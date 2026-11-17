import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'api.dart';
import 'downloads.dart';
import 'models.dart';

/// Where chapters already in Portuguese are downloaded: by the PC while it can be reached (it saves
/// them in its library, for every device), or by the phone itself, over Wi-Fi only or mobile data too.
enum DownloadWhere { pcFirst, phone, pc }

class DownloadPrefs {
  DownloadPrefs({required this.where, required this.wifiOnly});

  final DownloadWhere where;

  /// Downloads on the phone wait for Wi-Fi.
  final bool wifiOnly;

  static const _whereKey = 'download.where';
  static const _wifiKey = 'download.wifiOnly';

  static Future<DownloadPrefs> load() async {
    final prefs = await SharedPreferences.getInstance();
    final where = DownloadWhere.values.where((w) => w.name == prefs.getString(_whereKey)).firstOrNull ?? DownloadWhere.pcFirst;
    return DownloadPrefs(where: where, wifiOnly: prefs.getBool(_wifiKey) ?? false);
  }

  Future<void> save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_whereKey, where.name);
    await prefs.setBool(_wifiKey, wifiOnly);
  }
}

/// A chapter downloaded by the phone from a site: its PDF is kept with the PC's downloads (so the
/// reader opens it the same way), and what it is in this list.
class PhoneChapter {
  PhoneChapter({required this.id, required this.url, required this.title, required this.work, this.workId, this.chapter, required this.pages, required this.savedAt});

  final String id;
  final String url;
  final String title;
  final String work;
  final String? workId;
  final double? chapter;
  final int pages;
  final int savedAt;

  Map<String, dynamic> toJson() =>
      {'id': id, 'url': url, 'title': title, 'work': work, 'workId': workId, 'chapter': chapter, 'pages': pages, 'savedAt': savedAt};

  factory PhoneChapter.fromJson(Map<String, dynamic> j) => PhoneChapter(
        id: j['id'] as String,
        url: j['url'] as String,
        title: j['title'] as String,
        work: j['work'] as String,
        workId: j['workId'] as String?,
        chapter: (j['chapter'] as num?)?.toDouble(),
        pages: (j['pages'] as num).toInt(),
        savedAt: (j['savedAt'] as num).toInt(),
      );

  /// As the reader takes it; its reading goes to the PC by the site's address.
  LibraryChapter get asLibrary => LibraryChapter(
        id: id,
        title: title,
        workId: workId ?? '',
        chapter: chapter,
        pageCount: pages,
        translatedPages: pages,
        createdAt: savedAt,
        hasCover: false,
        downloaded: true,
        sourceUrl: url,
      );

  static const _key = 'phoneChapters';

  /// The ones whose PDF is on the phone (a backup restored brings the list back, not the files).
  static Future<List<PhoneChapter>> all() async {
    final text = (await SharedPreferences.getInstance()).getString(_key);
    if (text == null) return [];
    final kept = await Downloads.downloaded();
    return [
      for (final j in jsonDecode(text) as List)
        if (kept.contains(j['id'])) PhoneChapter.fromJson(j as Map<String, dynamic>),
    ];
  }

  static Future<void> _save(List<PhoneChapter> list) async =>
      (await SharedPreferences.getInstance()).setString(_key, jsonEncode(list.map((c) => c.toJson()).toList()));

  static Future<void> add(PhoneChapter chapter) async => _save([...(await all()).where((c) => c.id != chapter.id), chapter]);

  static Future<void> remove(String id) async {
    await Downloads.remove(id);
    await _save((await all()).where((c) => c.id != id).toList());
  }

  /// The same address always gives the same id, so downloading it again replaces it.
  static String idOf(String url) {
    // FNV-1a over the address, twice with different starts: 16 hex digits.
    String fnv(int start) {
      var hash = start;
      for (final byte in utf8.encode(url)) {
        hash = ((hash ^ byte) * 0x01000193) & 0xFFFFFFFF;
      }
      return hash.toRadixString(16).padLeft(8, '0');
    }

    return 'site-${fnv(0x811C9DC5)}${fnv(0x050C5D1F)}';
  }
}

