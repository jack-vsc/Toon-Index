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
    this.sources = const [],
    this.auto,
    this.catalogSites = const [],
    this.inVolumes = false,
    this.dates = const {},
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

  /// Its pages on sites, checked by the PC for new chapters.
  final List<String> sources;

  /// What the PC does with a new chapter besides the notice: 'translate', 'download' or null.
  final String? auto;

  /// The catalog sites it was found on (keys of [catalogSites]).
  final List<String> catalogSites;

  /// By chapter number ("229", "12.5"), when each came out (ms), where the work's sites say.
  final Map<String, int> dates;

  /// When chapter [n] came out, where known.
  int? dateOf(double n) => dates[n == n.roundToDouble() ? n.toInt().toString() : n.toString()];

  /// Numbered in volumes (a light novel translated a volume at a time) instead of chapters; set in its editor.
  final bool inVolumes;

  /// "Capítulo" or "Volume", "Capítulos" or "Volumes", "Cap." or "Vol.".
  String get unitOne => inVolumes ? 'Volume' : 'Capítulo';
  String get unitMany => inVolumes ? 'Volumes' : 'Capítulos';
  String get unitShort => inVolumes ? 'Vol.' : 'Cap.';

  String get name => displayName(names.first);

  Work withShelf({required String? shelf, required bool favorite}) =>
      Work(id: id, names: names, createdAt: createdAt, isNovel: isNovel, hasCover: hasCover, shelf: shelf, favorite: favorite, latest: latest,
          sources: sources, auto: auto, catalogSites: catalogSites, inVolumes: inVolumes, dates: dates);

  factory Work.fromJson(Map<String, dynamic> j) => Work(
        id: j['id'] as String,
        names: (j['names'] as List).cast<String>(),
        createdAt: (j['createdAt'] as num).toInt(),
        isNovel: j['format'] == 'novel',
        hasCover: j['hasCover'] == true,
        shelf: shelves.containsKey(j['shelf']) ? j['shelf'] as String : null,
        favorite: j['favorite'] == true,
        latest: (j['latest'] as num?)?.toDouble(),
        sources: ((j['sources'] as List?) ?? []).cast<String>(),
        auto: j['auto'] == 'translate' || j['auto'] == 'download' ? j['auto'] as String : null,
        catalogSites: (((j['catalog'] as Map?)?['sites'] as List?) ?? []).cast<String>(),
        inVolumes: j['unit'] == 'volume',
        dates: ((j['dates'] as Map?) ?? {}).map((k, v) => MapEntry(k as String, (v as num).toInt())),
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
    this.source,
  });

  /// Downloaded by the phone from this page (not in the PC's library): its reading goes to the PC by it.
  final String? sourceUrl;

  /// The page the PC took it from: a chapter saved from two sites is two versions of it.
  final String? source;

  /// The site it came from ("mgeko.cc"), or "arquivo" for a PDF.
  String get site {
    final host = Uri.tryParse(source ?? sourceUrl ?? '')?.host ?? '';
    return host.isEmpty ? 'arquivo' : host.replaceFirst(RegExp(r'^www\.'), '');
  }

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
        source: j['source'] as String?,
      );
}

/// A chapter the PC found on one of a work's sites, past the last one read.
class ChapterUpdate {
  ChapterUpdate({required this.workId, required this.latest, required this.url, required this.site, this.checkedAt = 0, this.date, this.since, this.recent = true});

  final String workId;
  final double latest;
  final String url;
  final String site;

  /// When the PC last looked at that site.
  final int checkedAt;

  /// When the chapter came out, where the site says.
  final int? date;

  /// When the PC first saw it, for sites that give no date.
  final int? since;

  /// Out in the last week: news. Older ones not read yet are the history under them.
  final bool recent;

  /// When it came out as far as is known, for the history's order.
  int get outAt => date ?? since ?? checkedAt;

