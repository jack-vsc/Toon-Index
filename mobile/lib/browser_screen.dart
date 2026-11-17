import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'api.dart';
import 'browser_tabs.dart';
import 'library_screen.dart' show appHome;
import 'models.dart';
import 'site_download.dart';
import 'theme.dart';

/// Reads chapters on their sites inside the app. The page runs the PC extension's tracker
/// (assets/reading_tracker.js), so the chapter is marked read or in progress the same way.
class BrowserScreen extends StatefulWidget {
  const BrowserScreen({super.key, required this.api, this.url, this.recent = const []});

  final Api api;

  /// The page to open; without one, the screen starts with [recent].
  final String? url;

  /// Works to pick up where they were left, for the start page.
  final List<WorkView> recent;

  @override
  State<BrowserScreen> createState() => _BrowserScreenState();
}

class _BrowserScreenState extends State<BrowserScreen> {
  /// Pages kept loaded at once: the tabs used longest ago keep only their address and load again when
  /// shown, as Chrome does, so many tabs cost no more memory than a few.
  static const _live = 4;

  final _data = BrowserData.instance;
  final Map<String, WebViewController> _webs = {};
  final _address = TextEditingController();
  final _addressFocus = FocusNode();
  String? _tracker;
  bool _ready = false;
  int _loading = 100;

  /// What the PC said about the chapter open in each tab: its work, chapter, read or how far.
  final Map<String, Map<String, dynamic>> _status = {};

  /// By tab, the work whose own page is open (its name and the page), as the tracker found it, and what
  /// the library has of it (its list, favorite): the "Quero ler" button.
  final Map<String, Map<String, dynamic>> _workPage = {};
  final Map<String, Map<String, dynamic>> _workInfo = {};

  static const _shelves = {'plan': 'Quero ler', 'reading': 'Lendo', 'paused': 'Pausado', 'done': 'Concluído', 'dropped': 'Abandonado'};
  bool _offline = false;

  BrowserTab get _tab => _data.active!;
  bool get _started => _tab.url != null;

