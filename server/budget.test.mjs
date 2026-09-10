// The 5h limit is a fixed window (zeroes at five_reset), not a rolling sum — burn
// from before the wall reset must not count against the fresh window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { emptyStore, computeBudget, applyEnvelope, compact } from "./tally.mjs";

const T = 1_800_000_000, H = 3600;

test("five window is anchor-aligned: pre-reset burn does not carry over", () => {
  const s = emptyStore();
  // window started 1h ago (resets in 4h); 100M burned before it, 8M inside it
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 100e6 },
    { surface: "laptop:a", root: "r2", ts: T - 0.5 * H, billed: 8e6 },
  );
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400 });
  const b = computeBudget(s, T);
  // Only the in-window event attributes to the 5h side. It is the whole window, so it carries
  // the whole 10% Anthropic reports — the pre-reset 100M is not allowed to dilute it.
  const surf = b.surfaces.find((x) => x.surface === "laptop:a");
  assert.equal(surf.five_pct, 10);
  assert.equal(surf.week_pct, 20, "both events sit inside the week, which they report as 20%");
});

// The ledger's windowed sums are INTERNAL. What ships is each window restated as a percentage
// of Anthropic's own reading, so an sl anchor's cap numbers cannot override anything and no
// token count leaves the server.
test("windowed sums ship as percentages of Anthropic's reading, never as counts", () => {
  const s = emptyStore();
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 50e6 },   // in the week window, not the 5h one
    { surface: "laptop:b", root: "r2", ts: T - 100, billed: 2e6 },      // inside both windows
  );
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 120e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  // the pcts we publish are Anthropic's own, not a ratio against something we invented
  assert.equal(b.usage_week_pct, 0.2);
  assert.equal(b.usage_five_pct, 0.1);
  // laptop:a holds 50 of the 52M week → 96.2% of the ledger → 19.2 of the real 20%
  assert.equal(b.surfaces.find((x) => x.surface === "laptop:a").week_pct, 19.2);
  assert.equal(b.surfaces.find((x) => x.surface === "laptop:a").five_pct, 0,
    "it burned before this 5h window opened, so it holds 0% of it");
  assert.equal(b.surfaces.find((x) => x.surface === "laptop:b").five_pct, 10, "laptop:b IS the 5h window");
  // NOTHING token-denominated may ship as a budget reading
  for (const k of ["week", "quota", "weekly_left_tokens", "session_to_spend", "session_burst",
                   "week_cap_tokens", "week_used_tokens", "week_bank", "session_over",
                   "five_billed", "week_billed", "coin_spree_low", "session_safe", "net_per_min"])
    assert.equal(b[k], undefined, `${k} must not ship — it is a token count or an invented standing`);
});

// The week bar's ╎ mark is drawn from week_bank_pct; a null bank silently erases it while the
// legend keeps promising "╎ = even pace". In percent it is simply clock minus spend.
test("week_bank_pct is clock-elapsed minus spend-used, + when under pace", () => {
  const s = emptyStore();
  // 3 days into the week (resets in 4) ⇒ the clock is 3/7 = 42.9% through it
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 100e6 });
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.1, five_reset: T + 4 * H, week_reset: T + 4 * 86400 });
  const b = computeBudget(s, T);
  assert.equal(b.week_elapsed_pct, 42.9);
  assert.ok(b.week_bank_pct != null, "a live week reset must yield a bank — null erases the pace mark");
  assert.equal(b.week_bank_pct, 32.9, "42.9% of the clock spent, 10% of the week used ⇒ 32.9 ahead");
});

// A young account's week did not start 7 days before its reset — it started when the account
// did. Anthropic opens a new account on a PARTIAL first window ending at the next schedule
// boundary. Unfloored, `week_reset − 7d` invents a start that predates the account and the
// bar reads far more of the week elapsed than has actually passed.
test("week_elapsed_pct is floored at account creation for a young account", () => {
  const s = emptyStore();
  const born = T - 10 * H;            // account created 10h ago
  const reset = T + 58 * H;           // its first reset is 58h out (a 68h partial window)
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 1e6 });
  s.anchors.push({
    ts: T - 600, five_pct: 0.05, week_pct: 0.02,
    five_reset: T + 4 * H, week_reset: reset,
    account_created: new Date(born * 1000).toISOString(),
  });
  const b = computeBudget(s, T);
  // 10h into a 68h window = 14.7%. Without the floor: (7d − 58h)/7d = 65.5%.
  assert.equal(b.week_elapsed_pct, 14.7, "elapsed must divide by the window the account actually had");
  assert.ok(b.week_elapsed_pct < 20, "a 10h-old account cannot be most of the way through its week");
});

// The gap that shipped: computeBudget read anchor.account_created, but applyEnvelope built the
// stored anchor field-by-field and never copied it — so the floor was dead in production while
// every unit test (which handed computeBudget an anchor directly) passed. Test the REAL path.
test("applyEnvelope carries account_created from the emitted anchor into the store", () => {
  const s = emptyStore();
  const born = new Date((T - 10 * H) * 1000).toISOString();
  applyEnvelope(s, {
    v: 1, surface: "laptop:a", handle: "h", emitted_at: new Date(T * 1000).toISOString(),
    cursor: "1", sessions: [{ surface: "laptop:a", root: "r1", ts: T - 600, billed: 1e6 }],
    anchor: {
      five_pct: 0.05, week_pct: 0.02,
      five_reset: T + 4 * H, week_reset: T + 58 * H,
      account_created: born, observed_at: new Date(T * 1000).toISOString(),
    },
  }, T);
  const a = s.anchors[s.anchors.length - 1];
  assert.equal(a.account_created, born, "ingest must persist it or the floor is dead");
  // and it must actually reach the reading
  assert.equal(computeBudget(s, T).week_elapsed_pct, 14.7);
});

