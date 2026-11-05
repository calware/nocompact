import type { Config } from './config.js';
import { callSubject, matchRule } from './rules.js';
import type {
  CallAction,
  CallDecision,
  Message,
  PruneResult,
  ToolCall,
  ToolResult,
  ToolUse,
} from './types.js';

/** Characters of text, tool input and tool output a message holds (Jev's measure). */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function totalChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) total += messageChars(message);
  return total;
}

export function reductionRatio(stats: { charsBefore: number; charsAfter: number }): number {
  return stats.charsBefore === 0 ? 0 : (stats.charsBefore - stats.charsAfter) / stats.charsBefore;
}

/** The first message and the newest `preserveRecentMessages` are never touched. */
export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result. A call without a result (still
 * running, or interrupted) is not a candidate and is left alone; so is a call
 * whose use or result sits in a pinned message.
 */
export function collectCalls(messages: readonly Message[], preserveRecentMessages: number): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, { index, result });
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

/** Decides every call: pinned stays, then the first matching rule, then recency, then `droppedCalls`. */
export function decideCalls(calls: readonly ToolCall[], config: Config): CallDecision[] {
  const candidates = calls.filter((call) => !call.pinned);
  const recent = new Set(
    config.keepRecentCalls > 0 ? candidates.slice(-config.keepRecentCalls).map((call) => call.tool_use_id) : [],
  );
  return calls.map((call) => {
    const base = { tool_use_id: call.tool_use_id, tool: call.tool };
    if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
    const rule = matchRule(config.rules, call.tool, call.input);
    if (rule) return { ...base, action: rule.action, reason: `rule:${rule.text}` };
    if (recent.has(call.tool_use_id)) return { ...base, action: 'keep', reason: 'recent' };
    return { ...base, action: config.droppedCalls, reason: 'default' };
  });
}