  @override
  void initState() {
    super.initState();
    _data.load().then((_) {
      if (!mounted) return;
      // Asked for a page: in the tab open if it is empty, else in a new one.
      if (widget.url != null) {
        if (_data.active?.url != null) _data.newTab();
        _go(widget.url!);
      } else {
        _show();
      }
      setState(() => _ready = true);
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // The whole address to edit while typing; the short one again after.
    _addressFocus.removeListener(_onFocus);
    _addressFocus.addListener(_onFocus);
  }

  void _onFocus() {
    if (!_ready) return;
    _showAddress();
    if (_addressFocus.hasFocus) _address.selection = TextSelection(baseOffset: 0, extentOffset: _address.text.length);
  }

  @override
  void dispose() {
    _address.dispose();
    _addressFocus.dispose();
    super.dispose();
  }

  /// "mediocrescan.com/capitulo/591535": the address as it reads, while it is not being typed.
  static String _shortUrl(String? url) => (url ?? '').replaceFirst(RegExp(r'^https?://(www\.)?'), '').replaceFirst(RegExp(r'/$'), '');

  void _showAddress() => _address.text = _addressFocus.hasFocus ? (_tab.url ?? '') : _shortUrl(_tab.url);

  BrowserTab? _tabWith(String id) => _data.tabs.where((t) => t.id == id).firstOrNull;

  /// The tab's page, made (and loaded) when first shown or after being let go of.
  WebViewController _webOf(BrowserTab tab) {
    final known = _webs[tab.id];
    if (known != null) return known;
    final id = tab.id;
    final web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('MangaIndex', onMessageReceived: (m) => _onReport(id, m.message))
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) {
          if (mounted && _data.activeId == id) setState(() => _loading = p);
        },
        onUrlChange: (change) {
          final url = change.url;
          final tab = _tabWith(id);
          if (url == null || url == 'about:blank' || tab == null || !mounted) return;
          _status.remove(id);
          if (_workPage[id]?['url'] != url) (_workPage.remove(id), _workInfo.remove(id));
          _data.visited(tab, url, '');
          if (_data.activeId == id && !_addressFocus.hasFocus) setState(_showAddress);
        },
        onPageFinished: (url) async {
          final web = _webs[id];
          if (web == null || url == 'about:blank') return;
          _inject(web);
          final title = await web.getTitle() ?? '';
          final tab = _tabWith(id);
          if (tab != null) _data.visited(tab, url, title);
        },
      ));
    _webs[id] = web;
    if (tab.url != null) web.loadRequest(Uri.parse(tab.url!));
    _letGo();
    return web;
  }

  /// The pages of the tabs used longest ago go (their tabs stay, with their address), and those of closed tabs.
  void _letGo() {
    _webs.removeWhere((id, web) {
      final gone = _tabWith(id) == null;
      if (gone) web.loadRequest(Uri.parse('about:blank'));
      return gone;
    });
    final alive = _data.tabs.where((t) => _webs.containsKey(t.id) && t.id != _data.activeId).toList()..sort((a, b) => b.usedAt.compareTo(a.usedAt));
    for (final t in alive.skip(_live - 1)) {
      _webs.remove(t.id)?.loadRequest(Uri.parse('about:blank'));
    }
  }

  /// Shows the active tab: its address in the bar, its page made if needed.
  void _show() {
    _addressFocus.unfocus();
    _showAddress();
    _loading = 100;
    if (_started) _webOf(_tab);
    _letGo();
    setState(() {});
  }

  /// An address opens as it is ("mangadex.org" too); anything else is searched on Google.
  void _go(String text) {
    final typed = text.trim();
    if (typed.isEmpty) return;
    var uri = typed.contains(' ') ? null : Uri.tryParse(typed.contains('://') ? typed : 'https://$typed');
    if (uri == null || !uri.host.contains('.')) {
      uri = Uri.https('www.google.com', '/search', {'q': typed});
    }
    _addressFocus.unfocus();
    final tab = _tab;
    final fresh = !_webs.containsKey(tab.id);
    tab.url = uri.toString();
    _data.changed();
    _address.text = _shortUrl(uri.toString());
    // A page made now loads the address itself.
    final web = _webOf(tab);
    if (!fresh) web.loadRequest(uri);
    setState(() => _status.remove(tab.id));
  }

  /// Straight to the app's start (Início), however deep in a site and however it was opened.
  void _home() {
    appHome.value++;
    Navigator.of(context).popUntil((route) => route.isFirst);
  }

  Future<void> _tabs() async {
    final picked = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => const TabsScreen()));
    if (!mounted) return;
    if (picked != null) _data.select(picked);
    _show();
  }

  Future<void> _saved(bool history) async {
    final url = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => SavedPagesScreen(history: history)));
    if (url != null && mounted) _go(url);
  }

  /// Runs the tracker in the page; its reports reach [_onReport] through the MangaIndex channel.
  Future<void> _inject(WebViewController web) async {
    _tracker ??= await rootBundle.loadString('assets/reading_tracker.js');
    await web.runJavaScript('''
(function () {
  if (window.__mangaIndexTracker) return;
  window.__mangaIndexTracker = true;
  // What the extension's background page does, done by the app instead.
  const chrome = { runtime: { sendMessage: (m) => MangaIndex.postMessage(JSON.stringify(m)) } };
  $_tracker
})();''');
  }

  Future<void> _onReport(String tabId, String message) async {
    final data = jsonDecode(message) as Map<String, dynamic>;
    if (data['type'] == 'work') return _onWorkPage(tabId, data['work'] as Map<String, dynamic>?);
    if (data['type'] != 'reading') return;
    try {
      final result = await widget.api.reportBrowserReading(data['report'] as Map<String, dynamic>);
      if (!mounted) return;
      setState(() {
        if (result != null) _status[tabId] = result;
        _offline = result?['offline'] == true;
      });
    } on ApiException {
      if (mounted) setState(() => _offline = true);
    }
  }

  /// The tab is on a work's page (or left it): the button shows, with the work's list once the PC says.
  Future<void> _onWorkPage(String tabId, Map<String, dynamic>? work) async {
    if (!mounted) return;
    setState(() {
      _workInfo.remove(tabId);
      work == null ? _workPage.remove(tabId) : _workPage[tabId] = work;
    });
    if (work == null || !widget.api.paired) return;
    try {
      final info = await widget.api.workPageInfo(work['url'] as String, work['name'] as String);
      if (mounted && _workPage[tabId]?['url'] == work['url']) setState(() => _workInfo[tabId] = info);
    } on ApiException {
      // Offline: the button still offers the lists, and says so when one is picked.
    }
  }

  /// The lists, and the favorite, for the work of the page open.
  Future<void> _workMenu() async {
    final tabId = _tab.id;
    final work = _workPage[tabId];
    if (work == null) return;
    final info = _workInfo[tabId];
    final current = info?['workId'] != null ? info!['shelf'] as String? : null;
    final favorite = info?['favorite'] == true;
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(work['name'] as String, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            ),
          ),
          for (final e in _shelves.entries)
            ListTile(
              leading: Icon(current == e.key ? Icons.check_circle : Icons.circle_outlined, color: current == e.key ? accent : null),
              title: Text(e.value),
              onTap: () => Navigator.pop(sheet, e.key),
            ),
          ListTile(
            leading: Icon(favorite ? Icons.favorite : Icons.favorite_border, color: favorite ? accent : null),
            title: Text(favorite ? 'Tirar das favoritas' : 'Favoritar'),
            onTap: () => Navigator.pop(sheet, 'favorite'),
          ),
        ]),
      ),
    );
    if (picked == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final info = picked == 'favorite'
          ? await widget.api.bookmarkWorkPage(work['url'] as String, work['name'] as String, favorite: !favorite)
          // The list it is on, picked again, takes it off.
          : await widget.api.bookmarkWorkPage(work['url'] as String, work['name'] as String, shelf: picked == current ? null : picked, clearShelf: picked == current);
      if (mounted) setState(() => _workInfo[tabId] = info);
      final shelf = info['shelf'] as String?;
      messenger.showSnackBar(SnackBar(
          content: Text(picked == 'favorite'
              ? (info['favorite'] == true ? 'Nas favoritas.' : 'Fora das favoritas.')
              : shelf != null && picked != current
                  ? 'Em "${_shelves[shelf]}". O PC avisa dos capítulos novos desta página.'
                  : 'Fora das listas.')));
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// "＋ Quero ler", or the list the work is on ("✓ Lendo"), floating over a work's page.
  Widget? _workButton() {
    final work = _workPage[_tab.id];
    if (work == null || !_started) return null;
    final info = _workInfo[_tab.id];
    final shelf = info?['workId'] != null ? info!['shelf'] as String? : null;
    final favorite = info?['favorite'] == true;
    return FloatingActionButton.extended(
      onPressed: _workMenu,
      backgroundColor: shelf != null ? panel : accent,
      foregroundColor: shelf != null ? readGreen : Colors.white,
      icon: Icon(shelf != null ? Icons.check : Icons.add),
      label: Text(shelf != null ? '${_shelves[shelf]}${favorite ? ' ♥' : ''}' : 'Quero ler'),
    );
  }

  Future<void> _translate() async {
    final url = _tab.url;
    if (url == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.api.translateLink(url);
      messenger.showSnackBar(const SnackBar(content: Text('Enviado ao PC para traduzir. Acompanhe em "Traduzir no PC".')));
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// Downloads the chapter open (already in Portuguese) where the settings say.
  Future<void> _download() async {
    final url = _tab.url;
    if (url == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final status = _status[_tab.id];
    final title = _tab.title;
    final message = await SiteDownloads.request(
      context,
      widget.api,
      SiteChapter(
        url: url,
        work: displayName(status?['work'] as String? ?? '').isNotEmpty ? displayName(status!['work'] as String) : (title.isNotEmpty ? title : Uri.parse(url).host),
        workId: status?['workId'] as String?,
        chapter: (status?['chapter'] as num?)?.toDouble(),
      ),
    );
    if (message != null) messenger.showSnackBar(SnackBar(content: Text(message)));
  }

  /// "✓ Lido · Cap. 99 · Work" or "Cap. 99 · 40% · Work" for the chapter open, as the PC counted it:
  /// a slim strip under the bar, with the page's loading on it.
  PreferredSizeWidget? _strip() {
    final status = _status[_tab.id];
    final loading = _started && _loading < 100;
    if (status == null && !_offline && !loading) return null;
    Widget? line;
    if (status != null) {
      final chapter = chapterLabel((status['chapter'] as num).toDouble());
      final read = status['status'] == 'read';
      final progress = status['progress'] as num?;
      final color = read ? readGreen : accentSoft;
      line = Row(children: [
        Icon(read ? Icons.check_circle : Icons.auto_stories, size: 14, color: color),
        const SizedBox(width: 6),
        Text(read ? 'Lido · cap. $chapter' : 'Cap. $chapter${progress != null ? ' · ${(progress * 100).round()}%' : ''}',
            style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700)),
        const SizedBox(width: 8),
        Expanded(child: Text(displayName(status['work'] as String? ?? ''), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontSize: 12))),
      ]);
    } else if (_offline) {
      line = const Row(children: [
        Icon(Icons.cloud_off, size: 14, color: muted),
        SizedBox(width: 6),
        Expanded(child: Text('PC fora de alcance: a leitura vai depois', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: muted, fontSize: 12))),
      ]);
    }
    return PreferredSize(
      preferredSize: Size.fromHeight(line != null ? 26 : 2),
      child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
        if (line != null) Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 6), child: line),
        SizedBox(height: 2, child: loading ? LinearProgressIndicator(value: _loading / 100, minHeight: 2) : null),
      ]),
    );
  }

  /// The tabs' count in a square, as in Chrome; opens the tabs.
  Widget _tabsButton() => IconButton(
        tooltip: 'Abas',
        visualDensity: VisualDensity.compact,
        onPressed: _tabs,
        icon: Container(
          width: 22,
          height: 22,
          alignment: Alignment.center,
          decoration: BoxDecoration(border: Border.all(color: Colors.white70, width: 1.6), borderRadius: BorderRadius.circular(5)),
          child: Text(_data.tabs.length > 99 ? '∞' : '${_data.tabs.length}', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800)),
        ),
      );

  @override
  Widget build(BuildContext context) {
    if (!_ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final tab = _tab;
    final favorite = _data.isFavorite(tab.url);
    return PopScope(
      canPop: false,
      // The phone's back button goes back in the site first.
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final navigator = Navigator.of(context);
        final web = _webs[tab.id];
        if (web != null && await web.canGoBack()) {
          await web.goBack();
        } else {
          navigator.pop();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          // The house on the left, where the back arrow would be: to the app's start.
          leading: IconButton(tooltip: 'Início do app', icon: const Icon(Icons.home_outlined), onPressed: _home),
          titleSpacing: 0,
          title: TextField(
            controller: _address,
            focusNode: _addressFocus,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.go,
            style: const TextStyle(fontSize: 14),
            decoration: InputDecoration(
              hintText: 'Digite o site ou pesquise',
              prefixIcon: const Icon(Icons.search, size: 20),
              prefixIconConstraints: const BoxConstraints(minWidth: 36),
              filled: true,
              fillColor: Colors.white.withValues(alpha: 0.08),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
              contentPadding: const EdgeInsets.symmetric(vertical: 10),
              isDense: true,
            ),
            onSubmitted: _go,
          ),
          actions: [
            _tabsButton(),
            PopupMenuButton<String>(
              onSelected: (action) async {
                final web = _webs[tab.id];
                switch (action) {
                  case 'new':
                    _data.newTab(group: tab.group);
                    _show();
                  case 'back':
                    if (web != null && await web.canGoBack()) await web.goBack();
                  case 'forward':
                    if (web != null && await web.canGoForward()) await web.goForward();
                  case 'reload':
                    await web?.reload();
                  case 'favorite':
                    _data.toggleFavorite(tab.url!, tab.title);
                    setState(() {});
                  case 'favorites':
                    await _saved(false);
                  case 'history':
                    await _saved(true);
                  case 'translate':
                    await _translate();
                  case 'download':
                    await _download();
                  case 'external':
                    if (tab.url != null) await launchUrl(Uri.parse(tab.url!), mode: LaunchMode.externalApplication);
                }
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'new', child: ListTile(leading: Icon(Icons.add), title: Text('Nova aba'), dense: true)),
                if (_started) const PopupMenuItem(value: 'back', child: ListTile(leading: Icon(Icons.arrow_back), title: Text('Voltar'), dense: true)),
                if (_started) const PopupMenuItem(value: 'forward', child: ListTile(leading: Icon(Icons.arrow_forward), title: Text('Avançar'), dense: true)),
                if (_started) const PopupMenuItem(value: 'reload', child: ListTile(leading: Icon(Icons.refresh), title: Text('Recarregar'), dense: true)),
                if (_started)
                  PopupMenuItem(
                    value: 'favorite',
                    child: ListTile(leading: Icon(favorite ? Icons.star : Icons.star_border), title: Text(favorite ? 'Tirar dos favoritos' : 'Favoritar'), dense: true),
                  ),
                const PopupMenuItem(value: 'favorites', child: ListTile(leading: Icon(Icons.bookmarks_outlined), title: Text('Favoritos'), dense: true)),
                const PopupMenuItem(value: 'history', child: ListTile(leading: Icon(Icons.history), title: Text('Histórico'), dense: true)),
                if (_started) const PopupMenuItem(value: 'translate', child: Text('Traduzir este capítulo no PC')),
                if (_started) const PopupMenuItem(value: 'download', child: Text('Baixar este capítulo (já em português)')),
                if (_started) const PopupMenuItem(value: 'external', child: Text('Abrir no navegador do celular')),
              ],
            ),
          ],
          bottom: _strip(),
        ),
        floatingActionButton: _workButton(),
        body: _started
            ? KeyedSubtree(key: ValueKey(tab.id), child: WebViewWidget(controller: _webOf(tab)))
            : BrowserStartPage(recent: widget.recent, favorites: _data.favorites, onOpen: _go),
      ),
    );
  }
}

