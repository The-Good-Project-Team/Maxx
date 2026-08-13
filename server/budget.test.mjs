// The 5h limit is a fixed window (zeroes at five_reset), not a rolling sum — burn
// from before the wall reset must not count against the fresh window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore, computeBudget, applyEnvelope, COINS_MAX, compact } from "./tally.mjs";

const T = 1_800_000_000, H = 3600;
const FIVE_SUB = Math.round((COINS_MAX * 5 * H) / (7 * 24 * H)); // 5h even-pace share ≈ 29.76M

test("five window is anchor-aligned: pre-reset burn does not carry over", () => {
  const s = emptyStore();
  // window started 1h ago (resets in 4h); 100M burned before it, 8M inside it
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 100e6 },
    { surface: "laptop:a", root: "r2", ts: T - 0.5 * H, billed: 8e6 },
  );
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400 });
  const b = computeBudget(s, T);
  assert.equal(b.five_billed, 8e6);
  // cap anchored against the same window: 8M at anchor / 10% = 80M
  assert.ok(Math.abs(b.five_billed / 0.1 - 80e6) < 1e5, `cap sane, got quota=${b.quota}`);
});

// Coin model: the counts ARE the ledger's own windowed sums, and the cap is the fixed
// tank — an sl anchor's own numbers no longer override either (that inference was the
// low-% blow-up). The CLI computes from the same constant, so they agree by construction.
test("coin model: counts are the ledger's windowed sums, cap is the fixed tank", () => {
  const s = emptyStore();
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 50e6 },   // in the week window, not the 5h one
    { surface: "laptop:a", root: "r2", ts: T - 100, billed: 2e6 },      // inside both windows
  );
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 120e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  // five window began at five_reset − 5h = T−1h, so the T−2h event is out; only 2M is in it.
  assert.equal(b.five_billed, 2e6);
  assert.equal(b.week_billed, 52e6);           // ledger sum, NOT the sl passthrough 122M
  assert.equal(b.week_cap_tokens, COINS_MAX);  // fixed tank, NOT sl's 1300M
  assert.equal(b.weekly_left_tokens, COINS_MAX - 52e6);
  assert.ok(Math.abs(b.week - 52e6 / COINS_MAX) < 1e-9);
});

// The week bar's ╎ mark is drawn from week_bank; a null bank silently erases it while the
// legend keeps promising "╎ = even pace". Bank is the CLI's ruler: cap×elapsed − used.
test("week_bank is the even-pace bank: cap×elapsed − used, + when under pace", () => {
  const s = emptyStore();
  // 3 days into the week (resets in 4), so even pace would have spent 3/7 of the tank.
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 100e6 });
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.1, five_reset: T + 4 * H, week_reset: T + 4 * 86400 });
  const b = computeBudget(s, T);
  const expected = COINS_MAX * (3 / 7) - 100e6;
  assert.ok(b.week_bank != null, "a live week reset must yield a bank — null erases the pace mark");
  assert.ok(Math.abs(b.week_bank - expected) < 1e6, `bank ${b.week_bank} ≉ ${expected}`);
  assert.ok(b.week_bank > 0, "spent 100M where even pace allows ~429M → banked, so positive");
});

test("week_bank goes negative once burn outruns the even-pace line", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 800e6 });
  s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.8, five_reset: T + 4 * H, week_reset: T + 4 * 86400 });
  assert.ok(computeBudget(s, T).week_bank < 0, "800M spent against a ~429M even-pace line is over pace");
});

// A sentinel reset (seen live: resets_at = 9999999999) collapses elapsed toward 0, which
// flips the bank's sign. Suppress it rather than draw the mark in the wrong place.
test("week_bank is suppressed when the week reset is missing or a far-future sentinel", () => {
  const mk = (weekReset) => {
    const s = emptyStore();
    s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 100e6 });
    s.anchors.push({ ts: T - 600, five_pct: 0.1, week_pct: 0.1, five_reset: T + 4 * H, week_reset: weekReset });
    return computeBudget(s, T).week_bank;
  };
  assert.equal(mk(0), null, "no reset → no elapsed → no mark");
  assert.equal(mk(9999999999), null, "a sentinel reset must not fabricate an elapsed");
});

test("net_per_min = sustainable weekly pace − recent burn (the pace model)", () => {
  const s = emptyStore();
  const wr = T + 100000; // week resets in 100000s
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 3000, billed: 20e6 },  // in 5h window, not last 5m
    { surface: "laptop:a", root: "r2", ts: T - 100, billed: 1.5e6 },  // last 5m → burn_5m
  );
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: wr,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 100e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.burn_5m, 1.5e6);
  // sustainable = weekly_left ÷ minutes-to-week-reset; net = sustainable − burn_5m/5
  const sustainable = b.weekly_left_tokens / ((wr - T) / 60);
  assert.equal(b.sustainable_per_min, Math.round(sustainable));
  assert.equal(b.net_per_min, Math.round(sustainable - b.burn_5m / 5));
});