// The floor must not touch a mature account: its window really did open 7 days before reset.
test("an account older than the window keeps the plain 7d span", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 100e6 });
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.1,
    five_reset: T + 4 * H, week_reset: T + 4 * 86400,
    account_created: new Date((T - 90 * 86400) * 1000).toISOString(),
  });
  const b = computeBudget(s, T);
  assert.equal(b.week_elapsed_pct, 42.9, "90d-old account: unchanged 3/7 of the week");
});

test("week_bank_pct goes negative once spend outruns the clock", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 800e6 });
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.8, five_reset: T + 4 * H, week_reset: T + 4 * 86400 });
  assert.ok(computeBudget(s, T).week_bank_pct < 0, "80% used against a 42.9% clock is behind pace");
});

// A sentinel reset (seen live: resets_at = 9999999999) collapses elapsed toward 0, which
// flips the bank's sign. Suppress it rather than draw the mark in the wrong place.
test("week_bank_pct is suppressed when the week reset is missing or a far-future sentinel", () => {
  const mk = (weekReset) => {
    const s = emptyStore();
    s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 100e6 });
    s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.1, five_reset: T + 4 * H, week_reset: weekReset });
    return computeBudget(s, T).week_bank_pct;
  };
  assert.equal(mk(0), null, "no reset → no elapsed → no mark");
  assert.equal(mk(9999999999), null, "a sentinel reset must not fabricate an elapsed");
});

test("pace is %/hr: burn against what the week can sustain", () => {
  const s = emptyStore();
  const wr = T + 100000; // week resets in 100000s ≈ 27.8h
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 3000, billed: 20e6 },
    { surface: "laptop:a", root: "r2", ts: T - 100, billed: 1.5e6 },
  );
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: wr });
  const b = computeBudget(s, T);
  // 80% of the week remains over 27.8h ⇒ it can sustain ~2.88%/hr
  assert.equal(b.sustainable_pct_per_hour, Math.round((80 / (100000 / 3600)) * 100) / 100);
  // the trailing 6h holds the whole 21.5M ledger = the whole 20% ⇒ 3.33%/hr
  assert.equal(b.burn_pct_per_hour, Math.round((20 / 6) * 100) / 100);
  assert.ok(b.burn_pct_per_hour > b.sustainable_pct_per_hour, "burning above what the week sustains");
  assert.ok(b.projected_wall_at > T, "so the wall is projected before the reset");
});

test("a surface's burn is reported as its share of the real week", () => {
  const s = emptyStore();
  s.events.push(
    { surface: "cloud:qa", root: "r1", ts: T - 100, billed: 3e6 },
    { surface: "laptop:a", root: "r2", ts: T - 100, billed: 1e6 },
  );
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400 });
  const b = computeBudget(s, T);
  // cloud:qa is 3 of the 4M ledger = 75% of it ⇒ 15 of the real 20% week
  assert.equal(b.surfaces[0].surface, "cloud:qa");
  assert.equal(b.surfaces[0].week_pct, 15);
  assert.equal(b.surfaces[1].week_pct, 5);
  // the shares add back up to Anthropic's own reading — that is what makes them trustworthy
  assert.equal(b.surfaces.reduce((a2, x) => a2 + x.week_pct, 0), 20);
});

test("no usable reading ⇒ percentages are null, which means UNKNOWN, not empty", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 100, billed: 5e6 });
  s.anchors.push({ ts: T - 60, five_pct: 0, week_pct: 0, five_reset: T + 4 * H, week_reset: T + 6 * 86400 });
  const b = computeBudget(s, T);
  assert.equal(b.surfaces[0].week_pct, null, "a 0% reading cannot apportion anything");
  assert.notEqual(b.surfaces[0].week_pct, 0, "and 0 would read as 'this surface burned nothing'");
});

// A sleeping laptop is the only thing that stops /usage anchors — it must not blind the
// account, because the server owns the full billed ledger and the weekly caps it
// calibrated move on a 7-day window.
test("aged anchor degrades (weekly standing live) instead of going stale", () => {
  const s = emptyStore();
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 5 * H, billed: 40e6 },
    { surface: "cloud:mcloud", root: "r2", ts: T - 600, billed: 2e6 },
  );
  // anchor 3h old — past the 45m trust window, well inside the 12h degrade window
  s.anchors.push({
    ts: T - 3 * H, five_pct: 0.1, week_pct: 0.2, five_reset: T - 2 * H, week_reset: T + 3 * 86400,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 120e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "degraded");
  assert.equal(b.fresh, false);
  assert.ok(b.anchor_age_sec >= 3 * H - 1, `anchor age reported, got ${b.anchor_age_sec}`);
  // the weekly numbers callers are told to steer by are real, not null
  assert.ok(b.usage_week_pct < 1, "the week is not spent");
  assert.ok(b.block_share_pct > 0, `this block must still have a share, got ${b.block_share_pct}`);
});

