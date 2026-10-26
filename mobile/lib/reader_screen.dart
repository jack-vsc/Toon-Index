import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pdfx/pdfx.dart';

import 'api.dart';
import 'downloads.dart';
import 'models.dart';

/// A band of a page, the unit the reader draws: a normal page is one, a webtoon strip many, so no
/// picture is ever too big for the phone's memory. `top` and `height` are in widths of the page.
class _Band {
  const _Band(this.page, this.top, this.height);

  final int page;
  final double top;
  final double height;
}

/// Bands this many page widths tall at most (a screenful and a half).
const _bandHeight = 1.5;

/// Reads a chapter of the library, its pages one under the other. Opens where it was left, tells the
/// PC how far it got (to the end: read), now or once the PC can be reached, and at the end goes on to
/// the next chapter of the work. A tap hides everything but the pages.
class ReaderScreen extends StatefulWidget {
  const ReaderScreen({super.key, required this.api, required this.chapter, this.chapters = const []});

  final Api api;
  final LibraryChapter chapter;

  /// The work's chapters in the library, for the one after this.
  final List<LibraryChapter> chapters;

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  static const _tiles = MethodChannel('manga_index/pdf');

  final _scroll = ScrollController();
  PdfDocument? _document;
  String? _path;
  List<_Band> _bands = [];
  final _images = <int, Uint8List>{};
  final _rendering = <int>{};
  Future<void> _renderQueue = Future.value();
  double? _downloadProgress;
  String? _error;
  int _band = 0;
  double _reached = 0;
  double _reported = 0;
  Timer? _reportTimer;
  bool _bars = true;

  LibraryChapter? get _previous {
    final current = widget.chapter.chapter;
    if (current == null) return null;
    final before = widget.chapters.where((c) => c.chapter != null && c.chapter! < current).toList()
      ..sort((a, b) => b.chapter!.compareTo(a.chapter!));
    return before.firstOrNull;
  }

