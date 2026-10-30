import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

/// The phone's own copy of the library (works, readings, lists), the same shapes the PC keeps. Every
/// change made here is applied to it at once, so the app works without the PC, and also queued for
/// the PC (Api); when the PC answers, its library (merged with what was queued) replaces this copy.
class LocalData {
  static const _key = 'library';

  /// One change at a time: each reads the copy, changes it and writes it back.
  static Future<void> _lock = Future.value();

  static Future<T> _change<T>(T Function(Map<String, dynamic> data) change) {
    final done = Completer<T>();
    _lock = _lock.then((_) async {
      try {
        final data = await load();
        final result = change(data);
        await save(data);
        done.complete(result);
      } catch (e, s) {
        done.completeError(e, s);
      }
    });
    return done.future;
  }

  static Future<Map<String, dynamic>> load() async {
    final text = (await SharedPreferences.getInstance()).getString(_key);
    final data = text == null ? <String, dynamic>{} : jsonDecode(text) as Map<String, dynamic>;
    for (final list in ['works', 'reading', 'chapters', 'updates']) {
      data[list] = [...((data[list] as List?) ?? const [])];
    }
    return data;
  }

  static Future<void> save(Map<String, dynamic> data) async => (await SharedPreferences.getInstance()).setString(_key, jsonEncode(data));

  /// The library as the PC sent it last, with the changes made here since.
  static Future<Library> library() async => Library.fromJson(await load());

  /// The PC's library (already merged with what this phone sent) becomes the phone's copy.
  static Future<void> replace(String json) => _change((data) {
        data
          ..clear()
          ..addAll(jsonDecode(json) as Map<String, dynamic>);
      });

