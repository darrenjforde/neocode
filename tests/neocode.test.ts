// Run with: claude plugin test .
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { BLOCK, bites, corruption, markdownExtents, paint, pickOption, streamFade } from '../hooks/matrix'

const REPLY = {
  text: '```python\nfor cell in grid:\n    print(cell)\n```\nDone.',
  isFirstOfReply: true,
}
const VIEWPORT = { columns: 80, rows: 30, isFullscreen: true }
// One 20-row reply filling the transcript: its top rows are far from the prompt.
const ON_SCREEN = { first: 0, last: 19, of: 20 }

const hasRaster = (tree: unknown) => JSON.stringify(tree).includes('"Raster"')
declare function setTimeout(fn: () => void, ms: number): unknown // the test runtime has it; es2023's lib does not
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
// The shortest resume delay the option allows, so the tests can wait it out.
const QUICK = { options: { resumeDelay: 1 }, timeoutMs: 8000 }

// The test stands in for the engine beneath the plugin: its own drawing of a
// row, and a store that keeps nothing.
const ENGINE = { type: 'engine', ref: 1 } as const

describe('decay', () => {
  test('is zero by the prompt, total at the top, and never decreases going up', () => {
    let last = 0
    for (let d = 0; d <= 40; d++) {
      const c = corruption(d, 40, 'balanced')
      expect(c).toBeGreaterThanOrEqual(last)
      last = c
    }
    expect(corruption(0, 40, 'balanced')).toBe(0)
    expect(corruption(40, 40, 'balanced')).toBe(1)
  })

  test('bites stay inside the text and cover more of it as decay grows', () => {
    const covered = (c: number) =>
      bites([4, 64], c, 7).reduce((n, [start, end]) => {
        expect(start).toBeGreaterThanOrEqual(4)
        expect(end).toBeLessThanOrEqual(64)
        return n + end - start
      }, 0)
    expect(covered(0)).toBe(0)
    expect(covered(0.4)).toBeLessThanOrEqual(covered(0.7))
    expect(covered(BLOCK)).toBe(60)
  })

  test('fences take no row; code keeps its indent under the reply indent', () => {
    expect(markdownExtents(REPLY.text, 80)).toEqual([
      [0, 0],
      [2, 19],
      [6, 17],
      [2, 7],
    ])
  })

  test('every painted glyph is one printable cell', () => {
    for (let x = 0; x < 200; x++) {
      const cell = paint(x, 3, 30, x / 200, true, x * 0.37, 12, 'katakana')
      if (!cell) continue
      const isHalfwidthKatakana = cell.glyph >= 0xff66 && cell.glyph <= 0xff9d
      const isPrintableAscii = cell.glyph >= 0x21 && cell.glyph <= 0x7e
      expect(isHalfwidthKatakana || isPrintableAscii || cell.glyph === 0xa6).toBe(true)
      expect(cell.color).toBeLessThanOrEqual(0xffffff)
    }
  })
})

describe('drawing', () => {
  test('lays rain over a reply far from the prompt, on the engine’s own drawing', async ($, on) => {
    on('ui.render', () => ENGINE)
    const ui = await $.ui.mount({
      plugin: 'neocode',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { ...REPLY, onScreen: ON_SCREEN },
      viewport: VIEWPORT,
    })
    const tree = await ui.drawn()
    expect(hasRaster(tree)).toBe(true)
    expect(JSON.stringify(tree)).toContain('"engine"')
  })

  test('leaves a short transcript readable: decay is measured against the screen, not the content', async ($, on) => {
    on('ui.render', () => ENGINE)
    const ui = await $.ui.mount({
      plugin: 'neocode',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { ...REPLY, onScreen: { first: 0, last: 4, of: 5 } },
      viewport: VIEWPORT,
    })
    expect(hasRaster(await ui.drawn())).toBe(false)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`leaves a ${surface} row alone when the surface reports no rows`, async ($, on) => {
      on('ui.render', () => ENGINE)
      const ui = await $.ui.mount({
        plugin: 'neocode',
        surface,
        component: 'AssistantMessage',
        props: REPLY,
        viewport: VIEWPORT,
      })
      expect(hasRaster(await ui.drawn())).toBe(false)
    })
  }

  test('/neocode off removes the rain and adds no transcript text', async ($, on) => {
    on('ui.render', () => ENGINE)
    on('store.set', () => ({ value: undefined }))
    const result = await $.command.run({
      command: 'neocode',
      args: 'off',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 80 },
    })
    expect(result.text).toBeUndefined()
    const ui = await $.ui.mount({
      plugin: 'neocode',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { ...REPLY, onScreen: ON_SCREEN },
      viewport: VIEWPORT,
    })
    expect(hasRaster(await ui.drawn())).toBe(false)
  })
})

