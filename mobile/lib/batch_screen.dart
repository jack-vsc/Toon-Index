import 'dart:convert';

import 'package:flutter/material.dart';

import 'api.dart';
import 'models.dart';
import 'theme.dart';
import 'translate_options.dart';

/// "Vários capítulos", as on the PC: the work looked up on MangaDex and mgeko (or its page on any site
/// given), then a range of its chapters for the PC to translate, or download as they are (a scan
/// already in Portuguese), one at a time.
class BatchScreen extends StatefulWidget {
  const BatchScreen({super.key, required this.api, this.query});

  final Api api;

  /// A name to look up as soon as the screen opens (from the search).
  final String? query;

  @override
  State<BatchScreen> createState() => _BatchScreenState();
}

class _BatchScreenState extends State<BatchScreen> {
  late final _name = TextEditingController(text: widget.query ?? '');
  final _link = TextEditingController();
  final _from = TextEditingController();
  final _to = TextEditingController();
  List<CatalogResult>? _results;

  /// Where the chapters come from: a match on a site, or a work's page given (site 'link').
  ({String site, String url, String title})? _picked;
  List<SiteChapterLink>? _chapters;
  bool _download = false;

  /// The range translated with these instead of the PC's settings.
  Map<String, dynamic>? _options;
  String? _busy;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.query != null) WidgetsBinding.instance.addPostFrameCallback((_) => _search());
  }

  Future<void> _run(String busy, Future<void> Function() work) async {
    setState(() => (_busy = busy, _error = null));
    try {
      await work();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _search() async {
    final query = _name.text.trim();
    if (query.isEmpty) return;
    FocusScope.of(context).unfocus();
    setState(() => (_picked = null, _chapters = null));
    await _run('Buscando nos sites…', () async {
      final results = await widget.api.searchSites(query);
      if (mounted) setState(() => _results = results);
    });
  }

  Future<void> _pick(String site, String url, String title) async {
    setState(() => (_picked = (site: site, url: url, title: title), _chapters = null));
    await _run(site == 'link' ? 'Lendo a lista de capítulos (pode levar alguns minutos)…' : 'Lendo os capítulos…', () async {
      final (:title, :chapters) = await widget.api.chapterList(site, url);
      if (!mounted) return;
      setState(() {
        _chapters = chapters;
        // A link read without the work's name: the name its page gives.
        if (title != null && title.isNotEmpty && _name.text.trim().isEmpty) {
          _name.text = title;
          _picked = (site: site, url: url, title: title);
        }
        if (chapters.isNotEmpty) {
          _from.text = chapterLabel(chapters.first.chapter);
          _to.text = chapterLabel(chapters.last.chapter);
        }
      });
    });
  }

  List<SiteChapterLink> get _range {
    final from = double.tryParse(_from.text.replaceAll(',', '.'));
    final to = double.tryParse(_to.text.replaceAll(',', '.'));
    if (from == null || to == null) return [];
    return (_chapters ?? []).where((c) => c.chapter >= from && c.chapter <= to).toList();
  }

  Future<void> _queue() async {
    final picked = _picked!;
    final range = _range;
    final work = _name.text.trim().isNotEmpty ? _name.text.trim() : picked.title;
    final site = picked.site == 'link' ? Uri.parse(picked.url).host.replaceFirst(RegExp(r'^www\.'), '') : picked.site;
    await _run('Mandando para o PC…', () async {
      await widget.api.queueBatch(work: work, site: site, chapters: range, download: _download, source: picked.url, options: _download ? null : _options);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('${range.length} capítulos na fila do PC: ${_download ? 'baixados' : 'traduzidos'} um por vez.'),
      ));
      Navigator.pop(context);
    });
  }

  @override
  Widget build(BuildContext context) {
    final range = _range;
    return Scaffold(
      appBar: AppBar(title: const Text('Vários capítulos', style: TextStyle(fontWeight: FontWeight.w800))),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 32), children: [
        const Text('Diga a obra e escolha de onde pegar: os capítulos vão para a fila do PC e entram na biblioteca.',
            style: TextStyle(color: muted, fontSize: 13)),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(
            child: TextField(
              controller: _name,
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Nome da obra'),
              onSubmitted: (_) => _search(),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(onPressed: _busy == null ? _search : null, child: const Text('Buscar')),
        ]),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: TextField(
              controller: _link,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.link), hintText: 'Ou o link da obra num site'),
              onChanged: (_) => setState(() {}),
            ),
          ),
          const SizedBox(width: 8),
          OutlinedButton(
            onPressed: _busy == null && _link.text.trim().startsWith('http') ? () => _pick('link', _link.text.trim(), _name.text.trim()) : null,
            child: const Text('Ler'),
          ),
        ]),
        if (_busy != null) ...[
          const SizedBox(height: 18),
          Row(children: [
            const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: 10),
            Expanded(child: Text(_busy!, style: const TextStyle(color: muted))),
          ]),
        ],
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 14), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
        if (_chapters != null && _picked != null) ...[
          const SizedBox(height: 18),
          _RangeCard(
            title: _picked!.title,
            count: _chapters!.length,
            from: _from,
            to: _to,
            selected: range.length,
            download: _download,
            onDownload: (d) => setState(() => _download = d),
            onChanged: () => setState(() {}),
            onQueue: range.isEmpty || _busy != null ? null : _queue,
          ),
          if (!_download) ...[
            const SizedBox(height: 10),
            TranslateOptionsCard(api: widget.api, onChanged: (o) => _options = o),
          ],
        ],
        for (final result in _results ?? <CatalogResult>[]) ...[
          const SizedBox(height: 18),
          Text(catalogSites[result.site] ?? result.site, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          if (result.error != null) Text(result.error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          if (result.error == null && result.matches.isEmpty) const Text('Nada encontrado com esse nome.', style: TextStyle(color: muted)),
          for (final m in result.matches)
            _MatchTile(
              match: m,
              picked: _picked?.url == m.url,
              onTap: _busy == null ? () => _pick(m.site, m.url, m.title) : null,
            ),
        ],
      ]),
    );
  }
}

