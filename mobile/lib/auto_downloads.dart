import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'downloads.dart';
import 'models.dart';

/// At home (the PC reached on Wi-Fi), the next translated chapters of the works being read are kept on
/// the phone on their own, so away from home there is something to read without the PC.
class AutoDownloads {
  static const _key = 'download.autoAhead';
  static const _app = MethodChannel('manga_index/app');
  static bool _running = false;

  /// How many chapters past the last one read are kept per work; 0 turns it off.
  static Future<int> ahead() async => (await SharedPreferences.getInstance()).getInt(_key) ?? 5;

  static Future<void> setAhead(int count) async => (await SharedPreferences.getInstance()).setInt(_key, count);

  /// Downloads what is missing, one chapter at a time, quietly; stops at the first the PC does not send.
  static Future<void> run(Api api, Library library) async {
    if (_running || !api.paired) return;
    final count = await ahead();
    if (count == 0) return;
    final network = await _app.invokeMethod<String>('network').catchError((_) => 'unknown');
    if (network != 'wifi') return;
    _running = true;
    try {
      final kept = await Downloads.downloaded();
      for (final view in library.views) {
        if (view.records.isEmpty && view.work.shelf != 'reading') continue;
        final upTo = view.readUpTo ?? 0;
        final next = view.readable.where((c) => c.chapter != null && c.chapter! > upTo).take(count);
        for (final c in next.where((c) => !kept.contains(c.id))) {
          await Downloads.download(api, c.id);
        }
      }
    } on ApiException {
      // The PC went out of reach; the rest waits for the next time.
    } finally {
      _running = false;
    }
  }
}
