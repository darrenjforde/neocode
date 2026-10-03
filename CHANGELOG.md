# Changelog

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
