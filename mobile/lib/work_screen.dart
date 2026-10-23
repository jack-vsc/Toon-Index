import 'package:flutter/material.dart';
import 'api.dart';
import 'browser_screen.dart';
import 'downloads.dart';
import 'library_screen.dart';
import 'models.dart';
import 'reader_screen.dart';

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
        icon: const Icon(Icons.offline_pin, color: Color(0xFF4CCF8A)),
        onPressed: () => _removeDownload(c),
      );
    }
    return IconButton(tooltip: 'Baixar para ler sem internet', icon: const Icon(Icons.download), onPressed: () => _download(c));
  }

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
    return Scaffold(
      appBar: AppBar(title: Text(view.work.name)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (aliases.isNotEmpty) Text('Também: ${aliases.join(' · ')}', style: const TextStyle(color: Colors.grey)),
          const SizedBox(height: 6),
          Text(statusText(view), style: const TextStyle(color: Color(0xFF4CCF8A))),
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
                    labelStyle: TextStyle(color: r.read ? const Color(0xFF4CCF8A) : const Color(0xFFFF8A5C)),
                    onPressed: r.url.isEmpty
                        ? null
                        : () => Navigator.push(context, MaterialPageRoute(builder: (_) => BrowserScreen(api: widget.api, url: r.url))),
                  ),
              ],
            ),
          ],
          if (view.translated.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text('Traduzidos no PC', style: Theme.of(context).textTheme.titleMedium),
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
                subtitle: Text(c.translatedPages == c.pageCount ? '${c.pageCount} páginas' : '${c.translatedPages} de ${c.pageCount} páginas traduzidas'),
                trailing: _downloadButton(c),
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ReaderScreen(api: widget.api, chapter: c))),
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
        ],
      ),
    );
  }
}
