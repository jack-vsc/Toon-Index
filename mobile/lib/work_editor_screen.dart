import 'dart:convert';

import 'package:flutter/material.dart';

import 'api.dart';
import 'local_data.dart';
import 'models.dart';
import 'theme.dart';

/// A work's editor, as on the PC: its names, the sites checked for new chapters, the catalog search,
/// what the PC does with a new chapter, and joining it with the same work under another name.
/// Pops with true once something changed on the PC.
class WorkEditorScreen extends StatefulWidget {
  const WorkEditorScreen({super.key, required this.work, required this.api});

  final Work work;
  final Api api;

  @override
  State<WorkEditorScreen> createState() => _WorkEditorScreenState();
}

class _WorkEditorScreenState extends State<WorkEditorScreen> {
  /// The work's names, the first the one it is shown by; dragged or starred into order.
  late final List<String> _names = [...widget.work.names];
  final _newName = TextEditingController();

  /// Moving or taking out a name is saved at once: the work is shown by its new first name.
  void _saveNames(void Function() change) {
    setState(change);
    _edit('names', {'names': [..._names]});
  }

  void _addName() {
    final name = _newName.text.trim();
    if (name.isEmpty) return;
    setState(() => _names.add(name));
    _newName.clear();
  }
  late final List<TextEditingController> _sources = [for (final s in widget.work.sources) TextEditingController(text: s)];
  late final _query = TextEditingController(text: widget.work.name);
  late String? _auto = widget.work.auto;
  late bool _volumes = widget.work.inVolumes;
  List<Work> _others = [];
  String? _mergeId;
  List<CatalogResult>? _results;
  final Set<String> _chosen = {};
  String? _busy;
  bool _changed = false;

  static const _maxSources = 3;

  @override
  void initState() {
    super.initState();
    LocalData.library().then((library) {
      final format = widget.work.isNovel;
      if (mounted) setState(() => _others = library.works.where((w) => w.id != widget.work.id && w.isNovel == format).toList()..sort((a, b) => a.name.compareTo(b.name)));
    });
  }

