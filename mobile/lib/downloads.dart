import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'api.dart';

/// Translated chapters kept on the phone to read without the PC: one PDF per library chapter.
/// A chapter opened without being downloaded is fetched into the cache, which Android may clear.
class Downloads {
  /// Replaces the phone's folders in tests, which have no Android storage.
  @visibleForTesting
  static Directory? root;

  static Future<Directory> _folder(bool kept) async {
    final base = root ?? (kept ? await getApplicationDocumentsDirectory() : await getTemporaryDirectory());
    final dir = Directory('${base.path}/chapters');
    await dir.create(recursive: true);
    return dir;
  }

  static Future<File> _file(String entryId, {required bool kept}) async =>
      File('${(await _folder(kept)).path}/$entryId.pdf');

  /// Ids of the chapters downloaded.
  static Future<Set<String>> downloaded() async {
    final dir = await _folder(true);
    return {
      for (final f in dir.listSync().whereType<File>())
        if (f.path.endsWith('.pdf')) f.uri.pathSegments.last.replaceFirst(RegExp(r'\.pdf$'), ''),
    };
  }

  /// Fetches the translated PDF, reporting how much arrived (0 to 1, or null when the size is unknown).
  static Future<File> download(Api api, String entryId, {bool kept = true, void Function(double?)? onProgress}) async {
    final target = await _file(entryId, kept: kept);
    final partial = File('${target.path}.part');
    final request = http.Request('GET', Uri.parse('${api.base}/api/pdf/$entryId/translated'))..headers.addAll(api.authHeaders);
    final client = http.Client();
    try {
      final response = await client.send(request);
      if (response.statusCode == 401) throw UnpairedException('Este celular não está mais pareado com o PC.');
      if (response.statusCode != 200) throw ApiException('O PC não enviou o capítulo (erro ${response.statusCode}).');
      final total = response.contentLength;
      var received = 0;
      final sink = partial.openWrite();
      await for (final chunk in response.stream) {
        sink.add(chunk);
        received += chunk.length;
        onProgress?.call(total == null || total == 0 ? null : received / total);
      }
      await sink.close();
      // Renamed only when complete, so a cut download never looks finished.
      return await partial.rename(target.path);
    } on ApiException {
      rethrow;
    } catch (_) {
      if (await partial.exists()) await partial.delete();
      throw ApiException('Não foi possível baixar o capítulo: o PC não respondeu.');
    } finally {
      client.close();
    }
  }

  /// The chapter's PDF: the download when there is one, else fetched into the cache (needs the PC).
  static Future<File> open(Api api, String entryId, {void Function(double?)? onProgress}) async {
    final kept = await _file(entryId, kept: true);
    if (await kept.exists()) return kept;
    final cached = await _file(entryId, kept: false);
    if (await cached.exists()) return cached;
    return download(api, entryId, kept: false, onProgress: onProgress);
  }

  /// Keeps a PDF made on the phone (a chapter downloaded from its site).
  static Future<void> save(String id, List<int> pdf) async {
    final target = await _file(id, kept: true);
    final partial = File('${target.path}.part');
    await partial.writeAsBytes(pdf, flush: true);
    await partial.rename(target.path);
  }

  /// Each chapter's PDF size: the ones kept to read without internet, or the ones only cached while reading.
  static Future<Map<String, int>> sizes({required bool kept}) async {
    final dir = await _folder(kept);
    return {
      for (final f in dir.listSync().whereType<File>())
        if (f.path.endsWith('.pdf')) f.uri.pathSegments.last.replaceFirst(RegExp(r'\.pdf$'), ''): f.lengthSync(),
    };
  }

  /// The chapters cached while reading (fetched again from the PC when opened).
  static Future<void> clearCache() async {
    final dir = await _folder(false);
    if (await dir.exists()) await dir.delete(recursive: true);
  }

  static Future<void> remove(String entryId) async {
    final file = await _file(entryId, kept: true);
    if (await file.exists()) await file.delete();
  }
}
