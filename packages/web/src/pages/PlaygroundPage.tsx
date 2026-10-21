/**
 * Playground: sends UnifiedChatRequests to /admin/playground/chat (session-
 * authed) and renders streaming SSE deltas live. The wire format is the same
 * OpenAI-compatible chunk stream the /v1 gateway emits, including mid-stream
 * error chunks with finish_reason "error".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Send, Square, Terminal } from 'lucide-react';
import { api, ApiClientError, type ProviderApi } from '../api';
import { Badge, ErrorNote, Field, Panel, Spinner, Toggle } from '../ui';

interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface RunMeta {
  requestId: string | null;
  providerModel: string | null;
}

interface RunUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface RunState {
  phase: 'pending' | 'done' | 'aborted' | 'error';
  text: string;
  meta: RunMeta;
  finishReason: string | null;
  usage: RunUsage | null;
  errorText: string | null;
}

interface RunResult extends RunState {
  ms: number | null;
}

interface Turn {
  id: number;
  kind: 'user' | 'assistant';
  /** user turns */
  text?: string;
  /** assistant turns */
  result?: RunResult;
}

interface ModelChoice {
  key: string; // provider/model — the gateway model address
  streaming: boolean | null;
}

const ELLIPSIS = '—';

/** Extracts complete `\n\n`-terminated SSE frames; returns the remainder. */
function parseSseFrames(buf: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buf;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    frames.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
  }
  return { frames, rest };
}

interface WireChunk {
  error?: { message?: string; code?: string };
  model?: string;
  request_id?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: RunUsage | null;
}