  factory ChapterUpdate.fromJson(Map<String, dynamic> j) => ChapterUpdate(
        workId: j['workId'] as String,
        latest: (j['latest'] as num).toDouble(),
        url: j['url'] as String,
        site: j['site'] as String,
        checkedAt: (j['checkedAt'] as num?)?.toInt() ?? 0,
        date: (j['date'] as num?)?.toInt(),
        since: (j['since'] as num?)?.toInt(),
        // PCs from before the history send only news.
        recent: j['recent'] != false,
      );
}

class Library {
  Library({required this.works, required this.reading, required this.chapters, this.updates = const [], this.ntfyTopic, this.lastCheck, this.checking = false});

  final List<Work> works;
  final List<ReadingRecord> reading;
  final List<LibraryChapter> chapters;
  final List<ChapterUpdate> updates;

  /// The ntfy.sh topic the PC sends new chapters to, while that is on.
  final String? ntfyTopic;

  /// When the PC last checked the works' sites, and whether it is checking now.
  final int? lastCheck;
  final bool checking;

  factory Library.fromJson(Map<String, dynamic> j) => Library(
        works: (j['works'] as List).map((w) => Work.fromJson(w as Map<String, dynamic>)).toList(),
        reading: (j['reading'] as List).map((r) => ReadingRecord.fromJson(r as Map<String, dynamic>)).toList(),
        chapters: (j['chapters'] as List).map((c) => LibraryChapter.fromJson(c as Map<String, dynamic>)).toList(),
        // PCs from before new-chapter checks send neither.
        updates: ((j['updates'] as List?) ?? []).map((u) => ChapterUpdate.fromJson(u as Map<String, dynamic>)).toList(),
        ntfyTopic: j['ntfyTopic'] as String?,
        lastCheck: (j['lastCheck'] as num?)?.toInt(),
        checking: j['checking'] == true,
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
      lastCheck: lastCheck,
      checking: checking,
    );
  }

  /// Chapters out over a week ago and not read yet, newest first: Novidades' history.
  List<(Work, ChapterUpdate)> get older {
    final byId = {for (final w in works) w.id: w};
    final rows = [
      for (final u in updates)
        if (!u.recent && byId[u.workId] != null) (byId[u.workId]!, u),
    ];
    // A work saved twice (a page in common) has one line, under the name of the copy on a list.
    final twice = duplicateWorks([for (final (w, _) in rows) w]);
    return rows.where((r) => !twice.contains(r.$1.id)).toList()..sort((a, b) => b.$2.outAt.compareTo(a.$2.outAt));
  }

  /// Works with something to show: those with a new chapter out first, then the one read most recently.
  List<WorkView> get views {
    final list = <WorkView>[];
    for (final work in works) {
      final records = reading.where((r) => r.workId == work.id).toList()..sort((a, b) => a.chapter.compareTo(b.chapter));
      final translated = chapters.where((c) => c.workId == work.id).toList()
        ..sort((a, b) => (a.chapter ?? double.infinity).compareTo(b.chapter ?? double.infinity));
      if (records.isEmpty && translated.isEmpty && work.shelf == null && !work.favorite) continue;
      list.add(WorkView(work, records, translated, update: updates.where((u) => u.workId == work.id && u.recent).firstOrNull));
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
  /// One version of each chapter, the newest (a chapter saved from two sites is two), for reading on
  /// from chapter to chapter.
  List<LibraryChapter> get readable {
    final newest = <double, LibraryChapter>{};
    final rest = <LibraryChapter>[];
    for (final c in translated) {
      if (c.chapter == null) {
        rest.add(c);
      } else if ((newest[c.chapter!]?.createdAt ?? -1) < c.createdAt) {
        newest[c.chapter!] = c;
      }
    }
    return [...newest.values, ...rest]..sort((a, b) => (a.chapter ?? double.infinity).compareTo(b.chapter ?? double.infinity));
  }

  LibraryChapter? get nextInLibrary {
    final upTo = readUpTo ?? double.negativeInfinity;
    final now = current;
    if (now != null) {
      final same = translated.where((c) => c.chapter == now.chapter).toList()..sort((a, b) => b.createdAt.compareTo(a.createdAt));
      if (same.isNotEmpty) return same.first;
    }
    return readable.where((c) => c.chapter != null && c.chapter! > upTo).firstOrNull;
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
      if (upTo != null) '${work.unitShort} ${chapterLabel(upTo)}' else if (listed == null) records.isEmpty ? 'Não lido' : 'Lendo',
      if (done != null && done < 1 && work.shelf != 'done') '${(done * 100).round()}% lido',
      if (work.isNovel) 'Novel',
    ].join(' · ');
  }

  /// "5 TRADUZIDOS · 3 BAIXADOS".
  String get chapterCount {
    final downloaded = readable.where((c) => c.downloaded).length;
    final done = readable.length - downloaded;
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

/// A name without what a page's title wrapped it in: "[Manga]: Manga One Day, Suddenly, Seoul Is Read"
/// → "One Day, Suddenly, Seoul Is", "The Asterisk War, Vol. 8 Overview" → "The Asterisk War"
/// (as src/shared/works.ts cleanWorkName).
String cleanWorkName(String name) {
  var clean = name.trim();
  final tagged = RegExp(r'^(?:\[[^\]]*\]\s*)?:').hasMatch(clean);
  clean = clean.replaceFirst(RegExp(r'^(?:\[[^\]]*\]\s*)?:\s*'), '');
  if (tagged) {
    clean = clean
        .replaceFirst(RegExp(r'^(?:manga|manhwa|manhua|webtoon)\s+', caseSensitive: false), '')
        .replaceFirst(RegExp(r'\s+read(?:\s+online)?$', caseSensitive: false), '');
  }
  clean = clean
      .replaceFirst(RegExp(r'[,\s]+(?:vol(?:ume)?\.?\s*\d+\s*)?overview$', caseSensitive: false), '')
      .replaceFirst(RegExp(r'[,\s\-–—:|]+$'), '')
      .trim();
  return clean.isEmpty ? name.trim() : clean;
}

/// A work's page as the same work's other copies have it: MangaDex by its id, any other by its address.
String sourceKey(String url) {
  final dex = RegExp(r'mangadex\.org/title/([0-9a-f-]{36})', caseSensitive: false).firstMatch(url);
  if (dex != null) return 'mangadex:${dex[1]!.toLowerCase()}';
  final u = Uri.tryParse(url);
  if (u == null || u.host.isEmpty) return url;
  return u.host.replaceFirst(RegExp(r'^www\.'), '') + u.path.replaceFirst(RegExp(r'/$'), '');
}

/// Of works that are the same one saved twice (a page in common), the ids of those not shown: the one on a
/// list or a favorite stays, else the first (as src/shared/works.ts duplicateWorks).
Set<String> duplicateWorks(List<Work> works) {
  bool listed(Work w) => w.shelf != null || w.favorite;
  final ranked = [...works.where(listed), ...works.where((w) => !listed(w))];
  final seen = <String>{};
  final hidden = <String>{};
  for (final w in ranked) {
    final keys = w.sources.map(sourceKey).toList();
    if (keys.any(seen.contains)) {
      hidden.add(w.id);
    } else {
      seen.addAll(keys);
    }
  }
  return hidden;
}

/// Names taken from links are lowercase: "the mythical weapon" → "The Mythical Weapon".
String displayName(String name) {
  name = cleanWorkName(name);
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
    this.work,
    this.chapter,
    this.downloadOnly = false,
    this.options,
    this.done,
    this.total,
  });

  /// While it translates: pages finished out of the chapter's.
  final int? done;
  final int? total;

  /// "12/38 páginas · 32%" while it translates.
  String? get progressText => done != null && total != null && total! > 0 ? '$done/$total páginas · ${(done! * 100 / total!).round()}%' : null;

  /// Translated with these instead of the PC's settings.
  final Map<String, dynamic>? options;

  /// For a chapter of a range ("Vários capítulos"): its work and number, and whether it is only downloaded.
  final String? work;
  final double? chapter;
  final bool downloadOnly;

  /// A novel's volume sent as a PDF ("Name - Volume 08"), grouped by its work like a chapter.
  bool get isVolume => !isLink && RegExp(r'\bvol(ume)?\b', caseSensitive: false).hasMatch(name);

  /// "Cap. 36" or "Vol. 8".
  String? get number => chapter == null ? null : '${isVolume ? 'Vol.' : 'Cap.'} ${chapterLabel(chapter!)}';

  /// "Cap. 36 · Solo Spell Caster", or the link or file asked for.
  String get label => work != null && number != null ? '$number · $work' : (isLink ? (url ?? name) : name);

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
        work: (j['batch'] as Map<String, dynamic>?)?['work'] as String?,
        chapter: ((j['batch'] as Map<String, dynamic>?)?['chapter'] as num?)?.toDouble(),
        downloadOnly: (j['batch'] as Map<String, dynamic>?)?['download'] == true,
        options: j['options'] == null ? null : Map<String, dynamic>.from(j['options'] as Map),
        done: (j['progress'] as Map?)?['done'] as int?,
        total: (j['progress'] as Map?)?['total'] as int?,
      );
}

