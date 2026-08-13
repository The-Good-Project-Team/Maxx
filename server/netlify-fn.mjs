/**
 * Netlify Function wrapper for the maxx tally server — the production deploy.
 *
 * PLACEMENT: copy (or symlink) this to the meetmaxx.co site's functions dir
 * (e.g. netlify/functions/maxx.mjs) alongside server/handler.mjs, server/tally.mjs,
 * server/store.mjs — or adjust the imports to wherever they live. Requires the
 * @netlify/blobs package (bundled on Netlify) for durable per-handle storage.
 *
 * Routes (via the config.path below):
 *   POST /api/u/:handle/logs     GET /api/u/:handle/budget     POST /mcp     GET /health
 *
 * Secrets: set MAXX_SECRET (shared) or MAXX_SECRET_<handle> (per-user) in the
 * Netlify env. If none is set for a handle, that handle is open (dev only).
 */
import { getStore } from "@netlify/blobs";
import { createHandler } from "../../server/handler.mjs"; // adjust to actual relative path
import { createBlobStore } from "../../server/store.mjs";

const handler = createHandler({
  store: createBlobStore(getStore("maxx-tally")),
  secretFor: async (h) =>
    process.env[`MAXX_SECRET_${h.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] ||
    process.env.MAXX_SECRET ||
    null,
  // A handle with no secret configured anywhere stays CLOSED on the public deploy: an
  // unclaimed name must not accept writes from strangers just because nobody set MAXX_SECRET.
  // Signed-up handles carry their own secret in the store and are unaffected.
  allowUnconfigured: false,
});

export default async (req) => {
  const u = new URL(req.url);
  const body = req.method === "POST" || req.method === "PUT" ? await req.text() : "";
  const out = await handler({
    method: req.method,
    url: u.pathname + u.search,
    headers: Object.fromEntries(req.headers),
    body,
  });
  return new Response(out.body || "", { status: out.status, headers: out.headers || {} });
};

export const config = {
  path: ["/api/u/:handle/logs", "/api/u/:handle/budget", "/mcp", "/health"],
};