export function PlaygroundPage() {
  const [providers, setProviders] = useState<ProviderApi[]>([]);
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [modelKey, setModelKey] = useState('');
  const [stream, setStream] = useState(true);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [pageError, setPageError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextTurnId = useRef(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .providers()
      .then((r) => setProviders(r.providers))
      .catch((e: unknown) => setPageError(e));
  }, []);

  useEffect(() => {
    const enabled = providers.filter((p) => p.enabled);
    if (enabled.length === 0) {
      setModelChoices([]);
      return;
    }
    let cancelled = false;
    const all: ModelChoice[] = [];
    Promise.all(
      enabled.map((p) =>
        api
          .providerModels(p.id)
          .then((r) => {
            for (const m of r.models) {
              // Every registered model is addressable; status is metadata only.
              all.push({ key: `${p.id}/${m.upstream_id}`, streaming: m.streaming ?? null });
            }
          })
          .catch(() => undefined),
      ),
    ).then(() => {
      if (!cancelled) setModelChoices(all.sort((a, b) => a.key.localeCompare(b.key)));
    });
    return () => {
      cancelled = true;
    };
  }, [providers]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  /** Builds the outgoing messages array from completed turns. */
  const buildMessages = (): ChatMsg[] => {
    const msgs: ChatMsg[] = [];
    if (systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt.trim() });
    for (const t of turns) {
      if (t.kind === 'user' && t.text) msgs.push({ role: 'user', content: t.text });
      if (t.kind === 'assistant' && t.result && t.result.text) msgs.push({ role: 'assistant', content: t.result.text });
    }
    return msgs;
  };

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !modelKey) return;
    setPageError(null);
    setBusy(true);
    setInput('');

    const msgs: ChatMsg[] = buildMessages();
    msgs.push({ role: 'user', content: text });

    const params: Record<string, unknown> = {};
    if (temperature.trim()) {
      const n = Number(temperature);
      if (Number.isFinite(n)) params['temperature'] = Math.max(0, Math.min(2, n));
    }
    if (maxTokens.trim()) {
      const n = Number(maxTokens);
      if (Number.isInteger(n) && n >= 1) params['max_tokens'] = n;
    }
    const payload: Record<string, unknown> = {
      model: modelKey,
      messages: msgs,
      stream,
      ...params,
    };

    const userId = nextTurnId.current++;
    const runId = nextTurnId.current++;
    const run: RunResult = { phase: 'pending', text: '', meta: { requestId: null, providerModel: null }, finishReason: null, usage: null, errorText: null, ms: null };
    setTurns((ts) => [...ts, { id: userId, kind: 'user', text }, { id: runId, kind: 'assistant', result: run }]);

    const patch = (p: Partial<RunResult>) =>
      setTurns((ts) => ts.map((t) => (t.kind === 'assistant' && t.id === runId ? { ...t, result: { ...t.result, ...p } as RunResult } : t)));

    const started = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;
    let accumulated = '';
    let meta: RunMeta = { requestId: null, providerModel: null };
    let finishReason: string | null = null;
    let usage: RunUsage | null = null;
    let errorText: string | null = null;

    const applyChunk = (chunk: WireChunk) => {
      if (chunk.error) {
        errorText = `${chunk.error.code ?? 'error'}: ${chunk.error.message ?? 'unknown error'}`;
      }
      if (chunk.request_id) {
        meta = { requestId: chunk.request_id, providerModel: meta.providerModel ?? chunk.model ?? null };
      } else if (chunk.model && !meta.providerModel) {
        meta = { ...meta, providerModel: chunk.model };
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) accumulated += delta;
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      if (chunk.usage) usage = chunk.usage;
    };

    const snapshotPatch = () => {
      patch({
        text: accumulated,
        meta,
        finishReason,
        usage,
        errorText,
        phase: errorText ? 'error' : 'pending',
      });
    };

    try {
      const res = await fetch('/admin/playground/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          accept: stream ? 'text/event-stream' : 'application/json',
          'content-type': 'application/json',
          'x-requested-with': 'zerorouter',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        throw new ApiClientError(res.status, 'request_failed', describeErrorStatus(res.status, raw));
      }

      if (!stream) {
        const shape = JSON.parse(await res.text()) as {
          model?: string;
          request_id?: string;
          choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: RunUsage | null;
        };
        accumulated = shape.choices?.[0]?.message?.content ?? '';
        finishReason = shape.choices?.[0]?.finish_reason ?? null;
        usage = shape.usage ?? null;
        meta = { requestId: shape.request_id ?? null, providerModel: shape.model ?? null };
      } else {
        if (res.body === null) throw new Error('Streaming response has no body.');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseFrames(buf);
          buf = rest;
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (data === '[DONE]') continue;
              try {
                applyChunk(JSON.parse(data) as WireChunk);
              } catch {
                /* ignore malformed frame */
              }
            }
          }
          snapshotPatch();
        }
        if (buf.trim() && !errorText) {
          for (const line of buf.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:') && trimmed.slice(5).trim() !== '[DONE]') {
              try {
                applyChunk(JSON.parse(trimmed.slice(5).trim()) as WireChunk);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }

      patch({
        phase: errorText ? 'error' : 'done',
        text: accumulated,
        meta,
        finishReason,
        usage,
        errorText,
        ms: Date.now() - started,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        patch({ phase: 'aborted', text: accumulated, meta, finishReason, usage, errorText, ms: Date.now() - started });
      } else {
        setPageError(err);
        patch({ phase: 'error', text: accumulated, meta, finishReason, usage, errorText: err instanceof Error ? err.message : String(err), ms: Date.now() - started });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [input, busy, modelKey, stream, systemPrompt, temperature, maxTokens, turns]);

  const abort = () => abortRef.current?.abort();

  const reset = () => {
    if (busy) return;
    setTurns([]);
    setPageError(null);
  };

  const modelOptions = (
    <>
      <option value="">— select a model —</option>
      {modelChoices.map((m) => (
        <option key={m.key} value={m.key}>
          {m.key}
          {m.streaming === false ? ' (non-stream)' : ''}
        </option>
      ))}
    </>
  );

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
      <div className="space-y-4">
        <Panel
          title={
            <span className="flex items-center gap-2">
              <Terminal size={15} className="text-amber" /> Controls
            </span>
          }
        >
          <div className="space-y-3">
            <Field label="Model" hint="Served as provider/model."
            >
              <select id="playground-model" className="zr-select" value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
                {modelOptions}
              </select>
            </Field>
            <Toggle checked={stream} onChange={setStream} label="Stream (SSE)" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Temperature">
                <input
                  className="zr-input"
                  inputMode="decimal"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  placeholder={ELLIPSIS}
                  aria-label="Temperature override"
                />
              </Field>
              <Field label="Max tokens">
                <input
                  className="zr-input"
                  inputMode="numeric"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder={ELLIPSIS}
                  aria-label="Max token override"
                />
              </Field>
            </div>
            <Field label="System prompt">
              <textarea
                className="zr-textarea"
                rows={4}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Optional. Sent as the first message of every request."
              />
            </Field>
            <div className="text-[11.5px] text-ink-faint">
              Goes to <span className="font-mono text-ink-dim">POST /admin/playground/chat</span> with your dashboard
              session (CSRF header attached) — gateway keys are never used here.
            </div>
          </div>
        </Panel>
        <Panel title="Notes">
          <ul className="space-y-1.5 text-[12.5px] text-ink-dim">
            <li>• Playground turns are logged to Request logs with source <span className="font-mono">playground</span>.</li>
            <li>• Requests count against the global in-flight cap and the stream event cap.</li>
            <li>• Mid-stream upstream failures surface as <span className="font-mono text-danger">finish_reason: "error"</span> and close the stream.</li>
          </ul>
        </Panel>
      </div>

      <Panel dense className="flex min-h-[calc(100vh-190px)] flex-col">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="zr-label">Transcript</span>
            {modelKey && <span className="font-mono text-[11.5px] text-cyan">{modelKey}</span>}
          </div>
          <div className="flex gap-2">
            <button type="button" className="zr-btn" onClick={reset} disabled={busy || turns.length === 0}>
              <Eraser size={13} /> Clear
            </button>
            {busy ? (
              <button type="button" className="zr-btn zr-btn-danger" onClick={abort} disabled={abortRef.current === null}>
                <Square size={13} /> Stop
              </button>
            ) : (
              <button
                type="button"
                id="playground-send"
                className="zr-btn zr-btn-accent"
                onClick={() => void send()}
                disabled={!input.trim() || !modelKey}
              >
                <Send size={13} /> Send
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={transcriptRef}>
          {pageError !== null && (
            <div className="mb-3">
              <ErrorNote error={pageError} />
            </div>
          )}
          {turns.length === 0 && (
            <div className="py-16 text-center text-[13px] text-ink-faint">
              Pick a model, type a prompt, and Send — replies stream exactly as gateway clients receive them.
            </div>
          )}
          {turns.map((t) =>
            t.kind === 'user' ? (
              <div key={t.id} className="mb-3 rounded-lg border border-hairline-strong bg-panel-raised px-3.5 py-2.5 text-[13.5px] leading-relaxed">
                <div className="zr-label pb-1">user</div>
                <div className="whitespace-pre-wrap break-words text-ink">{t.text}</div>
              </div>
            ) : (
              <div key={t.id} className="mb-3 rounded-lg border border-hairline bg-canvas px-3.5 py-2.5 text-[13.5px] leading-relaxed">
                <div className="flex items-center justify-between pb-1">
                  <div className="zr-label">assistant</div>
                  {t.result?.phase === 'pending' && (
                    <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                      <Spinner /> streaming
                    </span>
                  )}
                </div>
                {t.result && (
                  <>
                    <div className="whitespace-pre-wrap break-words text-ink">
                      {t.result.text || (t.result.phase === 'pending' ? '' : <span className="text-ink-faint">(empty reply)</span>)}
                      {t.result.phase === 'pending' && <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-cyan align-middle" />}
                    </div>
                    {(t.result.phase !== 'pending' || t.result.errorText) && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {t.result.meta.providerModel && <Badge tone="cyan">{t.result.meta.providerModel}</Badge>}
                        {t.result.finishReason && (
                          <Badge tone={t.result.finishReason === 'error' ? 'danger' : 'neutral'}>{t.result.finishReason}</Badge>
                        )}
                        {t.result.usage && (t.result.usage.prompt_tokens !== undefined || t.result.usage.completion_tokens !== undefined) && (
                          <Badge tone="neutral">
                            p {t.result.usage.prompt_tokens ?? ELLIPSIS} · c {t.result.usage.completion_tokens ?? ELLIPSIS}
                          </Badge>
                        )}
                        {t.result.phase === 'aborted' && <Badge tone="warn">aborted by you</Badge>}
                        {t.result.ms !== null && <span className="zr-num text-[11px] text-ink-faint">{t.result.ms} ms</span>}
                      </div>
                    )}
                    {t.result.errorText && (
                      <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[12px] break-words text-danger">
                        {t.result.errorText}
                      </div>
                    )}
                  </>
                )}
              </div>
            ),
          )}
        </div>

        <div className="border-t border-hairline p-3">
          <textarea
            id="playground-input"
            className="zr-textarea"
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={busy ? 'Streaming… you can Stop or keep typing.' : 'Prompt the gateway. Ctrl+Enter sends.'}
            disabled={false}
          />
          <div className="flex items-center justify-between pt-2">
            <span className="zr-label">
              {turns.filter((t) => t.kind === 'user').length} turn(s) in context · system prompt counts first
            </span>
            <span className="zr-label">ctrl+enter to send</span>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function describeErrorStatus(status: number, raw: string): string {
  try {
    const env = JSON.parse(raw) as { error?: { message?: string; code?: string } };
    if (env.error?.message) return `${env.error.code ?? 'error'}: ${env.error.message}`;
  } catch {
    /* fall through */
  }
  return `Request failed (${status}).`;
}
