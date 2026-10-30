import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

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

  /// The one found on the network when the PC's address changed comes first.
  List<String> hosts;
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

  /// Sends the request to each address in turn until one answers; when none does, looks for the PC
  /// on the phone's Wi-Fi (the router may have given it another address) and asks it there.
  Future<http.Response> _send(Future<http.Response> Function(Uri Function(String path) url) request, {Duration timeout = _timeout}) async {
    Future<http.Response?> at(String host) async {
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
        // Not reachable at this address.
        return null;
      }
    }

    for (final host in connection.ordered) {
      final response = await at(host);
      if (response != null) return response;
    }
    if (paired) {
      final found = await _findPc();
      if (found != null) {
        connection.hosts = [found, ...connection.hosts.where((h) => h != found)];
        final response = await at(found);
        if (response != null) return response;
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

  /// Chapters marked read by hand (one, or a run of them): on the phone at once, on the PC now or once it answers.
  Future<void> markRead(String workId, List<double> chapters) async {
    if (chapters.isEmpty) return;
    final at = DateTime.now().millisecondsSinceEpoch;
    await LocalData.applyMark(workId, chapters, at);
    await _queueMark({'kind': 'mark', 'workId': workId, 'name': await LocalData.nameOf(workId), 'chapter': chapters.first, 'chapters': chapters, 'at': at});
  }

  /// Chapters marked unread, or the whole work's reading forgotten when [chapters] is null.
  Future<void> forget(String workId, List<double>? chapters) async {
    await LocalData.applyForget(workId, chapters);
    await _queueMark({
      'kind': 'forget',
      'workId': workId,
      'name': await LocalData.nameOf(workId),
      'chapter': chapters?.first,
      'chapters': ?chapters,
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

  /// The PC's queue in the order it will run, and whether it is paused.
  Future<({List<RemoteJob> jobs, bool paused})> queue() async {
    final response = await _send((url) => http.get(url('/api/queue'), headers: authHeaders));
    final body = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    return (jobs: (body['jobs'] as List).map((j) => RemoteJob.fromJson(j as Map<String, dynamic>)).toList(), paused: body['paused'] == true);
  }

  /// The queued requests run in this order.
  Future<void> reorderQueue(List<String> ids) => _post('/api/queue/reorder', {'ids': ids});

  /// Every work's queued chapters back in the order of their numbers.
  Future<void> sortQueue() => _post('/api/queue/sort', {});

  /// The chapters that failed (these, or all of the ranges') go back to the queue.
  Future<void> retryQueue([List<String>? ids]) => _post('/api/queue/retry', {'ids': ?ids});

  Future<void> pauseQueue(bool paused) => _post('/api/queue/pause', {'paused': paused});

  /// The PC checks the works' sites for new chapters now, instead of at its next round.
  Future<void> checkUpdates() => _post('/api/updates/check', {});

  /// The PC's translation settings: its defaults, its APIs and languages, to choose a request's options from.
  Future<PcTranslateSettings> translateSettings() async {
    final response = await _send((url) => http.get(url('/api/translate/options'), headers: authHeaders));
    return PcTranslateSettings.fromJson(jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>);
  }

  /// Makes these the PC's defaults for everything it translates.
  Future<void> saveTranslateDefaults(Map<String, dynamic> options) => _post('/api/translate/options', {'options': options});

  /// Every chapter waiting in the PC's queue translated with these options (null: with the PC's settings).
  Future<void> setQueueOptions(Map<String, dynamic>? options) => _post('/api/queue/options', {'options': options});

  /// Asks the PC to translate the chapter at a site's link (with options of its own, or the PC's).
  Future<void> translateLink(String link, {Map<String, dynamic>? options}) => _post('/api/translate', {'url': link, 'options': ?options});

  /// Sends a PDF for the PC to translate, streamed (a chapter's scans can be large).
  Future<void> translatePdf(String name, Stream<List<int>> bytes, int? length, {Map<String, dynamic>? options}) async {
    final query = 'name=${Uri.encodeQueryComponent(name)}${options != null ? '&options=${Uri.encodeQueryComponent(jsonEncode(options))}' : ''}';
    // Streams can be read once, so this goes only to the address that answered last.
    final request = http.StreamedRequest('POST', Uri.parse('$base/api/translate/pdf?$query'))
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

  /// Every chapter of the work on that site (`site` 'link' for a work's page on any site), in order, and
  /// the work's name as its page gives it. Long lists come a page at a time, so this can take a few minutes.
  Future<({String? title, List<SiteChapterLink> chapters})> chapterList(String site, String url) async {
    final response = await _postFor('/api/works/chapters', {'site': site, 'url': url, 'withTitle': true}, const Duration(minutes: 6));
    final body = jsonDecode(utf8.decode(response.bodyBytes));
    // A PC from before the name came along sends the list alone.
    final list = body is Map ? body['chapters'] as List : body as List;
    return (
      title: body is Map ? body['title'] as String? : null,
      chapters: list.map((c) => SiteChapterLink.fromJson(c as Map<String, dynamic>)).toList(),
    );
  }

  /// A range of chapters for the PC to translate (or download as they are) one at a time.
  Future<void> queueBatch({
    required String work,
    required String site,
    required List<SiteChapterLink> chapters,
    required bool download,
    String? source,
    Map<String, dynamic>? options,
  }) =>
      _post('/api/batch', {
        'work': work,
        'site': site,
        'chapters': [for (final c in chapters) {'chapter': c.chapter, 'url': c.url}],
        'download': download,
        'source': ?source,
        'options': ?options,
      });

  Future<void> cancelJob(String id) => _post('/api/translate/cancel', {'id': id});

  /// Deletes one version of a chapter from the PC's library.
  Future<void> deleteChapter(String id) => _post('/api/library/delete', {'id': id});

  /// A chapter that failed goes back to the PC's queue, before the later chapters of its work.
  Future<void> retryJob(String id) => _post('/api/translate/retry', {'id': id});

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

  /// One search at a time, shared by the requests waiting on it, and not again right after one found nothing.
  static Future<String?>? _finding;
  static DateTime? _lastSearch;

  Future<String?> _findPc() {
    final last = _lastSearch;
    if (_finding == null && last != null && DateTime.now().difference(last) < const Duration(seconds: 30)) return Future.value(null);
    return _finding ??= _searchNetwork().whenComplete(() => (_finding = null, _lastSearch = DateTime.now()));
  }

  /// The PC on the phone's home network: every address of it with the app's port open, asked whether
  /// this phone is paired there (another PC with the app, or anything else on that port, is not it).
  Future<String?> _searchNetwork() async {
    final networks = <String>{};
    try {
      for (final interface in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
        for (final a in interface.addresses) {
          final p = a.address.split('.').map(int.parse).toList();
          if ((p[0] == 192 && p[1] == 168) || p[0] == 10 || (p[0] == 172 && p[1] >= 16 && p[1] < 32)) networks.add('${p[0]}.${p[1]}.${p[2]}');
        }
      }
    } catch (_) {
      return null;
    }
    for (final network in networks) {
      final candidates = [for (var n = 1; n < 255; n++) '$network.$n'].where((h) => !connection.hosts.contains(h)).toList();
      // A few dozen at a time: the whole network in a few seconds.
      for (var i = 0; i < candidates.length; i += 64) {
        final batch = candidates.sublist(i, min(i + 64, candidates.length));
        final open = await Future.wait(batch.map(_portOpen));
        for (var k = 0; k < batch.length; k++) {
          if (open[k] && await _pairedAt(batch[k])) return batch[k];
        }
      }
    }
    return null;
  }

  Future<bool> _portOpen(String host) async {
    try {
      final socket = await Socket.connect(host, connection.port, timeout: const Duration(milliseconds: 600));
      socket.destroy();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<bool> _pairedAt(String host) async {
    try {
      final response = await http.get(Uri.parse('http://$host:${connection.port}/api/status'), headers: authHeaders).timeout(_timeout);
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// How much of its disk the PC app takes (each work's chapters, the translation layers, caches).
  Future<Map<String, dynamic>> pcStorage() async {
    final response = await _send((url) => http.get(url('/api/storage'), headers: authHeaders), timeout: const Duration(seconds: 30));
    return jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
  }

  /// Clears on the PC what is made again when needed ('layers', 'aiCache' or 'appCache').
  Future<Map<String, dynamic>> clearPcStorage(String area) async =>
      jsonDecode(utf8.decode((await _postFor('/api/storage/clear', {'area': area}, const Duration(seconds: 60))).bodyBytes)) as Map<String, dynamic>;

  /// Deletes every chapter of a work on the PC (its readings and translation layers stay).
  Future<Map<String, dynamic>> deletePcWork(String workId) async =>
      jsonDecode(utf8.decode((await _postFor('/api/storage/work', {'workId': workId}, const Duration(seconds: 60))).bodyBytes)) as Map<String, dynamic>;

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
