import { describe, expect, it } from 'vitest';
import {
  ALIAS_RE,
  AliasUpsertSchema,
  ApiKeyCreateSchema,
  ManualModelUpsertSchema,
  ProviderUpsertSchema,
  UnifiedChatRequestSchema,
} from '../types.js';

describe('UnifiedChatRequestSchema', () => {
  const baseMsg = { role: 'user', content: 'hi' };

  it('accepts a minimal valid request', () => {
    const r = UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg] });
    expect(r.success).toBe(true);
  });

  it('accepts OpenAI-style extras (tools, tool_choice, parallel extras tolerated via unknown keys stripped)', () => {
    const parsed = UnifiedChatRequestSchema.safeParse({
      model: 'p/m',
      messages: [baseMsg],
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 128,
      stop: ['END'],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
      user: 'u1',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects missing model / empty messages', () => {
    expect(UnifiedChatRequestSchema.safeParse({ messages: [baseMsg] }).success).toBe(false);
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [] }).success).toBe(false);
    expect(UnifiedChatRequestSchema.safeParse({ model: '', messages: [baseMsg] }).success).toBe(false);
  });

  it('rejects malformed tools and tool_choice', () => {
    expect(
      UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg], tools: [{ type: 'web_search' }] }).success,
    ).toBe(false);
    expect(
      UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg], tool_choice: { function: {} } }).success,
    ).toBe(false);
    expect(
      UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg], tools: Array(65).fill(null).map(() => ({ type: 'function', function: { name: 'x' } })) }).success,
    ).toBe(false);
  });

  it('bounds messages and content sizes', () => {
    const msg = { role: 'user', content: 'x'.repeat(801_000) };
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [msg] }).success).toBe(false);
    expect(
      UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: Array(257).fill(baseMsg) }).success,
    ).toBe(false);
  });

  it('accepts multimodal text/image parts and rejects unknown part types', () => {
    const multimodal = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    };
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [multimodal] }).success).toBe(true);
    expect(
      UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [{ role: 'user', content: [{ type: 'audio', source: 'x' }] }] }).success,
    ).toBe(false);
  });

  it('validates numeric ranges for sampling params', () => {
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg], temperature: 2.5 }).success).toBe(false);
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg], top_p: 1.5 }).success).toBe(false);
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg], max_tokens: 0 }).success).toBe(false);
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg], temperature: -0.1 }).success).toBe(false);
  });

  it('requires stream to be boolean, not string', () => {
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg], stream: 'true' }).success).toBe(false);
  });

  it('constraint chain: assistant tool_calls follow the schema', () => {
    const assistantToolCall = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lima"}' } }],
    };
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [baseMsg, assistantToolCall] }).success).toBe(true);
    const bad = { ...assistantToolCall, tool_calls: [{ id: 'call_2', type: 'wrong', function: { name: 'x', arguments: '{}' } }] };
    expect(UnifiedChatRequestSchema.safeParse({ model: 'p/m', messages: [bad] }).success).toBe(false);
  });
});

describe('AliasUpsertSchema', () => {
  it('accepts full shape with fallbacks and params', () => {
    const r = AliasUpsertSchema.safeParse({
      alias: 'fast',
      provider_id: 'p1',
      model: 'm1',
      enabled: true,
      params: { temperature: 0.2, max_tokens: 50 },
      fallbacks: [{ provider_id: 'p2', model: 'm2' }],
      notes: 'note',
    });
    expect(r.success).toBe(true);
  });

  it('enforces the alias name pattern (no slash, sane charset)', () => {
    expect(ALIAS_RE.test('good.alias_1')).toBe(true);
    expect(ALIAS_RE.test('a')).toBe(false);
    expect(ALIAS_RE.test('has/slash')).toBe(false);
    expect(ALIAS_RE.test('.startsdot')).toBe(false);
    expect(ALIAS_RE.test('has space')).toBe(false);
    expect(AliasUpsertSchema.safeParse({ alias: 'has/slash', provider_id: 'p', model: 'm' }).success).toBe(false);
  });

  it('strips unknown param keys (alias params drive sampling only)', () => {
    const r1 = AliasUpsertSchema.parse({ alias: 'x1', provider_id: 'p', model: 'm', params: { unknown_key: 'v' } });
    expect(r1.params).not.toHaveProperty('unknown_key');
  });

  it('caps fallbacks and validates stop shapes', () => {
    const fallbacks = Array(5).fill(null).map((_, i) => ({ provider_id: `p${i}`, model: 'm' }));
    expect(AliasUpsertSchema.safeParse({ alias: 'x2', provider_id: 'p', model: 'm', fallbacks }).success).toBe(false);
    expect(AliasUpsertSchema.safeParse({ alias: 'x2', provider_id: 'p', model: 'm', fallbacks: fallbacks.slice(0, 4) }).success).toBe(true);
    expect(
      AliasUpsertSchema.safeParse({ alias: 'x2', provider_id: 'p', model: 'm', params: { stop: ['a', 'b'] } }).success,
    ).toBe(true);
    expect(
      AliasUpsertSchema.safeParse({ alias: 'x2', provider_id: 'p', model: 'm', params: { stop: Array(5).fill('a') } }).success,
    ).toBe(false);
  });
});

