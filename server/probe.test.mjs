// Pull-on-miss anchor: when the laptop stops PUSHING an anchor, the server PULLS one
// from Anthropic's ratelimit headers rather than letting the whole fleet read stale.
// Costs ~1 token and must NEVER fire while the push is healthy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { createMemoryStore } from "./store.mjs";
import { probeAnchor } from "./probe.mjs";

const T = 1_800_000_000;
const SECRET = "shh-owner";
const K = `k=${SECRET}`;

// A handler with a fake clock and a counting probe, so "did it call out?" is observable.
function mkHandler(anchorFor = (t) => ({ ts: t, five_pct: 0.2, week_pct: 0.02, five_reset: t + 3600, week_reset: t + 3 * 86400, sl: null, src: "probe" })) {
  const store = createMemoryStore();
  let clock = T;
  const calls = [];
  const h = createHandler({
    store,
    secretFor: (x) => (x === "testy" ? SECRET : null),
    now: () => clock,
    probe: async (token, { now }) => { calls.push({ token, now }); return anchorFor(now); },
  });
  return { store, h, calls, tick: (s) => (clock += s), at: () => clock };
}
const post = (url, body) => ({ method: "POST", url, headers: {}, body: JSON.stringify(body) });
const get = (url) => ({ method: "GET", url, headers: {} });

const seedAnchor = async (store, ageSec) => {
  const s = await store.load("testy");
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 20e6 });
  s.anchors.push({ ts: T - ageSec, five_pct: 0.1, week_pct: 0.2, five_reset: T + 3600, week_reset: T + 3 * 86400, sl: null });
  await store.save("testy", s);
};

test("probe token is write-only: set via config, never echoed back", async () => {
  const { h, store } = mkHandler();
  const res = await h(post(`/api/u/testy/config?${K}`, { probe_token: "sk-ant-oat-secret" }));
  assert.equal(res.status, 200);
  const b = JSON.parse(res.body);
  assert.equal(b.probe, true, "reports that a probe credential exists");
  assert.equal(JSON.stringify(b).includes("sk-ant-oat-secret"), false, "token must not appear in any response");
  assert.equal((await store.load("testy")).probe.token, "sk-ant-oat-secret");
  // and it clears
  await h(post(`/api/u/testy/config?${K}`, { probe_token: "" }));
  assert.equal((await store.load("testy")).probe, null);
});

test("healthy push: a fresh anchor never triggers a probe (zero cost)", async () => {
  const { h, store, calls } = mkHandler();
  await h(post(`/api/u/testy/config?${K}`, { probe_token: "tok" }));
  await seedAnchor(store, 60);                       // pushed a minute ago
  await h(get(`/api/u/testy/budget?${K}`));
  assert.equal(calls.length, 0, "must not spend a token while the laptop is reporting");
});

test("no probe token configured: stale anchor stays stale, no call attempted", async () => {
  const { h, store, calls } = mkHandler();
  await seedAnchor(store, 13 * 3600);                // past the degrade horizon
  const b = JSON.parse((await h(get(`/api/u/testy/budget?${K}`))).body);
  assert.equal(calls.length, 0);
  assert.equal(b.verdict, "stale");
});

test("push gone: stale anchor is pulled, and the fleet stops reading stale", async () => {
  const { h, store, calls } = mkHandler();
  await h(post(`/api/u/testy/config?${K}`, { probe_token: "tok" }));
  await seedAnchor(store, 13 * 3600);                // laptop off 13h → would be stale
  const b = JSON.parse((await h(get(`/api/u/testy/budget?${K}`))).body);
  assert.equal(calls.length, 1, "pulled exactly one anchor");
  assert.equal(calls[0].token, "tok");
  assert.notEqual(b.verdict, "stale");
  assert.equal(b.anchor_age_sec, 0, "budget computed against the freshly pulled anchor");
  assert.ok(b.block_share_pct > 0, `expected a live block share, got ${b.block_share_pct}`);
  const ops = (await store.load("testy")).ops.filter((o) => o.op === "probe");
  assert.equal(ops.length, 1);
});

test("probe is rate-limited: repeat gate checks inside 5min do not re-spend", async () => {
  const { h, store, calls, tick } = mkHandler();
  await h(post(`/api/u/testy/config?${K}`, { probe_token: "tok" }));
  await seedAnchor(store, 13 * 3600);
  await h(get(`/api/u/testy/budget?${K}`));
  assert.equal(calls.length, 1);
  for (let i = 0; i < 5; i++) { tick(50); await h(get(`/api/u/testy/budget?${K}`)); }
  assert.equal(calls.length, 1, "5 more gate checks inside the interval cost nothing");
});

test("a failing probe backs off instead of hammering the API every gate check", async () => {
  const { h, store, calls, tick } = mkHandler(() => null);   // dead token / no headers
  await h(post(`/api/u/testy/config?${K}`, { probe_token: "bad" }));
  await seedAnchor(store, 13 * 3600);
  await h(get(`/api/u/testy/budget?${K}`));
  tick(60);
  await h(get(`/api/u/testy/budget?${K}`));
  assert.equal(calls.length, 1, "failure is rate-limited exactly like a success");
  assert.equal(JSON.parse((await h(get(`/api/u/testy/budget?${K}`))).body).verdict, "stale", "no anchor invented on failure");
});

// The header contract itself, against a stubbed response.
test("probeAnchor maps the unified ratelimit headers onto the anchor shape", async () => {
  const headers = new Map([
    ["anthropic-ratelimit-unified-5h-utilization", "0.06"],
    ["anthropic-ratelimit-unified-5h-reset", "1784869800"],
    ["anthropic-ratelimit-unified-7d-utilization", "0.01"],
    ["anthropic-ratelimit-unified-7d-reset", "1785456000"],
  ]);
  const a = await probeAnchor("tok", {
    now: T,
    fetchImpl: async () => ({ status: 200, headers: { get: (k) => headers.get(k) ?? null } }),
  });
  assert.deepEqual(a, { ts: T, five_pct: 0.06, week_pct: 0.01, five_reset: 1784869800, week_reset: 1785456000, sl: null, src: "probe" });
});

test("probeAnchor returns null when the response carries no usable headers", async () => {
  const a = await probeAnchor("tok", { now: T, fetchImpl: async () => ({ status: 401, headers: { get: () => null } }) });
  assert.equal(a, null);
  const b = await probeAnchor("tok", { now: T, fetchImpl: async () => { throw new Error("network down"); } });
  assert.equal(b, null, "a thrown fetch must not take the budget route down");
});
