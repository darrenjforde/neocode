// neocode's pure maths: how far each transcript row has decayed, which of its
// cells are corrupted, and the glyph and colour every cell shows at time `t`.
//
// Nothing here touches `$`, the screen or any file. Every frame is a pure
// function of (cell position, distance from the prompt, time), so the effect
// needs no per-cell state and costs nothing while nothing is on screen.

/** A row's text as columns `[start, end)`; `[0, 0]` is a blank row. */
export type Extent = readonly [start: number, end: number]

/** How far up the screen the decay starts and where it is total. */
export type Reach = 'gentle' | 'balanced' | 'deep'

/** `katakana`: authentic Matrix glyphs. `letters`: ASCII only, for fonts without half-width katakana. */
export type GlyphSet = 'katakana' | 'letters'

/** One painted cell: a code point and a 0xRRGGBB foreground. */
export type Cell = { glyph: number; color: number }

/** Rows whose corruption reaches this are painted whole: full digital rain. */
export const BLOCK = 0.8

// --- glyphs -----------------------------------------------------------------

const codes = (s: string): number[] => [...s].map(ch => ch.codePointAt(0)!)

// Half-width katakana (U+FF66..U+FF9D) are one cell wide, like the film's.
const KATAKANA = Array.from({ length: 0xff9d - 0xff66 + 1 }, (_, i) => 0xff66 + i)
// Weighted so katakana dominate, with the film's digits and a few symbols.
const MATRIX = [...KATAKANA, ...KATAKANA, ...codes('0123456789'), ...codes(':.=*+-<>¦|"')]
// Code-ish ASCII: what the first stage of decay scrambles letters into.
const LETTERS = codes('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789{}[]()<>=+-*/_;:$#&')

// --- randomness ---------------------------------------------------------------

/** A stable hash of up to three integers into [0, 1). Same inputs, same output. */
export function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2545f491)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** A stable integer seed for a string (a message's id). */
export function seedOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

// --- decay --------------------------------------------------------------------

// [clean, full]: fractions of the transcript's height above the prompt where
// the decay starts and where it is complete.
const REACH: Record<Reach, readonly [number, number]> = {
  gentle: [0.45, 1.0],
  balanced: [0.25, 0.8],
  deep: [0.1, 0.6],
}

/**
 * How decayed a row is, 0 (readable) to 1 (pure rain), from its distance in
 * rows above the bottom of the transcript and the transcript's height.
 */
export function corruption(distance: number, viewRows: number, reach: Reach): number {
  const [clean, full] = REACH[reach] ?? REACH.balanced
  const x = (distance / Math.max(1, viewRows) - clean) / (full - clean)
  if (x <= 0) return 0
  if (x >= 1) return 1
  return x * x * (3 - 2 * x) // smoothstep: eases in and out of the band
}

/**
 * The runs of a partly decayed row that are corrupted: the row's text cut into
 * short segments, each corrupted once `c` passes its own stable threshold, so
 * decay eats into the code bite by bite instead of flickering at random.
 */
export function bites([start, end]: Extent, c: number, seed: number): Extent[] {
  const out: [number, number][] = []
  const p = Math.min(1, c / BLOCK)
  for (let x = start, i = 0; x < end; i++) {
    const len = 2 + Math.floor(hash(seed, i, 7) * 5)
    if (hash(seed, i, 11) < p) {
      const last = out[out.length - 1]
      if (last && last[1] === x) last[1] = Math.min(end, x + len)
      else out.push([x, Math.min(end, x + len)])
    }
    x += len
  }
  return out
}

// --- layout estimates ------------------------------------------------------------
//
// The engine draws each transcript row itself; a mod is told how many rows a
// message has, not what is in them. These estimates say roughly where the
// text sits, so decay lands on code rather than on empty space. Being off by
// a little is invisible: the cells it lands on are being scrambled anyway.

function wrap(out: Extent[], line: string, indent: number, columns: number): void {
  const lead = line.length - line.trimStart().length
  const text = line.trimEnd()
  const width = Math.max(1, columns - indent)
  if (!text.trim()) {
    out.push([0, 0])
    return
  }
  for (let i = 0; i < text.length; i += width) {
    out.push([indent + (i === 0 ? lead : 0), indent + Math.min(width, text.length - i)])
  }
}

/** An assistant reply: row 0 is the blank above it, fences take no row, text wraps under a 2-column indent. */
export function markdownExtents(markdown: string, columns: number): Extent[] {
  const out: Extent[] = [[0, 0]]
  let isFenced = false
  for (const raw of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      isFenced = !isFenced
      continue
    }
    const line = isFenced ? raw : raw.replace(/^(\s*)#+\s+/, '$1').replace(/\*\*|__|`/g, '')
    wrap(out, line, 2, columns)
  }
  return out
}

/** Any other row: a blank, a header line, then the text indented under it. */
export function plainExtents(header: string, body: string, columns: number, indent = 6): Extent[] {
  const out: Extent[] = [[0, 0]]
  if (header) wrap(out, header, 0, columns)
  for (const line of body ? body.split('\n') : []) wrap(out, line, indent, columns)
  return out
}

/** The longest string anywhere inside a tool's input or output: usually the code. */
export function longestText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value
  if (depth > 4 || value === null || typeof value !== 'object') return ''
  let best = ''
  for (const v of Object.values(value)) {
    const s = longestText(v, depth + 1)
    if (s.length > best.length) best = s
  }
  return best
}

