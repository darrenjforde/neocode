// neocode: the transcript decays into Matrix rain as it scrolls up the screen.
//
// How it works, in one pass:
//   1. Every transcript row (reply, tool call, prompt, ...) is drawn by the
//      engine as usual. A `ui.render` hook wraps that drawing and lays
//      `Raster` cell grids over the parts that should look decayed, using
//      `position: "absolute"` so nothing underneath moves.
//   2. The engine tells each row which of its lines are on screen
//      (`onScreen`) and how tall it is. Stacking those heights from the
//      bottom gives every line's distance above the prompt box, which sets
//      how decayed it is.
//   3. A timer repaints the mounted rasters with `$.ui.blit` (no re-render),
//      so glyphs churn and trails climb while the text underneath is static.
//
// What it touches, all of it: it hooks no event that carries conversation
// data (`session.append`, `tool.call`, `prompt.*`), rewrites no props, opens
// no network connection, runs no process and writes no file. Its own
// `$.store` keeps two flags (the /neocode toggle, and whether the fullscreen
// hint was shown); it reads one setting (`prefersReducedMotion`). The overlay
// exists only in the terminal's drawing; the one thing it does outside it is
// keep mouse copies clean (see syncPaused).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, MatchedHook, Register } from 'claude-code'

import {
  BLOCK,
  bites,
  corruption,
  hash,
  longestText,
  markdownExtents,
  paint,
  plainExtents,
  seedOf,
  waveAt,
} from './matrix'
import type { Extent, GlyphSet, Reach } from './matrix'

// --- session state (read while drawing, so a change redraws the readers) -----

const enabled = atom({ plugin: 'neocode', key: 'enabled' } as const, true)
const paused = atom({ plugin: 'neocode', key: 'paused' } as const, false)
const layout = atom({ plugin: 'neocode', key: 'layout' } as const, 0)

// Every transcript component the engine reports on-screen rows for.
const TRANSCRIPT = [
  'UserMessage',
  'AssistantMessage',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'CommandOutput',
  'TurnDuration',
  'InfoNotice',
] as const
type Draw = MatchedHook<'ui.render', { component: typeof TRANSCRIPT }>
type TranscriptInput = Parameters<Draw>[1]

// Rows of the fullscreen layout that are never transcript: prompt, rules, footer.
const CHROME_ROWS = 6

// --- module state (rebuilt on reload; the next render fills it again) --------

type OnScreen = { first: number; last: number; of: number }

/** What the engine last reported for a transcript row; `seq` is its order, top to bottom. */
type Entry = { seq: number; of: number }

/** One raster laid over a row: `rows` x `width` cells at (`row`, `col`) of the row's drawing. */
type Overlay = {
  key: string
  row: number
  col: number
  width: number
  rows: number
  isBlock: boolean
}

/** A row with overlays mounted, and what the frame timer needs to repaint them. */
type Mount = {
  requestId: string
  seed: number
  of: number
  below: number
  viewRows: number
  extents: Extent[]
  overlays: Overlay[]
}

const entries = new Map<string, Entry>()
const mounts = new Map<string, Mount>()
let nextSeq = 0
let bottomKey = ''
let isScrolled = false
let layoutDirtyAt = 0
let settings = { reach: 'balanced' as Reach, glyphs: 'katakana' as GlyphSet }

/** Records a row's reported size; flags a relayout when a row appears or changes height. */
function measure(key: string, shown: OnScreen | null): Entry {
  let entry = entries.get(key)
  if (!entry) {
    entry = { seq: nextSeq++, of: shown?.of ?? 0 }
    entries.set(key, entry)
    bottomKey = key
    layoutDirtyAt ||= Date.now()
  } else if (shown && shown.of !== entry.of) {
    entry.of = shown.of
    layoutDirtyAt ||= Date.now()
  }
  // The newest row is the bottom of the transcript: if any of it is out of
  // view, the person has scrolled away from the live end.
  if (key === bottomKey) isScrolled = !shown || shown.last < shown.of - 1
  return entry
}

/** Rows drawn below a row: the heights of every row that came after it. */
function rowsBelow(seq: number): number {
  let sum = 0
  for (const entry of entries.values()) if (entry.seq > seq) sum += entry.of
  return sum
}

/** Roughly where a row's text sits, line by line (see matrix.ts). */
function extentsOf(e: TranscriptInput, columns: number): Extent[] {
  switch (e.component) {
    case 'AssistantMessage':
      return markdownExtents(e.props.text, columns)
    case 'UserMessage':
    case 'CommandOutput':
    case 'InfoNotice':
      return plainExtents('', e.props.text, columns, 2)
    case 'ToolUse':
      return plainExtents(`  ${e.props.tool}()`, longestText(e.props.input), columns)
    case 'ToolResult':
      return plainExtents('', longestText(e.props.output), columns)
    default:
      return plainExtents(' '.repeat(36), '', columns)
  }
}

