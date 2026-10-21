import { describe, expect, it } from 'vitest';
import { relaySse, type RelayMeta } from '../services/sseRelay.js';
import type { UnifiedStreamEvent } from '../types.js';

const META: RelayMeta = {
  requestedModel: 'alias-1',
  provider: 'prov',
  modelId: 'model',
  requestId: 'req_abcdef123456',
  maxEvents: 1000,
};

/** Collects the full SSE body as decoded text. */
function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return (async () => {
    const decoder = new TextDecoder();
    let out = '';
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) out += decoder.decode(chunk, { stream: true });
    out += decoder.decode();
    return out;
  })();
}

function dataPayloads(body: string): string[] {
  return body
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => b.slice('data: '.length));
}

async function runWithEvents(source: UnifiedStreamEvent[] | Error, meta: Partial<RelayMeta> = {}): Promise<{ body: string; stats: ReturnType<typeof relaySse>['stats']; payloads: string[] }> {
  const src = (async function* gen() {
    if (source instanceof Error) throw source;
    for (const ev of source) yield ev;
  })();
  const { stream, stats } = relaySse(src, { ...META, ...meta });
  const body = await readAll(stream);
  await new Promise((r) => setImmediate(r));
  return { body, stats, payloads: dataPayloads(body) };
}

describe('relaySse', () => {
  it('converts text deltas into chat.completion.chunk frames and ends with [DONE]', async () => {
    const { body, stats, payloads } = await runWithEvents([
      { kind: 'role', role: 'assistant' },
      { kind: 'text', text: 'He' },
      { kind: 'text', text: 'llo' },
      { kind: 'finish', finishReason: 'stop' },
      { kind: 'usage', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
    ]);
    expect(body.split('\n\n').at(-2)).toBe('data: [DONE]'); // sentinel is present, near the end
    const parsed = payloads.slice(0, -1).map((p) => JSON.parse(p) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({ object: 'chat.completion.chunk', model: 'prov/model', provider: 'prov', request_id: 'req_abcdef123456', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    expect(parsed[1]).toMatchObject({ choices: [{ delta: { content: 'He' } }] });
    // usage chunk: empty choices + usage object
    expect(parsed.at(-1)).toEqual({
      id: 'chatcmpl-abcdef123456',
      object: 'chat.completion.chunk',
      created: expect.any(Number),
      model: 'prov/model',
      provider: 'prov',
      request_id: 'req_abcdef123456',
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
    expect(stats.chunks).toBe(6); // 5 relayed events + the [DONE] sentinel frame counts too
    expect(stats.finishReason).toBe('stop');
    expect(stats.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
    expect(stats.textChars).toBe(5);
  });

  it('synthesizes a stop frame when upstream ends without finish or error', async () => {
    const { stats, payloads } = await runWithEvents([{ kind: 'text', text: 'silence' }]);
    const parsed = payloads.slice(0, -1).map((p) => JSON.parse(p) as Record<string, unknown>);
    expect(parsed.at(-1)).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(stats.finishReason).toBe('stop');
  });

  it('relays in-stream error events as top-level error frames with finish_reason "error"', async () => {
    const { body, stats, payloads } = await runWithEvents([
      { kind: 'text', text: 'partial' },
      { kind: 'error', error: { code: 500, message: 'upstream exploded' } },
    ]);
    const parsed = payloads.slice(0, -1).map((p) => JSON.parse(p) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toMatchObject({
      error: { message: 'upstream exploded', code: 500, type: 'api_error', request_id: 'req_abcdef123456' },
      choices: [{ delta: {}, finish_reason: 'error' }],
    });
    expect(stats.errorCode).toBe('500');
    expect(stats.errorMessage).toBe('upstream exploded');
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('converts a thrown source error into a branded error frame', async () => {
    const { stats, payloads } = await runWithEvents(new Error('socket reset'));
    const parsed = payloads.slice(0, -1).map((p) => JSON.parse(p) as Record<string, unknown>);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ error: { message: 'Upstream stream failed.', code: 'provider_error' }, choices: [{ finish_reason: 'error' }] });
    expect(stats.errorCode).toBe('internal_error');
    expect(stats.errorMessage).toBe('socket reset');
    void parsed;
  });

  it('enforces maxEvents with cap-exceeded error frame', async () => {
    const source: UnifiedStreamEvent[] = Array(10).fill(null).map(() => ({ kind: 'text', text: 'x' }) as UnifiedStreamEvent);
    const { stats, payloads } = await runWithEvents(source, { maxEvents: 3 });
    expect(stats.errorCode).toBe('internal_error');
    expect(stats.errorMessage).toMatch(/event cap/);
    const parsed = payloads.slice(0, -1).map((p) => JSON.parse(p) as Record<string, unknown>);
    expect(parsed.at(-1)).toMatchObject({ choices: [{ finish_reason: 'error' }] });
    // 3 content chunks + 1 error chunk + [DONE] sentinel = 5 frames charged
    expect(stats.chunks).toBe(5);
  });

  it('buffers tool_call deltas preserving indexes and fields', async () => {
    const { payloads } = await runWithEvents([
      { kind: 'tool_call_delta', index: 2, call: { id: 'c9', name: 'fn', args: '{"a":' } },
      { kind: 'tool_call_delta', index: 2, call: { args: '1}' } },
      { kind: 'finish', finishReason: 'tool_calls' },
    ]);
    const parsed = payloads.slice(0, -1).map((p) => JSON.parse(p) as Record<string, unknown>);
    const [firstArgs, secondArgs] = parsed.map((p) => (p['choices'] as Array<Record<string, unknown>>)[0]!['delta']);
    expect(firstArgs).toEqual({
      tool_calls: [{ index: 2, id: 'c9', type: 'function', function: { name: 'fn', arguments: '{"a":' } }],
    });
    expect(secondArgs).toEqual({
      tool_calls: [{ index: 2, type: 'function', function: { arguments: '1}' } }],
    });
  });
});