// --- colour -------------------------------------------------------------------

function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff
    return Math.round(x + (((b >> shift) & 0xff) - x) * t) << shift
  }
  return ch(16) | ch(8) | ch(0)
}

// Phosphor green, dark to the near-white of a falling glyph's head.
const RAMP: readonly [number, number][] = [
  [0, 0x001a06],
  [0.35, 0x00701c],
  [0.7, 0x00c838],
  [0.9, 0x4dff7c],
  [1, 0xd8ffe0],
]

/** The rain's green at a brightness from 0 to 1. */
export function green(level: number): number {
  const l = Math.max(0, Math.min(1, level))
  for (let i = 1; i < RAMP.length; i++) {
    const [b, cb] = RAMP[i]!
    const [a, ca] = RAMP[i - 1]!
    if (l <= b) return mix(ca, cb, (l - a) / (b - a))
  }
  return RAMP[RAMP.length - 1]![1]
}

// The tint decaying code starts from: a pale grey, before it turns green.
const PALE = 0xc6cfc6

// --- the rain -------------------------------------------------------------------

/**
 * How much of the rain over a streaming reply to keep, 1 to 0, from the
 * reply's height so far against the window's. The rain over a stream hangs
 * from the row above it, which the engine stops drawing once the reply pushes
 * it off the top (at about the window's height); this thins the rain out over
 * the last stretch before that, ending a little early to allow for the
 * reply's height being an estimate.
 */
export function streamFade(streamRows: number, windowRows: number): number {
  const x = (0.92 * windowRows - streamRows) / (0.22 * windowRows)
  if (x <= 0) return 0
  if (x >= 1) return 1
  return x * x * (3 - 2 * x)
}

/** Where the upward ripple is now, in rows above the prompt. */
export function waveAt(t: number, viewRows: number): number {
  return (t * 22) % (viewRows * 1.5 + 8)
}

/**
 * The upward rain in screen column `x` at distance `d` above the prompt:
 * 1 at a trail's head, fading to 0 at its tail, 0 between trails. Trails are
 * anchored to the screen, not the text, and climb at a per-column speed: the
 * film's rain, reversed.
 */
export function rain(x: number, d: number, t: number): number {
  const speed = 4 + 10 * hash(x, 1)
  const length = 6 + 14 * hash(x, 2)
  const period = length + 6 + 22 * hash(x, 3)
  const head = (t * speed + hash(x, 4) * period) % period
  const behind = (((head - d) % period) + period) % period
  return behind < length ? 1 - behind / length : 0
}

function pick(set: readonly number[], h: number): number {
  return set[Math.floor(h * set.length) % set.length] ?? 0x20
}

/**
 * The cell at screen column `x` of a row: `row` is a stable id for the row
 * (so each cell keeps its own rhythm), `d` its distance above the prompt, `c`
 * its corruption, `isText` whether the code has a character there.
 * `density` (0 to 1) thins the rain out evenly, cell by cell, for a fade.
 *
 * Returns `null` for a cell the overlay leaves blank (rain-free empty space).
 */
export function paint(
  x: number,
  row: number,
  d: number,
  c: number,
  isText: boolean,
  t: number,
  wave: number,
  glyphs: GlyphSet,
  density = 1,
): Cell | null {
  // A fading cell drops out for good once density falls below its own threshold.
  if (density < 1 && hash(x, row, 12) >= density) return null
  const trail = rain(x, d, t)
  const isHead = trail > 0.93
  const nearWave = Math.abs(d - wave) < 1.5
  // Each cell changes glyph at its own rate; heads and the ripple churn every frame.
  const rate = 0.6 + 5 * hash(x, row, 5)
  const epoch = isHead || nearWave ? Math.floor(t * 30) : Math.floor(t * rate + hash(x, row, 6) * 10)
  const h = hash(x * 131 + row, epoch, 9)
  const matrix = glyphs === 'letters' ? LETTERS : MATRIX

  if (c < BLOCK) {
    // The transition band: scrambled letters first, then glyphs, greening as they go.
    const p = c / BLOCK
    const glyph = pick(hash(x, row, epoch + 3) < p ? matrix : LETTERS, h)
    let color = mix(PALE, green(0.6 + 0.3 * trail), Math.min(1, p * 1.3))
    if (nearWave) color = mix(color, green(1), 0.7)
    return { glyph, color }
  }

  // Full rain. Where the code was, every cell is a glyph; empty space fills
  // with climbing trails as decay completes.
  const fill = (c - BLOCK) / (1 - BLOCK)
  if (!isText && !(trail > 0 && hash(x, row, 8) < fill)) return null
  const level = isHead ? 1 : isText ? 0.3 + 0.2 * c + 0.5 * trail : 0.12 + 0.8 * trail
  return { glyph: pick(matrix, h), color: green(nearWave ? Math.max(level, 0.85) : level) }
}