test("degraded still yields to the weekly wall (over beats degraded)", () => {
  const s = emptyStore();
  // 99%+ of the anchored weekly cap already billed
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 4 * H, billed: 99e6 });
  s.anchors.push({ ts: T - 3 * H, five_pct: 0.5, week_pct: 0.99, five_reset: T + H, week_reset: T + 86400 });
  assert.equal(computeBudget(s, T).verdict, "over");
});

test("anchor past the degrade window is genuinely blind → stale", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 2e6 });
  s.anchors.push({ ts: T - 20 * H, five_pct: 0.1, week_pct: 0.2, five_reset: T - 19 * H, week_reset: T + 86400 });
  assert.equal(computeBudget(s, T).verdict, "stale");
});

test("no anchor at all is calibrating (hard stop), never degraded", () => {
  const s = emptyStore();
  s.events.push({ surface: "cloud:mcloud", root: "r1", ts: T - 600, billed: 2e6 });
  assert.equal(computeBudget(s, T).verdict, "calibrating");
});

test("wall reset since last anchor: only post-reset burn counts, sl session fields ignored", () => {
  const s = emptyStore();
  s.events.push(
    { surface: "laptop:dead", root: "r1", ts: T - 2 * H, billed: 50e6 },  // pre-reset (dead window)
    { surface: "laptop:live", root: "r2", ts: T - 600, billed: 3e6 },     // post-reset (new window)
  );
  // anchor 30m old (still FRESH) but its five_reset passed 20m ago
  s.anchors.push({
    ts: T - 1800, five_pct: 0.9, week_pct: 0.2, five_reset: T - 1200, week_reset: T + 3 * 86400,
    sl: { five_used: 70e6, five_cap: 80e6, to_spend: 0, week_used: 120e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  // the fresh 5h window contains ONLY the post-reset surface — the dead window's 50M is not
  // allowed to leak into it (the published share is how you can see that from outside)
  assert.equal(b.surfaces.find((x) => x.surface === "laptop:live").five_pct, 90,
    "the live surface IS the new window, so it carries the whole reported 90%");
  assert.equal(b.surfaces.find((x) => x.surface === "laptop:dead").five_pct, 0,
    "the dead window's burn is 0% of the new one — present in the week, absent from this block");
  // sl to_spend=0 described the DEAD window — must not gate the fresh one to zero
  assert.ok(b.block_share_pct > 0, `fresh window has a share, got ${b.block_share_pct}`);
  // the weekly window survives the 5h reset: both events still apportion the real 20% week
  assert.equal(b.surfaces.reduce((a2, x) => a2 + x.week_pct, 0), 20);
});

// An emit whose sessions carry no first_ts/last_ts, in an envelope with no emitted_at,
// used to store ts: 0. Zero fails every `e.ts > lo` test in windowedBilled, so the spend
// vanished from the 5h and weekly windows while still landing in the lifetime odometer —
// the gate reported MORE headroom than the account actually had. Observed in production:
// surface "cloud:mcloud-dispatch-20260721-1650" billed 8,000,000 at ts 1970-01-01.
test("an emit with no timestamps is stamped at receipt, not dropped into 1970", () => {
  const s = emptyStore();
  applyEnvelope(s, { surface: "cloud:dispatch", cursor: "c1", sessions: [{ root: "r1", billed: 8e6 }] }, T);
  assert.equal(s.events[0].ts, T, "ts falls back to receipt time");
  assert.equal(s.events[0].ts0, T, "ts0 falls back to receipt time");

  // With the old ts 0 the spend fell outside every window: real, billed, and invisible to
  // the gate. The odometer is the surviving count and must see it at its receipt time.
  const b = computeBudget(s, T);
  assert.equal(b.lifetime_billed, 8e6, "the spend lands, and is not double-counted");
  // and it is inside the live window, so it attributes against a reading when one exists
  s.anchors.push({ ts: T - 60, five_pct: 0.5, week_pct: 0.5, five_reset: T + H, week_reset: T + 86400 });
  assert.equal(computeBudget(s, T).surfaces[0].five_pct, 50, "visible to the 5h window");
});

// A brand-new account's FIRST anchor: /usage says 1%/4% but the CLI's local cap
// extrapolation (burned ÷ pct) is degenerate — its sl block carries five_used 0,
// to_spend 0. That zero must not govern (it read as "over" and hard-blocked a
// user who had barely spent anything); weekly pacing takes over instead.
test("first anchor with a degenerate sl share falls back to weekly pacing, not 'over'", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:new", root: "r1", ts: T - 300, billed: 15e3 });
  s.anchors.push({
    ts: T - 60, five_pct: 0.01, week_pct: 0.04, five_reset: T + 4 * H, week_reset: T + 6 * 86400,
    sl: { five_used: 0, five_cap: 0, to_spend: 0, over: 0, week_used: 15e3, week_cap: 3e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "ok", `fresh barely-used account must not read over, got ${b.verdict}`);
  assert.ok(b.block_share_pct > 0, `weekly-paced share governs, got ${b.block_share_pct}`);
});

// A brand-new account has events (maybe) but has NEVER seen a /usage anchor. That is
// "calibrating" — a setup state — not "stale" (a signal that died). Pages render it
// neutral instead of as red deficits; agents still treat it as a hard stop.
test("never-anchored account reads calibrating, not stale", () => {
  const s = emptyStore();
  assert.equal(computeBudget(s, T).verdict, "calibrating", "empty account");
  applyEnvelope(s, { surface: "laptop:new", cursor: "c", sessions: [{ root: "r", billed: 5e4 }] }, T);
  assert.equal(computeBudget(s, T).verdict, "calibrating", "events but no anchor ever");
});

// The emit reply is what a chat session shows its human — counts of batches alone
// ("accepted: 1") say nothing. It must echo the billed tokens it just recorded,
// and dedupes must not re-count.
test("applyEnvelope returns the billed sum it accepted", () => {
  const s = emptyStore();
  const r1 = applyEnvelope(s, { surface: "cloud:chat", cursor: "c1", sessions: [{ root: "a", billed: 12000 }, { root: "b", billed: 5000 }] }, T);
  assert.equal(r1.billed, 17000, "sum of accepted sessions");
  const r2 = applyEnvelope(s, { surface: "cloud:chat", cursor: "c1", sessions: [{ root: "a", billed: 12000 }] }, T);
  assert.equal(r2.billed, 0, "deduped batch re-counts nothing");
});

// Garbage timestamps must not poison ts with NaN, which fails every comparison silently.
test("unparseable timestamps fall back to receipt time rather than NaN", () => {
  const s = emptyStore();
  applyEnvelope(s, { surface: "s", cursor: "c", emitted_at: "not-a-date", sessions: [{ root: "r", billed: 1e6, last_ts: "garbage" }] }, T);
  assert.equal(s.events[0].ts, T);
  assert.ok(Number.isFinite(s.events[0].ts0));
});

// STALE means "no signal". It was firing while the server still held a perfectly good
// weekly cap, because the anchor's sl block — which carries that cap — was gated on
// `fresh` (45m). Past 45m the cap was discarded and re-derived from week_pct, and
// week_pct <= 0.005 (early in a week, or just after a wall reset) yields no cap at all,
// so session_to_spend went null and degradable collapsed to stale. A laptop napping a
// couple of hours then stopped the entire cloud fleet.
const SL = { five_used: 40e6, five_cap: 500e6, to_spend: 60e6, over: 0, week_used: 300e6, week_cap: 1500e6, bank: 20e6, net_per_min: 300000 };

test("a 2.7h-old anchor with a tiny week_pct degrades, it does not go stale", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 3 * H, billed: 5e6 });
  s.anchors.push({ ts: T - 9613, five_pct: 0.001, week_pct: 0.001, five_reset: T + 2 * H, week_reset: T + 3 * 86400, sl: SL });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "degraded", `expected degraded, got ${b.verdict}`);
  // A 0.1% week needed no division to be usable — this is the case the old token model
  // choked on (too small to imply a limit from) and the one a fleet must never stall on.
  assert.ok(b.block_share_pct > 0, `a barely-touched week must have a share, got ${b.block_share_pct}`);
  assert.equal(b.on_pace, true, "0.1% spent is not over any block's share");
});

