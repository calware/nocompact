import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../src/config.js';
import {
  abridgeText,
  collectCalls,
  headText,
  HYBRID_MIN_ROUNDS,
  hybridSplit,
  noteText,
  prune,
  reductionRatio,
  totalChars,
} from '../src/prune.js';
import { callSubject, matchRule, parseRules } from '../src/rules.js';
import { big, call, result, session, text, type Msg } from './helpers.js';

const jev = resolveConfig({});

describe('jev profile (the default)', () => {
  it('removes every unpinned tool call with its result and keeps all text', () => {
    const input = session();
    const out = prune(input, jev);
    expect(out.messages.map((m) => m.text)).toEqual([
      'Fix the failing test in src/a.ts.',
      'Running the tests.',
      'also check the docs',
      'Will do.',
      '',
      '',
      'Fixed.',
      'thanks',
    ]);
    expect(out.decisions.map((d) => [d.tool_use_id, d.action, d.reason])).toEqual([
      ['t1', 'remove', 'default'],
      ['t2', 'remove', 'default'],
      ['t3', 'remove', 'default'],
      ['t4', 'keep', 'pinned'],
    ]);
    expect(out.stats).toMatchObject({ calls: 4, pinned: 1, removed: 3, kept: 0, noted: 0, headed: 0 });
    expect(reductionRatio(out.stats)).toBeGreaterThan(0.9);
  });

  it('returns untouched messages as the same objects, handles included', () => {
    const input = session();
    const out = prune(input, jev);
    for (const message of out.messages) expect(input).toContain(message);
    expect(out.origins).toEqual([0, 3, 8, 9, 10, 11, 12, 13]);
  });

  it('never touches the first message or the newest preserveRecentMessages', () => {
    const input = [call('t0', 'Read', { file_path: 'x' }, big('x')), result('t0', big('x')), ...session().slice(1)];
    const out = prune(input, jev);
    expect(out.messages[0]).toBe(input[0]);
    expect(out.messages[1]).toBe(input[1]);
    expect(collectCalls(input, 6).filter((c) => c.pinned).map((c) => c.tool_use_id)).toEqual(['t0', 't4']);
  });

  it('pins a call whose result landed in the recent window', () => {
    const input = session();
    const calls = collectCalls(input, 7);
    expect(calls.find((c) => c.tool_use_id === 't3')?.pinned).toBe(true);
    expect(calls.find((c) => c.tool_use_id === 't2')?.pinned).toBe(false);
  });

  it('leaves an unanswered call alone', () => {
    const input = [...session().slice(0, 3), call('t9', 'Bash', { command: 'sleep 100' }, ''), ...session().slice(3)];
    input[3]!.toolUses = [{ tool_use_id: 't9', tool: 'Bash', input: { command: 'sleep 100' } }];
    const out = prune(input, jev);
    expect(out.messages).toContain(input[3]);
    expect(out.decisions.map((d) => d.tool_use_id)).not.toContain('t9');
  });

  it("keeps a rebuilt message's own text and remaining tools", () => {
    const mixed = text('assistant', 'Reading both.');
    mixed.toolUses = [
      { tool_use_id: 'a', tool: 'Read', input: { file_path: 'a' }, text: big('a') },
      { tool_use_id: 'b', tool: 'Read', input: { file_path: 'b' } },
    ];
    const input = [text('user', 'go'), mixed, result('a', big('a')), ...session().slice(8)];
    const out = prune(input, jev);
    expect(out.messages[1]).toEqual({ role: 'assistant', text: 'Reading both.', toolUses: [mixed.toolUses[1]] });
    expect(out.messages[1]).not.toHaveProperty('handle');
  });

  it("measures size exactly as fast-jev-compaction did", () => {
    const input = session();
    const expected = input.reduce(
      (sum, m) =>
        sum +
        m.text.length +
        m.toolUses.reduce((s, t) => s + JSON.stringify(t.input).length, 0) +
        (m.toolResults ?? []).reduce((s, r) => s + r.text.length, 0),
      0,
    );
    expect(totalChars(input)).toBe(expected);
  });
});

