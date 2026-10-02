/**
 * Parses JSON as models write it. Their usual slips: quotes from the lettering left unescaped inside
 * strings, raw line breaks in strings, missing or trailing commas, and a cut-off end. When the whole
 * thing still does not parse, every block that does is kept.
 */
export function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    const repaired = repair(text)
    try {
      return JSON.parse(repaired)
    } catch {
      const blocks = salvageBlocks(repaired)
      if (!blocks.length) throw err
      return { blocks }
    }
  }
}

const LITERAL = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/

/** Rewrites `text` (starting at its first bracket) into valid JSON where the intent is clear. */
export function repair(text: string): string {
  let out = ''
  const stack: string[] = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') {
        const next = text[i + 1]
        if (next !== undefined && '"\\/bfnrtu'.includes(next)) (out += c + next), i++
        else out += '\\\\'
      } else if (c === '"') {
        if (closesString(text, i + 1)) (inString = false), (out += c)
        else out += '\\"'
      } else if (c === '\n') out += '\\n'
      else if (c === '\r') out += '\\r'
      else if (c === '\t') out += '\\t'
      else if (c >= ' ') out += c
      continue
    }
    if (c === '"') {
      out = separate(out)
      inString = true
      out += c
    } else if (c === '{' || c === '[') {
      out = separate(out)
      stack.push(c)
      out += c
    } else if (c === '}' || c === ']') {
      if (!stack.length) break
      out = out.replace(/,\s*$/, '') + (stack.pop() === '{' ? '}' : ']')
      if (!stack.length) return out
    } else if (c === ',' || c === ':' || /\s/.test(c)) {
      out += c
    } else {
      const literal = LITERAL.exec(text.slice(i, i + 40))
      if (literal) {
        out = separate(out) + literal[0]
        i += literal[0].length - 1
      }
    }
  }
  if (inString) out += '"'
  out = out.replace(/[,:]\s*$/, '')
  while (stack.length) out += stack.pop() === '{' ? '}' : ']'
  return out
}

/** Adds the comma a model forgot between two values. */
function separate(out: string): string {
  return /["}\]\del]\s*$/.test(out) ? out.replace(/\s*$/, ',') : out
}

/**
 * Whether a quote inside a string ends it: only when what follows fits the JSON around it (a colon, a
 * closing bracket, a comma before the next key or value, or the next key itself). A quote from the
 * lettering is followed by more text.
 */
function closesString(text: string, from: number): boolean {
  const rest = text.slice(from, from + 200)
  return /^\s*(?:$|[:}\]]|,\s*(?:$|["{[\]}\d-]|true|false|null)|"[^"\\\n]*"\s*:)/.test(rest)
}

/** Every complete object that has a "translation", wherever it sits. */
function salvageBlocks(text: string): unknown[] {
  const found: unknown[] = []
  const starts: number[] = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') starts.push(i)
    else if (c === '}' && starts.length) {
      const chunk = text.slice(starts.pop(), i + 1)
      if (!chunk.includes('"translation"')) continue
      try {
        const item = JSON.parse(chunk)
        if (item && typeof item === 'object' && 'translation' in item) found.push(item)
      } catch {
        // A broken block is lost; the rest of the page is still translated.
      }
    }
  }
  return found
}
