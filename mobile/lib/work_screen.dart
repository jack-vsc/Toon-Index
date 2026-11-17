import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'api.dart';
import 'batch_screen.dart';
import 'browser_screen.dart';
import 'downloads.dart';
import 'downloads_screen.dart';
import 'library_screen.dart';
import 'models.dart';
import 'reader_screen.dart';
import 'site_download.dart';
import 'theme.dart';
import 'work_editor_screen.dart';

/// Chapters listed from 1 up to the newest; past this (a number misread from a title) only the known ones.
const _maxListed = 3000;

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
    final phone = await phoneChaptersOf(widget.view.work.id);
    if (mounted) setState(() => (_downloaded = ids, _phone = phone));
  }

  /// Chapters the phone downloaded from the sites.
  List<LibraryChapter> _phone = [];

  /// The new chapter on its site, downloaded where the settings say.
  Future<void> _downloadUpdate(ChapterUpdate update) async {
    final messenger = ScaffoldMessenger.of(context);
    final message = await SiteDownloads.request(
      context,
      widget.api,
      SiteChapter(url: update.url, work: widget.view.work.name, workId: widget.view.work.id, chapter: update.latest, site: update.site),
    );
    if (message != null) messenger.showSnackBar(SnackBar(content: Text(message)));
    await _refreshDownloads();
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

  /// Versions deleted here, gone from the PC's library already.
  final _deleted = <String>{};

  /// The PC's chapters of the work, every version of each.
  List<LibraryChapter> get _translated => widget.view.translated.where((c) => !_deleted.contains(c.id)).toList();

  /// One version of each chapter, the newest, to download and read on from.
  List<LibraryChapter> get _readable => widget.view.readable.where((c) => !_deleted.contains(c.id)).toList();

  /// What can be done with a chapter, as on the PC: read or unread, read up to it, delete what was translated.
  Future<void> _chapterMenu(double n, bool read, List<LibraryChapter> versions) => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (sheet) {
          void then(Future<void> Function() action) {
            Navigator.pop(sheet);
            action();
          }

          final one = widget.view.work.unitOne;
          return SafeArea(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                child: Align(alignment: Alignment.centerLeft, child: Text('$one ${chapterLabel(n)}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800))),
              ),
              ListTile(
                leading: Icon(read ? Icons.radio_button_unchecked : Icons.check_circle_outline),
                title: Text(read ? 'Marcar como não lido' : 'Marcar como lido'),
                onTap: () => then(() => _setRead([n], !read)),
              ),
              ListTile(
                leading: const Icon(Icons.done_all),
                title: const Text('Lidos até aqui'),
                subtitle: Text('Do 1 ao ${chapterLabel(n)}'),
                onTap: () => then(() => _readUpTo(n)),
              ),
              for (final v in versions)
                ListTile(
                  leading: const Icon(Icons.delete_outline, color: Color(0xFFE5484D)),
                  title: Text(versions.length > 1 ? 'Apagar a versão de ${v.site}' : 'Apagar ${v.downloaded ? 'o baixado' : 'a tradução'}'),
                  subtitle: Text(v.downloaded ? 'Baixado · ${v.site}' : 'Traduzido · ${v.site}'),
                  onTap: () => then(() => _deleteVersion(v)),
                ),
            ]),
          );
        },
      );

  Future<void> _deleteVersion(LibraryChapter c) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Apagar o capítulo ${chapterLabel(c.chapter!)} de ${c.site}?'),
        content: const Text('Ele sai da biblioteca do PC (e do celular, se foi baixado).'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Apagar')),
        ],
      ),
    );
    if (sure != true) return;
    try {
      await widget.api.deleteChapter(c.id);
      await Downloads.remove(c.id);
      setState(() => _deleted.add(c.id));
      await _refreshDownloads();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// Every chapter not on the phone yet, one after another, to read without internet (on a plane, say).
  Future<void> _downloadAll() async {
    for (final c in _readable.where((c) => !_downloaded.contains(c.id)).toList()) {
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

  void _read(LibraryChapter c) => Navigator.push(
      context,
      // Reading on goes to the next chapter's newest version; this one stays the one opened.
      MaterialPageRoute(builder: (_) => ReaderScreen(api: widget.api, chapter: c, chapters: _readable.map((r) => r.chapter == c.chapter ? c : r).toList())));

  Future<void> _markRead() async {
    final chapter = double.tryParse(_chapter.text.trim().replaceAll(',', '.'));
    if (chapter == null) return;
    await _readUpTo(chapter);
    if (mounted) Navigator.pop(context);
  }

  /// Read or unread by hand. Shown at once; the PC gets it now or once it answers.
  final Map<double, bool> _readNow = {};

  bool _isRead(double chapter, ReadingRecord? record) => _readNow[chapter] ?? record?.read == true;

  Future<void> _setRead(List<double> chapters, bool read) async {
    if (chapters.isEmpty) return;
    setState(() => _readNow.addAll({for (final c in chapters) c: read}));
    try {
      read ? await widget.api.markRead(widget.view.work.id, chapters) : await widget.api.forget(widget.view.work.id, chapters);
    } on ApiException catch (e) {
      if (mounted) setState(() => _message = e.message);
    }
  }

  /// This chapter and every one before it, from 1 (the ones not marked yet).
  Future<void> _readUpTo(double chapter) {
    final records = {for (final r in widget.view.records) r.chapter: r};
    final before = {
      for (var n = 1; n <= chapter && n <= _maxListed; n++) n.toDouble(),
      for (final r in widget.view.records) if (r.chapter <= chapter) r.chapter,
      for (final c in widget.view.translated) if (c.chapter != null && c.chapter! <= chapter) c.chapter!,
      chapter,
    };
    return _setRead([for (final c in before) if (!_isRead(c, records[c])) c]..sort(), true);
  }

  /// The chapter list: filtered by number, newest or oldest first.
  String _chapterQuery = '';
  bool _oldestFirst = false;

  /// The chapters after the last one read (or in the library), from the work's sites, to the PC's queue.
  void _next() {
    final view = widget.view;
    final had = [view.readUpTo ?? 0, ..._translated.map((c) => c.chapter ?? 0)].reduce((a, b) => a > b ? a : b);
    Navigator.push(context, MaterialPageRoute(builder: (_) => BatchScreen(api: widget.api, work: view.work, after: had)));
  }

  void _browse(String url) => Navigator.push(context, MaterialPageRoute(builder: (_) => BrowserScreen(api: widget.api, url: url)));

  @override
  Widget build(BuildContext context) {
    final view = widget.view;
    final aliases = view.work.names.skip(1).map(displayName).toList();
    final missing = _readable.where((c) => !_downloaded.contains(c.id)).toList();
    final newest = view.newest;
    final share = view.share;
    final next = view.nextInLibrary;
    final continueUrl = view.continueUrl;
    final shelf = _shelf ?? (view.records.isNotEmpty ? 'reading' : null);
    // Every chapter read or translated, the reading and the translations of each side by side (one per
    // site it was saved from, newest first).
    final rows = <double, ({ReadingRecord? record, List<LibraryChapter> versions})>{};
    // From chapter 1 up to the newest known, even the ones neither read nor translated (a work started
    // at chapter 50 still lists 1 to 49, to mark as read).
    for (var n = 1; newest != null && n <= newest && n <= _maxListed; n++) {
      rows[n.toDouble()] = (record: null, versions: []);
    }
    for (final r in view.records) {
      rows[r.chapter] = (record: r, versions: []);
    }
    for (final c in _translated.where((c) => c.chapter != null)) {
      rows.putIfAbsent(c.chapter!, () => (record: null, versions: [])).versions.add(c);
    }
    for (final row in rows.values) {
      row.versions.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    }
    final query = _chapterQuery.trim().replaceAll(',', '.');
    final numbers = rows.keys.where((n) => query.isEmpty || chapterLabel(n).startsWith(query)).toList()
      ..sort((a, b) => _oldestFirst ? a.compareTo(b) : b.compareTo(a));
    final heading = Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800);
    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(backgroundColor: Colors.transparent, actions: [
        if (widget.api.paired)
          IconButton(
            tooltip: 'Editar obra',
            icon: const Icon(Icons.edit_outlined),
            onPressed: () async {
              final changed = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => WorkEditorScreen(work: view.work, api: widget.api)));
              // Back to the library, which brings the work as the PC now has it.
              if (changed == true && context.mounted) Navigator.pop(context);
            },
          ),
      ]),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          _Header(view: view, api: widget.api, aliases: aliases, shelf: shelf),
          Wrap(spacing: 14, runSpacing: 4, children: [
            if (newest != null) Text.rich(TextSpan(children: [TextSpan(text: chapterLabel(newest), style: const TextStyle(fontWeight: FontWeight.w800)), TextSpan(text: ' ${view.work.unitMany.toLowerCase()}')])),
            if (_readable.isNotEmpty)
              Text.rich(TextSpan(children: [TextSpan(text: '${_readable.length}', style: const TextStyle(fontWeight: FontWeight.w800)), const TextSpan(text: ' no PC')])),
          ]),
          const SizedBox(height: 4),
          Text(statusText(view), style: const TextStyle(color: muted, fontSize: 13)),
          const SizedBox(height: 14),
          Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (next != null)
              FilledButton.icon(
                onPressed: () => _read(next),
                icon: Icon(_downloaded.contains(next.id) ? Icons.offline_pin : Icons.play_arrow),
                label: Text('${view.current != null || view.readUpTo != null ? 'Continuar' : 'Começar'}: cap. ${chapterLabel(next.chapter!)}'),
              )
            else if (continueUrl != null)
              FilledButton.icon(onPressed: () => _browse(continueUrl), icon: const Icon(Icons.play_arrow), label: const Text('Continuar')),
            if (next != null && continueUrl != null) OutlinedButton(onPressed: () => _browse(continueUrl), child: const Text('No site')),
            if (view.update != null)
              OutlinedButton(onPressed: () => _browse(view.update!.url), child: Text('Último · ${view.work.unitShort} ${chapterLabel(view.update!.latest)}')),
            if (view.update != null)
              IconButton.outlined(tooltip: 'Baixar o capítulo novo para ler sem internet', icon: const Icon(Icons.download), onPressed: () => _downloadUpdate(view.update!)),
            if (widget.api.paired)
              OutlinedButton.icon(
                onPressed: _next,
                icon: const Icon(Icons.playlist_add, size: 18),
                label: const Text('Próximos capítulos'),
              ),
            OutlinedButton.icon(
              onPressed: () => _setShelf(favorite: !_favorite),
              icon: Icon(_favorite ? Icons.favorite : Icons.favorite_border, color: _favorite ? accent : null, size: 18),
              label: Text(_favorite ? 'Favorita' : 'Favoritar'),
            ),
            PopupMenuButton<String>(
              tooltip: 'A lista de leitura da obra',
              onSelected: (v) => _setShelf(shelf: v.isEmpty ? null : v, clearShelf: v.isEmpty),
              itemBuilder: (_) => [
                PopupMenuItem(value: '', child: Text(view.records.isNotEmpty ? 'Lendo (automático)' : 'Em nenhuma lista')),
                for (final e in shelves.entries) PopupMenuItem(value: e.key, child: Text(e.value)),
              ],
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(99), border: Border.all(color: lineColor)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(_shelf != null ? shelves[_shelf]! : (view.records.isNotEmpty ? 'Lendo' : 'Status'), style: const TextStyle(fontWeight: FontWeight.w600)),
                  const Icon(Icons.expand_more, size: 18),
                ]),
              ),
            ),
          ]),
          if (share != null && newest != null) ...[
            const SizedBox(height: 14),
            Row(children: [
              Expanded(child: ProgressBar(share)),
              const SizedBox(width: 12),
              Text('${chapterLabel(view.readUpTo!)} de ${chapterLabel(newest)} lidos', style: const TextStyle(color: muted, fontSize: 12)),
            ]),
          ],
          const SizedBox(height: 22),
          _Panel(children: [
            Row(children: [
              Text(view.work.unitMany, style: heading),
              Text('  ${rows.length}', style: const TextStyle(color: muted)),
              const Spacer(),
              SizedBox(
                width: 120,
                child: TextField(
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(hintText: 'Nº', isDense: true, prefixIcon: Icon(Icons.search, size: 18)),
                  onChanged: (q) => setState(() => _chapterQuery = q),
                ),
              ),
              TextButton(
                onPressed: () => setState(() => _oldestFirst = !_oldestFirst),
                child: Text(_oldestFirst ? '↑ Antigos' : '↓ Recentes'),
              ),
            ]),
            if (rows.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 10), child: Text('Nenhum capítulo lido ou traduzido ainda.', style: TextStyle(color: muted))),
            for (final n in numbers) _chapterRow(view.work, n, rows[n]!.record, rows[n]!.versions),
            if (missing.isNotEmpty) ...[
              const SizedBox(height: 6),
              TextButton.icon(
                onPressed: _downloading.isEmpty ? _downloadAll : null,
                icon: const Icon(Icons.download_for_offline),
                label: Text('Baixar todos do PC para o celular (${missing.length})'),
              ),
            ],
          ]),
          if (_phone.isNotEmpty) ...[
            const SizedBox(height: 14),
            _Panel(children: [
              Text('No celular', style: heading),
              for (final c in _phone)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.offline_pin, color: readGreen),
                  title: Text(c.chapter != null ? '${view.work.unitOne} ${chapterLabel(c.chapter!)}' : c.title),
                  subtitle: Text('${c.pageCount} páginas · baixado do site no celular', style: const TextStyle(color: muted, fontSize: 12)),
                  trailing: IconButton(
                    tooltip: 'Apagar do celular',
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      await PhoneChapter.remove(c.id);
                      await _refreshDownloads();
                    },
                  ),
                  onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ReaderScreen(api: widget.api, chapter: c, chapters: _phone))),
                ),
            ]),
          ],
          const SizedBox(height: 14),
          _Panel(children: [
            Text('Informações', style: heading),
            const SizedBox(height: 8),
            _Info('Formato', view.work.isNovel ? 'Novel' : 'Mangá'),
            _Info('Lista', shelf != null ? shelves[shelf]! : 'Nenhuma'),
            if (newest != null) _Info(view.work.unitMany, chapterLabel(newest)),
            if (aliases.isNotEmpty) _Info('Outros nomes', aliases.join(' · ')),
            const SizedBox(height: 12),
            const Text('Leu em outro lugar?', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _chapter,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(hintText: 'Capítulo', isDense: true),
                  onSubmitted: (_) => _markRead(),
                ),
              ),
              const SizedBox(width: 10),
              FilledButton.tonal(onPressed: _markRead, child: const Text('Marcar lido até ele')),
            ]),
            if (_message != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_message!)),
          ]),
        ].map((w) => w is _Header ? w : Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: w)).toList(),
      ),
    );
  }

  /// A chapter as on the scans' title pages: its number big, its state, and reading it; saved from more
  /// than one site, each version to read or delete.
  Widget _chapterRow(Work work, double n, ReadingRecord? record, List<LibraryChapter> versions) {
    final entry = versions.firstOrNull;
    final read = _isRead(n, record);
    final released = work.dateOf(n);
    final where = [
      if (released != null) releaseLabel(released),
      if (record != null)
        [if (record.url.isNotEmpty) Uri.tryParse(record.url)?.host.replaceFirst(RegExp(r'^www\.'), '') ?? '', timeAgo(record.updatedAt)].where((s) => s.isNotEmpty).join(' · ')
      else if (entry != null)
        '${entry.site} · ${timeAgo(entry.createdAt)}',
    ].join(' · ');
    return InkWell(
      onTap: entry != null ? () => _read(entry) : record != null && record.url.isNotEmpty ? () => _browse(record.url) : null,
      onLongPress: () => _chapterMenu(n, read, versions),
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          SizedBox(
            width: 52,
            child: Text(chapterLabel(n), textAlign: TextAlign.center, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: read ? muted : null)),
          ),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Text('${work.unitOne} ${chapterLabel(n)}', style: const TextStyle(fontWeight: FontWeight.w600)),
                if (read) Tag('lido', color: readGreen.withValues(alpha: 0.16), textColor: readGreen),
                if (record != null && !read) Tag(record.progress != null ? '${(record.progress! * 100).round()}%' : 'lendo', color: accent.withValues(alpha: 0.16), textColor: accentSoft),
                if (versions.length == 1) Tag(entry!.downloaded ? 'baixado' : 'traduzido', color: accent.withValues(alpha: 0.16), textColor: accentSoft),
                if (versions.length > 1) Tag('${versions.length} versões', color: accent.withValues(alpha: 0.16), textColor: accentSoft),
              ]),
              if (where.isNotEmpty) Text(where, style: const TextStyle(color: muted, fontSize: 12)),
              if (versions.length > 1)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Wrap(spacing: 6, runSpacing: 6, children: [
                    for (final v in versions)
                      InputChip(
                        visualDensity: VisualDensity.compact,
                        label: Text('${v.site} · ${v.downloaded ? 'baixado' : 'traduzido'}', style: const TextStyle(fontSize: 12)),
                        tooltip: 'Ler esta versão',
                        onPressed: () => _read(v),
                        deleteIcon: const Icon(Icons.close, size: 16),
                        deleteButtonTooltipMessage: 'Apagar esta versão',
                        onDeleted: () => _deleteVersion(v),
                      ),
                  ]),
                ),
            ]),
          ),
          if (entry != null) _downloadButton(entry),
          IconButton(
            tooltip: read ? 'Marcar como não lido' : 'Marcar como lido',
            icon: Icon(read ? Icons.check_circle : Icons.radio_button_unchecked, color: read ? readGreen : muted),
            onPressed: () => _setRead([n], !read),
          ),
          IconButton(
            tooltip: 'Mais: lidos até aqui, apagar',
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.more_vert, color: muted),
            onPressed: () => _chapterMenu(n, read, versions),
          ),
        ]),
      ),
    );
  }
}

