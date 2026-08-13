#!/usr/bin/env node
/**
 * Local runner for the maxx tally server — node http wrapping the handler with a
 * file-backed store. For dev/test and as the reference the Netlify function
 * mirrors. Production wraps the same handler with createBlobStore instead.
 *
 *   node server/serve.mjs [--port 8787] [--dir <state dir>]
 *   PORT / MAXX_STATE_DIR env also honored.
 */
import http from "node:http";
import path from "node:path";
import { homedir } from "node:os";
import { createHandler } from "./handler.mjs";
import { createFileStore } from "./store.mjs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const port = Number(arg("--port", process.env.PORT || 8787));
const dir = arg("--dir", process.env.MAXX_STATE_DIR || path.join(homedir(), ".maxx", "tally"));

// Auth: signup-minted secrets live in the store (_auth.json). MAXX_SECRET_<HANDLE>
// env is a per-user override; MAXX_SECRET (shared) gates unclaimed handles when set.
//
// This is the entrypoint the PUBLIC deploy runs (api.meetmaxx.co, via the maxx-tally unit),
// not just a dev server — so "nothing set = open" is not an acceptable default here. Bind to
// localhost with MAXX_OPEN=1 for dev; anything reachable keeps unclaimed handles closed, so a
// name nobody has signed up for cannot be filled with usage that was never theirs.
const secretFor = async (h) =>
  process.env[`MAXX_SECRET_${String(h).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] || null;
const handler = createHandler({
  store: createFileStore(dir),
  secretFor,
  fallbackSecret: process.env.MAXX_SECRET || null,
  allowUnconfigured: process.env.MAXX_OPEN === "1",
});

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  const out = await handler({ method: req.method, url: req.url, headers: req.headers, body });
  // access log (journalctl): who hit what — for MCP, which tool. Never bodies/secrets.
  let tool = "";
  if (req.url.startsWith("/mcp")) {
    try { const r = JSON.parse(body); tool = ` ${r.method}${r.params?.name ? `:${r.params.name}` : ""}`; } catch {}
  }
  console.log(`${new Date().toISOString()} ${req.method} ${req.url.replace(/([?&]k=)[^&]+/, "$1***")}${tool} → ${out.status}`);
  res.writeHead(out.status, out.headers || {});
  res.end(out.body || "");
});
server.listen(port, () => console.log(`maxx tally on http://localhost:${port}  (state: ${dir})`));

// transition webhooks fire on ingest, but refills happen on the CLOCK while
// idle — sweep every 30s so over→ok reaches consumers within a minute.
setInterval(() => handler.sweepTransitions?.().catch?.(() => {}), 30_000);
