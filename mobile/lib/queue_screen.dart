import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'models.dart';
import 'theme.dart';
import 'translate_options.dart';

/// The PC's queue as it will run, as in its queue window: the chapter on now, the ones waiting (dragged
/// into another order, or taken off), and the ones that failed, to try again.
class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key, required this.api});

  final Api api;

  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  List<RemoteJob>? _jobs;
  bool _paused = false;
  String? _error;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _refresh();
    // The PC moves along on its own; this follows it while the screen is open.
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final q = await widget.api.queue();
      if (mounted) setState(() => (_jobs = q.jobs, _paused = q.paused, _error = null));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _do(Future<void> Function() request) async {
    try {
      await request();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final jobs = _jobs ?? [];
    final running = jobs.where((j) => j.status == 'running').toList();
    final waiting = jobs.where((j) => j.status == 'queued').toList();
    final failed = jobs.where((j) => j.status == 'failed' && j.isLink && DateTime.now().millisecondsSinceEpoch - j.updatedAt < 86400000).toList();
    return Scaffold(
      appBar: AppBar(title: const Text('Fila do PC'), actions: [
        IconButton(
          tooltip: _paused ? 'Continuar' : 'Pausar',
          icon: Icon(_paused ? Icons.play_arrow : Icons.pause),
          onPressed: () => _do(() => widget.api.pauseQueue(!_paused)),
        ),
      ]),
      body: _jobs == null && _error == null
          ? const Center(child: CircularProgressIndicator())
          : CustomScrollView(slivers: [
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                    if (_paused) const Text('Pausada: nada novo começa até continuar.', style: TextStyle(color: accentSoft)),
                    if (waiting.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      TranslateOptionsCard(
                        // Made again when the queue's options change, to show them.
                        key: ValueKey(waiting.first.options.toString()),
                        api: widget.api,
                        title: 'Opções da fila (${waiting.length})',
                        initial: waiting.first.options,
                        onChanged: (_) {},
                        apply: (options) async {
                          await widget.api.setQueueOptions(options);
                          await _refresh();
                        },
                      ),
                      const SizedBox(height: 8),
                    ],
                    for (final j in running) ...[
                      _RunningCard(job: j, paused: _paused, onPause: () => _do(() => widget.api.pauseQueue(!_paused))),
                      const SizedBox(height: 12),
                    ],
                    Row(children: [
                      Text('Esperando  ${waiting.length}', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                      const Spacer(),
                      TextButton.icon(
                        onPressed: waiting.length > 1 ? () => _do(widget.api.sortQueue) : null,
                        icon: const Icon(Icons.sort, size: 18),
                        label: const Text('Ordenar por capítulo'),
                      ),
                    ]),
                    if (waiting.isNotEmpty) const Text('Segure e arraste para mudar a ordem.', style: TextStyle(color: muted, fontSize: 12)),
                    if (waiting.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('Nada esperando na fila.', style: TextStyle(color: muted))),
                  ]),
                ),
              ),
              SliverReorderableList(
                itemCount: waiting.length,
                onReorderItem: (from, to) {
                  final ids = waiting.map((j) => j.id).toList();
                  ids.insert(to, ids.removeAt(from));
                  // Shown at once; the PC's answer comes with the next refresh.
                  setState(() => _jobs = [...jobs.where((j) => j.status != 'queued'), for (final id in ids) waiting.firstWhere((j) => j.id == id)]);
                  _do(() => widget.api.reorderQueue(ids));
                },
                itemBuilder: (context, i) {
                  final j = waiting[i];
                  return ReorderableDelayedDragStartListener(
                    key: ValueKey(j.id),
                    index: i,
                    child: Material(
                      color: Colors.transparent,
                      child: ListTile(
                        leading: SizedBox(width: 28, child: Text('${i + 1}', textAlign: TextAlign.end, style: const TextStyle(color: muted))),
                        title: Text(j.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(
                          [j.downloadOnly ? 'baixar' : 'traduzir', if (j.options?['visionDevice'] == 'cpu') 'visão na CPU'].join(' · '),
                          style: const TextStyle(color: muted, fontSize: 12),
                        ),
                        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                          IconButton(
                            tooltip: 'Para o começo da fila',
                            icon: const Icon(Icons.vertical_align_top),
                            onPressed: i == 0 ? null : () => _do(() => widget.api.reorderQueue([j.id])),
                          ),
                          IconButton(tooltip: 'Tirar da fila', icon: const Icon(Icons.close), onPressed: () => _do(() => widget.api.cancelJob(j.id))),
                          ReorderableDragStartListener(index: i, child: const Icon(Icons.drag_handle, color: muted)),
                        ]),
                      ),
                    ),
                  );
                },
              ),
              if (failed.isNotEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Text('Falharam  ${failed.length}', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                        const Spacer(),
                        FilledButton.tonal(onPressed: () => _do(() => widget.api.retryQueue(failed.map((j) => j.id).toList())), child: const Text('Tentar todos')),
                      ]),
                      for (final j in failed)
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: Icon(Icons.error, color: Theme.of(context).colorScheme.error),
                          title: Text(j.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text(j.message ?? 'Falhou', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
                          trailing: IconButton(tooltip: 'Tentar de novo', icon: const Icon(Icons.refresh), onPressed: () => _do(() => widget.api.retryQueue([j.id]))),
                        ),
                    ]),
                  ),
                ),
            ]),
    );
  }
}

/// The chapter on now, as a download manager shows one: what it is doing, how far, and a bar.
class _RunningCard extends StatelessWidget {
  const _RunningCard({required this.job, required this.paused, required this.onPause});

  final RemoteJob job;
  final bool paused;
  final VoidCallback onPause;

  @override
  Widget build(BuildContext context) {
    final share = job.done != null && job.total != null && job.total! > 0 ? job.done! / job.total! : null;
    final site = job.url != null ? Uri.tryParse(job.url!)?.host.replaceFirst(RegExp(r'^www\.'), '') : null;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: panel, borderRadius: BorderRadius.circular(14), border: Border.all(color: accent)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(99)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(width: 6, height: 6, decoration: const BoxDecoration(color: accent, shape: BoxShape.circle)),
                  const SizedBox(width: 5),
                  Text('${job.message ?? 'Começando'}…', style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600)),
                ]),
              ),
              const SizedBox(height: 6),
              Text(job.label, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
              const SizedBox(height: 2),
              Text(
                [if (site != null && site.isNotEmpty) site, job.downloadOnly ? 'baixar' : 'traduzir', if (job.options?['visionDevice'] == 'cpu') 'visão na CPU'].join(' · '),
                style: const TextStyle(color: muted, fontSize: 12),
              ),
            ]),
          ),
          const SizedBox(width: 10),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(share != null ? '${job.done}/${job.total} pág.' : '—', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
            Text(share != null ? '${(share * 100).round()}%' : 'abrindo', style: const TextStyle(color: muted, fontSize: 12)),
          ]),
        ]),
        const SizedBox(height: 12),
        ClipRRect(
          borderRadius: BorderRadius.circular(99),
          child: LinearProgressIndicator(value: share ?? 0, minHeight: 6, color: accent, backgroundColor: Colors.white.withValues(alpha: 0.08)),
        ),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          onPressed: onPause,
          style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
          icon: Icon(paused ? Icons.play_arrow : Icons.pause, size: 18),
          label: Text(paused ? 'Continuar' : 'Pausar'),
        ),
      ]),
    );
  }
}
