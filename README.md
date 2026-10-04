# neocode

**A Claude Code mod that turns your scrolling code into Matrix digital rain.**

As Claude writes, code near the prompt stays crisp and readable. The further a line scrolls up the screen, the more it decays: first its letters start scrambling in place, then they turn into green half-width katakana, and by the top of the screen the code has dissolved into full digital rain. The rain streams *upward*, the film's rain reversed, with bright leading heads, fading trails and a ripple that climbs the screen. It never stops moving.

It is purely cosmetic. Scroll or select text and the rain clears at once so you can read the real code. It comes back by itself a few seconds after you stop, and `/neocode off` turns it off.

<img width="1431" height="1195" alt="Screenshot 2026-10-04 at 17 47 11" src="https://github.com/user-attachments/assets/164fe521-e9d5-4932-bd08-00671586a4db" />
<img width="1490" height="1057" alt="Screenshot 2026-10-04 at 17 43 24" src="https://github.com/user-attachments/assets/c7fa2a75-e7e9-48bd-8251-56f96e93dba8" />


## Where it works

- **A terminal running `claude` in the fullscreen renderer** (`/tui fullscreen`). That includes the integrated terminal in VS Code or Cursor. It has been tested in tmux, iTerm2 and macOS Terminal on macOS. The checks behind the 0.3 releases (streaming, clipboard and scroll behaviour) were run in tmux. Other terminals, Linux and Windows haven't been tested.
- **The VS Code extension's chat panel:** mods run their hooks there but draw no interface, so neocode shows nothing.
- **The Desktop app's Code tab:** untested. It may not draw neocode's overlay.
- **Desktop WSL sessions:** plugins aren't available there.

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

## Try it

1. **See the rain.** Ask Claude for something long, such as `Print a 100-line Python module in one code block`. Once the reply finishes, the lines far from the prompt scramble into green katakana and then dissolve into rain, while the newest lines stay readable. While it is still streaming, you get rain around its lines instead.
2. **Read something old.** Scroll up with the mouse wheel. The rain clears at once, so you can read the real code. Stop for 5 seconds and it returns.
3. **Copy real code.** Select a few lines of code with the mouse, then paste. You get the code, never glyphs. `/neocode off` turns the effect off, and `/neocode on` brings it back.

## Turning it on and off

| Command | Effect |
| --- | --- |
| `/neocode` | Toggle the rain |
| `/neocode off` / `/neocode on` | Turn it off / on |
| `/neocode status` | Show whether it's on |

The toggle runs immediately, even while Claude is mid-turn, and is remembered across sessions. Feedback appears as a toast, so the toggle adds nothing to your conversation.

## Reading and copying: how it gets out of the way

You can't read decayed code, so neocode steps aside whenever you're interacting with the transcript, and comes back by itself once you stop. The wait is the **Resume after** option, 5 seconds by default.

- **Scrolling.** Every scroll, by mouse wheel or keyboard (PgUp, PgDn, Ctrl+Home, Ctrl+End), clears the rain from the whole screen at once. Once you've gone the full delay without scrolling, it returns exactly as it looks at the live bottom, wherever you've scrolled to. Decay is measured up from the bottom edge of the window, using your **Reach** setting.
- **Selecting text.** Selecting with the mouse clears the rain, so what you select is the real text. Under the fullscreen renderer Claude Code captures the mouse, so the selection is Claude Code's own, not the terminal's (in macOS Terminal, Edit > Copy is greyed out). The text is copied when you release the mouse, and again with Ctrl+Shift+C (tested in tmux). Once the selection has stopped changing for the full delay, the rain returns everywhere except the transcript row you selected in. That row stays clean while the selection might still be highlighted, so a later copy also gets the real text.
  - Typing anything in the prompt box clears the highlight, and the rain returns over that row too.
  - Claude Code doesn't tell mods when a click elsewhere clears the highlight. After a click, the row stays clean until you type, send a prompt or run a command.
  - A selection spanning several rows doesn't say which rows it covers, so the rain stays off until you type, send a prompt or run a command.

