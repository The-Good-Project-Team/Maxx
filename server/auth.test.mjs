// Cookie login for the owner dashboard — secret in the POST body once, HttpOnly
// cookie after; cookie honored for GET reads only (CSRF: mutations stay bearer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { createMemoryStore } from "./store.mjs";

const SECRET = "shh-owner";
function mkHandler() {
  const store = createMemoryStore();
  const h = createHandler({ store, secretFor: (x) => (x === "testy" ? SECRET : null) });
  return { store, h };
}
const post = (url, body, headers = {}) => ({ method: "POST", url, headers, body: JSON.stringify(body) });
const get = (url, headers = {}) => ({ method: "GET", url, headers });
const cookieOf = (res) => (res.headers["set-cookie"] || "").split(";")[0];

test("login: wrong secret 401, right secret sets HttpOnly cookie", async () => {
  const { h } = mkHandler();
  assert.equal((await h(post("/api/u/testy/login", { secret: "nope" }))).status, 401);
  const ok = await h(post("/api/u/testy/login", { secret: SECRET }));
  assert.equal(ok.status, 200);
  assert.match(ok.headers["set-cookie"], /^maxx_k=/);
  assert.match(ok.headers["set-cookie"], /HttpOnly/);
  assert.match(ok.headers["set-cookie"], /SameSite=Lax/);
});

// A freshly web-claimed handle has a secret but zero events until the first emit
// lands. The installer prints the card and dash URLs immediately — they must
// render (empty), not 404, or every new user's first click is a dead link.
// Unregistered names still 404 (no enumeration of arbitrary pages).
test("registered handle with zero events: card + dash render, unregistered 404s", async () => {
  const { h } = mkHandler();
  assert.equal((await h(get("/u/testy"))).status, 200, "card renders before first emit");
  assert.equal((await h(get("/u/testy/dash"))).status, 200, "dash renders before first emit");
  assert.equal((await h(get("/u/testy/live.json"))).status, 200, "live.json serves zeros");
  assert.equal((await h(get("/u/nobody"))).status, 404, "unregistered handle still 404s");
  assert.equal((await h(get("/u/nobody/dash"))).status, 404);
});

test("dash: no auth → shared (redacted) view; ?login=1 → login form; cookie → owner dash; ?k= → cookie", async () => {
  const { h } = mkHandler();
  // seed one event so the public dash renders instead of 404ing
  await h(post("/api/u/testy/logs", { surface: "laptop:x", sessions: [{ root: "r1", billed: 5, name: "secret project name" }] },
    { authorization: `Bearer ${SECRET}` }));
  const anon = await h(get("/u/testy/dash"));
  assert.equal(anon.status, 200);
  assert.match(anon.body, /shared view — names hidden/);
  assert.ok(!anon.headers["set-cookie"], "public view must not set an auth cookie");
  const form = await h(get("/u/testy/dash?login=1"));
  assert.equal(form.status, 401);
  assert.match(form.body, /Paste your secret/);
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  const dash = await h(get("/u/testy/dash", { cookie }));
  assert.equal(dash.status, 200);
  assert.match(dash.body, /· dash/);
  assert.ok(!dash.body.includes(SECRET), "secret must not be embedded in the page");
  // ?k= bridge: dash served directly + cookie set (no redirect — the Netlify proxy
  // re-appends the query string to Location headers, which would loop)
  const bridge = await h(get(`/u/testy/dash?k=${SECRET}`));
  assert.equal(bridge.status, 200);
  assert.match(bridge.body, /· dash/);
  assert.match(bridge.headers["set-cookie"], /^maxx_k=/);
});

test("magic link: bearer-only mint, single-use, expires", async () => {
  let t = 1_800_000_000;
  const store = createMemoryStore();
  const h = createHandler({ store, secretFor: (x) => (x === "testy" ? SECRET : null), now: () => t });
  // a cookie must NOT be able to mint (mint = an action, cookie = reads only)
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  assert.equal((await h(post("/api/u/testy/magic", {}, { cookie }))).status, 401);
  const mint = await h(post("/api/u/testy/magic", {}, { authorization: `Bearer ${SECRET}` }));
  assert.equal(mint.status, 200);
  const m = new URL(JSON.parse(mint.body).url).searchParams.get("m");
  const first = await h(get(`/u/testy/dash?m=${m}`));
  assert.equal(first.status, 200);
  assert.match(first.body, /· dash/);
  assert.match(first.headers["set-cookie"], /^maxx_k=/);
  // second use: consumed → falls to the shared view, and NEVER a cookie
  const again = await h(get(`/u/testy/dash?m=${m}`));
  assert.doesNotMatch(again.body, /· dash/);
  assert.ok(!again.headers["set-cookie"], "consumed magic token must not set a cookie");
  // expired token → shared view, no cookie
  const mint2 = await h(post("/api/u/testy/magic", {}, { authorization: `Bearer ${SECRET}` }));
  const m2 = new URL(JSON.parse(mint2.body).url).searchParams.get("m");
  t += 200;
  const late = await h(get(`/u/testy/dash?m=${m2}`));
  assert.doesNotMatch(late.body, /· dash/);
  assert.ok(!late.headers["set-cookie"], "expired magic token must not set a cookie");
});

