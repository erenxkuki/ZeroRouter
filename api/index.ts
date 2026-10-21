/**
 * Vercel serverless function — the whole ZeroRouter API in one handler.
 *
 * `vercel.json` routes /v1/*, /admin/* and /healthz here; everything else is
 * served statically from packages/web/dist (the SPA). The heavy runtime lives
 * in packages/server (built by `npm run build` as ES modules) and is loaded
 * with a native `import()` — deliberately NOT a static import, because hosts
 * that compile this file to CommonJS must not issue `require()` of ESM
 * (unsupported there). Native dynamic import is available in all CommonJS
 * modules, so the handler works in both ESM and CJS output formats.
 *
 * Cold-start gate: while the runtime is still connecting (DB boot), /healthz
 * answers immediately with a `booting` status instead of stalling to the
 * platform timeout — the dashboard then shows "checking/offline" honestly and
 * deployment-level 504s disappear for the one request shape that has no DB
 * dependency.
 *
 * Streams (SSE pass-through) work as-is; note the platform cap: 60 s on the
 * Hobby plan. See docs/vercel-deploy.md for the full runbook.
 */
type Handler = (req: Request) => Promise<Response>;
interface ServerlessModule {
  createVercelHandler: (env?: NodeJS.ProcessEnv) => Promise<{
    ready: Promise<void>;
    handle: Handler;
  }>;
}

console.log('[ZeroRouter] serverless API loaded');
const startedAt = Date.now();
let booting: Promise<Handler> | null = null;
let booted = false;
let lastBootError: string | null = null;

function boot(): Promise<Handler> {
  if (booting === null) {
    lastBootError = null;
    booting = (import('../packages/server/dist/serverless.js') as unknown as Promise<ServerlessModule>)
      .then((mod) => mod.createVercelHandler())
      .then((rt) => {
        void rt.ready; // retention sweep — best-effort, off the request path
        booted = true;
        return rt.handle;
      })
      .catch((err: unknown) => {
        lastBootError = err instanceof Error ? err.message.replaceAll('\n', ' ') : String(err);
        booting = null; // failed cold start must not poison the module cache
        throw err;
      });
  }
  return booting;
}

/** Fast, dependency-free status for /healthz while the DB boot is in flight. */
function bootStatus(): Response {
  if (lastBootError !== null) {
    return Response.json(
      { ok: false, service: 'zerorouter', booting: true, error: lastBootError, startedAt, now: Date.now() },
      { status: 500 },
    );
  }
  return Response.json(
    { ok: true, service: 'zerorouter', booting: true, startedAt, now: Date.now() },
  );
}

export default async function handler(req: Request): Promise<Response> {
  try {
    if (!booted) {
      void boot(); // start/stick the shared boot on the first request
      const url = new URL(req.url);
      if (url.pathname === '/healthz' || url.pathname === '/') return bootStatus();
    }
    const handle = await boot();
    return await handle(req);
  } catch (err) {
    // Boot/misconfiguration failure: return the gateway's error envelope so
    // callers (and the dashboard) see a readable message, not a raw 500 page.
    const message = err instanceof Error ? err.message.replaceAll('\n', ' ') : String(err);
    return Response.json(
      { error: { message, code: 'boot_error', type: 'server_error' } },
      { status: 500 },
    );
  }
}
