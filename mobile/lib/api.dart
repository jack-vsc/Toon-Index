import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'local_data.dart';
import 'models.dart';

/// Where the PC app is and the token this phone got when it paired. The PC has several addresses
/// (home Wi-Fi, Tailscale); the one that answered last is tried first.
class Connection {
  Connection({required this.hosts, required this.port, required this.token, this.lastHost});

  /// Not paired with any PC: the app works on its own data.
  Connection.none() : this(hosts: const [], port: 0, token: '');

  final List<String> hosts;
  final int port;
  final String token;
  String? lastHost;

  List<String> get ordered => [?lastHost, ...hosts.where((h) => h != lastHost)];

  Map<String, dynamic> toJson() => {'hosts': hosts, 'port': port, 'token': token, 'lastHost': lastHost};

  factory Connection.fromJson(Map<String, dynamic> j) => Connection(
        hosts: (j['hosts'] as List).cast<String>(),
        port: (j['port'] as num).toInt(),
        token: j['token'] as String,
        lastHost: j['lastHost'] as String?,
      );
}

/// What the QR code on the PC holds.
class PairingInfo {
  PairingInfo({required this.hosts, required this.port, required this.code});

  final List<String> hosts;
  final int port;
  final String code;

  /// Null when the text is not a Manga Index pairing code.
  static PairingInfo? parse(String text) {
    try {
      final j = jsonDecode(text) as Map<String, dynamic>;
      if (j['app'] != 'manga-index') return null;
      return PairingInfo(hosts: (j['hosts'] as List).cast<String>(), port: (j['port'] as num).toInt(), code: j['code'] as String);
    } catch (_) {
      return null;
    }
  }
}

class ApiException implements Exception {
  ApiException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// The PC answered, but this phone is no longer paired with it.
class UnpairedException extends ApiException {
  UnpairedException(super.message);
}

const _timeout = Duration(seconds: 4);

class Api {
  Api(this.connection);

  final Connection connection;

  /// Paired with a PC (else everything stays on the phone).
  bool get paired => connection.hosts.isNotEmpty;

  /// The address that answered last, for covers and PDFs.
  String get base => 'http://${connection.ordered.first}:${connection.port}';

  Map<String, String> get authHeaders => {'Authorization': 'Bearer ${connection.token}'};

  /// Sends the request to each address in turn until one answers.
  Future<http.Response> _send(Future<http.Response> Function(Uri Function(String path) url) request, {Duration timeout = _timeout}) async {
    for (final host in connection.ordered) {
      try {
        final response = await request((path) => Uri.parse('http://$host:${connection.port}$path')).timeout(timeout);
        if (connection.lastHost != host) {
          connection.lastHost = host;
          await Store.saveConnection(connection);
        }
        if (response.statusCode == 401) throw UnpairedException(_error(response));
        if (response.statusCode != 200) throw ApiException(_error(response));
        return response;
      } on ApiException {
        rethrow;
      } catch (_) {
        // Not reachable at this address; try the next one.
      }
    }
    throw ApiException(paired
        ? 'Não foi possível falar com o PC. Ele está ligado, com o Manga Index aberto? Fora de casa, o Tailscale precisa estar ativo.'
        : 'Este celular não está conectado a um PC. Conecte pelo menu ⋮ para traduzir.');
  }

  /// Syncs with the PC: what changed here goes first, then the PC's library (merged with it)
  /// becomes the phone's copy. Without the PC, the phone's copy.
  Future<Library> library() async {
    if (!paired) return LocalData.library();
    await flushPending();
    final response = await _send((url) => http.get(url('/api/library'), headers: authHeaders));
    // The PC sends UTF-8 without saying so; response.body would read it as Latin-1.
    await LocalData.replace(utf8.decode(response.bodyBytes));
    return LocalData.library();
  }

  /// "Read up to chapter N", set by hand: on the phone at once, on the PC now or once it answers.
  Future<void> markRead(String workId, double chapter) async {
    final at = DateTime.now().millisecondsSinceEpoch;
    await LocalData.applyMark(workId, chapter, at);
    await _queueMark({'kind': 'mark', 'workId': workId, 'name': await LocalData.nameOf(workId), 'chapter': chapter, 'at': at});
  }