/// The PC's translation settings, to choose a request's options from: its defaults (the keys of
/// TranslateOptions in src/shared/types.ts), its APIs, and the languages it translates.
class PcTranslateSettings {
  PcTranslateSettings({required this.defaults, required this.profiles, required this.languages, required this.auto});

  final Map<String, dynamic> defaults;
  final List<({String id, String name, String model, bool ready, bool local})> profiles;
  final List<({String value, String label})> languages;

  /// The source language value for "detect it".
  final String auto;

  factory PcTranslateSettings.fromJson(Map<String, dynamic> j) => PcTranslateSettings(
        defaults: Map<String, dynamic>.from(j['defaults'] as Map),
        profiles: [
          for (final p in (j['profiles'] as List).cast<Map<String, dynamic>>())
            (id: p['id'] as String, name: p['name'] as String, model: p['model'] as String? ?? '', ready: p['ready'] == true, local: p['local'] == true),
        ],
        languages: [for (final l in (j['languages'] as List).cast<Map<String, dynamic>>()) (value: l['value'] as String, label: l['label'] as String)],
        auto: j['auto'] as String? ?? 'auto',
      );

  String languageLabel(String value) => value == auto ? 'Detectar' : languages.where((l) => l.value == value).firstOrNull?.label ?? value;

