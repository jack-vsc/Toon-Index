// The same shapes the PC app keeps (src/shared/works.ts, src/shared/reading.ts, LibraryEntry):
// the phone only shows them and sends readings back; matching names to works happens on the PC.

/// The reading lists, as on the PC (src/shared/works.ts).
const shelves = {
  'reading': 'Lendo',
  'plan': 'Quero ler',
  'paused': 'Pausado',
  'done': 'Concluído',
  'dropped': 'Abandonado',
};

class Work {
  Work({
    required this.id,
    required this.names,
    required this.createdAt,
    required this.isNovel,
    this.hasCover = false,
    this.shelf,
    this.favorite = false,
    this.latest,
  });

  final String id;

  /// Every name the work is known by; the first one is shown.
  final List<String> names;
  final int createdAt;
  final bool isNovel;

  /// A cover the PC found on MangaDex, mgeko or comix (/api/work-cover/…).
  final bool hasCover;

  /// The reading list it was put on (a key of [shelves]), or null.
  final String? shelf;
  final bool favorite;

  /// The newest chapter out on its sites, when the PC checked them.
  final double? latest;

  String get name => displayName(names.first);

  Work withShelf({required String? shelf, required bool favorite}) =>
      Work(id: id, names: names, createdAt: createdAt, isNovel: isNovel, hasCover: hasCover, shelf: shelf, favorite: favorite, latest: latest);

  factory Work.fromJson(Map<String, dynamic> j) => Work(
        id: j['id'] as String,
        names: (j['names'] as List).cast<String>(),
        createdAt: (j['createdAt'] as num).toInt(),
        isNovel: j['format'] == 'novel',
        hasCover: j['hasCover'] == true,
        shelf: shelves.containsKey(j['shelf']) ? j['shelf'] as String : null,
        favorite: j['favorite'] == true,
        latest: (j['latest'] as num?)?.toDouble(),
      );
}

class ReadingRecord {
  ReadingRecord({
    required this.workId,
    required this.chapter,
    required this.read,
    required this.progress,
    required this.url,
    required this.source,
    required this.updatedAt,
  });

  final String workId;
  final double chapter;

  /// False: in progress, or not known to be finished.
  final bool read;

  /// 0 to 1, null when unknown.
  final double? progress;
  final String url;
  final String source;
  final int updatedAt;

  factory ReadingRecord.fromJson(Map<String, dynamic> j) => ReadingRecord(
        workId: j['workId'] as String,
        chapter: (j['chapter'] as num).toDouble(),
        read: j['status'] == 'read',
        progress: (j['progress'] as num?)?.toDouble(),
        url: j['url'] as String? ?? '',
        source: j['source'] as String? ?? '',
        updatedAt: (j['updatedAt'] as num).toInt(),
      );
}

/// A chapter translated in the PC app, kept in its library.
class LibraryChapter {
  LibraryChapter({
    required this.id,
    required this.title,
    required this.workId,
    required this.chapter,
    required this.pageCount,
    required this.translatedPages,
    required this.createdAt,
    required this.hasCover,
    this.downloaded = false,
    this.sourceUrl,
  });

  /// Downloaded by the phone from this page (not in the PC's library): its reading goes to the PC by it.
  final String? sourceUrl;

  final String id;
  final String title;
  final String workId;
  final double? chapter;
  final int pageCount;
  final int translatedPages;
  final int createdAt;
  final bool hasCover;

  /// Saved as the site had it (a scan already in Portuguese), not translated.
  final bool downloaded;

  factory LibraryChapter.fromJson(Map<String, dynamic> j) => LibraryChapter(
        id: j['id'] as String,
        title: j['title'] as String,
        workId: j['workId'] as String,
        chapter: (j['chapter'] as num?)?.toDouble(),
        pageCount: (j['pageCount'] as num).toInt(),
        translatedPages: (j['translatedPages'] as num).toInt(),
        createdAt: (j['createdAt'] as num).toInt(),
        hasCover: j['hasCover'] == true,
        downloaded: j['model'] == 'baixado sem tradução',
      );
}

/// A chapter the PC found on one of a work's sites, past the last one read.
class ChapterUpdate {
  ChapterUpdate({required this.workId, required this.latest, required this.url, required this.site});

  final String workId;
  final double latest;
  final String url;
  final String site;

  factory ChapterUpdate.fromJson(Map<String, dynamic> j) => ChapterUpdate(
        workId: j['workId'] as String,
        latest: (j['latest'] as num).toDouble(),
        url: j['url'] as String,
        site: j['site'] as String,
      );
}

class Library {
  Library({required this.works, required this.reading, required this.chapters, this.updates = const [], this.ntfyTopic});

  final List<Work> works;
  final List<ReadingRecord> reading;
  final List<LibraryChapter> chapters;
  final List<ChapterUpdate> updates;

  /// The ntfy.sh topic the PC sends new chapters to, while that is on.
  final String? ntfyTopic;