// The world a session starts in, mocked: a clock the test moves, an empty
// store, empty settings, a command registry. Hooks first, before any $ call.
function mockSession(on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  on('settings.read', () => ({ value: {} }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return clock
}

const startSession = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

describe('interaction', () => {
  test('a scroll clears the rain at once; it returns once scrolling stops', QUICK, async ($, on) => {
    on('ui.render', () => ENGINE)
    const ui = await $.ui.mount({
      plugin: 'neocode',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { ...REPLY, onScreen: ON_SCREEN },
      viewport: VIEWPORT,
    })
    expect(hasRaster(await ui.drawn())).toBe(true)
    await wait(500) // past the settling time of a row that just appeared

    // The window moves up a line: the row is now cut off at the bottom.
    await ui.redraw({ ...REPLY, onScreen: { first: 0, last: 18, of: 20 } })
    expect(hasRaster(await ui.drawn())).toBe(false)

    // Another scroll half way through the wait starts it again.
    await wait(600)
    await ui.redraw({ ...REPLY, onScreen: { first: 0, last: 17, of: 20 } })
    await wait(600)
    await ui.redraw()
    expect(hasRaster(await ui.drawn())).toBe(false)

    // Quiet for the whole delay: rain again, as at the live bottom.
    await wait(600)
    await ui.redraw()
    const tree = JSON.stringify(await ui.drawn())
    expect(tree).toContain('"Raster"')
    expect(tree).not.toContain('"top":19') // the lines nearest the window's bottom stay readable
  })

  test('a streaming reply pushes the rows above it into the rain as it grows', async ($, on) => {
    on('ui.render', () => ENGINE)
    on('classic.MessageDisplay', () => ({}))
    const props = { text: 'Write me a parser', origin: { kind: 'composer' as const }, isExpanded: false }
    const prompt = await $.ui.mount({
      plugin: 'neocode',
      surface: 'terminal',
      component: 'UserMessage',
      props: { ...props, onScreen: { first: 0, last: 1, of: 2 } },
      viewport: VIEWPORT,
    })
    expect(hasRaster(await prompt.drawn())).toBe(false) // nothing below it yet

    const delta = Array.from({ length: 22 }, (_, i) => `    line ${i} of streamed code`).join('\n') + '\n'
    await $.classic.MessageDisplay({ turn_id: 't', message_id: 'm', index: 0, final: false, delta })
    await prompt.redraw()
    expect(hasRaster(await prompt.drawn())).toBe(true)
  })

  test('a selection clears the rain; after the delay only the selected row stays clean', QUICK, async ($, on) => {
    on('ui.render', () => ENGINE)
    const clock = mockSession(on)
    const frames = async (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        await wait(100)
        await clock.advance(100)
      }
    }
    let selected: { text: string; requestId?: string } | undefined
    on('ui.selection', () => ({ value: selected }))
    on('ui.copy', () => ({ value: { isCopied: true } }))
    on('ui.blit', () => ({ value: {} }))
    await startSession($) // the frame timer is what watches the selection
    const mountReply = (requestId: string) =>
      $.ui.mount({
        plugin: 'neocode',
        surface: 'terminal',
        component: 'AssistantMessage',
        requestId,
        props: { ...REPLY, onScreen: ON_SCREEN },
        viewport: VIEWPORT,
      })
    const chosen = await mountReply('chosen')
    const other = await mountReply('other')

    selected = { text: 'for cell in grid:', requestId: 'chosen' }
    await frames(300)
    await chosen.redraw()
    await other.redraw()
    expect(hasRaster(await chosen.drawn())).toBe(false)
    expect(hasRaster(await other.drawn())).toBe(false)

    await frames(1300)
    await chosen.redraw()
    await other.redraw()
    expect(hasRaster(await chosen.drawn())).toBe(false) // a copy from it must never catch glyphs
    expect(hasRaster(await other.drawn())).toBe(true)

    // A selection across rows names no row, so the rain stays away while it lasts.
    selected = { text: 'for cell in grid:\n\nDone.' }
    await frames(1500)
    await other.redraw()
    expect(hasRaster(await other.drawn())).toBe(false)
  })
})

describe('scrolled back (0.2.1 fixes)', () => {
  const reply = (requestId: string, onScreen: { first: number; last: number; of: number } | null) =>
    ({ plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId, props: { ...REPLY, onScreen }, viewport: VIEWPORT }) as const
  const coveredRows = (tree: unknown) =>
    [...JSON.stringify(tree).matchAll(/"top":(\d+)[^}]*\}[^R]*Raster[^}]*?"rows":(\d+)/g)].flatMap(m =>
      Array.from({ length: Number(m[2]) }, (_, i) => Number(m[1]) + i),
    )
  const rasterRows = (tree: unknown) => [...JSON.stringify(tree).matchAll(/"top":(\d+)/g)].map(m => Number(m[1]))

  test('a row left over from another scroll position does not throw the window off', QUICK, async ($, on) => {
    on('ui.render', () => ENGINE)
    // Seen while scrolled to the top: cut off at the bottom of the window then.
    // The window has since jumped away and the engine never reported it again.
    await $.ui.mount(reply('old', { first: 0, last: 9, of: 41 }))
    // What is really on screen: the last 24 lines of a long reply, at the live bottom.
    const now = await $.ui.mount(reply('now', { first: 72, last: 95, of: 96 }))
    await now.redraw()
    const rows = rasterRows(await now.drawn())
    expect(rows.length).toBeGreaterThan(0) // rain over the top of the window
    expect(Math.min(...rows)).toBe(72) // starting at the window's top line
  })

  test('a row first seen after the row below it is still placed above it', QUICK, async ($, on) => {
    on('ui.render', () => ENGINE)
    const code = { text: Array.from({ length: 11 }, (_, i) => `    line ${i} of the reply`).join('\n'), isFirstOfReply: true }
    const reply = (requestId: string, onScreen: { first: number; last: number; of: number }) =>
      ({ plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId, props: { ...code, onScreen }, viewport: VIEWPORT }) as const
    // A resumed conversation: the bottom reply is drawn first, the one above
    // it only appears later, when a pass over the screen draws both in order.
    const below = await $.ui.mount(reply('below', { first: 0, last: 11, of: 12 }))
    await wait(50)
    const above = await $.ui.mount(reply('above', { first: 0, last: 11, of: 12 }))
    // A pass over the screen: both rows drawn at once, top to bottom.
    await Promise.all([above.redraw(), below.redraw()])
    await Promise.all([above.redraw(), below.redraw()])
    const covered = coveredRows(await above.drawn())
    expect(covered).toContain(11) // its last line sits twelve lines up, in the rain
  })

  test('rows shifting down as a sent prompt leaves the box are not a scroll', QUICK, async ($, on) => {
    on('ui.render', () => ENGINE)
    const clock = mockSession(on)
    on('ui.selection', () => ({ value: undefined }))
    on('ui.blit', () => ({ value: {} }))
    await startSession($)
    const row = await $.ui.mount(reply('row', { first: 6, last: 29, of: 30 })) // the newest row, its end in view
    await wait(500)
    // A two-line prompt is sent: Claude Code draws it at once as a placeholder
    // row, and the emptied prompt box gives the window two lines back.
    await $.ui.mount({
      plugin: 'neocode', surface: 'terminal', component: 'UserMessage', requestId: 'placeholder',
      props: { text: 'a long prompt', origin: { kind: 'composer' }, isExpanded: false, onScreen: { first: 0, last: 1, of: 2 } },
      viewport: VIEWPORT,
    })
    await row.redraw({ ...REPLY, onScreen: { first: 4, last: 29, of: 30 } })
    await wait(400)
    await clock.advance(100)
    await row.redraw()
    expect(hasRaster(await row.drawn())).toBe(true)
  })

  test('a jump that cuts no row off at the bottom still counts as a scroll', QUICK, async ($, on) => {
    on('ui.render', () => ENGINE)
    const clock = mockSession(on)
    on('ui.selection', () => ({ value: undefined }))
    on('ui.blit', () => ({ value: {} }))
    await startSession($)
    const row = await $.ui.mount(reply('row', null)) // off screen
    await wait(500)
    // Ctrl+End: the window lands on a row that was off screen, every line of it in view.
    await row.redraw({ ...REPLY, onScreen: { first: 0, last: 23, of: 24 } })
    await wait(400)
    await clock.advance(100)
    await row.redraw()
    expect(hasRaster(await row.drawn())).toBe(false) // paused: that was a scroll
    await wait(1100)
    await clock.advance(100)
    await row.redraw()
    expect(hasRaster(await row.drawn())).toBe(true) // and it comes back
  })
})

