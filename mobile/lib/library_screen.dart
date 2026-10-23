import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'models.dart';
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
    return Scaffold(
      appBar: AppBar(
        title: const Text('Manga Index'),
        actions: [
          PopupMenuButton<String>(
            onSelected: (_) => _unpair(),
            itemBuilder: (_) => [const PopupMenuItem(value: 'unpair', child: Text('Desparear do PC'))],
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
          children: [
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
            for (final view in views) _WorkTile(view: view, api: widget.api, onChanged: _refresh),
          ],
        ),
      ),
    );
  }
}

class _WorkTile extends StatelessWidget {
  const _WorkTile({required this.view, required this.api, required this.onChanged});

  final WorkView view;
  final Api api;
  final Future<void> Function() onChanged;

  @override
  Widget build(BuildContext context) {
    final cover = view.translated.where((c) => c.hasCover).firstOrNull;
    final url = view.continueUrl;
    return Card(
      margin: const EdgeInsets.only(top: 10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () async {
          await Navigator.push(context, MaterialPageRoute(builder: (_) => WorkScreen(view: view, api: api)));
          onChanged();
        },
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: SizedBox(
                  width: 52,
                  height: 72,
                  child: cover != null
                      ? Image.network('${api.base}/api/cover/${cover.id}', headers: api.authHeaders, fit: BoxFit.cover,
                          errorBuilder: (_, _, _) => const _NoCover())
                      : const _NoCover(),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text.rich(
                      TextSpan(children: [
                        TextSpan(text: view.work.name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                        if (view.work.isNovel) const TextSpan(text: '  novel', style: TextStyle(fontSize: 12, color: Colors.grey)),
                      ]),
                    ),
                    const SizedBox(height: 4),
                    Text(statusText(view), style: const TextStyle(color: Color(0xFF4CCF8A), fontSize: 13)),
                    if (view.translated.isNotEmpty)
                      Text('${view.translated.length} traduzidos no PC', style: const TextStyle(color: Colors.grey, fontSize: 12)),
                  ],
                ),
              ),
              if (url != null)
                IconButton(
                  tooltip: 'Continuar',
                  icon: const Icon(Icons.play_circle_fill, color: Color(0xFFFF5D73), size: 32),
                  onPressed: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NoCover extends StatelessWidget {
  const _NoCover();

  @override
  Widget build(BuildContext context) =>
      ColoredBox(color: Theme.of(context).colorScheme.surfaceContainerHighest, child: const Center(child: Text('📚')));
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