test("an anchor older than the 12h degrade window is still stale", () => {
  const s = emptyStore();
  s.anchors.push({ ts: T - 13 * H, five_pct: 0.2, week_pct: 0.3, five_reset: T + 2 * H, week_reset: T + 3 * 86400, sl: SL });
  assert.equal(computeBudget(s, T).verdict, "stale");
});

test("no anchor at all is calibrating, not stale", () => {
  assert.equal(computeBudget(emptyStore(), T).verdict, "calibrating");
});

test("a fresh anchor is unaffected and still reads ok", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 1e6 });
  s.anchors.push({ ts: T - 300, five_pct: 0.1, week_pct: 0.2, five_reset: T + 2 * H, week_reset: T + 3 * 86400, sl: SL });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "ok");
  assert.ok(b.block_share_pct > 0);
});

// reif_tgp on 2026-07-24 sat at 15% of its week per Anthropic, having burned ~61.5M. It read
// "over" and hard-blocked 6 live cloud routines. The cause was never the inference — 61.5M ÷
// 0.15 ≈ 410M is a fine estimate — it was that a PACING number was allowed to deny. Only
// Anthropic's own wall votes on the verdict now, so 15% reads ok whatever the estimate says.
test("reif_tgp false-over stays dissolved: a paced number cannot deny (over → ok)", () => {
  const s = emptyStore();
  const wr = T + 147 * H, fr = T + 4 * H;      // ~147h to weekly reset, ~4h to 5h reset
  s.events.push(
    { surface: "laptop:3b1cc3c3", root: "r1", ts: T - 10 * H, billed: 55.3e6 }, // this week, outside 5h
    { surface: "laptop:3b1cc3c3", root: "r2", ts: T - 600, billed: 6.2e6 },     // inside the 5h window
  );
  // fresh anchor carrying Anthropic's real low % AND the OLD poison (inferred 408M cap, to_spend 0)
  s.anchors.push({
    ts: T - 12, five_pct: 0.02, week_pct: 0.15, five_reset: fr, week_reset: wr,
    sl: { five_used: 6.2e6, five_cap: 130e6, to_spend: 0, over: 0, week_used: 61.5e6, week_cap: 408e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "ok", `15%-used account must not read over, got ${b.verdict}`);
  assert.ok(b.block_share_pct > 0, `fleet has a share to spend, got ${b.block_share_pct}`);
  assert.equal(b.usage_week_pct, 0.15, "their reading is the whole story");
  assert.ok(b.block_share_pct > 0, "and it leaves this block a share to spend");
});

// The coin tank paces; Anthropic's real wall still hard-stops. A LIVE-window anchor at ≥99%
// real utilization forces "over" even though coins say there's tank left — the meter does
// not stop the car, the real gas tank does.
test("real 99% utilization on a live window still forces over (safety wall)", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 3600, billed: 30e6 }); // coins say plenty left
  s.anchors.push({ ts: T - 300, five_pct: 0.5, week_pct: 0.99, five_reset: T + 2 * H, week_reset: T + 86400 });
  assert.equal(computeBudget(s, T).verdict, "over", "real weekly wall overrides a half-full coin tank");
});

