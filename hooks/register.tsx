// neocode: the transcript decays into Matrix rain as it scrolls up the screen.
//
// How it works, in one pass:
//   1. Every transcript row (reply, tool call, prompt, ...) is drawn by the
//      engine as usual. A `ui.render` hook wraps that drawing and lays
//      `Raster` cell grids over the parts that should look decayed, using
//      `position: "absolute"` so nothing underneath moves.
//   2. The engine tells each row which of its lines are on screen
//      (`onScreen`) and how tall it is. Stacking those heights gives every
//      line's distance above the bottom of the window, which sets how
//      decayed it is.
//   3. A timer repaints the mounted rasters with `$.ui.blit` (no re-render),
//      so glyphs churn and trails climb while the text underneath is static.
//
// The rain steps aside while the person interacts: every scroll clears it at
// once, and so does selecting text; it comes back after a quiet spell (the
// `resumeDelay` option). See `measure` for scrolling, `syncPaused` for both.
//
// A reply is drawn by a part of the screen mods cannot hook until it has
// finished streaming. While it streams, its lines (read from the engine's
// `MessageDisplay` event, which neocode observes and passes on untouched) are
// laid out by estimate, so the rows above decay as the reply pushes them up,
// and rain fills the space around the streamed lines from the row just above
// them. The engine paints the streamed text itself over any overlay, and drops
// that row once it scrolls off, so the reply's own text decays when it completes.
//
// What it touches, all of it: it hooks no event that changes conversation
// data (`session.append`, `tool.call`, `prompt.*`), rewrites no props, opens
// no network connection, runs no process and writes no file. It reads the
// streamed reply's display lines to size the rain over them. Its own
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
import type { Curve, Extent, GlyphSet, Reach } from './matrix'

// --- session state (read while drawing, so a change redraws the readers) -----

const enabled = atom({ plugin: 'neocode', key: 'enabled' } as const, true)
const paused = atom({ plugin: 'neocode', key: 'paused' } as const, false)
const layout = atom({ plugin: 'neocode', key: 'layout' } as const, 0)
const keptClean = atom({ plugin: 'neocode', key: 'keptClean' } as const, '')

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

// A row that has just appeared or changed height may sit half in view for a
// moment while the screen catches up; its reports in that time are not scrolls.
const SETTLE_MS = 400

// --- module state (rebuilt on reload; the next render fills it again) --------

type OnScreen = { first: number; last: number; of: number }

/**
 * What the engine last reported for a transcript row: `seq` is its order, top
 * to bottom; `shown` its last `onScreen`; `changedAt` when it appeared or last
 * changed height.
 */
type Entry = { seq: number; of: number; shown: OnScreen | null; changedAt: number }

/** One raster laid over a row: `rows` x `width` cells at (`row`, `col`) of the row's drawing. */
type Overlay = {
  key: string
  row: number
  col: number
  width: number
  rows: number
  isBlock: boolean
}

/**
 * A row with overlays mounted, and what the frame timer needs to repaint
 * them. Line `r` of the row sits `base - r` lines above the window's bottom.
 */
type Mount = {
  requestId: string
  seed: number
  base: number
  viewRows: number
  curve: Curve
  extents: Extent[]
  overlays: Overlay[]
}

const entries = new Map<string, Entry>()
const mounts = new Map<string, Mount>()
let nextSeq = 0
let bottomKey = ''
let lastScrollAt = 0
let layoutDirtyAt = 0
let settings = { reach: 'balanced' as Reach, glyphs: 'katakana' as GlyphSet, resumeMs: 5000 }

/** The reply streaming now, as its display lines have arrived so far. */
let stream: { id: string; text: string } | undefined

const isBottomClipped = (s: OnScreen | null | undefined) => !!s && s.last < s.of - 1
const sameRange = (a: OnScreen | null, b: OnScreen | null) =>
  a === b || (!!a && !!b && a.first === b.first && a.last === b.last && a.of === b.of)

/** True while a scroll happened within the resume delay. */
const isScrolling = () => Date.now() - lastScrollAt < settings.resumeMs

/**
 * Records a row's report and tells scrolling apart from content arriving.
 *
 * Mods get no scroll event for the transcript, but the rows at the window's
 * edges report each time they move. New output at the live bottom only ever
 * pushes rows off the top. A row cut off at the bottom of the window, or one
 * that just was, means the window itself moved: the person is scrolling.
 */
