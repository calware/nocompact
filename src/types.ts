/**
 * The transcript shapes nocompact works on. They are the subset of Claude
 * Code's `SessionMessage` the pruner reads, so the library runs without the
 * engine (tests, replays) and an engine message is accepted as it is.
 */

export type ToolUse = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** The result as the model read it, mirrored on the call by the engine. */
  text?: string;
  isError?: true;
};

export type ToolResult = {
  tool_use_id: string;
  text: string;
  isError?: boolean;
};

export type Message = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly ToolUse[];
  toolResults?: readonly ToolResult[];
};

/** What happens to one tool call. */
export type CallAction =
  /** Left exactly as it is. */
  | 'keep'
  /** The call and its result disappear (what Jev did with almost every call). */
  | 'remove'
  /** Removed, with a one-line note naming it left in the conversation. */
  | 'note'
  /** The call stays; its output is cut to the first `headChars` characters. */
  | 'head';

export type DropStyle = Exclude<CallAction, 'keep'>;

/** What to do when pruning tool calls frees too little. */
export type LowReduction =
  /** Hand the whole conversation to Claude Code's built-in summary (Jev's behavior). */
  | 'summary'
  /** Abridge long old assistant texts, oldest first; still too little, the built-in summary. */
  | 'abridge'
  /** Summarize only the oldest part with the built-in summarizer; keep the rest verbatim. */
  | 'hybrid';

export type OldText = 'keep' | 'abridge' | 'abridge-all';

/** One paired tool call of the transcript. */
export type ToolCall = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use. */
  callIndex: number;
  /** Index of the message holding the tool_result. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first message or the newest `preserveRecentMessages`: never touched. */
  pinned: boolean;
};

export type CallDecision = {
  tool_use_id: string;
  tool: string;
  action: CallAction;
  /** Why: `pinned`, `rule:<text>`, `recent`, or `default`. */
  reason: string;
};

export type PruneStats = {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  calls: number;
  pinned: number;
  kept: number;
  removed: number;
  noted: number;
  headed: number;
  abridged: number;
};

export type PruneResult = {
  messages: Message[];
  /** For each output message, the index of the input message it came from. */
  origins: number[];
  decisions: CallDecision[];
  stats: PruneStats;
};
