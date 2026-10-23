import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'api.dart';
import 'browser_screen.dart';
import 'models.dart';
import 'theme.dart';
import 'translate_screen.dart';
import 'work_screen.dart';

/// Every work read or translated, where it was left, the most recent first. Shows the last library
/// seen when the PC cannot be reached.
class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key, required this.api, required this.onUnpaired});

  final Api api;
  final VoidCallback onUnpaired;

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  Library? _library;
  String? _error;
  bool _loading = false;
  String _query = '';

  @override
  void initState() {
    super.initState();
    Store.loadLibrary().then((cached) {
      if (mounted && _library == null && cached != null) setState(() => _library = cached);
    });
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    try {
      final library = await widget.api.library();
      if (mounted) setState(() => (_library = library, _error = null));
    } on UnpairedException {
      await Store.forgetConnection();
      widget.onUnpaired();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
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
        content: const Text('O celular para de sincronizar com o PC até ser pareado de novo.'),
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
  Widget build(BuildContext context) {
    final views = (_library?.views ?? []).where((v) => v.matches(_query)).toList();
    final fresh = views.where((v) => v.update != null).toList();
    final current = ([...views]..sort((a, b) => b.lastActivity.compareTo(a.lastActivity))).where((v) => v.continueUrl != null).firstOrNull;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Manga Index'),
        actions: [
          if (_library?.ntfyTopic != null)
            IconButton(
              tooltip: 'Receber avisos de capítulo novo (app ntfy)',
              icon: const Icon(Icons.notifications_active_outlined),
              onPressed: () => _subscribe(_library!.ntfyTopic!),
            ),
          IconButton(
            tooltip: 'Ler nos sites',
            icon: const Icon(Icons.public),
            onPressed: () => _browse(null),
          ),
          PopupMenuButton<String>(
            onSelected: (_) => _unpair(),
            itemBuilder: (_) => [const PopupMenuItem(value: 'unpair', child: Text('Desparear do PC'))],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          await Navigator.push(context, MaterialPageRoute(builder: (_) => TranslateScreen(api: widget.api)));
          _refresh();
        },
        icon: const Icon(Icons.translate),
        label: const Text('Traduzir no PC'),
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: CustomScrollView(
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 0),
              sliver: SliverList.list(children: [
                TextField(
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Buscar obra por qualquer nome…'),
                  onChanged: (q) => setState(() => _query = q),
                ),
                if (_loading && _library == null) const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text(
                      _library == null ? _error! : '$_error\nMostrando a última biblioteca sincronizada.',
                      style: TextStyle(color: Theme.of(context).colorScheme.error),
                    ),
                  ),
                if (_library != null && views.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(40),
                    child: Text('Nada por aqui ainda. O que você ler e traduzir aparece nesta lista.', textAlign: TextAlign.center),
                  ),
                if (_query.isEmpty && current != null) ...[
                  const SizedBox(height: 16),
                  _Hero(view: current, api: widget.api, onOpen: () => _openWork(current), onBrowse: _browse),
                ],
                if (_query.isEmpty && fresh.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  Text('Capítulos novos', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  for (final view in fresh) _UpdateRow(view: view, api: widget.api, onOpen: () => _openWork(view), onBrowse: _browse),
                ],
                if (views.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  Row(children: [
                    Text('Biblioteca', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                    const SizedBox(width: 10),
                    Text('${views.length} OBRAS', style: monoLabel()),
                  ]),
                  const SizedBox(height: 10),
                ],
              ]),
            ),
            SliverPadding(
              // Room under the last row for the button.
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 96),
              sliver: SliverGrid.builder(
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 140,
                  mainAxisSpacing: 16,
                  crossAxisSpacing: 12,
                  childAspectRatio: 0.48,
                ),
                itemCount: views.length,
                itemBuilder: (_, i) => _Poster(view: views[i], api: widget.api, onOpen: () => _openWork(views[i])),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _openWork(WorkView view) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => WorkScreen(view: view, api: widget.api)));
    _refresh();
  }
}

/// The work read last, big: where it was left and what came out since.
class _Hero extends StatelessWidget {
  const _Hero({required this.view, required this.api, required this.onOpen, required this.onBrowse});

  final WorkView view;
  final Api api;
  final VoidCallback onOpen;
  final Future<void> Function(String url) onBrowse;

  @override
  Widget build(BuildContext context) {
    final url = view.continueUrl;
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
                if (url != null)
                  FilledButton.icon(
                    onPressed: () => onBrowse(url),
                    icon: const Icon(Icons.play_arrow, size: 18),
                    label: const Text('Continuar'),
                    style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
                  ),
                if (view.update != null)
                  OutlinedButton(
                    onPressed: () => onBrowse(view.update!.url),
                    style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
                    child: Text('Cap. ${chapterLabel(view.update!.latest)}'),
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
  const _UpdateRow({required this.view, required this.api, required this.onOpen, required this.onBrowse});

  final WorkView view;
  final Api api;
  final VoidCallback onOpen;
  final Future<void> Function(String url) onBrowse;

  @override
  Widget build(BuildContext context) {
    final update = view.update!;
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
                Text(view.work.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.bold)),
                const SizedBox(height: 2),
                Text('Capítulo ${chapterLabel(update.latest)}', style: const TextStyle(fontSize: 13)),
                Text(update.site.toUpperCase(), style: monoLabel(size: 10)),
              ]),
            ),
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

/// A cover in the grid (comix): title under it, and how far it was read.
class _Poster extends StatelessWidget {
  const _Poster({required this.view, required this.api, required this.onOpen});

  final WorkView view;
  final Api api;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final upTo = view.readUpTo;
    final meta = [
      upTo != null ? 'CAP. ${chapterLabel(upTo)}' : (view.records.isEmpty ? 'NÃO LIDO' : 'LENDO'),
      if (view.work.isNovel) 'NOVEL',
    ].join(' · ');
    return InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Stack(children: [
          CoverImage(url: coverUrlOf(view, api), api: api),
          if (view.update != null) Positioned(top: 6, left: 6, child: Tag('NOVO · ${chapterLabel(view.update!.latest)}', color: accent)),
        ]),
        const SizedBox(height: 6),
        Text(view.work.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, height: 1.25)),
        const SizedBox(height: 3),
        Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: monoLabel(size: 10)),
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