### How scrolling is detected

Mods get no scroll event for the transcript. Instead, Claude Code reports which lines of each row are on screen whenever they change. New output at the live bottom only ever pushes rows up and off the top. So neocode treats any other movement as a scroll: a row cut off at the bottom of the window, a row coming into view from off screen, or a row's top line coming back. It ignores moves that happen as output arrives, or as the prompt box changes height while you type or send.

A row that jumps off screen in one move (Ctrl+Home, Ctrl+End, PgUp) isn't always reported again. So neocode never trusts a single row's report. It works out which rows are on screen from neighbouring rows that agree with each other, in the order Claude Code draws them.

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

1. **Distance from the bottom of the window.** Each row reports how tall it is and which of its lines are visible. neocode counts up from the lowest line on screen to give every line its distance above the bottom of the window. At the live bottom that lowest line is the newest output. That distance, against your **Reach** setting, sets how decayed the line is. The same rule applies at every scroll position, so a given line of the window decays the same way wherever you are.
2. **Decay, bite by bite.** In the transition band, a line's text is cut into short segments that each corrupt once the decay passes their own fixed threshold, so the corruption eats into the code instead of flickering at random. Near the top, whole lines are covered with rain.
3. **Animation without re-rendering.** A timer repaints the mounted grids with `$.ui.blit`, which only changes cells. The rain is computed from position and time alone, so there's no per-cell state to track.

### While Claude is still writing

While a reply streams, Claude Code draws it in a part of the screen that mods can't hook. The reply only becomes a transcript row, and neocode's to draw on, once it's complete. neocode still does what it can live:

- It reads the streamed lines from Claude Code's `MessageDisplay` event, without changing them, to know how tall the reply is so far. The rows *above* the reply decay as it pushes them up the screen.
- It hangs rain from the row just above the reply, which fills the gaps around the streamed lines: the spaces between words, and the empty columns to the right of each line. The streamed lines take rain sooner than finished rows at the same height, so the older half of a reply carries rain long before it fills the window. In tests with a 31-line window and `deep`, rain reached 13 of the reply's lines when the reply was half the window tall, and 19 when it was 85%. With `gentle`, the figures were 6 and 16.
- That row stops being drawn once the reply pushes it off the top. So over the last third of the window the rain thins out gradually, paced by how fast the reply is growing, and has gone by the time the reply reaches the window's height. A reply taller than that streams plain.
- When the reply completes, it becomes a row of its own. Its text then decays like any other row, and its rain ramps in over a moment.
- If the reply stops early (tested with Esc, Ctrl+C, a denied permission prompt and `/clear`), the stream state is dropped as the turn ends, and the rain goes back to how it looks for that content at the live bottom.

Why the streamed text itself can't take rain: it is drawn in front of anything a mod lays over it. The only way to change it is to rewrite each batch of streamed lines as it arrives, which is display-only (the stored conversation keeps the real text). Tests showed three problems:
- Swapping characters for glyphs puts the glyphs into anything you copy, which breaks the clipboard guarantee.
- A batch can't be changed once shown, so lines can't decay as they rise.
- Colour-only restyling breaks markdown tables and syntax highlighting, and stays on the reply by the prompt.

All the maths lives in [`hooks/matrix.ts`](hooks/matrix.ts), which has no I/O. The hooks are in [`hooks/register.tsx`](hooks/register.tsx).

## Display-only, and what the code touches

Mods run unsandboxed with your permissions, so here is everything neocode does:

- **Hooks:**
  - `ui.render` on transcript rows, to draw the overlay.
  - `command.run` for `/neocode`.
  - `session.start` and `session.end`, to set up the timer and command, and to reset after `/clear`.
  - Three events it only observes. Each is passed on, with the engine's answer, exactly as received (a test checks this):
    - `classic.MessageDisplay`: reads the streamed reply's lines, to know how tall the reply is so far.
    - `turn.complete`: reads only whether the turn belongs to a subagent, so that a turn that ends without its last streamed lines (an interrupt, an error) ends the stream state.
    - `prompt.edit`: notes that you typed in the prompt box, which clears a selection. It doesn't read what you typed.

  It hooks nothing that changes conversation data: no `session.append`, `tool.call` or `prompt.submit`.
