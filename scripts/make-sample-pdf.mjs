// Generates a tiny original "manga" chapter (shapes + English speech bubbles) for local testing.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const W = 600
const H = 900

const pages = [
  [
    { x: 160, y: 760, rx: 120, ry: 70, lines: ['Hey! Wait up!', "You forgot", 'your bag!'] },
    { x: 440, y: 540, rx: 110, ry: 60, lines: ['Oh no...', 'Thanks a lot!'] },
    { x: 180, y: 220, rx: 130, ry: 65, lines: ["Let's hurry,", "we're late", 'for class.'] }
  ],
  [
    { x: 430, y: 780, rx: 125, ry: 65, lines: ['Did you study', 'for the test?'] },
    { x: 170, y: 470, rx: 120, ry: 70, lines: ['Not at all.', 'I fell asleep', 'reading manga.'] },
    { x: 400, y: 170, rx: 120, ry: 55, lines: ['Typical...'] }
  ]
]

const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.HelveticaBold)

for (const bubbles of pages) {
  const page = pdf.addPage([W, H])
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) })
  // panel borders and some "art" lines
  for (const [y, h] of [[620, 260], [330, 270], [20, 290]]) {
    page.drawRectangle({ x: 20, y, width: W - 40, height: h, borderColor: rgb(0, 0, 0), borderWidth: 3 })
    for (let i = 0; i < 8; i++) {
      page.drawLine({
        start: { x: 30 + i * 70, y: y + 10 },
        end: { x: 60 + i * 70, y: y + h * 0.45 },
        thickness: 1.5,
        color: rgb(0.35, 0.35, 0.35)
      })
    }
  }
  for (const b of bubbles) {
    page.drawEllipse({ x: b.x, y: b.y, xScale: b.rx, yScale: b.ry, color: rgb(1, 1, 1), borderColor: rgb(0, 0, 0), borderWidth: 2.5 })
    const size = 15
    b.lines.forEach((line, i) => {
      const width = font.widthOfTextAtSize(line, size)
      const top = b.y + ((b.lines.length - 1) * size * 1.2) / 2
      page.drawText(line, { x: b.x - width / 2, y: top - i * size * 1.2 - size / 3, size, font, color: rgb(0, 0, 0) })
    })
  }
}

mkdirSync(join(root, 'samples'), { recursive: true })
writeFileSync(join(root, 'samples', 'teste-capitulo.pdf'), await pdf.save())
console.log('samples/teste-capitulo.pdf')
