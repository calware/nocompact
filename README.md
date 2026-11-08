# nocompact

Instant, model-free context compaction for [Claude Code](https://code.claude.com).

When your context fills up, Claude Code normally asks a model to summarize the
conversation. nocompact usually skips that step. It removes the old tool calls
and their output, and keeps every message you and Claude wrote word for word.
A compaction takes a few milliseconds, uses no API calls and costs nothing.
When pruning alone can't free enough space, or anything goes wrong, nocompact
hands off to Claude Code's normal compaction, so compacting never gets worse
than without the plugin.

```
nocompact: kept 412/2,118 messages, no summary (74% reduction; 803 calls removed, 3 pinned)
```

## Why

nocompact started as a replacement for
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), which
asked TypeSafe's Jev model, call by call, whether each old tool call and its
output were still needed. I logged a month of real Jev compactions (2,281
compactions and 230,870 decisions) and replayed every one of them through
nocompact's default profile:

| | Jev | nocompact (`jev` profile) |
|---|---|---|
| Same outcome (prune vs. fall back to the built-in summary) | | **2,281 / 2,281 (100%)** |
| Same per-call decision | | **99.49%** |
| Calls removed outright | 99.5% | 100% |
| Remaining size after compaction | | 3% smaller than Jev's |
| Time per compaction | ~0.45 s median (network) | ~5 ms |
| Cost | paid API credits | free |

Jev removed nearly everything. The remaining 0.5% were outputs it truncated
rather than removed, and in 230,870 decisions it kept a call whole only 8
times. A few lines of deterministic code make the same choices. Where Jev's
behavior had weak spots, nocompact also gives you settings to do better.

## Install

At the prompt of a Claude Code session:

