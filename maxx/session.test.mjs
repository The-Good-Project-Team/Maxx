import test from "node:test";
import assert from "node:assert/strict";
import { sessionShare, sessionShareLabel } from "./session.mjs";

const HOUR = 3600;

// Live numbers, account `reif`, 2026-08-13 20:00Z — the ones that made the old coin tank
// report "over" while 18% of the real week was still there.
const REIF = {
  weekPct: 0.82,
  weekResetInSec: 112.8 * HOUR,
  weekBilled: 1_405_413_743,
  fiveBilled: 82_205_334,
};

test("spreads what remains of the week across the 5h blocks left", () => {
  const s = sessionShare(REIF);
  assert.equal(s.blocksLeft, 23);                       // 112.8h / 5h, rounded up
  assert.ok(Math.abs(s.allowancePct - 0.18 / 23) < 1e-6);
});

test("a block that has used more than its share is warn, never a breach", () => {
  const s = sessionShare(REIF);
  assert.equal(s.onPace, false);   // 4.8% of the week spent in one block vs a 0.78% share
  assert.equal(s.role, "warn");    // amber: it borrows from later blocks, breaches nothing
});

test("session-over-session-limit is NOT the number — it would green-light eating the week", () => {
  // The rejected formula: this block used 25% of its 5h limit, so "75% left, spend away".
  // The share says otherwise, and the share is the one that survives six blocks in a row.
  const s = sessionShare(REIF);
  assert.ok(s.allowancePct < 0.01, "a healthy block's share of the week is under 1%");
  assert.ok(s.usedPct > s.allowancePct * 5, "the 5h-limit view would have called this fine");
});

test("the allowance rises as the week's last blocks arrive", () => {
  const early = sessionShare({ ...REIF, weekResetInSec: 112 * HOUR });
  const late = sessionShare({ ...REIF, weekResetInSec: 6 * HOUR });
  const last = sessionShare({ ...REIF, weekResetInSec: 2 * HOUR });
  assert.ok(late.allowancePct > early.allowancePct);
  assert.ok(last.allowancePct > late.allowancePct);
  // Inside the final block, the whole remainder of the week is this block's to spend.
  assert.ok(Math.abs(last.allowancePct - 0.18) < 1e-6);
});

test("a nearly-spent week leaves a nearly-zero allowance, not a negative one", () => {
  const s = sessionShare({ ...REIF, weekPct: 1.0 });
  assert.equal(s.allowancePct, 0);
  assert.equal(s.remainingPct, 0);
});

test("returns null rather than guessing when the inputs cannot answer", () => {
  assert.equal(sessionShare(), null);
  assert.equal(sessionShare({ ...REIF, weekPct: 0 }), null);        // no ratio to scale by
  assert.equal(sessionShare({ ...REIF, weekPct: 1.4 }), null);      // not a fraction
  assert.equal(sessionShare({ ...REIF, weekResetInSec: 0 }), null);
  assert.equal(sessionShare({ ...REIF, weekBilled: 0 }), null);
  assert.equal(sessionShare({ ...REIF, fiveBilled: "n/a" }), null);
});

test("every number is a percentage of one denominator, so the two sides compare", () => {
  const s = sessionShare(REIF);
  for (const k of ["allowancePct", "usedPct", "remainingPct"]) {
    assert.ok(s[k] >= 0 && s[k] <= 1, `${k} is not a 0..1 fraction of the week`);
  }
});

test("label keeps a decimal — whole percent would print 0% for every healthy block", () => {
  const s = sessionShare({ ...REIF, fiveBilled: 5_000_000 });
  assert.equal(sessionShareLabel(s), "0.8% of week this block · 0.3% used");
  assert.equal(sessionShareLabel(null), null);
});
