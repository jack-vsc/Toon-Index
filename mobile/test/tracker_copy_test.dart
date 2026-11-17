import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the browser inside the app runs the same tracker as the PC extension', () {
    final extension = File('../extension/content.js').readAsStringSync().replaceAll('\r\n', '\n');
    final copy = File('assets/reading_tracker.js').readAsStringSync().replaceAll('\r\n', '\n');
    expect(copy, extension, reason: 'Copy extension/content.js to mobile/assets/reading_tracker.js');
  });
}
