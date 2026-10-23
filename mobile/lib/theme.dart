import 'package:flutter/material.dart';

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

/// A cover at 2:3, or a book where there is none.
class CoverImage extends StatelessWidget {
  const CoverImage({super.key, required this.url, required this.api, this.radius = 8});

  final String? url;
  final Api api;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final none = ColoredBox(color: Theme.of(context).colorScheme.surfaceContainerHighest, child: const Center(child: Text('📚', style: TextStyle(fontSize: 28))));
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: AspectRatio(
        aspectRatio: 2 / 3,
        child: url == null ? none : Image.network(url!, headers: api.authHeaders, fit: BoxFit.cover, errorBuilder: (_, _, _) => none),
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
