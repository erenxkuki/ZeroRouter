/**
 * Runtime origin for user-facing endpoint examples. The same page shows the
 * correct base URL wherever it runs — localhost, a LAN box, or a public
 * deploy — because the origin is read from the browser at runtime, never
 * hardcoded. `api.ts` fetches stay relative, so they already follow the host.
 */
export function getRuntimeOrigin(): string {
  if (typeof window === 'undefined') return 'http://localhost:8787';
  return window.location.origin;
}