class _MatchTile extends StatelessWidget {
  const _MatchTile({required this.match, required this.picked, required this.onTap});

  final CatalogMatch match;
  final bool picked;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final thumb = match.thumb;
    final bytes = thumb != null && thumb.contains(',') ? base64Decode(thumb.split(',').last) : null;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Ink(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: panel,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: picked ? accent : Colors.transparent),
          ),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: SizedBox(
                width: 48,
                height: 72,
                child: bytes != null ? Image.memory(bytes, fit: BoxFit.cover) : ColoredBox(color: Colors.white.withValues(alpha: 0.06)),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(match.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                if (match.latest != null) Text('cap. ${chapterLabel(match.latest!)}', style: const TextStyle(color: muted, fontSize: 12)),
                if (match.altNames.isNotEmpty)
                  Text(match.altNames.take(4).join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontSize: 11)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

/// The chapters found, the range to take of them, and translated or only downloaded.
class _RangeCard extends StatelessWidget {
  const _RangeCard({
    required this.title,
    required this.count,
    required this.from,
    required this.to,
    required this.selected,
    required this.download,
    required this.onDownload,
    required this.onChanged,
    required this.onQueue,
  });

  final String title;
  final int count;
  final TextEditingController from;
  final TextEditingController to;
  final int selected;
  final bool download;
  final void Function(bool download) onDownload;
  final VoidCallback onChanged;
  final VoidCallback? onQueue;

  @override
  Widget build(BuildContext context) {
    InputDecoration field(String label) => InputDecoration(labelText: label, isDense: true);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: panel, borderRadius: BorderRadius.circular(16), border: Border.all(color: lineColor)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title.isEmpty ? 'Capítulos' : title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(count == 0 ? 'Nenhum capítulo encontrado.' : '$count capítulos encontrados', style: const TextStyle(color: muted, fontSize: 12)),
        if (count > 0) ...[
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: TextField(controller: from, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: field('Do'), onChanged: (_) => onChanged())),
            const SizedBox(width: 10),
            Expanded(child: TextField(controller: to, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: field('Ao'), onChanged: (_) => onChanged())),
          ]),
          const SizedBox(height: 12),
          SegmentedButton<bool>(
            segments: const [
              ButtonSegment(value: false, label: Text('Traduzir')),
              ButtonSegment(value: true, label: Text('Só baixar (já em PT)')),
            ],
            selected: {download},
            onSelectionChanged: (s) => onDownload(s.first),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: onQueue,
              icon: Icon(download ? Icons.download : Icons.translate),
              label: Text('${download ? 'Baixar' : 'Traduzir'} $selected em ordem'),
            ),
          ),
        ],
      ]),
    );
  }
}