/// What to download: the chapter's page on the site, and what is known of it.
class SiteChapter {
  SiteChapter({required this.url, required this.work, this.workId, this.chapter, this.site});

  final String url;
  final String work;
  final String? workId;
  final double? chapter;
  final String? site;
}

const _app = MethodChannel('manga_index/app');

class SiteDownloads {
  /// Downloads [chapter] where the settings say. Returns what to tell the person (null: nothing, the
  /// phone's download screen already showed how it went).
  static Future<String?> request(BuildContext context, Api api, SiteChapter chapter) async {
    final prefs = await DownloadPrefs.load();
    final known = chapter.chapter != null;
    if (prefs.where != DownloadWhere.phone && known) {
      try {
        await api.downloadOnPc(chapter.url, work: chapter.work, chapter: chapter.chapter!, site: chapter.site ?? Uri.parse(chapter.url).host);
        return 'O PC está baixando o capítulo ${chapterLabel(chapter.chapter!)}. Ele aparece em "No PC" na obra quando terminar.';
      } on ApiException catch (e) {
        if (prefs.where == DownloadWhere.pc) return e.message;
      }
    }
    if (prefs.where == DownloadWhere.pc) {
      return 'O PC só baixa capítulos que ele reconhece. Abra o capítulo pela obra, ou mude onde baixar em "Downloads".';
    }
    final network = await _app.invokeMethod<String>('network').catchError((_) => 'unknown');
    if (network == 'none') return 'Sem internet no celular agora.';
    if (prefs.wifiOnly && network == 'cellular') {
      return 'O celular está nos dados móveis, e os downloads estão configurados para só Wi-Fi (em "Downloads").';
    }
    if (!context.mounted) return null;
    final saved = await Navigator.push<PhoneChapter>(context, MaterialPageRoute(builder: (_) => PhoneDownloadScreen(chapter: chapter)));
    return saved == null ? null : 'Baixado no celular: ${saved.title} (${saved.pages} páginas).';
  }
}

/// Downloads a chapter on the phone: the page opens in a browser below the progress (a site's check
/// can be passed there by hand), is scrolled to the end so every image gets its address, and the
/// images become a PDF kept on the phone.
class PhoneDownloadScreen extends StatefulWidget {
  const PhoneDownloadScreen({super.key, required this.chapter});

  final SiteChapter chapter;

  @override
  State<PhoneDownloadScreen> createState() => _PhoneDownloadScreenState();
}

class _PhoneDownloadScreenState extends State<PhoneDownloadScreen> {
  late final WebViewController _web;
  final _loaded = Completer<void>();
  final _fetches = <int, Completer<Uint8List>>{};
  var _nextFetch = 0;
  String _stage = 'Abrindo o site…';
  double? _progress;
  String? _error;
  bool _showPage = false;
  bool _cancelled = false;

  @override
  void initState() {
    super.initState();
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('MIFetch', onMessageReceived: (m) => _onFetched(m.message))
      ..setNavigationDelegate(NavigationDelegate(onPageFinished: (_) {
        if (!_loaded.isCompleted) _loaded.complete();
      }));
    _run();
  }

  @override
  void dispose() {
    _cancelled = true;
    super.dispose();
  }

  void _check() {
    if (_cancelled) throw const _Cancelled();
  }

  void _set(String stage, [double? progress]) {
    if (mounted) setState(() => (_stage = stage, _progress = progress));
  }