// A transient reserve (a fan-out's maxx_reserve lease) throttles session_to_spend so other
// dispatchers back off — but must NOT flip the verdict to "over". One lease hard-denying the
// whole account while the week is healthy is the reif_tgp "over at 18% + 1 lease" surprise.
test("a held reserve shows as reserved_pct but does not flip the verdict", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 20e6 }); // healthy week
  s.anchors.push({ ts: T - 60, five_pct: 0.1, week_pct: 0.1, five_reset: T + 4 * H, week_reset: T + 6 * 86400 });
  s.leases = [{ pct: 5, expires: T + 3600, label: "fan-out" }];   // a hold larger than this block's share
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "ok", `healthy week with a held lease must not read over, got ${b.verdict}`);
  assert.equal(b.reserved_pct, 5, "the hold is visible, in percent of the week");
  assert.ok(b.block_share_pct > 0, "and the block's own share is untouched by it");
});

// Front-loading one 5h window past its even-pace coin share must not hard-block the account
// when the WEEK is healthy and Anthropic's real wall is nowhere near. reif_tgp maxed its 29.76M
// 5h share with 815M week left + real 5h at 2% and hard-skipped a QA run — that was the bug.
test("front-loading one window throttles to_spend but does not flip the verdict", () => {
  const s = emptyStore();
  const wr = T + 2 * 86400, fr = T + 3 * H;
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 30 * H, billed: 150e6 },  // healthy week, ~818M left
    { surface: "laptop:a", root: "r2", ts: T - 600, billed: 32e6 },      // this window blew past the ~29.76M share
  );
  s.anchors.push({ ts: T - 60, five_pct: 0.02, week_pct: 0.18, five_reset: fr, week_reset: wr });
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "ok", `healthy week + maxed 5h share must not read over, got ${b.verdict}`);
  // the remainder is SHOWN, not zeroed by a front-loaded window — routines pace against it, Anthropic limits
  assert.ok(b.block_share_pct > 0, `the next blocks still have shares, got ${b.block_share_pct}`);
});

// session_over is the over-pace mark: what this window spent past its fair share of what's
// left. It is GUIDANCE — borrowing from later blocks shortens the week, it breaches nothing —
// so it must be visible without ever touching the verdict.
test("a block past its share reads off-pace, and still reads ok", () => {
  const s = emptyStore();
  const wr = T + 4 * 86400;                                    // ~19.2 blocks left in the week
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 90e6 });
  s.anchors.push({ ts: T - 60, five_pct: 0.3, week_pct: 0.5, five_reset: T + 4 * H, week_reset: wr });
  const b = computeBudget(s, T);
  // half the week is gone with 19.2 blocks left ⇒ each may have ~2.6% of the week. This block
  // spent the lot, so it is far past its share — guidance, never a verdict.
  assert.ok(b.block_used_pct > b.block_share_pct, `${b.block_used_pct}% spent vs a ${b.block_share_pct}% share`);
  assert.equal(b.on_pace, false);
  assert.equal(b.verdict, "ok", "over-pace is advice; only Anthropic's wall can say over");
});

// A CAP is a capacity; a READING is not. The 5h path already refuses an anchor whose
// window has since died (windowCurrent). The WEEK path did not: an anchor taken just
// before week_reset carries week_used ≈ cap, and the server kept adding to it AFTER the
// wall reset — so weekPct pinned at 1 and every cloud routine read "budget over" on a
// week that had just gone to zero. Blocked reif_tgp's whole fleet 2026-07-23 19:11–20:44
// CDT, until a fresh anchor happened to land.
test("week reset while anchor is stale: pre-reset week_used does not carry over", () => {
  const s = emptyStore();
  const wr = T - 600;              // week reset 10 min ago
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 3 * H, billed: 900e6 },  // pre-reset burn
    { surface: "laptop:a", root: "r2", ts: T - 300, billed: 2e6 },      // post-reset burn
  );
  // last anchor is 2h old (past TRUST, inside DEGRADE) and describes the DEAD week
  s.anchors.push({
    ts: T - 2 * H, five_pct: 0.1, week_pct: 0.99, five_reset: T + 2 * H, week_reset: wr,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 1290e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.surfaces.reduce((a2, x) => a2 + x.week_pct, 0), 99, "the live week is the post-reset burn, apportioned whole");
  assert.notEqual(b.verdict, "over");
  // the anchor's 99% describes a week that no longer exists — it must not be treated as live,
  // which is the whole reason the 2026-07-23 fleet block happened
  assert.equal(b.usage_week_live, false, "a reset week's old reading is not a live wall");
});

