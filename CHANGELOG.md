# Changelog

## 1.0.0

- Model-free compaction for Claude Code: removes old tool calls and their output, keeps all text verbatim.
- `jev` profile (default) reproduces fast-jev-compaction: same outcome on 2,281 of 2,281 replayed real compactions.
- `smart` profile and per-setting overrides: notes for removed calls, per-tool rules, recent-call retention, text abridging.
- Fallbacks: the built-in summary on errors and low reduction; optional `abridge` and `hybrid` (summarize only the oldest part).
- `/nocompact` shows settings, recent compactions, and a dry-run preview.