  Future<void> _run() async {
    final chapter = widget.chapter;
    try {
      final mangadex = RegExp(r'^https://mangadex\.org/chapter/([0-9a-f-]{36})', caseSensitive: false).firstMatch(chapter.url)?.group(1);
      final images = mangadex != null ? await _mangadex(mangadex) : await _fromPage(chapter.url);
      _set('Montando o PDF…');
      final pages = <JpegPage>[];
      for (final image in images) {
        _check();
        final jpeg = await _app.invokeMapMethod<String, dynamic>('toJpeg', {'bytes': image});
        if (jpeg == null) continue;
        pages.add(JpegPage(jpeg['bytes'] as Uint8List, (jpeg['width'] as num).toInt(), (jpeg['height'] as num).toInt()));
      }
      if (pages.isEmpty) throw const _Failure('As imagens do capítulo não puderam ser abertas.');
      final id = PhoneChapter.idOf(chapter.url);
      await Downloads.save(id, pdfFromJpegs(pages));
      final title = chapter.chapter != null ? '${chapter.work} — capítulo ${chapterLabel(chapter.chapter!)}' : chapter.work;
      final saved = PhoneChapter(
        id: id,
        url: chapter.url,
        title: title,
        work: chapter.work,
        workId: chapter.workId,
        chapter: chapter.chapter,
        pages: pages.length,
        savedAt: DateTime.now().millisecondsSinceEpoch,
      );
      await PhoneChapter.add(saved);
      if (mounted) Navigator.pop(context, saved);
    } on _Cancelled {
      // Left the screen.
    } on _Failure catch (e) {
      if (mounted) setState(() => (_error = e.message, _showPage = true));
    } catch (e) {
      if (mounted) setState(() => (_error = 'Não foi possível baixar o capítulo ($e).', _showPage = true));
    }
  }

