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

let booting: Promise<Handler> | null = null;
function boot(): Promise<Handler> {
  if (booting === null) {
    booting = (import('../packages/server/dist/serverless.js') as unknown as Promise<ServerlessModule>)
      .then((mod) => mod.createVercelHandler())
      .then((rt) => {
        void rt.ready; // retention sweep — best-effort, off the request path
        return rt.handle;
      })
      .catch((err: unknown) => {
        booting = null; // failed cold start must not poison the module cache
        throw err;
      });
  }
  return booting;
}

export default async function handler(req: Request): Promise<Response> {
  try {
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