- **What it reads.** All of it stays in memory. None of it is stored, logged or sent anywhere.
  - **The text of the rows it draws over**: replies, your prompts, tool input and output, command output. It uses it to estimate where each line's text sits, and keeps only those positions (numbers), not the text.
  - **The streamed reply's lines**, held until the reply's own row arrives or its turn ends.
  - **Your current mouse selection**, asked about every frame while the effect runs: its text, and the transcript row it lies in. neocode holds the text to compare what you selected over rain with what it reads once the rain has gone, so it can tell whether a copy caught glyphs. It drops it when Claude Code stops reporting that selection, or when the session ends.
  - **Your settings.** Claude Code's settings call hands over all of them; neocode looks only at `prefersReducedMotion`, and keeps nothing else.
  - **Whether the terminal is fullscreen, and its size.**
- **Never changes what the model sees, what the transcript stores, or what gets written to files.** It doesn't rewrite any props. It draws on top of the engine's own drawing.
- **Clipboard.** Claude Code copies its mouse selection from what's on screen, both when you release the mouse and when you copy again later (Ctrl+Shift+C, tested in tmux, including while a reply is still streaming). So neocode removes the rain while you select, and never puts it back over the row you selected in while that selection exists. If a selection is made faster than one animation frame (a double-click on a word, for example), the copy on release can catch glyphs. When that happens, neocode re-copies the same selection once the rain is gone, so the clipboard ends up holding the real text you selected. That is the only clipboard write it makes, and it only ever re-copies your own selection, as it really reads. It never copies anything else.
- **Storage:** two flags in its own plugin store: your `/neocode` choice, and whether the fullscreen hint has been shown. A test checks that nothing else is written.
- **Other calls:** toasts (the `/neocode` answer and the one-time fullscreen hint), registering the `/neocode` command, timers for the animation, and `$.ui.blit` on its own rain grids.
- **No** network access, processes, file reads or writes, dependencies, install scripts or build step. The source is the TypeScript you see here.

Run `claude plugin validate --strict .claude-plugin/plugin.json` in a clone to see the engine's own list of what the module hooks and calls.

## Known limitations

