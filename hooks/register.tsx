// neocode: the transcript decays into Matrix rain as it scrolls up the screen.
//
// How it works, in one pass:
//   1. Every transcript row (reply, tool call, prompt, ...) is drawn by the
//      engine as usual. A `ui.render` hook wraps that drawing and lays
//      `Raster` cell grids over the parts that should look decayed, using
//      `position: "absolute"` so nothing underneath moves.
//   2. The engine tells each row which of its lines are on screen
//      (`onScreen`) and how tall it is. Stacking the heights of the rows on
//      screen, in the order the engine draws them, gives every line's
//      distance above the bottom of the window, which sets how decayed it is.
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
// What it touches, all of it.
//
// Hooks. `ui.render` draws the overlay; `session.start` and `session.end` set
// up and reset; `command.run` answers /neocode. Three more are only observed:
// each passes the event, and the engine's answer, on exactly as received.
//   - `classic.MessageDisplay`: reads the streamed reply's display lines, to
//     size the rain over them.
//   - `turn.complete`: reads only whether the turn belongs to a subagent
//     (`agentId`), so that a turn ending without a last flush ends the stream.
//   - `prompt.edit`: notes that an edit happened, because typing clears a
//     selection. The text typed is not read.
// It hooks no event that changes conversation data (`session.append`,
// `tool.call`, `prompt.submit` and the rest), rewrites no props, opens no
// network connection, runs no process and reads or writes no file.
//
// What it reads, in memory only: never stored, logged or sent anywhere.
//   - The text of the rows it draws over (replies, prompts, tool input and
//     output, command output), to estimate where each line's text sits. Only
//     those line extents, numbers, are kept.
//   - The streamed reply's lines, kept until its row arrives or its turn ends.
//   - The person's current mouse selection (`$.ui.selection()`, asked about
//     every frame): its text and the transcript row it lies in. The text is
//     held to compare what was selected over rain with what it reads once the
//     rain is gone; it is dropped when the engine stops reporting that selection,
//     or at session end.
//   - The settings: `$.settings.read()` hands over all of them; only
//     `prefersReducedMotion` is looked at, and nothing else is kept.
//   - Whether the terminal is fullscreen, and its size (`viewport`).
//
// What it writes. `$.store` keeps two flags (the /neocode toggle, and whether
// the fullscreen hint was shown). The one clipboard write is `$.ui.copy`,
// used only when a copy caught rain glyphs, and it re-copies the person's own
// selection, as it really reads (see syncPaused). The rest is the terminal's
// drawing: `$.ui.blit` on its own rasters, toasts (the /neocode answer and
// the one-time fullscreen hint), `$.command.register` for /neocode, and the
// `$.clock` timers behind the animation.

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
  paintGap,
  plainExtents,
  seedOf,
  streamCorruption,
  streamFade,
  waveAt,
} from './matrix'
import type { Extent, GlyphSet, Reach } from './matrix'

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

// A reply that has finished streaming arrives as a row of its own, often tall
// enough to be decayed at once; its rain ramps in over this long instead of
// appearing in one frame, matching the fade-out over the stream before it.
const RAMP_MS = 800

// A row that has just appeared or changed height may sit half in view for a
// moment while the screen catches up; its reports in that time are not scrolls.
const SETTLE_MS = 400

// Draws the engine makes this close together belong to one pass over the
// transcript, which it makes top to bottom.
const PASS_MS = 5

// --- module state (rebuilt on reload; the next render fills it again) --------

type OnScreen = { first: number; last: number; of: number }

/**
 * What the engine last reported for a transcript row: `shown` its last
 * `onScreen`; `changedAt` when it appeared or last changed height;
 * `arrivedAt` when it arrived as a reply that had just finished streaming (0
 * for any other row) and `rampFrom` the fade its stream had reached then: its
 * rain ramps from that back to full (see RAMP_MS). `seenAt` when it was last
 * drawn; `isGone` once a full redraw passed it by (see `sweepGone`).
 */
