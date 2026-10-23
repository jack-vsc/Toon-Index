import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'api.dart';
import 'browser_screen.dart';
import 'downloads.dart';
import 'library_screen.dart';
import 'models.dart';
import 'reader_screen.dart';
import 'theme.dart';

/// One work: its other names, every chapter read (and where), the ones translated on the PC, and
/// marking chapters read somewhere the apps could not see.
class WorkScreen extends StatefulWidget {
  const WorkScreen({super.key, required this.view, required this.api});

  final WorkView view;
  final Api api;

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

class _WorkScreenState extends State<WorkScreen> {
  final _chapter = TextEditingController();
  String? _message;
  Set<String> _downloaded = {};

  /// The reading list and favorite as last set here (sent to the PC now, or once it can be reached).
  late String? _shelf = widget.view.work.shelf;
  late bool _favorite = widget.view.work.favorite;

  /// Chapters being downloaded, with how much arrived (null: size unknown).
  final _downloading = <String, double?>{};

  @override
  void initState() {
    super.initState();
    _refreshDownloads();
  }

  Future<void> _refreshDownloads() async {
    final ids = await Downloads.downloaded();
    if (mounted) setState(() => _downloaded = ids);
  }

  Future<void> _download(LibraryChapter c) async {
    setState(() => _downloading[c.id] = null);
    try {
      await Downloads.download(widget.api, c.id, onProgress: (p) => mounted ? setState(() => _downloading[c.id] = p) : null);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      _downloading.remove(c.id);
      await _refreshDownloads();
    }
  }

  /// Every chapter not on the phone yet, one after another, to read without internet (on a plane, say).
  Future<void> _downloadAll() async {
    for (final c in widget.view.translated.where((c) => !_downloaded.contains(c.id)).toList()) {
      if (!mounted) return;
      await _download(c);
    }
  }

  Future<void> _removeDownload(LibraryChapter c) async {
    await Downloads.remove(c.id);
    await _refreshDownloads();
  }

