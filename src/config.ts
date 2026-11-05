import { parseRules, type ToolRule } from './rules.js';
import type { DropStyle, LowReduction, OldText } from './types.js';

export type Profile = 'jev' | 'smart';
export type Notify = 'toast' | 'log' | 'off';
/** What kept messages carry back; see `forEngine` in hooks/nocompact.ts. */
export type Thinking = 'drop' | 'keep';

/** Everything that shapes a compaction, after profile and options are merged. */
export type Config = {
  profile: Profile;
  /** What happens to a tool call no rule keeps: `remove` is Jev's behavior. */
  droppedCalls: DropStyle;
  /** Per-tool rules, the person's first, then the profile's; first match wins. */
  rules: ToolRule[];
  /** The rule text in force, for display. */
  rulesText: string;
  /** Bad `toolRules` entries, ignored. */
  ruleErrors: string[];
  /** Newest unpinned tool calls kept whole regardless of `droppedCalls`. */
  keepRecentCalls: number;
  /** Characters of output a `head` call keeps. */
  headChars: number;
  /** Abridge long old texts on every compaction. */
  oldText: OldText;
  /** Texts longer than this many characters are abridged when abridging. */
  abridgeAbove: number;
  /** What to do when pruning frees less than `minReductionRatio`. */
  lowReduction: LowReduction;
  /** For `hybrid`: the share of the original size the verbatim recent part may take. */
  hybridKeepPercent: number;
  /** Below this share of characters removed, the plan B in `lowReduction` runs. */
  minReductionRatio: number;
  /** Newest messages never touched (the first message never is either). */
  preserveRecentMessages: number;
  /** Context percentage at which a finished turn asks for compaction; 0 never. */
  compactAtPercent: number;
  /**
   * `drop`: kept assistant messages and tool results go back as copies, which
   * survive a resume but lose their thinking blocks. `keep`: they go back as
   * Claude Code's own (Jev's way), thinking included, but resuming the session
   * brings pruned history back and duplicates kept messages (Claude Code
   * 2.1.318).
   */
  thinking: Thinking;
  notify: Notify;
};

type ProfileValues = Omit<Config, 'profile' | 'rules' | 'ruleErrors'>;

/**
 * `jev` reproduces fast-jev-compaction with Jev's answers as measured over
 * ~230,000 of its decisions: every unpinned tool call goes, text stays, and
 * a compaction that frees under 25% falls back to the built-in summary. One
 * deliberate difference: `thinking` is `drop`, so a resumed session stays
 * compacted; `keep` is Jev's exact way.
 */
export const PROFILES: Record<Profile, ProfileValues> = {
  jev: {
    droppedCalls: 'remove',
    rulesText: '',
    keepRecentCalls: 0,
    headChars: 300,
    oldText: 'keep',
    abridgeAbove: 2000,
    lowReduction: 'summary',
    hybridKeepPercent: 40,
    minReductionRatio: 0.25,
    preserveRecentMessages: 6,
    compactAtPercent: 60,
    thinking: 'drop',
    notify: 'toast',
  },
  smart: {
    droppedCalls: 'note',
    rulesText: 'AskUserQuestion=keep, ExitPlanMode=keep, WebFetch=head, WebSearch=head, mcp__*=head',
    keepRecentCalls: 0,
    headChars: 500,
    oldText: 'keep',
    abridgeAbove: 2000,
    lowReduction: 'hybrid',
    hybridKeepPercent: 40,
    minReductionRatio: 0.25,
    preserveRecentMessages: 6,
    compactAtPercent: 60,
    thinking: 'drop',
    notify: 'toast',
  },
};

/** The picker value that means "whatever the profile says". */
export const FROM_PROFILE = 'profile';

type Options = Readonly<Record<string, unknown>>;

function pick<T extends string>(options: Options, key: string, allowed: readonly T[]): T | undefined {
  const value = options[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function num(options: Options, key: string, min: number, max: number): number | undefined {
  const raw = options[key];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

/**
 * Merges the plugin's `userConfig` values over the chosen profile. An unset
 * option, or a picker left on `profile`, takes the profile's value; anything
 * malformed is ignored the same way.
 */
export function resolveConfig(options: Options = {}): Config {
  const profile = pick(options, 'profile', ['jev', 'smart'] as const) ?? 'jev';
  const base = PROFILES[profile];
  const own = typeof options['toolRules'] === 'string' ? options['toolRules'].trim() : '';
  const rulesText = [own, base.rulesText].filter(Boolean).join(', ');
  const { rules, errors } = parseRules(rulesText);
  const ratio = num(options, 'minReductionPercent', 0, 100);
  return {
    profile,
    droppedCalls: pick(options, 'droppedCalls', ['remove', 'note', 'head'] as const) ?? base.droppedCalls,
    rules,
    rulesText,
    ruleErrors: errors,
    keepRecentCalls: Math.floor(num(options, 'keepRecentCalls', 0, 10_000) ?? base.keepRecentCalls),
    headChars: Math.floor(num(options, 'headChars', 0, 100_000) ?? base.headChars),
    oldText: pick(options, 'oldText', ['keep', 'abridge', 'abridge-all'] as const) ?? base.oldText,
    abridgeAbove: Math.floor(num(options, 'abridgeAbove', 200, 1_000_000) ?? base.abridgeAbove),
    lowReduction: pick(options, 'lowReduction', ['summary', 'abridge', 'hybrid'] as const) ?? base.lowReduction,
    hybridKeepPercent: num(options, 'hybridKeepPercent', 5, 95) ?? base.hybridKeepPercent,
    minReductionRatio: ratio === undefined ? base.minReductionRatio : ratio / 100,
    preserveRecentMessages: Math.floor(num(options, 'preserveRecentMessages', 0, 1000) ?? base.preserveRecentMessages),
    compactAtPercent: num(options, 'compactAtPercent', 0, 100) ?? base.compactAtPercent,
    thinking: pick(options, 'thinking', ['drop', 'keep'] as const) ?? base.thinking,
    notify: pick(options, 'notify', ['toast', 'log', 'off'] as const) ?? base.notify,
  };
}

/** The settings as `/nocompact` shows them. */
export function describeConfig(config: Config): string[] {
  const lines = [
    `profile            ${config.profile}`,
    `droppedCalls       ${config.droppedCalls}`,
    `toolRules          ${config.rulesText || '(none)'}`,
    `keepRecentCalls    ${config.keepRecentCalls}`,
    `headChars          ${config.headChars}`,
    `oldText            ${config.oldText} (above ${config.abridgeAbove} chars)`,
    `lowReduction       ${config.lowReduction}${config.lowReduction === 'hybrid' ? ` (recent part up to ${config.hybridKeepPercent}%)` : ''}`,
    `minReduction       ${Math.round(config.minReductionRatio * 100)}%`,
    `preserveRecent     ${config.preserveRecentMessages} messages`,
    `compactAtPercent   ${config.compactAtPercent === 0 ? 'off' : `${config.compactAtPercent}%`}`,
    `thinking           ${config.thinking === 'keep' ? 'keep (a resumed session undoes compactions)' : 'drop (resume-safe)'}`,
    `notify             ${config.notify}`,
  ];
  for (const error of config.ruleErrors) lines.push(`ignored rule       ${error}`);
  return lines;
}