type Entry = {
  of: number
  shown: OnScreen | null
  changedAt: number
  arrivedAt: number
  rampFrom: number
  seenAt: number
  isGone: boolean
}

/** One raster laid over a row: `rows` x `width` cells at (`row`, `col`) of the row's drawing. */
type Overlay = {
  key: string
  row: number
  col: number
  width: number
  rows: number
  isBlock: boolean
  /** Laid over a streaming reply's lines: trails in the gaps (paintGap). */
  isStream?: boolean
}

/**
 * A row with overlays mounted, and what the frame timer needs to repaint
 * them. Line `r` of the row sits `base - r` lines above the window's bottom.
 */
type Mount = {
  requestId: string
  seed: number
  base: number
  /** How far its decay has ramped in, 0 to 1 (see RAMP_MS). */
  ramp: number
  /** How much of the rain over a streaming reply below this row to keep (see streamFade). */
  fade: number
  /**
   * For that fade between redraws: the lines left above the reply when drawn
   * (`remaining`), when (`drawnAt`), and how fast the reply was growing then
   * (`rate`, lines a second). A fast reply grows several lines between
   * redraws; projecting it lets the rain thin out frame by frame.
   */
  remaining: number
  drawnAt: number
  rate: number
  viewRows: number
  extents: Extent[]
  overlays: Overlay[]
}

const entries = new Map<string, Entry>()
const order: Entry[] = [] // the rows top to bottom, as learned in `place`
const mounts = new Map<string, Mount>()
let lastScrollAt = 0
let maybeScrollAt = 0 // a move that may be a scroll, confirmed in `frame` unless output explains it
let lastGrowthAt = 0 // when output last arrived: a row appeared or grew, or the stream got longer
let promptAt = 0 // when the prompt box last changed height: edited, or a prompt sent
let layoutDirtyAt = 0
let settings = { reach: 'balanced' as Reach, glyphs: 'katakana' as GlyphSet, resumeMs: 5000 }

/**
 * The reply streaming now, as its display lines have arrived so far, the fade
 * its rain is at (see streamFade) and when its last flush came. Its final
 * flush, or the turn ending, sets `finishedAt`: from then it adds no lines
 * below the newest row, and the finished reply's own row takes it over if it
 * comes. `finished` names the last stream, so a late flush for it is ignored.
 *
 * A stream left behind would push every row on screen into the rain, so it
 * ends on every way a reply can stop (see `endStream`): its row arriving, a
 * new prompt, the turn ending (an interrupt or an error included), /clear,
 * and, as a backstop, no flush for STREAM_STALE_MS.
 */
let stream:
  | { id: string; text: string; fade: number; rate: number; flushedAt: number; finishedAt?: number }
  | undefined
let finished = ''
const STREAM_STALE_MS = 10_000

function endStream(now: number) {
  if (!stream) return
  finished = stream.id
  stream = undefined
  layoutDirtyAt ||= now
}
let rampUntil = 0 // redraw until then, so a finishing reply's rain ramps in

const isBottomClipped = (s: OnScreen | null | undefined) => !!s && s.last < s.of - 1
const sameRange = (a: OnScreen | null, b: OnScreen | null) =>
  a === b || (!!a && !!b && a.first === b.first && a.last === b.last && a.of === b.of)

/** True while a scroll happened within the resume delay. */
const isScrolling = () => Date.now() - lastScrollAt < settings.resumeMs

/** A scroll was seen: clear the rain now; it returns once scrolling has stopped. */
function scrolled(at: number) {
  lastScrollAt = at
}

/**
 * Records a row's report and tells scrolling apart from content arriving.
 *
 * Mods get no scroll event for the transcript, but a row reports again each
 * time its lines on screen change. New output at the live bottom only pushes
 * rows up and off the top of the window. Anything else is the window moving:
 *
 * - A row cut off at the bottom of the window, or one that just was, can only
 *   be a scroll, so it clears the rain at once.
 * - Any other move (a row coming into view from off screen, as after Ctrl+End;
 *   a row's top line coming back) is a scroll too, unless something else
 *   explains it within a few hundred milliseconds (`frame` decides): output
 *   arriving (the spinner giving way to a streaming reply shifts rows), or
 *   the prompt box changing height as it is edited or sent (`promptAt`).
 *
 * Jumps (Ctrl+Home, Ctrl+End, PgUp) can leave a row's report stale: a row that
 * leaves the screen in one jump is not always reported again. Nothing here
 * trusts a row's report on its own; see `visibleRun`.
 */
