import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

/// Where the PC app is and the token this phone got when it paired. The PC has several addresses
/// (home Wi-Fi, Tailscale); the one that answered last is tried first.
class Connection {
  Connection({required this.hosts, required this.port, required this.token, this.lastHost});

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

  /// The address that answered last, for covers and PDFs.
  String get base => 'http://${connection.ordered.first}:${connection.port}';

  Map<String, String> get authHeaders => {'Authorization': 'Bearer ${connection.token}'};

  /// Sends the request to each address in turn until one answers.
  Future<http.Response> _send(Future<http.Response> Function(Uri Function(String path) url) request) async {
    for (final host in connection.ordered) {
      try {
        final response = await request((path) => Uri.parse('http://$host:${connection.port}$path')).timeout(_timeout);
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
    throw ApiException('Não foi possível falar com o PC. Ele está ligado, com o Manga Index aberto? Fora de casa, o Tailscale precisa estar ativo.');
  }

  Future<Library> library() async {
    final response = await _send((url) => http.get(url('/api/library'), headers: authHeaders));
    // The PC sends UTF-8 without saying so; response.body would read it as Latin-1.
    final text = utf8.decode(response.bodyBytes);
    await Store.saveLibrary(text);
    return Library.fromJson(jsonDecode(text) as Map<String, dynamic>);
  }

  Future<void> markRead(String workId, double chapter) =>
      _post('/api/reading/mark', {'workId': workId, 'chapter': chapter});

  Future<void> forget(String workId, double? chapter) =>
      _post('/api/reading/forget', {'workId': workId, 'chapter': chapter});

  Future<void> _post(String path, Object body) =>
      _send((url) => http.post(url(path), headers: {...authHeaders, 'Content-Type': 'application/json'}, body: jsonEncode(body)));

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

  static Future<Connection?> loadConnection() async {
    final text = (await SharedPreferences.getInstance()).getString(_connection);
    return text == null ? null : Connection.fromJson(jsonDecode(text) as Map<String, dynamic>);
  }

  static Future<void> saveConnection(Connection connection) async =>
      (await SharedPreferences.getInstance()).setString(_connection, jsonEncode(connection.toJson()));

  static Future<void> forgetConnection() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_connection);
    await prefs.remove(_library);
  }

  static Future<Library?> loadLibrary() async {
    final text = (await SharedPreferences.getInstance()).getString(_library);
    return text == null ? null : Library.fromJson(jsonDecode(text) as Map<String, dynamic>);
  }

  static Future<void> saveLibrary(String json) async => (await SharedPreferences.getInstance()).setString(_library, json);
}