test("cookie works for GET reads, never for mutations", async () => {
  const { h } = mkHandler();
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  assert.equal((await h(get("/api/u/testy/budget", { cookie }))).status, 200);
  assert.equal((await h(get("/api/u/testy/feed", { cookie }))).status, 200);
  // no auth → still 200, but the PUBLIC (redacted) shape
  const pub = await h(get("/api/u/testy/budget"));
  assert.equal(pub.status, 200);
  assert.equal(JSON.parse(pub.body).public, true);
  // mutating endpoints must ignore the cookie
  const env = { surface: "laptop:x", sessions: [{ root: "r", billed: 1 }] };
  assert.equal((await h(post("/api/u/testy/logs", env, { cookie }))).status, 401);
  assert.equal((await h(post("/api/u/testy/directive", { session: "*", action: "pause" }, { cookie }))).status, 401);
  assert.equal((await h(post("/api/u/testy/logs", env, { cookie, authorization: `Bearer ${SECRET}` }))).status, 200);
});

test("settings mutations: cookie + same-origin Origin ok; cross-origin/no-Origin denied", async () => {
  const { h } = mkHandler();
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  const same = { cookie, origin: "https://api.meetmaxx.co", host: "api.meetmaxx.co" };
  const dir = { session: "*", action: "pause" };
  assert.equal((await h(post("/api/u/testy/directive", dir, same))).status, 200);
  assert.equal((await h(post("/api/u/testy/config", { runaway_min: 5 }, same))).status, 200);
  assert.equal((await h(post("/api/u/testy/directive", dir, { cookie, origin: "https://evil.example", host: "api.meetmaxx.co" }))).status, 401);
  assert.equal((await h(post("/api/u/testy/directive", dir, { cookie, host: "api.meetmaxx.co" }))).status, 401);
  // settings page: auth-gated like the dash
  assert.equal((await h(get("/u/testy/settings"))).status, 401);
  const page = await h(get("/u/testy/settings", { cookie }));
  assert.equal(page.status, 200);
  assert.match(page.body, /Fleet control/);
});

test("ops ring: auth + mcp + directives land in /ops, capped and owner-only", async () => {
  const { h } = mkHandler();
  await h(post("/api/u/testy/login", { secret: "wrong" }));
  const cookie = cookieOf(await h(post("/api/u/testy/login", { secret: SECRET })));
  await h(post("/api/u/testy/directive", { session: "*", action: "pause" }, { cookie, origin: "https://api.meetmaxx.co", host: "api.meetmaxx.co" }));
  const anonOps = await h(get("/api/u/testy/ops"));
  assert.equal(anonOps.status, 200);
  assert.deepEqual(JSON.parse(anonOps.body).ops, [], "ops content is owner-only; public gets an empty ring");
  const r = await h(get("/api/u/testy/ops", { cookie }));
  assert.equal(r.status, 200);
  const ops = JSON.parse(r.body).ops.map((o) => `${o.op}:${o.d}`);
  assert.ok(ops.some((o) => o.startsWith("auth:login:FAILED")), "failed login logged");
  assert.ok(ops.some((o) => o.startsWith("directive:pause")), "directive logged");
});

test("public reads are redacted: no names, no session ids, no directive text, empty ops", async () => {
  const { h } = mkHandler();
  const bear = { authorization: `Bearer ${SECRET}` };
  await h(post("/api/u/testy/logs", { surface: "laptop:mbp-13", sessions: [
    { root: "8f3c2a1d-real-session-id", billed: 900000, name: "Acme prod incident debug", project: "acme-api", branch: "hotfix/oops" },
  ] }, bear));
  await h(post("/api/u/testy/logs", { surface: "cloud:reviewer", sessions: [
    { root: "cloudroot-1", billed: 250000, name: "review PR #42" },
  ] }, bear));
  await h(post("/api/u/testy/directive", { session: "*", action: "pause", note: "secret ops note" },
    { ...bear, origin: "https://api.meetmaxx.co", host: "api.meetmaxx.co" }));

  const leak = /Acme|acme-api|hotfix|8f3c2a1d|mbp-13|reviewer|PR #42|secret ops note/;
  const feed = await h(get("/api/u/testy/feed?n=50"));
  assert.equal(feed.status, 200);
  assert.doesNotMatch(feed.body, leak, "public feed leaked content");
  const fj = JSON.parse(feed.body);
  assert.ok(fj.events.length >= 2, "magnitudes must survive redaction");
  assert.ok(fj.events.every((e) => /^(machine|cloud) \d+$/.test(e.surface)), "surfaces must be anonymized");
  assert.ok(fj.events.every((e) => /^session-\d+$/.test(e.root)), "session ids must be anonymized");

  const bud = await h(get("/api/u/testy/budget"));
  assert.doesNotMatch(bud.body, leak, "public budget leaked content");
  assert.equal(JSON.parse(bud.body).pending_directives.length, 0);

  const ops = await h(get("/api/u/testy/ops"));
  assert.equal(ops.status, 200);
  assert.deepEqual(JSON.parse(ops.body).ops, []);

  // owner still sees everything
  const own = await h(get("/api/u/testy/feed?n=50", bear));
  assert.match(own.body, /Acme prod incident debug/);
});

test("owner feed serves 10k; public feed stays at 200", async () => {
  const { h } = mkHandler();
  const bear = { authorization: `Bearer ${SECRET}` };
  for (let i = 0; i < 250; i++) {
    await h(post("/api/u/testy/logs", {
      surface: "laptop:x",
      sessions: [{ root: `r${i}`, billed: 10, name: `turn ${i}` }],
    }, bear));
  }
  const own = JSON.parse((await h(get("/api/u/testy/feed?n=99999", bear))).body);
  assert.equal(own.events.length, 250, "owner n=99999 must not clamp below what is stored");
  const pub = JSON.parse((await h(get("/api/u/testy/feed?n=99999"))).body);
  assert.equal(pub.events.length, 200, "public feed must stay at 200 even when asked for more");
});
