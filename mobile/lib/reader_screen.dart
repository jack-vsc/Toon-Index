import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:pdfx/pdfx.dart';

import 'api.dart';
import 'downloads.dart';
import 'models.dart';

/// Reads a translated chapter, its pages one under the other. Opens where it was left, and tells
/// the PC how far it got (to the end: read), now or once the PC can be reached.
class ReaderScreen extends StatefulWidget {
  const ReaderScreen({super.key, required this.api, required this.chapter});

  final Api api;
  final LibraryChapter chapter;

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  final _scroll = ScrollController();
  PdfDocument? _document;

  /// Height / width of each page, known before the pages are drawn so the list does not jump.
  List<double> _aspects = [];
  final _images = <int, Uint8List>{};
  final _rendering = <int>{};
  Future<void> _renderQueue = Future.value();
  double? _downloadProgress;
  String? _error;
  int _page = 0;
  double _reached = 0;
  double _reported = 0;
  Timer? _reportTimer;

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
      final aspects = <double>[];
      for (var i = 1; i <= document.pagesCount; i++) {
        final page = await document.getPage(i);
        aspects.add(page.height / page.width);
        await page.close();
      }
      final start = await Store.loadPage(widget.chapter.id);
      if (!mounted) return;
      setState(() => (_document = document, _aspects = aspects, _page = start.clamp(0, aspects.length - 1)));
      // Back to where it was left, once the list has its size.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients && start > 0) _scroll.jumpTo(_offsetOf(start));
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'Não foi possível abrir o capítulo: $e');
    }
  }

  double get _width => MediaQuery.of(context).size.width;

  double _offsetOf(int page) => _aspects.take(page).fold(0.0, (sum, a) => sum + a * _width);

  void _onScroll() {
    if (_aspects.isEmpty) return;
    final position = _scroll.position;
    final total = _aspects.fold(0.0, (sum, a) => sum + a * _width);
    final bottom = position.pixels + position.viewportDimension;
    // The page at the middle of the screen.
    var page = 0;
    var y = 0.0;
    final middle = position.pixels + position.viewportDimension / 2;
    while (page < _aspects.length - 1 && y + _aspects[page] * _width < middle) {
      y += _aspects[page] * _width;
      page++;
    }
    final reached = position.pixels >= position.maxScrollExtent - 4 ? 1.0 : (bottom / total).clamp(0.0, 1.0);
    if (page != _page) {
      setState(() => _page = page);
      Store.savePage(widget.chapter.id, page);
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
    widget.api.reportAppReading(widget.chapter.id, _reached);
  }

  /// Draws pages one at a time (Android opens one page of a PDF at a time).
  Future<void> _render(int index) {
    if (_images.containsKey(index) || _rendering.contains(index)) return Future.value();
    _rendering.add(index);
    final width = (_width * MediaQuery.of(context).devicePixelRatio).clamp(600.0, 1600.0);
    return _renderQueue = _renderQueue.then((_) async {
      final document = _document;
      if (document == null || !mounted) return;
      final page = await document.getPage(index + 1);
      try {
        final image = await page.render(width: width, height: width * page.height / page.width, format: PdfPageImageFormat.jpeg, quality: 90);
        if (image != null && mounted) setState(() => _images[index] = image.bytes);
      } finally {
        await page.close();
        _rendering.remove(index);
      }
      // Pages far from the screen are let go, so a long chapter does not fill the memory.
      _images.removeWhere((i, _) => (i - _page).abs() > 6);
    });
  }

  @override
  void dispose() {
    _report();
    _scroll.dispose();
    _document?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.chapter;
    final title = c.chapter != null ? 'Capítulo ${chapterLabel(c.chapter!)}' : c.title;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(title: Text(title), backgroundColor: Colors.black),
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
              : ReaderPages(
                  controller: _scroll,
                  aspects: _aspects,
                  images: _images,
                  page: _page,
                  onMissing: _render,
                ),
    );
  }
}

/// The chapter's pages one under the other, with the page number in a corner. Pages not drawn yet
/// show a spinner and are asked for through `onMissing`.
class ReaderPages extends StatelessWidget {
  const ReaderPages({
    super.key,
    required this.controller,
    required this.aspects,
    required this.images,
    required this.page,
    required this.onMissing,
  });

  final ScrollController controller;
  final List<double> aspects;
  final Map<int, Uint8List> images;
  final int page;
  final void Function(int index) onMissing;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    return Stack(
      children: [
        ListView.builder(
          controller: controller,
          itemCount: aspects.length,
          itemExtentBuilder: (index, _) => aspects[index] * width,
          itemBuilder: (context, index) {
            final bytes = images[index];
            if (bytes == null) {
              onMissing(index);
              return const Center(child: CircularProgressIndicator(strokeWidth: 2));
            }
            return Image.memory(bytes, fit: BoxFit.fill, gaplessPlayback: true);
          },
        ),
        Positioned(
          right: 12,
          bottom: 16,
          child: DecoratedBox(
            decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              child: Text('${page + 1} / ${aspects.length}', style: const TextStyle(color: Colors.white)),
            ),
          ),
        ),
      ],
    );
  }
}