  /// "Visão na GPU · Gemini · Rápido · Português (Brasil)".
  String summary(Map<String, dynamic> o) => [
        'Visão na ${o['visionDevice'] == 'cpu' ? 'CPU' : 'GPU'}',
        ?profiles.where((p) => p.id == o['activeProfileId']).firstOrNull?.name,
        speeds[o['speed']] ?? '',
        languageLabel(o['targetLanguage'] as String? ?? ''),
      ].where((s) => s.isNotEmpty).join(' · ');

  static const speeds = {'fast': 'Rápido', 'balanced': 'Equilibrado', 'quality': 'Qualidade máxima'};
  static const gpuSharing = {'auto': 'Automático', 'phased': 'Uma IA de cada vez (GPU pequena)', 'together': 'Tudo junto (GPU grande)'};
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

const catalogSites = {'mangadex': 'MangaDex', 'mgeko': 'mgeko', 'mangakakalot': 'MangaKakalot', 'mangalivre': 'MangaLivre (português)', 'sites': 'Nos seus sites em português'};

/// A chapter of a work on a site, to translate or download.
class SiteChapterLink {
  SiteChapterLink({required this.chapter, required this.url});

  final double chapter;
  final String url;

  factory SiteChapterLink.fromJson(Map<String, dynamic> j) => SiteChapterLink(chapter: (j['chapter'] as num).toDouble(), url: j['url'] as String);
}
