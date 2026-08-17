// Grouping handles into one account, and choosing which to use next.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkHandle, handlesFor, accountOf, accountId, pick } from "./account.mjs";

test("handles group under one account, case-folded", () => {
  let ix = {};
  ix = linkHandle(ix, "Reif@Thegoodproject.net", "reif");
  ix = linkHandle(ix, "reif@thegoodproject.net", "reif_tgp");
  // Case-folding is not cosmetic: without it Reif@x and reif@x are two pools, and a fleet
  // would round-robin inside a group of one while believing it had two.
  assert.deepEqual(handlesFor(ix, "REIF@THEGOODPROJECT.NET"), ["reif", "reif_tgp"]);
  assert.equal(accountOf(ix, "reif_tgp"), "reif@thegoodproject.net");
  assert.equal(accountOf(ix, "stranger"), null);
});

test("linking is idempotent and moves a handle rather than duplicating it", () => {
  let ix = linkHandle(linkHandle({}, "a@x", "h1"), "a@x", "h1");
  assert.deepEqual(handlesFor(ix, "a@x"), ["h1"], "re-link must not duplicate");
  // A handle counted under two accounts would have its usage double-counted in a pooled
  // total, so the pool would believe it had more headroom than it does.
  ix = linkHandle(ix, "b@x", "h1");
  assert.deepEqual(handlesFor(ix, "a@x"), [], "the old owner must lose it");
  assert.deepEqual(handlesFor(ix, "b@x"), ["h1"]);
  assert.equal(accountId(" Mixed@Case.COM "), "mixed@case.com");
});

test("round robin spreads the burn: least recently used goes first", () => {
  const r = pick([
    { handle: "reif", usage_week_pct: 0.30, last_used: 900 },
    { handle: "reif_tgp", usage_week_pct: 0.30, last_used: 100 },
  ]);
  assert.equal(r.handle, "reif_tgp");
  assert.match(r.why, /round robin/);
});

test("exhaustion keeps the second account as a reserve", () => {
  const members = [
    { handle: "reif", usage_week_pct: 0.30, last_used: 900 },
    { handle: "reif_tgp", usage_week_pct: 0.10, last_used: 100 },
  ];
  // Round robin would take reif_tgp (older last_used); exhaustion holds the caller's order and
  // drains the first one that still has room. That difference IS the setting.
  assert.equal(pick(members, { strategy: "round_robin" }).handle, "reif_tgp");
  assert.equal(pick(members, { strategy: "exhaustion" }).handle, "reif");
  assert.equal(pick(members, { strategy: "lowest_usage" }).handle, "reif_tgp");
});

test("an account over the ceiling is skipped while another has room", () => {
  const r = pick([
    { handle: "reif", usage_week_pct: 0.99, last_used: 0 },      // past 0.925
    { handle: "reif_tgp", usage_week_pct: 0.40, last_used: 999 },
  ]);
  assert.equal(r.handle, "reif_tgp", "the spent account must not be chosen over a healthy one");
});

test("an UNREADABLE meter stays a candidate -- it is not an exhausted account", () => {
  // The rule maxx states last and calls the most expensive mistake in its history. A null
  // reading must not rank below a genuinely spent account.
  const r = pick([
    { handle: "spent", usage_week_pct: 0.99, last_used: 0 },
    { handle: "unknown", usage_week_pct: null, last_used: 5 },
  ]);
  assert.equal(r.handle, "unknown");
});

test("a reading whose window already rolled is unknown, not full", () => {
  // usage_week_live:false means that reading describes a window that no longer exists. Reading
  // it as 100%-used is what left the fleet unable to restart itself when the week rolled.
  const r = pick([
    { handle: "rolled", usage_week_pct: 1, usage_week_live: false, last_used: 0 },
    { handle: "spent", usage_week_pct: 0.98, usage_week_live: true, last_used: 0 },
  ]);
  assert.equal(r.handle, "rolled");
});

test("everyone over the ceiling still returns SOMEONE -- picking is not gating", () => {
  // "Nobody" would be a gate, and nothing maxx computes may deny work. The caller asked who is
  // next; Anthropic decides whether the call actually lands.
  const r = pick([
    { handle: "a", usage_week_pct: 0.99, last_used: 5 },
    { handle: "b", usage_week_pct: 0.97, last_used: 1 },
  ]);
  assert.ok(r && r.handle, "must still name a handle");
  assert.equal(r.ranked.length, 2);
});

test("no members at all is null -- nothing to choose between", () => {
  assert.equal(pick([]), null);
  assert.equal(pick(null), null);
});

test("a per-handle weekly_max overrides the account default", () => {
  const r = pick([
    { handle: "strict", usage_week_pct: 0.50, weekly_max: 0.45, last_used: 0 },  // over ITS cap
    { handle: "loose", usage_week_pct: 0.60, last_used: 9 },                     // under 0.925
  ]);
  assert.equal(r.handle, "loose");
});
