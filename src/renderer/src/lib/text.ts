/** Letters and digits only, lower case: what is left of a text once punctuation and spacing go. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Dice coefficient on character bigrams, or containment (a block cut by a slice edge is a prefix/suffix). */
export function similarText(a: string, b: string): boolean {
  const x = normalizeText(a)
  const y = normalizeText(b)
  if (!x || !y) return false
  // A piece of a cut block is a good part of it; two letters found inside a long text are no copy of it
  // ("TL" in "STATUS WINDOW TITLE...").
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (long.includes(short)) return short.length >= Math.min(8, long.length * 0.4)
  const grams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const gx = grams(x)
  const gy = grams(y)
  let common = 0
  for (const [g, n] of gx) common += Math.min(n, gy.get(g) ?? 0)
  return (2 * common) / Math.max(1, x.length - 1 + y.length - 1) > 0.6
}
