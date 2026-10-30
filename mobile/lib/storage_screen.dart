import 'package:flutter/material.dart';

import 'api.dart';
import 'downloads.dart';
import 'local_data.dart';
import 'site_download.dart';
import 'theme.dart';

/// "1,4 GB", "820 MB", "12 KB".
String formatBytes(num bytes) {
  if (bytes < 1024) return '$bytes B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  var value = bytes / 1024;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return '${value.toStringAsFixed(value < 10 ? 1 : 0).replaceAll('.', ',')} ${units[unit]}';
}

/// What the chapters take on this phone (kept to read without internet, or cached while reading) and on
/// the PC, each work's on its own, to clear.
class StorageScreen extends StatefulWidget {
  const StorageScreen({super.key, required this.api});

  final Api api;

  @override
  State<StorageScreen> createState() => _StorageScreenState();
}

/// One work's chapters kept on the phone.
class _PhoneWork {
  _PhoneWork(this.name);
  final String name;
  final List<String> ids = [];

  /// The phone's own downloads (from the sites), removed with their record too.
  final Set<String> fromSites = {};
  int bytes = 0;
}

class _StorageScreenState extends State<StorageScreen> {
  List<_PhoneWork>? _phone;
  int _cache = 0;
  Map<String, dynamic>? _pc;
  String? _pcError;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final kept = await Downloads.sizes(kept: true);
    final cached = await Downloads.sizes(kept: false);
    final library = await LocalData.library();
    final names = {for (final w in library.works) w.id: w.name};
    final works = <String, _PhoneWork>{};
    void add(String key, String name, String id, {bool site = false}) {
      final work = works.putIfAbsent(key, () => _PhoneWork(name));
      work.ids.add(id);
      if (site) work.fromSites.add(id);
      work.bytes += kept[id] ?? 0;
    }