  factory Library.fromJson(Map<String, dynamic> j) => Library(
        works: (j['works'] as List).map((w) => Work.fromJson(w as Map<String, dynamic>)).toList(),
        reading: (j['reading'] as List).map((r) => ReadingRecord.fromJson(r as Map<String, dynamic>)).toList(),
        chapters: (j['chapters'] as List).map((c) => LibraryChapter.fromJson(c as Map<String, dynamic>)).toList(),
        // PCs from before new-chapter checks send neither.
        updates: ((j['updates'] as List?) ?? []).map((u) => ChapterUpdate.fromJson(u as Map<String, dynamic>)).toList(),
        ntfyTopic: j['ntfyTopic'] as String?,
      );

  /// With the reading lists and favorites set on this phone and not yet sent to the PC.
  Library withShelves(List<Map<String, dynamic>> pending) {
    if (pending.isEmpty) return this;
    final latest = {for (final p in pending) p['workId']: p};
    return Library(
      works: [
        for (final w in works)
          latest[w.id] == null ? w : w.withShelf(shelf: latest[w.id]!['shelf'] as String?, favorite: latest[w.id]!['favorite'] == true),
      ],
      reading: reading,
      chapters: chapters,
      updates: updates,
      ntfyTopic: ntfyTopic,
    );
  }

  /// Works with something to show: those with a new chapter out first, then the one read most recently.
  List<WorkView> get views {
    final list = <WorkView>[];
    for (final work in works) {
      final records = reading.where((r) => r.workId == work.id).toList()..sort((a, b) => a.chapter.compareTo(b.chapter));
      final translated = chapters.where((c) => c.workId == work.id).toList()
        ..sort((a, b) => (a.chapter ?? double.infinity).compareTo(b.chapter ?? double.infinity));
      if (records.isEmpty && translated.isEmpty && work.shelf == null && !work.favorite) continue;
      list.add(WorkView(work, records, translated, update: updates.where((u) => u.workId == work.id).firstOrNull));
    }
    int fresh(WorkView v) => v.update != null ? 1 : 0;
    list.sort((a, b) => fresh(b) != fresh(a) ? fresh(b) - fresh(a) : b.lastActivity.compareTo(a.lastActivity));
    return list;
  }
}

/// A work with its readings and translated chapters.
class WorkView {
  WorkView(this.work, this.records, this.translated, {this.update});

  final Work work;
  final List<ReadingRecord> records;
  final List<LibraryChapter> translated;

  /// A chapter out past the last one read, if the PC found one.
  final ChapterUpdate? update;

  int get lastActivity => [
        0,
        ...records.map((r) => r.updatedAt),
        ...translated.map((c) => c.createdAt),
      ].reduce((a, b) => a > b ? a : b);

  /// The highest chapter read, or null.
  double? get readUpTo {
    final read = records.where((r) => r.read).map((r) => r.chapter);
    return read.isEmpty ? null : read.reduce((a, b) => a > b ? a : b);
  }

  /// The chapter left midway after the last one read, the latest touched.
  ReadingRecord? get current {
    final upTo = readUpTo;
    final open = records.where((r) => !r.read && (upTo == null || r.chapter > upTo)).toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return open.isEmpty ? null : open.first;
  }

  /// The page to go back to: the chapter left midway, or the last one read on a site.
  String? get continueUrl {
    final now = current;
    if (now != null && now.url.isNotEmpty) return now.url;
    final withUrl = records.where((r) => r.url.isNotEmpty).toList()..sort((a, b) => b.chapter.compareTo(a.chapter));
    return withUrl.isEmpty ? null : withUrl.first.url;
  }

  /// The reading list it is on: the one picked, or "reading" once something of it was read.
  String? get shelf => work.shelf ?? (records.isNotEmpty ? 'reading' : null);

  /// The library chapter to go on with: the one left midway, or the first after the last one read.
  LibraryChapter? get nextInLibrary {
    final upTo = readUpTo ?? double.negativeInfinity;
    final now = current;
    if (now != null) {
      final same = translated.where((c) => c.chapter == now.chapter).toList()..sort((a, b) => b.createdAt.compareTo(a.createdAt));
      if (same.isNotEmpty) return same.first;
    }
    return translated.where((c) => c.chapter != null && c.chapter! > upTo).firstOrNull;
  }

  /// The newest chapter known: out on its sites, translated, or read (a site may be behind the reading).
  double? get newest {
    final all = [?work.latest, ?update?.latest, ...translated.map((c) => c.chapter).whereType<double>(), ...records.map((r) => r.chapter)];
    return all.isEmpty ? null : all.reduce((a, b) => a > b ? a : b);
  }

  /// How far the reading is, 0 to 1: the last chapter read out of the newest one; null before any.
  double? get share {
    final upTo = readUpTo;
    final top = newest;
    return upTo == null || top == null || top <= 0 ? null : (upTo / top).clamp(0.0, 1.0);
  }

