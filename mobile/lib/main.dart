import 'package:flutter/material.dart';

import 'api.dart';
import 'library_screen.dart';
import 'pair_screen.dart';

void main() => runApp(const MangaIndexApp());

/// The phone side of Manga Index: the library and where each work was left, kept in sync with the
/// PC app it is paired with.
class MangaIndexApp extends StatefulWidget {
  const MangaIndexApp({super.key});

  @override
  State<MangaIndexApp> createState() => _MangaIndexAppState();
}

class _MangaIndexAppState extends State<MangaIndexApp> {
  Connection? _connection;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    Store.loadConnection().then((c) => setState(() => (_connection = c, _loaded = true)));
  }

  @override
  Widget build(BuildContext context) {
    // The PC app's colors.
    final scheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFFFF5D73),
      brightness: Brightness.dark,
      surface: const Color(0xFF1D1F26),
    );
    return MaterialApp(
      title: 'Manga Index',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorScheme: scheme, scaffoldBackgroundColor: const Color(0xFF14151A), useMaterial3: true),
      home: !_loaded
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : _connection == null
              ? PairScreen(onPaired: (c) => setState(() => _connection = c))
              : LibraryScreen(
                  key: ValueKey(_connection!.token),
                  api: Api(_connection!),
                  onUnpaired: () => setState(() => _connection = null),
                ),
    );
  }
}
