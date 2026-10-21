/** Open-redirect prevention for post-login navigation targets. */
import { describe, expect, it } from 'vitest';
import { isSafeInternalPath, normalizeLoginReturn } from './safeRedirect';

describe('isSafeInternalPath', () => {
  it('accepts plain internal paths', () => {
    expect(isSafeInternalPath('/')).toBe(true);
    expect(isSafeInternalPath('/providers')).toBe(true);
    expect(isSafeInternalPath('/console/models')).toBe(true);
    expect(isSafeInternalPath('/logs?status=401')).toBe(true);
    expect(isSafeInternalPath('/aliases#fast-test')).toBe(true);
  });

  it('rejects external and scheme-like targets', () => {
    expect(isSafeInternalPath('http://evil.example')).toBe(false);
    expect(isSafeInternalPath('https://evil.example/path')).toBe(false);
    expect(isSafeInternalPath('javascript:alert(1)')).toBe(false);
    expect(isSafeInternalPath('mailto:owner@example.com')).toBe(false);
  });

  it('rejects protocol-relative and backslash trickery', () => {
    expect(isSafeInternalPath('//evil.example')).toBe(false);
    expect(isSafeInternalPath('/\\evil.example')).toBe(false);
    expect(isSafeInternalPath('/\\')).toBe(false);
    expect(isSafeInternalPath('/%2F%2Fevil.example')).toBe(false);
    expect(isSafeInternalPath('/%5Cevil')).toBe(false);
    expect(isSafeInternalPath('/x/%00https://evil')).toBe(false);
  });

  it('rejects non-paths and hostile types', () => {
    expect(isSafeInternalPath('providers')).toBe(false);
    expect(isSafeInternalPath('')).toBe(false);
    expect(isSafeInternalPath(null)).toBe(false);
    expect(isSafeInternalPath(undefined)).toBe(false);
    expect(isSafeInternalPath(42)).toBe(false);
    expect(isSafeInternalPath({ evil: true })).toBe(false);
    expect(isSafeInternalPath('/' + 'a'.repeat(200))).toBe(false);
  });

  it('normalizeLoginReturn falls back to "/console" for anything unsafe', () => {
    expect(normalizeLoginReturn('/keys')).toBe('/keys');
    expect(normalizeLoginReturn('/console/providers')).toBe('/console/providers');
    expect(normalizeLoginReturn('//evil.example')).toBe('/console');
    expect(normalizeLoginReturn('https://evil.example')).toBe('/console');
    expect(normalizeLoginReturn(null)).toBe('/console');
  });
});
