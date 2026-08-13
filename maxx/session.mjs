/**
 * The session marker: what share of the WEEK this 5h block is allowed to spend.
 *
 * The question a session line has to answer is "how much may I use right now", and the
 * obvious answer — session used ÷ session limit — is the wrong one. It says 100% is fine
 * every single block, because the 5h window refills. Spend to that number six blocks in a
 * row and the weekly limit is gone by Wednesday; the sessions that eat the future are all
 * individually "within limits". So this divides what remains of the WEEK by the number of
 * 5h blocks left before the week resets, and reports both sides in percent of the week:
 *
 *     allowancePct = weekLeftPct / blocksLeft      what this block may spend
 *     usedPct      = fiveBilled / weekLimitTokens  what this block has spent
 *
 * Everything is a percentage of one denominator (the weekly limit) so the two numbers can
 * be compared directly — the coin tank this replaced kept them in different units and in
 * its own invented currency, which is how both fleet accounts came to read "over" on
 * 2026-08-13 while one still had 18% of its real week.
 *
 * Only Anthropic's own limits are involved. There is no configured cap here to breach.
 */

const FIVE_HOURS_SEC = 5 * 3600;

/**
 * @param {object} u                    Anthropic's live /usage numbers, as maxx stores them.
 * @param {number} u.weekPct            0..1 utilization of the weekly limit.
 * @param {number} u.weekResetInSec     Seconds until the weekly limit resets.
 * @param {number} u.weekBilled         Tokens counted against the week so far.
 * @param {number} u.fiveBilled         Tokens counted against the CURRENT 5h block.
 * @returns {null|{allowancePct, usedPct, remainingPct, blocksLeft, onPace, role}}
 *   null when the inputs cannot support the answer (never a guessed one).
 */
export function sessionShare({ weekPct, weekResetInSec, weekBilled, fiveBilled } = {}) {
  const pct = Number(weekPct);
  const resetIn = Number(weekResetInSec);
  const billed = Number(weekBilled);
  const five = Number(fiveBilled);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 1) return null;   // 0 → no ratio to scale by
  if (!Number.isFinite(resetIn) || resetIn <= 0) return null;
  if (!Number.isFinite(billed) || billed <= 0) return null;
  if (!Number.isFinite(five) || five < 0) return null;

  // The weekly limit in tokens, implied by "billed is pct of it". Never configured, never
  // ours: if maxx under-counted, this comes out small and the allowance with it — the error
  // direction that spends less than allowed rather than more.
  const weekLimitTokens = billed / pct;

  // Whole blocks left, floored at 1: inside the final block, the rest of the week IS this
  // block's allowance. Without the floor a 12-minute remainder would multiply it 5x.
  const blocksLeft = Math.max(1, Math.ceil(resetIn / FIVE_HOURS_SEC));

  const weekLeftPct = Math.max(0, 1 - pct);
  const allowancePct = weekLeftPct / blocksLeft;
  const usedPct = five / weekLimitTokens;

  return {
    allowancePct,                                   // share of the WEEK this block may spend
    usedPct,                                        // share of the WEEK this block has spent
    remainingPct: Math.max(0, allowancePct - usedPct),
    blocksLeft,
    onPace: usedPct <= allowancePct,
    // amber, never red: outspending this block's share borrows from later blocks, it does
    // not breach anything. Red belongs to Anthropic's own wall, which enforces itself.
    role: usedPct <= allowancePct ? "good" : "warn",
  };
}

/**
 * One line for the session row: "0.8% of week this block · 0.3% used".
 * Percentages of the week run small (18% spread over 22 blocks is 0.8% each), so this
 * keeps one decimal — rounding to whole percent would print "0%" for every healthy block.
 */
export function sessionShareLabel(share) {
  if (!share) return null;
  const p = (x) => `${(x * 100).toFixed(1)}%`;
  return `${p(share.allowancePct)} of week this block · ${p(share.usedPct)} used`;
}

/**
 * The wall we RECOMMEND for this 5h window, as a percentage of that window.
 *
 * Converts the weekly share into the window's own denominator so it can sit beside
 * "used %" and "wall 100%" and be compared at a glance, then caps it below the hard wall.
 * The cap is not caution for its own sake: 5h windows are not spent evenly — you sleep
 * through some and burst through others — so planning every window to the wall assumes the
 * flattest possible week. And the 5h wall is a LOCKOUT: meeting it means finding out
 * mid-task, with the work half done.
 *
 * Mirrors blockShare() in server/tally.mjs. Two runtimes, one rule — if you change the margin
 * here, change it there, or the bar and the API will advise different numbers.
 */
export const WALL_MARGIN_PCT = 85;

export function advisedWall({ allowancePct, weekLimitTokens, fiveLimitTokens } = {}) {
  if (!(allowancePct >= 0) || !(weekLimitTokens > 0) || !(fiveLimitTokens > 0)) return null;
  const asWindowPct = ((allowancePct * weekLimitTokens) / fiveLimitTokens) * 100;
  return Math.round(Math.min(WALL_MARGIN_PCT, asWindowPct) * 10) / 10;
}