- **Fullscreen renderer only.** neocode needs `/tui fullscreen`. The default renderer prints finished rows into terminal scrollback, where they can't be redrawn.
- **The terminal's own scrollbar and search don't see the conversation.** Under the fullscreen renderer the conversation lives on the terminal's alternate screen. The terminal's scrollbar, Cmd+F and native scrollback don't reflect it, and dragging the native scrollbar can show blank space or lines from before Claude Code launched. This happens with or without neocode. Scroll with the mouse wheel, or use Ctrl+O for transcript mode.
- **Text positions are estimates.** A mod is told how tall each row is and which of its lines are on screen, but not where the text sits within a line. neocode estimates that from the row's content (markdown, tool input or output), so in the transition band a bite occasionally lands on whitespace. Higher up, everything is rain anyway.
- **A reply still streaming isn't fully reachable.** Claude Code paints streaming text over anything a mod lays on it, so the streamed text itself can't decay until the reply completes. Until then the rain shows only in the gaps around its lines. Claude Code also stops drawing the row the rain hangs from once that row scrolls off. So the rain fades out as the reply nears the window's height, and a reply taller than the window streams plain until it's done. There is little or no rain over the first quarter of a streaming reply's height. See [While Claude is still writing](#while-claude-is-still-writing).
- **A selection made while a reply streams may not last.** Claude Code drops it as the stream moves, with or without neocode. A copy made before that holds the real text. A later copy (Ctrl+Shift+C) may find nothing selected, and then copies nothing.
- **An error mid-stream is untested.** A reply stopped with Esc, Ctrl+C, a denied permission prompt or `/clear` was tested in tmux. A reply cut off by an API error wasn't, because one couldn't be triggered. neocode is meant to handle it the same way, through the turn's end event and a 10-second timeout on the streamed lines, but that hasn't been seen.
- **A selection keeps its row clean until you type, send a prompt or run a command,** because Claude Code tells mods nothing when a click clears it. A multi-row selection keeps all the rain paused that long, because no API says which rows it covers.
- **Native selection can copy rain.** If mouse capture is off (`CLAUDE_CODE_DISABLE_MOUSE=1`, or a terminal's key for bypassing mouse reporting), selection is the terminal's own. neocode can't see it, so text copied from the screen may contain rain glyphs. In tmux with mouse capture off, a copy made with tmux's own selection contained the glyphs, and after `/neocode off` the same copy was clean. Run `/neocode off` before copying that way. Native selection in iTerm2 and macOS Terminal hasn't been tested.
- **Scroll detection is inferred** from which rows are visible, so an unusual layout change can briefly pause the rain.
- **Rows the engine doesn't report**, such as the welcome banner, the live spinner and Claude Code's own notices, are left as they are. At the live bottom such rows below the newest output lift the point decay is measured from by their height.
- **Glyph width.** Half-width katakana are one cell wide in standard terminal fonts. A font that draws them wide will misalign the rain; use `letters`.
- **Light themes.** The palette is tuned for dark backgrounds.
- **Cost.** With rain on screen at 15 fps, expect about 10% of one CPU core. In tmux on one Mac, Claude Code's process used 7–13% of a core with rain on screen, against about 3% with neocode off. It drops to close to nothing while the effect is paused.

## Troubleshooting

- **Nothing happens.** Check that you're in the fullscreen renderer (`/tui fullscreen`; neocode says so once if you're not), that `/neocode status` says on, and that **Reduce motion** isn't turned on in `/config`. A short conversation stays readable on purpose: decay is measured against the window, and the rain starts once there's enough transcript to scroll.
- **The rain looks misaligned.** Your font draws half-width katakana wide. Set **Glyphs** to `letters` in `/config`.
- **Copied text contains rain.** That happens only when the terminal does the selecting, with mouse capture off. See [Native selection can copy rain](#known-limitations). Run `/neocode off` first, or select with Claude Code's own mouse selection.
- **It uses too much CPU.** Lower **Frames per second** in `/config`, or turn it off with `/neocode off`.
- **Anything else.** [Open an issue](https://github.com/darrenjforde/neocode/issues) with your Claude Code version, terminal, and whether `/neocode status` says on.

## Development

```sh
claude --plugin-dir . --settings '{"tui":"fullscreen"}'   # run it from a clone; edits hot-reload
claude plugin test .                                      # tests in tests/
claude plugin validate --strict .claude-plugin/plugin.json
```

Bump `version` in `.claude-plugin/plugin.json` for every release: `claude plugin update` only fetches a version it hasn't installed.

Claude Code writes its API declarations into `.claude-plugin/types/` the first time it loads the folder. After that, `npx -p typescript tsc -p .` type-checks the mod.

## Contributing

Contributions are welcome, especially fixes for the known limitations: live rain while a reply streams, a palette for light themes, other terminals and environments, and the Desktop app's Code tab. For bigger changes, please open an issue first.

```sh
claude --plugin-dir . --settings '{"tui":"fullscreen"}'   # run it from a clone; edits hot-reload
claude plugin test .                                      # tests in tests/
claude plugin validate --strict .claude-plugin/plugin.json
```

Add or update tests with any change in behaviour. Every change must keep these:
- **Display-only:** nothing changes what the model sees, what the transcript stores, or what gets written to files.
- **The clipboard guarantee:** selected text always copies as the real text, never rain glyphs.
- **No network access or install scripts.**
- **Readable, auditable code.**

## License

[MIT](LICENSE) © Darren Forde