  LibraryChapter? get _next {
    final current = widget.chapter.chapter;
    if (current == null) return null;
    final after = widget.chapters.where((c) => c.chapter != null && c.chapter! > current).toList()
      ..sort((a, b) => a.chapter!.compareTo(b.chapter!));
    return after.firstOrNull;
  }

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _open();
  }

  Future<void> _open() async {
    try {
      final file = await Downloads.open(widget.api, widget.chapter.id,
          onProgress: (p) => mounted ? setState(() => _downloadProgress = p ?? 0) : null);
      final document = await PdfDocument.openFile(file.path);
      final bands = <_Band>[];
      for (var i = 1; i <= document.pagesCount; i++) {
        final page = await document.getPage(i);
        final aspect = page.height / page.width;
        await page.close();
        for (var top = 0.0; top < aspect - 0.01; top += _bandHeight) {
          bands.add(_Band(i - 1, top, math.min(_bandHeight, aspect - top)));
        }
      }
      final start = await Store.loadBand(widget.chapter.id);
      if (!mounted) return;
      setState(() => (_document = document, _path = file.path, _bands = bands, _band = start.clamp(0, bands.length - 1)));
      // Back to where it was left, once the list has its size.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients && start > 0) _scroll.jumpTo(_offsetOf(start));
      });
      _prefetchNext();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'Não foi possível abrir o capítulo: $e');
    }
  }

  /// The next chapter comes from the PC while it can be reached, so it opens without internet too.
  Future<void> _prefetchNext() async {
    final next = _next;
    if (next == null) return;
    try {
      await Downloads.open(widget.api, next.id);
    } catch (_) {
      // Away from the PC: it is fetched when opened, if it can be.
    }
  }

  double get _width => MediaQuery.of(context).size.width;

  double _offsetOf(int band) => _bands.take(band).fold(0.0, (sum, b) => sum + b.height * _width);

  void _onScroll() {
    if (_bands.isEmpty) return;
    final position = _scroll.position;
    final total = _bands.fold(0.0, (sum, b) => sum + b.height * _width);
    final bottom = position.pixels + position.viewportDimension;
    // The band at the middle of the screen.
    var band = 0;
    var y = 0.0;
    final middle = position.pixels + position.viewportDimension / 2;
    while (band < _bands.length - 1 && y + _bands[band].height * _width < middle) {
      y += _bands[band].height * _width;
      band++;
    }
    final reached = bottom >= total - 4 ? 1.0 : (bottom / total).clamp(0.0, 1.0);
    if (band != _band) {
      setState(() => _band = band);
      Store.saveBand(widget.chapter.id, band);
    }
    if (reached > _reached) {
      _reached = reached;
      // The end at once; positions along the way every few seconds.
      if (reached >= 1) {
        _report();
      } else {
        _reportTimer ??= Timer(const Duration(seconds: 8), _report);
      }
    }
  }

  void _report() {
    _reportTimer?.cancel();
    _reportTimer = null;
    if (_reached <= _reported) return;
    _reported = _reached;
    final source = widget.chapter.sourceUrl;
    if (source != null) {
      // As the browser reports a chapter read on its site.
      widget.api.reportBrowserReading({
        'url': source,
        'title': widget.chapter.title,
        'progress': _reached,
        'finished': _reached >= 0.999,
        'at': DateTime.now().millisecondsSinceEpoch,
      }).catchError((_) => null);
    } else {
      widget.api.reportAppReading(widget.chapter.id, _reached);
    }
  }

  /// Draws bands one at a time (Android opens one page of a PDF at a time).
  Future<void> _render(int index) {
    if (_images.containsKey(index) || _rendering.contains(index)) return Future.value();
    _rendering.add(index);
    final width = (_width * MediaQuery.of(context).devicePixelRatio).clamp(600.0, 1440.0).round();
    return _renderQueue = _renderQueue.then((_) async {
      final document = _document;
      if (document == null || !mounted) return;
      try {
        final bytes = await _drawBand(document, _bands[index], width);
        if (bytes != null && mounted) setState(() => _images[index] = bytes);
      } catch (_) {
        // Drawn again when scrolled back to.
      } finally {
        _rendering.remove(index);
      }
      // Bands far from the screen are let go, so a long chapter does not fill the memory.
      _images.removeWhere((i, _) => (i - _band).abs() > 8);
    });
  }

  Future<Uint8List?> _drawBand(PdfDocument document, _Band band, int width) async {
    try {
      return await _tiles.invokeMethod<Uint8List>('tile', {
        'path': _path,
        'page': band.page,
        'width': width,
        'top': band.top,
        'height': band.height,
      });
    } on MissingPluginException {
      // Not on Android (tests): the whole page, cut to the band.
      final page = await document.getPage(band.page + 1);
      try {
        final height = width * page.height / page.width;
        final image = await page.render(
          width: width.toDouble(),
          height: height,
          format: PdfPageImageFormat.jpeg,
          quality: 90,
          cropRect: Rect.fromLTWH(0, band.top * width, width.toDouble(), band.height * width),
        );
        return image?.bytes;
      } finally {
        await page.close();
      }
    }
  }

  void _toggleBars() {
    setState(() => _bars = !_bars);
    SystemChrome.setEnabledSystemUIMode(_bars ? SystemUiMode.edgeToEdge : SystemUiMode.immersiveSticky);
  }

  void _openNext(LibraryChapter next) {
    _report();
    Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => ReaderScreen(api: widget.api, chapter: next, chapters: widget.chapters)));
  }

  /// The chapters of the work in the library, to jump to one.
  Future<void> _pickChapter() async {
    final listed = widget.chapters.where((c) => c.chapter != null).toList()..sort((a, b) => b.chapter!.compareTo(a.chapter!));
    final picked = await showModalBottomSheet<LibraryChapter>(
      context: context,
      backgroundColor: const Color(0xFF1E1E22),
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: GridView.count(
          crossAxisCount: 3,
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          mainAxisSpacing: 8,
          crossAxisSpacing: 8,
          childAspectRatio: 2.6,
          children: [
            for (final c in listed)
              FilledButton.tonal(
                onPressed: () => Navigator.pop(context, c),
                style: FilledButton.styleFrom(
                  backgroundColor: c.id == widget.chapter.id ? const Color(0xFFFF6740) : null,
                  padding: EdgeInsets.zero,
                ),
                child: Text('Cap. ${chapterLabel(c.chapter!)}'),
              ),
          ],
        ),
      ),
    );
    if (picked != null && picked.id != widget.chapter.id) _openNext(picked);
  }

  @override
  void dispose() {
    _report();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    if (_path != null) _tiles.invokeMethod('close', {'path': _path}).catchError((_) => null);
    _scroll.dispose();
    _document?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.chapter;
    final title = c.chapter != null ? 'Capítulo ${chapterLabel(c.chapter!)}' : c.title;
    final next = _next;
    final previous = _previous;
    return Scaffold(
      backgroundColor: Colors.black,
      extendBodyBehindAppBar: true,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(kToolbarHeight),
        child: AnimatedOpacity(
          opacity: _bars ? 1 : 0,
          duration: const Duration(milliseconds: 150),
          child: IgnorePointer(
            ignoring: !_bars,
            child: AppBar(
              title: Text(title, style: const TextStyle(color: Color(0xFFFF6740), fontWeight: FontWeight.w800)),
              backgroundColor: Colors.black87,
            ),
          ),
        ),
      ),
      // The chapters around this one, at hand at the bottom while the bars show (as on the scans' reader).
      floatingActionButtonLocation: FloatingActionButtonLocation.centerFloat,
      floatingActionButton: c.chapter == null || _document == null
          ? null
          : AnimatedOpacity(
              opacity: _bars ? 1 : 0,
              duration: const Duration(milliseconds: 150),
              child: IgnorePointer(
                ignoring: !_bars,
                child: Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: const Color(0xEB18181C),
                    borderRadius: BorderRadius.circular(99),
                    border: Border.all(color: const Color(0xFF33333A)),
                  ),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    IconButton(tooltip: 'Capítulo anterior', onPressed: previous == null ? null : () => _openNext(previous), icon: const Icon(Icons.chevron_left)),
                    TextButton.icon(
                      onPressed: _pickChapter,
                      icon: const Icon(Icons.list, size: 18),
                      label: Text('Cap. ${chapterLabel(c.chapter!)}'),
                      style: TextButton.styleFrom(foregroundColor: Colors.white),
                    ),
                    IconButton(tooltip: 'Próximo capítulo', onPressed: next == null ? null : () => _openNext(next), icon: const Icon(Icons.chevron_right)),
                  ]),
                ),
              ),
            ),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center)))
          : _document == null
              ? Center(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    CircularProgressIndicator(value: _downloadProgress == 0 ? null : _downloadProgress),
                    const SizedBox(height: 12),
                    Text(_downloadProgress != null ? 'Baixando do PC…' : 'Abrindo…'),
                  ]),
                )
              : GestureDetector(
                  onTap: _toggleBars,
                  child: ReaderPages(
                    controller: _scroll,
                    aspects: [for (final b in _bands) b.height],
                    images: _images,
                    page: _bands[_band].page,
                    pageCount: _bands.last.page + 1,
                    showPage: _bars,
                    onMissing: _render,
                    footer: _ChapterEnd(chapter: c, next: next, onNext: next == null ? null : () => _openNext(next)),
                  ),
                ),
    );
  }
}