  /// A chapter page read in the app's browser (or a chapter downloaded on the phone): its work and
  /// chapter found from the title and link, as the PC does. Null when the page names no chapter.
  static Future<Map<String, dynamic>?> applyReport(Map<String, dynamic> report) => _change((data) {
        final url = report['url'] as String? ?? '';
        final title = report['title'] as String? ?? '';
        final parsed = parseChapterName(title, url);
        if (parsed.chapter == null || parsed.work.isEmpty) return null;
        final workId = _indexWork(data, parsed.work, isNovelUrl(url) ? 'novel' : 'comic');
        final progress = (report['progress'] as num?)?.toDouble();
        final record = _upsert(data, {
          'workId': workId,
          'chapter': parsed.chapter,
          'status': report['finished'] == true ? 'read' : 'reading',
          'progress': progress?.clamp(0.0, 1.0),
          'url': url,
          'title': title,
          'source': 'browser',
          'updatedAt': (report['at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
        });
        final work = _works(data).firstWhere((w) => w['id'] == workId);
        return {...record, 'work': (work['names'] as List).first};
      });

  /// How far into a library chapter the phone's reader got (1: read).
  static Future<void> applyAppReading(String entryId, double progress, int at) => _change((data) {
        final entry = (data['chapters'] as List).cast<Map<String, dynamic>>().where((c) => c['id'] == entryId).firstOrNull;
        final chapter = (entry?['chapter'] as num?)?.toDouble();
        if (entry == null || chapter == null) return;
        final clamped = progress.clamp(0.0, 1.0);
        _upsert(data, {
          'workId': entry['workId'],
          'chapter': chapter,
          'status': clamped >= 1 ? 'read' : 'reading',
          'progress': clamped,
          'url': entry['source'] ?? '',
          'title': entry['title'] ?? '',
          'source': 'app',
          'updatedAt': at,
        });
      });

  static Future<void> applyMark(String workId, List<double> chapters, int at) => _change((data) {
        for (final chapter in chapters) {
          _upsert(data, {
            'workId': workId,
            'chapter': chapter,
            'status': 'read',
            'progress': 1.0,
            'url': '',
            'title': '',
            'source': 'manual',
            'updatedAt': at,
          });
        }
      });

  /// Chapters marked unread (their reading forgotten), or every chapter of the work when [chapters] is null.
  static Future<void> applyForget(String workId, List<double>? chapters) => _change((data) {
        (data['reading'] as List).removeWhere((r) => r['workId'] == workId && (chapters == null || chapters.contains((r['chapter'] as num).toDouble())));
      });

  static Future<void> applyShelf(String workId, String? shelf, bool favorite) => _change((data) {
        for (final w in _works(data)) {
          if (w['id'] != workId) continue;
          w.remove('shelf');
          w.remove('favorite');
          if (shelf != null) w['shelf'] = shelf;
          if (favorite) w['favorite'] = true;
        }
      });

  /// Name of a work, for the PC to find it when the phone made it (its id is the phone's own).
  static Future<String?> nameOf(String workId) async =>
      _works(await load()).where((w) => w['id'] == workId).map((w) => (w['names'] as List).first as String).firstOrNull;

  /// What an exported file holds: the works and where each was left (the same file the PC exports).
  static Future<Map<String, dynamic>> export() async {
    final data = await load();
    return {
      'app': 'manga-index',
      'kind': 'data',
      'version': 1,
      'exportedAt': DateTime.now().millisecondsSinceEpoch,
      'works': data['works'],
      'reading': data['reading'],
    };
  }

  /// Merges an exported file (this phone's, another's or the PC's) into the copy: works matched by
  /// name, readings that never go back. Returns how many works and chapters it held.
  static Future<(int, int)> merge(Map<String, dynamic> file) => _change((data) {
        if (file['app'] != 'manga-index' || file['works'] is! List || file['reading'] is! List) {
          throw const FormatException('Esse arquivo não é um backup do Manga Index.');
        }
        final ids = <String, String>{};
        for (final w in (file['works'] as List).cast<Map<String, dynamic>>()) {
          final names = (w['names'] as List).cast<String>();
          if (names.isEmpty) continue;
          final known = _works(data).where((k) => k['id'] == w['id']).firstOrNull;
          final id = known?['id'] as String? ?? _indexWork(data, names.first, w['format'] == 'novel' ? 'novel' : 'comic');
          ids[w['id'] as String] = id;
          final work = _works(data).firstWhere((k) => k['id'] == id);
          for (final name in names.skip(1)) {
            _addName(work, name);
          }
          if (work['shelf'] == null && w['shelf'] != null) work['shelf'] = w['shelf'];
          if (w['favorite'] == true) work['favorite'] = true;
        }
        var chapters = 0;
        for (final r in (file['reading'] as List).cast<Map<String, dynamic>>()) {
          final workId = ids[r['workId']];
          if (workId == null || r['chapter'] is! num) continue;
          _upsert(data, {...r, 'workId': workId, 'chapter': (r['chapter'] as num).toDouble()});
          chapters++;
        }
        return (ids.length, chapters);
      });

  static List<Map<String, dynamic>> _works(Map<String, dynamic> data) => (data['works'] as List).cast<Map<String, dynamic>>();

  /// The work of that name (found by any of its names), made on the phone when there is none yet.
  static String _indexWork(Map<String, dynamic> data, String name, String format) {
    final clean = name.trim().isEmpty ? 'Sem nome' : name.trim();
    final found = findWork(_works(data), clean, format);
    if (found != null) {
      _addName(found, clean);
      return found['id'] as String;
    }
    final random = Random();
    final id = 'phone-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}-${random.nextInt(1 << 32).toRadixString(36)}';
    (data['works'] as List).add({
      'id': id,
      'names': [clean],
      'createdAt': DateTime.now().millisecondsSinceEpoch,
      if (format == 'novel') 'format': 'novel',
    });
    return id;
  }

  /// As the PC records a chapter: one read stays read, and the position only moves forward. Opening
  /// a chapter means the one before it was finished.
  static Map<String, dynamic> _upsert(Map<String, dynamic> data, Map<String, dynamic> next) {
    final records = (data['reading'] as List).cast<Map<String, dynamic>>();
    final i = records.indexWhere((r) => r['workId'] == next['workId'] && (r['chapter'] as num).toDouble() == next['chapter']);
    if (i < 0) {
      records.add(next);
    } else {
      final old = records[i];
      final oldProgress = (old['progress'] as num?)?.toDouble();
      final newProgress = (next['progress'] as num?)?.toDouble();
      final newer = (next['updatedAt'] as int) >= (old['updatedAt'] as num).toInt() && (next['source'] != 'history' || old['source'] == 'history');
      records[i] = {
        ...old,
        'status': old['status'] == 'read' || next['status'] == 'read' ? 'read' : 'reading',
        'progress': oldProgress == null ? newProgress : newProgress == null ? oldProgress : max(oldProgress, newProgress),
        if (newer) ...{
          'url': (next['url'] as String? ?? '').isNotEmpty ? next['url'] : old['url'],
          'title': (next['title'] as String? ?? '').isNotEmpty ? next['title'] : old['title'],
          'source': next['source'],
          'updatedAt': next['updatedAt'],
        },
      };
    }
    final workId = next['workId'];
    final chapters = records.where((r) => r['workId'] == workId).map((r) => (r['chapter'] as num).toDouble()).toList();
    for (var j = 0; j < records.length; j++) {
      final r = records[j];
      final c = (r['chapter'] as num).toDouble();
      if (r['workId'] == workId && r['status'] == 'reading' && chapters.any((o) => o > c && o <= c + 1)) {
        records[j] = {...r, 'status': 'read', 'progress': 1.0};
      }
    }
    return records.firstWhere((r) => r['workId'] == workId && (r['chapter'] as num).toDouble() == next['chapter']);
  }

  static void _addName(Map<String, dynamic> work, String name) {
    final names = (work['names'] as List).cast<String>();
    final updated = withName(names, name);
    if (updated != names) work['names'] = updated;
  }
}

// ---- Names of works and chapters, as the PC reads them (src/shared/works.ts) ----

/// Sites and paths of web novels: chapters there are text, not the manga of the same name.
final _novel = RegExp(r'novel|wuxia|ranobe|royalroad|scribblehub|comrademao|webnovel|mtlnation|novelupdates', caseSensitive: false);

bool isNovelUrl(String url) {
  final u = Uri.tryParse(url);
  return u != null && (_novel.hasMatch(u.host) || _novel.hasMatch(u.path));
}

/// Names shorter than this (normalized) only match exactly: "Solo" must not match every "Solo …".
const _minPrefix = 12;

final _chapterRe = RegExp(r'(?:\b(?:chapter|chap|ch|cap(?:[ií]tulo)?|ep(?:is[oó]dio|isode)?)\.?\s*[-#:]?\s*|#)(\d+(?:[.,]\d+)?)', caseSensitive: false);

typedef ChapterName = ({String work, double? chapter});

/// Splits a chapter's title (page title, file name) and its link into work name and number.
ChapterName parseChapterName(String title, [String? url]) {
  var text = title.replaceAll(RegExp(r'\.(pdf|cbz|zip)$', caseSensitive: false), '');
  double? chapter;
  // "[054]" style numbers inside brackets; other bracket tags ([EN], [@Group]) are dropped.
  final bracket = RegExp(r'[\[(]\s*(\d{1,4}(?:[.,]\d+)?)\s*[\])]').firstMatch(text);
  if (bracket != null) {
    chapter = double.parse(bracket[1]!.replaceAll(',', '.'));
    text = text.replaceRange(bracket.start, bracket.end, ' ');
  }
  text = text.replaceAll(RegExp(r'\[[^\]]*\]|\([^)]*\)|@\S+'), ' ');
  final found = _chapterRe.firstMatch(text);
  if (found != null) {
    chapter ??= double.parse(found[1]!.replaceAll(',', '.'));
    // What follows the chapter number is the chapter's own title or the site's name.
    text = text.substring(0, found.start);
  }
  text = text.replaceFirst(RegExp(r'^\s*(?:(?:read|ler|leia)\s+|(?:manga|manhwa|manhua|webtoon)\s*:\s*)', caseSensitive: false), '');
  var parts = text.split(RegExp(r'\s+[|–—-]\s+')).map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
  final site = url != null ? _siteName(url) : '';
  final named = site.isNotEmpty ? parts.where((p) => !_isSite(p, site)).toList() : parts;
  if (named.length < parts.length && named.isNotEmpty) {
    parts = named;
  } else if (parts.length > 1) {
    parts = parts.sublist(0, parts.length - 1);
  }
  var work = parts.join(' - ').replaceAll(RegExp(r'[\s\-–—:|,.·•]+$'), '').trim();
  if (url != null) {
    final fromUrl = _parseUrl(url);
    chapter ??= fromUrl.chapter;
    if (work.isEmpty && fromUrl.work.isNotEmpty) work = fromUrl.work;
  }
  return (work: work.replaceAll(RegExp(r'\s+'), ' '), chapter: chapter);
}

/// "www.manga-site.com" → "mangasite".
String _siteName(String url) {
  final host = Uri.tryParse(url)?.host;
  if (host == null || host.isEmpty) return '';
  final labels = host.replaceFirst(RegExp(r'^www\.'), '').split('.');
  return normalizeName(labels.length > 1 ? labels.sublist(0, labels.length - 1).join() : labels.first);
}

bool _isSite(String part, String site) {
  final name = normalizeName(part);
  return name.length >= 3 && (name.contains(site) || site.contains(name));
}

/// "/manga/the-mythical-weapon/chapter-53/" → "the mythical weapon", 53.
ChapterName _parseUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return (work: '', chapter: null);
  final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  String label(int i) {
    final joined = RegExp(r'^(chapter|capitulo|cap|ch|episode|ep)$', caseSensitive: false).hasMatch(segments[i]) &&
            i + 1 < segments.length &&
            RegExp(r'^\d').hasMatch(segments[i + 1])
        ? '${segments[i]} ${segments[i + 1]}'
        : segments[i];
    return joined.replaceAll(RegExp(r'[-_]'), ' ');
  }

  final i = List.generate(segments.length, (j) => j).where((j) => _chapterRe.hasMatch(label(j))).firstOrNull ?? -1;
  final chapterSeg = i >= 0 ? _chapterRe.firstMatch(label(i)) : null;
  bool named(String s) => RegExp(r'[a-z].*[-_].*[a-z]', caseSensitive: false).hasMatch(s);
  final slug = i > 0 ? (segments.sublist(0, i).reversed.where(named).firstOrNull ?? segments[i - 1]) : segments.where(named).firstOrNull;
  final name = slug == null
      ? ''
      : slug.replaceFirst(RegExp(r'[-_](?=[a-z]*\d)[a-z0-9]{4,}$', caseSensitive: false), '').replaceAll(RegExp(r'[-_]+'), ' ');
  return (work: name, chapter: chapterSeg != null ? double.parse(chapterSeg[1]!.replaceAll(',', '.')) : null);
}

const _accents = {
  'a': 'àáâãäåāăą',
  'c': 'çćĉċč',
  'd': 'ď',
  'e': 'èéêëēĕėęě',
  'g': 'ĝğġģ',
  'h': 'ĥ',
  'i': 'ìíîïĩīĭį',
  'j': 'ĵ',
  'k': 'ķ',
  'l': 'ĺļľ',
  'n': 'ñńņň',
  'o': 'òóôõöōŏő',
  'r': 'ŕŗř',
  's': 'śŝşš',
  't': 'ţť',
  'u': 'ùúûüũūŭůűų',
  'w': 'ŵ',
  'y': 'ýÿŷ',
  'z': 'źżž',
};
final _plain = {
  for (final e in _accents.entries)
    for (final c in e.value.split('')) c: e.key,
};

/// Lowercase letters and digits only, accents removed: "Gênio Regressado!" → "genioregressado".
String normalizeName(String name) {
  final lower = name.toLowerCase();
  final plain = StringBuffer();
  for (final rune in lower.runes) {
    final c = String.fromCharCode(rune);
    plain.write(_plain[c] ?? c);
  }
  return plain.toString().replaceAll(RegExp(r'[^\p{L}\p{N}]+', unicode: true), '');
}

/// Same name, or one cut short of the other (file names are often truncated), unless what the
/// longer one goes on with is a subtitle: "Solo Leveling: Ragnarok" is another work.
bool sameName(String a, String b) {
  final x = normalizeName(a);
  final y = normalizeName(b);
  if (x.isEmpty || y.isEmpty) return false;
  if (x == y) return true;
  final (short, long, longRaw) = x.length <= y.length ? (x, y, b) : (y, x, a);
  if (short.length < _minPrefix || !long.startsWith(short)) return false;
  return !RegExp(r'^\s*([:–—(]|-\s|\d|season\b|part\b|temporada\b|parte\b)', caseSensitive: false).hasMatch(_rest(longRaw, short.length));
}

/// The raw text of [name] after its first [count] normalized characters.
String _rest(String name, int count) {
  var seen = 0;
  final chars = name.runes.map(String.fromCharCode).toList();
  for (var i = 0; i < chars.length; i++) {
    if (seen == count) return chars.sublist(i).join();
    seen += normalizeName(chars[i]).length;
  }
  return '';
}

/// The work of that format one of whose names matches; the longest matching name wins.
Map<String, dynamic>? findWork(List<Map<String, dynamic>> works, String name, [String format = 'comic']) {
  Map<String, dynamic>? best;
  var bestLength = 0;
  for (final work in works) {
    if ((work['format'] ?? 'comic') != format) continue;
    for (final known in (work['names'] as List).cast<String>()) {
      if (!sameName(known, name)) continue;
      final length = min(normalizeName(known).length, normalizeName(name).length);
      if (length > bestLength) (best, bestLength) = (work, length);
    }
  }
  return best;
}

/// Adds a name the work was not known by yet; a fuller form of the name shown becomes the one shown.
List<String> withName(List<String> names, String name) {
  final clean = name.trim();
  if (clean.isEmpty) return names;
  final key = normalizeName(clean);
  if (names.any((n) => normalizeName(n) == key)) return names;
  final updated = [...names, clean];
  final shown = normalizeName(updated.first);
  final related = key.startsWith(shown) || shown.startsWith(key);
  bool lowercase(String n) => n == n.toLowerCase();
  final better = _cutShort(updated.first)
      ? !_cutShort(clean)
      : !_cutShort(clean) && key.length > shown.length && (!lowercase(clean) || lowercase(updated.first));
  if (related && better) updated.insert(0, updated.removeLast());
  return updated;
}

/// "The Mythical Weapon Creation o": cut in the middle of a word.
bool _cutShort(String name) => RegExp(r'\s\p{Ll}$', unicode: true).hasMatch(name.trim());