/// Sites offered on the start page besides those of the works read.
const _knownSites = ['mangadex.org', 'mgeko.cc', 'mangakakalot.fan', 'mangalivre.blog', 'mediocrescan.com'];

/// Before a site is open: an address to type, the sites already used, and the works to pick up where
/// they were left.
class BrowserStartPage extends StatelessWidget {
  const BrowserStartPage({super.key, required this.recent, required this.onOpen, this.favorites = const []});

  final List<WorkView> recent;
  final List<SavedPage> favorites;
  final void Function(String url) onOpen;

  @override
  Widget build(BuildContext context) {
    final withUrl = recent.where((v) => v.continueUrl != null).take(12).toList();
    final sites = {
      for (final view in withUrl) Uri.parse(view.continueUrl!).host.replaceFirst(RegExp(r'^www\.'), ''),
      ..._knownSites,
    }.where((h) => h.isNotEmpty).take(10);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('Digite o endereço de qualquer site na barra de cima (ou o que quiser pesquisar) e leia por aqui: o '
            'capítulo é marcado como lido quando você chega ao fim, igual à extensão do PC.'),
        const SizedBox(height: 20),
        Text('Sites', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final site in sites)
              ActionChip(avatar: const Icon(Icons.public, size: 18), label: Text(site), onPressed: () => onOpen(site)),
          ],
        ),
        if (favorites.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Favoritos', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final page in favorites.take(12))
              ActionChip(
                avatar: const Icon(Icons.star, size: 18, color: Color(0xFFFF6740)),
                label: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 220), child: Text(page.label, overflow: TextOverflow.ellipsis)),
                onPressed: () => onOpen(page.url),
              ),
          ]),
        ],
        if (withUrl.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Continuar de onde parou', style: Theme.of(context).textTheme.titleMedium),
          for (final view in withUrl)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.play_circle_fill, color: Color(0xFFFF6740)),
              title: Text(view.work.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(Uri.parse(view.continueUrl!).host.replaceFirst(RegExp(r'^www\.'), ''), maxLines: 1),
              onTap: () => onOpen(view.continueUrl!),
            ),
        ],
      ],
    );
  }
}