// The cap is implied from Anthropic's %, so an anchor that repeats the SAME % must produce the
// SAME cap — a probe (pct only, no sl block) cannot move it. That is what keeps the CLI and the
// server on one ruler without a constant to agree on.
test("the implied cap is stable across anchors carrying the same %", () => {
  const s = emptyStore();
  const wr = T + 3 * 86400;
  // 60M burned this week — the ledger the OLD code divided by a coarse 9% to get a tiny cap
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 3600, billed: 60e6 });
  s.anchors.push({
    ts: T - 1800, five_pct: 0.05, week_pct: 0.09, five_reset: T + 3 * H, week_reset: wr,
    sl: { five_used: 5e6, five_cap: 130e6, to_spend: 20e6, over: 0, week_used: 60e6, week_cap: 670e6 },
  });
  const before = computeBudget(s, T);
  assert.equal(before.usage_week_pct, 0.09, "their reading, unmediated");
  // a probe lands 20 min later — pct only, NO sl (server/probe.mjs shape)
  s.anchors.push({ ts: T + 1200, five_pct: 0.05, week_pct: 0.09, five_reset: T + 3 * H, week_reset: wr, sl: null, src: "probe" });
  const after = computeBudget(s, T + 1200);
  assert.equal(after.usage_week_pct, before.usage_week_pct, "same %; a probe cannot move it");
  assert.equal(after.block_share_pct, before.block_share_pct, "so the block share is stable too");
});

// lucky2, 2026-08-11: reif_tgp had billed 1.377B against a 1e9 tank, so `week` pinned at 1.0
// and every account_pool pass read "gated:week" all night with the real weekly at 2%. Nothing
// in the payload may impose a ceiling of its own — the ledger can be any size, and the only
// reading that means anything is Anthropic's.
test("a ledger far past any invented ceiling still reads healthy on the real numbers", () => {
  const s = emptyStore();
  const wr = T + 3 * 86400;
  s.events.push({ surface: "lucky2:m", root: "r1", ts: T - 3600, billed: 1_377_368_673 });
  s.anchors.push({ ts: T - 600, five_pct: 0.03, week_pct: 0.02, five_reset: T + 2 * H, week_reset: wr });
  const b = computeBudget(s, T);
  assert.equal(b.week, undefined, "no self-set standing ships at all — that was the fiction");
  assert.equal(b.usage_week_pct, 0.02, "the real weekly is 2%, and must be readable");
  assert.equal(b.verdict, "ok", "1.377B billed is not a wall; 2% of the real week is the truth");
  assert.ok(b.block_share_pct > 0, `the fleet must have a share, got ${b.block_share_pct}`);
  assert.equal(b.usage_five_pct, 0.03);
  assert.equal(b.usage_week_live, true, "week_reset is ahead of now → a live reading");
  assert.equal(b.usage_five_live, true);
});

// BLIND is not EMPTY: with no anchor there is no real reading, and a gate must be able to
// tell that apart from "the real limit says 0%". Null, never 0.
test("no anchor → the /usage pcts are null, not zero", () => {
  const b = computeBudget(emptyStore(), T);
  assert.equal(b.usage_week_pct, null);
  assert.equal(b.usage_five_pct, null);
  assert.equal(b.usage_week_live, false);
});

// A reading whose window has already reset describes a DEAD window (the 2026-07-23
// reif_tgp false-over). The pct still ships — a caller may want it — but `live` is false
// so nobody re-blocks a fresh window with last week's 99%.
test("an anchor whose window already reset reads not-live", () => {
  const s = emptyStore();
  s.anchors.push({ ts: T - 8 * 86400, five_pct: 0.99, week_pct: 0.99, five_reset: T - 7 * 86400, week_reset: T - 6 * 86400 });
  const b = computeBudget(s, T);
  assert.equal(b.usage_week_pct, 0.99, "the reading still ships");
  assert.equal(b.usage_week_live, false, "but its window is dead — never a fresh block");
  assert.equal(b.usage_five_live, false);
});

// ---------------------------------------------------------------------------
// The coin tank does not get a vote on `verdict` (Reif, 2026-08-13: "the only limits are
// the built in session and weekly limits by claude").
//
// Live that day, both fleet accounts, same minute — verdict=over from `weekPct >= 1` alone:
//
//   reif_tgp  week_billed 1.377B vs OUR 1B cap   Anthropic's real week: 100%
//   reif      week_billed 1.405B vs OUR 1B cap   Anthropic's real week:  82%
//
// The second account had 242M real tokens it was not permitted to spend, and every consumer
// of this field read "over" and stopped. A counter that can deny is a limit nobody agreed to.
// ---------------------------------------------------------------------------

test("a spent coin tank is NOT over while Anthropic's real windows have room", () => {
  const s = emptyStore();
  // 1.4B billed against a 1B configured cap -> weekPct pins at 1.0 (the old `over` trigger)
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 4 * H, billed: 1_405_000_000 });
  // ...while Anthropic's own anchor says 82% of the real week, 26% of the 5h window
  s.anchors.push({ ts: T - 60, five_pct: 0.26, week_pct: 0.82, five_reset: T + 2 * H, week_reset: T + 112 * H });
  const b = computeBudget(s, T);
  assert.notEqual(b.verdict, "over", "the coin tank denied an account Anthropic still allows");
  assert.equal(b.verdict, "ok");
});

test("Anthropic's own wall is still absolute", () => {
  for (const [label, anchor] of [
    ["weekly", { five_pct: 0.1, week_pct: 0.99 }],
    ["5h", { five_pct: 0.99, week_pct: 0.1 }],
  ]) {
    const s = emptyStore();
    s.events.push({ surface: "laptop:a", root: "r1", ts: T - 4 * H, billed: 1e6 });
    s.anchors.push({ ts: T - 60, ...anchor, five_reset: T + 2 * H, week_reset: T + 86400 });
    assert.equal(computeBudget(s, T).verdict, "over", `${label} wall no longer stops anything`);
  }
});

