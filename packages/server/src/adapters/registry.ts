/**
 * Adapter registry — the single source of truth for provider adapter types.
 */
import type { Adapter, AdapterCapabilities } from './base.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { OpenRouterAdapter } from './openrouter.js';
import { GenericRestAdapter } from './generic-rest.js';
import { AnthropicAdapter } from './anthropic.js';

const registry = new Map<string, Adapter>();

function register(adapter: Adapter): void {
  registry.set(adapter.id, adapter);
}

register(new OpenAICompatibleAdapter());
register(new OpenRouterAdapter());
register(new AnthropicAdapter());
register(new GenericRestAdapter());

export function getAdapter(id: string): Adapter | null {
  return registry.get(id) ?? null;
}

export function listAdapters(): Adapter[] {
  return [...registry.values()];
}

export function adapterSummaries(): Array<{
  id: string;
  label: string;
  description: string;
  capabilities: AdapterCapabilities;
}> {
  return listAdapters().map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    capabilities: a.capabilities,
  }));
}

/**
 * Load a custom adapter module. SECURITY: only loads explicit, local file paths
 * recorded by a trusted operator (allow list is session-provided). No remote
 * downloads, no code from admin UI bodies, no eval. Each file must export a
 * `default` implementing the Adapter interface.
 */
export async function loadCustomAdapterModule(modulePath: string): Promise<Adapter> {
  const mod = (await import(/* @vite-ignore */ modulePath)) as { default?: unknown };
  const candidate = mod['default'] ?? mod as unknown;
  if (!candidate || typeof candidate !== 'object' || !('id' in (candidate as Adapter))) {
    throw new Error(`Custom adapter module ${modulePath} must export an Adapter as default.`);
  }
  const adapter = candidate as Adapter;
  if (typeof adapter.chat !== 'function' || typeof adapter.validateConfig !== 'function') {
    throw new Error(`Custom adapter module ${modulePath} is missing required adapter methods.`);
  }
  if (registry.has(adapter.id)) {
    throw new Error(`Custom adapter id "${adapter.id}" conflicts with a built-in adapter.`);
  }
  registry.set(adapter.id, adapter);
  return adapter;
}