describe('drop styles and rules', () => {
  it('note: gathers removed calls in a row into one short note', () => {
    const out = prune(session(), resolveConfig({ droppedCalls: 'note' }));
    const notes = out.messages.filter((m) => m.text.startsWith('[nocompact removed'));
    expect(notes).toHaveLength(2);
    expect(notes[0]!.text).toBe(noteText(['Read src/a.ts']));
    expect(notes[1]!.text).toBe(noteText(['Bash npm test (error)', 'Grep expected']));
    expect(notes[1]!.text).toContain('2 earlier tool calls');
    expect(out.stats.noted).toBe(3);
  });

  it('note: caps how many calls one note lists', () => {
    const entries = Array.from({ length: 20 }, (_, i) => `Read f${i}`);
    expect(noteText(entries)).toContain('· and 8 more.');
  });

  it('head: keeps the call and cuts its output like Jev cut a dropped result', () => {
    const out = prune(session(), resolveConfig({ droppedCalls: 'head', headChars: 10 }));
    const read = out.messages.find((m) => m.toolUses[0]?.tool_use_id === 't1')!;
    expect(read.toolUses[0]!.text).toBe(headText(big('file a'), false, 10));
    const res = out.messages.find((m) => m.toolResults?.[0]?.tool_use_id === 't2')!;
    expect(res.toolResults![0]).toEqual({
      tool_use_id: 't2',
      text: `FAIL b.tes\n[nocompact truncated 3990 chars of this tool result (error); re-run the tool if needed]`,
      isError: true,
    });
    expect(headText('short', false, 10)).toBe('short');
  });

  it('rules override the drop style, first match wins, subjects match arguments', () => {
    const config = resolveConfig({ toolRules: 'Read(*.ts)=keep; bash=head, Grep=note, Read=remove' });
    const out = prune(session(), config);
    expect(out.decisions.slice(0, 3).map((d) => [d.action, d.reason])).toEqual([
      ['keep', 'rule:Read(*.ts)=keep'],
      ['head', 'rule:bash=head'],
      ['note', 'rule:Grep=note'],
    ]);
  });

  it('keepRecentCalls keeps the newest unpinned calls whole', () => {
    const out = prune(session(), resolveConfig({ keepRecentCalls: 2 }));
    expect(out.decisions.map((d) => d.reason)).toEqual(['default', 'recent', 'recent', 'pinned']);
  });

  it('parses rules leniently and reports bad entries', () => {
    const { rules, errors } = parseRules('A=keep,, B(x y)=stub ; C=explode; =keep; mcp__*=truncate');
    expect(rules.map((r) => [r.text, r.action])).toEqual([
      ['A=keep', 'keep'],
      ['B(x y)=stub', 'note'],
      ['mcp__*=truncate', 'head'],
    ]);
    expect(errors).toHaveLength(2);
    expect(matchRule(rules, 'mcp__ms365__get-mail-message', {})?.action).toBe('head');
    expect(matchRule(rules, 'MCP__x', {})?.action).toBe('head');
    expect(matchRule(rules, 'B', { command: 'x y' })?.action).toBe('note');
    expect(matchRule(rules, 'B', { command: 'x' })).toBeUndefined();
  });

  it('finds the subject of a call', () => {
    expect(callSubject({ file_path: 'a.ts', limit: 3 })).toBe('a.ts');
    expect(callSubject({ command: 'ls', description: 'list' })).toBe('ls');
    expect(callSubject({ other: 5, thing: 'value' })).toBe('value');
    expect(callSubject({})).toBe('');
  });
});

describe('old text', () => {
  const long = (label: string) => `${label} `.padEnd(5000, 'y');
  function chatty() {
    return [
      text('user', 'start'),
      text('assistant', long('old answer')),
      text('user', long('pasted log')),
      text('assistant', long('second answer')),
      ...session().slice(8),
    ];
  }

  it('keep (default) never changes text', () => {
    const input = chatty();
    expect(prune(input, jev).messages.slice(0, 4)).toEqual(input.slice(0, 4));
  });

  it('abridge shortens old assistant texts, abridge-all user texts too', () => {
    const a = prune(chatty(), resolveConfig({ oldText: 'abridge', abridgeAbove: 1000 }));
    expect(a.messages[1]!.text).toBe(abridgeText(long('old answer'), 1000));
    expect(a.messages[1]!.text).toContain('[… nocompact abridged 4150 chars of this old message …]');
    expect(a.messages[2]!.text).toBe(long('pasted log'));
    expect(a.stats.abridged).toBe(2);
    const all = prune(chatty(), resolveConfig({ oldText: 'abridge-all', abridgeAbove: 1000 }));
    expect(all.messages[2]!.text.length).toBeLessThan(1100);
  });

  it('abridgeUntil abridges oldest first and stops once enough is gone', () => {
    const config = resolveConfig({ abridgeAbove: 1000 });
    const out = prune(chatty(), config, { abridgeUntil: 0.2 });
    expect(out.stats.abridged).toBe(1);
    expect(out.messages[1]!.text.length).toBeLessThan(1100);
    expect(out.messages[3]!.text).toBe(long('second answer'));
    expect(reductionRatio(out.stats)).toBeGreaterThanOrEqual(0.2);
  });
});