describe('selection (0.2.1 fixes)', () => {
  test('a selection that scrolls out of the drawn rows keeps its row, rather than pausing all rain', QUICK, async ($, on) => {
    on('ui.render', () => ENGINE)
    const clock = mockSession(on)
    let selected: { text: string; requestId?: string } = { text: 'for cell in grid:', requestId: 'chosen' }
    on('ui.selection', () => ({ value: selected }))
    on('ui.copy', () => ({ value: { isCopied: true } }))
    on('ui.blit', () => ({ value: {} }))
    await startSession($)
    const other = await $.ui.mount({
      plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId: 'other',
      props: { ...REPLY, onScreen: ON_SCREEN }, viewport: VIEWPORT,
    })
    const frames = async (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        await wait(100)
        await clock.advance(100)
      }
    }
    await frames(1300)
    selected = { text: 'for cell in grid:' } // same selection; its row is no longer drawn
    await frames(300)
    await other.redraw()
    expect(hasRaster(await other.drawn())).toBe(true)
  })
})

describe('streaming reply fade (0.3.0)', () => {
  test('the rain over a stream thins out smoothly before the row carrying it leaves', () => {
    // `remaining`: lines the anchor row and those above it still have on screen.
    let last = 0
    for (let remaining = 0; remaining <= 30; remaining++) {
      const f = streamFade(remaining, 30)
      expect(f).toBeGreaterThanOrEqual(last) // never thickens as the anchor nears the top
      expect(f - last).toBeLessThan(0.35) // no cliff: under a third per line
      last = f
    }
    expect(streamFade(10, 30)).toBe(1) // plenty of room: all of it
    expect(streamFade(1, 30)).toBe(0) // gone a line before the anchor leaves
  })

  // Glyphs the rasters draw on each line of the row's drawing.
  function glyphsPerLine(tree: unknown): Map<number, number> {
    const out = new Map<number, number>()
    const walk = (node: any, top: number) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'Raster') {
        const bytes = (Uint8Array as any).fromBase64(node.props.cells) as Uint8Array
        const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        for (let i = 0; i < node.props.rows; i++) {
          let n = 0
          for (let j = 0; j < node.props.columns; j++) if (words[(i * node.props.columns + j) * 3] !== 0x20) n++
          out.set(top + i, (out.get(top + i) ?? 0) + n)
        }
      }
      const childTop = node.props?.position === 'absolute' ? Number(node.props.top ?? 0) : top
      for (const child of node.children ?? []) walk(child, childTop)
    }
    walk(tree, 0)
    return out
  }

  test('the streamed lines lose their rain gradually as the reply nears the window height', async ($, on) => {
    on('ui.render', () => ENGINE)
    on('classic.MessageDisplay', () => ({}))
    const props = { text: 'Write me a parser', origin: { kind: 'composer' as const }, isExpanded: false }
    const prompt = await $.ui.mount({
      plugin: 'neocode',
      surface: 'terminal',
      component: 'UserMessage',
      props: { ...props, onScreen: { first: 0, last: 1, of: 2 } },
      viewport: VIEWPORT,
    })
    const window = 24 // VIEWPORT's 30 rows less the prompt and footer
    // `onScreen`: the prompt row above the reply, pushed up as the reply grows.
    const streamGlyphs = async (lines: number, index: number, onScreen: { first: number; last: number; of: number }) => {
      const delta = Array.from({ length: lines }, (_, i) => `x${i}`).join('\n') + '\n'
      await $.classic.MessageDisplay({ turn_id: 't', message_id: `m${index}`, index: 0, final: false, delta })
      await prompt.redraw({ ...props, onScreen })
      let n = 0
      for (const [line, count] of glyphsPerLine(await prompt.drawn())) if (line >= 2) n += count
      return n
    }
    const full = await streamGlyphs(Math.round(window * 0.6), 0, { first: 0, last: 1, of: 2 })
    const thin = await streamGlyphs(Math.round(window * 0.85), 1, { first: 0, last: 1, of: 2 })
    // The prompt row has one line left on screen: the next lines push it off.
    const gone = await streamGlyphs(window - 1, 2, { first: 1, last: 1, of: 2 })
    expect(full).toBeGreaterThan(0)
    expect(thin).toBeGreaterThan(0) // thinned, not cut off
    expect(thin).toBeLessThan(full * (0.85 / 0.6)) // fewer than the taller reply alone would give
    expect(gone).toBe(0)
  })

  for (const reach of ['gentle', 'balanced', 'deep'] as const) {
    test(`${reach}: a reply half the window tall already has rain around most of its older lines`, { options: { reach } }, async ($, on) => {
      on('ui.render', () => ENGINE)
      on('classic.MessageDisplay', () => ({}))
      const prompt = await $.ui.mount({
        plugin: 'neocode', surface: 'terminal', component: 'UserMessage',
        props: { text: 'Write it', origin: { kind: 'composer' }, isExpanded: false, onScreen: { first: 0, last: 1, of: 2 } },
        viewport: VIEWPORT,
      })
      const lines = 12 // half of the 24-line window
      const delta = Array.from({ length: lines }, (_, i) => `x${i}`).join('\n') + '\n'
      await $.classic.MessageDisplay({ turn_id: 't', message_id: 'half', index: 0, final: false, delta })
      await prompt.redraw()
      // The layer over the streamed lines: which of them it spans.
      const layer = JSON.stringify(await prompt.drawn()).match(/"top":(\d+)[^}]*\}[^R]*Raster","props":\{"key":"ustream","columns":\d+,"rows":(\d+)/)
      const spanned = layer ? Number(layer[2]) : 0
      const expected = { gentle: 4, balanced: 7, deep: 9 }[reach] // of its 13 lines (a blank, then 12)
      expect(spanned).toBeGreaterThanOrEqual(expected)
    })
  }

  // A reply streams under the prompt row (`index` keeps message ids apart),
  // then completes as a row of its own; returns that row's drawing.
  async function finishReply($: any, id: string, lines: number) {
    const anchor = await $.ui.mount({
      plugin: 'neocode', surface: 'terminal', component: 'UserMessage', requestId: `p-${id}`,
      props: { text: 'Write it', origin: { kind: 'composer' }, isExpanded: false, onScreen: { first: 0, last: 1, of: 2 } },
      viewport: VIEWPORT,
    })
    const text = Array.from({ length: lines }, (_, i) => `    line ${i} of streamed code`).join('\n')
    await $.classic.MessageDisplay({ turn_id: 't', message_id: id, index: 0, final: false, delta: text + '\n' })
    await anchor.redraw() // drawn mid-stream: the rain over the stream takes its fade
    await $.classic.MessageDisplay({ turn_id: 't', message_id: id, index: 1, final: true, delta: '' })
    const of = lines + 1
    return $.ui.mount({
      plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId: id,
      props: { text, isFirstOfReply: true, onScreen: { first: Math.max(0, of - 24), last: of - 1, of } }, viewport: VIEWPORT,
    })
  }

  test('a tall reply, its stream faded out, ramps its rain back in when it completes', { timeoutMs: 8000 }, async ($, on) => {
    on('ui.render', () => ENGINE)
    on('classic.MessageDisplay', () => ({}))
    const reply = await finishReply($, 'tall', 30)
    const first = glyphsTotal(await reply.drawn())
    await wait(400)
    await reply.redraw()
    const mid = glyphsTotal(await reply.drawn())
    await wait(500)
    await reply.redraw()
    const late = glyphsTotal(await reply.drawn())
    expect(first).toBeLessThan(late / 4) // starts nearly clean, where the fade left it
    expect(mid).toBeGreaterThan(first) // and climbs gradually
    expect(mid).toBeLessThan(late)
  })

  test('a short reply, its stream at full rain, completes without a blink', async ($, on) => {
    on('ui.render', () => ENGINE)
    on('classic.MessageDisplay', () => ({}))
    const reply = await finishReply($, 'short', 12)
    const first = glyphsTotal(await reply.drawn())
    await reply.redraw()
    expect(first).toBeGreaterThan(0)
    expect(glyphsTotal(await reply.drawn())).toBeGreaterThan(first / 2) // no drop to nothing and back
  })
})