test("coin-spree = 85–97% of the estimated Anthropic 5h room; burst is the top of the band", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r2", ts: T - 100, billed: 1.5e6 });
  s.anchors.push({
    ts: T - 600, five_pct: 0.1, week_pct: 0.2, five_reset: T + 4 * H, week_reset: T + 3 * 86400,
    sl: { five_used: 8e6, five_cap: 80e6, to_spend: 30e6, week_used: 100e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.five_billed, 1.5e6);
  const estCap = 1.5e6 / 0.1;                                          // 15M implied 5h capacity
  assert.equal(b.coin_spree_low, Math.round(0.85 * estCap - 1.5e6));   // 11.25M — floor of the band
  assert.equal(b.coin_spree_high, Math.round(0.97 * estCap - 1.5e6));  // 13.05M — never 100%
  assert.equal(b.session_burst, b.coin_spree_high, "burst is the top of the spree");
  assert.ok(b.coin_spree_low < b.coin_spree_high, "it's a range");
  assert.ok(b.session_to_spend <= b.session_burst, "the remainder is never above the spree top");
});

test("a low 5h % is too noisy to divide — burst falls back to the whole remaining tank", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 100, billed: 5e6 });
  s.anchors.push({ ts: T - 60, five_pct: 0.01, week_pct: 0.1, five_reset: T + 4 * H, week_reset: T + 6 * 86400 });
  const b = computeBudget(s, T);
  assert.equal(b.session_burst, COINS_MAX - 5e6, "≤2% 5h ⇒ no estimate; burst = remaining tank");
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
  assert.ok(b.weekly_left_tokens > 0, `weekly tank readable, got ${b.weekly_left_tokens}`);
  assert.ok(b.session_to_spend > 0, `paced standing readable, got ${b.session_to_spend}`);
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
    { surface: "laptop:a", root: "r1", ts: T - 2 * H, billed: 50e6 },  // pre-reset (dead window)
    { surface: "laptop:a", root: "r2", ts: T - 600, billed: 3e6 },     // post-reset (new window)
  );
  // anchor 30m old (still FRESH) but its five_reset passed 20m ago
  s.anchors.push({
    ts: T - 1800, five_pct: 0.9, week_pct: 0.2, five_reset: T - 1200, week_reset: T + 3 * 86400,
    sl: { five_used: 70e6, five_cap: 80e6, to_spend: 0, week_used: 120e6, week_cap: 1300e6 },
  });
  const b = computeBudget(s, T);
  assert.equal(b.five_billed, 3e6, "new window counts from the known reset, not the dead window");
  // sl to_spend=0 described the DEAD window — must not gate the fresh one to zero
  assert.ok(b.session_to_spend > 0, `fresh window has allowance, got ${b.session_to_spend}`);
  // weekly window survives the 5h reset; week = the ledger's own sum (both events, coin units)
  assert.equal(b.week_billed, 50e6 + 3e6);
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

  // No anchor: five_billed is then the raw ledger window, which is exactly what the
  // ts fallback has to land inside. With the old ts 0 this read 0 — the spend was real
  // but the 5h gate could not see a token of it.
  const b = computeBudget(s, T);
  assert.equal(b.five_billed, 8e6, "the spend is visible to the 5h gate");
  assert.equal(b.lifetime_billed, 8e6, "and is not double-counted in lifetime");
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
  assert.ok(b.session_to_spend > 0, `weekly-paced share governs, got ${b.session_to_spend}`);
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
  assert.ok(b.weekly_left_tokens > 0, `weekly standing must survive, got ${b.weekly_left_tokens}`);
  assert.ok(b.session_to_spend != null, "session_to_spend must be computable from the weekly wall");
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
  assert.ok(b.session_to_spend > 0);
});

// THE FIX, on real numbers: reif_tgp on 2026-07-24 sat at 15% of its week per Anthropic,
// having burned ~61.5M coins. The OLD code inferred cap = 61.5M ÷ 0.15 ≈ 408M, paced that
// tiny cap to session_to_spend 0, and returned "over" — hard-blocking its 6 live cloud
// routines at 15% weekly usage. A fixed tank makes 61.5M of 1B plainly fine.
test("reif_tgp false-over dissolves under the coin tank (over → ok)", () => {
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
  assert.ok(b.session_to_spend > 0, `fleet has allowance, got ${b.session_to_spend}`);
  assert.equal(b.week_cap_tokens, COINS_MAX);
  assert.equal(b.week_used_tokens, 61.5e6);
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
test("a held reserve throttles to_spend but does not flip the verdict", () => {
  const s = emptyStore();
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 600, billed: 20e6 }); // healthy week
  s.anchors.push({ ts: T - 60, five_pct: 0.1, week_pct: 0.1, five_reset: T + 4 * H, week_reset: T + 6 * 86400 });
  s.leases = [{ tokens: 100e6, expires: T + 3600, label: "fan-out" }];          // reserve exceeds the window's paced share
  const b = computeBudget(s, T);
  assert.equal(b.verdict, "ok", `healthy week with a held lease must not read over, got ${b.verdict}`);
  assert.equal(b.reserved_tokens, 100e6);
  assert.equal(b.session_to_spend, 0, "a share-exceeding reserve zeroes to_spend — but the verdict stays ok");
});