/** The rasters a row needs: one block over its fully decayed lines, small bites over the rest. */
function overlaysFor(m: Mount, shown: OnScreen, columns: number, prefix: string): Overlay[] {
  const out: Overlay[] = []
  let blockEnd = shown.first
  for (let r = shown.first; r <= shown.last; r++) {
    const d = m.of - 1 - r + m.below
    const c = corruption(d, m.viewRows, settings.reach)
    if (c <= 0) break // rows only get closer to the prompt from here
    if (c >= BLOCK && r === blockEnd) {
      blockEnd = r + 1
      continue
    }
    const extent = m.extents[r] ?? [0, 0]
    for (const [start, end] of bites(extent, c, hash(m.seed, r))) {
      out.push({ key: `${prefix}${r}_${start}`, row: r, col: start, width: end - start, rows: 1, isBlock: false })
    }
  }
  if (blockEnd > shown.first) {
    out.push({
      key: `${prefix}block`,
      row: shown.first,
      col: 0,
      width: Math.min(512, columns),
      rows: Math.min(256, blockEnd - shown.first),
      isBlock: true,
    })
  }
  return out
}

/** Packs one overlay's cells at time `t` as RasterProps.cells wants them. */
function cellsOf(m: Mount, o: Overlay, t: number): string {
  const words = new Uint32Array(o.width * o.rows * 3)
  const wave = waveAt(t, m.viewRows)
  for (let i = 0; i < o.rows; i++) {
    const r = o.row + i
    const d = m.of - 1 - r + m.below
    const c = corruption(d, m.viewRows, settings.reach)
    const [start, end] = m.extents[r] ?? [0, 0]
    const rowId = hash(m.seed, r) * 1e6
    for (let j = 0; j < o.width; j++) {
      const x = o.col + j
      const cell = paint(x, rowId, d, c, x >= start && x < end, t, wave, settings.glyphs)
      const at = (i * o.width + j) * 3
      words[at] = cell ? cell.glyph : 0x20
      words[at + 1] = cell ? cell.color : 0x01000000
      words[at + 2] = 0x01000000 // the terminal's own background
    }
  }
  // Uint8Array.prototype.toBase64 is in the mod runtime; TypeScript's es2023 lib predates it.
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}

// --- drawing -----------------------------------------------------------------

const draw: Draw = async ($, e, next) => {
  if (e.surface === 'terminal' && e.viewport?.isFullscreen === false) void hintFullscreen($)
  const key = `${e.component}:${e.requestId}`
  const shown = e.props.onScreen
  // `undefined` means this surface does not report rows (the main screen, a
  // desktop): neocode has nothing to measure and stays out of the way.
  const entry = shown === undefined || e.requestId === 'placeholder' ? undefined : measure(key, shown)

  const isOn = await read($, enabled)
  const isPaused = await read($, paused)
  await read($, layout) // subscribe: redraw when the rows below this one change
  const inner = await next(e)

  if (!entry || !shown || !isOn || isPaused || e.surface !== 'terminal' || !e.viewport) {
    mounts.delete(key)
    return inner
  }

  const columns = e.viewport.columns
  const mount: Mount = {
    requestId: e.requestId,
    seed: seedOf(key),
    of: shown.of,
    below: rowsBelow(entry.seq),
    viewRows: Math.max(4, e.viewport.rows - CHROME_ROWS),
    extents: extentsOf(e, columns),
    overlays: [],
  }
  // ToolUse and ToolResult share a requestId; prefixes keep their raster keys apart.
  mount.overlays = overlaysFor(mount, shown, columns, e.component === 'ToolResult' ? 'r' : 'u')
  if (mount.overlays.length === 0) {
    mounts.delete(key)
    return inner
  }
  mounts.set(key, mount)

  const { Box, Raster } = $.ui.resolve(e)
  const t = Date.now() / 1000
  return (
    <Box flexDirection="column">
      {inner}
      {mount.overlays.map(o => (
        <Box position="absolute" top={o.row} left={o.col}>
          <Raster key={o.key} columns={o.width} rows={o.rows} cells={cellsOf(mount, o, t)} />
        </Box>
      ))}
    </Box>
  )
}

// The rain needs the fullscreen renderer, the only one that reports rows on
// screen. Say so once, ever, rather than silently doing nothing.
let isHinted = false

async function hintFullscreen($: EngineInterface) {
  if (isHinted) return
  isHinted = true
  if (await $.store.get('fullscreenHinted')) return
  await $.store.set('fullscreenHinted', true)
  $.ui.toast('The Matrix rain needs the fullscreen renderer. Run /tui fullscreen', { timeoutMs: 10000 })
}

// --- the frame timer -----------------------------------------------------------

let frameNo = 0

