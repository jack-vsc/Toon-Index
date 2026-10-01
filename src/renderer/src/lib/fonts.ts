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
import type { FontRole } from '../../../shared/types'

export interface FontFace {
  /** CSS font-family list; system fonts cover scripts the bundled files lack. */
  family: string
  /** Bundled weights, lightest first. */
  weights: number[]
}

/**
 * Scanlation lettering conventions mapped onto bundled open-licence fonts. Slant, width and extra
 * weight are matched to the original when drawing, so upright faces are enough.
 */
export const FONTS: Record<FontRole, FontFace> = {
  comic: { family: '"Comic Neue", "Comic Sans MS", sans-serif', weights: [300, 400, 700] },
  brush: { family: 'Bangers, "Comic Neue", "Comic Sans MS", sans-serif', weights: [400] },
  condensed: { family: 'Oswald, "Arial Narrow", sans-serif', weights: [200, 300, 400, 500, 600] },
  sans: { family: 'Roboto, "Segoe UI", Arial, sans-serif', weights: [400, 700] },
  serif: { family: '"Noto Serif", Georgia, serif', weights: [400, 700] },
  handwritten: { family: 'Kalam, "Segoe Print", cursive', weights: [400, 700] }
}

let ready: Promise<void> | null = null

/** Canvas text only uses fonts that are already loaded; call before drawing. */
export function ensureFonts(): Promise<void> {
  ready ??= Promise.all(
    Object.values(FONTS).flatMap((f) => f.weights.map((w) => document.fonts.load(`${w} 20px ${f.family}`, 'AÃÇÉ')))
  ).then(() => undefined)
  return ready
}