// ---------------------------------------------------------------------------
// Retention (2026-08-13). Found by deploying: reif_tgp's doc had grown to 82,150 events /
// 36MB, and every single budget request parsed and re-scanned all of it —
//
//   $ curl -o /dev/null -w "%{time_total}" http://127.0.0.1:8791/api/u/reif_tgp/budget
//   26.616729s      (at the ORIGIN, inside the VM)
//
// which the edge served as intermittent 502s and every client read as "unreachable". The 6s
// client timeouts that started this hunt were not wrong about the symptom.
//
// The odometer must not move when history is dropped, or retention becomes a silent data bug.
// ---------------------------------------------------------------------------

test("compaction drops old events without moving the lifetime odometer", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 200 * 24 * H, billed: 500e6 });  // ancient
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 60 * 24 * H, billed: 300e6 });   // old
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 7e6 });           // current
  s.anchors.push({ ts: T - 60, five_pct: 0.2, week_pct: 0.3, five_reset: T + H, week_reset: T + 86400 });
  const before = computeBudget(s, T);

  compact(s, T);

  assert.equal(s.events.length, 1, "events outside retention must be dropped");
  const after = computeBudget(s, T);
  assert.equal(after.lifetime_billed, before.lifetime_billed, "the odometer rolled backwards");
  assert.deepEqual(after.surfaces, before.surfaces, "the live windows changed");
});

test("compaction is idempotent — running it twice changes nothing further", () => {
  const s = emptyStore();
  s.events.push({ surface: "a", root: "r", ts: T - 90 * 24 * H, billed: 1e6 });
  s.events.push({ surface: "a", root: "r", ts: T - H, billed: 2e6 });
  compact(s, T);
  const once = { base: s.lifetime_base, n: s.events.length };
  compact(s, T);
  assert.deepEqual({ base: s.lifetime_base, n: s.events.length }, once);
});

test("anchors are capped on every path, not just the probe's", () => {
  const s = emptyStore();
  for (let i = 0; i < 900; i++) s.anchors.push({ ts: T - i * 60, five_pct: 0.1, week_pct: 0.2, five_reset: T + H, week_reset: T + 86400 });
  compact(s, T);
  assert.equal(s.anchors.length, 500, "reif reached 39,852 anchors this way");
  assert.equal(s.anchors[s.anchors.length - 1].ts, T - 899 * 60, "the tail kept must be contiguous");
});

test("a store inside retention is left completely alone", () => {
  const s = emptyStore();
  s.events.push({ surface: "a", root: "r", ts: T - 3 * H, billed: 5e6 });
  compact(s, T);
  assert.equal(s.events.length, 1);
  assert.equal(s.lifetime_base, 0);
});

test("compaction keeps the last 10k events even when they are all inside the time window", () => {
  const s = emptyStore();
  for (let i = 0; i < 10_001; i++) {
    s.events.push({ surface: "a", root: "r", ts: T - H + i, billed: 1e3 });
  }
  const before = computeBudget(s, T);
  compact(s, T);
  assert.equal(s.events.length, 10_000, "the 10,001st oldest must roll off");
  assert.equal(s.events[0].ts, T - H + 1, "the oldest kept is the 2nd-oldest written");
  const after = computeBudget(s, T);
  assert.equal(after.lifetime_billed, before.lifetime_billed, "the odometer rolled backwards");
});

// ---------------------------------------------------------------------------
// A budget read never waits on a recompute (Reif, 2026-08-13: "the delay is 0, and the worst
// case is the next one uses up all the tokens and is stopped by the wall").
//
// The number is a COUNTER. Being one pass out of date costs at most one overspend, which
// Anthropic's wall stops by itself. Being slow cost the fleet 26 hours: 22-27s per call →
// edge 502s → client timeouts → "unreachable" → tier=standby → nothing spawned.
// ---------------------------------------------------------------------------

test("a second read is served instantly from the last reading, not recomputed", async () => {
  let loads = 0;
  const slowStore = {
    async load() { loads++; await new Promise((r) => setTimeout(r, 60)); return emptyStore(); },
    async save() {},
  };
  // The clock MUST advance between the two reads, or the same-second shortcut answers and the
  // stale path — the one under test — never runs. (It passed for that wrong reason first.)
  let clock = T;
  const h = createHandler({ store: slowStore, now: () => clock });

  const first = Date.now();
  await h({ method: "GET", url: "/api/u/x/budget", headers: {} });
  const coldMs = Date.now() - first;

  clock = T + 30;                      // a later second: same data, stale memo
  const second = Date.now();
  await h({ method: "GET", url: "/api/u/x/budget", headers: {} });
  const warmMs = Date.now() - second;

  assert.ok(coldMs >= 50, `the cold read should have paid the load cost, took ${coldMs}ms`);
  assert.ok(warmMs < 25, `a warm read waited ${warmMs}ms — the whole point is that it does not`);
  assert.equal(loads, 2, "the background refresh should still have been kicked off");
});

test("concurrent readers share one recompute instead of stampeding the parse", async () => {
  let loads = 0;
  const slowStore = {
    async load() { loads++; await new Promise((r) => setTimeout(r, 40)); return emptyStore(); },
    async save() {},
  };
  const h = createHandler({ store: slowStore, now: () => T });
  await Promise.all(Array.from({ length: 8 }, () => h({ method: "GET", url: "/api/u/x/budget", headers: {} })));
  assert.equal(loads, 1, `8 cold readers caused ${loads} parses of a 37MB doc`);
});

