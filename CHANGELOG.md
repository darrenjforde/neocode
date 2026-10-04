# Changelog

## 0.3.4 (2026-10-04)

No change in behaviour. Directory listing metadata, a privacy policy and a fixed donation link.

- **Listing fields** in `plugin.json`: `icon` (`assets/neocode_icon_1024.png`, a 1024 px PNG), `documentationUrl`, `supportUrl` and `privacyPolicyUrl`.
- **`PRIVACY.md`:** a one-page privacy policy, linked from the README. neocode sends nothing anywhere and collects nothing.
- **Fixed: the Buy Me a Coffee button.** The embed script was committed to the README, and GitHub doesn't run scripts, so it showed nothing. It is replaced by a Markdown link with a badge, placed under the screenshots, and there's a `.github/FUNDING.yml` for GitHub's Sponsor button. The plugin's code, toasts and manifest description say nothing about donations.
- `.gitignore` now excludes `assets/*.psd`, the icon's Photoshop source (6.8 MB, and not a file type the directory accepts).

## 0.3.3 (2026-10-04)

No change in behaviour. Preparation for submitting to the Claude plugin directory: what the code touches, and what the docs say about it, now agree.

- **Disclosure.** The header comment in `hooks/register.tsx`, the README and the plugin description now list everything the code reads and writes, which they had left incomplete:
  - the `turn.complete` hook (it reads only whether the turn belongs to a subagent, and passes the event on untouched);
  - that it reads your current mouse selection, holds its text in memory only to tell whether a copy caught rain glyphs, and that its one clipboard write is re-copying your own selection as it really reads;
  - that it reads the text of the rows it draws over (keeping only line positions) and the streamed reply's lines, in memory only;
  - that the settings call returns every setting, of which it looks only at `prefersReducedMotion`;
  - the toasts, the `/neocode` command registration and the timers.
- **Tests.** The `MessageDisplay`, `turn.complete` and `prompt.edit` hooks are checked to pass their events and the engine's answers on unchanged. A full session using every feature is checked to write only the two documented store flags, and to copy only your own selection.
- **README:** a "Try it" section with three worked examples and a "Troubleshooting" section, as the directory policy asks for documentation of how to use and troubleshoot a plugin.
- **README limitations** now match 0.3.2: little or no rain over the first quarter of a streaming reply; a selection made while a reply streams may not last; an error mid-stream is untested; CPU use measured at 7–13% of a core; and the "text positions" entry no longer says the code never sees a row's content.

## 0.3.2 (2026-10-04)

- **More rain over a streaming reply, sooner.** In 0.3.1 streamed lines took rain on the finished-row curve at their true height. A reply's lines sit low on the screen, below where your Reach starts decaying, so they had almost no rain until the reply was tall. By then the fade-out, which began at 70% of the window's height, was already thinning it. With `gentle` there was none at all. Streamed lines now decay as if twice as far up. The fade-out now covers only the last third of the window, measured from the space actually left above the reply rather than an estimate of its height. It's also projected each frame from how fast the reply is growing, instead of jumping at each redraw. In tests with a 31-line window, a reply half the window tall had rain on 6, 10 and 13 lines (gentle, balanced, deep), up from 0, 0 and 0.
- **Fixed: rain filling the whole window after a stopped reply.** When a reply was stopped mid-stream, neocode kept counting its streamed lines as if they were still below the newest row, so every row decayed fully. Two causes:
  - A stopped reply sends no final streaming update.
  - Esc while Claude was thinking takes the prompt row back. That row never draws again but stayed "newest", so the reply that followed didn't end the stream either.

  The stream state is now cleared by its reply's row arriving, a newer prompt row, a `turn.complete` event (any reason), `/clear`, and as a backstop 10 s without a streaming update. Rows that stop being drawn no longer count as the newest. Tested in tmux with Esc while thinking, Esc and Ctrl+C mid-stream, a denied permission prompt after text, and `/clear` mid-stream. New tests check that after an interrupted stream the rain profile matches the live-bottom profile for each Reach; they fail against 0.3.1.

## 0.3.1 (2026-10-04)