/** Jev's `drop_result` cut: a bounded head and a note, short outputs left alone. */
export function headText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[nocompact truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

export function abridgeText(text: string, above: number): string {
  if (text.length <= above) return text;
  const head = Math.floor(above * 0.6);
  const tail = Math.floor(above * 0.25);
  return `${text.slice(0, head)}\n[… nocompact abridged ${text.length - head - tail} chars of this old message …]\n${text.slice(-tail)}`;
}

const NOTE_LISTED = 12;
const SUBJECT_CHARS = 70;

export function describeCall(call: Pick<ToolCall, 'tool' | 'input' | 'isError'>): string {
  const subject = callSubject(call.input).replace(/\s+/g, ' ').trim();
  const short = subject.length > SUBJECT_CHARS ? `${subject.slice(0, SUBJECT_CHARS - 1)}…` : subject;
  return `${call.tool}${short ? ` ${short}` : ''}${call.isError ? ' (error)' : ''}`;
}

export function noteText(entries: readonly string[]): string {
  const listed = entries.slice(0, NOTE_LISTED).join(' · ');
  const more = entries.length > NOTE_LISTED ? ` · and ${entries.length - NOTE_LISTED} more` : '';
  const s = entries.length === 1 ? '' : 's';
  return `[nocompact removed ${entries.length} earlier tool call${s} to save context: ${listed}${more}. Re-run any you need.]`;
}

type Rewrite = {
  /** tool_use_id → action, for calls that are not kept. */
  actions: ReadonlyMap<string, CallAction>;
  calls: ReadonlyMap<string, ToolCall>;
  /** Message index → replacement text. */
  texts: ReadonlyMap<number, string>;
  headChars: number;
};

/**
 * Rebuilds the conversation. A message nothing happened to is returned as the
 * same object (so the engine keeps its own copy, thinking blocks included); a
 * message left with no text, tool use or result disappears; notes of removed
 * calls in a row are gathered into one short assistant message.
 */
export function rewrite(messages: readonly Message[], plan: Rewrite): { messages: Message[]; origins: number[] } {
  const out: Message[] = [];
  const origins: number[] = [];
  let openNote: { message: Message; entries: string[] } | undefined;
  const flush = () => {
    if (openNote) (openNote.message as { text: string }).text = noteText(openNote.entries);
    openNote = undefined;
  };

  messages.forEach((message, index) => {
    const results = message.toolResults ?? [];
    const touched =
      plan.texts.has(index) ||
      message.toolUses.some((tool) => plan.actions.has(tool.tool_use_id)) ||
      results.some((result) => plan.actions.has(result.tool_use_id));
    if (!touched) {
      flush();
      out.push(message);
      origins.push(index);
      return;
    }

    let changed = plan.texts.has(index);
    const notes: string[] = [];
    const toolUses: ToolUse[] = [];
    for (const tool of message.toolUses) {
      const action = plan.actions.get(tool.tool_use_id);
      if (action === 'remove' || action === 'note') {
        changed = true;
        if (action === 'note') {
          const call = plan.calls.get(tool.tool_use_id);
          notes.push(describeCall(call ?? { tool: tool.tool, input: tool.input, isError: tool.isError ?? false }));
        }
        continue;
      }
      if (action === 'head' && tool.text !== undefined) {
        const text = headText(tool.text, tool.isError ?? false, plan.headChars);
        if (text !== tool.text) {
          changed = true;
          const copy: ToolUse = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input, text };
          if (tool.isError) copy.isError = true;
          toolUses.push(copy);
          continue;
        }
      }
      toolUses.push(tool);
    }
    const toolResults: ToolResult[] = [];
    for (const result of results) {
      const action = plan.actions.get(result.tool_use_id);
      if (action === 'remove' || action === 'note') {
        changed = true;
        continue;
      }
      if (action === 'head') {
        const text = headText(result.text, result.isError ?? false, plan.headChars);
        if (text !== result.text) {
          changed = true;
          toolResults.push({ tool_use_id: result.tool_use_id, text, isError: result.isError ?? false });
          continue;
        }
      }
      toolResults.push(result);
    }

    if (!changed) {
      flush();
      out.push(message);
      origins.push(index);
      return;
    }

    const text = plan.texts.get(index) ?? message.text;
    const empty = text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0;
    if (empty) {
      if (notes.length === 0) return;
      if (openNote && out[out.length - 1] === openNote.message) {
        openNote.entries.push(...notes);
      } else {
        flush();
        openNote = { message: { role: 'assistant', text: '', toolUses: [] }, entries: [...notes] };
        out.push(openNote.message);
        origins.push(index);
      }
      return;
    }

    flush();
    const rebuilt: Message = {
      role: message.role,
      text: notes.length > 0 ? `${text}${text.trim() ? '\n\n' : ''}${noteText(notes)}` : text,
      toolUses,
    };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    out.push(rebuilt);
    origins.push(index);
  });
  flush();
  return { messages: out, origins };
}

/** Which old messages may be abridged: outside the pinned ones, long, of the chosen roles. */
function abridgeCandidates(messages: readonly Message[], config: Config, roles: 'assistant' | 'all'): number[] {
  const indices: number[] = [];
  messages.forEach((message, index) => {
    if (isPinned(index, messages.length, config.preserveRecentMessages)) return;
    if (roles === 'assistant' && message.role !== 'assistant') return;
    if (message.text.length > config.abridgeAbove) indices.push(index);
  });
  return indices;
}

export type PruneOptions = {
  /**
   * Abridge old assistant texts, oldest first, until this share of the
   * characters is gone (`lowReduction: abridge`). Applies after tool pruning.
   */
  abridgeUntil?: number;
};

/**
 * Compacts a transcript without a model: decides every tool call by the
 * config, optionally abridges old texts, and reports what changed.
 */
