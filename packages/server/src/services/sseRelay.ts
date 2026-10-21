/**
 * SSE relay: converts the gateway's unified stream events into the
 * OpenAI-compatible `chat.completion.chunk` wire format (verified against the
 * OpenAI streaming spec and OpenRouter's documented mid-stream error handling).
 *
 * Wire shape per event:
 *   role    → delta: { role }
 *   text    → delta: { content }
 *   tool_*  → delta: { tool_calls: [...] } (index-aligned, args streamed)
 *   finish  → delta: {}, finish_reason
 *   usage   → separate usage chunk with empty choices (OpenAI include_usage style)
 *   error   → chunk carrying a top-level `error` object + finish_reason "error",
 *             then the stream closes. [DONE] terminates the stream.
 */
import { randomId } from '../crypto.js';
import type { UnifiedStreamEvent } from '../types.js';

/** Response headers required for a streaming SSE reply. Applies to the hono Context. */
export function applySseHeaders(c: { header(k: string, v: string, o?: { append?: boolean }): void }): void {
  c.header('content-type', 'text/event-stream; charset=utf-8');
  c.header('cache-control', 'no-cache, no-transform');
  c.header('connection', 'keep-alive');
  c.header('x-accel-buffering', 'no');
}

export type SseEventSource = AsyncIterable<UnifiedStreamEvent>;

export interface RelayMeta {
  requestedModel: string;
  provider: string;
  modelId: string;
  requestId: string;
  /** Safety cap on relayed chunks (protects memory from malicious upstreams). */
  maxEvents?: number;
}

export interface RelayStats {
  chunks: number;
  textChars: number;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  errorCode: string | null;
  errorMessage: string | null;
  aborted: boolean;
}

export function relaySse(
  source: SseEventSource,
  meta: RelayMeta,
  onEvent?: (stats: RelayStats) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { stream: ReadableStream<Uint8Array>; stats: RelayStats } {
  const encoder = new TextEncoder();
  const stats: RelayStats = {
    chunks: 0,
    textChars: 0,
    finishReason: null,
    usage: null,
    errorCode: null,
    errorMessage: null,
    aborted: false,
  };
  const completionId = `chatcmpl-${meta.requestId.slice(4)}`;
  const created = Math.floor(Date.now() / 1000);
  const fullModel = `${meta.provider}/${meta.modelId}`;

  // Buffer flushes with an inner controller to decouple source pacing from client pacing.
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  async function push(payload: string): Promise<void> {
    stats.chunks += 1;
    if (controllerRef) controllerRef.enqueue(encoder.encode(payload));
  }

  function chunkJson(delta: Record<string, unknown>, finishReason: string | null): string {
    return `data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: fullModel,
      provider: meta.provider,
      request_id: meta.requestId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      stats.aborted = true;
      closed = true;
      void iterator?.return?.(undefined as never);
    },
  });

  let iterator: AsyncIterator<UnifiedStreamEvent> | null = null;

  async function run(): Promise<void> {
    const toolBuffers = new Map<number, { id?: string; name?: string }>();
    try {
      iterator = source[Symbol.asyncIterator]();
      while (true) {
        if (closed) break;
        const next = await iterator.next();
        if (next.done) break;
        if (meta.maxEvents !== undefined && stats.chunks >= meta.maxEvents) {
          stats.errorCode = 'internal_error';
          stats.errorMessage = `Stream exceeded the configured event cap (${meta.maxEvents}).`;
          await push(
            `data: ${JSON.stringify({
              error: { message: stats.errorMessage, code: 'internal_error', type: 'api_error', request_id: meta.requestId },
              choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
            })}\n\n`,
          );
          break;
        }
        const ev = next.value;
        switch (ev.kind) {
          case 'role': {
            await push(chunkJson({ role: ev.role }, null));
            break;
          }
          case 'text': {
            stats.textChars += ev.text.length;
            await push(chunkJson({ content: ev.text }, null));
            break;
          }
          case 'tool_call_delta': {
            const known = toolBuffers.get(ev.index);
            if (!known) toolBuffers.set(ev.index, { id: ev.call.id, name: ev.call.name });
            const delta: Record<string, unknown> = {
              tool_calls: [
                {
                  index: ev.index,
                  ...(ev.call.id ? { id: ev.call.id } : {}),
                  type: 'function',
                  function: {
                    ...(ev.call.name ? { name: ev.call.name } : {}),
                    ...(ev.call.args !== undefined ? { arguments: ev.call.args } : {}),
                  },
                },
              ],
            };
            await push(chunkJson(delta, null));
            break;
          }
          case 'finish': {
            stats.finishReason = ev.finishReason ?? 'stop';
            await push(chunkJson({}, ev.finishReason ?? 'stop'));
            break;
          }
          case 'usage': {
            stats.usage = ev.usage;
            if (controllerRef && !closed) {
              await push(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: fullModel,
                  provider: meta.provider,
                  request_id: meta.requestId,
                  choices: [],
                  usage: ev.usage,
                })}\n\n`,
              );
            }
            break;
          }
          case 'error': {
            stats.errorCode = String(ev.error.code ?? 'internal_error');
            stats.errorMessage = ev.error.message;
            await push(
              `data: ${JSON.stringify({
                error: {
                  message: ev.error.message,
                  code: ev.error.code ?? 'internal_error',
                  type: ev.error.type ?? 'api_error',
                  request_id: meta.requestId,
                },
                choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
              })}\n\n`,
            );
            break;
          }
          default:
            break;
        }
      }
      if (!stats.errorCode && !stats.finishReason) {
        // Upstream ended without an explicit finish event.
        stats.finishReason = 'stop';
        await push(chunkJson({}, 'stop'));
      }
      if (!closed) await push('data: [DONE]\n\n');
    } catch (err) {
      stats.errorCode = stats.errorCode ?? 'internal_error';
      stats.errorMessage = stats.errorMessage ?? (err instanceof Error ? err.message : String(err));
      if (!closed) {
        await push(
          `data: ${JSON.stringify({
            error: { message: 'Upstream stream failed.', code: 'provider_error', type: 'upstream_error', request_id: meta.requestId },
            choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
          })}\n\n`,
        );
        await push('data: [DONE]\n\n');
      }
    } finally {
      onEvent?.(stats);
      if (!closed) {
        closed = true;
        try {
          controllerRef?.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  // Kick off consumption; errors are handled inside run().
  void run();

  return { stream, stats };
}
