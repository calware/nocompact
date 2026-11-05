import { describe, expect, it } from 'vitest';
import type { SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code';

import { compactEvent, forEngine, hybridInstructions, previewText, register, type Outcome } from '../hooks/nocompact.js';
import { resolveConfig } from '../src/config.js';
import { big, session, text, type Msg } from './helpers.js';

const SUMMARY: SessionMessage[] = [{ role: 'user', text: 'built-in summary', toolUses: [] }];

function harness() {
  const seen: SessionCompactInput[] = [];
  const said: [Outcome, string][] = [];
  const next = async (event: SessionCompactInput): Promise<SessionCompactResult> => {
    seen.push(event);
    return { messages: SUMMARY };
  };
  const say = (outcome: Outcome, line: string) => said.push([outcome, line]);
  return { seen, said, next, say };
}

const event = (messages: SessionMessage[], extra: Partial<SessionCompactInput> = {}): SessionCompactInput => ({
  trigger: 'auto',
  messages,
  ...extra,
});

/** Mostly text, so pruning tool calls frees little. */
function textHeavy(): SessionMessage[] {
  const messages: Msg[] = [text('user', 'start')];
  for (let i = 0; i < 10; i += 1) {
    messages.push(text('user', `question ${i}`), text('assistant', big(`answer ${i}`, 3000)));
  }
  return [...messages, ...session().slice(8)] as SessionMessage[];
}

describe('compactEvent', () => {
  it('jev: answers with the pruned conversation and never calls the summarizer', async () => {
    const h = harness();
    const input = session() as SessionMessage[];
    const out = await compactEvent(resolveConfig({}), event(input), h.next, h.say);
    expect(h.seen).toHaveLength(0);
    expect(out.messages).toHaveLength(8);
    expect(out.messages![0]).toEqual(input[0]);
    expect(h.said).toEqual([['pruned', expect.stringMatching(/^kept 8\/14 messages, no summary \(9\d% reduction; 3 calls removed, 1 pinned\)$/)]]);
  });

  it('jev: falls back to the built-in summary, untouched, when pruning frees too little', async () => {
    const h = harness();
    const input = textHeavy();
    const ev = event(input, { instructions: 'keep the plan' });
    const out = await compactEvent(resolveConfig({}), ev, h.next, h.say);
    expect(out).toEqual({ messages: SUMMARY });
    expect(h.seen).toEqual([ev]);
    expect(h.said[0]![0]).toBe('fallback_low_reduction');
    expect(h.said[0]![1]).toMatch(/below the 25% minimum/);
  });

  it('falls back to the built-in summary on an error', async () => {
    const h = harness();
    const broken = [text('user', 'x'), { role: 'assistant', text: 'y', toolUses: null }] as unknown as SessionMessage[];
    const out = await compactEvent(resolveConfig({}), event(broken), h.next, h.say);
    expect(out).toEqual({ messages: SUMMARY });
    expect(h.seen).toHaveLength(1);
    expect(h.said[0]![0]).toBe('fallback_error');
  });

  it('abridge: shortens old answers instead of summarizing when that is enough', async () => {
    const h = harness();
    const out = await compactEvent(resolveConfig({ lowReduction: 'abridge', abridgeAbove: 1000 }), event(textHeavy()), h.next, h.say);
    expect(h.seen).toHaveLength(0);
    expect(h.said[0]![0]).toBe('pruned');
    expect(out.messages!.some((m) => m.text.includes('nocompact abridged'))).toBe(true);
  });

  it('hybrid: summarizes only the oldest part and keeps the rest verbatim after it', async () => {
    const h = harness();
    const input = textHeavy();
    const out = await compactEvent(
      resolveConfig({ lowReduction: 'hybrid', hybridKeepPercent: 40 }),
      event(input, { instructions: 'keep the plan' }),
      h.next,
      h.say,
    );
    expect(h.seen).toHaveLength(1);
    const sent = h.seen[0]!;
    expect(sent.trigger).toBe('auto');
    expect(sent.instructions).toBe(hybridInstructions('keep the plan'));
    expect(sent.messages.length).toBeGreaterThan(1);
    expect(sent.messages).toEqual(input.slice(0, sent.messages.length));
    const kept = out.messages!.slice(SUMMARY.length);
    expect(out.messages!.slice(0, SUMMARY.length)).toEqual(SUMMARY);
    expect(kept[kept.length - 1]!.text).toBe(input[input.length - 1]!.text);
    expect(h.said[0]![0]).toBe('hybrid');
  });

  it('hybrid: passes a skipped summary through and never runs the summarizer twice', async () => {
    const seen: SessionCompactInput[] = [];
    const out = await compactEvent(
      resolveConfig({ lowReduction: 'hybrid' }),
      event(textHeavy()),
      async (e) => (seen.push(e), { skip: 'compaction is off' }),
      () => {},
    );
    expect(out).toEqual({ skip: 'compaction is off' });
    expect(seen).toHaveLength(1);
  });

  it('hybrid: keeps the pruned conversation when the summarizer fails', async () => {
    const h = harness();
    const input = [...(session().slice(0, 8) as SessionMessage[]), ...textHeavy().slice(1)];
    const out = await compactEvent(resolveConfig({ lowReduction: 'hybrid', minReductionPercent: 50 }), event(input), async () => {
      throw new Error('api down');
    }, h.say);
    expect(out.messages!.length).toBeLessThan(input.length);
    expect(h.said[0]).toEqual(['pruned', expect.stringMatching(/^summarizer failed \(api down\); kept the pruned conversation/)]);
  });

  it('hybrid: rethrows a summarizer failure when pruning removed nothing', async () => {
    const seen: SessionCompactInput[] = [];
    const chat = textHeavy().filter((m) => m.toolUses.length === 0 && !m.toolResults);
    await expect(
      compactEvent(resolveConfig({ lowReduction: 'hybrid' }), event(chat), async (e) => {
        seen.push(e);
        throw new Error('api down');
      }, () => {}),
    ).rejects.toThrow('api down');
    expect(seen).toHaveLength(1);
  });

  it('subagent transcripts compact the same way', async () => {
    const h = harness();
    const out = await compactEvent(resolveConfig({}), event(session() as SessionMessage[], { agentId: 'a1' }), h.next, h.say);
    expect(out.messages).toHaveLength(8);
  });
});

describe('forEngine', () => {
  const handled = (m: Msg, handle: string) => ({ ...m, handle }) as SessionMessage;

  it('copies assistant messages and tool results without handles, so a resumed session stays compacted', () => {
    const input = session().map((m, i) => handled(m, `h${i}`));
    const useText = input[1]!.toolUses[0]!.text;
    input[1]!.toolUses[0] = { ...input[1]!.toolUses[0]!, result: { file: 'x' }, agentId: 'a' } as SessionMessage['toolUses'][number];
    const out = forEngine(input, 'drop');
    expect(out[1]).not.toHaveProperty('handle');
    expect(out[1]!.toolUses[0]).toEqual({ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/a.ts' }, text: useText });
    expect(out[5]).not.toHaveProperty('handle');
    expect(out[5]!.toolResults).toEqual([{ tool_use_id: 't2', text: input[5]!.toolResults![0]!.text, isError: true }]);
    expect(out.map((m) => m.text)).toEqual(input.map((m) => m.text));
  });

  it("hands your own prompts back as the engine's objects, so pasted images survive", () => {
    const prompt = handled(text('user', 'look at this screenshot'), 'p1');
    expect(forEngine([prompt], 'drop')[0]).toBe(prompt);
  });

  it("thinking: keep hands everything back as the engine's own, as Jev did", () => {
    const input = session().map((m, i) => handled(m, `h${i}`));
    const out = forEngine(input, 'keep');
    out.forEach((m, i) => expect(m).toBe(input[i]));
    expect(resolveConfig({ thinking: 'keep' }).thinking).toBe('keep');
    expect(resolveConfig({}).thinking).toBe('keep');
    expect(resolveConfig({ profile: 'smart' }).thinking).toBe('keep');
    expect(resolveConfig({ thinking: 'drop' }).thinking).toBe('drop');
  });

  it('drops a message that held only thinking instead of sending it empty', () => {
    const thinking = handled(text('assistant', ''), 'th');
    const out = forEngine([text('user', 'q'), thinking, text('assistant', 'answer')], 'drop');
    expect(out.map((m) => m.text)).toEqual(['q', 'answer']);
  });
});

describe('preview', () => {
  it('describes what compacting now would do', () => {
    expect(previewText(session(), resolveConfig({}))).toMatch(/^If the conversation compacted now: would prune, no summary\.\n  14 → 8 messages/);
    expect(previewText(textHeavy(), resolveConfig({}))).toMatch(/would fall back to the built-in summary/);
    expect(previewText(textHeavy(), resolveConfig({ profile: 'smart' }))).toMatch(/would summarize the oldest \d+ messages/);
    expect(previewText([], resolveConfig({}))).toBe('Nothing to compact yet.');
  });
});

describe('register', () => {
  type Hook = (...args: unknown[]) => Promise<unknown>;
  function hooks(options: Record<string, unknown> = {}) {
    const map = new Map<string, Hook>();
    const on = (name: string, ...rest: unknown[]) => {
      map.set(name, rest[rest.length - 1] as Hook);
      return { catch: (handler: Hook) => map.set(`${name}.catch`, handler) };
    };
    register(on as never, options as never);
    return map;
  }

  it('registers the compaction hook with a catch that runs the built-in compaction', async () => {
    const map = hooks();
    expect([...map.keys()].sort()).toEqual(['command.run', 'session.compact', 'session.compact.catch', 'session.start', 'turn.complete']);
    const logs: string[] = [];
    const out = await map.get('session.compact.catch')!({ ui: { log: (l: string) => logs.push(l) } }, event([]), async () => ({ messages: SUMMARY }));
    expect(out).toEqual({ messages: SUMMARY });
    expect(logs[0]).toMatch(/built-in compaction/);
  });

  it('toasts and logs a compaction, and /nocompact lists it', async () => {
    const map = hooks();
    const logs: string[] = [];
    const toasts: string[] = [];
    const $ = {
      ui: { log: (l: string) => logs.push(l), toast: (t: string) => toasts.push(t) },
      session: { messages: async () => session() },
    };
    await map.get('session.compact')!($, event(session() as SessionMessage[], { trigger: 'manual' }), async () => ({ messages: SUMMARY }));
    expect(logs[0]).toMatch(/^nocompact: kept 8\/14 messages/);
    expect(toasts).toHaveLength(1);
    const status = (await map.get('command.run')!($, { command: 'nocompact', args: '' })) as { text: string };
    expect(status.text).toContain('profile            jev');
    expect(status.text).toMatch(/manual: kept 8\/14 messages/);
    const preview = (await map.get('command.run')!($, { command: 'nocompact', args: ' Preview ' })) as { text: string };
    expect(preview.text).toMatch(/would prune, no summary/);
  });

  it('stays quiet when notify is off and only logs precompute', async () => {
    const quiet = hooks({ notify: 'off' });
    const logs: string[] = [];
    const $ = { ui: { log: (l: string) => logs.push(l), toast: () => logs.push('toast') } };
    await quiet.get('session.compact')!($, event(session() as SessionMessage[]), async () => ({ messages: SUMMARY }));
    expect(logs).toEqual([]);
    await hooks().get('session.compact')!($, event(session() as SessionMessage[], { trigger: 'precompute' }), async () => ({ messages: SUMMARY }));
    expect(logs).toHaveLength(1);
  });

  it('asks for compaction past compactAtPercent, and not when it is 0', async () => {
    let compacted = 0;
    const $ = { session: { usage: async () => ({ context: { percent: 70 } }), compact: async () => (compacted += 1) }, ui: { log: () => {} } };
    const done = async () => ({});
    await hooks().get('turn.complete')!($, {}, done);
    expect(compacted).toBe(1);
    await hooks({ compactAtPercent: 80 }).get('turn.complete')!($, {}, done);
    await hooks({ compactAtPercent: 0 }).get('turn.complete')!($, {}, done);
    expect(compacted).toBe(1);
  });
});
