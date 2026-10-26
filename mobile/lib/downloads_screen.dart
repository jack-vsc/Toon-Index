import 'package:flutter/material.dart';

import 'api.dart';
import 'models.dart';
import 'reader_screen.dart';
import 'site_download.dart';

/// Where chapters are downloaded (PC or phone, Wi-Fi or mobile data) and the ones the phone keeps.
class DownloadsScreen extends StatefulWidget {
  const DownloadsScreen({super.key, required this.api});

  final Api api;

  @override
  State<DownloadsScreen> createState() => _DownloadsScreenState();
}

class _DownloadsScreenState extends State<DownloadsScreen> {
  DownloadPrefs? _prefs;
  List<PhoneChapter> _chapters = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final prefs = await DownloadPrefs.load();
    final chapters = (await PhoneChapter.all())..sort((a, b) => b.savedAt.compareTo(a.savedAt));
    if (mounted) setState(() => (_prefs = prefs, _chapters = chapters));
  }

  Future<void> _set({DownloadWhere? where, bool? wifiOnly}) async {
    final prefs = DownloadPrefs(where: where ?? _prefs!.where, wifiOnly: wifiOnly ?? _prefs!.wifiOnly);
    await prefs.save();
    setState(() => _prefs = prefs);
  }

  Future<void> _remove(PhoneChapter c) async {
    await PhoneChapter.remove(c.id);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final prefs = _prefs;
    return Scaffold(
      appBar: AppBar(title: const Text('Downloads')),
      body: prefs == null
          ? const Center(child: CircularProgressIndicator())
          : RadioGroup<DownloadWhere>(
              groupValue: prefs.where,
              onChanged: (w) => _set(where: w),
              child: ListView(children: [
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 16, 16, 4),
                  child: Text('Capítulos já em português: onde baixar', style: TextStyle(fontWeight: FontWeight.bold)),
                ),
                const RadioListTile(
                  value: DownloadWhere.pcFirst,
                  title: Text('No PC quando estiver ligado, senão no celular'),
                  subtitle: Text('O PC guarda na biblioteca dele, para todos os aparelhos.'),
                ),
                const RadioListTile(
                  value: DownloadWhere.phone,
                  title: Text('Sempre no celular'),
                  subtitle: Text('Não depende do PC; o capítulo fica só neste celular.'),
                ),
                const RadioListTile(value: DownloadWhere.pc, title: Text('Sempre no PC')),
                SwitchListTile(
                  value: prefs.wifiOnly,
                  onChanged: (v) => _set(wifiOnly: v),
                  title: const Text('No celular, baixar só no Wi-Fi'),
                  subtitle: const Text('Desligado, usa os dados móveis também (de 5 a 30 MB por capítulo).'),
                ),
                const Divider(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                  child: Text('Baixados no celular (${_chapters.length})', style: const TextStyle(fontWeight: FontWeight.bold)),
                ),
                if (_chapters.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(16),
                    child: Text('Nenhum ainda. Baixe pelo menu ⋮ do navegador do app, ou pelo capítulo novo na tela da obra.'),
                  ),
                for (final c in _chapters)
                  ListTile(
                    leading: const Icon(Icons.offline_pin),
                    title: Text(c.title, maxLines: 2, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${c.pages} páginas · ${Uri.parse(c.url).host}'),
                    trailing: IconButton(tooltip: 'Apagar do celular', icon: const Icon(Icons.delete_outline), onPressed: () => _remove(c)),
                    onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ReaderScreen(api: widget.api, chapter: c.asLibrary))),
                  ),
              ]),
            ),
    );
  }
}

/// Phone chapters of a work, for its screen.
Future<List<LibraryChapter>> phoneChaptersOf(String workId) async => [
      for (final c in await PhoneChapter.all())
        if (c.workId == workId) c.asLibrary,
    ]..sort((a, b) => (a.chapter ?? 0).compareTo(b.chapter ?? 0));