function glyphsTotal(tree: unknown): number {
  let n = 0
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Raster') {
      const bytes = (Uint8Array as any).fromBase64(node.props.cells) as Uint8Array
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      for (let i = 0; i < words.length; i += 3) if (words[i] !== 0x20) n++
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return n
}

describe('parity: rain after a scroll matches the live bottom (0.3.1)', () => {
  // A reply of identical full-width code lines, so every line of the window
  // holds the same text wherever the window is.
  const LINE = 'a'.repeat(78)
  const UNIFORM = { text: '```\n' + Array.from({ length: 95 }, () => LINE).join('\n') + '\n```', isFirstOfReply: true }
  const WINDOW = 24 // VIEWPORT's 30 rows less the prompt and footer
  const at = (first: number) => ({ first, last: first + WINDOW - 1, of: 96 })
  const POSITIONS = { top: at(0), middle: at(40), bottom: at(72) }

  // Rain per window line: how many cells it covers, and their summed greenness.
  function rainByWindowLine(tree: unknown, first: number) {
    const out = Array.from({ length: WINDOW }, () => ({ cells: 0, green: 0 }))
    const walk = (node: any, top: number) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'Raster') {
        const bytes = (Uint8Array as any).fromBase64(node.props.cells) as Uint8Array
        const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        for (let i = 0; i < node.props.rows; i++) {
          const line = top + i - first
          if (line < 0 || line >= WINDOW) continue
          for (let j = 0; j < node.props.columns; j++) {
            const at3 = (i * node.props.columns + j) * 3
            if (words[at3] === 0x20) continue
            const rgb = words[at3 + 1] ?? 0
            out[line]!.cells++
            // Greenness: how far the cell has gone from grey (scrambled text) to Matrix green.
            out[line]!.green += ((rgb >> 8) & 0xff) - (((rgb >> 16) & 0xff) + (rgb & 0xff)) / 2
          }
        }
      }
      const childTop = node.props?.position === 'absolute' ? Number(node.props.top ?? 0) : top
      for (const child of node.children ?? []) walk(child, childTop)
    }
    walk(tree, 0)
    return out
  }

  // Compares two windows band by band (4 lines): the share of cells rained on,
  // and how bright that rain is. Bites are seeded per line of text, so single
  // lines vary a little between positions; bands even that out.
  // Only window lines that hold a code line at both positions are compared
  // (the reply's first line, row 0, is the blank above it).
  function expectSameRain(live: ReturnType<typeof rainByWindowLine>, other: ReturnType<typeof rainByWindowLine>, where: string, first: number) {
    const isCode = (line: number) => first + line >= 1
    for (let band = 0; band < WINDOW; band += 4) {
      const lines = [0, 1, 2, 3].map(i => band + i).filter(isCode)
      if (lines.length === 0) continue
      const sum = (w: typeof live) => lines.reduce((a, l) => ({ cells: a.cells + w[l]!.cells, green: a.green + w[l]!.green }), { cells: 0, green: 0 })
      const a = sum(live)
      const b = sum(other)
      const share = (x: number) => x / (lines.length * 80)
      expect({ where, band, diff: Math.abs(share(a.cells) - share(b.cells)) < 0.12 }).toEqual({ where, band, diff: true })
      if (a.cells > 40 && b.cells > 40) {
        const brightness = Math.abs(a.green / a.cells - b.green / b.cells)
        expect({ where, band, bright: brightness < 30 }).toEqual({ where, band, bright: true })
      }
    }
    // Lines with no rain at the live bottom have none here either, and fully rained lines stay full.
    for (let line = 0; line < WINDOW; line++) {
      if (!isCode(line)) continue
      if (live[line]!.cells === 0) expect({ where, line, cells: other[line]!.cells }).toEqual({ where, line, cells: 0 })
      if (live[line]!.cells >= 77.5) expect({ where, line, full: other[line]!.cells >= 77.5 }).toEqual({ where, line, full: true })
    }
  }

  for (const reach of ['gentle', 'balanced', 'deep'] as const) {
    test(`${reach}: top, middle and bottom after a scroll look like the live bottom`, { options: { resumeDelay: 1, reach }, timeoutMs: 25000 }, async ($, on) => {
      on('ui.render', () => ENGINE)
      const ui = await $.ui.mount({
        plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId: 'uniform',
        props: { ...UNIFORM, onScreen: POSITIONS.bottom }, viewport: VIEWPORT,
      })
      // The rain animates, so each position is sampled over a second and summed.
      const sample = async (first: number) => {
        const total = Array.from({ length: WINDOW }, () => ({ cells: 0, green: 0 }))
        for (let i = 0; i < 6; i++) {
          if (i) await wait(200)
          await ui.redraw()
          rainByWindowLine(await ui.drawn(), first).forEach((l, line) => {
            total[line]!.cells += l.cells / 6
            total[line]!.green += l.green / 6
          })
        }
        return total
      }
      const live = await sample(POSITIONS.bottom.first)
      expect(live.some(l => l.cells > 0)).toBe(true)
      await wait(500)
      for (const [where, onScreen] of [['top', POSITIONS.top], ['middle', POSITIONS.middle], ['bottom', POSITIONS.bottom]] as const) {
        // Scroll there (the rain clears), then wait out the resume delay.
        await ui.redraw({ ...UNIFORM, onScreen: { ...onScreen, last: onScreen.last - 1 } })
        await ui.redraw({ ...UNIFORM, onScreen })
        await wait(1150)
        expectSameRain(live, await sample(onScreen.first), where, onScreen.first)
      }
    })
  }
})

