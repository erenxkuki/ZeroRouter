/** Shared small utilities for adapters. */

/** Safely joins a provider base URL and an absolute path. Throws on bad path. */
export function urlPathJoin(base: string, pathName: string): string {
  if (typeof pathName !== 'string' || !pathName.startsWith('/')) {
    throw new Error(`Path must be absolute (starting with "/"): ${String(pathName)}`);
  }
  return `${base.replace(/\/+$/, '')}${pathName}`;
}

/** Builds a URL that includes a path and query params, validated minimally. */
export function urlWithQuery(base: string, pathName: string, params: Record<string, string>): string {
  const url = new URL(urlPathJoin(base, pathName));
  for (const [key, value] of Object.entries(params)) {
    if (value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

export function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) {
    const n = Number.parseInt(v, 10);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

export function limitText(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
