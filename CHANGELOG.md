# Changelog

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
