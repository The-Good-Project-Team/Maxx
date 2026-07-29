// The tally's whole promise is "every machine, one live tally" — which means the normal
// case is several surfaces POSTing at the same moment. Every mutating path is
// load → mutate → save with an await in the middle, so without serialization the second
// save overwrites the first one's events and the ledger under-counts silently. Silent is
// the problem: the budget still looks authoritative, it is just wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHandler } from "./handler.mjs";
import { createMemoryStore, createFileStore } from "./store.mjs";

// A store whose load/save straddle a real tick, so the interleaving is deterministic
// instead of a race we might win by luck on a fast machine.
function slowStore(inner, delayMs = 5) {
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    ...inner,
    async load(h) { const v = await inner.load(h); await wait(); return v; },
    async save(h, s) { await wait(); return inner.save(h, s); },
  };
}

const envelope = (surface, id) => JSON.stringify({
  v: 1, surface, handle: "acme", cursor: `c-${id}`,
  emitted_at: new Date(1_800_000_000_000).toISOString(),
  sessions: [{ root: `sess-${id}`, name: `run ${id}`, billed: 1000, last_ts: new Date(1_800_000_000_000).toISOString() }],
});

async function postConcurrently(handler, n) {
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      handler({
        method: "POST", url: "/api/u/acme/logs",
        headers: { authorization: "Bearer k" }, body: envelope(`laptop:m${i}`, i),
      })),
  );
}

test("concurrent emits from several surfaces all land — none is silently overwritten", async () => {
  const store = slowStore(createMemoryStore());
  await store.setSecret("acme", "k");
  const handler = createHandler({ store, now: () => 1_800_000_000 });

  const N = 8;
  const res = await postConcurrently(handler, N);
  assert.ok(res.every((r) => r.status === 200), "every emit was accepted");

  const s = await store.load("acme");
  assert.equal(s.events.length, N,
    `all ${N} emits must survive — got ${s.events.length}, so ${N - s.events.length} surfaces' burn vanished`);
  const surfaces = new Set(s.events.map((e) => e.surface));
  assert.equal(surfaces.size, N, "each surface is represented exactly once");
});

test("a concurrent read never sees a half-applied write", async () => {
  const store = slowStore(createMemoryStore());
  await store.setSecret("acme", "k");
  const handler = createHandler({ store, now: () => 1_800_000_000 });

  // budget reads interleaved with emits must never observe a torn store
  const mixed = await Promise.all([
    ...Array.from({ length: 4 }, (_, i) =>
      handler({ method: "POST", url: "/api/u/acme/logs", headers: { authorization: "Bearer k" }, body: envelope(`laptop:m${i}`, i) })),
    ...Array.from({ length: 4 }, () =>
      handler({ method: "GET", url: "/api/u/acme/budget", headers: { authorization: "Bearer k" } })),
  ]);
  assert.ok(mixed.every((r) => r.status === 200), "no request errored under interleaving");
  assert.equal((await store.load("acme")).events.length, 4, "reads must not cost writes");
});

test("different handles do not block each other", async () => {
  const store = slowStore(createMemoryStore(), 20);
  await store.setSecret("a", "k");
  await store.setSecret("b", "k");
  const handler = createHandler({ store, now: () => 1_800_000_000 });
  const post = (h) => handler({
    method: "POST", url: `/api/u/${h}/logs`, headers: { authorization: "Bearer k" },
    body: envelope("laptop:x", h).replace('"handle":"acme"', `"handle":"${h}"`),
  });
  const t0 = Date.now();
  await Promise.all([post("a"), post("b")]);
  // serialized would be ~2x a single round trip (4 waits); parallel stays near 1x
  assert.ok(Date.now() - t0 < 150, "one customer's write must not queue behind another's");
});

// A truncated store doc is worse than a lost event: the handle's entire history reads as
// corrupt and computeBudget falls back to an empty ledger.
test("saves are atomic — no truncated doc is ever visible under the real name", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "maxx-store-"));
  const store = createFileStore(dir);
  const big = { ...(await store.load("acme")), events: Array.from({ length: 5000 }, (_, i) => ({ surface: "laptop:a", root: `r${i}`, ts: i, billed: 1 })) };
  await store.save("acme", big);
  const p = path.join(dir, "acme.json");
  const first = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(first.events.length, 5000);

  // A rename REPLACES the file, so the inode changes; a plain writeFileSync truncates and
  // refills the same inode — which is the window where a crash leaves a half-written doc.
  // The inode is the only observable difference between the two without killing the process.
  const inoBefore = statSync(p).ino;
  await store.save("acme", { ...big, events: big.events.slice(0, 10) });
  assert.notEqual(statSync(p).ino, inoBefore,
    "save truncated the live file in place — a crash mid-write would leave the ledger corrupt");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).events.length, 10, "the rename swapped in a complete doc");
  assert.ok(!readdirSync(dir).some((f) => f.includes(".tmp-")), "no temp file left behind");
});
