import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'app_update.dart';
import 'data_screen.dart';
import 'storage_screen.dart';
import 'theme.dart';

/// Everything about the app in one place: the PC it is paired with, storage, data and backup, about.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key, required this.api, required this.onConnect, required this.onUnpair, this.ntfyTopic, required this.onSubscribe});

  final Api api;
  final VoidCallback onConnect;
  final Future<void> Function() onUnpair;

  /// The ntfy.sh topic the PC sends new chapters to, while that is on in the PC.
  final String? ntfyTopic;
  final Future<void> Function(String topic) onSubscribe;

  @override
  Widget build(BuildContext context) {
    final heading = Theme.of(context).textTheme.labelLarge?.copyWith(color: accentSoft, fontWeight: FontWeight.w700);
    Widget section(String text) => Padding(padding: const EdgeInsets.fromLTRB(16, 20, 16, 4), child: Text(text, style: heading));
    void open(Widget screen) => Navigator.push(context, MaterialPageRoute(builder: (_) => screen));
    return Scaffold(
      appBar: AppBar(title: const Text('Configurações')),
      body: ListView(children: [
        section('PC'),
        ListTile(
          leading: Icon(api.paired ? Icons.computer : Icons.link_off, color: api.paired ? readGreen : muted),
          title: Text(api.paired ? 'Pareado com o PC' : 'Não pareado'),
          subtitle: Text(
            api.paired
                ? 'Endereço: ${api.connection.ordered.first}. Se ele mudar, o celular acha o PC sozinho no Wi-Fi.'
                : 'Pareie para traduzir, ver a fila e sincronizar a biblioteca.',
            style: const TextStyle(color: muted, fontSize: 12),
          ),
        ),
        if (!api.paired)
          ListTile(
            leading: const Icon(Icons.qr_code_scanner),
            title: const Text('Parear com o PC'),
            onTap: () {
              Navigator.pop(context);
              onConnect();
            },
          ),
        if (api.paired) ...[
          ListTile(
            leading: const Icon(Icons.qr_code_scanner),
            title: const Text('Parear de novo'),
            subtitle: const Text('Lendo o QR code do PC outra vez', style: TextStyle(color: muted, fontSize: 12)),
            onTap: () {
              Navigator.pop(context);
              onConnect();
            },
          ),
          ListTile(leading: const Icon(Icons.system_update), title: const Text('Verificar atualização'), onTap: () => AppUpdate.check(context, api)),
          ListTile(
            leading: const Icon(Icons.link_off),
            title: const Text('Desparear'),
            onTap: () async {
              await onUnpair();
              if (context.mounted) Navigator.pop(context);
            },
          ),
        ],
        section('Notificações'),
        ListTile(
          leading: const Icon(Icons.notifications_active_outlined),
          title: const Text('Avisos de capítulo novo'),
          subtitle: Text(
            ntfyTopic != null
                ? 'Pelo app ntfy: toque para assinar os avisos que o PC manda.'
                : 'Ligue no PC, em Celular › "Avisar no celular pelo ntfy", e volte aqui.',
            style: const TextStyle(color: muted, fontSize: 12),
          ),
          enabled: ntfyTopic != null,
          onTap: ntfyTopic == null ? null : () => onSubscribe(ntfyTopic!),
        ),
        section('Armazenamento e dados'),
        ListTile(
          leading: const Icon(Icons.storage),
          title: const Text('Armazenamento'),
          subtitle: const Text('Quanto os capítulos ocupam no celular e no PC, e limpar', style: TextStyle(color: muted, fontSize: 12)),
          onTap: () => open(StorageScreen(api: api)),
        ),
        ListTile(
          leading: const Icon(Icons.backup_outlined),
          title: const Text('Dados e backup'),
          subtitle: const Text('Exportar e restaurar a biblioteca e as leituras', style: TextStyle(color: muted, fontSize: 12)),
          onTap: () => open(DataScreen(api: api)),
        ),
        section('Sobre'),
        ListTile(leading: const Icon(Icons.info_outline), title: const Text('Sobre o Manga Index'), onTap: () => open(const AboutScreen())),
      ]),
    );
  }
}

/// The app, its version and who made it.
class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key});

  static const _channel = MethodChannel('manga_index/app');

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sobre')),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        Center(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(24),
            child: Image.asset('assets/icon.png', width: 96, height: 96),
          ),
        ),
        const SizedBox(height: 16),
        const Center(child: Text('Manga Index', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800))),
        FutureBuilder<String?>(
          future: _channel.invokeMethod<String>('version').catchError((_) => null),
          builder: (context, snap) => Center(
            child: Text(snap.data != null ? 'Versão ${snap.data}' : '', style: const TextStyle(color: muted)),
          ),
        ),
        const SizedBox(height: 24),
        const Text(
          'Lê e traduz mangás, manhwas e webtoons. O PC traduz os capítulos com IA: acha o texto, apaga e escreve a '
          'tradução no lugar. O celular lê o que o PC traduziu, acompanha onde você parou em cada obra e manda '
          'capítulos para a fila do PC.',
        ),
        const SizedBox(height: 24),
        const ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.person_outline), title: Text('Criado por Jack')),
        const ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.computer),
          title: Text('App do PC e do celular'),
          subtitle: Text('Os dois se juntam pela rede de casa (ou pelo Tailscale, fora dela).', style: TextStyle(color: muted, fontSize: 12)),
        ),
      ]),
    );
  }
}
