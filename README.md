# neocode

**A Claude Code mod that turns your scrolling code into Matrix digital rain.**

As Claude writes, code near the prompt stays crisp and readable. The further a line scrolls up the screen, the more it decays: first its letters start scrambling in place, then they turn into green half-width katakana, and by the top of the screen the code has dissolved into full digital rain. The rain streams *upward*, the film's rain reversed, with bright leading heads, fading trails and a ripple that climbs the screen. It never stops moving.

It is purely cosmetic. Scroll or select text and the rain clears at once so you can read the real code. It comes back by itself a few seconds after you stop, and `/neocode off` turns it off.

<!-- SCREENSHOT / GIF ──────────────────────────────────────────────────────────
     Put a screenshot or screen recording here, e.g.:
     ![neocode in action](docs/neocode.gif)
     ─────────────────────────────────────────────────────────────────────────── -->
> 📸 **Screenshot / GIF goes here.**

## Requirements

- **Claude Code 2.1.287 or later**, the first release with mods.
- **The fullscreen renderer.** Run `/tui fullscreen` in Claude Code, or set `"tui": "fullscreen"` in your settings. Only the fullscreen renderer reports which lines are on screen. Under the default renderer, neocode does nothing and tells you so once.
- **A font with half-width katakana** for the authentic glyphs. Most macOS and Linux terminal fonts fall back to one automatically. If you see boxes or tofu, set **Glyphs** to `letters` (see [Configuration](#configuration)).

## Install

In Claude Code:

```
/plugin marketplace add darrenjforde/neocode
/plugin install neocode@neocode
```

Or from a shell:

```sh
claude plugin marketplace add darrenjforde/neocode
claude plugin install neocode@neocode
```

The installer may say the plugin's options aren't set yet. That's fine: the defaults apply until you change them.

Start a new session, or run `/reload-plugins`, and the rain begins as soon as there's enough transcript to scroll.

## Turning it on and off

| Command | Effect |
| --- | --- |
| `/neocode` | Toggle the rain |
| `/neocode off` / `/neocode on` | Turn it off / on |
| `/neocode status` | Show whether it's on |

The toggle runs immediately, even while Claude is mid-turn, and is remembered across sessions. Feedback appears as a toast, so the toggle adds nothing to your conversation.

## Reading and copying: how it gets out of the way

You can't read decayed code, so neocode steps aside whenever you're interacting with the transcript, and comes back by itself once you stop. The wait is the **Resume after** option, 5 seconds by default.

- **Scrolling.** Every scroll, by mouse wheel or keyboard, clears the rain from the whole screen at once. Once you've gone the full delay without scrolling, it returns. If you're still scrolled back through the conversation, it uses a gentler pattern: the lower half of the window stays fully readable and only the upper half turns to rain. Back at the live bottom, it decays as usual.
- **Selecting text.** Selecting with the mouse clears the rain, so what you select is the real text. Once the selection has stopped changing for the full delay, the rain returns everywhere except the transcript row you selected in. That row stays clean for as long as the selection exists, so copying it later, with Ctrl+C, Ctrl+Shift+C or Cmd+C, also gets the real text. If your selection spans several rows, the rain stays off until your next prompt or command, because Claude Code doesn't tell a mod which rows a multi-row selection covers.

### How scrolling is detected

Mods get no scroll event for the transcript. Instead, Claude Code reports which lines of each row are on screen whenever the rows at the window's edges move. New output at the live bottom only ever pushes rows off the *top* of the window, so neocode treats a row cut off at the *bottom* of the window, or one that just was, as a scroll.

## Configuration

Open `/config` and look for the rows marked `· neocode`:

| Option | Default | What it does |
| --- | --- | --- |
| Rain on at start | `true` | Whether the effect starts on. Your last `/neocode` choice overrides this. |
| Reach | `balanced` | How far down the screen the decay reaches: `gentle` (top half only), `balanced`, or `deep` (almost to the prompt). |
| Glyphs | `katakana` | `katakana` for the authentic Matrix glyphs. `letters` uses ASCII only, for fonts without half-width katakana. |
| Resume after (seconds) | `5` | How long the rain waits after your last scroll or selection before coming back, 1 to 60. |
| Frames per second | `15` | Animation rate, 5 to 30. Lower it if your terminal struggles. |

If you've turned on **Reduce motion** in `/config`, neocode starts off. You can still turn it on with `/neocode on`.

## How it works

Claude Code draws every transcript row as usual. neocode's `ui.render` hook wraps each row's drawing and lays [`Raster`](https://code.claude.com/docs/en/plugins/mods/reference.md) cell grids over the parts that should look decayed, positioned absolutely so nothing underneath moves:

1. **Distance from the prompt.** Each row reports how tall it is and which of its lines are visible. Stacking those heights gives every line's distance above the bottom of the window, and that distance sets how decayed the line is. At the live bottom the count runs up from the newest output; when you're scrolled back it runs down from the row at the top of the window.
2. **Decay, bite by bite.** In the transition band, a line's text is cut into short segments that each corrupt once the decay passes their own fixed threshold, so the corruption eats into the code instead of flickering at random. Near the top, whole lines are covered with rain.
3. **Animation without re-rendering.** A timer repaints the mounted grids with `$.ui.blit`, which only changes cells. The rain is computed from position and time alone, so there's no per-cell state to track.

### While Claude is still writing

While a reply streams, Claude Code draws it in a part of the screen that mods can't hook. The reply only becomes a transcript row, and neocode's to draw on, once it's complete. neocode still does what it can live:

- It reads the streamed lines from Claude Code's `MessageDisplay` event, without changing them, to know how tall the reply is so far. The rows *above* the reply decay as it pushes them up the screen.
- It hangs rain from the row just above the reply, which fills the space around the streamed lines.
- The moment the reply completes, the reply itself decays.

All the maths lives in [`hooks/matrix.ts`](hooks/matrix.ts), which has no I/O. The hooks are in [`hooks/register.tsx`](hooks/register.tsx).

## Display-only, and what the code touches

Mods run unsandboxed with your permissions, so here is everything neocode does:

- **Hooks:**
  - `ui.render` on transcript rows, to draw the overlay.
  - `command.run` for `/neocode`.
  - `session.start` and `session.end`, to set up the timer and command, and to reset after `/clear`.
  - `classic.MessageDisplay`, to read the streamed reply's lines so it knows how tall the reply is. It passes the event on unchanged, and that event is display-only in Claude Code anyway.

  It hooks nothing that changes conversation data: no `session.append`, `tool.call` or `prompt.*`.
- **Never changes what the model sees, what the transcript stores, or what gets written to files.** It doesn't rewrite any props. It draws on top of the engine's own drawing.
- **Clipboard.** Claude Code copies a mouse selection from what's on screen, both when you release the mouse and when you press a copy key later. So neocode removes the rain while you select, and never puts it back over the row you selected in while that selection exists. If a selection is made faster than one animation frame (a double-click on a word, for example), the copy on release can catch glyphs. When that happens, neocode re-copies the same selection once the rain is gone, so the clipboard ends up holding the real text you selected.
- **Storage:** two flags in its own plugin store: your `/neocode` choice, and whether the fullscreen hint has been shown.
- **Settings:** reads one setting, `prefersReducedMotion`.
- **No** network access, processes, file reads or writes, dependencies, install scripts or build step. The source is the TypeScript you see here.

Run `claude plugin validate --strict .claude-plugin/plugin.json` in a clone to see the engine's own list of what the module hooks and calls.

## Known limitations

- **Fullscreen renderer only.** The default renderer prints finished rows into terminal scrollback, where they can't be redrawn.
- **Text positions are estimates.** A mod is told how tall each row is, but not what's in it. neocode estimates where text sits from the row's content (markdown, tool input or output), so in the transition band a bite occasionally lands on whitespace. Higher up, everything is rain anyway.
- **A reply still streaming isn't fully reachable.** Claude Code paints streaming text over anything a mod lays on it, and it stops drawing the row above once that row scrolls off. So a reply's own text decays only once it completes. Until then you get rain around its lines, but only until the reply fills the screen; after that it stays plain until it's done. See [While Claude is still writing](#while-claude-is-still-writing).
- **Multi-row selections pause the rain until your next prompt or command,** because no API says which rows they cover.
- **Rows the engine doesn't report**, such as the welcome banner and the live spinner, are left as they are.
- **Glyph width.** Half-width katakana are one cell wide in standard terminal fonts. A font that draws them wide will misalign the rain; use `letters`.
- **Light themes.** The palette is tuned for dark backgrounds.
- **Cost.** With a full screen of rain at 15 fps, expect about 10–20% of one CPU core while the effect runs, and close to nothing when it's off or paused.

## Development

```sh
claude --plugin-dir . --settings '{"tui":"fullscreen"}'   # run it from a clone; edits hot-reload
claude plugin test .                                      # tests in tests/
claude plugin validate --strict .claude-plugin/plugin.json
```

Bump `version` in `.claude-plugin/plugin.json` for every release: `claude plugin update` only fetches a version it hasn't installed.

Claude Code writes its API declarations into `.claude-plugin/types/` the first time it loads the folder. After that, `npx -p typescript tsc -p .` type-checks the mod.

## License

[MIT](LICENSE) © Darren Forde
