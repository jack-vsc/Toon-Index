import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'api.dart';
import 'app_update.dart';
import 'auto_downloads.dart';
import 'browser_screen.dart';
import 'cloud.dart';
import 'local_data.dart';
import 'downloads_screen.dart';
import 'models.dart';
import 'batch_screen.dart';
import 'reader_screen.dart';
import 'queue_screen.dart';
import 'search_screen.dart';
import 'settings_screen.dart';
import 'theme.dart';
import 'translate_screen.dart';
import 'work_screen.dart';

/// Every work read or translated, where it was left, the most recent first. Shows the last library
/// seen when the PC cannot be reached.
/// Bumped to bring the app back to its start (the browser's home button, from deep in a site).
final appHome = ValueNotifier(0);

class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key, required this.api, required this.onUnpaired, required this.onConnect});

  final Api api;
  final VoidCallback onUnpaired;

  /// Pairs with a PC, from a phone used on its own.
  final VoidCallback onConnect;

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  Library? _library;
  String? _error;
  bool _loading = false;

  /// The list shown: 'all', 'favorite' or a key of [shelves].
  String _filter = 'all';

  @override
  void initState() {
    super.initState();
    appHome.addListener(_toStart);
    Store.loadLibrary().then((cached) async {
      if (cached == null) return;
      final shown = cached.withShelves(await Store.loadPending(Store.pendingShelves));
      if (mounted && _library == null) setState(() => _library = shown);
    });
    _refresh();
    unawaited(Cloud.listen(opened: _notified, arrived: (title, data) {
      _refresh();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(title),
        action: SnackBarAction(label: 'Ver', onPressed: () => _notified(data)),
      ));
    }));
  }

  /// A new-chapter notification tapped: its work, or the chapter on the site when the work is not here yet.
  Future<void> _notified(Map<String, dynamic> data) async {
    await _refresh();
    final view = _library?.views.where((v) => v.work.id == data['workId']).firstOrNull;
    if (view != null) {
      await _openWork(view);
    } else if (data['url'] is String) {
      await _browse(data['url'] as String);
    }
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    try {
      final library = (await widget.api.library()).withShelves(await Store.loadPending(Store.pendingShelves));
      if (mounted) setState(() => (_library = library, _error = null));
      // The PC reached: a newer build of this app there is offered, and the next chapters are kept for away from home.
      if (mounted) AppUpdate.offer(context, widget.api);
      unawaited(AutoDownloads.run(widget.api, library));
    } on UnpairedException {
      await Store.forgetConnection();
      widget.onUnpaired();
    } on ApiException catch (e) {
      // The phone's own data, with what was read here since.
      final local = (await LocalData.library()).withShelves(await Store.loadPending(Store.pendingShelves));
      if (mounted) setState(() => (_library = local, _error = widget.api.paired ? e.message : null));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// The app's browser, at `url` or at its start page; back here, the readings it sent show up.
  Future<void> _browse(String? url) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => BrowserScreen(api: widget.api, url: url, recent: _library?.views ?? [])));
    _refresh();
  }

  /// Subscribes the ntfy app to the PC's topic, so new chapters arrive even with the PC out of reach.
  Future<void> _subscribe(String topic) async {
    final messenger = ScaffoldMessenger.of(context);
    var opened = false;
    try {
      opened = await launchUrl(Uri.parse('ntfy://ntfy.sh/$topic'), mode: LaunchMode.externalApplication);
    } catch (_) {}
    if (opened) return;
    messenger.showSnackBar(SnackBar(
      content: const Text('Instale o app ntfy e toque em 🔔 de novo.'),
      action: SnackBarAction(
        label: 'Play Store',
        onPressed: () => launchUrl(Uri.parse('https://play.google.com/store/apps/details?id=io.heckel.ntfy'), mode: LaunchMode.externalApplication),
      ),
    ));
  }

  Future<void> _unpair() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Desparear?'),
        content: const Text('O celular para de sincronizar com o PC até ser pareado de novo. A biblioteca e as leituras continuam no celular.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Desparear')),
        ],
      ),
    );
    if (ok != true) return;
    await Store.forgetConnection();
    widget.onUnpaired();
  }

  @override
  void dispose() {
    appHome.removeListener(_toStart);
    super.dispose();
  }

  void _toStart() {
    if (mounted) setState(() => _tab = 0);
  }

  /// The tab shown: 0 the start (where the reading is, new chapters), 1 every new chapter, 2 the collection.
  int _tab = 0;

  /// The collection's order: a key of [_sorts].
  String _sort = 'recent';

  /// 'all', 'comic' or 'novel'.
  String _format = 'all';

  Future<void> _search() async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => SearchScreen(api: widget.api, views: _library?.views ?? [])));
    _refresh();
  }

  Future<void> _batch() async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => BatchScreen(api: widget.api)));
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final views = _library?.views ?? [];
    final fresh = views.where((v) => v.update != null).length;
    return Scaffold(
      appBar: AppBar(
        title: Text(const ['Toon Index', 'Novidades', 'Biblioteca'][_tab], style: const TextStyle(fontWeight: FontWeight.w800)),
        actions: [
          IconButton(tooltip: 'Buscar obra', icon: const Icon(Icons.search), onPressed: _search),
          PopupMenuButton<String>(
            onSelected: (action) => switch (action) {
              'queue' => Navigator.push(context, MaterialPageRoute(builder: (_) => QueueScreen(api: widget.api))),
              'downloads' => Navigator.push(context, MaterialPageRoute(builder: (_) => DownloadsScreen(api: widget.api))),
              _ => Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => SettingsScreen(
                      api: widget.api,
                      onConnect: widget.onConnect,
                      onUnpair: _unpair,
                      ntfyTopic: _library?.ntfyTopic,
                      onSubscribe: _subscribe,
                    ),
                  ),
                ).then((_) => _refresh()),
            },
            itemBuilder: (_) => [
              if (widget.api.paired) const PopupMenuItem(value: 'queue', child: Text('Fila do PC')),
              const PopupMenuItem(value: 'downloads', child: Text('Downloads')),
              const PopupMenuItem(value: 'settings', child: Text('Configurações')),
            ],
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        // Início, Browser, Biblioteca, Novidades; Browser opens the sites' browser over the tabs instead of being one.
        selectedIndex: const [0, 3, 2][_tab],
        onDestinationSelected: (i) => i == 1 ? _browse(null) : setState(() => _tab = const [0, -1, 2, 1][i]),
        height: 64,
        destinations: [
          const NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Início'),
          const NavigationDestination(icon: Icon(Icons.public), label: 'Browser'),
          const NavigationDestination(
            icon: Icon(Icons.collections_bookmark_outlined),
            selectedIcon: Icon(Icons.collections_bookmark),
            label: 'Biblioteca',
          ),
          NavigationDestination(
            icon: Badge(isLabelVisible: fresh > 0, label: Text('$fresh'), child: const Icon(Icons.notifications_outlined)),
            selectedIcon: Badge(isLabelVisible: fresh > 0, label: Text('$fresh'), child: const Icon(Icons.notifications)),
            label: 'Novidades',
          ),
        ],
      ),
      floatingActionButton: _tab == 0
          ? FloatingActionButton.extended(
              onPressed: () async {
                await Navigator.push(context, MaterialPageRoute(builder: (_) => TranslateScreen(api: widget.api)));
                _refresh();
              },
              icon: const Icon(Icons.translate),
              label: const Text('Traduzir no PC'),
            )
          : null,
      body: RefreshIndicator(onRefresh: _refresh, child: switch (_tab) { 0 => _home(views), 1 => _updates(views), _ => _collection(views) }),
    );
  }

  List<Widget> _notices(List<WorkView> views) => [
        if (_loading && _library == null) const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Text(
              _library == null ? _error! : '$_error\nMostrando os dados do celular; eles vão para o PC quando ele responder.',
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        if (_library != null && views.isEmpty)
          const Padding(
            padding: EdgeInsets.all(40),
            child: Text('Nada por aqui ainda. O que você ler e traduzir aparece nesta lista.', textAlign: TextAlign.center),
          ),
      ];

  /// The start: the work being read, big; new chapters; the works read lately in a row.
  Widget _home(List<WorkView> views) {
    final fresh = freshViews(views);
    final recent = [...views]..sort((a, b) => b.lastActivity.compareTo(a.lastActivity));
    final current = recent.where((v) => v.continueUrl != null || v.nextInLibrary != null).firstOrNull;
    final heading = Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800);
    return ListView(padding: const EdgeInsets.fromLTRB(14, 4, 14, 96), children: [
      ..._notices(views),
      if (current != null) _Hero(view: current, api: widget.api, onOpen: () => _openWork(current), onBrowse: _browse, onRead: (c) => _read(current, c)),
      if (fresh.isNotEmpty) ...[
        const SizedBox(height: 22),
        Row(children: [
          Expanded(child: Text('Capítulos novos', style: heading)),
          if (fresh.length > _homeUpdates) TextButton(onPressed: () => setState(() => _tab = 1), child: Text('Ver todos (${fresh.length}) →')),
        ]),
        const SizedBox(height: 8),
        for (final view in fresh.take(_homeUpdates)) _UpdateRow(view: view, api: widget.api, onOpen: () => _openWork(view), onBrowse: _browse),
      ],
      if (recent.isNotEmpty) ...[
        const SizedBox(height: 22),
        Row(children: [
          Expanded(child: Text('Lidos recentemente', style: heading)),
          TextButton(onPressed: () => setState(() => _tab = 2), child: const Text('Ver tudo →')),
        ]),
        const SizedBox(height: 4),
        SizedBox(
          height: 290,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: recent.length.clamp(0, 12),
            separatorBuilder: (_, _) => const SizedBox(width: 12),
            itemBuilder: (_, i) => SizedBox(width: 120, child: Poster(view: recent[i], api: widget.api, onOpen: () => _openWork(recent[i]))),
          ),
        ),
      ],
      if (widget.api.paired) ...[
        const SizedBox(height: 18),
        OutlinedButton.icon(onPressed: _batch, icon: const Icon(Icons.library_add), label: const Text('Traduzir ou baixar vários capítulos')),
      ],
    ]);
  }

  /// How many new chapters the start shows; the rest are on their own tab.
  static const _homeUpdates = 5;

  /// Every work with a chapter out past the last one read: the app's notices.
  Widget _updates(List<WorkView> views) {
    final fresh = freshViews(views);
    final library = _library;
    final checked = library?.lastCheck != null ? 'Última checagem ${timeAgo(library!.lastCheck!)}' : 'Ainda não checado';
    return ListView(padding: const EdgeInsets.fromLTRB(14, 4, 14, 32), children: [
      ..._notices(views),
      Row(children: [
        Expanded(
          child: Text(
            library?.checking == true ? 'O PC está checando os sites agora…' : '$checked · a cada 2 horas',
            style: const TextStyle(color: muted, fontSize: 12),
          ),
        ),
        if (widget.api.paired)
          TextButton.icon(
            onPressed: library?.checking == true ? null : _checkUpdates,
            icon: const Icon(Icons.refresh, size: 18),
            label: const Text('Checar agora'),
          ),
      ]),
      const Text('Capítulos que saíram nos últimos 7 dias depois do último que você leu. A obra sai daqui quando você lê o capítulo.',
          style: TextStyle(color: muted, fontSize: 12)),
      const SizedBox(height: 12),
      if (library != null && fresh.isEmpty)
        const Padding(padding: EdgeInsets.all(28), child: Text('Nenhum capítulo novo nos últimos 7 dias.', textAlign: TextAlign.center)),
      for (final view in fresh)
        _UpdateRow(
          view: view,
          api: widget.api,
          onOpen: () => _openWork(view),
          onBrowse: _browse,
          onTranslate: widget.api.paired ? () => _translate(view) : null,
        ),
      ..._history(library),
    ]);
  }

  /// History rows shown, a page more each time "Mostrar mais" is pressed.
  int _historyShown = 40;

  /// Chapters out over a week ago and not read yet: one compact line each, a page at a time.
  List<Widget> _history(Library? library) {
    final older = library?.older ?? const [];
    if (older.isEmpty) return const [];
    return [
      const SizedBox(height: 20),
      Text('Histórico · ${older.length}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
      const Text('Capítulos que saíram há mais de 7 dias e você ainda não leu.', style: TextStyle(color: muted, fontSize: 12)),
      const SizedBox(height: 6),
      for (final (work, update) in older.take(_historyShown))
        InkWell(
          onTap: () => _browse(update.url),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(children: [
              Expanded(child: Text(work.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
              const SizedBox(width: 8),
              Text('${work.unitShort} ${chapterLabel(update.latest)}', style: const TextStyle(color: accentSoft, fontWeight: FontWeight.w700, fontSize: 12)),
              const SizedBox(width: 8),
              SizedBox(
                width: 96,
                child: Text(update.date != null ? releaseLabel(update.date!).replaceFirst(RegExp(r'^saiu (em )?'), '') : timeAgo(update.outAt),
                    textAlign: TextAlign.right, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontSize: 11)),
              ),
            ]),
          ),
        ),
      if (older.length > _historyShown)
        TextButton(onPressed: () => setState(() => _historyShown += 40), child: Text('Mostrar mais (${older.length - _historyShown})')),
    ];
  }

  Future<void> _checkUpdates() async {
    try {
      await widget.api.checkUpdates();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('O PC está checando os sites. Leva alguns minutos: puxe a lista para baixo para ver.')),
      );
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// The chapters still to read, looked up for the PC to translate.
  Future<void> _translate(WorkView view) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => BatchScreen(api: widget.api, query: view.work.name)));
    _refresh();
  }

  /// The collection, as on the scans: the lists with their counts, the order, and the covers.
  Widget _collection(List<WorkView> views) {
    bool inFilter(WorkView v, String f) => f == 'all' || (f == 'favorite' ? v.work.favorite : v.shelf == f);
    final listed = views.where((v) => inFilter(v, _filter)).toList();
    final formats = listed.map((v) => v.work.isNovel).toSet();
    final shown = listed.where((v) => _format == 'all' || v.work.isNovel == (_format == 'novel')).toList()..sort(_sorts[_sort]!.$2);
    final filters = {'all': 'Todas', 'favorite': 'Favoritas', ...shelves};
    final title = _filter == 'all' ? 'Todas as obras' : filters[_filter]!;
    return CustomScrollView(slivers: [
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 0),
        sliver: SliverList.list(children: [
          ..._notices(views),
          SizedBox(
            height: 36,
            child: ListView(scrollDirection: Axis.horizontal, children: [
              for (final f in filters.entries)
                if (f.key == 'all' || f.key == 'favorite' || f.key == _filter || views.any((v) => inFilter(v, f.key)))
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: Pill(
                      label: f.value,
                      count: views.where((v) => inFilter(v, f.key)).length,
                      selected: _filter == f.key,
                      onTap: () => setState(() => _filter = f.key),
                    ),
                  ),
            ]),
          ),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
              child: Text.rich(TextSpan(children: [
                TextSpan(text: title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                TextSpan(text: '  ${listed.length}', style: const TextStyle(fontSize: 18, color: muted)),
              ])),
            ),
            PopupMenuButton<String>(
              tooltip: 'Ordem',
              initialValue: _sort,
              onSelected: (s) => setState(() => _sort = s),
              itemBuilder: (_) => [for (final e in _sorts.entries) PopupMenuItem(value: e.key, child: Text(e.value.$1))],
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                decoration: BoxDecoration(color: panel, borderRadius: BorderRadius.circular(99), border: Border.all(color: lineColor)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(_sorts[_sort]!.$1, style: const TextStyle(fontSize: 13)),
                  const Icon(Icons.expand_more, size: 18),
                ]),
              ),
            ),
          ]),
          if (formats.length > 1) ...[
            const SizedBox(height: 6),
            UnderlineTabs(
              tabs: const {'all': 'Tudo', 'comic': 'Mangá', 'novel': 'Novel'},
              selected: _format,
              onSelected: (f) => setState(() => _format = f),
            ),
          ],
          const SizedBox(height: 12),
          if (_library != null && views.isNotEmpty && shown.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('Nenhuma obra nesta lista ainda: escolha a lista na página de cada obra.', textAlign: TextAlign.center),
            ),
        ]),
      ),
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 32),
        sliver: SliverGrid.builder(
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 150,
            mainAxisSpacing: 18,
            crossAxisSpacing: 12,
            childAspectRatio: 0.44,
          ),
          itemCount: shown.length,
          itemBuilder: (_, i) => Poster(view: shown[i], api: widget.api, onOpen: () => _openWork(shown[i])),
        ),
      ),
    ]);
  }

  /// A chapter of the library, read in the app (offline once downloaded).
  Future<void> _read(WorkView view, LibraryChapter chapter) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => ReaderScreen(api: widget.api, chapter: chapter, chapters: view.translated)));
    _refresh();
  }

  Future<void> _openWork(WorkView view) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => WorkScreen(view: view, api: widget.api)));
    _refresh();
  }
}

