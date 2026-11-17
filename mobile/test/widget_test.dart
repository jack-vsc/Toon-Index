import 'package:flutter_test/flutter_test.dart';
import 'package:manga_index/library_screen.dart';
import 'package:manga_index/models.dart';

Map<String, dynamic> record(String workId, num chapter, String status, {num? progress, String url = '', int at = 0}) =>
    {'workId': workId, 'chapter': chapter, 'status': status, 'progress': progress, 'url': url, 'source': 'browser', 'updatedAt': at};

void main() {
  final now = DateTime.now().millisecondsSinceEpoch;
  final library = Library.fromJson({
    'works': [
      {'id': 'a', 'names': ['Solo Leveling', 'Nível Solo'], 'createdAt': 0},
      {'id': 'b', 'names': ['versatile mage'], 'createdAt': 0, 'format': 'novel'},
      {'id': 'c', 'names': ['Unread'], 'createdAt': 0},
    ],
    'reading': [
      record('a', 53, 'read', progress: 1, at: now - 3600000),
      record('a', 54, 'reading', progress: 0.4, url: 'https://www.site.com/solo/chapter-54', at: now - 120000),
      record('b', 614, 'reading', at: now - 86400000 * 3),
    ],
    'chapters': [],
  });

  test('works with readings, the most recent first; works with nothing are left out', () {
    expect(library.views.map((v) => v.work.id), ['a', 'b']);
  });

  test('where a work was left', () {
    final solo = library.views.first;
    expect(solo.readUpTo, 53);
    expect(solo.current!.chapter, 54);
    expect(solo.continueUrl, 'https://www.site.com/solo/chapter-54');
    expect(statusText(solo), 'Lido até o cap. 53 · parou no cap. 54 (40%) · site.com · há 2 min');
    expect(statusText(library.views[1]), 'Parou no cap. 614 · há 3 dias');
  });

  test('a work with a new chapter out comes first', () {
    final json = {
      'works': [
        {'id': 'a', 'names': ['Solo Leveling'], 'createdAt': 0},
        {'id': 'b', 'names': ['versatile mage'], 'createdAt': 0, 'format': 'novel'},
      ],
      'reading': [record('a', 54, 'read', at: now), record('b', 614, 'read', at: now - 86400000)],
      'chapters': [],
      'updates': [
        {'workId': 'b', 'latest': 615, 'url': 'https://novel.site/versatile-mage/615', 'site': 'novel.site', 'checkedAt': now, 'work': 'Versatile Mage'},
      ],
      'ntfyTopic': 'manga-index-abc',
    };
    final updated = Library.fromJson(json);
    expect(updated.views.map((v) => v.work.id), ['b', 'a']);
    expect(updateText(updated.views.first.update!), '🆕 Cap. 615 saiu · novel.site');
    expect(updated.ntfyTopic, 'manga-index-abc');
    // A PC from before the checks sends neither.
    expect(library.views.every((v) => v.update == null), isTrue);
    expect(library.ntfyTopic, isNull);
  });

  test('search by any name, ignoring accents and case', () {
    expect(library.views.first.matches('nivel'), isTrue);
    expect(library.views.first.matches('mage'), isFalse);
  });

  test('names from links are capitalized; chapters print without .0', () {
    expect(displayName('versatile mage'), 'Versatile Mage');
    expect(chapterLabel(53), '53');
    expect(chapterLabel(53.5), '53.5');
  });
}
