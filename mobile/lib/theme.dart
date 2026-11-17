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
const lineColor = Color(0xFF33333A);

ThemeData appTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: accent, brightness: Brightness.dark, primary: accent, surface: panel);
  return ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: background,
    appBarTheme: const AppBarTheme(backgroundColor: background, scrolledUnderElevation: 0),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: panel,
      indicatorColor: accent.withValues(alpha: 0.18),
      labelTextStyle: WidgetStateProperty.all(const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
    ),
    // Round fields and buttons, as on the scans' pages.
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: panel,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(99), borderSide: const BorderSide(color: lineColor)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(99), borderSide: const BorderSide(color: lineColor)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(99), borderSide: const BorderSide(color: accent, width: 1.5)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    ),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(shape: const StadiumBorder())),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(shape: const StadiumBorder(), side: const BorderSide(color: lineColor))),
    useMaterial3: true,
  );
}

/// "CAP. 90 · MGREAD.IO": small spaced capitals for labels.
TextStyle monoLabel({Color color = muted, double size = 11}) => TextStyle(fontSize: size, letterSpacing: 0.8, color: color, fontWeight: FontWeight.w700);

/// The work's own cover (found on MangaDex or mgeko), or its latest translated chapter's.
String? coverUrlOf(WorkView view, Api api) {
  if (view.work.hasCover) return '${api.base}/api/work-cover/${view.work.id}';
  final chapter = view.translated.where((c) => c.hasCover).lastOrNull;
  return chapter != null ? '${api.base}/api/cover/${chapter.id}' : null;
}

/// A cover at 2:3, or a book where there is none. Kept on the phone once seen, so the library looks
/// the same away from the PC; looked up again after a week (a work's cover can change).
class CoverImage extends StatefulWidget {
  const CoverImage({super.key, required this.url, required this.api, this.radius = 8, this.title, this.fill = false});

  final String? url;
  final Api api;
  final double radius;

  /// Shown on the empty cover of a work none of the sites had a picture for.
  final String? title;

  /// Fills the box it is in (a background) instead of standing at 2:3.
  final bool fill;

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
    final title = widget.title;
    final none = ColoredBox(
      color: Colors.white.withValues(alpha: 0.06),
      child: Center(
        child: title == null
            ? const Text('📚', style: TextStyle(fontSize: 28))
            : Padding(
                padding: const EdgeInsets.all(10),
                child: Text(title, textAlign: TextAlign.center, maxLines: 5, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontWeight: FontWeight.w700, fontSize: 13)),
              ),
      ),
    );
    final url = widget.url;
    final picture = url == null
        ? none
        : _network
            ? Image.network(url, headers: widget.api.authHeaders, fit: BoxFit.cover, errorBuilder: (_, _, _) => none)
            : _bytes != null
                ? Image.memory(_bytes!, fit: BoxFit.cover, gaplessPlayback: true, errorBuilder: (_, _, _) => none)
                : none;
    if (widget.fill) return url == null ? const SizedBox() : SizedBox.expand(child: picture);
    return ClipRRect(
      borderRadius: BorderRadius.circular(widget.radius),
      child: AspectRatio(aspectRatio: 2 / 3, child: picture),
    );
  }
}

/// A small round tag, as on the scans' title pages.
class Tag extends StatelessWidget {
  const Tag(this.text, {super.key, this.color, this.textColor});

  final String text;
  final Color? color;
  final Color? textColor;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(color: color ?? Colors.white.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(99)),
        child: Text(text, style: TextStyle(color: textColor ?? Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
      );
}

/// A list to pick, with how many it holds: "Lendo 10".
class Pill extends StatelessWidget {
  const Pill({super.key, required this.label, required this.selected, required this.onTap, this.count});

  final String label;
  final int? count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(99),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? Colors.white.withValues(alpha: 0.12) : Colors.transparent,
            borderRadius: BorderRadius.circular(99),
            border: Border.all(color: selected ? Colors.transparent : lineColor),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(label, style: TextStyle(fontSize: 13, fontWeight: selected ? FontWeight.w700 : FontWeight.w500)),
            if (count != null && count! > 0) ...[const SizedBox(width: 6), Text('$count', style: const TextStyle(fontSize: 12, color: muted))],
          ]),
        ),
      );
}

/// Tabs underlined in orange when picked ("Tudo · Mangá · Novel").
class UnderlineTabs extends StatelessWidget {
  const UnderlineTabs({super.key, required this.tabs, required this.selected, required this.onSelected});

  final Map<String, String> tabs;
  final String selected;
  final void Function(String key) onSelected;

  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: lineColor))),
        child: Row(children: [
          for (final t in tabs.entries)
            InkWell(
              onTap: () => onSelected(t.key),
              child: Container(
                margin: const EdgeInsets.only(right: 18),
                padding: const EdgeInsets.symmetric(vertical: 9),
                decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.key == selected ? accent : Colors.transparent, width: 2))),
                child: Text(t.value, style: TextStyle(fontSize: 13, color: t.key == selected ? Colors.white : muted, fontWeight: FontWeight.w600)),
              ),
            ),
        ]),
      );
}

/// How far a work was read: a thin orange bar.
class ProgressBar extends StatelessWidget {
  const ProgressBar(this.share, {super.key, this.height = 4});

  final double share;
  final double height;

  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(height),
        child: LinearProgressIndicator(value: share, minHeight: height, color: accent, backgroundColor: Colors.white.withValues(alpha: 0.08)),
      );
}