describe('a stream that stops without finishing (0.3.2)', () => {
  const LINE = 'a'.repeat(78)
  const UNIFORM = { text: '```\n' + Array.from({ length: 95 }, () => LINE).join('\n') + '\n```', isFirstOfReply: true }
  const AT_BOTTOM = { first: 72, last: 95, of: 96 }
  const cellsPerLine = (tree: unknown) => {
    const out = new Map<number, number>()
    const walk = (node: any, top: number) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'Raster') {
        const bytes = (Uint8Array as any).fromBase64(node.props.cells) as Uint8Array
        const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        for (let i = 0; i < node.props.rows; i++) {
          let n = 0
          for (let j = 0; j < node.props.columns; j++) if (words[(i * node.props.columns + j) * 3] !== 0x20) n++
          out.set(top + i, (out.get(top + i) ?? 0) + n)
        }
      }
      const childTop = node.props?.position === 'absolute' ? Number(node.props.top ?? 0) : top
      for (const child of node.children ?? []) walk(child, childTop)
    }
    walk(tree, 0)
    return out
  }
  // Lines of the window with any rain, and the fully rained ones: the profile.
  const profile = (tree: unknown) => {
    const lines = cellsPerLine(tree)
    const rained = [...lines].filter(([, n]) => n > 0).map(([l]) => l).sort((a, b) => a - b)
    const full = [...lines].filter(([, n]) => n >= 78).map(([l]) => l).sort((a, b) => a - b)
    return { lowestRained: rained[rained.length - 1] ?? -1, lowestFull: full[full.length - 1] ?? -1 }
  }

  for (const reach of ['gentle', 'balanced', 'deep'] as const) {
    test(`${reach}: once an interrupted turn ends, the rain is the live-bottom profile again`, { options: { reach } }, async ($, on) => {
      on('ui.render', () => ENGINE)
      on('classic.MessageDisplay', () => ({}))
      on('turn.complete', () => ({ text: '' }))
      const reply = await $.ui.mount({
        plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId: 'r',
        props: { ...UNIFORM, onScreen: AT_BOTTOM }, viewport: VIEWPORT,
      })
      const live = profile(await reply.drawn())
      // A new reply starts streaming, then the turn is cut off (Esc, Ctrl+C, an
      // error): no final flush, and no row of its own ever arrives.
      const delta = Array.from({ length: 20 }, (_, i) => `x${i}`).join('\n') + '\n'
      await $.classic.MessageDisplay({ turn_id: 't', message_id: 'cut', index: 0, final: false, delta })
      await $.turn.complete({ turnId: 't', reason: 'aborted', isAborted: true, answer: '', durationMs: 1000 } as never)
      await reply.redraw()
      expect(profile(await reply.drawn())).toEqual(live)
    })
  }

  test('a row that vanishes (a prompt Esc took back) stops counting as the newest row', { timeoutMs: 8000 }, async ($, on) => {
    on('ui.render', () => ENGINE)
    const clock = mockSession(on)
    on('ui.selection', () => ({ value: undefined }))
    on('ui.blit', () => ({ value: {} }))
    on('classic.MessageDisplay', () => ({}))
    await startSession($)
    const reply = await $.ui.mount({
      plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId: 'r',
      props: { ...UNIFORM, onScreen: { first: 74, last: 95, of: 96 } }, viewport: VIEWPORT,
    })
    const live = profile(await reply.drawn())
    // A prompt is sent and drawn below the reply, then taken back: it is never drawn again.
    await $.ui.mount({
      plugin: 'neocode', surface: 'terminal', component: 'UserMessage', requestId: 'withdrawn',
      props: { text: 'never mind', origin: { kind: 'composer' }, isExpanded: false, onScreen: { first: 0, last: 1, of: 2 } },
      viewport: VIEWPORT,
    })
    // Redraw passes go by without it (the frame timer runs them).
    for (let i = 0; i < 12; i++) {
      await wait(100)
      await clock.advance(100)
      await reply.redraw()
    }
    // A stream now (the next prompt's reply) would hang below the newest row;
    // the vanished prompt must not be taken for it.
    const delta = Array.from({ length: 20 }, (_, i) => `x${i}`).join('\n') + '\n'
    await $.classic.MessageDisplay({ turn_id: 't2', message_id: 'next', index: 0, final: false, delta })
    await reply.redraw()
    // The reply is the newest row still drawn, so the stream's rain hangs from it.
    expect(JSON.stringify(await reply.drawn())).toContain('"key":"ustream"')
    void live
  })
})


