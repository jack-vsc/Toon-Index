import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'local_data.dart';

/// The phone's data: exported to a file (to the phone, or to Google Drive through Android's file
/// picker) and brought back from one, and how Android's backup keeps it in the Google account.
class DataScreen extends StatefulWidget {
  const DataScreen({super.key, required this.api});

  final Api api;

  @override
  State<DataScreen> createState() => _DataScreenState();
}

class _DataScreenState extends State<DataScreen> {
  String? _message;
  bool _busy = false;

  Future<void> _export() async {
    setState(() => (_busy = true, _message = null));
    try {
      final data = await LocalData.export();
      final day = DateTime.now().toIso8601String().substring(0, 10);
      final path = await FilePicker.saveFile(
        dialogTitle: 'Salvar o backup',
        fileName: 'manga-index-$day.json',
        mimeType: 'application/json',
        bytes: Uint8List.fromList(utf8.encode(const JsonEncoder.withIndent(' ').convert(data))),
      );
      final works = (data['works'] as List).length;
      final chapters = (data['reading'] as List).length;
      if (mounted) setState(() => _message = path == null ? null : 'Backup salvo: $works obras e $chapters capítulos.');
    } catch (e) {
      if (mounted) setState(() => _message = 'Não foi possível salvar o backup ($e).');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _import() async {
    setState(() => (_busy = true, _message = null));
    try {
      final picked = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: ['json']);
      if (picked.isEmpty) return;
      final bytes = await picked.first.readAsBytes();
      final file = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
      final (works, chapters) = await widget.api.importData(file);
      if (mounted) {
        setState(() => _message = 'Backup restaurado: $works obras e $chapters capítulos juntados aos que já estavam no celular.'
            '${widget.api.paired ? ' O PC recebe também.' : ''}');
      }
    } on FormatException catch (e) {
      if (mounted) setState(() => _message = e.message);
    } catch (e) {
      if (mounted) setState(() => _message = 'Não foi possível ler o arquivo ($e).');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Dados e backup')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const Text(
          'A biblioteca, onde você parou em cada obra, as listas e as favoritas ficam guardadas no celular. Com o PC '
          'conectado, os dois se juntam sozinhos sempre que se falam.',
        ),
        const SizedBox(height: 20),
        Text('Arquivo de backup', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        const Text(
          'Um arquivo JSON com tudo isso. Na hora de salvar, dá para escolher o Google Drive. Restaurar junta o arquivo ao '
          'que já está no celular, sem apagar nada. O mesmo arquivo serve no PC (Configurações).',
          style: TextStyle(color: Colors.white70),
        ),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: FilledButton.icon(onPressed: _busy ? null : _export, icon: const Icon(Icons.upload_file), label: const Text('Exportar'))),
          const SizedBox(width: 12),
          Expanded(child: OutlinedButton.icon(onPressed: _busy ? null : _import, icon: const Icon(Icons.restore), label: const Text('Restaurar'))),
        ]),
        if (_message != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_message!)),
        const SizedBox(height: 28),
        Text('Backup na conta Google', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        const Text(
          'O Android guarda os dados do app na sua conta Google sozinho (uma vez por dia, no Wi-Fi e carregando) e os '
          'devolve se você reinstalar o app no mesmo celular ou num novo com a mesma conta. Os capítulos baixados não '
          'entram, só os dados: é preciso baixá-los de novo.\n\n'
          'Confira se está ligado em: Configurações do Android › Google › Backup › Backup do Google One.',
          style: TextStyle(color: Colors.white70),
        ),
      ]),
    );
  }
}