/// The work read last, big: where it was left and what came out since.
class _Hero extends StatelessWidget {
  const _Hero({required this.view, required this.api, required this.onOpen, required this.onBrowse, required this.onRead});

  final WorkView view;
  final Api api;
  final VoidCallback onOpen;
  final Future<void> Function(String url) onBrowse;
  final void Function(LibraryChapter chapter) onRead;

  @override
  Widget build(BuildContext context) {
    final url = view.continueUrl;
    final inApp = view.nextInLibrary;
    return InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(14),
      child: Ink(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: panel, borderRadius: BorderRadius.circular(14)),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 96, child: CoverImage(url: coverUrlOf(view, api), api: api)),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('CONTINUAR LENDO', style: monoLabel(color: accent)),
              const SizedBox(height: 6),
              Text(view.work.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              Text(statusText(view), style: const TextStyle(color: readGreen, fontSize: 12)),
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 6, children: [
                if (inApp != null)
                  FilledButton.icon(
                    onPressed: () => onRead(inApp),
                    icon: const Icon(Icons.play_arrow, size: 18),
                    label: Text('${view.work.unitShort} ${chapterLabel(inApp.chapter!)}'),
                    style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
                  ),
                if (url != null)
                  (inApp == null
                      ? FilledButton.icon(
                          onPressed: () => onBrowse(url),
                          icon: const Icon(Icons.play_arrow, size: 18),
                          label: const Text('Continuar'),
                          style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
                        )
                      : OutlinedButton(
                          onPressed: () => onBrowse(url),
                          style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
                          child: const Text('No site'),
                        )),
                if (view.update != null)
                  OutlinedButton(
                    onPressed: () => onBrowse(view.update!.url),
                    style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
                    child: Text('${view.work.unitShort} ${chapterLabel(view.update!.latest)}'),
                  ),
              ]),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// A new chapter out, as in MangaDex's latest updates.
class _UpdateRow extends StatelessWidget {
  const _UpdateRow({required this.view, required this.api, required this.onOpen, required this.onBrowse, this.onTranslate});

