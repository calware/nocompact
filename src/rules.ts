import type { CallAction } from './types.js';

/**
 * A per-tool rule from the `toolRules` option, written `Tool=action` or
 * `Tool(subject)=action`. `*` and `?` are wildcards; matching ignores case.
 * The subject is the call's main argument: a file path, a command, a URL, a
 * search pattern or query (see `callSubject`).
 */
export type ToolRule = {
  text: string;
  tool: RegExp;
  subject?: RegExp;
  action: CallAction;
};

export type ParsedRules = { rules: ToolRule[]; errors: string[] };

const ACTIONS: Record<string, CallAction> = {
  keep: 'keep',
  remove: 'remove',
  drop: 'remove',
  note: 'note',
  stub: 'note',
  head: 'head',
  truncate: 'head',
};

const RULE = /^([^=()]+?)\s*(?:\(([^)]*)\))?\s*=\s*([A-Za-z]+)$/;

export function globToRegExp(glob: string): RegExp {
  const body = glob
    .trim()
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'is');
}

/** Parses `Read=note, AskUserQuestion=keep; mcp__*mail*=head`; bad entries are reported, not fatal. */
export function parseRules(text: string | undefined): ParsedRules {
  const rules: ToolRule[] = [];
  const errors: string[] = [];
  for (const raw of (text ?? '').split(/[,;\n]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = RULE.exec(entry);
    const action = match ? ACTIONS[match[3]!.toLowerCase()] : undefined;
    if (!match || !action) {
      errors.push(`"${entry}" (expected Tool=keep|remove|note|head or Tool(subject)=action)`);
      continue;
    }
    const rule: ToolRule = { text: entry, tool: globToRegExp(match[1]!), action };
    if (match[2] !== undefined && match[2].trim() !== '') rule.subject = globToRegExp(match[2]);
    rules.push(rule);
  }
  return { rules, errors };
}

const SUBJECT_KEYS = [
  'file_path',
  'notebook_path',
  'command',
  'url',
  'pattern',
  'query',
  'path',
  'skill',
  'subagent_type',
  'description',
  'prompt',
] as const;

/** The argument that says what a call was about, or '' when it has none. */
export function callSubject(input: Record<string, unknown>): string {
  for (const key of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** The first rule that matches the call, if any. */
export function matchRule(
  rules: readonly ToolRule[],
  tool: string,
  input: Record<string, unknown>,
): ToolRule | undefined {
  let subject: string | undefined;
  for (const rule of rules) {
    if (!rule.tool.test(tool)) continue;
    if (rule.subject) {
      subject ??= callSubject(input);
      if (!rule.subject.test(subject)) continue;
    }
    return rule;
  }
  return undefined;
}