describe('hybrid split', () => {
  const rounds = (...tails: Msg[]) => [
    text('user', 'p1'),
    text('assistant', big('a1', 3000)),
    text('user', 'p2'),
    text('assistant', big('a2', 3000)),
    text('user', 'p3'),
    text('assistant', big('a3', 3000)),
    text('user', 'p4'),
    text('assistant', big('a4', 3000)),
    ...tails,
    ...session().slice(8),
  ];

  it('splits at a prompt so the recent part fits the budget', () => {
    const input = rounds();
    const config = resolveConfig({ hybridKeepPercent: 50 });
    const pruned = prune(input, config);
    const split = hybridSplit(input, pruned, config)!;
    expect(split).toBe(6);
    expect(input[split]!.text).toBe('p4');
    const tail = pruned.messages.filter((_, k) => pruned.origins[k]! >= split);
    expect(totalChars(tail)).toBeLessThanOrEqual(totalChars(input) * 0.5);
  });

  it(`leaves at least ${HYBRID_MIN_ROUNDS} rounds to summarize`, () => {
    const input = rounds();
    const config = resolveConfig({ hybridKeepPercent: 80 });
    // Splitting at p2 would fit 80%, but one round is too few for the summarizer.
    expect(hybridSplit(input, prune(input, config), config)).toBe(4);
  });

  it('does not split at text Claude Code added', () => {
    const input = rounds();
    input.splice(6, 0, text('user', '<system-reminder>context</system-reminder>'));
    const config = resolveConfig({ hybridKeepPercent: 50 });
    expect(input[hybridSplit(input, prune(input, config), config)!]!.text).toBe('p4');
  });

  it('never splits inside a call and its result', () => {
    const inside = [
      call('w', 'Write', { file_path: 'f', content: big('body', 9000) }, 'written'),
      text('user', 'typed while the call ran'),
      result('w', 'written'),
      text('assistant', 'ok'),
    ];
    const input = rounds(...inside);
    const config = resolveConfig({ hybridKeepPercent: 30, toolRules: 'Write=keep' });
    const split = hybridSplit(input, prune(input, config), config);
    expect(split).not.toBe(9);
    expect(split).toBe(12);
  });

  it('gives up when even the pinned recent messages exceed the budget', () => {
    const input = [text('user', 'go'), ...session().slice(8)];
    input[2]!.text = big('huge', 20000);
    const config = resolveConfig({ hybridKeepPercent: 10 });
    expect(hybridSplit(input, prune(input, config), config)).toBeUndefined();
  });
});

describe('config', () => {
  it('defaults to the jev profile', () => {
    expect(jev).toMatchObject({
      profile: 'jev',
      droppedCalls: 'remove',
      rules: [],
      keepRecentCalls: 0,
      headChars: 300,
      oldText: 'keep',
      lowReduction: 'summary',
      minReductionRatio: 0.25,
      preserveRecentMessages: 6,
      compactAtPercent: 60,
      notify: 'toast',
    });
  });

  it('applies the smart profile, with each option overriding it', () => {
    expect(resolveConfig({ profile: 'smart' })).toMatchObject({ droppedCalls: 'note', lowReduction: 'hybrid', headChars: 500 });
    const config = resolveConfig({ profile: 'smart', droppedCalls: 'remove', lowReduction: 'profile', toolRules: 'Read=keep' });
    expect(config.droppedCalls).toBe('remove');
    expect(config.lowReduction).toBe('hybrid');
    expect(config.rulesText.startsWith('Read=keep, AskUserQuestion=keep')).toBe(true);
  });

  it('reads numbers, clamps them, and ignores junk', () => {
    expect(resolveConfig({ minReductionPercent: 40 }).minReductionRatio).toBe(0.4);
    expect(resolveConfig({ minReductionPercent: '10' }).minReductionRatio).toBe(0.1);
    expect(resolveConfig({ minReductionPercent: 900 }).minReductionRatio).toBe(1);
    expect(resolveConfig({ preserveRecentMessages: 'lots' }).preserveRecentMessages).toBe(6);
    expect(resolveConfig({ profile: 'turbo', droppedCalls: 'shred' })).toMatchObject({ profile: 'jev', droppedCalls: 'remove' });
  });
});
