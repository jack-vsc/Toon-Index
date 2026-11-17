import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'api.dart';

/// Pairs the phone with the PC app: scanning the QR code from its 📱 Celular window, or typing the
/// PC's address and the six-digit code.
class PairScreen extends StatefulWidget {
  const PairScreen({super.key, required this.onPaired});

  final void Function(Connection connection) onPaired;

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _host = TextEditingController();
  final _code = TextEditingController();
  final _name = TextEditingController(text: 'Celular');
  bool _scanning = false;
  bool _busy = false;
  String? _error;

  Future<void> _pair(PairingInfo info) async {
    setState(() {
      _busy = true;
      _error = null;
      _scanning = false;
    });
    try {
      widget.onPaired(await Api.pair(info, _name.text));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _pairTyped() {
    final host = _host.text.trim();
    final code = _code.text.trim();
    if (host.isEmpty || code.length != 6) {
      setState(() => _error = 'Digite o endereço do PC e o código de 6 dígitos que aparece nele.');
      return;
    }
    _pair(PairingInfo(hosts: [host], port: 47321, code: code));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Parear com o PC')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'No Toon Index do PC, abra 📱 Celular, ligue o acesso pela rede e toque em "Parear um celular".',
          ),
          const SizedBox(height: 16),
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Nome deste celular')),
          const SizedBox(height: 20),
          if (_scanning)
            SizedBox(
              height: 300,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: MobileScanner(
                  onDetect: (capture) {
                    if (_busy) return;
                    for (final code in capture.barcodes) {
                      final info = PairingInfo.parse(code.rawValue ?? '');
                      if (info != null) {
                        _pair(info);
                        return;
                      }
                    }
                  },
                ),
              ),
            )
          else
            FilledButton.icon(
              onPressed: _busy ? null : () => setState(() => _scanning = true),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Ler o QR code'),
            ),
          const SizedBox(height: 28),
          Text('Ou digite', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          TextField(
            controller: _host,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(labelText: 'Endereço do PC', hintText: '192.168.0.10'),
          ),
          TextField(
            controller: _code,
            keyboardType: TextInputType.number,
            maxLength: 6,
            decoration: const InputDecoration(labelText: 'Código'),
          ),
          FilledButton.tonal(onPressed: _busy ? null : _pairTyped, child: const Text('Parear')),
          if (_busy) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: CircularProgressIndicator())),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
        ],
      ),
    );
  }
}
