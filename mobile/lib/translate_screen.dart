import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'models.dart';
import 'queue_screen.dart';
import 'reader_screen.dart';
import 'translate_options.dart';

/// Asks the PC to translate a chapter, from a site's link or a PDF on the phone, and follows the
/// requests until they are in the library. Opened from the library or by sharing a link or PDF.
class TranslateScreen extends StatefulWidget {
  const TranslateScreen({super.key, required this.api, this.sharedLink, this.sharedFile});

  final Api api;

  /// A link shared from another app (the browser's Share), sent at once.
  final String? sharedLink;

  /// A PDF shared from another app.
  final File? sharedFile;

  @override
  State<TranslateScreen> createState() => _TranslateScreenState();
}

class _TranslateScreenState extends State<TranslateScreen> {
  final _link = TextEditingController();
  List<RemoteJob>? _jobs;
  String? _error;
  bool _sending = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _refresh();
    // The PC moves the requests along on its own; this follows them while the screen is open.
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _refresh());
    final link = widget.sharedLink;
    final file = widget.sharedFile;
    if (link != null) {
      _link.text = link;
      WidgetsBinding.instance.addPostFrameCallback((_) => _sendLink());
    } else if (file != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _sendFile(file.uri.pathSegments.last, file.openRead(), file.lengthSync()));
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final jobs = await widget.api.jobs();
      if (mounted) setState(() => (_jobs = jobs, _error = null));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _send(Future<void> Function() request) async {
    setState(() => (_sending = true, _error = null));
    try {
      await request();
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _sendLink() async {
    final link = _extractLink(_link.text);
    if (link == null) {
      setState(() => _error = 'Cole o link da página de leitura do capítulo.');
      return;
    }
    await _send(() => widget.api.translateLink(link, options: _options));
    if (_error == null) _link.clear();
  }

  /// Options chosen for the requests sent from here (null: the PC's settings).
  Map<String, dynamic>? _options;

  Future<void> _sendFile(String name, Stream<List<int>> bytes, int? length) =>
      _send(() => widget.api.translatePdf(name, bytes, length, options: _options));

  Future<void> _pickPdf() async {
    final picked = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: ['pdf']);
    if (picked.isEmpty) return;
    final file = picked.first;
    await _sendFile(file.name, file.readAsByteStream(), file.lengthSync());
  }

  Future<void> _open(RemoteJob job) async {
    try {
      final library = await widget.api.library();
      final chapter = library.chapters.where((c) => c.id == job.entryId).firstOrNull;
      if (chapter == null || !mounted) return;
      await Navigator.push(context, MaterialPageRoute(builder: (_) => ReaderScreen(api: widget.api, chapter: chapter)));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final jobs = _jobs;
    return Scaffold(
      appBar: AppBar(title: const Text('Traduzir no PC')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text('O PC traduz e o capítulo entra na biblioteca. Ele precisa estar ligado, com o Manga Index aberto.'),
            const SizedBox(height: 12),
            TranslateOptionsCard(api: widget.api, onChanged: (o) => _options = o),
            const SizedBox(height: 16),
            TextField(
              controller: _link,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(labelText: 'Link do capítulo', hintText: 'https://…/chapter-54/'),
              onSubmitted: (_) => _sendLink(),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(child: FilledButton(onPressed: _sending ? null : _sendLink, child: const Text('Traduzir o link'))),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: _sending ? null : _pickPdf,
                    icon: const Icon(Icons.picture_as_pdf),
                    label: const Text('Enviar PDF'),
                  ),
                ),
              ],
            ),
            if (_sending) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ),
            const SizedBox(height: 24),
            Row(children: [
              Text('Pedidos', style: Theme.of(context).textTheme.titleMedium),
              const Spacer(),
              TextButton.icon(
                onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => QueueScreen(api: widget.api))).then((_) => _refresh()),
                icon: const Icon(Icons.low_priority, size: 18),
                label: const Text('Fila do PC'),
              ),
            ]),
            if (jobs == null && _error == null) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
            if (jobs != null && jobs.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: Text('Nenhum pedido ainda.')),
            for (final job in jobs ?? <RemoteJob>[])
              _JobTile(
                job: job,
                onOpen: () => _open(job),
                onCancel: () => _send(() => widget.api.cancelJob(job.id)),
                onRetry: () => _send(() => widget.api.retryJob(job.id)),
              ),
          ],
        ),
      ),
    );
  }
}

class _JobTile extends StatelessWidget {
  const _JobTile({required this.job, required this.onOpen, required this.onCancel, required this.onRetry});

  final RemoteJob job;
  final VoidCallback onOpen;
  final VoidCallback onCancel;

  /// A link that failed goes back to the queue (a PDF sent is gone from the PC by then).
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final (icon, color, text) = switch (job.status) {
      'queued' => (Icons.schedule, Colors.grey, 'Na fila'),
      'running' => (Icons.autorenew, const Color(0xFFFF8A5C), job.message ?? 'Traduzindo'),
      'done' => (Icons.check_circle, const Color(0xFF4CCF8A), 'Pronto: toque para ler'),
      _ => (Icons.error, Theme.of(context).colorScheme.error, 'Falhou: ${job.message ?? 'erro'}'),
    };
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: color),
      title: Text(job.label, maxLines: 2, overflow: TextOverflow.ellipsis),
      subtitle: Text(text, style: TextStyle(color: color)),
      onTap: job.status == 'done' && job.entryId != null ? onOpen : null,
      trailing: job.status == 'queued'
          ? IconButton(tooltip: 'Tirar da fila', icon: const Icon(Icons.close), onPressed: onCancel)
          : job.status == 'failed' && job.isLink
              ? IconButton(tooltip: 'Tentar de novo', icon: const Icon(Icons.refresh), onPressed: onRetry)
              : null,
    );
  }
}

/// The first http(s) link in shared or pasted text ("Chapter 54 - Site https://…").
String? _extractLink(String text) => RegExp(r'https?://\S+').firstMatch(text)?.group(0);