- **Fixed: weaker rain after a scroll.** Once the rain returned after a scroll, it used a separate, gentler curve and measured distance differently, so it covered less than at the live bottom with the same content. Three things differed:
  - A `scrolled` curve replaced your Reach until your next prompt.
  - At the live bottom, distance was counted down from the window's top using an estimated height, while scrolled back it was counted up from the bottom edge.
  - The window height was only measured after certain scrolls, which also changed how far the ripple travels.

  All three are gone. Distance is now always measured up from the lowest line on screen against your Reach, so the rain looks the same wherever you've scrolled to. A new parity test compares the rain per window line, in coverage and colour, at the live bottom and after scrolling to the top, middle and bottom, for every Reach.
- README: a "Where it works" section, clipboard wording limited to what's been tested, a note on native selection with mouse capture off, and a Contributing section.

## 0.3.0 (2026-10-04)

- **Graceful exit while a reply streams.** The rain around a streaming reply used to vanish in one frame when the reply grew to about the window's height, because the row it hangs from scrolls off and stops being drawn. It now thins out over the last stretch before that.
- **Smooth arrival when a reply completes.** The finished reply's rain ramps in over 0.8 s instead of appearing in a single frame.
- **Fixed: the rain pausing after you send a long prompt.** When a prompt that wrapped onto several lines left the prompt box, the transcript moved down and neocode took that for a scroll (since 0.2.1). Moves caused by the prompt box changing height no longer count as scrolls.
- Investigated keeping the rain live over replies taller than the window. Every site a mod can draw in either scrolls off with the conversation or clips what it draws. The only way to change the streamed text is the `MessageDisplay` event's `displayContent`. Tests showed swapping in glyphs leaks into copies, that lines can't be changed once shown, and that colour-only restyling breaks tables and highlighting. So the streamed text itself still decays only once the reply completes.

## 0.2.1 (2026-10-04)

- **Fixed: rain returning inconsistently after scrolling.** It could return over the upper half of the window, over a thin strip, or not at all, depending on where you'd scrolled. Two causes:
  - A row that left the screen in one jump (Ctrl+Home, Ctrl+End, PgUp, a fast wheel) kept its last report, and neocode measured from it.
  - Rows first seen while scrolling, as in a resumed conversation or after a reload, were treated as the newest.

  neocode now learns the transcript's order from Claude Code's top-to-bottom drawing passes. It works out what's on screen only from neighbouring rows that agree, and measures from whichever edge of the window is exact. After any scroll, the upper half of the window turns to rain and the lower half stays readable, wherever you are.
- **Fixed: jumps not counted as scrolls.** Ctrl+End and similar jumps that cut no row off at the bottom now clear the rain too.
- **Fixed: a selection holding the rain off indefinitely.** Typing in the prompt box clears a selection's highlight, so the rain now returns over the selected row as soon as you type. The fixes above also stop stale positions keeping the rain off the rest of the screen. Claude Code still gives mods no signal when a click clears a selection.
- README: the fullscreen requirement is spelled out, with a note on the terminal's own scrollbar under fullscreen rendering.

## 0.2.0 (2026-10-03)

- **Comes back by itself.** Scrolling or selecting text still clears the rain at once, but it now returns after a quiet spell instead of waiting for you to return to the bottom or send a prompt. The delay is the new **Resume after (seconds)** option, 5 seconds by default.
- **Rain while scrolled back.** When the rain returns while you're reading back through the conversation, the lower half of the window stays fully readable and only the upper half turns to rain.
- **Copies stay clean after the rain returns.** The row you selected in stays clear for as long as the selection exists, so a later Ctrl+C, Ctrl+Shift+C or Cmd+C copies real text. Selections spanning several rows keep the rain paused until your next prompt or command.
- **Live while Claude writes.** Rows above a streaming reply now decay as it pushes them up, and rain fills the space around the streamed lines. Previously the effect switched itself off for the whole stream, because the stream pushing your prompt off screen looked like a scroll. The streamed text itself still decays only once the reply completes; see the README.
- Scrolling is now detected from rows cut off at the bottom of the window, so new output, dialogs and the spinner no longer look like scrolls.

## 0.1.0 (2026-10-03)

First release.

- Transcript rows decay into Matrix rain by their distance above the prompt: readable by the prompt, scrambling letters further up, then green half-width katakana, then full upward-streaming rain at the top of the screen.
- Upward ripple, bright trail heads and per-cell flicker, animated with `$.ui.blit` (no re-renders).
- `/neocode [on|off|status]` toggle, remembered across sessions.
- Pauses automatically while the transcript is scrolled away from the live bottom, and while text is selected, so reading and copying always see the real text.
- Options: start on/off, reach, glyph set (katakana or ASCII), frame rate.
