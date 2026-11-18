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

  /// The works opened (or, with a single work, closed) to show their chapters.
  final Set<String> _toggled = {};

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

  /// The queue in this order of works (and of chapters in them): shown at once, the PC's answer comes with the next refresh.
  void _save(List<RemoteJob> jobs, List<_Group> groups) {
    final ids = [for (final g in groups) for (final j in g.jobs) j.id];
    final waiting = [for (final g in groups) ...g.jobs];
    setState(() => _jobs = [...jobs.where((j) => j.status != 'queued'), ...waiting]);
    _do(() => widget.api.reorderQueue(ids));
  }

  Future<void> _removeGroup(_Group g) async {
    if (g.jobs.length > 1) {
      final sure = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text('Tirar ${g.work} da fila?'),
          content: Text('Os ${g.jobs.length} capítulos dela saem da fila.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Tirar')),
          ],
        ),
      );
      if (sure != true) return;
    }
    await _do(() async {
      for (final j in g.jobs) {
        await widget.api.cancelJob(j.id);
      }
    });
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
    final groups = _byWork(waiting);
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
                      _RunningCard(
                        job: j,
                        paused: _paused,
                        onPause: () => _do(() => widget.api.pauseQueue(!_paused)),
                        onRemove: () => _do(() => widget.api.cancelJob(j.id)),
                      ),
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
                    if (waiting.isNotEmpty)
                      const Text('Juntos por obra: arraste a obra para mover todos os capítulos dela; toque para abrir e mudar a ordem deles.',
                          style: TextStyle(color: muted, fontSize: 12)),
                    if (waiting.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('Nada esperando na fila.', style: TextStyle(color: muted))),
                  ]),
                ),
              ),
              SliverReorderableList(
                itemCount: groups.length,
                onReorderItem: (from, to) {
                  final next = [...groups];
                  next.insert(to, next.removeAt(from));
                  _save(jobs, next);
                },
                itemBuilder: (context, i) {
                  final g = groups[i];
                  final open = g.work != null && (groups.length == 1) != _toggled.contains(g.key);
                  return Material(
                    key: ValueKey(g.key),
                    color: Colors.transparent,
                    child: Column(children: [
                      ReorderableDelayedDragStartListener(
                        index: i,
                        child: ListTile(
                          onTap: g.work == null ? null : () => setState(() => _toggled.contains(g.key) ? _toggled.remove(g.key) : _toggled.add(g.key)),
                          leading: SizedBox(width: 28, child: Text('${i + 1}', textAlign: TextAlign.end, style: const TextStyle(color: muted))),
                          title: Text(g.work ?? g.jobs.first.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                          subtitle: Text(
                            [
                              if (g.work != null) g.range,
                              if (g.jobs.length > 1) '${g.jobs.length} capítulos',
                              ...{for (final j in g.jobs) j.downloadOnly ? 'baixar' : 'traduzir'},
                              if (g.jobs.any((j) => j.options?['visionDevice'] == 'cpu')) 'visão na CPU',
                            ].join(' · '),
                            style: const TextStyle(color: muted, fontSize: 12),
                          ),
                          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                            IconButton(
                              tooltip: 'Para o começo da fila',
                              icon: const Icon(Icons.vertical_align_top),
                              onPressed: i == 0 ? null : () => _save(jobs, [g, ...groups.where((o) => o != g)]),
                            ),
                            IconButton(
                              tooltip: g.jobs.length > 1 ? 'Tirar a obra da fila' : 'Tirar da fila',
                              icon: const Icon(Icons.close),
                              onPressed: () => _removeGroup(g),
                            ),
                            if (g.work != null) Icon(open ? Icons.expand_less : Icons.expand_more, color: muted),
                            ReorderableDragStartListener(index: i, child: const Icon(Icons.drag_handle, color: muted)),
                          ]),
                        ),
                      ),
                      if (open)
                        ReorderableListView.builder(
                          shrinkWrap: true,
                          physics: const NeverScrollableScrollPhysics(),
                          buildDefaultDragHandles: false,
                          itemCount: g.jobs.length,
                          onReorderItem: (from, to) {
                            final chapters = [...g.jobs];
                            chapters.insert(to, chapters.removeAt(from));
                            _save(jobs, [for (final o in groups) o == g ? o.withJobs(chapters) : o]);
                          },
                          itemBuilder: (context, k) {
                            final j = g.jobs[k];
                            return Material(
                              key: ValueKey(j.id),
                              color: background,
                              child: ListTile(
                                dense: true,
                                contentPadding: const EdgeInsets.only(left: 60, right: 16),
                                title: Text(j.number ?? j.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                                  IconButton(
                                    tooltip: 'Primeiro da obra',
                                    icon: const Icon(Icons.vertical_align_top, size: 20),
                                    onPressed: k == 0 ? null : () => _save(jobs, [for (final o in groups) o == g ? o.withJobs([j, ...g.jobs.where((x) => x != j)]) : o]),
                                  ),
                                  IconButton(tooltip: 'Tirar da fila', icon: const Icon(Icons.close, size: 20), onPressed: () => _do(() => widget.api.cancelJob(j.id))),
                                  ReorderableDragStartListener(index: k, child: const Icon(Icons.drag_handle, color: muted, size: 20)),
                                ]),
                              ),
                            );
                          },
                        ),
                    ]),
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

/// A work's chapters waiting (`work` null: a link or PDF sent on its own), as in the PC's queue window.
class _Group {
  _Group(this.key, this.work, this.jobs);

  final String key;
  final String? work;
  final List<RemoteJob> jobs;

  _Group withJobs(List<RemoteJob> jobs) => _Group(key, work, jobs);

  /// "Cap. 31–40", or "Cap. 36" for one; "Vol. 8–17" for a novel's volumes.
  String get range {
    final numbers = [for (final j in jobs) ?j.chapter];
    if (numbers.isEmpty) return '';
    final low = numbers.reduce((a, b) => a < b ? a : b);
    final high = numbers.reduce((a, b) => a > b ? a : b);
    final prefix = jobs.every((j) => j.isVolume) ? 'Vol.' : 'Cap.';
    return low == high ? '$prefix ${chapterLabel(low)}' : '$prefix ${chapterLabel(low)}–${chapterLabel(high)}';
  }
}

/// The queue by work, each where its first chapter is: moving a work moves all its chapters, and saving
/// that order puts them together.
List<_Group> _byWork(List<RemoteJob> jobs) {
  final groups = <_Group>[];
  final byWork = <String, _Group>{};
  for (final j in jobs) {
    if (j.work == null) {
      groups.add(_Group(j.id, null, [j]));
      continue;
    }
    final key = 'work:${j.work!.toLowerCase()}';
    byWork.putIfAbsent(key, () {
      final g = _Group(key, j.work, []);
      groups.add(g);
      return g;
    }).jobs.add(j);
  }
  return groups;
}

/// The chapter on now, as a download manager shows one: what it is doing, how far, and a bar.
class _RunningCard extends StatelessWidget {
  const _RunningCard({required this.job, required this.paused, required this.onPause, required this.onRemove});

  final RemoteJob job;
  final bool paused;
  final VoidCallback onPause;

  /// Stops this chapter and takes it off the queue: the PC goes on to the next.
  final VoidCallback onRemove;

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
        Wrap(spacing: 8, runSpacing: 8, children: [
          OutlinedButton.icon(
            onPressed: onPause,
            style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
            icon: Icon(paused ? Icons.play_arrow : Icons.pause, size: 18),
            label: Text(paused ? 'Continuar' : 'Pausar'),
          ),
          OutlinedButton.icon(
            onPressed: onRemove,
            style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact, foregroundColor: muted),
            icon: const Icon(Icons.close, size: 18),
            label: const Text('Tirar da fila'),
          ),
        ]),
      ]),
    );
  }
}