```
/plugin install nocompact --marketplace calware/nocompact
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it apply
to every session). From a shell, the equivalent is:

```sh
claude plugin install nocompact --marketplace calware/nocompact
```

In the desktop app, where `/plugin` isn't available: click **+** next to the
prompt box, then **Plugins** → **Add marketplace** and enter
`calware/nocompact`, then **Add plugin**.

**From a local clone**, so edits apply as soon as you run `/reload-plugins`:

```sh
git clone https://github.com/calware/nocompact
claude plugin marketplace add ./nocompact
claude plugin install nocompact@nocompact
```

**Coming from fast-jev-compaction?** Disable it so only one plugin handles
compaction:

```sh
claude plugin disable fast-jev-compaction@fast-jev-compaction
```

### Updating

Claude Code doesn't refresh third-party marketplaces on its own unless you turn
that on. To get a new version now, from a shell:

```sh
claude plugin marketplace update nocompact
claude plugin update nocompact@nocompact
```

Then restart Claude Code, or run `/reload-plugins` in each open session. To
update automatically at startup instead, run `/plugin`, open the **nocompact**
marketplace and choose **Enable auto-update**.

A local clone updates with `git pull`, then `/reload-plugins`. See
[CHANGELOG.md](CHANGELOG.md) for what changed.

### Requirements

nocompact uses Claude Code's function-hook plugin API, which is in early
access; it was tested on Claude Code 2.1.318. If your build doesn't load
function hooks on its own, enable them in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

To check that it loaded, run `/nocompact` in a session.

## What it does by default

The default `jev` profile does exactly what fast-jev-compaction did:

1. **Pins** the first message and the newest 6 messages, and never touches them.
2. **Removes** every other tool call, together with its result. A call that
   hasn't returned yet is left alone.
3. **Keeps** every message's own text: your prompts and Claude's answers,
   word for word, along with Claude's thinking.
4. **Drops** messages that end up empty, such as a message that held only a
   tool call.
5. **Checks the savings.** If the result is at least 25% smaller (by
   characters), it replaces the conversation, with no summary. Otherwise it
   runs Claude Code's built-in summary instead.
6. **Falls back on errors.** If anything throws, the built-in summary runs.
7. **Compacts early.** After any turn that leaves the context window 60% full,
   it compacts on its own, so the slow built-in auto-compact rarely fires.

It handles `/compact`, auto-compact and subagent transcripts the same way.

**Background precompute.** With a compaction window of 200K tokens or more,
Claude Code prepares a compaction in the background shortly before the
threshold and installs nothing until the real compaction. Pruning takes
milliseconds, so nocompact declines these quietly and prunes at the real
compaction instead, and its notice only appears when a compaction actually
happens. When pruning would fall short, it lets Claude Code prepare its summary
in the background as usual. (fast-jev-compaction answered every precompute and
showed a notice for it, though nothing had been compacted yet.)

## Thinking and resumed sessions

Claude Code lets a compaction plugin hand a message back in one of two ways:

- **As Claude Code's own message.** It keeps everything, including Claude's
  thinking blocks. fast-jev-compaction did this. In Claude Code 2.1.318,
  though, a session compacted this way doesn't survive a resume: when the
  session is loaded again, the pruned history comes back and kept messages
  appear twice.
- **As a copy.** It keeps the text and the tool calls but not thinking blocks
  or images, and a resumed session stays exactly as compacted.

By default nocompact does what Jev did (`thinking: keep`): Claude keeps its
earlier reasoning across compactions. If you resume sessions often and want
them to stay compacted, set `thinking: drop`. Then Claude's messages and
tool results are handed back as copies, and a kept message that held only
thinking is removed. Your own prompts are always handed back as Claude
Code's own, because that is safe for them and keeps pasted images.

I tested both ways in real sessions on 2.1.318, with `claude -p --resume`:
compacting, resuming, compacting again and resuming again. Interactive
`claude --resume` and `/resume` load the same saved transcript. With `keep`,
the removed reads came back and kept answers appeared twice. With `drop`,
nothing came back and no message was repeated. Auto-compactions in the middle of a tool-using turn
work with `drop` too: the API accepts the conversation without the dropped
thinking.

## Making it better than Jev

Each setting below defaults to the Jev behavior. You can switch everything at
once with `profile: smart`, or override settings one at a time; any setting
you set wins over the profile.

### Things the Jev approach does poorly, and the setting for each

| Weak spot (measured on real logs) | Setting |
|---|---|
| The model re-reads files after compaction (about 5% of removed Reads came back, with no edit in between). It doesn't remember what it already looked at. | `droppedCalls: note` leaves a one-line note such as `[nocompact removed 3 earlier tool calls: Read src/a.ts · Bash npm test (error) · Grep TODO. Re-run any you need.]` |
| Output that can't be fetched again is lost: email bodies, web pages, answers to questions, approved plans. | `toolRules`, for example `AskUserQuestion=keep, mcp__*mail*=head, WebFetch=head` |
| Long, text-heavy sessions can't shrink below the 25% minimum and fall back to a full built-in summary. That was 81 compactions in my logs. | `lowReduction: hybrid` summarizes only the oldest part and keeps the newer part verbatim. Or `lowReduction: abridge` shortens long old answers first. |
| Very long old answers stay forever. | `oldText: abridge` keeps the start and end of old long answers. |
| The most recent tool output is removed as soon as it leaves the pinned window. | `keepRecentCalls: N` |

Replayed over the same 2,281 logged compactions, `profile: smart` needed a
full built-in summary only **2** times instead of 81; the other 105 low-yield
compactions went hybrid.

### All settings

Set them with `/plugin configure nocompact@nocompact`, or in
`~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "nocompact@nocompact": {
      "options": {
        "profile": "smart",
        "toolRules": "Read(*.md)=keep, Bash(git *)=note"
      }
    }
  }
}
```

| Setting | Values | `jev` (default) | `smart` | What it does |
|---|---|---|---|---|
| `profile` | `jev`, `smart` | `jev` | | Starting point for everything below. |
| `droppedCalls` | `remove`, `note`, `head` | `remove` | `note` | What happens to an old tool call that no rule keeps. `head` keeps the call and the first `headChars` characters of its output. |
| `toolRules` | rule list | none | `AskUserQuestion=keep, ExitPlanMode=keep, WebFetch=head, WebSearch=head, mcp__*=head` | Per-tool overrides; see [Tool rules](#tool-rules). Yours are checked before the profile's. |
| `keepRecentCalls` | number | `0` | `0` | Keep this many of the newest unpinned calls whole. |
| `headChars` | number | `300` | `500` | Output kept by `head`. |
| `oldText` | `keep`, `abridge`, `abridge-all` | `keep` | `keep` | On every compaction, shorten old texts longer than `abridgeAbove` to their start and end. `abridge` applies to Claude's answers; `abridge-all` applies to your messages too. |
| `abridgeAbove` | number | `2000` | `2000` | What counts as long, in characters. |
| `lowReduction` | `summary`, `abridge`, `hybrid` | `summary` | `hybrid` | What happens when pruning frees less than the minimum. See [Fallbacks](#fallbacks). |
| `hybridKeepPercent` | 5–95 | `40` | `40` | For `hybrid`: the largest share of the original size the verbatim part may take. |
| `minReductionPercent` | 0–100 | `25` | `25` | Pruning must free at least this much, or `lowReduction` applies. |
| `preserveRecentMessages` | number | `6` | `6` | Newest messages never touched. |
| `compactAtPercent` | 0–100 | `60` | `60` | Compact after a turn once the context is this full. `0` leaves the timing to Claude Code. |
| `thinking` | `keep`, `drop` | `keep` | `keep` | Whether kept messages keep their thinking blocks. `keep` is Jev's way; `drop` keeps resumed sessions compacted. See [above](#thinking-and-resumed-sessions). |
| `notify` | `toast`, `log`, `off` | `toast` | `toast` | How each compaction is reported. |

Picker settings also accept `profile`, which means "use the profile's value".
Leaving a number setting empty does the same.

### Tool rules

Rules are written `Tool=action` or `Tool(subject)=action` and separated by
commas, semicolons or new lines. The first matching rule wins.

- **Actions:** `keep`, `remove`, `note`, `head`. `drop`, `stub` and `truncate`
  also work as aliases.
- **Tool:** the tool's name as Claude Code reports it, such as `Read`, `Bash`
  or `mcp__server__tool`. `*` and `?` are wildcards, and matching ignores case.
- **Subject:** matched against the call's main argument: the file path,
  command, URL, search pattern or query.

```
AskUserQuestion=keep              answers you gave can't be re-asked
Read(*.md)=keep                   keep docs that were read
Read(*/node_modules/*)=remove     never keep vendored files
Bash(git *)=note                  just remember which git commands ran
mcp__*mail*=head                  keep the start of every email read
mcp__*=head                       keep the start of all MCP output
```

Rules never override pinned messages. Bad entries are ignored and listed by
`/nocompact`.

## Fallbacks

nocompact is built so a compaction never ends up worse than Claude Code's own:

- **On any error**, Claude Code's built-in compaction runs as if the plugin
  weren't installed. The hook also has a guard, so even an unexpected crash
  falls through to the built-in compaction.
- **When pruning frees too little** (under `minReductionPercent`), what
  happens depends on `lowReduction`:
  - `summary`: the built-in summary of the whole conversation (Jev's behavior).
  - `abridge`: shortens Claude's longest old answers, oldest first, until the
    minimum is met. If it still falls short, the built-in summary runs.
  - `hybrid`: Claude Code's summarizer condenses only the oldest part, and the
    newest part (up to `hybridKeepPercent` of the original size) follows the
    summary word for word.
- **How the hybrid split is chosen:** it always falls on a prompt you typed,
  never between a tool call and its result, and leaves at least two rounds to
  summarize. If no split qualifies, the built-in summary runs. If the
  summarizer fails, nocompact keeps the pruned conversation instead of not
  compacting at all.

## `/nocompact`

```
/nocompact           settings in force and the last five compactions
/nocompact preview   what compacting right now would do (changes nothing)
/nocompact help
```

## How it works

nocompact is a Claude Code function-hook plugin:

- **`session.compact`** receives the transcript and returns the pruned
  version. Kept messages are handed back as Claude Code's own, thinking
  included, or with `thinking: drop` as copies (see
  [Thinking and resumed sessions](#thinking-and-resumed-sessions)).
  When it calls `next(event)`, the built-in compaction runs.
- **`turn.complete`** checks the context usage and asks for a compaction at
  `compactAtPercent`.

It logs nothing to disk and makes no network requests.

The pruning library under `src/` has no dependency on Claude Code, so it can
be tested or replayed against saved transcripts on its own.

```
src/prune.ts        collect calls, decide, rewrite, abridge, hybrid split
src/rules.ts        tool-rule parser and matcher
src/config.ts       profiles and option parsing
hooks/nocompact.ts  the Claude Code hooks and /nocompact
```

## Development

```sh
npm install
npm run check      # type-check, tests, claude plugin validate
```

Type-checking the hook module needs Claude Code's API types. The engine writes
them to `.claude-plugin/types/` the first time it loads the plugin from this
folder.

## Known limitations

- Like any approach that prunes without summarizing, nocompact can't shrink a
  conversation that is mostly text. That is what the `lowReduction` fallbacks
  are for.
- After any compaction, Claude Code itself re-attaches recently read files.
  This is not specific to nocompact.
- With the default `thinking: keep`, as with fast-jev-compaction, resuming a
  compacted session in Claude Code 2.1.318 brings the pruned history back and
  repeats kept messages. The next compaction removes the returned tool output
  again, but the repeated messages stay. `thinking: drop` avoids this at the
  cost of Claude's earlier thinking, and of images in kept tool results.

## License

MIT. nocompact's default behavior reproduces
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT), which inspired it. The code is a separate implementation.