function measure(key: string, shown: OnScreen | null): Entry {
  const now = Date.now()
  let entry = entries.get(key)
  if (!entry) {
    entry = { of: shown?.of ?? 0, shown, changedAt: now, arrivedAt: 0, rampFrom: 1, seenAt: now, isGone: false }
    entries.set(key, entry)
    place(entry, now)
    layoutDirtyAt ||= now // a full pass soon, to settle where it goes
    if (entry === newest() && !isScrolling()) lastGrowthAt = now
    if (stream && !isScrolling()) {
      if (key.startsWith('AssistantMessage:')) {
        // The reply has its own row now (finished, or cut short): stop raining
        // on its stream, and ramp its own rain in from where the fade left off.
        if (stream.fade < 1) {
          entry.arrivedAt = now
          entry.rampFrom = stream.fade
          rampUntil = now + RAMP_MS
        }
        endStream(now)
      } else if (key.startsWith('UserMessage:') && entry === newest()) {
        endStream(now) // a new prompt: whatever was streaming is over
      }
    }
    return entry
  }
  entry.seenAt = now
  entry.isGone = false
  place(entry, now)
  const prev = entry.shown
  // A row first reported off screen has no height yet (0); learning it is not growth.
  const hasGrown = !!shown && entry.of > 0 && shown.of !== entry.of
  if (shown) entry.of = shown.of
  if (hasGrown) {
    entry.changedAt = now
    lastGrowthAt = now
  } else if (!sameRange(prev, shown) && now - entry.changedAt > SETTLE_MS) {
    const isPushedUp =
      !!prev && (shown ? shown.last === prev.last && shown.first > prev.first : prev.last === prev.of - 1)
    if (isBottomClipped(prev) || isBottomClipped(shown)) scrolled(now)
    else if (!isPushedUp) maybeScrollAt ||= now
  }
  // Any row moving redraws the rest, so they measure against fresh reports.
  if (!sameRange(prev, shown)) layoutDirtyAt ||= now
  entry.shown = shown
  return entry
}

/** The last row of the transcript that is still drawn. */
function newest(): Entry | undefined {
  for (let i = order.length - 1; i >= 0; i--) if (!order[i]!.isGone) return order[i]
  return undefined
}

/**
 * Marks the rows a full redraw passed by as gone. Every row on the screen (and
 * the few just off it the engine keeps drawn) redraws when `layout` changes;
 * a row that does not has left: scrolled far away, or removed, like a prompt
 * Esc took back before Claude answered. A gone row's last report is stale, so
 * it must not stand as the newest row or as part of what is on screen. It
 * comes back the next time it is drawn.
 */
let passAt = 0
const PASS_SETTLE_MS = 600

function sweepGone(now: number) {
  if (!passAt || now - passAt < PASS_SETTLE_MS) return
  for (const entry of order) if (entry.seenAt < passAt) entry.isGone = true
  passAt = 0
}

/**
 * Learns the transcript's order. The engine draws rows in passes, top to
 * bottom, so a row drawn right after another (within PASS_MS) sits directly
 * below it: a new row goes there, and a known row found elsewhere moves there.
 *
 * Counting rows as they first appear would not do: in a resumed conversation,
 * or after the mod reloads, older rows first appear as the person scrolls up
 * to them. Any full pass (every layout change makes one) repairs the order.
 */
let lastDraw: { entry: Entry; at: number } | undefined

