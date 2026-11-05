import type { Message, ToolUse } from '../src/types.js';

export type Msg = Message & { handle?: string };

export function text(role: Message['role'], body: string, handle?: string): Msg {
  const message: Msg = { role, text: body, toolUses: [] };
  if (handle) message.handle = handle;
  return message;
}

export function call(id: string, tool: string, input: Record<string, unknown>, output: string): Msg {
  const use: ToolUse = { tool_use_id: id, tool, input, text: output };
  return { role: 'assistant', text: '', toolUses: [use], handle: `c-${id}` };
}

export function result(id: string, output: string, isError = false): Msg {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError }], handle: `r-${id}` };
}

export const big = (label: string, n = 4000) => `${label}:`.padEnd(n, 'x');

/**
 * A small session: a prompt, three old answered tool calls, then six
 * recent messages (one more call among them) pinned by default.
 */
export function session(): Msg[] {
  return [
    text('user', 'Fix the failing test in src/a.ts.', 'h0'),
    call('t1', 'Read', { file_path: 'src/a.ts' }, big('file a')),
    result('t1', big('file a')),
    text('assistant', 'Running the tests.', 'h3'),
    call('t2', 'Bash', { command: 'npm test' }, big('FAIL b.test.ts')),
    result('t2', big('FAIL b.test.ts'), true),
    call('t3', 'Grep', { pattern: 'expected', path: 'src' }, big('grep hits')),
    result('t3', big('grep hits')),
    text('user', 'also check the docs', 'h8'),
    text('assistant', 'Will do.', 'h9'),
    call('t4', 'Read', { file_path: 'docs/a.md' }, 'short doc'),
    result('t4', 'short doc'),
    text('assistant', 'Fixed.', 'h12'),
    text('user', 'thanks', 'h13'),
  ];
}