  Future<void> forget(String workId, double? chapter) async {
    await LocalData.applyForget(workId, chapter);
    await _queueMark({
      'kind': 'forget',
      'workId': workId,
      'name': await LocalData.nameOf(workId),
      'chapter': chapter,
      'at': DateTime.now().millisecondsSinceEpoch,
    });
  }

  Future<void> _queueMark(Map<String, dynamic> mark) async {
    await Store.addPending(mark, Store.pendingMarks, 'at');
    await _flushQuietly();
  }

  Future<void> _flushQuietly() async {
    if (!paired) return;
    try {
      await flushPending();
    } on ApiException {
      // Stays queued.
    }
  }

  /// A backup file (this phone's, another's or the PC's) merged into the phone's data and sent to the PC.
  Future<(int, int)> importData(Map<String, dynamic> file) async {
    final counts = await LocalData.merge(file);
    await Store.addPending({'works': file['works'], 'reading': file['reading'], 'at': DateTime.now().millisecondsSinceEpoch},
        Store.pendingMerges, 'at');
    await _flushQuietly();
    return counts;
  }

  /// The chapters asked of the PC, newest first.
  Future<List<RemoteJob>> jobs() async {
    final response = await _send((url) => http.get(url('/api/translate'), headers: authHeaders));
    final list = (jsonDecode(utf8.decode(response.bodyBytes)) as List).map((j) => RemoteJob.fromJson(j as Map<String, dynamic>)).toList();
    return list..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  }

  /// Asks the PC to translate the chapter at a site's link.
  Future<void> translateLink(String link) => _post('/api/translate', {'url': link});

  /// Sends a PDF for the PC to translate, streamed (a chapter's scans can be large).
  Future<void> translatePdf(String name, Stream<List<int>> bytes, int? length) async {
    // Streams can be read once, so this goes only to the address that answered last.
    final request = http.StreamedRequest('POST', Uri.parse('$base/api/translate/pdf?name=${Uri.encodeQueryComponent(name)}'))
      ..headers.addAll(authHeaders)
      ..headers['Content-Type'] = 'application/pdf';
    if (length != null) request.contentLength = length;
    bytes.listen(request.sink.add, onDone: request.sink.close, onError: request.sink.addError);
    final http.StreamedResponse streamed;
    try {
      streamed = await request.send();
    } catch (_) {
      throw ApiException('Não foi possível enviar o PDF: o PC não respondeu.');
    }
    final response = await http.Response.fromStream(streamed);
    if (response.statusCode == 401) throw UnpairedException(_error(response));
    if (response.statusCode != 200) throw ApiException(_error(response));
  }

  /// The work looked up on the PC's catalog sites (MangaDex, mgeko), with covers to choose from.
  Future<List<CatalogResult>> searchSites(String query) async {
    final response = await _postFor('/api/works/search', {'query': query}, const Duration(seconds: 60));
    return (jsonDecode(utf8.decode(response.bodyBytes)) as List).map((r) => CatalogResult.fromJson(r as Map<String, dynamic>)).toList();
  }

  /// Every chapter of the work on that site (`site` 'link' for a work's page on any site), in order.
  /// Long lists come a page at a time, so this can take a few minutes.
  Future<List<SiteChapterLink>> chapterList(String site, String url) async {
    final response = await _postFor('/api/works/chapters', {'site': site, 'url': url}, const Duration(minutes: 6));
    return (jsonDecode(utf8.decode(response.bodyBytes)) as List).map((c) => SiteChapterLink.fromJson(c as Map<String, dynamic>)).toList();
  }

  /// A range of chapters for the PC to translate (or download as they are) one at a time.
  Future<void> queueBatch({required String work, required String site, required List<SiteChapterLink> chapters, required bool download, String? source}) =>
      _post('/api/batch', {
        'work': work,
        'site': site,
        'chapters': [for (final c in chapters) {'chapter': c.chapter, 'url': c.url}],
        'download': download,
        'source': ?source,
      });

  Future<void> cancelJob(String id) => _post('/api/translate/cancel', {'id': id});

