/**
 * Post-login redirect validation (open-redirect prevention).
 * Only same-app relative paths are accepted as login return targets; anything
 * ambiguous (scheme-likes, protocol-relative "//", backslash tricks, control
 * characters, embedded colons or their encoded variants) falls back to the
 * console root (/console — the dashboard now lives there; "/" is the public
 * landing).
 */
export function isSafeInternalPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 128) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  if (value.includes('\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  // Percent-encoded variants must not smuggle scheme-like or protocol-relative
  // forms past the checks above; colons/control chars are rejected outright.
  try {
    const decoded = decodeURIComponent(value);
    if (/[\0-\x1f\x7f]/.test(decoded)) return false;
    if (decoded.includes('\\') || decoded.includes(':')) return false;
    if (decoded.startsWith('//') || decoded.includes('//')) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return false;
  } catch {
    return false; // malformed percent-encoding is never a safe target
  }
  return true;
}

/** Returns a validated internal path, or the console root. */
export function normalizeLoginReturn(value: unknown): string {
  return isSafeInternalPath(value) ? value : '/console';
}
