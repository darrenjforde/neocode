# Changelog

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
