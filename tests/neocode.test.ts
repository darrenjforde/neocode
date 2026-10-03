// Run with: claude plugin test .
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { BLOCK, bites, corruption, markdownExtents, paint } from '../hooks/matrix'

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
  test('a scroll clears the rain at once; it returns, softer, once scrolling stops', QUICK, async ($, on) => {
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

    // Quiet for the whole delay: rain again, over the top of the window only.
    await wait(600)
    await ui.redraw()
    const tree = JSON.stringify(await ui.drawn())
    expect(tree).toContain('"Raster"')
    expect(tree).not.toContain('"top":17') // the lines nearest the window's bottom stay readable
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