// What the plugin is allowed to do, held to what the README and the header of
// hooks/register.tsx say: the three events it observes go on untouched, the
// store only ever holds the two documented flags, and the one clipboard write
// is the person's own selection, re-copied.
describe('display-only: what the code touches (0.3.3)', () => {
  test('MessageDisplay, turn.complete and prompt.edit reach the engine untouched, with its answer unchanged', async ($, on) => {
    const seen: Record<string, unknown[]> = { display: [], complete: [], edit: [] }
    const answers = {
      display: {},
      complete: { text: 'the engine’s own answer' },
      edit: { text: 'hello', cursor: 5 },
    }
    on('classic.MessageDisplay', (_$, e) => (seen.display!.push(e), answers.display))
    on('turn.complete', (_$, e) => (seen.complete!.push(e), answers.complete as never))
    on('prompt.edit', (_$, e) => (seen.edit!.push(e), answers.edit as never))

    const display = { turn_id: 't', message_id: 'm', index: 0, final: false, delta: 'one\ntwo\n' }
    const complete = { turnId: 't', reason: 'aborted', isAborted: true, answer: 'partial', durationMs: 1200 }
    const edit = {
      origin: { kind: 'composer' }, text: 'hello', cursor: 5, start: 4, end: 4, inputText: 'o',
    }
    const results = {
      display: await $.classic.MessageDisplay(display),
      complete: await $.turn.complete(complete as never),
      // The testing kit raises it at runtime, but its types leave `prompt.edit` out of the engine's `$`.
      edit: await ($.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }).edit(edit),
    }
    // The kit stamps its own fields (session id, event name) on what it raises;
    // every field the event was raised with must arrive as it was.
    expect(seen.display).toMatchObject([display])
    expect(seen.complete).toMatchObject([complete])
    expect(seen.edit).toMatchObject([edit])
    expect(results.display).toEqual(answers.display)
    expect(results.complete).toEqual(answers.complete)
    expect(results.edit).toEqual(answers.edit)
  })

  test('a session using every feature writes only the two documented flags, and copies only the selection', QUICK, async ($, on) => {
    on('ui.render', () => ENGINE)
    // mockSession's world, but with a store that records every write.
    const clock = mock.clock(on)
    on('settings.read', () => ({ value: {} }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    const stored: Record<string, unknown> = {}
    const writes: string[] = []
    const copies: unknown[] = []
    on('store.get', (_$, e) => ({ value: stored[e.key] }))
    on('store.set', (_$, e) => ((stored[e.key] = e.value), writes.push(`set ${e.key}`), { value: undefined }))
    on('store.delete', (_$, e) => (writes.push(`delete ${e.key}`), { value: undefined }))
    on('store.keys', () => ({ value: Object.keys(stored) }))
    let selected: { text: string; requestId?: string } | undefined
    on('ui.selection', () => ({ value: selected }))
    on('ui.copy', (_$, e) => (copies.push(e.text), { value: { isCopied: true } }))
    on('ui.blit', () => ({ value: {} }))
    on('classic.MessageDisplay', () => ({}))
    on('turn.complete', () => ({ text: '' }))
    const frames = async (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        await wait(100)
        await clock.advance(100)
      }
    }
    await startSession($)

    // Drawn on a surface without the fullscreen renderer: the one-time hint.
    await $.ui.mount({
      plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId: 'plain',
      props: { ...REPLY, onScreen: ON_SCREEN }, viewport: { columns: 80, rows: 30, isFullscreen: false },
    })
    const chosen = await $.ui.mount({
      plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId: 'chosen',
      props: { ...REPLY, onScreen: ON_SCREEN }, viewport: VIEWPORT,
    })
    // The toggle, every spelling of it.
    for (const args of ['off', 'on', 'status', '', 'off', 'on']) {
      await $.command.run({ command: 'neocode', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
    }
    // A stream that is cut off, then a selection that catches glyphs and is repaired.
    await $.classic.MessageDisplay({ turn_id: 't', message_id: 'm', index: 0, final: false, delta: 'a\nb\n' })
    await $.turn.complete({ turnId: 't', reason: 'aborted', isAborted: true, answer: '', durationMs: 1 } as never)
    await chosen.redraw()
    selected = { text: 'ﾊﾟﾗ cell ｱｲｳ', requestId: 'chosen' }
    await frames(300)
    await chosen.redraw()
    selected = { text: 'for cell in grid:', requestId: 'chosen' }
    await frames(1500)

    // Only the two flags, only ever set, both booleans.
    expect([...new Set(writes)].sort()).toEqual(['set enabled', 'set fullscreenHinted'])
    expect(stored).toEqual({ enabled: true, fullscreenHinted: true })
    // The one clipboard write is the person's own selection, as it really reads.
    expect(copies).toEqual(['for cell in grid:'])
  })
})

// Reach and Glyphs are free text in /config (the directory doesn't accept a
// fixed list of options yet), so a typed value is read case-insensitively and
// trimmed, and anything else is the default.
describe('typed options (0.3.5)', () => {
  test('a typed value is matched without regard to case or surrounding spaces; anything else is the default', () => {
    const REACH = ['gentle', 'balanced', 'deep'] as const
    expect(pickOption('deep', REACH, 'balanced')).toBe('deep')
    expect(pickOption('Deep', REACH, 'balanced')).toBe('deep')
    expect(pickOption(' deep ', REACH, 'balanced')).toBe('deep')
    expect(pickOption('\tGENTLE\n', REACH, 'balanced')).toBe('gentle')
    for (const other of ['', '  ', 'deeper', 'de ep', 'medium', undefined, null, 3, true, ['deep']]) {
      expect(pickOption(other, REACH, 'balanced')).toBe('balanced')
    }
    expect(pickOption(' Letters ', ['katakana', 'letters'] as const, 'katakana')).toBe('letters')
    expect(pickOption('kana', ['katakana', 'letters'] as const, 'katakana')).toBe('katakana')
  })

  // The same reply drawn under each option value: how far down the rain
  // reaches (the lowest line with any), and whether any glyph is katakana.
  const LINE = 'a'.repeat(78)
  const TALL = { text: '```\n' + Array.from({ length: 95 }, () => LINE).join('\n') + '\n```', isFirstOfReply: true }
  const look = (tree: unknown) => {
    let lowest = -1
    let isKatakana = false
    const walk = (node: any, top: number) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'Raster') {
        const bytes = (Uint8Array as any).fromBase64(node.props.cells) as Uint8Array
        const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        for (let i = 0; i < node.props.rows; i++) {
          for (let j = 0; j < node.props.columns; j++) {
            const glyph = words[(i * node.props.columns + j) * 3]!
            if (glyph === 0x20) continue
            lowest = Math.max(lowest, top + i)
            if (glyph >= 0xff61 && glyph <= 0xff9f) isKatakana = true
          }
        }
      }
      const childTop = node.props?.position === 'absolute' ? Number(node.props.top ?? 0) : top
      for (const child of node.children ?? []) walk(child, childTop)
    }
    walk(tree, 0)
    return { lowest, isKatakana }
  }
  const seen = new Map<string, ReturnType<typeof look>>()
  const cases: [string, { reach: string; glyphs: string }][] = [
    ['deep', { reach: 'deep', glyphs: 'letters' }],
    ['typed', { reach: ' Deep ', glyphs: ' LETTERS ' }],
    ['balanced', { reach: 'balanced', glyphs: 'katakana' }],
    ['unknown', { reach: 'medium', glyphs: 'runes' }],
  ]
  for (const [name, options] of cases) {
    test(`draws with reach ${JSON.stringify(options.reach)} and glyphs ${JSON.stringify(options.glyphs)}`, { options }, async ($, on) => {
      on('ui.render', () => ENGINE)
      const reply = await $.ui.mount({
        plugin: 'neocode', surface: 'terminal', component: 'AssistantMessage', requestId: 'r',
        props: { ...TALL, onScreen: { first: 72, last: 95, of: 96 } }, viewport: VIEWPORT,
      })
      seen.set(name, look(await reply.drawn()))
    })
  }
  test('a typed " Deep " and " LETTERS " draw as deep and letters; unknown values draw as the defaults', () => {
    expect(seen.size).toBe(4)
    expect(seen.get('typed')).toEqual(seen.get('deep'))
    expect(seen.get('typed')!.isKatakana).toBe(false)
    expect(seen.get('unknown')).toEqual(seen.get('balanced'))
    expect(seen.get('unknown')!.isKatakana).toBe(true)
    // deep reaches further down the window than balanced does
    expect(seen.get('deep')!.lowest).toBeGreaterThan(seen.get('balanced')!.lowest)
  })
})
