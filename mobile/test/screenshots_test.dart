// Pictures of the screens without a phone or emulator: SCREENSHOTS=<folder> flutter test test/screenshots_test.dart
// (PAGES=<folder with translated pages, pNN-after.png> for the reader). Skipped otherwise.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:manga_index/api.dart';
import 'package:manga_index/downloads.dart';
import 'package:manga_index/models.dart';
import 'package:manga_index/reader_screen.dart';
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

ThemeData theme() => ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFFF5D73), brightness: Brightness.dark, surface: const Color(0xFF1D1F26)),
      scaffoldBackgroundColor: const Color(0xFF14151A),
      useMaterial3: true,
    );

Future<void> shoot(WidgetTester tester, Widget screen, String name) async {
  final boundary = GlobalKey();
  await tester.pumpWidget(RepaintBoundary(
    key: boundary,
    child: MaterialApp(debugShowCheckedModeBanner: false, theme: theme(), home: screen),
  ));
  await tester.runAsync(() async {
    // Images decode outside the fake clock.
    for (final element in find.byType(Image).evaluate()) {
      await precacheImage((element.widget as Image).image, element);
    }
    await Future<void>.delayed(const Duration(milliseconds: 200));
  });
  await tester.pump(const Duration(seconds: 1));
  await tester.runAsync(() async {
    final render = boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
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
}