/// A rounded card on the page (the scans' chapter list and info boxes).
class _Panel extends StatelessWidget {
  const _Panel({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: panel, borderRadius: BorderRadius.circular(16), border: Border.all(color: lineColor)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
      );
}

class _Info extends StatelessWidget {
  const _Info(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 110, child: Text(label, style: const TextStyle(color: muted, fontSize: 13))),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ]),
      );
}

/// The work's cover over a blurred copy of it, its tags and names (the scans' title page).
class _Header extends StatelessWidget {
  const _Header({required this.view, required this.api, required this.aliases, required this.shelf});

  final WorkView view;
  final Api api;
  final List<String> aliases;
  final String? shelf;

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
              child: ColorFiltered(
                colorFilter: const ColorFilter.mode(Colors.black54, BlendMode.darken),
                child: CoverImage(url: cover, api: api, fill: true),
              ),
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
          SizedBox(width: 120, child: CoverImage(url: cover, api: api, radius: 12, title: view.work.name)),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(spacing: 6, runSpacing: 6, children: [
                Tag(view.work.isNovel ? 'Novel' : 'Mangá'),
                if (shelf != null) Tag(shelves[shelf]!, color: readGreen.withValues(alpha: 0.16), textColor: readGreen),
                if (view.update != null) Tag('Novo · ${chapterLabel(view.update!.latest)}', color: accent),
              ]),
              const SizedBox(height: 8),
              Text(view.work.name, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, height: 1.12)),
              if (aliases.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(aliases.join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70, fontSize: 12)),
              ],
            ]),
          ),
        ]),
      ),
    ]);
  }
}
