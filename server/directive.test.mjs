// Directive channel — orchestrator → session commands (pause/clear/resume).
// Pure tally fns with injected time + handler-level REST/MCP round-trips on a
// memory store (no live servers — see HANDOFF gotchas). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore, addDirective, pendingDirectives, autoAdvise, computeBudget } from "./tally.mjs";
import { createHandler } from "./handler.mjs";
import { createMemoryStore } from "./store.mjs";

const T0 = 1_800_000_000; // fixed epoch seconds

test("pause targets one session; broadcast reaches all; others untouched", () => {
  const s = emptyStore();
  addDirective(s, { session: "aaa", action: "pause", note: "runaway" }, T0);
  assert.equal(pendingDirectives(s, { session: "aaa" }, T0 + 1)[0].note, "runaway");
  assert.equal(pendingDirectives(s, { session: "bbb" }, T0 + 1).length, 0);
  addDirective(s, { session: "*", action: "pause" }, T0 + 2);
  assert.equal(pendingDirectives(s, { session: "bbb" }, T0 + 3).length, 1);
});

test("pause is sticky across reads; clear is one-shot per session", () => {
  const s = emptyStore();
  addDirective(s, { session: "*", action: "pause" }, T0);
  addDirective(s, { session: "*", action: "clear" }, T0);
  assert.deepEqual(pendingDirectives(s, { session: "aaa" }, T0 + 1).map((d) => d.action).sort(), ["clear", "pause"]);
  // second read: pause re-delivered, clear consumed
  assert.deepEqual(pendingDirectives(s, { session: "aaa" }, T0 + 2).map((d) => d.action), ["pause"]);
  // a different session still gets the broadcast clear once
  assert.deepEqual(pendingDirectives(s, { session: "bbb" }, T0 + 3).map((d) => d.action).sort(), ["clear", "pause"]);
});

test("resume lifts a session's pauses; broadcast resume lifts all", () => {
  const s = emptyStore();
  addDirective(s, { session: "aaa", action: "pause" }, T0);
  addDirective(s, { session: "bbb", action: "pause" }, T0);
  const r = addDirective(s, { session: "aaa", action: "resume" }, T0 + 1);
  assert.equal(r.lifted, 1);
  assert.equal(pendingDirectives(s, { session: "aaa" }, T0 + 2).length, 0);
  assert.equal(pendingDirectives(s, { session: "bbb" }, T0 + 2).length, 1);
  assert.equal(addDirective(s, { session: "*", action: "resume" }, T0 + 3).lifted, 1);
});

test("directives expire at ttl; ttl clamped to [60, 86400]", () => {
  const s = emptyStore();
  addDirective(s, { session: "aaa", action: "pause", ttl_sec: 60 }, T0);
  assert.equal(pendingDirectives(s, { session: "aaa" }, T0 + 30).length, 1);
  assert.equal(pendingDirectives(s, { session: "aaa" }, T0 + 61).length, 0);
  const d = addDirective(s, { session: "aaa", action: "pause", ttl_sec: 999_999 }, T0);
  assert.equal(d.expires, T0 + 86400);
});

test("bad input rejected; old store docs without the field tolerated", () => {
  const s = emptyStore();
  assert.equal(addDirective(s, { session: "", action: "pause" }, T0).ok, false);
  assert.equal(addDirective(s, { session: "aaa", action: "reboot" }, T0).ok, false);
  delete s.directives; // pre-directive store doc
  assert.equal(addDirective(s, { session: "aaa", action: "pause" }, T0).ok, true);
  delete s.directives;
  assert.deepEqual(pendingDirectives(s, { session: "aaa" }, T0), []);
});

test("create + delivery audited in the feed as billed:0 events", () => {
  const s = emptyStore();
  addDirective(s, { session: "aaa", action: "pause", note: "hot" }, T0);
  pendingDirectives(s, { session: "aaa" }, T0 + 1);
  const notes = s.events.filter((e) => e.surface === "directive");
  assert.equal(notes.length, 2);
  assert.ok(notes[0].name.includes("pause"));
  assert.ok(notes[1].name.startsWith("✓"));
  assert.ok(notes.every((e) => e.billed === 0));
});

