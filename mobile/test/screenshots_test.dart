// Pictures of the screens without a phone or emulator: SCREENSHOTS=<folder> flutter test test/screenshots_test.dart
// (PAGES=<folder with translated pages, pNN-after.png> for the reader). Skipped otherwise.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:manga_index/api.dart';
import 'package:manga_index/browser_screen.dart';
import 'package:manga_index/data_screen.dart';
import 'package:manga_index/downloads_screen.dart';
import 'package:manga_index/downloads.dart';
import 'package:manga_index/library_screen.dart';
import 'package:manga_index/models.dart';
import 'package:manga_index/reader_screen.dart';
import 'package:manga_index/batch_screen.dart';
import 'package:manga_index/queue_screen.dart';
import 'package:manga_index/search_screen.dart';
import 'package:manga_index/site_download.dart';
import 'package:manga_index/theme.dart';
import 'package:manga_index/translate_screen.dart';
import 'package:manga_index/work_screen.dart';

final out = Platform.environment['SCREENSHOTS'];
final pagesDir = Platform.environment['PAGES'];
const phone = Size(412, 915);
const ratio = 2.625;

Future<void> loadFonts() async {
  final fonts = '${Platform.environment['FLUTTER_ROOT']}/bin/cache/artifacts/material_fonts';
  Future<ByteData> font(String name) async => ByteData.sublistView(await File('$fonts/$name').readAsBytes());
  await (FontLoader('Roboto')
        ..addFont(font('roboto-regular.ttf'))
        ..addFont(font('roboto-medium.ttf'))
        ..addFont(font('roboto-bold.ttf')))
      .load();
  await (FontLoader('MaterialIcons')..addFont(font('materialicons-regular.otf'))).load();
}


final _boundary = GlobalKey();

/// Draws `screen` as a phone shows it (after `act`, taps or typing on it) into `out/name.png`.
Future<void> shoot(WidgetTester tester, Widget screen, String name, {Future<void> Function(WidgetTester tester)? act}) async {
  await tester.pumpWidget(RepaintBoundary(
    key: _boundary,
    child: MaterialApp(debugShowCheckedModeBanner: false, theme: appTheme(), home: screen),
  ));
  if (act != null) {
    await settle(tester);
    await act(tester);
  }
  await settle(tester);
  await capture(tester, name);
}

/// Lets requests, images and animations finish.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 300));
      // Images decode outside the fake clock.
      for (final element in find.byType(Image).evaluate()) {
        await precacheImage((element.widget as Image).image, element).catchError((_) {});
      }
    });
    await tester.pump(const Duration(seconds: 1));
  }
}

Future<void> capture(WidgetTester tester, String name) async {
  await tester.runAsync(() async {
    final render = _boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await render.toImage(pixelRatio: ratio);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$out/$name.png').writeAsBytes(png!.buffer.asUint8List());
  });
}

/// Answers with requests in every state instead of asking a PC.
class FakeJobsApi extends Api {
  FakeJobsApi() : super(Connection(hosts: ['127.0.0.1'], port: 1, token: 'test'));

  @override
  Future<List<RemoteJob>> jobs() async {
    final now = DateTime.now().millisecondsSinceEpoch;
    RemoteJob job(String id, bool link, String name, String status, {String? message}) => RemoteJob(
        id: id, isLink: link, name: name, url: link ? name : null, status: status, message: message, entryId: status == 'done' ? 'e' : null, updatedAt: now);
    return [
      job('1', true, 'https://mgread.io/manga/the-mythical-weapon-creation/chapter-91/', 'queued'),
      job('2', true, 'https://asuracomic.net/series/solo-leveling-ragnarok/chapter/42', 'running', message: 'Traduzindo'),
      job('3', false, 'Mythical Weapon Chapter 52.pdf', 'done'),
      job('4', true, 'https://site-fora-do-ar.com/chapter-10', 'failed', message: 'O site não respondeu.'),
    ];
  }
}

/// A library with new chapters out, instead of asking a PC.
class FakeLibraryApi extends Api {
  FakeLibraryApi(this.fake, {int port = 1}) : super(Connection(hosts: ['127.0.0.1'], port: port, token: 'test'));

  final Library fake;

  @override
  Future<Library> library() async => fake;
}

/// The phone's folders, in a folder of the test's.
class FakePaths extends PathProviderPlatform with MockPlatformInterfaceMixin {
  FakePaths(this.root);

  final String root;

