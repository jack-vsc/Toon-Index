import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'api.dart';
import 'models.dart';

// The PC app's look: MangaDex's dark theme and orange, with comix's small mono capitals for labels.
const accent = Color(0xFFFF6740);
const accentSoft = Color(0xFFFF8A5C);
const readGreen = Color(0xFF4CCF8A);
const background = Color(0xFF131315);
const panel = Color(0xFF1E1E22);
const muted = Color(0xFF9E9EA8);

ThemeData appTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: accent, brightness: Brightness.dark, primary: accent, surface: panel);
  return ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: background,
    appBarTheme: const AppBarTheme(backgroundColor: background, scrolledUnderElevation: 0),
    useMaterial3: true,
  );
}

/// "CAP. 90 · MGREAD.IO": labels in small monospaced capitals.
TextStyle monoLabel({Color color = muted, double size = 11}) =>
    TextStyle(fontFamily: 'monospace', fontSize: size, letterSpacing: 0.6, color: color, fontWeight: FontWeight.w600);

/// The work's own cover (found on MangaDex or mgeko), or its latest translated chapter's.
String? coverUrlOf(WorkView view, Api api) {
  if (view.work.hasCover) return '${api.base}/api/work-cover/${view.work.id}';
  final chapter = view.translated.where((c) => c.hasCover).lastOrNull;
  return chapter != null ? '${api.base}/api/cover/${chapter.id}' : null;
}

/// A cover at 2:3, or a book where there is none. Kept on the phone once seen, so the library looks
/// the same away from the PC; looked up again after a week (a work's cover can change).
class CoverImage extends StatefulWidget {
  const CoverImage({super.key, required this.url, required this.api, this.radius = 8});

  final String? url;
  final Api api;
  final double radius;

  @override
  State<CoverImage> createState() => _CoverImageState();
}

class _CoverImageState extends State<CoverImage> {
  Uint8List? _bytes;

  /// Where the phone's storage cannot be used (tests): straight from the PC.
  bool _network = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(CoverImage old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      _bytes = null;
      _load();
    }
  }

  Future<void> _load() async {
    final url = widget.url;
    if (url == null) return;
    File file;
    try {
      final dir = Directory('${(await getApplicationSupportDirectory()).path}/covers');
      await dir.create(recursive: true);
      file = File('${dir.path}/${Uri.parse(url).pathSegments.join('-')}.jpg');
    } catch (_) {
      if (mounted) setState(() => _network = true);
      return;
    }
    if (await file.exists()) {
      final bytes = await file.readAsBytes();
      if (mounted && widget.url == url) setState(() => _bytes = bytes);
      if (DateTime.now().difference(await file.lastModified()) < const Duration(days: 7)) return;
    }
    try {
      final response = await http.get(Uri.parse(url), headers: widget.api.authHeaders).timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) return;
      await file.writeAsBytes(response.bodyBytes);
      if (mounted && widget.url == url) setState(() => _bytes = response.bodyBytes);
    } catch (_) {
      // Away from the PC: the copy kept, if any.
    }
  }

  @override
  Widget build(BuildContext context) {
    final none = ColoredBox(color: Theme.of(context).colorScheme.surfaceContainerHighest, child: const Center(child: Text('📚', style: TextStyle(fontSize: 28))));
    final url = widget.url;
    return ClipRRect(
      borderRadius: BorderRadius.circular(widget.radius),
      child: AspectRatio(
        aspectRatio: 2 / 3,
        child: url == null
            ? none
            : _network
                ? Image.network(url, headers: widget.api.authHeaders, fit: BoxFit.cover, errorBuilder: (_, _, _) => none)
                : _bytes != null
                    ? Image.memory(_bytes!, fit: BoxFit.cover, gaplessPlayback: true, errorBuilder: (_, _, _) => none)
                    : none,
      ),
    );
  }
}

/// A small mono tag, as on the sites' title pages.
class Tag extends StatelessWidget {
  const Tag(this.text, {super.key, this.color});

  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(color: color ?? Colors.white.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(5)),
        child: Text(text, style: monoLabel(color: Colors.white, size: 10)),
      );
}