describe('ApiKeyCreateSchema', () => {
  it('accepts label + optional expiry', () => {
    expect(ApiKeyCreateSchema.safeParse({ label: 'ci-bot' }).success).toBe(true);
    expect(ApiKeyCreateSchema.safeParse({ label: 'ci-bot', expires_in_days: 30 }).success).toBe(true);
    expect(ApiKeyCreateSchema.safeParse({ label: 'ci-bot', expires_in_days: null }).success).toBe(true);
  });

  it('rejects absurd expiry and empty labels', () => {
    expect(ApiKeyCreateSchema.safeParse({ label: 'x', expires_in_days: 0 }).success).toBe(false);
    expect(ApiKeyCreateSchema.safeParse({ label: 'x', expires_in_days: 731 }).success).toBe(false);
    expect(ApiKeyCreateSchema.safeParse({ label: '' }).success).toBe(false);
  });
});

describe('ProviderUpsertSchema', () => {
  it('accepts and normalizes a full provider', () => {
    const parsed = ProviderUpsertSchema.parse({
      id: 'my-provider',
      name: 'My Provider',
      adapter: 'openai-compatible',
      base_url: 'http://127.0.0.1:8000',
      auth_type: 'bearer',
      api_key: 'sk-test',
      config: { allow_insecure_private_http: true },
      timeout_ms: 30000,
      retry_max: 1,
    });
    expect(parsed.enabled).toBe(true); // default
    expect(parsed.auth_type).toBe('bearer');
    expect(parsed.id).toBe('my-provider');
  });

  it('enforces the provider slug', () => {
    expect(ProviderUpsertSchema.safeParse({ name: 'X', adapter: 'openai-compatible', id: 'Bad%' }).success).toBe(false);
    expect(ProviderUpsertSchema.safeParse({ name: 'X', adapter: 'openai-compatible', id: 'ok-ok' }).success).toBe(true);
  });

  it('rejects unknown auth types and bad header names', () => {
    expect(ProviderUpsertSchema.safeParse({ name: 'X', adapter: 'a', auth_type: 'magic' }).success).toBe(false);
    expect(ProviderUpsertSchema.safeParse({ name: 'X', adapter: 'a', auth_header: '_bad header!' }).success).toBe(false);
  });

  it('rejects out-of-range timeouts', () => {
    expect(ProviderUpsertSchema.safeParse({ name: 'X', adapter: 'a', timeout_ms: 999 }).success).toBe(false);
    expect(ProviderUpsertSchema.safeParse({ name: 'X', adapter: 'a', timeout_ms: 700_000 }).success).toBe(false);
  });

  it('never leaks api_key into non-credential fields', () => {
    const parsed = ProviderUpsertSchema.parse({ name: 'X', adapter: 'a', api_key: 'sk-live-secret' });
    expect(Object.keys(parsed)).not.toContain('credentials');
    expect((parsed as unknown as Record<string, unknown>)['api_key']).toBe('sk-live-secret');
  });
});

describe('ManualModelUpsertSchema', () => {
  it('accepts a full manual model and bounds values', () => {
    expect(
      ManualModelUpsertSchema.safeParse({
        upstream_id: 'llama3',
        display_name: 'Llama 3',
        context_length: 8192,
        input_modalities: ['text'],
        output_modalities: ['text'],
        streaming: true,
        tools: false,
        pricing: { prompt_per_token: '0.000001', completion_per_token: '0.000002' },
      }).success,
    ).toBe(true);
    expect(ManualModelUpsertSchema.safeParse({ upstream_id: '', display_name: 'x' }).success).toBe(false);
    expect(ManualModelUpsertSchema.safeParse({ upstream_id: 'x', context_length: 0 }).success).toBe(false);
    expect(ManualModelUpsertSchema.safeParse({ upstream_id: 'x', input_modalities: ['smell'] }).success).toBe(false);
  });
});