  final WorkView view;
  final Api api;
  final VoidCallback onOpen;
  final Future<void> Function(String url) onBrowse;

  /// The chapters still to read to the PC's queue; null where that is not offered.
  final VoidCallback? onTranslate;

  @override
  Widget build(BuildContext context) {
    final update = view.update!;
    final upTo = view.readUpTo;
    final behind = upTo == null ? null : (update.latest.floor() - upTo.floor()).clamp(1, 9999);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(10),
        child: Ink(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(color: panel, borderRadius: BorderRadius.circular(10)),
          child: Row(children: [
            SizedBox(width: 40, child: CoverImage(url: coverUrlOf(view, api), api: api, radius: 5)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  if (view.work.favorite) const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.star, size: 15, color: accent)),
                  Expanded(child: Text(view.work.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.bold))),
                ]),
                const SizedBox(height: 2),
                Text('${view.work.unitOne} ${chapterLabel(update.latest)}', style: const TextStyle(fontSize: 13)),
                if (behind != null)
                  Text('${behind == 1 ? '1 capítulo' : '$behind capítulos'} depois do ${chapterLabel(upTo!)}',
                      style: const TextStyle(fontSize: 12, color: muted)),
                Text([update.site.toUpperCase(), if (update.date != null) releaseLabel(update.date!) else if (update.checkedAt > 0) timeAgo(update.checkedAt)].join(' · '),
                    style: monoLabel(size: 10)),
              ]),
            ),
            if (onTranslate != null)
              IconButton(tooltip: 'Traduzir no PC', icon: const Icon(Icons.translate, size: 20), onPressed: onTranslate),
            FilledButton(
              onPressed: () => onBrowse(update.url),
              style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('Ler'),
            ),
          ]),
        ),
      ),
    );
  }
}

