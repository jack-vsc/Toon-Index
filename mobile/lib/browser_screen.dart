import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'api.dart';
import 'models.dart';

/// Reads chapters on their sites inside the app. The page runs the PC extension's tracker
/// (assets/reading_tracker.js), so the chapter is marked read or in progress the same way.
class BrowserScreen extends StatefulWidget {
  const BrowserScreen({super.key, required this.api, this.url, this.recent = const []});

  final Api api;

  /// The page to open; without one, the screen starts with [recent].
  final String? url;

  /// Works to pick up where they were left, for the start page.
  final List<WorkView> recent;

  @override
  State<BrowserScreen> createState() => _BrowserScreenState();
}

class _BrowserScreenState extends State<BrowserScreen> {
  late final WebViewController _web;
  final _address = TextEditingController();
  final _addressFocus = FocusNode();
  String? _tracker;
  bool _started = false;
  int _loading = 0;

  /// What the PC said about the chapter open: its work, chapter, read or how far.
  Map<String, dynamic>? _status;
  bool _offline = false;

  @override
  void initState() {
    super.initState();
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('MangaIndex', onMessageReceived: (m) => _onReport(m.message))
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) => mounted ? setState(() => _loading = p) : null,
        onUrlChange: (change) {
          if (change.url == null || !mounted) return;
          setState(() => _status = null);
          if (!_addressFocus.hasFocus) _address.text = change.url!;
        },
        onPageFinished: (_) => _inject(),
      ));
    if (widget.url != null) _go(widget.url!);
  }

  @override
  void dispose() {
    _address.dispose();
    _addressFocus.dispose();
    super.dispose();
  }

  void _go(String text) {
    final typed = text.trim();
    if (typed.isEmpty) return;
    final uri = Uri.tryParse(typed.contains('://') ? typed : 'https://$typed');
    if (uri == null || !uri.host.contains('.')) return;
    setState(() => (_started = true, _status = null));
    _address.text = uri.toString();
    _web.loadRequest(uri);
  }

  /// Runs the tracker in the page; its reports reach [_onReport] through the MangaIndex channel.
  Future<void> _inject() async {
    _tracker ??= await rootBundle.loadString('assets/reading_tracker.js');
    await _web.runJavaScript('''
(function () {
  if (window.__mangaIndexTracker) return;
  window.__mangaIndexTracker = true;
  // What the extension's background page does, done by the app instead.
  const chrome = { runtime: { sendMessage: (m) => MangaIndex.postMessage(JSON.stringify(m)) } };
  $_tracker
})();''');
  }

  Future<void> _onReport(String message) async {
    final data = jsonDecode(message) as Map<String, dynamic>;
    if (data['type'] != 'reading') return;
    try {
      final result = await widget.api.reportBrowserReading(data['report'] as Map<String, dynamic>);
      if (mounted) setState(() => (_status = result ?? _status, _offline = result == null));
    } on ApiException {
      if (mounted) setState(() => _offline = true);
    }
  }

  Future<void> _translate() async {
    final url = await _web.currentUrl();
    if (url == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.api.translateLink(url);
      messenger.showSnackBar(const SnackBar(content: Text('Enviado ao PC para traduzir. Acompanhe em "Traduzir no PC".')));
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// "✓ cap. 54" or "cap. 54 · 40%" for the chapter open, as the PC counted it.
  Widget? _badge() {
    final status = _status;
    if (status == null) {
      return _offline ? const Tooltip(message: 'PC fora de alcance: a leitura será enviada depois', child: Icon(Icons.cloud_off, size: 20)) : null;
    }
    final chapter = chapterLabel((status['chapter'] as num).toDouble());
    final read = status['status'] == 'read';
    final progress = status['progress'] as num?;
    return Tooltip(
      message: '${displayName(status['work'] as String? ?? '')} — ${read ? 'lido' : 'em andamento'}',
      child: Chip(
        visualDensity: VisualDensity.compact,
        label: Text(read ? '✓ $chapter' : '$chapter · ${progress != null ? '${(progress * 100).round()}%' : '…'}'),
        labelStyle: TextStyle(color: read ? const Color(0xFF4CCF8A) : const Color(0xFFFF8A5C), fontSize: 12),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final badge = _badge();
    return PopScope(
      canPop: false,
      // The phone's back button goes back in the site first.
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final navigator = Navigator.of(context);
        if (_started && await _web.canGoBack()) {
          await _web.goBack();
        } else {
          navigator.pop();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          titleSpacing: 0,
          title: TextField(
            controller: _address,
            focusNode: _addressFocus,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.go,
            style: const TextStyle(fontSize: 14),
            decoration: const InputDecoration(hintText: 'Endereço do site', border: InputBorder.none, isDense: true),
            onSubmitted: _go,
            onTap: () => _address.selection = TextSelection(baseOffset: 0, extentOffset: _address.text.length),
          ),
          actions: [
            ?badge,
            PopupMenuButton<String>(
              onSelected: (action) async {
                switch (action) {
                  case 'forward':
                    if (await _web.canGoForward()) await _web.goForward();
                  case 'reload':
                    await _web.reload();
                  case 'translate':
                    await _translate();
                  case 'external':
                    final url = await _web.currentUrl();
                    if (url != null) await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
                }
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'forward', child: Text('Avançar')),
                const PopupMenuItem(value: 'reload', child: Text('Recarregar')),
                if (_started) const PopupMenuItem(value: 'translate', child: Text('Traduzir este capítulo no PC')),
                if (_started) const PopupMenuItem(value: 'external', child: Text('Abrir no navegador do celular')),
              ],
            ),
          ],
          bottom: _started && _loading < 100
              ? PreferredSize(preferredSize: const Size.fromHeight(2), child: LinearProgressIndicator(value: _loading / 100, minHeight: 2))
              : null,
        ),
        body: _started ? WebViewWidget(controller: _web) : BrowserStartPage(recent: widget.recent, onOpen: _go),
      ),
    );
  }
}

/// Before a site is open: the works to pick up where they were left.
class BrowserStartPage extends StatelessWidget {
  const BrowserStartPage({super.key, required this.recent, required this.onOpen});

  final List<WorkView> recent;
  final void Function(String url) onOpen;

  @override
  Widget build(BuildContext context) {
    final withUrl = recent.where((v) => v.continueUrl != null).take(12).toList();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('Leia nos sites por aqui: o capítulo é marcado como lido quando você chega ao fim, igual à extensão do PC.'),
        if (withUrl.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Continuar de onde parou', style: Theme.of(context).textTheme.titleMedium),
          for (final view in withUrl)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.play_circle_fill, color: Color(0xFFFF5D73)),
              title: Text(view.work.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(Uri.parse(view.continueUrl!).host.replaceFirst(RegExp(r'^www\.'), ''), maxLines: 1),
              onTap: () => onOpen(view.continueUrl!),
            ),
        ],
      ],
    );
  }
}