  Widget _downloadButton(LibraryChapter c) {
    if (_downloading.containsKey(c.id)) {
      return SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2, value: _downloading[c.id]));
    }
    if (_downloaded.contains(c.id)) {
      return IconButton(
        tooltip: 'Baixado: tocar para apagar do celular',
        icon: const Icon(Icons.offline_pin, color: readGreen),
        onPressed: () => _removeDownload(c),
      );
    }
    return IconButton(tooltip: 'Baixar para ler sem internet', icon: const Icon(Icons.download), onPressed: () => _download(c));
  }

  Future<void> _setShelf({String? shelf, bool? favorite, bool clearShelf = false}) async {
    setState(() {
      if (shelf != null || clearShelf) _shelf = shelf;
      if (favorite != null) _favorite = favorite;
    });
    await widget.api.setShelf(widget.view.work.id, shelf: _shelf, favorite: _favorite);
  }

  void _read(LibraryChapter c) =>
      Navigator.push(context, MaterialPageRoute(builder: (_) => ReaderScreen(api: widget.api, chapter: c, chapters: widget.view.translated)));

  Future<void> _markRead() async {
    final chapter = double.tryParse(_chapter.text.trim().replaceAll(',', '.'));
    if (chapter == null) return;
    try {
      await widget.api.markRead(widget.view.work.id, chapter);
      if (mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      setState(() => _message = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final view = widget.view;
    final aliases = view.work.names.skip(1).map(displayName).toList();
    final missing = view.translated.where((c) => !_downloaded.contains(c.id)).toList();
    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(backgroundColor: Colors.transparent),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 16),
        children: [
          _Header(view: view, api: widget.api, aliases: aliases),
          Row(children: [
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _shelf ?? '',
                isDense: true,
                decoration: const InputDecoration(labelText: 'Lista', contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10)),
                items: [
                  DropdownMenuItem(value: '', child: Text(view.records.isNotEmpty ? 'Lendo (automático)' : 'Em nenhuma lista')),
                  for (final e in shelves.entries) DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: (v) => _setShelf(shelf: v == null || v.isEmpty ? null : v, clearShelf: v == null || v.isEmpty),
              ),
            ),
            const SizedBox(width: 8),
            IconButton.filledTonal(
              tooltip: _favorite ? 'Tirar das favoritas' : 'Favoritar',
              icon: Icon(_favorite ? Icons.star : Icons.star_border, color: _favorite ? const Color(0xFFFFC940) : null),
              onPressed: () => _setShelf(favorite: !_favorite),
            ),
          ]),
          const SizedBox(height: 10),
          Text(statusText(view), style: const TextStyle(color: readGreen)),
          if (view.nextInLibrary != null) ...[
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: () => _read(view.nextInLibrary!),
              icon: Icon(_downloaded.contains(view.nextInLibrary!.id) ? Icons.offline_pin : Icons.play_arrow),
              label: Text('${view.current != null || view.readUpTo != null ? 'Continuar' : 'Começar'}: capítulo ${chapterLabel(view.nextInLibrary!.chapter!)}'),
            ),
          ],
          if (view.update != null) ...[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => BrowserScreen(api: widget.api, url: view.update!.url))),
              icon: const Icon(Icons.fiber_new),
              label: Text('Ler o cap. ${chapterLabel(view.update!.latest)} em ${view.update!.site}'),
            ),
          ],
          if (view.records.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text('Capítulos lidos', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final r in view.records)
                  ActionChip(
                    label: Text(r.read
                        ? '${chapterLabel(r.chapter)} ✓'
                        : '${chapterLabel(r.chapter)} · ${r.progress != null ? '${(r.progress! * 100).round()}%' : '…'}'),
                    labelStyle: TextStyle(color: r.read ? readGreen : accentSoft),
                    onPressed: r.url.isEmpty
                        ? null
                        : () => Navigator.push(context, MaterialPageRoute(builder: (_) => BrowserScreen(api: widget.api, url: r.url))),
                  ),
              ],
            ),
          ],
          if (view.translated.isNotEmpty) ...[
            const SizedBox(height: 18),
            Row(children: [
              Expanded(child: Text('No PC', style: Theme.of(context).textTheme.titleMedium)),
              if (missing.isNotEmpty)
                TextButton.icon(
                  onPressed: _downloading.isEmpty ? _downloadAll : null,
                  icon: const Icon(Icons.download_for_offline),
                  label: Text('Baixar todos (${missing.length})'),
                ),
            ]),
            for (final c in view.translated)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: c.hasCover
                    ? ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: Image.network('${widget.api.base}/api/cover/${c.id}',
                            headers: widget.api.authHeaders, width: 40, height: 56, fit: BoxFit.cover,
                            errorBuilder: (_, _, _) => const SizedBox(width: 40)),
                      )
                    : null,
                title: Text(c.chapter != null ? 'Capítulo ${chapterLabel(c.chapter!)}' : c.title),
                subtitle: Text(c.downloaded
                    ? '${c.pageCount} páginas · baixado do site'
                    : c.translatedPages == c.pageCount
                        ? '${c.pageCount} páginas · traduzido'
                        : '${c.translatedPages} de ${c.pageCount} páginas traduzidas'),
                trailing: _downloadButton(c),
                onTap: () => _read(c),
              ),
          ],
          const SizedBox(height: 24),
          Text('Leu em outro lugar?', style: Theme.of(context).textTheme.titleMedium),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _chapter,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Capítulo'),
                  onSubmitted: (_) => _markRead(),
                ),
              ),
              const SizedBox(width: 12),
              FilledButton.tonal(onPressed: _markRead, child: const Text('Marcar lido até ele')),
            ],
          ),
          if (_message != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_message!)),
        ].map((w) => w is _Header ? w : Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: w)).toList(),
      ),
    );
  }
}

/// The work's cover over a blurred copy of it, its names and tags (MangaDex's title page).
class _Header extends StatelessWidget {
  const _Header({required this.view, required this.api, required this.aliases});

  final WorkView view;
  final Api api;
  final List<String> aliases;

  @override
  Widget build(BuildContext context) {
    final cover = coverUrlOf(view, api);
    final top = MediaQuery.paddingOf(context).top + kToolbarHeight;
    return Stack(children: [
      if (cover != null)
        Positioned.fill(
          child: ClipRect(
            child: ImageFiltered(
              imageFilter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
              child: Image.network(cover,
                  headers: api.authHeaders, fit: BoxFit.cover, color: Colors.black54, colorBlendMode: BlendMode.darken, errorBuilder: (_, _, _) => const SizedBox()),
            ),
          ),
        ),
      Positioned.fill(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Theme.of(context).scaffoldBackgroundColor]),
          ),
        ),
      ),
      Padding(
        padding: EdgeInsets.fromLTRB(16, top, 16, 16),
        child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          SizedBox(width: 110, child: CoverImage(url: cover, api: api)),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(view.work.name, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, height: 1.15)),
              if (aliases.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(aliases.join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70, fontSize: 12)),
              ],
              const SizedBox(height: 8),
              Wrap(spacing: 6, runSpacing: 6, children: [
                Tag(view.work.isNovel ? 'NOVEL' : 'MANGÁ'),
                if (view.translated.isNotEmpty) Tag(view.chapterCount),
                if (view.update != null) Tag('NOVO · ${chapterLabel(view.update!.latest)}', color: accent),
              ]),
            ]),
          ),
        ]),
      ),
    ]);
  }
}
