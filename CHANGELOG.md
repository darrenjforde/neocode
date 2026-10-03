# Changelog

## 0.1.0 (2026-10-03)

First release.

- Transcript rows decay into Matrix rain by their distance above the prompt: readable by the prompt, scrambling letters further up, then green half-width katakana, then full upward-streaming rain at the top of the screen.
- Upward ripple, bright trail heads and per-cell flicker, animated with `$.ui.blit` (no re-renders).
- `/neocode [on|off|status]` toggle, remembered across sessions.
- Pauses automatically while the transcript is scrolled away from the live bottom, and while text is selected, so reading and copying always see the real text.
- Options: start on/off, reach, glyph set (katakana or ASCII), frame rate.
