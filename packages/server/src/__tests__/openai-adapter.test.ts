import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { createOpenAiSseIterator, mapToOpenaiBody, normalizeFinishReason, normalizeOpenaiChatCompleted, normalizeUsage } from '../adapters/openai-compatible.js';
import type { StreamStateRef } from '../adapters/openai-compatible.js';
import type { AdapterContext } from '../adapters/base.js';
import type { ApiError } from '../errors.js';
import type { UnifiedChatRequest, UnifiedStreamEvent } from '../types.js';

/** The iterator reads only stream lifecycle + data; a Readable stands in for the HTTP response. */
type IteratorStream = Parameters<typeof createOpenAiSseIterator>[0];
const asIncoming = (r: Readable): IteratorStream => r as unknown as IncomingMessage;

/* â”€â”€â”€ non-streaming normalization â”€â”€â”€ */

describe('normalizeOpenaiChatCompleted', () => {
  it('maps a standard completion', () => {
    const shape = normalizeOpenaiChatCompleted(
      {
        id: 'cmpl-1',
        model: 'gpt-x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!', refusal: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
      'gpt-x',
    );
    expect(shape.choices).toHaveLength(1);
    expect(shape.choices[0]!.message.content).toBe('Hi!');
    expect(shape.choices[0]!.finish_reason).toBe('stop');
    expect(shape.usage?.total_tokens).toBe(6);
    expect(shape.model).toBe('gpt-x');
  });

  it('joins array content and extracts tool calls', () => {
    const shape = normalizeOpenaiChatCompleted(
      {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
              tool_calls: [{ id: 't1', function: { name: 'fn', arguments: '{"a":1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: null,
      },
      'm',
    );
    expect(shape.choices[0]!.message.content).toBe('AB');
    expect(shape.choices[0]!.message.tool_calls).toEqual([
      { id: 't1', type: 'function', function: { name: 'fn', arguments: '{"a":1}' } },
    ]);
    expect(shape.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('falls back to generated ids and default model fields', () => {
    const shape = normalizeOpenaiChatCompleted({ choices: [{ index: 0, message: { content: 'x' }, finish_reason: null }] }, 'resolved');
    expect(shape.id.startsWith('chatcmpl-')).toBe(true);
    expect(shape.model).toBe('resolved');
    expect(shape.usage).toBeNull();
  });

  it('throws ApiError on provider error envelopes and empty choices', () => {
    for (const body of [
      { error: { message: 'bad upstream' } },
      { choices: [] },
      'not even an object',
      null,
    ]) {
      let err: unknown = null;
      try {
        normalizeOpenaiChatCompleted(body, 'm');
      } catch (e) {
        err = e;
      }
      expect((err as ApiError).name).toBe('ApiError');
      expect((err as ApiError).status).toBe(502);
    }
  });

  it('maps finish reasons (unknown â†’ stop, error passthrough)', () => {
    expect(normalizeFinishReason('stop')).toBe('stop');
    expect(normalizeFinishReason('length')).toBe('length');
    expect(normalizeFinishReason('tool_calls')).toBe('tool_calls');
    expect(normalizeFinishReason('weird_universal')).toBe('stop');
    expect(normalizeOpenaiChatCompleted({ choices: [{ index: 0, message: { content: '' }, finish_reason: 'length' }] }, 'm').choices[0]!.finish_reason).toBe('length');
  });
});

describe('normalizeUsage', () => {
  it('keeps numeric fields and drops junk', () => {
    expect(normalizeUsage({ prompt_tokens: 3, completion_tokens: 5.5, total_tokens: 8, junk: true })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 5.5,
      total_tokens: 8,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
    expect(normalizeUsage('junk')).toEqual({
      prompt_tokens: undefined,
      completion_tokens: undefined,
      total_tokens: undefined,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });
});

/* â”€â”€â”€ body mapping â”€â”€â”€ */

describe('mapToOpenaiBody', () => {
  const baseCtx = { provider: { id: 'p', config: {} }, credentials: null, transport: {} } as unknown as AdapterContext;

  it('maps unified fields deterministically and coerces stop to array', () => {
    const body = mapToOpenaiBody(
      baseCtx,
      {
        model: 'local-test/m',
        messages: [{ role: 'user', content: 'hey' }],
        temperature: 0.5,
        max_tokens: 10,
        stop: 'END',
      } as UnifiedChatRequest,
      'upstream-m',
      false,
    );
    expect(body).toMatchObject({
      model: 'upstream-m',
      temperature: 0.5,
      max_tokens: 10,
      stop: ['END'],
      stream: false,
    });
  });

  it('merges extra_body adapter config under the mapped request', () => {
    const ctx = { provider: { id: 'p', config: { extra_body: { custom_flag: 'on' } } }, credentials: null, transport: {} } as unknown as AdapterContext;
    const body = mapToOpenaiBody(ctx, { model: 'x', messages: [{ role: 'user', content: 'q' }] } as UnifiedChatRequest, 'm', true);
    expect(body['custom_flag']).toBe('on');
    expect(body['model']).toBe('m');
    expect(body['stream']).toBe(true);
  });
});

/* â”€â”€â”€ SSE event iterator â”€â”€â”€ */

function sseStream(frames: string[]): Readable {
  const r = new Readable({ read() {} });
  r.push(frames.join(''));
  r.push(null);
  return r;
}

function collect(events: AsyncIterable<UnifiedStreamEvent>): Promise<UnifiedStreamEvent[]> {
  return (async () => {
    const out: UnifiedStreamEvent[] = [];
    for await (const ev of events) out.push(ev);
    return out;
  })();
}

const noopState: StreamStateRef = { providerMeta: {} };

describe('createOpenAiSseIterator', () => {
  it('emits content deltas, finish, and usage â€” NOTHING may be dropped', async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ];
    const parser = createOpenAiSseIterator(asIncoming(sseStream(frames)), noopState);
    const evs = await collect(parser.events);
    expect(evs.map((e) => e.kind)).toEqual(['role', 'text', 'text', 'finish', 'usage']);
    expect(evs[1]).toEqual({ kind: 'text', text: 'Hel' });
    expect(evs[3]).toEqual({ kind: 'finish', finishReason: 'stop', nativeFinishReason: undefined });
    expect(evs[4]).toEqual({ kind: 'usage', usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, prompt_tokens_details: undefined, completion_tokens_details: undefined } });
  });

  it('keeps events intact even when they arrive in one giant chunk (regression)', async () => {
    // All six frames in ONE tcp chunk â€” exactly the smoke condition that used to silently drop upstream events.
    const frames = ['data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"b"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"c"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n'];
    const parser = createOpenAiSseIterator(asIncoming(sseStream(frames)), noopState);
    const evs = await collect(parser.events);
    expect(evs.map((e) => e.kind)).toEqual(['text', 'text', 'text', 'finish', 'usage']);
  });

  it('tolerates malformed payloads, comments, CR separators and ping events', async () => {
    const frames = [
      ': keepalive\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\r\n\n', // CR line ending + blank separator
      'event: ping\ndata: {"noop":true}\n\n', // non-data event block â†’ no unified events
      'data: {invalid json\n\n', // malformed payload tolerated â†’ skipped
      'data: {"choices":[{"index":0,"delta":{"content":"done"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const parser = createOpenAiSseIterator(asIncoming(sseStream(frames)), noopState);
    const evs = await collect(parser.events);
    expect(evs.filter((e) => e.kind === 'text')).toEqual([{ kind: 'text', text: 'ok' }, { kind: 'text', text: 'done' }]);
    expect(evs.at(-1)).toMatchObject({ kind: 'finish' });
  });

  it('emits structured error events and terminates on mid-stream error objects', async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      'data: {"error": {"message": "exploded", "code": 500}}\n\n',
    ];
    const parser = createOpenAiSseIterator(asIncoming(sseStream(frames)), noopState);
    const evs = await collect(parser.events);
    expect(evs).toHaveLength(2);
    expect(evs[1]).toEqual({ kind: 'error', error: { code: 500, message: 'exploded' } });
  });

  it('terminates on [DONE] even without stream end', async () => {
    // A stream that never ends must still finish via [DONE].
    const r = new Readable({ read() {} });
    r.push('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n');
    r.push('data: [DONE]\n\n');
    evLoopNoEnd(r);
    const parser = createOpenAiSseIterator(asIncoming(r), noopState);
    const evs = await collect(parser.events);
    expect(evs).toHaveLength(1);
  });

  it('maps tool call deltas with indexes', async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"v\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const parser = createOpenAiSseIterator(asIncoming(sseStream(frames)), noopState);
    const evs = await collect(parser.events);
    expect(evs).toEqual([
      { kind: 'tool_call_delta', index: 0, call: { id: 'c1', name: 'f', args: '{"a":' } },
      { kind: 'tool_call_delta', index: 0, call: { args: '"v"}' } },
      { kind: 'finish', finishReason: 'tool_calls', nativeFinishReason: undefined },
    ]);
  });
});

/** Keeps a Readable open without ending it (stream lifecycle control in tests). */
function evLoopNoEnd(_r: Readable): void {
  /* intentionally never closes */
}
