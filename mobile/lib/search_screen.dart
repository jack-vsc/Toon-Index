import 'package:flutter/material.dart';

import 'api.dart';
import 'batch_screen.dart';
import 'models.dart';
import 'theme.dart';
import 'work_screen.dart';

/// The search on top of the scans' pages (Ctrl+K on the PC): the library's works by any of their
/// names, and the name looked up on the sites to translate or download its chapters.
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key, required this.api, required this.views});

  final Api api;
  final List<WorkView> views;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final query = _query.trim();
    final found = query.isEmpty ? <WorkView>[] : widget.views.where((v) => v.matches(query)).toList();
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: TextField(
          autofocus: true,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Buscar obra por qualquer nome…', isDense: true),
          onChanged: (q) => setState(() => _query = q),
        ),
        actions: const [SizedBox(width: 12)],
      ),
      body: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
        for (final view in found)
          ListTile(
            leading: SizedBox(width: 40, child: CoverImage(url: coverUrlOf(view, widget.api), api: widget.api, radius: 5)),
            title: Text(view.work.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(view.metaLine, style: const TextStyle(color: muted, fontSize: 12)),
            onTap: () => Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => WorkScreen(view: view, api: widget.api))),
          ),
        if (query.isNotEmpty && widget.api.paired)
          ListTile(
            leading: const SizedBox(width: 40, child: Icon(Icons.travel_explore, color: accent)),
            title: Text('Buscar “$query” nos sites', style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: const Text('MangaDex, mgeko, MangaKakalot e MangaLivre: traduzir ou baixar capítulos', style: TextStyle(color: muted, fontSize: 12)),
            onTap: () => Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => BatchScreen(api: widget.api, query: query))),
          ),
        if (query.isEmpty)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Text('Digite o nome da obra, em qualquer língua em que ela já apareceu.', style: TextStyle(color: muted), textAlign: TextAlign.center),
          ),
        if (query.isNotEmpty && found.isEmpty && !widget.api.paired)
          const Padding(padding: EdgeInsets.all(24), child: Text('Nenhuma obra com esse nome.', textAlign: TextAlign.center)),
      ]),
    );
  }
}