  @override
  Future<String?> getApplicationSupportPath() async => root;

  @override
  Future<String?> getApplicationDocumentsPath() async => root;

  @override
  Future<String?> getTemporaryPath() async => root;
}

/// The sites' answers for "Vários capítulos", instead of asking a PC.
/// A PC's queue in the middle of a range, instead of asking a PC.
class FakeQueueApi extends Api {
  FakeQueueApi() : super(Connection(hosts: ['127.0.0.1'], port: 1, token: 'test'));

  static Map<String, dynamic> _job(String id, String status, num chapter, {String? message, bool download = false}) => {
        'id': id,
        'kind': 'link',
        'name': 'Solo Spell Caster Chapter $chapter',
        'url': 'https://mangadex.org/chapter/$id',
        'status': status,
        'message': ?message,
        'updatedAt': DateTime.now().millisecondsSinceEpoch,
        'batch': {'work': download ? 'Omniscient Reader' : 'Solo Spell Caster', 'chapter': chapter, 'site': 'mangadex.org', 'download': download},
      };

  @override
  Future<({List<RemoteJob> jobs, bool paused})> queue() async => (
        jobs: [
          _job('a', 'running', 36, message: 'Traduzindo'),
          for (final n in [37, 38, 39, 40, 41]) _job('q$n', 'queued', n),
          _job('d1', 'queued', 120, download: true),
          _job('f1', 'failed', 35, message: 'Não foi possível baixar a página 16 do MangaDex (HTTP 502).'),
        ].map(RemoteJob.fromJson).toList(),
        paused: false,
      );
}

class FakeBatchApi extends Api {
  FakeBatchApi({required int port, required this.thumb}) : super(Connection(hosts: ['127.0.0.1'], port: port, token: 'test'));

  final String thumb;

  @override
  Future<List<CatalogResult>> searchSites(String query) async => [
        CatalogResult(site: 'mangadex', matches: [
          CatalogMatch(site: 'mangadex', title: query, url: 'https://mangadex.org/title/x', altNames: ['Hwasan Gwihwan', 'O Retorno da Seita do Monte Hua'], latest: 184, thumb: thumb),
        ]),
        CatalogResult(site: 'mgeko', matches: [
          CatalogMatch(site: 'mgeko', title: query, url: 'https://www.mgeko.cc/manga/x/', altNames: [], latest: 184, thumb: thumb),
        ]),
      ];

  @override
  Future<List<SiteChapterLink>> chapterList(String site, String url) async =>
      [for (var n = 1; n <= 184; n++) SiteChapterLink(chapter: n.toDouble(), url: 'https://mangadex.org/chapter/$n')];
}