test("a failed refresh serves the last good reading rather than nothing", async () => {
  let calls = 0;
  const flakyStore = {
    async load() { if (++calls > 1) throw new Error("disk gone"); return emptyStore(); },
    async save() {},
  };
  const h = createHandler({ store: flakyStore, now: () => T });
  const ok = await h({ method: "GET", url: "/api/u/x/budget", headers: {} });
  assert.equal(ok.status, 200);
  const after = await h({ method: "GET", url: "/api/u/x/budget", headers: {} });
  assert.equal(after.status, 200, "a broken refresh must not take the endpoint down with it");
});

// ---------------------------------------------------------------------------
// The three marks a session shows, all on ONE denominator (Reif, 2026-08-13: "it should show
// your session usage, the hard wall, and the wall that we recommend").
// ---------------------------------------------------------------------------

const anchored = (over) => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 14e6 });   // this 5h block
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 3 * 24 * H, billed: 1.5e9 }); // this week
  s.anchors.push({ ts: T - 60, five_pct: 0.46, week_pct: over ? 0.99 : 0.86,
                   five_reset: T + 2 * H, week_reset: T + 96 * H });
  return computeBudget(s, T);
};

test("session usage, advised wall and hard wall are comparable numbers", () => {
  const b = anchored(false);
  assert.equal(b.session_wall_pct, 100, "the hard wall must be stated, never inferred");
  assert.equal(b.session_used_pct, 46, "usage is Anthropic's own 5h percentage");
  assert.ok(b.session_advised_pct > 0 && b.session_advised_pct < 100);
});

test("the advised wall is never the whole 5h window", () => {
  // Even on a nearly-untouched week, where the weekly share would cover the entire window:
  const s = emptyStore();
  s.events.push({ surface: "a", root: "r", ts: T - H, billed: 1e6 });
  s.anchors.push({ ts: T - 60, five_pct: 0.02, week_pct: 0.02, five_reset: T + 2 * H, week_reset: T + 6 * 24 * H });
  const b = computeBudget(s, T);
  assert.ok(b.session_advised_pct <= 85,
    `advised ${b.session_advised_pct}% — 5h windows are not evenly paced, so the wall is never the plan`);
});

test("a spent week pulls the advised wall down, not the hard one", () => {
  const healthy = anchored(false).session_advised_pct;
  const spent = anchored(true).session_advised_pct;
  assert.ok(spent < healthy, `advised should tighten as the week runs out (${spent} vs ${healthy})`);
  assert.equal(anchored(true).session_wall_pct, 100, "Anthropic's wall does not move");
});

test("no live anchor yields nulls, not a fabricated recommendation", () => {
  const s = emptyStore();
  s.events.push({ surface: "a", root: "r", ts: T - H, billed: 1e6 });
  const b = computeBudget(s, T);
  assert.equal(b.session_advised_pct, null);
  assert.equal(b.block_share_pct, null);
});

// ---- surfaces[] is capped, and the tail is SUMMED, not dropped -------------------------------
// Measured live 2026-08-17: 325 rows / 32,775 bytes of a 32,797-byte payload -- 99.9% of it,
// ~8,200 tokens. Every agent is told to call maxx_budget before token-expensive work, so ASKING
// how much of the week was left had become a real line item in the week. 281 rows were one-shot
// builder worktrees that will never exist again, and the list only ever grows.

test("surfaces[] is capped and the tail is aggregated into one row, never dropped", () => {
  const s = emptyStore();
  // 60 surfaces, descending burn: 60e6, 59e6, ... 1e6. Total 1830e6.
  for (let i = 60; i >= 1; i--) {
    s.events.push({ surface: `laptop:s${String(i).padStart(2, "0")}`, root: "r", ts: T - 600, billed: i * 1e6 });
  }
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.5, five_reset: T + 4 * H, week_reset: T + 3 * 86400,
  });
  const b = computeBudget(s, T);

  assert.equal(b.surfaces.length, 26, "25 named surfaces + exactly one aggregate row");
  const agg = b.surfaces[b.surfaces.length - 1];
  assert.equal(agg.aggregated, 35, "60 surfaces - 25 named = 35 folded into the tail");
  assert.match(agg.surface, /35 more surfaces/);

  // CONSERVATION: the column must still add up to the account's real week. Dropping the tail
  // would have silently deleted a third of the week's spend from a payload whose entire job is
  // answering "where did it go".
  const total = b.surfaces.reduce((a, r) => a + r.week_pct, 0);
  assert.ok(Math.abs(total - 50) < 0.5, `surfaces must still sum to the real 50% of week, got ${total}`);

  // The named rows are the BIGGEST ones -- a cap that kept an arbitrary 25 would be useless.
  assert.equal(b.surfaces[0].surface, "laptop:s60");
  assert.ok(b.surfaces[24].week_pct >= agg.week_pct / 35,
    "every named row must outrank the average tail row");
});

test("no aggregate row appears when the surfaces fit under the cap", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r", ts: T - 600, billed: 10e6 });
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400,
  });
  const b = computeBudget(s, T);
  assert.equal(b.surfaces.length, 1);
  assert.ok(!("aggregated" in b.surfaces[0]), "a short list must not grow a synthetic row");
});
