import '@fontsource/comic-neue/latin-300.css'
import '@fontsource/comic-neue/latin-400.css'
import '@fontsource/comic-neue/latin-700.css'
import '@fontsource/bangers/latin-400.css'
import '@fontsource/oswald/latin-200.css'
import '@fontsource/oswald/latin-300.css'
import '@fontsource/oswald/latin-400.css'
import '@fontsource/oswald/latin-500.css'
import '@fontsource/oswald/latin-600.css'
import '@fontsource/kalam/latin-400.css'
import '@fontsource/kalam/latin-700.css'
import '@fontsource/roboto/latin-400.css'
import '@fontsource/roboto/latin-700.css'
import '@fontsource/noto-serif/latin-400.css'
import '@fontsource/noto-serif/latin-700.css'
import { FONTS } from './fontFaces'

export { FONTS, type FontFace } from './fontFaces'

let ready: Promise<void> | null = null

/** Canvas text only uses fonts that are already loaded; call before drawing. */
export function ensureFonts(): Promise<void> {
  ready ??= Promise.all(
    Object.values(FONTS).flatMap((f) => f.weights.map((w) => document.fonts.load(`${w} 20px ${f.family}`, 'AÃÇÉ')))
  ).then(() => undefined)
  return ready
}
