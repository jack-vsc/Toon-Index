import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'api.dart';

/// The PC hands out the newest build of this app (scripts/phone-release.mjs). When it is newer than
/// the one running, the app offers it once per opening: downloaded from the PC and handed to
/// Android's installer, which updates the app in place, keeping the pairing and the downloads.
class AppUpdate {
  static const _channel = MethodChannel('manga_index/app');
  static bool _offered = false;

  static Future<void> offer(BuildContext context, Api api) async {
    if (_offered) return;
    _offered = true;
    final int mine;
    final Map<String, dynamic> release;
    try {
      mine = await _channel.invokeMethod<int>('build') ?? 0;
      final response = await http.get(Uri.parse('${api.base}/api/app'), headers: api.authHeaders).timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) return;
      release = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      // Away from the PC, or not on Android: asked again next time the app opens.
      _offered = false;
      return;
    }
    final build = (release['build'] as num?)?.toInt() ?? 0;
    if (build <= mine || !context.mounted) return;
    final update = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Atualização disponível'),
        content: Text('O PC tem a versão ${release['version']} do Manga Index. Atualizar agora? '
            'O pareamento e os capítulos baixados continuam no celular.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Depois')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Atualizar')),
        ],
      ),
    );
    if (update != true || !context.mounted) return;
    await showDialog<void>(context: context, barrierDismissible: false, builder: (_) => _Downloading(api: api));
  }
}

/// Downloads the update with its progress, then opens the installer.
class _Downloading extends StatefulWidget {
  const _Downloading({required this.api});

  final Api api;

  @override
  State<_Downloading> createState() => _DownloadingState();
}

class _DownloadingState extends State<_Downloading> {
  double? _progress;
  String? _error;

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    final client = http.Client();
    try {
      final dir = Directory('${(await getTemporaryDirectory()).path}/updates');
      await dir.create(recursive: true);
      final file = File('${dir.path}/MangaIndex.apk');
      final response = await client.send(http.Request('GET', Uri.parse('${widget.api.base}/api/app/apk'))..headers.addAll(widget.api.authHeaders));
      if (response.statusCode != 200) throw Exception('erro ${response.statusCode}');
      final total = response.contentLength;
      var received = 0;
      final sink = file.openWrite();
      await for (final chunk in response.stream) {
        sink.add(chunk);
        received += chunk.length;
        if (mounted && total != null && total > 0) setState(() => _progress = received / total);
      }
      await sink.close();
      await AppUpdate._channel.invokeMethod('install', {'path': file.path});
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => _error = 'Não foi possível baixar a atualização do PC ($e).');
    } finally {
      client.close();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Atualizando'),
      content: _error != null
          ? Text(_error!)
          : Column(mainAxisSize: MainAxisSize.min, children: [
              LinearProgressIndicator(value: _progress),
              const SizedBox(height: 12),
              const Text('Baixando do PC… Depois, confirme a instalação na tela do Android.'),
            ]),
      actions: [if (_error != null) TextButton(onPressed: () => Navigator.pop(context), child: const Text('Fechar'))],
    );
  }
}