int _favoriteFirst(WorkView a, WorkView b) => (b.work.favorite ? 1 : 0) - (a.work.favorite ? 1 : 0);

/// The works with a chapter out past the last one read: favorites first, then the ones checked last.
List<WorkView> freshViews(List<WorkView> views) => views.where((v) => v.update != null).toList()
  ..sort((a, b) => b.update!.outAt.compareTo(a.update!.outAt));

int _newFirst(WorkView a, WorkView b) => (b.update != null ? 1 : 0) - (a.update != null ? 1 : 0);

/// The collection's orders, as on the PC.
final _sorts = <String, (String, int Function(WorkView, WorkView))>{
  'recent': ('Lidas por último', (a, b) => _favoriteFirst(a, b) != 0 ? _favoriteFirst(a, b) : b.lastActivity.compareTo(a.lastActivity)),
  'updated': ('Com capítulo novo', (a, b) => _newFirst(a, b) != 0 ? _newFirst(a, b) : b.lastActivity.compareTo(a.lastActivity)),
  'progress': ('Mais adiantadas', (a, b) => (b.share ?? -1).compareTo(a.share ?? -1)),
  'title': ('A–Z', (a, b) => a.work.name.toLowerCase().compareTo(b.work.name.toLowerCase())),
};

/// A cover as on the scans' collections: a heart on favorites, a bar for how far it was read, the name
/// and "Cap. 45 · 45% lido" under it.
class Poster extends StatelessWidget {
  const Poster({super.key, required this.view, required this.api, required this.onOpen});

