/**
 * Vercel serverless function — the whole ZeroRouter API in one handler.
 *
 * `vercel.json` routes /v1/*, /admin/* and /healthz here; everything else is
 * served statically from packages/web/dist (the SPA). The heavy runtime lives
 * in packages/server (built by `npm run build`); this file only caches the
 * boot promise so each warm instance pays it once.
 *
 * Streams (SSE pass-through) work as-is; note the platform cap: 60 s on the
 * Hobby plan — set in vercel.json → functions.maxDuration. See
 * docs/vercel-deploy.md for the full runbook.
 */
import { createVercelHandler } from '../packages/server/dist/serverless.js';

type Handler = (req: Request) => Promise<Response>;

let booting: Promise<Handler> | null = null;
function getHandler(): Promise<Handler> {
  booting ??= createVercelHandler().then((rt) => {
    void rt.ready; // maintenance sweep — best-effort, off the request path
    return rt.handle;
  });
  return booting;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const handle = await getHandler();
    return await handle(req);
  } catch (err) {
    // Boot/misconfiguration failure: return the gateway's error envelope so
    // callers (and the dashboard) see a readable message, not a 500 page.
    const message = err instanceof Error ? err.message.replaceAll('\n', ' ') : String(err);
    return Response.json(
      { error: { message, code: 'boot_error', type: 'server_error' } },
      { status: 500 },
    );
  }
}
