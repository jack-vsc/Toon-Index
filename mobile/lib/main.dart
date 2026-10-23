import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'library_screen.dart';
import 'pair_screen.dart';
import 'theme.dart';
import 'translate_screen.dart';

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
  final _navigator = GlobalKey<NavigatorState>();

  /// What other apps share to this one (MainActivity.kt): a chapter's link or a PDF.
  static const _share = MethodChannel('manga_index/share');

  @override
  void initState() {
    super.initState();
    Store.loadConnection().then((c) {
      setState(() => (_connection = c, _loaded = true));
      // A link or PDF shared to the app (the browser's or file manager's Share) goes to the PC to translate.
      _share.invokeMethod<Map<Object?, Object?>>('initial').then(_shared);
    });
    _share.setMethodCallHandler((call) async {
      if (call.method == 'shared') _shared(call.arguments as Map<Object?, Object?>?);
    });
  }

  void _shared(Map<Object?, Object?>? shared) {
    final connection = _connection;
    if (shared == null || connection == null) return;
    final text = shared['text'] as String?;
    final file = shared['file'] as String?;
    final screen = text != null
        ? TranslateScreen(api: Api(connection), sharedLink: text)
        : file != null
            ? TranslateScreen(api: Api(connection), sharedFile: File(file))
            : null;
    if (screen != null) _navigator.currentState?.push(MaterialPageRoute(builder: (_) => screen));
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Manga Index',
      navigatorKey: _navigator,
      debugShowCheckedModeBanner: false,
      theme: appTheme(),
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