  /// Asks the PC to download a chapter already in Portuguese into its library, as it is.
  Future<void> downloadOnPc(String url, {required String work, required double chapter, required String site}) =>
      _post('/api/download', {'url': url, 'work': work, 'chapter': chapter, 'site': site});

  /// How far into a library chapter the phone's reader got (1: to the end). Kept on the phone when
  /// the PC cannot be reached, and sent with the next request that gets through.
  Future<void> reportAppReading(String entryId, double progress) async {
    final at = DateTime.now().millisecondsSinceEpoch;
    await LocalData.applyAppReading(entryId, progress, at);
    await Store.addPending({'entryId': entryId, 'progress': progress, 'at': at});
    await _flushQuietly();
  }

  /// Puts a work on a reading list (null: none) and among the favorites or not, now or once the PC
  /// can be reached.
  Future<void> setShelf(String workId, {required String? shelf, required bool favorite}) async {
    await LocalData.applyShelf(workId, shelf, favorite);
    await Store.addPending(
        {'workId': workId, 'name': await LocalData.nameOf(workId), 'shelf': shelf, 'favorite': favorite, 'at': DateTime.now().millisecondsSinceEpoch},
        Store.pendingShelves,
        'workId');
    await _flushQuietly();
  }

  Future<void> flushPending() async {
    if (!paired) return;
    // Imported files first: the works they bring are the ones the rest may name.
    final merges = await Store.loadPending(Store.pendingMerges);
    for (final m in merges) {
      await _post('/api/merge', {'works': m['works'], 'reading': m['reading']});
    }
    if (merges.isNotEmpty) await Store.removePending(merges, Store.pendingMerges);
    final shelves = await Store.loadPending(Store.pendingShelves);
    for (final s in shelves) {
      await _post('/api/works/shelf', s);
    }
    if (shelves.isNotEmpty) await Store.removePending(shelves, Store.pendingShelves);
    final pending = await Store.loadPending();
    if (pending.isNotEmpty) {
      await _post('/api/reading/app', pending);
      await Store.removePending(pending);
    }
    final reports = await Store.loadPending(Store.pendingReports);
    if (reports.isNotEmpty) {
      await _post('/api/reading', reports);
      await Store.removePending(reports, Store.pendingReports);
    }
    // After the readings: a chapter forgotten here must not come back with one sent above.
    final marks = await Store.loadPending(Store.pendingMarks);
    for (final m in marks) {
      await _post(m['kind'] == 'forget' ? '/api/reading/forget' : '/api/reading/mark', m);
    }
    if (marks.isNotEmpty) await Store.removePending(marks, Store.pendingMarks);
  }

  /// A chapter page read in the app's browser (what the PC's extension sends): the PC answers with
  /// the work and whether the chapter counts as read. Null when the PC could not be reached (the
  /// report waits on the phone) or the page is not a chapter.
  Future<Map<String, dynamic>?> reportBrowserReading(Map<String, dynamic> report) async {
    // Counted on the phone at once; what the PC says replaces it when it answers.
    final local = await LocalData.applyReport(report);
    if (!paired) return local == null ? null : {...local, 'offline': true};
    try {
      final response = await _send((url) => http.post(url('/api/reading'),
          headers: {...authHeaders, 'Content-Type': 'application/json'}, body: jsonEncode(report)));
      unawaited(flushPending().catchError((_) {}));
      final body = jsonDecode(utf8.decode(response.bodyBytes));
      return body is Map<String, dynamic> ? body : null;
    } on UnpairedException {
      rethrow;
    } on ApiException {
      await Store.addPending(report, Store.pendingReports, 'url');
      return local == null ? null : {...local, 'offline': true};
    }
  }

  Future<void> _post(String path, Object body) => _postFor(path, body, _timeout);

  Future<http.Response> _postFor(String path, Object body, Duration timeout) =>
      _send((url) => http.post(url(path), headers: {...authHeaders, 'Content-Type': 'application/json'}, body: jsonEncode(body)), timeout: timeout);