function frame($: EngineInterface) {
  frameNo++
  const now = Date.now()
  const t = now / 1000

  // Geometry changed (a row arrived or grew): redraw once it settles.
  if (layoutDirtyAt && now - layoutDirtyAt > 120) {
    layoutDirtyAt = 0
    void update($, layout, n => (n ?? 0) + 1)
  }
  void syncPaused($)

  for (const [key, m] of mounts) {
    const wave = waveAt(t, m.viewRows)
    for (const o of m.overlays) {
      // Full-rain blocks animate every frame. Bites churn every third frame,
      // and every frame while the upward ripple passes through their row.
      const d = m.of - 1 - o.row + m.below
      if (!o.isBlock && Math.abs(d - wave) > 2 && (frameNo + o.row) % 3 !== 0) continue
      void $.ui.blit({ requestId: m.requestId, key: o.key, cells: cellsOf(m, o, t) }).then(r => {
        if ('deny' in r && r.deny) mounts.delete(key) // unmounted or resized: the next render remounts
      })
    }
  }
}

// A selection that starts while rain is drawn: its text then (glyphs and
// all), and when it was first seen; `at` is 0 once it needs no more checking.
let selectedOverRain: { text: string; at: number } | undefined

/**
 * Sets `paused`, which every overlay reads, and keeps copies clean.
 *
 * The rain steps aside while the transcript is scrolled away from the live
 * bottom, and while text is selected with the mouse. The terminal copies a
 * selection from what is on screen, so the overlay must be gone before the
 * button is released; the selection is reported live during a drag, which
 * gives a frame or two to clear it. A selection stays reported until the next
 * prompt or command runs, which is when the rain returns.
 *
 * A selection made faster than one frame (a double-click on a word, say) is
 * copied before the rain can step aside. Once the rain is gone the live
 * selection reads the real text underneath; if that differs from what it
 * read over the rain, the clipboard holds glyphs, so the real text goes there
 * instead. This only ever re-copies what the person themselves just selected.
 */
async function syncPaused($: EngineInterface) {
  const selection = await $.ui.selection()
  const isRaining = mounts.size > 0 // read before pausing clears the overlays
  const shouldPause = isScrolled || selection !== undefined
  if ((await read($, paused)) !== shouldPause) await update($, paused, () => shouldPause)

  if (selection === undefined) {
    selectedOverRain = undefined
  } else if (!selectedOverRain) {
    selectedOverRain = { text: selection.text, at: isRaining ? Date.now() : 0 }
  } else if (selectedOverRain.at && !isRaining && Date.now() - selectedOverRain.at > 150) {
    selectedOverRain.at = 0 // once per selection
    if (selection.text !== selectedOverRain.text) await $.ui.copy({ text: selection.text })
  }
}

// --- registration --------------------------------------------------------------

export const register: Register = (on, options) => {
  settings = {
    reach: (['gentle', 'balanced', 'deep'].includes(String(options.reach)) ? options.reach : 'balanced') as Reach,
    glyphs: (options.glyphs === 'letters' ? 'letters' : 'katakana') as GlyphSet,
  }
  const fps = Math.max(5, Math.min(30, Number(options.fps) || 15))

  on('session.start', async ($, e, next) => {
    // The person's last /neocode wins; otherwise the option, off for anyone
    // who has asked Claude Code to reduce motion. Only that one setting is read.
    const stored = await $.store.get('enabled')
    const { prefersReducedMotion } = await $.settings.read()
    const startOn = typeof stored === 'boolean' ? stored : options.enabled !== false && prefersReducedMotion !== true
    await update($, enabled, () => startOn)
    $.clock.every(Math.round(1000 / fps), () => frame($))
    try {
      await $.command.register({
        name: 'neocode',
        description: 'Toggle the Matrix rain over the transcript',
        argumentHint: '[on|off|status]',
        immediate: true,
      })
    } catch {
      // Another plugin owns /neocode; the effect still runs, just without the toggle.
    }
    return next(e)
  })

  // A /clear empties the transcript: forget every row measured so far.
  on('session.end', ($, e, next) => {
    entries.clear()
    mounts.clear()
    bottomKey = ''
    isScrolled = false
    return next(e)
  })

  // Answers with a toast and no `text`, so the toggle adds no transcript row.
  on('command.run', { command: 'neocode' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const was = await read($, enabled)
    const isOn = arg === 'on' ? true : arg === 'off' ? false : arg === 'status' ? was : !was
    if (isOn !== was) {
      await update($, enabled, () => isOn)
      await $.store.set('enabled', isOn)
    }
    const where = e.presentation?.isFullscreen === false ? ' (needs the fullscreen renderer: /tui fullscreen)' : ''
    $.ui.toast(`Rain ${isOn ? 'on' : 'off'}${where}`)
    return {}
  })

  on('ui.render', { component: TRANSCRIPT }, draw)
}
