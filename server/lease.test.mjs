// Reservation leases guard fan-outs: a lease held by one dispatcher must subtract from
// what every OTHER dispatcher is allowed to grab — across transports, concurrently, and
// it must give the hold back the moment the fan-out lands. These tests pin the ways that
// contract can silently break while the budget still looks authoritative.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { createMemoryStore } from "./store.mjs";

const T = 1_800_000_000, H = 3600;

// Deterministic interleaving: load/save straddle a real tick, so a lost-update race is
// forced instead of hoped for (same trick as concurrency.test.mjs). load() also CLONES:
// the memory store hands every caller the same live object, which quietly makes
// concurrent readers see each other's unsaved writes — file and Netlify-Blobs stores
// (production) parse fresh JSON per load, so each request gets its own snapshot.
function slowStore(inner, delayMs = 5) {
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    ...inner,
    async load(h) { const v = await inner.load(h); await wait(); return structuredClone(v); },
    async save(h, s) { await wait(); return inner.save(h, s); },
  };
}

// A healthy, freshly-anchored account. Reserves are PERCENT OF THE WEEK: 5% used with 16.8
// five-hour blocks left to the reset ⇒ each block may spend ~5.6% of the week, and this block
// has barely touched it, so that is the allowance a fan-out reserves against.
async function seededStore() {
  const store = slowStore(createMemoryStore());
  await store.setSecret("acme", "k");
  const s = await store.load("acme");
  // most of the burn is EARLIER in the week, outside this 5h block — otherwise the block has
  // already spent its own share and there is nothing left to reserve against
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 50e6 });
  s.events.push({ surface: "laptop:a", root: "r2", ts: T - 600, billed: 1e6 });
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.05, five_reset: T + 4 * H, week_reset: T + 3.5 * 86400 });
  await store.save("acme", s);
  return store;
}

const mcpReserve = (args, id = 1) => ({
  method: "POST", url: "/mcp", headers: { authorization: "Bearer k" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "maxx_reserve", arguments: args } }),
});
const mcpRelease = (args, id = 1) => ({
  method: "POST", url: "/mcp", headers: { authorization: "Bearer k" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "maxx_release", arguments: args } }),
});
const mcpResult = (r) => JSON.parse(JSON.parse(r.body).result.content[0].text);

const httpReserve = (body) => ({
  method: "POST", url: "/api/u/acme/reserve", headers: { authorization: "Bearer k" }, body: JSON.stringify(body),
});

test("concurrent reserves through the MCP body-handle path cannot double-grant", async () => {
  const store = await seededStore();
  const handler = createHandler({ store, now: () => T });
  // Two dispatchers each want 4% of a ~5.6% allowance: only ONE grant can be honest.
  // One arrives over MCP with the handle ONLY in the JSON-RPC body, the other over HTTP —
  // the body-handle transport used to lock on "_mcp" instead of the handle, so the two
  // requests held DIFFERENT locks, both read the pre-write doc, and both granted.
  const res = await Promise.all([
    handler(mcpReserve({ handle: "acme", pct: 4, label: "fleet-a" })),
    handler(httpReserve({ pct: 4, label: "fleet-b" })),
  ]);
  const grants = [mcpResult(res[0]), JSON.parse(res[1].body)].filter((r) => r.granted);
  assert.equal(grants.length, 1,
    `a ~5.6% allowance granted ${grants.length} × 4% leases — concurrent dispatchers double-spent the same share`);
});

test("renew (reserve with your own lease_id) replaces the lease instead of stacking", async () => {
  const store = await seededStore();
  const handler = createHandler({ store, now: () => T });
  const first = mcpResult(await handler(mcpReserve({ handle: "acme", pct: 3 })));
  assert.ok(first.granted);
  // 3% held of ~5.5% leaves ~2.5% — a fresh 3% reserve must fail, a RENEW must not.
  const stacked = mcpResult(await handler(mcpReserve({ handle: "acme", pct: 3 }, 2)));
  assert.ok(!stacked.granted, "without renew the second 30M must not fit next to the first");
  const renewed = mcpResult(await handler(mcpReserve({ handle: "acme", pct: 3, lease_id: first.lease_id }, 3)));
  assert.ok(renewed.granted, "renewing my own 30M lease must succeed — the old hold doesn't count against me");
  assert.equal((await store.load("acme")).leases.length, 1, "renew must leave exactly one lease, not stack two");
});

test("maxx_release returns the held percent to everyone else's allowance immediately", async () => {
  const store = await seededStore();
  const handler = createHandler({ store, now: () => T });
  const g = mcpResult(await handler(mcpReserve({ handle: "acme", pct: 3 })));
  assert.ok(g.granted);
  const budget = async () => JSON.parse((await handler({
    method: "GET", url: "/api/u/acme/budget", headers: { authorization: "Bearer k" },
  })).body);
  const held = await budget();
  assert.equal(held.reserved_pct, 3);
  const rel = mcpResult(await handler(mcpRelease({ handle: "acme", lease_id: g.lease_id }, 2)));
  assert.equal(rel.released, 1);
  const freed = await budget();
  assert.equal(freed.reserved_pct, 0, "released hold must stop subtracting at once, not at TTL");
  // the allowance every OTHER dispatcher computes (share − used − reserved) recovers the hold
  const avail = (b) => b.block_share_pct - b.block_used_pct - b.reserved_pct;
  assert.ok(avail(freed) > avail(held), "the released percent must return to the allowance");
  assert.equal(Math.round((avail(freed) - avail(held)) * 10) / 10, 3, "and it is exactly the 3% held");
  // idempotent: releasing again is a no-op, not an error
  const again = mcpResult(await handler(mcpRelease({ handle: "acme", lease_id: g.lease_id }, 3)));
  assert.equal(again.released, 0);
});

test("lease count is bounded — a retry loop cannot grow the doc without limit", async () => {
  const store = await seededStore();
  const handler = createHandler({ store, now: () => T });
  const s = await store.load("acme");
  s.leases = Array.from({ length: 100 }, (_, i) => ({ id: `l${i}`, pct: 0.01, expires: T + 3600, label: null }));
  await store.save("acme", s);
  const r = JSON.parse((await handler(httpReserve({ pct: 1 }))).body);
  assert.ok(!r.granted, "the 101st lease must be refused");
  assert.match(r.error || "", /too many active leases/);
});