  /// Trades the code shown on the PC for this phone's token.
  static Future<Connection> pair(PairingInfo info, String deviceName) async {
    String? lastError;
    for (final host in info.hosts) {
      try {
        final response = await http
            .post(Uri.parse('http://$host:${info.port}/api/pair'),
                headers: {'Content-Type': 'application/json'}, body: jsonEncode({'code': info.code, 'name': deviceName}))
            .timeout(_timeout);
        if (response.statusCode != 200) {
          lastError = _error(response);
          // The PC answered: the code itself is wrong, other addresses would say the same.
          break;
        }
        final token = (jsonDecode(response.body) as Map<String, dynamic>)['token'] as String;
        final connection = Connection(hosts: info.hosts, port: info.port, token: token, lastHost: host);
        await Store.saveConnection(connection);
        return connection;
      } on TimeoutException {
        continue;
      } catch (_) {
        continue;
      }
    }
    throw ApiException(lastError ?? 'O PC não respondeu. Celular e PC estão no mesmo Wi-Fi (ou no Tailscale)?');
  }

  static String _error(http.Response response) {
    try {
      return (jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>)['error'] as String;
    } catch (_) {
      return 'Erro ${response.statusCode} do PC.';
    }
  }
}

/// What the app keeps on the phone: the connection and the last library seen (shown while offline).
class Store {
  static const _connection = 'connection';
  static const _library = 'library';
  static const _pending = 'pending';
  static const pendingReports = 'pendingReports';

  static Future<Connection?> loadConnection() async {
    final text = (await SharedPreferences.getInstance()).getString(_connection);
    return text == null ? null : Connection.fromJson(jsonDecode(text) as Map<String, dynamic>);
  }

  static Future<void> saveConnection(Connection connection) async =>
      (await SharedPreferences.getInstance()).setString(_connection, jsonEncode(connection.toJson()));

  static Future<void> forgetConnection() async {
    final prefs = await SharedPreferences.getInstance();
    // The phone's data stays: the app goes on without the PC.
    await prefs.remove(_connection);
  }

  static Future<Library?> loadLibrary() async {
    final text = (await SharedPreferences.getInstance()).getString(_library);
    return text == null ? null : Library.fromJson(jsonDecode(text) as Map<String, dynamic>);
  }

  static Future<void> saveLibrary(String json) async => (await SharedPreferences.getInstance()).setString(_library, json);

  /// Readings not yet sent to the PC, oldest first: chapters of the library read in the reader
  /// (the default list), or pages of sites read in the browser ([pendingReports]).
  static Future<List<Map<String, dynamic>>> loadPending([String list = _pending]) async {
    final text = (await SharedPreferences.getInstance()).getString(list);
    return text == null ? [] : (jsonDecode(text) as List).cast<Map<String, dynamic>>();
  }

  /// Keeps a reading to send later; an older one of the same chapter (same `key`) is replaced.
  static Future<void> addPending(Map<String, dynamic> reading, [String list = _pending, String key = 'entryId']) async {
    final pending = await loadPending(list);
    pending.removeWhere((r) => r[key] == reading[key] && (r['at'] as num) <= (reading['at'] as num));
    pending.add(reading);
    // A long time away from the PC must not fill the phone.
    final kept = pending.length > 1000 ? pending.sublist(pending.length - 1000) : pending;
    await (await SharedPreferences.getInstance()).setString(list, jsonEncode(kept));
  }

  /// Drops the readings just sent; ones added meanwhile stay.
  static Future<void> removePending(List<Map<String, dynamic>> sent, [String list = _pending]) async {
    bool wasSent(Map<String, dynamic> r) => sent.any((s) => s['at'] == r['at'] && s['entryId'] == r['entryId'] && s['url'] == r['url']);
    final pending = (await loadPending(list)).where((r) => !wasSent(r)).toList();
    await (await SharedPreferences.getInstance()).setString(list, jsonEncode(pending));
  }

  /// Where a chapter was left in the phone's reader: the band of a page on screen (0-based).
  static Future<int> loadBand(String entryId) async => (await SharedPreferences.getInstance()).getInt('band:$entryId') ?? 0;

  static Future<void> saveBand(String entryId, int band) async =>
      (await SharedPreferences.getInstance()).setInt('band:$entryId', band);

  static const pendingShelves = 'pendingShelves';

  /// Chapters marked read or forgotten by hand.
  static const pendingMarks = 'pendingMarks';

  /// Backup files imported on the phone, for the PC to merge too.
  static const pendingMerges = 'pendingMerges';
}