  /// Sends one change; says what went wrong, or that it was saved.
  Future<bool> _edit(String what, Map<String, dynamic> change, {String? done}) async {
    setState(() => _busy = what);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.api.editWork(widget.work.id, change);
      _changed = true;
      if (done != null) messenger.showSnackBar(SnackBar(content: Text(done)));
      return true;
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
      return false;
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  /// Deletes the work on the PC, after asking: its chapters, where it was left and its cover go.
  Future<void> _delete() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text('Excluir "${widget.work.name}"?'),
        content: const Text('Os capítulos traduzidos dela no PC, onde você parou e a capa somem. Não dá para desfazer.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false), child: const Text('Cancelar')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFE5484D)),
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Excluir'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    setState(() => _busy = 'delete');
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.api.deleteWork(widget.work.id);
      // The work's page goes too: back to the library, which no longer has it.
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _saveSources() async {
    final list = _sources.map((c) => c.text.trim()).where((s) => s.isNotEmpty).toList();
    await _edit('sources', {'sources': list}, done: 'Sites salvos.');
  }

  Future<void> _search() async {
    setState(() {
      _busy = 'search';
      _results = null;
      _chosen.clear();
    });
    try {
      final found = await widget.api.searchSites(_query.text.trim());
      // The ones with one of the work's names exactly come chosen, as on the PC.
      final names = widget.work.names.map((n) => n.toLowerCase().trim()).toSet();
      setState(() {
        _results = found;
        for (final r in found) {
          final same = r.matches.where((m) => [m.title, ...m.altNames].any((n) => names.contains(n.toLowerCase().trim()))).firstOrNull;
          if (same != null) _chosen.add(same.url);
        }
      });
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  /// One choice per site: choosing another of the same site swaps it, choosing it again unchooses.
  void _toggle(CatalogResult result, CatalogMatch match) => setState(() {
        final had = _chosen.contains(match.url);
        _chosen.removeAll(result.matches.map((m) => m.url));
        if (!had) _chosen.add(match.url);
      });

  Future<void> _link() async {
    final matches = [
      for (final r in _results ?? <CatalogResult>[])
        for (final m in r.matches)
          if (_chosen.contains(m.url)) {'site': m.site, 'title': m.title, 'url': m.url, 'altNames': m.altNames, 'latest': m.latest, 'cover': null},
    ];
    if (await _edit('link', {'matches': matches}, done: 'Nomes, capa e site vinculados.') && mounted) setState(() => _results = null);
  }

  Future<void> _merge() async {
    final other = _others.where((w) => w.id == _mergeId).firstOrNull;
    if (other == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Juntar as obras?'),
        content: Text('Os capítulos, as leituras e os nomes de "${other.name}" passam para esta obra.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Juntar')),
        ],
      ),
    );
    if (ok == true && await _edit('merge', {'fromId': other.id}) && mounted) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    final heading = Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800);
    Widget label(String text) => Padding(padding: const EdgeInsets.only(top: 22, bottom: 6), child: Text(text, style: heading));
    const hint = TextStyle(color: muted, fontSize: 12);
    final busy = _busy != null;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.pop(context, _changed);
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('Editar obra'), bottom: busy ? const PreferredSize(preferredSize: Size.fromHeight(2), child: LinearProgressIndicator(minHeight: 2)) : null),
        body: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 32), children: [
          label('Nomes (o primeiro é o que aparece)'),
          ReorderableListView(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            buildDefaultDragHandles: false,
            onReorderItem: (from, to) => _saveNames(() => _names.insert(to, _names.removeAt(from))),
            children: [
              for (final (i, name) in _names.indexed)
                ListTile(
                  key: ValueKey('$i-$name'),
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  leading: ReorderableDragStartListener(index: i, child: const Icon(Icons.drag_indicator, color: Colors.white54)),
                  title: Text(name, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: i == 0 ? FontWeight.w800 : FontWeight.w500)),
                  subtitle: i == 0 ? const Text('Principal', style: TextStyle(color: Color(0xFFFF8A5C), fontSize: 11)) : null,
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (i > 0)
                      IconButton(
                        tooltip: 'Mostrar a obra com este nome',
                        icon: const Icon(Icons.star_border, size: 20),
                        onPressed: () => _saveNames(() => _names.insert(0, _names.removeAt(i))),
                      ),
                    if (_names.length > 1)
                      IconButton(tooltip: 'Tirar este nome', icon: const Icon(Icons.close, size: 18), onPressed: () => _saveNames(() => _names.removeAt(i))),
                  ]),
                ),
            ],
          ),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _newName,
                decoration: const InputDecoration(hintText: 'Outro nome (de outro site ou idioma)', isDense: true),
                onSubmitted: (_) => _addName(),
              ),
            ),
            IconButton(tooltip: 'Adicionar', icon: const Icon(Icons.add), onPressed: _addName),
          ]),
          const SizedBox(height: 6),
          const Text('Capítulos com qualquer um desses nomes, ou com o começo deles, entram nesta obra. Adicione os nomes usados em outros sites e idiomas.', style: hint),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              onPressed: busy ? null : () => _edit('names', {'names': [..._names, _newName.text].map((n) => n.trim()).where((n) => n.isNotEmpty).toList()}, done: 'Nomes salvos.'),
              child: const Text('Salvar nomes'),
            ),
          ),

          label('Buscar nos sites (${catalogSites.values.join(', ')})'),
          if (widget.work.catalogSites.isNotEmpty) Text('Já encontrada no ${widget.work.catalogSites.map((s) => catalogSites[s] ?? s).join(', ')}.', style: hint),
          const Text('Traz outros nomes, a capa e a página para avisar de capítulo novo.', style: hint),
          const SizedBox(height: 6),
          Row(children: [
            Expanded(child: TextField(controller: _query, textInputAction: TextInputAction.search, onSubmitted: (_) => _search())),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: busy || _query.text.trim().isEmpty ? null : _search, child: Text(_busy == 'search' ? 'Buscando…' : 'Buscar')),
          ]),
          for (final r in _results ?? <CatalogResult>[]) ...[
            Padding(padding: const EdgeInsets.only(top: 12, bottom: 4), child: Text(catalogSites[r.site] ?? r.site, style: monoLabel(color: accentSoft))),
            if (r.error != null) Text(r.error!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
            if (r.error == null && r.matches.isEmpty) const Text('Nada encontrado com esse nome.', style: hint),
            for (final m in r.matches) _Match(match: m, chosen: _chosen.contains(m.url), onTap: () => _toggle(r, m)),
          ],
          if (_results != null)
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                onPressed: busy || _chosen.isEmpty ? null : _link,
                child: Text(_busy == 'link' ? 'Vinculando…' : (_chosen.length == 1 ? 'Usar o escolhido' : 'Usar os ${_chosen.length} escolhidos')),
              ),
            ),

          label('Sites para avisar de capítulo novo (até $_maxSources)'),
          const Text('A página da obra no site, a que lista os capítulos.', style: hint),
          for (final (i, c) in _sources.indexed)
            Row(children: [
              Expanded(child: TextField(controller: c, keyboardType: TextInputType.url, decoration: const InputDecoration(hintText: 'https://…'))),
              IconButton(
                tooltip: 'Tirar',
                icon: const Icon(Icons.close),
                onPressed: busy
                    ? null
                    : () {
                        setState(() => _sources.removeAt(i));
                        _saveSources();
                      },
              ),
            ]),
          Row(children: [
            if (_sources.length < _maxSources)
              TextButton.icon(onPressed: () => setState(() => _sources.add(TextEditingController())), icon: const Icon(Icons.add), label: const Text('Adicionar site')),
            const Spacer(),
            OutlinedButton(onPressed: busy ? null : _saveSources, child: const Text('Salvar sites')),
          ]),

          label('Numeração'),
          const Text('Volumes para quem traduz uma light novel um volume inteiro por vez: a obra mostra "Vol. 8" em vez de "Capítulo 8".', style: hint),
          const SizedBox(height: 6),
          SegmentedButton<bool>(
            segments: const [ButtonSegment(value: false, label: Text('Capítulos')), ButtonSegment(value: true, label: Text('Volumes'))],
            selected: {_volumes},
            onSelectionChanged: busy
                ? null
                : (picked) async {
                    final before = _volumes;
                    setState(() => _volumes = picked.first);
                    if (!await _edit('unit', {'unit': picked.first ? 'volume' : 'chapter'}) && mounted) setState(() => _volumes = before);
                  },
          ),

          label('Quando sair capítulo novo'),
          RadioGroup<String?>(
            groupValue: _auto,
            onChanged: (value) async {
              final before = _auto;
              setState(() => _auto = value);
              if (!await _edit('auto', {'auto': value}) && mounted) setState(() => _auto = before);
            },
            child: const Column(children: [
              RadioListTile<String?>(contentPadding: EdgeInsets.zero, value: null, title: Text('Só avisar')),
              RadioListTile<String?>(contentPadding: EdgeInsets.zero, value: 'translate', title: Text('Traduzir no PC sozinho')),
              RadioListTile<String?>(contentPadding: EdgeInsets.zero, value: 'download', title: Text('Baixar no PC sem traduzir')),
            ]),
          ),

          label('Dados da obra'),
          const Text('Capa, sinopse, gêneros e situação, do MangaDex ou da página da obra num site.', style: hint),
          Align(
            alignment: Alignment.centerRight,
            child: OutlinedButton.icon(
              onPressed: busy ? null : () => _edit('refresh', {'refresh': true}, done: 'Dados atualizados.'),
              icon: const Icon(Icons.refresh, size: 18),
              label: Text(_busy == 'refresh' ? 'Atualizando…' : 'Atualizar dados'),
            ),
          ),

          if (_others.isNotEmpty) ...[
            label('É a mesma obra com outro nome?'),
            DropdownButton<String>(
              isExpanded: true,
              value: _mergeId,
              hint: const Text('Escolha a obra para juntar com esta…'),
              items: [for (final w in _others) DropdownMenuItem(value: w.id, child: Text(w.name, overflow: TextOverflow.ellipsis))],
              onChanged: (id) => setState(() => _mergeId = id),
            ),
            Align(alignment: Alignment.centerRight, child: OutlinedButton(onPressed: busy || _mergeId == null ? null : _merge, child: const Text('Juntar'))),
          ],

          const SizedBox(height: 28),
          OutlinedButton.icon(
            onPressed: busy ? null : _delete,
            style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFFE5484D), side: const BorderSide(color: Color(0xFFE5484D))),
            icon: const Icon(Icons.delete_outline, size: 18),
            label: Text(_busy == 'delete' ? 'Excluindo…' : 'Excluir obra'),
          ),
        ]),
      ),
    );
  }
}

/// One result of the catalog search: its cover, name, newest chapter and other names.
class _Match extends StatelessWidget {
  const _Match({required this.match, required this.chosen, required this.onTap});

  final CatalogMatch match;
  final bool chosen;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final thumb = match.thumb;
    final bytes = thumb != null && thumb.contains(',') ? base64Decode(thumb.split(',').last) : null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Ink(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: panel,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: chosen ? accent : lineColor),
          ),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(chosen ? Icons.radio_button_checked : Icons.radio_button_off, color: chosen ? accent : muted, size: 20),
            const SizedBox(width: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: bytes != null ? Image.memory(bytes, width: 40, height: 56, fit: BoxFit.cover) : const SizedBox(width: 40, height: 56, child: Icon(Icons.menu_book)),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(match.title, style: const TextStyle(fontWeight: FontWeight.bold)),
                if (match.latest != null) Text('cap. ${chapterLabel(match.latest!)}', style: const TextStyle(color: muted, fontSize: 12)),
                if (match.altNames.isNotEmpty)
                  Text(match.altNames.take(6).join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontSize: 11)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