test("handler REST: POST /directive queues, GET /directives consumes, peek does not", async () => {
  let t = T0;
  const h = createHandler({ store: createMemoryStore(), now: () => t });
  const post = await h({
    method: "POST", url: "/api/u/reif/directive", headers: {},
    body: JSON.stringify({ session: "aaa", action: "clear", note: "ctx 300k" }),
  });
  assert.equal(post.status, 200);
  t += 1;
  const peek = await h({ method: "GET", url: "/api/u/reif/directives?session=aaa&peek=1", headers: {} });
  assert.equal(JSON.parse(peek.body).directives.length, 1);
  const read = await h({ method: "GET", url: "/api/u/reif/directives?session=aaa", headers: {} });
  assert.equal(JSON.parse(read.body).directives[0].note, "ctx 300k");
  const again = await h({ method: "GET", url: "/api/u/reif/directives?session=aaa", headers: {} });
  assert.equal(JSON.parse(again.body).directives.length, 0);
  const bad = await h({ method: "POST", url: "/api/u/reif/directive", headers: {}, body: '{"session":"a","action":"nope"}' });
  assert.equal(bad.status, 400);
});

test("handler MCP: maxx_directive listed and callable", async () => {
  const h = createHandler({ store: createMemoryStore(), now: () => T0 });
  const rpc = (method, params = {}) =>
    h({ method: "POST", url: "/mcp?handle=reif", headers: {}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const list = JSON.parse((await rpc("tools/list")).body);
  assert.ok(list.result.tools.some((x) => x.name === "maxx_directive"));
  const call = JSON.parse((await rpc("tools/call", {
    name: "maxx_directive", arguments: { session: "*", action: "pause", note: "budget hold" },
  })).body);
  const res = JSON.parse(call.result.content[0].text);
  assert.equal(res.ok, true);
  assert.equal(res.action, "pause");
});

// ---- watchdog: maxx acting on its own -------------------------------------
test("watchdog advises /clear on a past-wall session that is actually burning", () => {
  const s = emptyStore();
  const T = 1_800_000_000;
  // weekly anchor so sustainable_per_min is real
  s.anchors.push({ ts: T - 60, five_pct: 0.2, week_pct: 0.3, five_reset: T + 3600, week_reset: T + 2 * 86400 });
  // a fat session burning hard in the last 5 minutes
  for (let i = 0; i < 5; i++)
    s.events.push({ surface: "laptop:a", root: "sess-hot", ts: T - 60 * i, billed: 20e6, ctx: 430e3, name: "hot session" });
  const sent = autoAdvise(s, T);
  assert.equal(sent.length, 1, `one advisory, got ${JSON.stringify(sent)}`);
  assert.equal(sent[0].session, "sess-hot");
  const d = s.directives.find((x) => x.session === "sess-hot");
  assert.ok(d && d.action === "clear" && d.auto === true, "auto clear directive queued");
  assert.match(d.note, /past the .* wall/);
  // cooldown: a second run inside the window must not nag again
  assert.equal(autoAdvise(s, T + 60).length, 0, "cooldown suppresses repeat");
});

test("watchdog stays quiet on a big but idle context", () => {
  const s = emptyStore();
  const T = 1_800_000_000;
  s.anchors.push({ ts: T - 60, five_pct: 0.2, week_pct: 0.3, five_reset: T + 3600, week_reset: T + 2 * 86400 });
  // huge context, but the burn is old — nothing in the last 5 minutes
  s.events.push({ surface: "laptop:a", root: "sess-idle", ts: T - 3000, billed: 40e6, ctx: 460e3, name: "idle whale" });
  assert.equal(autoAdvise(s, T).length, 0, "idle session is not urgent");
  assert.equal((s.directives || []).length, 0, "no directive queued");
});

test("watchdog fires on a climbing cost-per-turn before the wall", () => {
  const s = emptyStore();
  const T = 1_800_000_000;
  s.anchors.push({ ts: T - 60, five_pct: 0.2, week_pct: 0.3, five_reset: T + 3600, week_reset: T + 2 * 86400 });
  // under the 250k ctx wall the whole time, but cost/turn doubles across 6 emits
  const perTurn = [80e3, 85e3, 82e3, 210e3, 240e3, 260e3];
  perTurn.forEach((c, i) =>
    s.events.push({ surface: "laptop:a", root: "sess-ramp", ts: T - (6 - i) * 60,
      billed: c * 4, turns: 4, ctx: 180e3, name: "ramping session" }));
  // and it is burning inside the last 5 minutes
  s.events.push({ surface: "laptop:a", root: "sess-ramp", ts: T - 30, billed: 30e6, turns: 3, ctx: 190e3, name: "ramping session" });
  const sent = autoAdvise(s, T);
  assert.equal(sent.length, 1, `climbing session advised, got ${JSON.stringify(sent)}`);
  const d = s.directives.find((x) => x.session === "sess-ramp");
  assert.match(d.note, /cost per turn is climbing/);
  assert.ok(!/past the/.test(d.note.split("Burning")[0]) || d.note.includes("climbing"), "leads with the climb, not the wall");
});

// An unattended session has nobody to press /clear, and past the wall every further turn
// re-bills the whole context. `rise` is how the watchdog says "advising is not enough here".
test("past-wall clear is marked rise; a climbing-but-under-wall one is only advisory", () => {
  const T = 1_800_000_000;
  const anchored = () => {
    const s = emptyStore();
    s.anchors.push({ ts: T - 60, five_pct: 0.2, week_pct: 0.3, five_reset: T + 3600, week_reset: T + 2 * 86400 });
    return s;
  };
  const past = anchored();
  for (let i = 0; i < 5; i++)
    past.events.push({ surface: "laptop:a", root: "sess-hot", ts: T - 60 * i, billed: 20e6, ctx: 430e3 });
  autoAdvise(past, T);
  assert.equal(past.directives.find((d) => d.session === "sess-hot").rise, true,
    "past the wall, waiting on a human keystroke is the expensive option");

  const ramp = anchored();
  [80e3, 85e3, 82e3, 210e3, 240e3, 260e3].forEach((c, i) =>
    ramp.events.push({ surface: "laptop:a", root: "sess-ramp", ts: T - (6 - i) * 60, billed: c * 4, turns: 4, ctx: 180e3 }));
  ramp.events.push({ surface: "laptop:a", root: "sess-ramp", ts: T - 30, billed: 30e6, turns: 3, ctx: 190e3 });
  autoAdvise(ramp, T);
  assert.equal(ramp.directives.find((d) => d.session === "sess-ramp").rise, false,
    "still room to finish the thought — do not renew a session that is merely getting pricey");
});

test("rise survives the wire to the session that must act on it", () => {
  const s = emptyStore();
  const T = 1_800_000_000;
  addDirective(s, { session: "sess-1", action: "clear", rise: true, note: "ctx 613k" }, T);
  const [d] = pendingDirectives(s, { session: "sess-1" }, T);
  assert.equal(d.rise, true, "the gate cannot escalate what the payload drops");
  addDirective(s, { session: "sess-2", action: "clear" }, T);
  assert.equal(pendingDirectives(s, { session: "sess-2" }, T)[0].rise, false, "defaults to advisory, never renews on its own");
});

test("pending directives ride along in the budget payload", () => {
  const s = emptyStore();
  const T = 1_800_000_000;
  addDirective(s, { session: "sess-x", surface: "laptop:a", action: "pause", note: "hold" }, T);
  const b = computeBudget(s, T);
  assert.equal(b.pending_directives.length, 1);
  assert.equal(b.pending_directives[0].surface, "laptop:a");
  assert.equal(b.pending_directives[0].delivered, 0);
});