  /// MangaDex's reader draws its pages from its image API, which gives their addresses directly.
  Future<List<Uint8List>> _mangadex(String id) async {
    Future<Map<String, dynamic>> json(String url) async {
      final response = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 30));
      if (response.statusCode != 200) throw _Failure('O MangaDex respondeu ${response.statusCode}.');
      return jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    }

    _set('Consultando o MangaDex…');
    final server = await json('https://api.mangadex.org/at-home/server/$id');
    final info = server['chapter'] as Map<String, dynamic>;
    final urls = (info['data'] as List).map((f) => '${server['baseUrl']}/data/${info['hash']}/$f').toList();
    if (urls.isEmpty) throw const _Failure('Esse capítulo do MangaDex não tem páginas (pode estar só num site oficial).');
    return _downloadAll(urls, referer: 'https://mangadex.org/', userAgent: null, inPage: false);
  }

  Future<List<Uint8List>> _fromPage(String url) async {
    await _web.loadRequest(Uri.parse(url));
    await _loaded.future.timeout(const Duration(seconds: 60), onTimeout: () => throw const _Failure('O site demorou demais para abrir.'));
    _check();
    // Cloudflare-like checks pass on their own most of the time; otherwise the page is shown.
    final started = DateTime.now();
    while (await _challenged()) {
      _check();
      final waited = DateTime.now().difference(started);
      if (waited > const Duration(seconds: 8) && !_showPage) {
        if (mounted) setState(() => _showPage = true);
        _set('O site pediu uma verificação: conclua na página abaixo.');
      }
      if (waited > const Duration(minutes: 2)) throw const _Failure('O site pediu uma verificação que não foi concluída.');
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    if (_showPage && mounted) setState(() => _showPage = false);
    await Future<void>.delayed(const Duration(seconds: 2));
    _set('Carregando as páginas…');
    await _scrollToBottom();
    final found = await _js(_collect) as Map<String, dynamic>;
    final urls = (found['urls'] as List).cast<String>();
    if (urls.isEmpty) throw const _Failure('Não encontrei as páginas do capítulo nesse link. Confira se é a página de leitura.');
    final userAgent = await _js('navigator.userAgent') as String?;
    return _downloadAll(urls, referer: url, userAgent: userAgent, inPage: true);
  }

  Future<List<Uint8List>> _downloadAll(List<String> urls, {required String referer, required String? userAgent, required bool inPage}) async {
    final images = List<Uint8List?>.filled(urls.length, null);
    var done = 0;
    var next = 0;
    _set('Baixando as páginas…', 0);
    Future<void> worker() async {
      while (next < urls.length) {
        _check();
        final i = next++;
        images[i] = await _download(urls[i], referer: referer, userAgent: userAgent, inPage: inPage);
        done++;
        _set('Baixando as páginas… $done de ${urls.length}', done / urls.length);
      }
    }

    await Future.wait(List.generate(4, (_) => worker()));
    return images.cast<Uint8List>();
  }

  /// Straight from the image server with the page as referer, as the site's reader asks; addresses
  /// that only exist inside the page, or servers that turn the app away, are read by the page itself.
  Future<Uint8List> _download(String url, {required String referer, required String? userAgent, required bool inPage}) async {
    if (!url.startsWith('blob:') && !url.startsWith('data:')) {
      for (var attempt = 1; attempt <= 3; attempt++) {
        try {
          final response = await http
              .get(Uri.parse(url), headers: {'Referer': referer, 'User-Agent': ?userAgent})
              .timeout(const Duration(seconds: 40));
          if (response.statusCode == 200 && response.bodyBytes.isNotEmpty) return response.bodyBytes;
          if (response.statusCode == 403 || response.statusCode == 401) break;
        } catch (_) {
          // Tried again below.
        }
        await Future<void>.delayed(Duration(milliseconds: 800 * attempt));
      }
    }
    if (!inPage) throw _Failure('Não foi possível baixar uma página ($url).');
    return _pageFetch(url);
  }

  Future<Uint8List> _pageFetch(String url) {
    final id = _nextFetch++;
    final done = Completer<Uint8List>();
    _fetches[id] = done;
    _web.runJavaScript('''
fetch(${jsonEncode(url)}, { credentials: 'include' })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob() })
  .then((b) => new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(String(f.result).split(',')[1]); f.readAsDataURL(b) }))
  .then((data) => MIFetch.postMessage(JSON.stringify({ id: $id, data })))
  .catch((e) => MIFetch.postMessage(JSON.stringify({ id: $id, error: String(e) })))''');
    return done.future.timeout(const Duration(seconds: 60), onTimeout: () => throw _Failure('Uma página demorou demais ($url).'));
  }

  void _onFetched(String message) {
    final data = jsonDecode(message) as Map<String, dynamic>;
    final done = _fetches.remove((data['id'] as num).toInt());
    if (done == null) return;
    if (data['error'] != null) {
      done.completeError(_Failure('Não foi possível baixar uma página (${data['error']}).'));
    } else {
      done.complete(base64Decode(data['data'] as String));
    }
  }

  /// Runs [script] in the page; objects come back as JSON.
  Future<Object?> _js(String script) async {
    Object? result = await _web.runJavaScriptReturningResult('JSON.stringify($script)');
    // Android hands back the string; some versions quote it once more.
    for (var i = 0; i < 2 && result is String; i++) {
      try {
        result = jsonDecode(result);
      } catch (_) {
        break;
      }
    }
    return result;
  }

  Future<bool> _challenged() async =>
      await _js("/just a moment|um momento|attention required|verify you are human|checking your browser/i.test(document.title + ' ' + (document.body?.innerText ?? '').slice(0, 400))") ==
      true;

  /// Scrolls down a screen at a time until the page stops growing, so lazy images get their address.
  Future<void> _scrollToBottom() async {
    var lastHeight = 0;
    var still = 0;
    for (var step = 0; step < 600 && still < 6; step++) {
      _check();
      final r = await _js(
          '(() => { window.scrollBy(0, Math.round(window.innerHeight * 0.9)); const h = document.documentElement.scrollHeight; return { height: h, bottom: window.scrollY + window.innerHeight >= h - 4 } })()') as Map<String, dynamic>;
      final height = (r['height'] as num).toInt();
      final bottom = r['bottom'] == true;
      still = bottom && height == lastHeight ? still + 1 : 0;
      lastHeight = height;
      await Future<void>.delayed(Duration(milliseconds: bottom ? 400 : 150));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.chapter.chapter != null ? 'Baixando o cap. ${chapterLabel(widget.chapter.chapter!)}' : 'Baixando no celular'),
        actions: [
          IconButton(
            tooltip: _showPage ? 'Esconder a página' : 'Mostrar a página',
            icon: Icon(_showPage ? Icons.visibility_off : Icons.visibility),
            onPressed: () => setState(() => _showPage = !_showPage),
          ),
        ],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(widget.chapter.work, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(Uri.parse(widget.chapter.url).host, style: const TextStyle(color: Colors.white60)),
            const SizedBox(height: 16),
            if (_error == null) ...[
              LinearProgressIndicator(value: _progress),
              const SizedBox(height: 8),
              Text(_stage),
            ] else
              Text(_error!, style: const TextStyle(color: Color(0xFFFF8A5C))),
          ]),
        ),
        // The page is laid out (so it loads as on a screen) even while hidden.
        Expanded(child: Opacity(opacity: _showPage ? 1 : 0.02, child: IgnorePointer(ignoring: !_showPage, child: WebViewWidget(controller: _web)))),
      ]),
    );
  }
}

