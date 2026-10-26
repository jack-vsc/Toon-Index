import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:manga_index/site_download.dart';

// A PDF made from JPEGs, as the phone saves chapters downloaded from a site. PDF_OUT keeps it to look at.
void main() {
  test('pdf from jpegs', () {
    final jpeg = File('../samples/eval/base/p01-1.jpg').readAsBytesSync();
    final pdf = pdfFromJpegs([JpegPage(jpeg, 1172, 652), JpegPage(jpeg, 1172, 652)]);
    expect(String.fromCharCodes(pdf.take(8)), '%PDF-1.4');
    final out = Platform.environment['PDF_OUT'];
    if (out != null) File(out).writeAsBytesSync(pdf);
  });
}