// Front-loading one 5h window past its even-pace coin share must not hard-block the account
// when the WEEK is healthy and Anthropic's real wall is nowhere near. reif_tgp maxed its 29.76M
// 5h share with 815M week left + real 5h at 2% and hard-skipped a QA run — that was the bug.
test("maxing the 5h even-pace share throttles to_spend but does not flip the verdict", () => {
  const s = emptyStore();
  const wr = T + 2 * 86400, fr = T + 3 * H;
  s.events.push(
    { surface: "laptop:a", root: "r1", ts: T - 30 * H, billed: 150e6 },  // healthy week, ~818M left
    { surface: "laptop:a", root: "r2", ts: T - 600, billed: 32e6 },      // this window blew past the ~29.76M share
  );
  s.anchors.push({ ts: T - 60, five_pct: 0.02, week_pct: 0.18, five_reset: fr, week_reset: wr });
  const b = computeBudget(s, T);
  assert.equal(b.quota, 1, "the 5h coin sub-cap is maxed");
  assert.equal(b.verdict, "ok", `healthy week + maxed 5h share must not read over, got ${b.verdict}`);
  // the remainder is SHOWN, not zeroed by a front-loaded window — routines pace against it, Anthropic limits
  assert.ok(b.session_to_spend > 0, `remainder must stay positive with 800M+ left, got ${b.session_to_spend}`);
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
  assert.equal(b.week_used_tokens, 2e6, "week counts only post-reset burn");
  assert.notEqual(b.verdict, "over");
  assert.ok(b.session_to_spend > 0, `expected headroom, got ${b.session_to_spend}`);
});

// The cap is the fixed coin tank — no anchor (sl or probe) resizes it, so there is nothing
// for the CLI and server to disagree ON. This subsumes the whole class of "cap re-derived
// to a different number" bugs: a low % simply can't move a constant.
test("the cap is the fixed tank — sl and probe anchors never resize it", () => {
  const s = emptyStore();
  const wr = T + 3 * 86400;
  // 60M burned this week — the ledger the OLD code divided by a coarse 9% to get a tiny cap
  s.events.push({ surface: "laptop:a", root: "r1", ts: T - 3600, billed: 60e6 });
  s.anchors.push({
    ts: T - 1800, five_pct: 0.05, week_pct: 0.09, five_reset: T + 3 * H, week_reset: wr,
    sl: { five_used: 5e6, five_cap: 130e6, to_spend: 20e6, over: 0, week_used: 60e6, week_cap: 670e6 },
  });
  const before = computeBudget(s, T);
  assert.equal(before.week_cap_tokens, COINS_MAX, "cap is the tank, not sl's 670M");
  // a probe lands 20 min later — pct only, NO sl (server/probe.mjs shape)
  s.anchors.push({ ts: T + 1200, five_pct: 0.05, week_pct: 0.09, five_reset: T + 3 * H, week_reset: wr, sl: null, src: "probe" });
  const after = computeBudget(s, T + 1200);
  assert.equal(after.week_cap_tokens, COINS_MAX, "still the tank — a probe cannot re-derive a cap");
  assert.equal(after.weekly_left_tokens, COINS_MAX - 60e6, "left = tank − ledger, stable across anchors");
});

// The coin pcts are OUR tank; the /usage pcts are Anthropic's. A fleet that outspends the
// tank pins `week` at 1.0 while the real subscription is untouched — lucky2 2026-08-11:
// reif_tgp held 1.377B coins against the 1e9 tank and every account_pool pass read
// "gated:week" all night with the real weekly at 0%. A caller that hard-stops an account
// needs the real reading, and until now the payload simply did not carry it.
test("the payload carries Anthropic's real /usage pcts, distinct from the coin tank", () => {
  const s = emptyStore();
  const wr = T + 3 * 86400;
  s.events.push({ surface: "lucky2:m", root: "r1", ts: T - 3600, billed: 1_377_368_673 });
  s.anchors.push({ ts: T - 600, five_pct: 0.03, week_pct: 0.02, five_reset: T + 2 * H, week_reset: wr });
  const b = computeBudget(s, T);
  assert.equal(b.week, 1, "coins ÷ tank pins at 1 — the fiction that gated the fleet");
  assert.equal(b.usage_week_pct, 0.02, "the real weekly is 2%, and must be readable");
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
  assert.equal(after.week_billed, before.week_billed, "the weekly window changed");
  assert.equal(after.five_billed, before.five_billed, "the 5h window changed");
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
