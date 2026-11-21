import 'dart:async';
import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// The sync over the internet through the person's own Firebase project (the PC's cloud.ts), for when
/// the PC is not on the same network. Only information goes there, never PDFs or images:
/// - a request the phone would make to the PC is left as a document; the PC runs it and writes the
///   answer back (or later, when it comes on);
/// - the PC keeps its library and queue there, read when it does not answer.
/// The PC hands out the project's settings when the phone pairs (or syncs) at home, and adds this
/// phone's anonymous account to the space only it and its phones can read.
class Cloud {
  static const _key = 'cloud';
  static Map<String, dynamic>? _info;
  static Future<bool>? _starting;

  /// What the PC handed out ({web, androidAppId, spaceId}); null turns it off here.
  static Future<void> save(Map<String, dynamic>? info) async {
    final prefs = await SharedPreferences.getInstance();
    if (info == null) {
      await prefs.remove(_key);
    } else {
      await prefs.setString(_key, jsonEncode(info));
    }
    _info = info;
  }

  static Future<Map<String, dynamic>?> _load() async {
    if (_info != null) return _info;
    final text = (await SharedPreferences.getInstance()).getString(_key);
    return _info = text == null ? null : jsonDecode(text) as Map<String, dynamic>;
  }

  /// Signed in to the project (anonymously, the account kept by Android); false when it is off.
  static Future<bool> ready() => _starting ??= _start().then((ok) {
        if (!ok) _starting = null;
        return ok;
      });

  static Future<bool> _start() async {
    final info = await _load();
    if (info == null) return false;
    final web = info['web'] as Map<String, dynamic>;
    try {
      if (Firebase.apps.isEmpty) {
        try {
          await Firebase.initializeApp(
            options: FirebaseOptions(
              apiKey: web['apiKey'] as String,
              appId: info['androidAppId'] as String,
              messagingSenderId: web['messagingSenderId'] as String,
              projectId: web['projectId'] as String,
              storageBucket: web['storageBucket'] as String?,
            ),
          );
        } on FirebaseException catch (e) {
          // Already started by Android (App.kt) with the same project.
          if (e.code != 'duplicate-app') rethrow;
        }
      }
      if (FirebaseAuth.instance.currentUser == null) await FirebaseAuth.instance.signInAnonymously().timeout(const Duration(seconds: 15));
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<String?> uid() async => await ready() ? FirebaseAuth.instance.currentUser?.uid : null;

  static Future<String?> spaceId() async => (await _load())?['spaceId'] as String?;

  static Future<DocumentReference<Map<String, dynamic>>> _space() async =>
      FirebaseFirestore.instance.collection('spaces').doc(await spaceId());

  /// A request to the PC through the cloud. The PC's answer when it is on (within [wait]); null when it
  /// does not answer in time: a request that changes something stays there for the PC to run when it
  /// comes on (Firestore sends it once the phone is online, if it is not now).
  static Future<http.Response?> request(String method, String path, String? body, {required Duration wait}) async {
    final ref = (await _space()).collection('ops').doc();
    // Written to the phone's copy at once; sent to the cloud as soon as it can be.
    unawaited(ref.set({'method': method, 'path': path, 'body': body, 'at': FieldValue.serverTimestamp()}).catchError((_) {}));
    try {
      final done = await ref.snapshots().firstWhere((s) => s.data()?['status'] != null).timeout(wait);
      final data = done.data()!;
      unawaited(ref.delete().catchError((_) {}));
      return http.Response.bytes(utf8.encode(data['response'] as String), (data['status'] as num).toInt(),
          headers: {'content-type': 'application/json; charset=utf-8'});
    } on TimeoutException {
      // Nobody will read what the PC would answer to a question; a change waits for it.
      if (method == 'GET') unawaited(ref.delete().catchError((_) {}));
      return null;
    }
  }

  /// Leaves this phone's notification address in the space, where the PC sends the new chapters it
  /// finds. Asks Android once for permission to notify; written again only when the address changes.
  static Future<void> registerPush() async {
    if (!await ready()) return;
    try {
      final messaging = FirebaseMessaging.instance;
      await messaging.requestPermission();
      final token = await messaging.getToken();
      final prefs = await SharedPreferences.getInstance();
      final key = '${await spaceId()}|$token';
      if (token == null || prefs.getString('cloud.push') == key) return;
      await (await _space()).collection('devices').doc(FirebaseAuth.instance.currentUser!.uid).set({'token': token, 'at': FieldValue.serverTimestamp()});
      await prefs.setString('cloud.push', key);
    } catch (_) {
      // Tried again on the next sync at home.
    }
  }

  static bool _listening = false;

  /// The PC's notifications: [opened] when one is tapped (also the one that opened the app), [arrived]
  /// when one comes with the app open (Android shows them only when it is not).
  static Future<void> listen({required void Function(Map<String, dynamic> data) opened, required void Function(String title, Map<String, dynamic> data) arrived}) async {
    if (_listening || !await ready()) return;
    _listening = true;
    final first = await FirebaseMessaging.instance.getInitialMessage();
    if (first != null) opened(first.data);
    FirebaseMessaging.onMessageOpenedApp.listen((m) => opened(m.data));
    FirebaseMessaging.onMessage.listen((m) => arrived(m.notification?.title ?? 'Capítulo novo', m.data));
  }

  /// Whether this phone receives the PC's notifications (set up and allowed by Android).
  static Future<bool> pushOn() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getString('cloud.push') == null || !await ready()) return false;
    final settings = await FirebaseMessaging.instance.getNotificationSettings();
    return settings.authorizationStatus == AuthorizationStatus.authorized;
  }

  /// What the PC last published there ('library' or 'queue'), for when it is off.
  static Future<String?> published(String name) async {
    try {
      final snap = await (await _space()).collection('state').doc(name).get().timeout(const Duration(seconds: 15));
      return snap.data()?['json'] as String?;
    } catch (_) {
      return null;
    }
  }
}