/// After the last page: the next chapter of the work, when the library has it.
class _ChapterEnd extends StatelessWidget {
  const _ChapterEnd({required this.chapter, required this.next, required this.onNext});

  final LibraryChapter chapter;
  final LibraryChapter? next;
  final VoidCallback? onNext;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 32, 24, 48),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(chapter.chapter != null ? 'FIM DO CAPÍTULO ${chapterLabel(chapter.chapter!)}' : 'FIM DO CAPÍTULO',
            style: const TextStyle(color: Color(0xFFFF6740), fontWeight: FontWeight.bold, letterSpacing: 1.2, fontSize: 12)),
        const SizedBox(height: 14),
        if (next != null)
          FilledButton.icon(
            onPressed: onNext,
            icon: const Icon(Icons.skip_next),
            label: Text('Próximo: Capítulo ${chapterLabel(next!.chapter!)}'),
          )
        else
          const Text('Este é o último capítulo na biblioteca.', style: TextStyle(color: Colors.white70)),
      ]),
    );
  }
}

/// The chapter's pages (or bands of them) one under the other, with the page number in a corner and
/// `footer` after the last. Ones not drawn yet show a spinner and are asked for through `onMissing`.
class ReaderPages extends StatelessWidget {
  const ReaderPages({
    super.key,
    required this.controller,
    required this.aspects,
    required this.images,
    required this.page,
    required this.onMissing,
    this.pageCount,
    this.showPage = true,
    this.footer,
  });

  final ScrollController controller;

  /// Height / width of each item.
  final List<double> aspects;
  final Map<int, Uint8List> images;

  /// The page shown (from 0), of [pageCount] (the number of items when not given).
  final int page;
  final int? pageCount;
  final bool showPage;
  final void Function(int index) onMissing;
  final Widget? footer;

  static const _footerHeight = 200.0;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return Stack(
      children: [
        ListView.builder(
          controller: controller,
          itemCount: aspects.length + (footer != null ? 1 : 0),
          itemExtentBuilder: (index, _) => index < aspects.length ? aspects[index] * width : _footerHeight,
          itemBuilder: (context, index) {
            if (index >= aspects.length) return footer;
            final bytes = images[index];
            if (bytes == null) {
              onMissing(index);
              return const Center(child: CircularProgressIndicator(strokeWidth: 2));
            }
            return Image.memory(bytes, fit: BoxFit.fill, gaplessPlayback: true);
          },
        ),
        if (showPage)
          Positioned(
            right: 12,
            bottom: 16,
            child: DecoratedBox(
              decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                child: Text('${page + 1} / ${pageCount ?? aspects.length}', style: const TextStyle(color: Colors.white)),
              ),
            ),
          ),
      ],
    );
  }
}
