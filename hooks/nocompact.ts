import type {
  On,
  PluginOptions,
  Register,
  SessionCompactInput,
  SessionCompactResult,
  SessionMessage,
} from 'claude-code';

import { describeConfig, resolveConfig, type Config } from '../src/config.js';
import { hybridSplit, prune, reductionRatio } from '../src/prune.js';
import type { Message, PruneResult, PruneStats } from '../src/types.js';

/** How one compaction ended, for `/nocompact` and the notice. */
export type Outcome =
  /** The pruned conversation replaced the old one; no summary was written. */
  | 'pruned'
  /** The oldest part went to the built-in summarizer; the rest stayed verbatim. */
  | 'hybrid'
  /** Pruning freed too little; the built-in summary ran on everything. */
  | 'fallback_low_reduction'
  /** Something failed; the built-in summary ran on everything. */
  | 'fallback_error';

export type Report = {
  at: string;
  trigger: SessionCompactInput['trigger'];
  agentId?: string;
  outcome: Outcome;
  text: string;
};

const HISTORY = 5;

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(stats: PruneStats): string {
  const parts = [
    stats.removed ? `${stats.removed} calls removed` : '',
    stats.noted ? `${stats.noted} calls removed with a note` : '',
    stats.headed ? `${stats.headed} outputs truncated` : '',
    stats.kept ? `${stats.kept} kept` : '',
    stats.pinned ? `${stats.pinned} pinned` : '',
    stats.abridged ? `${stats.abridged} old texts abridged` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(stats))} reduction; ${parts.join(', ') || 'no tool calls'}`;
}

/** Runs the pruner as configured (the `abridge` plan B included). */
export function pruneFor(messages: readonly Message[], config: Config): PruneResult {
  return prune(
    messages,
    config,
    config.lowReduction === 'abridge' ? { abridgeUntil: config.minReductionRatio } : {},
  );
}

/**
 * The messages to hand back to Claude Code.
 *
 * `thinking: keep` (the default) hands every message back as
 * fast-jev-compaction did: the engine's own objects (their handles), so kept
 * messages keep their thinking blocks. Claude Code 2.1.318, though, writes a
 * kept assistant or tool-result row with its original message id and its
 * pre-compaction links, so resuming the session gathers the originals back
 * in: pruned history returns and kept messages appear twice.
 *
 * `thinking: drop` hands assistant messages and tool results back as fresh
 * copies, which resume cleanly. A copy carries the text and tool calls but not
 * thinking blocks or images, so a copy left with nothing (a message that held
 * only thinking) is dropped rather than sent empty. Your own prompts keep
 * their handles: they resume cleanly and keep pasted images. Keeping handles
 * only for the untouched tail does not help: Claude Code writes those rows
 * the same way.
 */
export function forEngine(messages: readonly Message[], thinking: Config['thinking']): SessionMessage[] {
  if (thinking === 'keep') return [...(messages as readonly SessionMessage[])];
  const out: SessionMessage[] = [];
  for (const message of messages as readonly SessionMessage[]) {
    if (message.handle !== undefined && message.role === 'user' && !message.toolResults?.length) {
      out.push(message);
      continue;
    }
    if (!message.text && message.toolUses.length === 0 && !message.toolResults?.length) continue;
    const copy: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => {
        const use: SessionMessage['toolUses'][number] = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input };
        if (tool.text !== undefined) use.text = tool.text;
        if (tool.isError) use.isError = true;
        return use;
      }),
    };
    if (message.toolResults?.length) {
      copy.toolResults = message.toolResults.map((result) => ({
        tool_use_id: result.tool_use_id,
        text: result.text,
        isError: result.isError ?? false,
      }));
    }
    out.push(copy);
  }
  return out;
}

export function hybridInstructions(instructions: string | undefined): string {
  const note =
    'Only the earlier part of the conversation is being summarized here. The most recent part follows this summary verbatim, so focus on what that later part will need from the earlier one.';
  return instructions ? `${instructions}\n\n${note}` : note;
}

/**
 * Compacts one transcript. Returns the engine's own compaction (via `next`)
 * whenever pruning cannot do the job: on any error, and when it frees less
 * than `minReductionRatio` and no plan B helps.
 */
export async function compactEvent(
  config: Config,
  event: SessionCompactInput,
  next: (event: SessionCompactInput) => Promise<SessionCompactResult>,
  say: (outcome: Outcome, text: string) => void,
): Promise<SessionCompactResult> {
  let handedOff = false;
  const builtIn = async (outcome: Outcome, why: string): Promise<SessionCompactResult> => {
    handedOff = true;
    say(outcome, `fallback to built-in summary (${why})`);
    return next(event);
  };
  try {
    const result = pruneFor(event.messages, config);
    const ratio = reductionRatio(result.stats);
    const total = event.messages.length;
    if (ratio >= config.minReductionRatio && result.stats.charsAfter < result.stats.charsBefore) {
      say('pruned', `kept ${result.messages.length}/${total} messages, no summary (${summarize(result.stats)})`);
      return { messages: forEngine(result.messages, config.thinking) };
    }
    if (config.lowReduction === 'hybrid') {
      const split = hybridSplit(event.messages, result, config);
      if (split !== undefined) {
        const tail = forEngine(result.messages.filter((_, k) => result.origins[k]! >= split), config.thinking);
        handedOff = true;
        let summary: SessionCompactResult;
        try {
          summary = await next({
            ...event,
            messages: event.messages.slice(0, split),
            instructions: hybridInstructions(event.instructions),
          });
        } catch (error) {
          // The summarizer can't be asked twice in one compaction: keep what
          // pruning achieved, if anything, rather than not compacting at all.
          if (result.stats.charsAfter >= result.stats.charsBefore) throw error;
          const why = error instanceof Error ? error.message : String(error);
          say('pruned', `summarizer failed (${why}); kept the pruned conversation (${summarize(result.stats)})`);
          return { messages: forEngine(result.messages, config.thinking) };
        }
        if (summary.skip !== undefined) return summary;
        say(
          'hybrid',
          `summarized the oldest ${split}/${total} messages, kept the newest ${tail.length} verbatim (pruning alone: ${summarize(result.stats)})`,
        );
        return { messages: [...summary.messages, ...tail] };
      }
    }
    return builtIn(
      'fallback_low_reduction',
      `${summarize(result.stats)}, below the ${percent(config.minReductionRatio)} minimum`,
    );
  } catch (error) {
    if (handedOff) throw error;
    return builtIn('fallback_error', error instanceof Error ? error.message : String(error));
  }
}

export function previewText(messages: readonly Message[], config: Config): string {
  if (messages.length === 0) return 'Nothing to compact yet.';
  const result = pruneFor(messages, config);
  const ratio = reductionRatio(result.stats);
  const byTool = new Map<string, number>();
  for (const decision of result.decisions) {
    if (decision.action === 'keep') continue;
    byTool.set(decision.tool, (byTool.get(decision.tool) ?? 0) + 1);
  }
  const top = [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 8);
  let verdict: string;
  if (ratio >= config.minReductionRatio && result.stats.charsAfter < result.stats.charsBefore) {
    verdict = 'would prune, no summary';
  } else if (config.lowReduction === 'hybrid' && hybridSplit(messages, result, config) !== undefined) {
    const split = hybridSplit(messages, result, config)!;
    verdict = `would summarize the oldest ${split} messages and keep the rest verbatim`;
  } else {
    verdict = `would fall back to the built-in summary (below ${percent(config.minReductionRatio)})`;
  }
  const lines = [
    `If the conversation compacted now: ${verdict}.`,
    `  ${result.stats.messagesBefore} → ${result.stats.messagesAfter} messages, ~${Math.round(result.stats.charsBefore / 1000)}K → ~${Math.round(result.stats.charsAfter / 1000)}K chars`,
    `  ${summarize(result.stats)}`,
  ];
  if (top.length) lines.push(`  most affected: ${top.map(([tool, n]) => `${tool} ${n}`).join(', ')}`);
  return lines.join('\n');
}

const HELP = [
  '/nocompact            settings and recent compactions',
  '/nocompact preview    what compacting now would do (changes nothing)',
  'Change settings with /plugin configure nocompact@nocompact, or under pluginConfigs in settings.json.',
].join('\n');

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveConfig(options);
  const reports: Report[] = [];
  let compacting = false;

  on('session.start', async ($, event, next) => {
    await $.command.register({
      name: 'nocompact',
      description: 'Show nocompact settings, recent compactions, or a preview',
      argumentHint: '[preview|help]',
    });
    if (config.ruleErrors.length > 0) {
      $.ui.log(`nocompact: ignored toolRules ${config.ruleErrors.join('; ')}`);
    }
    return next(event);
  });

  on('session.compact', async ($, event, next) => {
    const say = (outcome: Outcome, text: string) => {
      const report: Report = { at: new Date().toISOString(), trigger: event.trigger, outcome, text };
      if (event.agentId) report.agentId = event.agentId;
      reports.unshift(report);
      reports.length = Math.min(reports.length, HISTORY);
      if (config.notify === 'off') return;
      $.ui.log(`nocompact: ${text}`);
      if (config.notify === 'toast') {
        $.ui.toast(`nocompact: ${text}`, { timeoutMs: 15_000 });
      }
    };
    return compactEvent(config, event, next, say);
  }).catch(($, event, next) => {
    // Whatever went wrong, Claude Code's own compaction still runs (or, where
    // the hook had already handed off to it, its answer is replayed).
    $.ui.log('nocompact: hook failed; using the built-in compaction');
    return next(event);
  });

  on('turn.complete', async ($, event, next) => {
    if (compacting || config.compactAtPercent <= 0) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(`nocompact: auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });

  on('command.run', { command: 'nocompact' }, async ($, event) => {
    const arg = event.args.trim().toLowerCase();
    if (arg === 'help') return { text: HELP };
    if (arg === 'preview') return { text: previewText(await $.session.messages(), config) };
    const recent = reports.length
      ? reports.map((r) => `  ${r.at.slice(11, 19)} ${r.trigger}${r.agentId ? ` (subagent)` : ''}: ${r.text}`)
      : ['  none since the plugin loaded'];
    return {
      text: ['nocompact settings', ...describeConfig(config).map((line) => `  ${line}`), 'Recent compactions', ...recent, '', HELP].join('\n'),
    };
  });
};