  final WorkView view;
  final Api api;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final share = view.share;
    return InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Stack(children: [
          CoverImage(url: coverUrlOf(view, api), api: api, radius: 10, title: view.work.name),
          if (view.update != null) Positioned(top: 6, left: 6, child: Tag('Novo · ${chapterLabel(view.update!.latest)}', color: accent)),
          if (view.work.favorite)
            const Positioned(
              top: 6,
              right: 6,
              child: CircleAvatar(radius: 12, backgroundColor: Colors.black87, child: Icon(Icons.favorite, size: 13, color: accent)),
            ),
        ]),
        if (share != null) ...[const SizedBox(height: 4), ProgressBar(share)],
        const SizedBox(height: 6),
        Text(view.work.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, height: 1.25)),
        const SizedBox(height: 3),
        Text(view.metaLine, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: muted)),
      ]),
    );
  }
}

/// "Lido até o cap. 53 · parou no cap. 54 (40%) · site.com · há 3 dias", as in the PC app.
String statusText(WorkView view) {
  final parts = <String>[];
  final upTo = view.readUpTo;
  final current = view.current;
  if (upTo != null) parts.add('Lido até o cap. ${chapterLabel(upTo)}');
  if (current != null) {
    final where = current.progress != null ? ' (${(current.progress! * 100).round()}%)' : '';
    parts.add('${upTo != null ? 'parou no' : 'Parou no'} cap. ${chapterLabel(current.chapter)}$where');
  }
  if (view.records.isEmpty) return 'Ainda não lido';
  final shown = current ?? (view.records.toList()..sort((a, b) => b.updatedAt.compareTo(a.updatedAt))).first;
  final site = Uri.tryParse(shown.url)?.host.replaceFirst(RegExp(r'^www\.'), '') ?? '';
  if (site.isNotEmpty) parts.add(site);
  parts.add(timeAgo(shown.updatedAt));
  return parts.join(' · ');
}

