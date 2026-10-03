# neocode

**A Claude Code mod that turns your scrolling code into Matrix digital rain.**

As Claude writes, code near the prompt stays crisp and readable. The further a line scrolls up the screen, the more it decays: first its letters start scrambling in place, then they turn into green half-width katakana, and by the top of the screen the code has dissolved into full digital rain. The rain streams *upward*, the film's rain reversed, with bright leading heads, fading trails and a ripple that climbs the screen. It never stops moving.

It is purely cosmetic. Scroll up and the effect gets out of the way so you can read the real code, and `/neocode off` turns it off.

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

## How scrolling switches it off

You can't read decayed code, so neocode steps aside whenever you're reading rather than watching:

- **Scrolling.** Claude Code tells a mod which lines of each transcript row are on screen. When the newest row is no longer fully in view, you've scrolled away from the live bottom, and every overlay is removed at once so you see the real text. Scroll back to the bottom and the rain returns.
- **Selecting text.** While you select text with the mouse, the rain is removed so you select the real text. It returns after your next prompt or command.

## Configuration

Open `/config` and look for the rows marked `· neocode`:

| Option | Default | What it does |
| --- | --- | --- |
| Rain on at start | `true` | Whether the effect starts on. Your last `/neocode` choice overrides this. |
| Reach | `balanced` | How far down the screen the decay reaches: `gentle` (top half only), `balanced`, or `deep` (almost to the prompt). |
| Glyphs | `katakana` | `katakana` for the authentic Matrix glyphs. `letters` uses ASCII only, for fonts without half-width katakana. |
| Frames per second | `15` | Animation rate, 5 to 30. Lower it if your terminal struggles. |

If you've turned on **Reduce motion** in `/config`, neocode starts off. You can still turn it on with `/neocode on`.

## How it works

Claude Code draws every transcript row as usual. neocode's `ui.render` hook wraps each row's drawing and lays [`Raster`](https://code.claude.com/docs/en/plugins/mods/reference.md) cell grids over the parts that should look decayed, positioned absolutely so nothing underneath moves:

1. **Distance from the prompt.** Each row reports how tall it is and which of its lines are visible. Stacking those heights from the bottom gives every line's distance above the prompt box, and that distance sets how decayed the line is.
2. **Decay, bite by bite.** In the transition band, a line's text is cut into short segments that each corrupt once the decay passes their own fixed threshold, so the corruption eats into the code instead of flickering at random. Near the top, whole lines are covered with rain.
3. **Animation without re-rendering.** A timer repaints the mounted grids with `$.ui.blit`, which only changes cells. The rain is computed from position and time alone, so there's no per-cell state to track.

All the maths lives in [`hooks/matrix.ts`](hooks/matrix.ts), which has no I/O. The hooks are in [`hooks/register.tsx`](hooks/register.tsx).

## Display-only, and what the code touches

Mods run unsandboxed with your permissions, so here is everything neocode does:

- **Hooks:** `ui.render` on transcript rows (to draw the overlay), `command.run` for `/neocode`, and `session.start`/`session.end` (to set up the timer and command, and to reset after `/clear`). It hooks nothing that carries conversation data: no `session.append`, `tool.call` or `prompt.*`.
- **Never changes what the model sees, what the transcript stores, or what gets written to files.** It doesn't rewrite any props. It draws on top of the engine's own drawing.
- **Clipboard.** Claude Code copies a mouse selection from what's on screen, so neocode removes the rain while you select. If a selection is made faster than one animation frame (a double-click on a word, for example), the copy can catch glyphs. When that happens, neocode re-copies the same selection once the rain is gone, so the clipboard ends up holding the real text you selected.
- **Storage:** two flags in its own plugin store: your `/neocode` choice, and whether the fullscreen hint has been shown.
- **Settings:** reads one setting, `prefersReducedMotion`.
- **No** network access, processes, file reads or writes, dependencies, install scripts or build step. The source is the TypeScript you see here.

Run `claude plugin validate --strict .claude-plugin/plugin.json` in a clone to see the engine's own list of what the module hooks and calls.

## Known limitations

- **Fullscreen renderer only.** The default renderer prints finished rows into terminal scrollback, where they can't be redrawn.
- **Text positions are estimates.** A mod is told how tall each row is, but not what's in it. neocode estimates where text sits from the row's content (markdown, tool input or output), so in the transition band a bite occasionally lands on whitespace. Higher up, everything is rain anyway.
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
