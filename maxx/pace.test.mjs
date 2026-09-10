// The week line's pace token. The bug (2026-07-24): a tiny even-pace wobble rendered as
// the word "over" in RED — the same word/colour the fleet-halting cap verdict uses — so
// "263M left · −3.6M over" read as a weekly breach when 91% of the tank remained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekPaceToken, plausibleReset, windowSpan, windowElapsed } from "./pace.mjs";

const CAP = 289e6; // reif_tgp's real weekly cap the day of the bug

test("the reproducer: a 3.6M behind-pace wobble is NOT called 'over' and is NOT red", () => {
  const t = weekPaceToken(-3.6e6, CAP); // 1.3% of cap — the exact screenshot number
  // 3.6M is inside the 5%-of-cap dead-band → it should not render at all
  assert.equal(t, null, "sub-band pace noise must print nothing, not a red 'over'");
});

test("behind pace beyond the band: amber, compact signed %, never 'over'/red", () => {
  const t = weekPaceToken(-30e6, CAP); // ~10% behind
  assert.ok(t, "a real deviation renders");
  assert.equal(t.role, "warn", "behind pace is amber (warn), never red (danger)");
  assert.notEqual(t.role, "danger");
  assert.equal(t.ahead, false);
  assert.equal(t.pct, 10, "30M / 289M ≈ 10% — the compact display unit");
  assert.equal(/over/.test(t.label), false, "the word 'over' must never appear");
});

test("ahead of pace beyond the band: green, signed % of cap", () => {
  const t = weekPaceToken(40e6, CAP);
  assert.equal(t.role, "good");
  assert.equal(t.ahead, true);
  assert.equal(t.pct, 14, "40M / 289M ≈ 14%");
});

test("dead-band: anything within ±5% of cap prints nothing (on pace)", () => {
  assert.equal(weekPaceToken(0, CAP), null);
  assert.equal(weekPaceToken(14e6, CAP), null);   // 4.8% ahead → still noise
  assert.equal(weekPaceToken(-14e6, CAP), null);  // 4.8% behind → still noise
  assert.ok(weekPaceToken(15e6, CAP), "5.2% ahead crosses the band");
  assert.ok(weekPaceToken(-15e6, CAP), "5.2% behind crosses the band");
});

test("no cap (uncalibrated) → no token, never a divide-by-zero deviation", () => {
  assert.equal(weekPaceToken(-30e6, 0), null);
  assert.equal(weekPaceToken(-30e6, null), null);
});

// The 2026-07-24 gmail incident: a setup-token probe payload carried resets_at = 9999999999,
// which rendered "95082d" and — because elapsed collapsed to ≈0 — a phantom "−9% behind pace"
// on an account /usage showed at 10% used, UNDER pace. plausibleReset is the guard.
test("the reproducer: a 9999999999 sentinel reset is rejected (→ 0)", () => {
  const now = 1784901980; // the incident's clock
  assert.equal(plausibleReset(9999999999, now), 0, "a 260-year-out reset is a sentinel, not a window");
});

test("a real weekly reset (~6 days out) passes through unchanged", () => {
  const now = 1784901980;
  const realReset = 1785456000; // reif_tgp's live reset that day — ~6.4d out
  assert.equal(plausibleReset(realReset, now), realReset, "a plausible reset must survive intact");
});

test("plausibleReset boundary: ≤8d passes, >8d is a sentinel", () => {
  const now = 1_000_000;
  assert.equal(plausibleReset(now + 8 * 86400, now), now + 8 * 86400, "exactly 8d out is still real");
  assert.equal(plausibleReset(now + 8 * 86400 + 1, now), 0, "one second past 8d is a sentinel");
  assert.equal(plausibleReset(0, now), 0, "no reset → 0");
});

// ── window start anchoring ────────────────────────────────────────────────────
// Regression: an account created 2026-09-10T10:23Z showed "week 2/65%" because the week
// start was computed as resets_at−7d = Sep 6 — four days before the account existed.
const WK = 7 * 24 * 3600;
const BORN = Date.parse("2026-09-10T10:23:18Z") / 1000;   // Anthropic accountCreatedAt
const RESET = 1789282800;                                  // observed seven_day.resets_at
const NOW = Date.parse("2026-09-10T20:30:38Z") / 1000;     // when the bad bar was seen

test("week elapsed is anchored at account creation, not resets_at−7d", () => {
  const pct = Math.round(windowElapsed(RESET, WK, BORN, NOW) * 100);
  // The account opened its window 10.1h ago and it resets in 68.6h, so 10.1/68.6 = 15%.
  // The bug rendered 65% — (now − (resets_at−7d)) / 7d, a span the account never lived in.
  assert.equal(pct, 15, `expected 15% elapsed for a 10h-old account, got ${pct}%`);
  assert.notEqual(pct, 65, "65% is the fabricated-start reading");
});

test("the fabricated start is rejected outright", () => {
  const { start } = windowSpan(RESET, WK, BORN);
  assert.ok(start >= BORN, "window start must never predate the account");
  assert.equal(start, BORN, "a young account anchors exactly at creation");
});

test("an account older than the window is unaffected (clamp is a no-op)", () => {
  const old = RESET - 90 * 24 * 3600;                      // 90d-old account
  const { start, span } = windowSpan(RESET, WK, old);
  assert.equal(start, RESET - WK, "old account keeps resets_at−7d");
  assert.equal(span, WK, "and a full 7d span");
});

test("no accountCreatedAt → exactly the old behavior", () => {
  const { start, span } = windowSpan(RESET, WK, 0);
  assert.equal(start, RESET - WK);
  assert.equal(span, WK);
});

test("elapsed stays within 0..1 at the window edges", () => {
  assert.equal(windowElapsed(RESET, WK, 0, RESET + 5000), 1, "past reset clamps to 1");
  assert.equal(windowElapsed(RESET, WK, 0, RESET - WK - 5000), 0, "before start clamps to 0");
});