  /// "Cap. 45 · 45% lido", "Concluído · Cap. 222", "Não lido" under a cover (as on the PC).
  String get metaLine {
    final upTo = readUpTo;
    final listed = work.shelf != null && work.shelf != 'reading' ? shelves[work.shelf] : null;
    final done = share;
    return [
      ?listed,
      if (upTo != null) 'Cap. ${chapterLabel(upTo)}' else if (listed == null) records.isEmpty ? 'Não lido' : 'Lendo',
      if (done != null && done < 1 && work.shelf != 'done') '${(done * 100).round()}% lido',
      if (work.isNovel) 'Novel',
    ].join(' · ');
  }

  /// "5 TRADUZIDOS · 3 BAIXADOS".
  String get chapterCount {
    final downloaded = translated.where((c) => c.downloaded).length;
    final done = translated.length - downloaded;
    return [if (done > 0) '$done TRADUZIDOS', if (downloaded > 0) '$downloaded BAIXADOS'].join(' · ');
  }

  bool matches(String query) {
    final q = normalizeName(query);
    return q.isEmpty || work.names.any((n) => normalizeName(n).contains(q));
  }
}

/// "53" or "53.5".
String chapterLabel(double chapter) => chapter == chapter.roundToDouble() ? chapter.toInt().toString() : chapter.toString();

/// Lowercase letters and digits only, accents removed (as normalizeName in src/shared/works.ts).
String normalizeName(String name) {
  const from = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
  const to = 'aaaaaeeeeiiiiooooouuuucn';
  final lower = name.toLowerCase();
  final out = StringBuffer();
  for (final rune in lower.runes) {
    var c = String.fromCharCode(rune);
    final i = from.indexOf(c);
    if (i >= 0) c = to[i];
    if (RegExp(r'[\p{L}\p{N}]', unicode: true).hasMatch(c)) out.write(c);
  }
  return out.toString();
}

/// Names taken from links are lowercase: "the mythical weapon" → "The Mythical Weapon".
String displayName(String name) {
  if (name != name.toLowerCase()) return name;
  return name.replaceAllMapped(RegExp(r'(^|\s)(\p{L})', unicode: true), (m) => '${m[1]}${m[2]!.toUpperCase()}');
}

/// A chapter this phone (or another) asked the PC to translate (src/shared/remoteJobs.ts).
class RemoteJob {
  RemoteJob({
    required this.id,
    required this.isLink,
    required this.name,
    required this.url,
    required this.status,
    required this.message,
    required this.entryId,
    required this.updatedAt,
  });

  final String id;
  final bool isLink;
  final String name;
  final String? url;

  /// queued, running, done or failed.
  final String status;
  final String? message;

  /// The library chapter it became, once done.
  final String? entryId;
  final int updatedAt;

  factory RemoteJob.fromJson(Map<String, dynamic> j) => RemoteJob(
        id: j['id'] as String,
        isLink: j['kind'] == 'link',
        name: j['name'] as String,
        url: j['url'] as String?,
        status: j['status'] as String,
        message: j['message'] as String?,
        entryId: j['entryId'] as String?,
        updatedAt: (j['updatedAt'] as num).toInt(),
      );
}

/// A work found on one of the PC's catalog sites (src/shared/catalog.ts).
class CatalogMatch {
  CatalogMatch({required this.site, required this.title, required this.url, required this.altNames, this.latest, this.thumb});

  final String site;
  final String title;

  /// The work's page there, the one that lists its chapters.
  final String url;
  final List<String> altNames;
  final double? latest;

  /// The cover as a data URL.
  final String? thumb;

  factory CatalogMatch.fromJson(Map<String, dynamic> j) => CatalogMatch(
        site: j['site'] as String,
        title: j['title'] as String,
        url: j['url'] as String,
        altNames: ((j['altNames'] as List?) ?? []).cast<String>(),
        latest: (j['latest'] as num?)?.toDouble(),
        thumb: j['thumb'] as String?,
      );
}

/// What one site answered: its matches, or why it could not be searched.
class CatalogResult {
  CatalogResult({required this.site, required this.matches, this.error});

  final String site;
  final List<CatalogMatch> matches;
  final String? error;

  factory CatalogResult.fromJson(Map<String, dynamic> j) => CatalogResult(
        site: j['site'] as String,
        matches: (j['matches'] as List).map((m) => CatalogMatch.fromJson(m as Map<String, dynamic>)).toList(),
        error: j['error'] as String?,
      );
}

const catalogSites = {'mangadex': 'MangaDex', 'mgeko': 'mgeko'};

/// A chapter of a work on a site, to translate or download.
class SiteChapterLink {
  SiteChapterLink({required this.chapter, required this.url});

  final double chapter;
  final String url;

  factory SiteChapterLink.fromJson(Map<String, dynamic> j) => SiteChapterLink(chapter: (j['chapter'] as num).toDouble(), url: j['url'] as String);
}