export function prune(messages: readonly Message[], config: Config, options: PruneOptions = {}): PruneResult {
  const calls = collectCalls(messages, config.preserveRecentMessages);
  const decisions = decideCalls(calls, config);
  const actions = new Map<string, CallAction>();
  for (const decision of decisions) if (decision.action !== 'keep') actions.set(decision.tool_use_id, decision.action);
  const byId = new Map(calls.map((call) => [call.tool_use_id, call]));
  const charsBefore = totalChars(messages);

  const texts = new Map<number, string>();
  if (config.oldText !== 'keep') {
    const roles = config.oldText === 'abridge-all' ? 'all' : 'assistant';
    for (const index of abridgeCandidates(messages, config, roles)) {
      texts.set(index, abridgeText(messages[index]!.text, config.abridgeAbove));
    }
  }

  const plan = { actions, calls: byId, texts, headChars: config.headChars };
  let rebuilt = rewrite(messages, plan);
  let charsAfter = totalChars(rebuilt.messages);

  if (options.abridgeUntil !== undefined && reductionRatio({ charsBefore, charsAfter }) < options.abridgeUntil) {
    const wanted = charsBefore * (1 - options.abridgeUntil);
    let estimate = charsAfter;
    for (const index of abridgeCandidates(messages, config, 'assistant')) {
      if (estimate <= wanted) break;
      if (texts.has(index)) continue;
      const short = abridgeText(messages[index]!.text, config.abridgeAbove);
      estimate -= messages[index]!.text.length - short.length;
      texts.set(index, short);
    }
    rebuilt = rewrite(messages, plan);
    charsAfter = totalChars(rebuilt.messages);
  }

  const count = (action: CallAction) =>
    decisions.filter((decision) => decision.reason !== 'pinned' && decision.action === action).length;
  return {
    messages: rebuilt.messages,
    origins: rebuilt.origins,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: rebuilt.messages.length,
      charsBefore,
      charsAfter,
      calls: calls.length,
      pinned: decisions.filter((decision) => decision.reason === 'pinned').length,
      kept: count('keep'),
      removed: count('remove'),
      noted: count('note'),
      headed: count('head'),
      abridged: texts.size,
    },
  };
}

/**
 * A message a person typed: where a round of the conversation begins. Text
 * Claude Code adds on its own (`<system-reminder>`, command echoes) starts
 * with a tag and does not count.
 */
export function isPrompt(message: Message): boolean {
  if (message.role !== 'user' || message.toolResults?.length) return false;
  const text = message.text.trim();
  return text.length > 0 && !text.startsWith('<');
}

/** Fewest rounds the summarized part must hold; Claude Code refuses to summarize fewer. */
export const HYBRID_MIN_ROUNDS = 2;

/**
 * For `lowReduction: hybrid`: the index where the conversation splits into an
 * old part for the built-in summarizer and a recent part kept (pruned) as it
 * is. The split falls on a prompt the person typed, after at least
 * `HYBRID_MIN_ROUNDS` prompts and answers, never inside a tool call; the
 * recent part is the largest that fits `hybridKeepPercent` of the original
 * characters. Undefined when no split qualifies.
 */
export function hybridSplit(messages: readonly Message[], pruned: PruneResult, config: Config): number | undefined {
  const n = messages.length;
  const budget = (pruned.stats.charsBefore * config.hybridKeepPercent) / 100;

  // A call from message c answered in message r forbids splits at c+1..r.
  const straddle = new Array<number>(n + 2).fill(0);
  for (const call of collectCalls(messages, 0)) {
    if (call.resultIndex > call.callIndex) {
      straddle[call.callIndex + 1]! += 1;
      straddle[call.resultIndex + 1]! -= 1;
    }
  }
  // Characters of the pruned output that come from message i onward.
  const tail = new Array<number>(n + 1).fill(0);
  pruned.messages.forEach((message, k) => {
    tail[pruned.origins[k]!]! += messageChars(message);
  });
  for (let i = n - 1; i >= 0; i -= 1) tail[i]! += tail[i + 1]!;

  const last = Math.min(n - config.preserveRecentMessages, n - 1);
  let open = 0;
  let prompts = 0;
  let answers = 0;
  for (let i = 0; i <= last; i += 1) {
    open += straddle[i]!;
    const message = messages[i]!;
    if (
      i > 0 &&
      open === 0 &&
      isPrompt(message) &&
      prompts >= HYBRID_MIN_ROUNDS &&
      answers >= HYBRID_MIN_ROUNDS &&
      tail[i]! <= budget
    ) {
      return i;
    }
    if (isPrompt(message)) prompts += 1;
    else if (message.role === 'assistant') answers += 1;
  }
  return undefined;
}