void main() {
  final now = DateTime.now().millisecondsSinceEpoch;
  final api = Api(Connection(hosts: ['127.0.0.1'], port: 1, token: 'test'));
  final work = Work(id: 'w', names: ['The Mythical Weapon Creation of the Regressed Genius Player', 'Gênio Regressado'], createdAt: 0, isNovel: false);
  LibraryChapter chapter(String id, double n, int pages) =>
      LibraryChapter(id: id, title: 'cap $n', workId: 'w', chapter: n, pageCount: pages, translatedPages: pages, createdAt: now, hasCover: false);
  ReadingRecord record(double n, bool read, double? progress) =>
      ReadingRecord(workId: 'w', chapter: n, read: read, progress: progress, url: 'https://mgread.io/x/chapter-$n', source: 'browser', updatedAt: now - 3600000);

  setUpAll(() async {
    if (out == null) return;
    await loadFonts();
  });

  testWidgets('work screen with downloads', (tester) async {
    tester.view.physicalSize = phone * ratio;
    tester.view.devicePixelRatio = ratio;
    final root = Directory.systemTemp.createTempSync('mi-downloads');
    Downloads.root = root;
    Directory('${root.path}/chapters').createSync();
    File('${root.path}/chapters/c53.pdf').writeAsStringSync('pdf');
    File('${root.path}/chapters/c54.pdf').writeAsStringSync('pdf');
    final view = WorkView(work, [record(88, true, 1), record(89, true, 1), record(90, false, 0.3)],
        [chapter('c53', 53, 13), chapter('c54', 54, 14), chapter('c55', 55, 14), chapter('c56', 56, 15)]);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await shoot(tester, WorkScreen(view: view, api: api), 'p2-work');
  }, skip: out == null);

  testWidgets('queue', (tester) async {
    tester.view.physicalSize = phone * ratio;
    tester.view.devicePixelRatio = ratio;
    await shoot(tester, QueueScreen(api: FakeQueueApi()), 'm6-queue');
  }, skip: out == null);

  testWidgets('reader', (tester) async {
    tester.view.physicalSize = phone * ratio;
    tester.view.devicePixelRatio = ratio;
    final files = Directory(pagesDir!).listSync().whereType<File>().where((f) => f.path.endsWith('-after.png')).toList()
      ..sort((a, b) => a.path.compareTo(b.path));
    final images = <int, Uint8List>{};
    final aspects = <double>[];
    await tester.runAsync(() async {
      for (final (i, f) in files.indexed) {
        final bytes = await f.readAsBytes();
        final decoded = await decodeImageFromList(bytes);
        aspects.add(decoded.height / decoded.width);
        images[i] = bytes;
      }
    });
    final screen = Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(title: const Text('Capítulo 53'), backgroundColor: Colors.black),
      body: ReaderPages(controller: ScrollController(initialScrollOffset: 520), aspects: aspects, images: images, page: 1, onMissing: (_) {}),
    );
    await shoot(tester, screen, 'p2-reader');
  }, skip: out == null || pagesDir == null);

  testWidgets('translate on the PC', (tester) async {
    tester.view.physicalSize = phone * ratio;
    tester.view.devicePixelRatio = ratio;
    final api = FakeJobsApi();
    await shoot(tester, TranslateScreen(api: api), 'p3-translate');
    // The screen asks the PC again every few seconds.
    await tester.pumpWidget(const SizedBox());
  }, skip: out == null);

  testWidgets('library with new chapters', (tester) async {
    tester.view.physicalSize = phone * ratio;
    tester.view.devicePixelRatio = ratio;
    SharedPreferences.setMockInitialValues({});
    Map<String, dynamic> read(String id, num chapter, String url, int ago) =>
        {'workId': id, 'chapter': chapter, 'status': 'read', 'progress': 1, 'url': url, 'source': 'browser', 'updatedAt': now - ago};
    final library = Library.fromJson({
      'works': [
        {'id': 'a', 'names': ['The Mythical Weapon Creation of the Regressed Genius Player'], 'createdAt': 0},
        {'id': 'b', 'names': ['Overgeared'], 'createdAt': 0},
        {'id': 'c', 'names': ['Versatile Mage'], 'createdAt': 0, 'format': 'novel'},
        {'id': 'd', 'names': ['Solo Leveling: Ragnarok'], 'createdAt': 0},
      ],
      'reading': [
        read('a', 90, 'https://mgread.io/manga/the-mythical-weapon-creation-of-the-regressed-genius-player/chapter-90/', 7200000),
        read('b', 343, 'https://asurascans.com/comics/overgeared-11fe7da3/chapter/343', 86400000 * 6),
        read('c', 614, 'https://novel.site/versatile-mage/chapter-614', 3600000),
        read('d', 41, 'https://asuracomic.net/series/solo-leveling-ragnarok-7f873ca6/chapter/41', 86400000 * 2),
      ],
      'chapters': [],
      'updates': [
        {'workId': 'a', 'latest': 100, 'url': 'https://mgread.io/manga/the-mythical-weapon-creation-of-the-regressed-genius-player/chapter-100/', 'site': 'mgread.io', 'checkedAt': now},
        {'workId': 'b', 'latest': 344, 'url': 'https://asurascans.com/comics/overgeared-11fe7da3/chapter/344', 'site': 'asurascans.com', 'checkedAt': now},
      ],
      'ntfyTopic': 'manga-index-test',
    });
    await shoot(tester, LibraryScreen(api: FakeLibraryApi(library), onUnpaired: () {}, onConnect: () {}), 'p5-library');
  }, skip: out == null);

  testWidgets('browser start page', (tester) async {
    tester.view.physicalSize = phone * ratio;
    tester.view.devicePixelRatio = ratio;
    WorkView view(String id, String name, String url, double chapter) => WorkView(
        Work(id: id, names: [name], createdAt: 0, isNovel: false),
        [ReadingRecord(workId: id, chapter: chapter, read: false, progress: 0.4, url: url, source: 'browser', updatedAt: now)],
        []);
    final recent = [
      view('a', 'The Mythical Weapon Creation of the Regressed Genius Player', 'https://mgread.io/manga/the-mythical/chapter-90/', 90),
      view('b', 'Solo Leveling: Ragnarok', 'https://asuracomic.net/series/solo-leveling-ragnarok/chapter/42', 42),
      view('c', 'Overgeared', 'https://www.mgeko.cc/reader/en/overgeared-chapter-335/', 335),
    ];
    // The app bar as the browser shows it on a chapter it is following (the page itself is a WebView,
    // which tests cannot draw).
    final screen = Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: TextField(
          decoration: InputDecoration(
            hintText: 'Digite o site ou pesquise',
            prefixIcon: const Icon(Icons.search, size: 20),
            prefixIconConstraints: const BoxConstraints(minWidth: 36),
            filled: true,
            fillColor: Colors.white.withValues(alpha: 0.08),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
            contentPadding: const EdgeInsets.symmetric(vertical: 10),
            isDense: true,
          ),
          style: TextStyle(fontSize: 14),
        ),
        actions: [
          const Chip(
            visualDensity: VisualDensity.compact,
            label: Text('90 · 40%'),
            labelStyle: TextStyle(color: Color(0xFFFF8A5C), fontSize: 12),
          ),
          IconButton(onPressed: () {}, icon: const Icon(Icons.more_vert)),
        ],
      ),
      body: BrowserStartPage(recent: recent, onOpen: (_) {}),
    );
    await shoot(tester, screen, 'p4-browser');
  }, skip: out == null);

  testWidgets('downloads and data screens', (tester) async {
    tester.view.physicalSize = phone * ratio;
    tester.view.devicePixelRatio = ratio;
    final docs = Directory.systemTemp.createTempSync('mi-shots');
    Downloads.root = docs;
    SharedPreferences.setMockInitialValues({});
    final api = Api(Connection.none());
    await tester.runAsync(() async {
      for (final (i, chapter) in [(1, 90.0), (2, 91.0)]) {
        final id = PhoneChapter.idOf('https://mgread.io/manga/the-mythical/chapter-${chapter.round()}/');
        await Downloads.save(id, [37, 80, 68, 70]);
        await PhoneChapter.add(PhoneChapter(
          id: id,
          url: 'https://mgread.io/manga/the-mythical/chapter-${chapter.round()}/',
          title: 'The Mythical Weapon Creation — capítulo ${chapter.round()}',
          work: 'The Mythical Weapon Creation',
          chapter: chapter,
          pages: 40 + i,
          savedAt: i,
        ));
      }
    });
    await shoot(tester, DownloadsScreen(api: api), 'p6-downloads');
    await shoot(tester, DataScreen(api: api), 'p7-data');
  }, skip: out == null);

  // The collection, a work's page, the search and "Vários capítulos" with covers: COVERS=<folder of
  // <id>.jpg>, the PC's work covers.
  group('with covers', () {
    final coversDir = Platform.environment['COVERS'];
    late Api coverApi;
    late Library library;
    late Directory support;

    setUpAll(() async {
      if (out == null || coversDir == null) return;
      // The covers as the phone keeps them once seen (theme.dart), so no request goes out.
      support = Directory.systemTemp.createTempSync('mi-support');
      Directory('${support.path}/covers').createSync();
      for (final f in Directory(coversDir).listSync().whereType<File>()) {
        f.copySync('${support.path}/covers/api-work-cover-${f.uri.pathSegments.last}');
      }
      final ids = Directory(coversDir).listSync().whereType<File>().map((f) => f.uri.pathSegments.last.replaceAll('.jpg', '')).toList()..sort();
      coverApi = FakeLibraryApi(Library(works: [], reading: [], chapters: []));
      Map<String, dynamic> read(String id, num chapter, int ago, {bool done = true, double? progress}) => {
            'workId': id,
            'chapter': chapter,
            'status': done ? 'read' : 'reading',
            'progress': progress ?? 1,
            'url': 'https://mgread.io/manga/x/chapter-$chapter/',
            'source': 'browser',
            'updatedAt': now - ago,
          };
      final names = [
        'Return of the Mount Hua Sect',
        "Omniscient Reader's Viewpoint",
        'Solo Leveling',
        'The Mythical Weapon Creation of the Regressed Genius Player',
        'The Max Level Hero Has Returned!',
        'Nano Machine',
        'The Greatest Estate Developer',
        'Tower of God',
      ];
      library = Library.fromJson({
        'works': [
          for (final (i, name) in names.indexed)
            {
              'id': i < ids.length ? ids[i] : 'w$i',
              'names': [name],
              'createdAt': 0,
              'hasCover': i < ids.length,
              'latest': [184, 262, 200, 101, 251, 335, 223, 652][i],
              if (i == 2) 'shelf': 'done',
              if (i == 6 || i == 7) 'shelf': 'plan',
              if (i < 3) 'favorite': true,
            },
          {'id': 'novel', 'names': ['Versatile Mage'], 'createdAt': 0, 'format': 'novel'},
          {'id': 'none', 'names': ['Logando 10.000 Anos no Futuro'], 'createdAt': 0},
        ],
        'reading': [
          for (final (i, chapter) in [120, 150, 200, 58, 30, 200, 60].indexed) read(i < ids.length ? ids[i] : 'w$i', chapter, 3600000 * (i + 1)),
          read(ids.length > 3 ? ids[3] : 'w3', 59, 600000, done: false, progress: 0.3),
          read('novel', 614, 86400000),
          read('none', 90, 86400000 * 3),
        ],
        'chapters': [
          for (final n in [53, 54, 55, 56, 57])
            {
              'id': 'c$n',
              'title': 'cap $n',
              'workId': ids.length > 3 ? ids[3] : 'w3',
              'chapter': n,
              'pageCount': 14,
              'translatedPages': 14,
              'createdAt': now - 86400000 * 20,
              'source': 'https://mangadex.org/chapter/x$n',
            },
          // The same chapter from another site: a second version of it.
          {
            'id': 'c57b',
            'title': 'cap 57',
            'workId': ids.length > 3 ? ids[3] : 'w3',
            'chapter': 57,
            'pageCount': 14,
            'translatedPages': 14,
            'createdAt': now - 86400000 * 2,
            'source': 'https://www.mgeko.cc/reader/en/x-chapter-57/',
          },
        ],
        'updates': [
          {'workId': ids.first, 'latest': 184, 'url': 'https://mgeko.cc/x/chapter-184/', 'site': 'mgeko.cc', 'checkedAt': now},
          {'workId': ids[1], 'latest': 262, 'url': 'https://mangadex.org/chapter/x', 'site': 'mangadex.org', 'checkedAt': now},
        ],
      });
    });

    setUp(() {
      if (out == null || coversDir == null) return;
      PathProviderPlatform.instance = FakePaths(support.path);
    });

    testWidgets('collection', (tester) async {
      tester.view.physicalSize = phone * ratio;
      tester.view.devicePixelRatio = ratio;
      SharedPreferences.setMockInitialValues({});
      final api = FakeLibraryApi(library);
      await shoot(tester, LibraryScreen(api: api, onUnpaired: () {}, onConnect: () {}), 'm1-home');
      await tester.tap(find.text('Biblioteca').last);
      await settle(tester);
      await capture(tester, 'm2-collection');
    }, skip: out == null || coversDir == null);

    testWidgets('work page', (tester) async {
      tester.view.physicalSize = phone * ratio;
      tester.view.devicePixelRatio = ratio;
      SharedPreferences.setMockInitialValues({});
      Downloads.root = Directory.systemTemp.createTempSync('mi-work');
      Directory('${Downloads.root!.path}/chapters').createSync();
      final view = library.views.firstWhere((v) => v.work.name.startsWith('The Mythical'));
      await shoot(tester, WorkScreen(view: view, api: coverApi), 'm3-work');
    }, skip: out == null || coversDir == null);

    testWidgets('search', (tester) async {
      tester.view.physicalSize = phone * ratio;
      tester.view.devicePixelRatio = ratio;
      await shoot(tester, SearchScreen(api: coverApi, views: library.views), 'm4-search', act: (tester) async {
        await tester.enterText(find.byType(TextField), 'the');
      });
    }, skip: out == null || coversDir == null);

    testWidgets('several chapters', (tester) async {
      tester.view.physicalSize = phone * ratio;
      tester.view.devicePixelRatio = ratio;
      final thumb = 'data:image/jpeg;base64,${base64Encode(File('$coversDir/${Directory(coversDir!).listSync().whereType<File>().first.uri.pathSegments.last}').readAsBytesSync())}';
      final api = FakeBatchApi(port: 1, thumb: thumb);
      await shoot(tester, BatchScreen(api: api, query: 'Return of the Mount Hua Sect'), 'm5-batch', act: (tester) async {
        await tester.tap(find.text('Return of the Mount Hua Sect').last);
      });
    }, skip: out == null || coversDir == null);
  });
}