/// "🆕 Cap. 92 saiu · mgread.io"
String updateText(ChapterUpdate update) => '🆕 Cap. ${chapterLabel(update.latest)} saiu · ${update.site}';

/// "saiu hoje", "saiu há 3 dias", "saiu em 26 de mai. de 2026" (as on the PC).
String releaseLabel(int at) {
  DateTime day(DateTime t) => DateTime(t.year, t.month, t.day);
  final when = DateTime.fromMillisecondsSinceEpoch(at);
  final days = day(DateTime.now()).difference(day(when)).inDays;
  if (days <= 0) return 'saiu hoje';
  if (days == 1) return 'saiu ontem';
  if (days < 7) return 'saiu há $days dias';
  const months = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'];
  return 'saiu em ${when.day} de ${months[when.month - 1]} de ${when.year}';
}

String timeAgo(int at) {
  final minutes = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(at)).inMinutes;
  if (minutes < 1) return 'agora';
  if (minutes < 60) return 'há $minutes min';
  if (minutes < 60 * 24) return 'há ${minutes ~/ 60} h';
  final days = minutes ~/ (60 * 24);
  if (days < 30) return days == 1 ? 'ontem' : 'há $days dias';
  if (days < 365) return days < 60 ? 'há 1 mês' : 'há ${days ~/ 30} meses';
  return days < 730 ? 'há 1 ano' : 'há ${days ~/ 365} anos';
}