/// The reader's images in page order, as the PC app picks them (scripts/webChapter.ts).
const _collect = r'''(() => {
  const pick = (img) => {
    const lazy = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-cfsrc'].map((a) => img.getAttribute(a)).find((v) => v && !v.startsWith('data:image/gif'))
    const set = (img.getAttribute('data-srcset') || '').split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean).pop()
    const src = lazy || set || img.currentSrc || img.src
    try { return src ? new URL(src.trim(), location.href).href : '' } catch { return '' }
  }
  const imgs = [...document.querySelectorAll('img')].map((img) => {
    const r = img.getBoundingClientRect()
    return { url: pick(img), w: Math.max(img.naturalWidth, r.width), h: Math.max(img.naturalHeight, r.height), shown: r.width }
  }).filter((i) => /^(https?|data|blob):/.test(i.url) && !/\.(svg|gif)(\?|$)/i.test(i.url))
  const widest = Math.max(0, ...imgs.map((i) => i.shown))
  const seen = new Set()
  const urls = imgs.filter((i) => i.shown >= widest * 0.6 && i.w >= 150 && i.h >= 100).map((i) => i.url).filter((u) => !seen.has(u) && seen.add(u))
  return { title: document.title, urls }
})()''';

class _Cancelled implements Exception {
  const _Cancelled();
}

class _Failure implements Exception {
  const _Failure(this.message);
  final String message;
}

class JpegPage {
  JpegPage(this.bytes, this.width, this.height);

  final Uint8List bytes;
  final int width;
  final int height;
}

/// A PDF with one JPEG per page, each page the image's size (as the PC saves downloaded chapters).
Uint8List pdfFromJpegs(List<JpegPage> pages) {
  final out = BytesBuilder(copy: false);
  final offsets = <int>[];
  void text(String s) => out.add(latin1.encode(s));
  void object(int n, void Function() body) {
    offsets.add(out.length);
    text('$n 0 obj\n');
    body();
    text('\nendobj\n');
  }

  text('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  final n = pages.length;
  // 1: catalog, 2: page tree, then per page: page, contents, image.
  object(1, () => text('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => text('<< /Type /Pages /Count $n /Kids [${List.generate(n, (i) => '${3 + i * 3} 0 R').join(' ')}] >>'));
  for (var i = 0; i < n; i++) {
    final page = pages[i];
    final first = 3 + i * 3;
    object(first, () => text('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] '
        '/Resources << /XObject << /Im0 ${first + 2} 0 R >> >> /Contents ${first + 1} 0 R >>'));
    final draw = 'q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q';
    object(first + 1, () => text('<< /Length ${draw.length} >>\nstream\n$draw\nendstream'));
    object(first + 2, () {
      text('<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB '
          '/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n');
      out.add(page.bytes);
      text('\nendstream');
    });
  }
  final xref = out.length;
  text('xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n');
  for (final offset in offsets) {
    text('${offset.toString().padLeft(10, '0')} 00000 n \n');
  }
  text('trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n');
  return out.takeBytes();
}
