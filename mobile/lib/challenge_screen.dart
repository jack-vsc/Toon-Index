import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'api.dart';

/// A site's "are you a robot" check, done in the PC's browser: the check's cookie only counts for the
/// browser that passed it. The page arrives as a picture, renewed every moment, and each tap on it is a
/// click there; holding the finger holds the mouse button ("press and hold").
class ChallengeScreen extends StatefulWidget {
  const ChallengeScreen({super.key, required this.api, required this.id, required this.site});

  final Api api;
  final String id;
  final String site;

  @override
  State<ChallengeScreen> createState() => _ChallengeScreenState();
}

class _ChallengeScreenState extends State<ChallengeScreen> {
  final _image = GlobalKey();
  Uint8List? _frame;
  String? _error;
  bool _done = false;
  bool _busy = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(milliseconds: 800), (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    if (_busy || _done) return;
    _busy = true;
    try {
      final frame = await widget.api.challengeFrame(widget.id);
      if (mounted) setState(() => (_frame = frame, _error = null));
    } on ApiException catch (e) {
      // The PC answers that the check is over once the site lets the browser in.
      if (e.message.contains('terminou')) {
        _timer?.cancel();
        if (mounted) setState(() => _done = true);
      } else if (mounted) {
        setState(() => _error = e.message);
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      _busy = false;
    }
  }

  Future<void> _press(Offset at, String action) async {
    final size = _image.currentContext?.size;
    if (size == null || size.isEmpty) return;
    try {
      await widget.api.challengePress(widget.id, at.dx / size.width, at.dy / size.height, action);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    // The page changes right after a click: show it without waiting for the next round.
    unawaited(Future.delayed(const Duration(milliseconds: 300), _load));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.site.isEmpty ? 'Verificação' : 'Verificação · ${widget.site}')),
      body: _done
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(Icons.check_circle, size: 56, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(height: 16),
                  const Text('Verificação concluída. O PC continua de onde parou.', textAlign: TextAlign.center),
                  const SizedBox(height: 20),
                  FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Voltar')),
                ]),
              ),
            )
          : Column(children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Text(
                  'Esta é a página aberta no PC. Toque nela como faria no navegador; segure o dedo quando o site pedir para pressionar e segurar.',
                ),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ),
              Expanded(
                child: _frame == null
                    ? const Center(child: CircularProgressIndicator())
                    : Center(
                        child: GestureDetector(
                          onTapUp: (d) => _press(d.localPosition, 'tap'),
                          onLongPressStart: (d) => _press(d.localPosition, 'down'),
                          onLongPressEnd: (d) => _press(d.localPosition, 'up'),
                          child: Image.memory(_frame!, key: _image, gaplessPlayback: true, fit: BoxFit.contain),
                        ),
                      ),
              ),
            ]),
    );
  }
}