function place(entry: Entry, now: number) {
  const above = lastDraw && now - lastDraw.at <= PASS_MS ? lastDraw.entry : undefined
  lastDraw = { entry, at: now }
  const at = order.indexOf(entry)
  if (!above || above === entry) {
    if (at < 0) order.push(entry) // drawn alone: new output at the bottom, until a pass says otherwise
    return
  }
  if (at >= 0 && order[at - 1] === above) return
  if (at >= 0) order.splice(at, 1)
  order.splice(order.indexOf(above) + 1, 0, entry)
}

/**
 * The transcript rows on screen now, top to bottom, found outward from a row
 * the engine is drawing at this moment (so certainly on screen).
 *
 * A neighbour joins only when the two agree: the row above must show its last
 * line and this one its first; the row below must show its first line and
 * this one its last. A stale report from another scroll position fails that
 * test, so it cannot pull the window off.
 */
function visibleRun(seed: Entry): Entry[] {
  const all = order.filter(e => !e.isGone || e === seed)
  let top = all.indexOf(seed)
  let bottom = top
  while (top > 0) {
    const here = all[top]!.shown
    const above = all[top - 1]!.shown
    if (!here || here.first > 0 || !above || above.last < above.of - 1) break
    top--
  }
  while (bottom < all.length - 1) {
    const here = all[bottom]!.shown
    const below = all[bottom + 1]!.shown
    if (!here || here.last < here.of - 1 || !below || below.first > 0) break
    bottom++
  }
  return all.slice(top, bottom + 1)
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

/** The window's height in lines, from the terminal's size: the scale the decay is measured against. */
const windowRows = (viewportRows: number) => Math.max(4, viewportRows - CHROME_ROWS)

/**
 * Where a row sits: `base`, so that its line `r` is `base - r` lines above the
 * bottom of the window.
 *
 * Wherever the window is, this counts up from the lowest line on screen of
 * the run of rows around it (`visibleRun`): at the live bottom that is the
 * newest output, scrolled back it is the window's bottom edge. Nothing else
 * goes in, so the same lines of the window decay the same way at any scroll
 * position. The one addition is a reply still streaming below the newest row,
 * whose lines sit between it and the prompt.
 */
function baseOf(entry: Entry, shown: OnScreen, streamRows: number): number {
  const run = visibleRun(entry)
  let below = 0
  for (const other of run.slice(run.indexOf(entry) + 1)) {
    if (other.shown) below += other.shown.last - other.shown.first + 1
  }
  const lowest = run[run.length - 1]!
  const isAtLiveBottom = lowest === newest() && !isBottomClipped(lowest.shown)
  return shown.last + below + (isAtLiveBottom ? streamRows : 0)
}

/**
 * How many lines the row above a streaming reply (`anchor`) and the rows above
 * it still have on screen, before the reply pushes the anchor off the top.
 * Once the top row on screen is cut off by the window's top, that is exactly
 * the lines of the rows on screen. Before then, rows the engine does not
 * report (the welcome banner) may sit above them too: at least those lines,
 * and as many as the window's height less the reply's.
 */
function linesAboveStream(anchor: Entry, viewRows: number, streamRows: number): number {
  const run = visibleRun(anchor)
  let lines = 0
  for (const e of run) if (e.shown) lines += e.shown.last - e.shown.first + 1
  const isTopCut = (run[0]!.shown?.first ?? 0) > 0
  return isTopCut ? lines : Math.max(lines, viewRows - streamRows)
}

/**
 * The rasters a row needs: one block over its fully decayed lines, small bites
 * over the rest. Lines from `streamFrom` to `last` belong to the reply
 * streaming below the row; they get one layer of their own (see streamLayer).
 */
function overlaysFor(m: Mount, first: number, last: number, columns: number, prefix: string, streamFrom: number): Overlay[] {
  const out: Overlay[] = streamLayer(m, streamFrom, last, columns, prefix)
  last = Math.min(last, streamFrom - 1)
  let blockEnd = first
  for (let r = first; r <= last; r++) {
    const c = corruption(m.base - r, m.viewRows, settings.reach) * m.ramp
    if (c <= 0) break // lines only get closer to the bottom from here
    if (c >= BLOCK && r === blockEnd) {
      blockEnd = r + 1
      continue
    }
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

/**
 * The layer over a streaming reply's lines, `from` to `to`: one raster across
 * the window from its oldest line down to the last line rain reaches. The
 * engine paints the streamed text over it, so only the gaps around the text
 * show it; the trails there thicken with a line's distance above the newest
 * one (streamCorruption).
 */
function streamLayer(m: Mount, from: number, to: number, columns: number, prefix: string): Overlay[] {
  if (from > to || m.fade <= 0) return []
  let end = from
  while (end <= to && streamCorruption(m.base - end, m.viewRows, settings.reach) > 0) end++
  if (end === from) return []
  const rows = Math.min(256, end - from)
  return [{ key: `${prefix}stream`, row: from, col: 0, width: Math.min(512, columns), rows, isBlock: true, isStream: true }]
}

/** The fade over a streaming reply at time `t` (seconds): projected on from the last redraw, never thicker. */
function streamFadeNow(m: Mount, t: number): number {
  const lines = m.remaining - (m.rate * Math.max(0, t * 1000 - m.drawnAt)) / 1000
  return Math.min(m.fade, streamFade(lines, m.viewRows))
}

/** Packs one overlay's cells at time `t` as RasterProps.cells wants them. */
function cellsOf(m: Mount, o: Overlay, t: number): string {
  const words = new Uint32Array(o.width * o.rows * 3)
  const wave = waveAt(t, m.viewRows)
  for (let i = 0; i < o.rows; i++) {
    const r = o.row + i
    const d = m.base - r
    const rowId = hash(m.seed, r) * 1e6
    const c = o.isStream
      ? streamCorruption(d, m.viewRows, settings.reach) * streamFadeNow(m, t)
      : corruption(d, m.viewRows, settings.reach) * m.ramp
    const [start, end] = m.extents[r] ?? [0, 0]
    for (let j = 0; j < o.width; j++) {
      const x = o.col + j
      const cell = o.isStream
        ? paintGap(x, rowId, d, c, t, wave, settings.glyphs)
        : paint(x, rowId, d, c, x >= start && x < end, t, wave, settings.glyphs)
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
  // A sent prompt is drawn at once as a placeholder row, as the prompt box empties.
  if (e.requestId === 'placeholder') promptAt = Date.now()
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
  const viewRows = windowRows(e.viewport.rows)
  // The streaming reply sits below the newest row; that row carries its rain.
  const streamExtents = stream && !stream.finishedAt ? markdownExtents(stream.text, columns) : []
  const base = baseOf(entry, shown, streamExtents.length)
  const isAnchor = entry === newest() && streamExtents.length > 0 && shown.last === shown.of - 1
  const remaining = isAnchor ? linesAboveStream(entry, viewRows, streamExtents.length) : viewRows
  const fade = isAnchor ? Math.min(stream?.fade ?? 1, streamFade(remaining, viewRows)) : 1
  if (isAnchor && stream) stream.fade = fade
  const mount: Mount = {
    requestId: e.requestId,
    seed: seedOf(key),
    base,
    fade,
    remaining,
    drawnAt: Date.now(),
    rate: isAnchor && stream ? stream.rate : 0,
    viewRows,
    ramp: entry.arrivedAt
      ? entry.rampFrom + (1 - entry.rampFrom) * Math.min(1, (Date.now() - entry.arrivedAt) / RAMP_MS)
      : 1,
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

  // A finished stream whose row never came is dropped, and so is one gone quiet.
  if (stream && (now - (stream.finishedAt ?? Infinity) > 2000 || now - stream.flushedAt > STREAM_STALE_MS)) {
    endStream(now)
  }
  sweepGone(now)
  // Rain ramping in after a reply, or fading out over one still streaming,
  // redraws as it goes, so each step shows.
  if (now < rampUntil + 150 || (stream && !stream.finishedAt && stream.fade < 1)) layoutDirtyAt ||= now
  // Geometry changed (a row arrived or grew, the stream got longer): redraw once it settles.
  if (layoutDirtyAt && now - layoutDirtyAt > 120) {
    layoutDirtyAt = 0
    passAt ||= now // every row on screen redraws now; sweepGone looks at who did not
    void update($, layout, n => (n ?? 0) + 1)
  }
  // A move that might have been a scroll is one, unless output arrived around then.
  if (maybeScrollAt && now - maybeScrollAt > 300) {
    const explained = Math.abs(lastGrowthAt - maybeScrollAt) <= 300 || Math.abs(promptAt - maybeScrollAt) <= 500
    if (!explained) scrolled(maybeScrollAt)
    maybeScrollAt = 0
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
let selection:
  | { text: string; changedAt: number; requestId?: string; overRain?: string; isDismissed?: boolean }
  | undefined

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
 * except the transcript row the selection lies in, which stays clean while the
 * selection may still be highlighted. A selection across several rows does
 * not say which rows it covers, so for that one the rain stays paused.
 *
 * The engine keeps answering with the last selection after its highlight is
 * gone, until the next prompt or command, and says nothing when a click takes
 * the highlight down. The one signal a mod gets is typing in the prompt box
 * (`prompt.edit`), which always clears the highlight: from then on that
 * selection holds nothing back. A new selection changes the answer and starts
 * over; one made over rain is caught by the repair below.
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
  } else if (current.requestId && !selection.requestId) {
    selection.requestId = current.requestId // the same selection, named again
  } else if (selection.overRain !== undefined && !isRaining && now - selection.changedAt > 300) {
    // Settled with the rain gone: the live selection now reads the real text.
    const sawGlyphs = selection.overRain !== current.text
    selection.overRain = undefined // once per selection
    if (sawGlyphs) await $.ui.copy({ text: current.text })
  }

  const live = selection?.isDismissed ? undefined : selection
  const isSelecting = !!live && (now - live.changedAt < settings.resumeMs || !live.requestId)
  const shouldPause = isScrolling() || isSelecting
  const clean = live?.requestId ?? ''
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
    order.length = 0
    passAt = 0
    lastDraw = undefined
    mounts.clear()
    lastScrollAt = 0
    maybeScrollAt = 0
    stream = undefined
    finished = ''
    rampUntil = 0
    selection = undefined
    return next(e)
  })

  // While a reply streams, its lines are drawn where no render hook reaches.
  // Read them to size the rain laid over them; pass the event on untouched.
  on('classic.MessageDisplay', ($, e, next) => {
    const now = Date.now()
    if (e.message_id === finished) return next(e) // a late flush for a reply already done
    if (stream?.id !== e.message_id) {
      if (e.final) return next(e) // a last flush for a reply whose row already took over
      stream = { id: e.message_id, text: '', fade: 1, rate: 0, flushedAt: now }
    }
    // How fast it grows, in lines a second, smoothed over the last few flushes.
    const lines = e.delta.split('\n').length - 1
    if (now > stream.flushedAt) stream.rate = 0.6 * stream.rate + 0.4 * ((lines * 1000) / (now - stream.flushedAt))
    stream.text += e.delta
    stream.flushedAt = now
    if (e.final) {
      stream.finishedAt = now
      finished = e.message_id
    }
    lastGrowthAt = now
    layoutDirtyAt ||= now
    return next(e)
  })

  // A turn ending (answered, interrupted, or cut off by an error) ends its
  // stream: the reply's row, if one comes, still takes it over. A subagent's
  // turn is not the main conversation's. The event goes on untouched.
  on('turn.complete', ($, e, next) => {
    if (!e.agentId && stream && !stream.finishedAt) stream.finishedAt = Date.now()
    return next(e)
  })

  // Typing in the prompt box takes any selection's highlight down, so the row
  // it lay in no longer needs keeping clean, and may change the box's height,
  // which moves the transcript without a scroll. Only the fact of the edit is
  // used; the event goes on untouched.
  on('prompt.edit', ($, e, next) => {
    promptAt = Date.now() // the box may change height: not a scroll
    if (selection) selection.isDismissed = true
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
