# Changelog

## 1.0.1

- Background precomputes are declined quietly when pruning will do the job, so a notice only appears when a compaction actually happens. One that would fall back still lets Claude Code prepare its summary in the background.
- Notices no longer repeat the plugin name (Claude Code already shows it).
- Reductions round down, so a result just under the minimum no longer reads as the minimum.

## 1.0.0

- Model-free compaction for Claude Code: removes old tool calls and their output, keeps all text verbatim.
- `jev` profile (default) reproduces fast-jev-compaction: same outcome on 2,281 of 2,281 replayed real compactions.
- `smart` profile and per-setting overrides: notes for removed calls, per-tool rules, recent-call retention, text abridging.
- Fallbacks: the built-in summary on errors and low reduction; optional `abridge` and `hybrid` (summarize only the oldest part).
- `thinking` setting. The default `keep` hands kept messages back whole, thinking included, as fast-jev-compaction did; on Claude Code 2.1.318 a resumed session then brings pruned history back and repeats kept messages. `drop` hands back copies, which resume cleanly but lose thinking blocks.
- `/nocompact` shows settings, recent compactions, and a dry-run preview.
