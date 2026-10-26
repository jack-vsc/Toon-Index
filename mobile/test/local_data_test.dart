import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:manga_index/local_data.dart';
import 'package:shared_preferences/shared_preferences.dart';

// The phone finds works and chapters as the PC does: parity.json is what src/shared/works.ts answers.
void main() {
  final parity = jsonDecode(File('test/parity.json').readAsStringSync()) as Map<String, dynamic>;

  test('chapter names as on the PC', () {
    for (final c in (parity['parse'] as List).cast<Map<String, dynamic>>()) {
      final u = c['u'] as String;
      final got = parseChapterName(c['t'] as String, u.isEmpty ? null : u);
      expect((work: got.work, chapter: got.chapter), (work: c['r']['work'], chapter: (c['r']['chapter'] as num?)?.toDouble()), reason: '${c['t']} $u');
    }
  });

  test('same names as on the PC', () {
    for (final c in (parity['same'] as List).cast<Map<String, dynamic>>()) {
      expect(sameName(c['a'] as String, c['b'] as String), c['r'], reason: '${c['a']} / ${c['b']}');
      expect(normalizeName(c['a'] as String), c['n']);
    }
  });

  test('readings on the phone, then a backup merged', () async {
    SharedPreferences.setMockInitialValues({});
    final status = await LocalData.applyReport({
      'url': 'https://mgread.io/manga/the-mythical-weapon/chapter-53/',
      'title': 'The Mythical Weapon Creation – Chapter 53 - MGRead',
      'progress': 0.4,
      'finished': false,
      'at': 1000,
    });
    expect(status!['chapter'], 53.0);
    expect(status['status'], 'reading');
    await LocalData.applyReport({'url': 'https://mgread.io/manga/the-mythical-weapon/chapter-54/', 'title': 'The Mythical Weapon Creation – Chapter 54', 'progress': 0.1, 'finished': false, 'at': 2000});
    final library = await LocalData.library();
    expect(library.works, hasLength(1));
    // Opening 54 means 53 was finished.
    expect(library.reading.firstWhere((r) => r.chapter == 53).read, isTrue);
    final exported = await LocalData.export();
    SharedPreferences.setMockInitialValues({});
    await LocalData.applyReport({'url': 'https://x.com/the-mythical-weapon-creation/chapter-60', 'title': 'The Mythical Weapon Creation Chapter 60', 'progress': 1, 'finished': true, 'at': 3000});
    final (works, chapters) = await LocalData.merge(exported);
    expect((works, chapters), (1, 2));
    final merged = await LocalData.library();
    expect(merged.works, hasLength(1));
    expect(merged.reading.map((r) => r.chapter).toSet(), {53.0, 54.0, 60.0});
  });
}
