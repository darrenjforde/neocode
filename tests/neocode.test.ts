// Run with: claude plugin test .
import { describe, expect, test } from 'claude-code/testing'

import { BLOCK, bites, corruption, markdownExtents, paint } from '../hooks/matrix'

const REPLY = {
  text: '```python\nfor cell in grid:\n    print(cell)\n```\nDone.',
  isFirstOfReply: true,
}
const VIEWPORT = { columns: 80, rows: 30, isFullscreen: true }
// One 20-row reply filling the transcript: its top rows are far from the prompt.
const ON_SCREEN = { first: 0, last: 19, of: 20 }

const hasRaster = (tree: unknown) => JSON.stringify(tree).includes('"Raster"')

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
