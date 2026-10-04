# neocode privacy policy

Last updated: 4 October 2026 (version 0.3.5)

**neocode sends nothing anywhere and collects nothing.** It runs entirely inside your Claude Code session, on your machine.

## What it reads

To draw the rain, neocode looks at these things while Claude Code is running. It uses them in memory only and doesn't store, log or send any of them:

- **The text on screen:** the rows it draws over (replies, your prompts, tool input and output). It uses them to work out where each line of text sits.
- **A reply as it streams in**, to work out how tall it is so far.
- **Your mouse selection:** its text and which row it is in. neocode compares what you selected with what's on screen once the rain has cleared, so it can tell whether a copy caught decorative characters.
- **One setting,** whether you've asked Claude Code to reduce motion. Claude Code's settings call returns all of your settings; neocode looks only at that one.
- **When a turn ends, whether it was a subagent's.** It reads no conversation text from that event.
- **Whether the terminal is in fullscreen mode, and its size.**

## What it keeps

Two on/off flags in the plugin's own storage: whether you turned the rain on or off with `/neocode`, and whether it has shown its one-time hint about the fullscreen renderer. Nothing else is kept.

## What it writes

The only thing it ever writes to your clipboard is your own selection, when a very quick selection (a double-click, say) caught decorative characters. It copies the same text again as it really reads, so your clipboard holds the real code. That clipboard is your machine's own: nothing leaves your computer.

## What it never does

- It never uses the network.
- It never reads or writes files.
- It never runs other programs.
- It never calls the model.
- It never changes your transcript, your prompts, or what Claude sees.

You can check all of this. The source is in this repository, and the README's [section on what the code touches](README.md#display-only-and-what-the-code-touches) lists every hook and call.

## Questions

Open an issue at <https://github.com/darrenjforde/neocode/issues>.