    final known = <String>{};
    for (final c in library.chapters) {
      if (!kept.containsKey(c.id)) continue;
      add(c.workId, names[c.workId] ?? c.title, c.id);
      known.add(c.id);
    }
    for (final c in await PhoneChapter.all()) {
      if (known.contains(c.id)) continue;
      add(c.workId ?? 'site:${c.work.toLowerCase()}', c.workId != null ? names[c.workId] ?? c.work : c.work, c.id, site: true);
      known.add(c.id);
    }
    for (final id in kept.keys.where((id) => !known.contains(id))) {
      add('', 'Outros', id);
    }
    if (mounted) {
      setState(() => (_phone = works.values.toList()..sort((a, b) => b.bytes.compareTo(a.bytes)), _cache = cached.values.fold(0, (a, b) => a + b)));
    }
    if (!widget.api.paired) return;
    try {
      final pc = await widget.api.pcStorage();
      if (mounted) setState(() => (_pc = pc, _pcError = null));
    } on ApiException catch (e) {
      if (mounted) setState(() => _pcError = e.message);
    }
  }

  Future<bool> _sure(String title, String text) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(text),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Apagar')),
          ],
        ),
      ) ==
      true;

  Future<void> _do(Future<void> Function() task) async {
    setState(() => _busy = true);
    try {
      await task();
    } on ApiException catch (e) {
      if (mounted) setState(() => _pcError = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _load();
  }

  Future<void> _removePhoneWork(_PhoneWork w) async {
    if (!await _sure('Apagar do celular?', 'Os ${w.ids.length} capítulos de ${w.name} baixados neste celular. Os do PC ficam.')) return;
    await _do(() async {
      for (final id in w.ids) {
        w.fromSites.contains(id) ? await PhoneChapter.remove(id) : await Downloads.remove(id);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final phone = _phone;
    final phoneTotal = (phone ?? []).fold<int>(0, (a, w) => a + w.bytes) + _cache;
    final heading = Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800);
    return Scaffold(
      appBar: AppBar(title: const Text('Armazenamento')),
      body: phone == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
                Text('Neste celular', style: heading),
                Text(formatBytes(phoneTotal), style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
                const SizedBox(height: 8),
                _Row(
                  title: 'Cache de leitura',
                  subtitle: 'Capítulos abertos sem baixar; o PC manda de novo quando abrir.',
                  bytes: _cache,
                  action: _cache == 0 || _busy ? null : () => _do(Downloads.clearCache),
                  actionLabel: 'Limpar',
                ),
                if (phone.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('Nenhum capítulo baixado.', style: TextStyle(color: muted))),
                for (final w in phone)
                  _Row(
                    title: w.name,
                    subtitle: '${w.ids.length} ${w.ids.length == 1 ? 'capítulo baixado' : 'capítulos baixados'}',
                    bytes: w.bytes,
                    action: _busy ? null : () => _removePhoneWork(w),
                    actionLabel: 'Apagar',
                  ),
                if (widget.api.paired) ...[
                  const SizedBox(height: 24),
                  Text('No PC', style: heading),
                  if (_pcError != null) Text(_pcError!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  if (_pc == null && _pcError == null) const Padding(padding: EdgeInsets.all(12), child: LinearProgressIndicator()),
                  if (_pc != null) ..._pcRows(_pc!),
                ],
              ]),
            ),
    );
  }

  List<Widget> _pcRows(Map<String, dynamic> pc) {
    final areas = pc['areas'] as Map<String, dynamic>;
    int bytesOf(String key) => ((areas[key] as Map<String, dynamic>)['bytes'] as num).toInt();
    final works = (pc['works'] as List).cast<Map<String, dynamic>>();
    final free = pc['free'] as num?;
    return [
      Text(formatBytes(pc['total'] as num), style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
      if (free != null) Text('${formatBytes(free)} livres no disco do PC', style: const TextStyle(color: muted)),
      const SizedBox(height: 8),
      _Row(
        title: 'Camadas de tradução',
        subtitle: 'Só o que a tradução mudou em cada página: traduzir de novo um capítulo apagado leva segundos.',
        bytes: bytesOf('layers'),
        action: bytesOf('layers') == 0 || _busy
            ? null
            : () async {
                if (await _sure('Limpar as camadas?', 'Traduzir de novo um capítulo apagado volta a passar por todas as etapas.')) {
                  await _do(() => widget.api.clearPcStorage('layers'));
                }
              },
        actionLabel: 'Limpar',
      ),
      _Row(
        title: 'Respostas da IA',
        subtitle: 'Para não pagar duas vezes pela mesma página.',
        bytes: bytesOf('aiCache'),
        action: bytesOf('aiCache') == 0 || _busy
            ? null
            : () async {
                if (await _sure('Limpar as respostas da IA?', 'As páginas traduzidas de novo voltam a ser pedidas à IA.')) {
                  await _do(() => widget.api.clearPcStorage('aiCache'));
                }
              },
        actionLabel: 'Limpar',
      ),
      _Row(
        title: 'Cache do app no PC',
        subtitle: 'Refeito sozinho.',
        bytes: bytesOf('appCache'),
        action: bytesOf('appCache') == 0 || _busy ? null : () => _do(() => widget.api.clearPcStorage('appCache')),
        actionLabel: 'Limpar',
      ),
      _Row(title: 'Modelos de IA locais', subtitle: 'Removidos no PC, em "IAs e GPU".', bytes: bytesOf('models')),
      const SizedBox(height: 8),
      const Text('Apagar os capítulos de uma obra no PC mantém as leituras e as camadas: traduzir de novo é rápido.',
          style: TextStyle(color: muted, fontSize: 12)),
      for (final w in works)
        _Row(
          title: w['name'] as String,
          subtitle: '${w['chapters']} capítulos · traduzidos ${formatBytes(w['translated'] as num)} · originais ${formatBytes(w['original'] as num)}',
          bytes: (w['translated'] as num) + (w['original'] as num) + (w['other'] as num),
          action: _busy
              ? null
              : () async {
                  if (await _sure('Apagar do PC?', 'Os ${w['chapters']} capítulos de ${w['name']} no PC. As leituras e as camadas de tradução ficam.')) {
                    await _do(() => widget.api.deletePcWork(w['workId'] as String));
                  }
                },
          actionLabel: 'Apagar',
        ),
    ];
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.title, required this.subtitle, required this.bytes, this.action, this.actionLabel});

  final String title;
  final String subtitle;
  final num bytes;
  final VoidCallback? action;
  final String? actionLabel;

  @override
  Widget build(BuildContext context) => ListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(subtitle, style: const TextStyle(color: muted, fontSize: 12)),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(formatBytes(bytes), style: const TextStyle(fontWeight: FontWeight.w700)),
          if (actionLabel != null) ...[const SizedBox(width: 8), TextButton(onPressed: action, child: Text(actionLabel!))],
        ]),
      );
}