function measure(key: string, shown: OnScreen | null): Entry {
  const now = Date.now()
  let entry = entries.get(key)
  if (!entry) {
    entry = { seq: nextSeq++, of: shown?.of ?? 0, shown, changedAt: now }
    entries.set(key, entry)
    bottomKey = key
    layoutDirtyAt ||= now
    // The finished reply has its own row now; stop raining on its stream.
    if (key.startsWith('AssistantMessage:')) stream = undefined
    return entry
  }
  const prev = entry.shown
  if (shown && shown.of !== entry.of) {
    entry.of = shown.of
    entry.changedAt = now
    layoutDirtyAt ||= now
  } else if (!sameRange(prev, shown) && now - entry.changedAt > SETTLE_MS) {
    if (isBottomClipped(prev) || isBottomClipped(shown)) lastScrollAt = now
  }
  // Scrolled back, positions are counted from the window's top, so any move redraws.
  if (!sameRange(prev, shown) && isAway()) layoutDirtyAt ||= now
  entry.shown = shown
  return entry
}

/** True while the window is scrolled away from the live bottom: some row is cut off below it. */
function isAway(): boolean {
  for (const { shown } of entries.values()) if (isBottomClipped(shown)) return true
  return false
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

/**
 * Where a row sits: `base`, so that its line `r` is `base - r` lines above the
 * window's bottom.
 *
 * At the live bottom this counts up from the end of the transcript: the rows
 * below this one, and the reply still streaming under them all. Scrolled back,
 * the rows below the window are off screen, so it counts down from the row at
 * the window's top instead, which reports on every move.
 */
function baseOf(entry: Entry, streamRows: number, viewRows: number): number | undefined {
  if (!isAway()) {
    let below = streamRows
    for (const other of entries.values()) if (other.seq > entry.seq) below += other.of
    return entry.of - 1 + below
  }
  let top: Entry | undefined
  for (const other of entries.values()) if (other.shown && (!top || other.seq < top.seq)) top = other
  if (!top?.shown) return undefined
  let offset = -top.shown.first // the window row of `top`'s line 0
  for (const other of entries.values()) if (other.seq >= top.seq && other.seq < entry.seq) offset += other.of
  return viewRows - 1 - offset
}

/**
 * The rasters a row needs: one block over its fully decayed lines, small bites
 * over the rest. Lines from `bitesEnd` on get no bites: they belong to the
 * streaming reply, whose text the engine paints over anything laid there, so
 * only the block's rain in the space around its lines would ever show.
 */
function overlaysFor(m: Mount, first: number, last: number, columns: number, prefix: string, bitesEnd: number): Overlay[] {
  const out: Overlay[] = []
  let blockEnd = first
  for (let r = first; r <= last; r++) {
    const c = corruption(m.base - r, m.viewRows, m.curve)
    if (c <= 0) break // lines only get closer to the bottom from here
    if (c >= BLOCK && r === blockEnd) {
      blockEnd = r + 1
      continue
    }
    if (r >= bitesEnd) break
    const extent = m.extents[r] ?? [0, 0]
    for (const [start, end] of bites(extent, c, hash(m.seed, r))) {
      out.push({ key: `${prefix}${r}_${start}`, row: r, col: start, width: end - start, rows: 1, isBlock: false })
    }
  }
  if (blockEnd > first) {
    out.push({
      key: `${prefix}block`,
      row: first,
      col: 0,
      width: Math.min(512, columns),
      rows: Math.min(256, blockEnd - first),
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
    const d = m.base - r
    const c = corruption(d, m.viewRows, m.curve)
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
  const wasScrolling = isScrolling()
  const entry = shown === undefined || e.requestId === 'placeholder' ? undefined : measure(key, shown)
  // This report was a scroll: clear the rain everywhere now, not at the next frame.
  if (!wasScrolling && isScrolling()) $.clock.after(0, () => void syncPaused($))

  const isOn = await read($, enabled)
  const isPaused = await read($, paused)
  const clean = await read($, keptClean)
  await read($, layout) // subscribe: redraw when the rows around this one change
  const inner = await next(e)

  if (
    !entry ||
    !shown ||
    !isOn ||
    isPaused ||
    isScrolling() ||
    e.requestId === clean ||
    e.surface !== 'terminal' ||
    !e.viewport
  ) {
    mounts.delete(key)
    return inner
  }

  const columns = e.viewport.columns
  const viewRows = Math.max(4, e.viewport.rows - CHROME_ROWS)
  const isAtBottom = !isAway()
  // The streaming reply sits below the newest row; that row carries its rain.
  const streamExtents = stream && isAtBottom ? markdownExtents(stream.text, columns) : []
  const base = baseOf(entry, streamExtents.length, viewRows)
  if (base === undefined) {
    mounts.delete(key)
    return inner
  }
  const isAnchor = key === bottomKey && streamExtents.length > 0 && shown.last === shown.of - 1
  const mount: Mount = {
    requestId: e.requestId,
    seed: seedOf(key),
    base,
    viewRows,
    curve: isAtBottom ? settings.reach : 'scrolled',
    extents: isAnchor ? [...extentsOf(e, columns), ...streamExtents] : extentsOf(e, columns),
    overlays: [],
  }
  const last = isAnchor ? shown.of - 1 + streamExtents.length : shown.last
  // ToolUse and ToolResult share a requestId; prefixes keep their raster keys apart.
  mount.overlays = overlaysFor(mount, shown.first, last, columns, e.component === 'ToolResult' ? 'r' : 'u', shown.of)
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

  // Geometry changed (a row arrived or grew, the stream got longer): redraw once it settles.
  if (layoutDirtyAt && now - layoutDirtyAt > 120) {
    layoutDirtyAt = 0
    void update($, layout, n => (n ?? 0) + 1)
  }
  void syncPaused($)
  if (isScrolling()) return

  for (const [key, m] of mounts) {
    const wave = waveAt(t, m.viewRows)
    for (const o of m.overlays) {
      // Full-rain blocks animate every frame. Bites churn every third frame,
      // and every frame while the upward ripple passes through their row.
      const d = m.base - o.row
      if (!o.isBlock && Math.abs(d - wave) > 2 && (frameNo + o.row) % 3 !== 0) continue
      // Refused (unmounted, resized) or failed: drop it; the next render remounts.
      void $.ui.blit({ requestId: m.requestId, key: o.key, cells: cellsOf(m, o, t) }).then(
        r => void ('deny' in r && r.deny && mounts.delete(key)),
        () => void mounts.delete(key),
      )
    }
  }
}

/**
 * The person's mouse selection as last seen: its text, when it last changed,
 * the transcript row it lies in (absent when it spans several), and, when it
 * was made or changed while rain was drawn, the text seen then (`overRain`)
 * so syncPaused can tell whether the copy caught glyphs.
 */
let selection: { text: string; changedAt: number; requestId?: string; overRain?: string } | undefined

/**
 * Sets `paused` and `keptClean`, which every overlay reads, and keeps copies clean.
 *
 * Scrolling pauses the rain until no scroll has come for the resume delay.
 *
 * Selecting pauses it too. Claude Code copies a selection from what is on
 * screen, on mouse release and again on Ctrl+C or Cmd+C, so the selected
 * text must never have rain on it. The selection is reported live while it
 * is made, which gives a frame or two to clear the rain before the release.
 * Once it has not changed for the resume delay, the rain returns everywhere
 * except the transcript row the selection lies in, which stays clean for as
 * long as the selection is reported (until the next prompt or command). A
 * selection across several rows does not say which rows it covers, so for
 * that one the rain stays paused until the selection clears.
 *
 * A selection made faster than one frame (a double-click on a word, say) is
 * copied before the rain can step aside. If the text it read while rain was
 * drawn differs from the real text it reads once the rain is gone, the
 * clipboard holds glyphs, so the real text goes there instead. This only ever
 * re-copies what the person themselves just selected.
 */
async function syncPaused($: EngineInterface) {
  const now = Date.now()
  const current = await $.ui.selection()
  const isRaining = mounts.size > 0 // read before pausing clears the overlays

  if (current === undefined) {
    selection = undefined
  } else if (!selection || selection.text !== current.text) {
    const overRain = isRaining ? current.text : selection?.overRain
    selection = { text: current.text, changedAt: now, requestId: current.requestId, overRain }
  } else if (selection.overRain !== undefined && !isRaining && now - selection.changedAt > 300) {
    // Settled with the rain gone: the live selection now reads the real text.
    const sawGlyphs = selection.overRain !== current.text
    selection.overRain = undefined // once per selection
    if (sawGlyphs) await $.ui.copy({ text: current.text })
  }

  const isSelecting = !!selection && (now - selection.changedAt < settings.resumeMs || !selection.requestId)
  const shouldPause = isScrolling() || isSelecting
  const clean = selection?.requestId ?? ''
  if ((await read($, paused)) !== shouldPause) await update($, paused, () => shouldPause)
  if ((await read($, keptClean)) !== clean) await update($, keptClean, () => clean)
}

// --- registration --------------------------------------------------------------

export const register: Register = (on, options) => {
  settings = {
    reach: (['gentle', 'balanced', 'deep'].includes(String(options.reach)) ? options.reach : 'balanced') as Reach,
    glyphs: (options.glyphs === 'letters' ? 'letters' : 'katakana') as GlyphSet,
    resumeMs: Math.max(1, Math.min(60, Number(options.resumeDelay) || 5)) * 1000,
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
    lastScrollAt = 0
    stream = undefined
    selection = undefined
    return next(e)
  })

  // While a reply streams, its lines are drawn where no render hook reaches.
  // Read them to size the rain laid over them; pass the event on untouched.
  on('classic.MessageDisplay', ($, e, next) => {
    if (stream?.id !== e.message_id) stream = { id: e.message_id, text: '' }
    stream.text += e.delta
    if (e.final) stream = undefined
    layoutDirtyAt ||= Date.now()
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
