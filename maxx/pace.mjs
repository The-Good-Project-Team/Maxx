/**
 * The WEEK line's pace token — pure decision, extracted so it's testable (render.mjs
 * runs main() and reads homedir() at import, so it can't be unit-tested in place).
 *
 * The week line answers ONE question: am I over? The "X left" token already answers it
 * (left > 0 → not over). This SECOND token is a PACE signal only: the even-pace bank,
 * cap×elapsed − used = how far ahead of / behind a straight-line burn through the week.
 *
 * It used to render as the word "over" in RED — the same word and colour the real,
 * fleet-halting cap verdict uses. So a −3.6M pace wobble against a 289M week (1.3%, pure
 * noise) read as "you breached your weekly cap" while 91% of the tank was still there.
 * That is the exact confusion that made the week status unreadable on 2026-07-24.
 *
 * Rules, so that can't happen again:
 *  - never the word "over" — "ahead pace" / "behind pace" (over belongs to the verdict);
 *  - behind pace is AMBER, not RED — RED is reserved for the actual over-budget verdict;
 *  - dead-banded: a deviation under 5% of the weekly cap is even-pace noise → show nothing.
 *
 * bankTokens and capTokens are in the same units. Returns null when nothing should render.
 * `pct` is the deviation as a signed whole-percent of the weekly cap — the compact display
 * unit ("−9%"): the raw k-magnitude ("−60,323k behind pace") was long AND meaningless to a
 * human, where "9% behind an even burn" is instantly legible in a third the width.
 */
export function weekPaceToken(bankTokens, capTokens) {
  if (!capTokens || capTokens <= 0) return null;
  if (Math.abs(bankTokens) <= capTokens * 0.05) return null; // on pace → no token at all
  const ahead = bankTokens >= 0;
  return {
    ahead,
    label: ahead ? "ahead pace" : "behind pace",
    role: ahead ? "good" : "warn", // good→green, warn→amber — never "danger"/red
    magnitude: Math.abs(bankTokens),
    pct: Math.round((Math.abs(bankTokens) / capTokens) * 100), // signed via `ahead`
  };
}

/**
 * A real rate-limit window never resets more than ~8 days out (the widest wall is 7d). A
 * resets_at beyond that is a "not-limited" sentinel — seen live on 2026-07-24 when a
 * setup-token probe payload carried resets_at = 9999999999 (year 2286). Left to stand it
 * poisoned the week row two ways: the days label rendered "95082d", and elapsed computed as
 * ≈0 so `cap×elapsed − used` turned 9% used into a phantom "−9% behind pace" (sign flipped —
 * the account was actually UNDER pace). It also won mergeWall's "later reset wins" race and
 * overwrote the real cached reset. Returns 0 for a sentinel, the reset unchanged otherwise.
 */
export function plausibleReset(reset, nowSec) {
  if (!reset || reset <= 0) return 0;
  return reset - nowSec <= 8 * 24 * 3600 ? reset : 0;
}

/**
 * Where a rate-limit window actually STARTED, in epoch seconds.
 *
 * The naive answer — resets_at − windowSpan — is right only for an account older than the
 * window. It silently fabricates a start otherwise, and that fabrication has shipped twice:
 * an account created 2026-09-10 rendered "week 2/65%" because resets_at−7d put the week's
 * start at Sep 6, four days before the account existed. True elapsed was ~5%.
 *
 * `bornSec` is Anthropic's accountCreatedAt. It is the only sound floor: no window can open
 * before its account does. It is NOT the local ledger's `since` (which restamps on login/dir
 * churn and has been observed a month stale) — anchoring the week to that caused the mirror
 * bug, "week 49/10%" on a months-old account with a 2-day-old ledger.
 *
 * Returns { start, span }. With no usable bornSec this is exactly the old behavior, so an
 * account older than the window (the common case) is unaffected.
 */
export function windowSpan(resetAt, winSec, bornSec) {
  const naive = resetAt - winSec;
  const start = bornSec > 0 ? Math.max(naive, bornSec) : naive;
  return { start, span: Math.max(1, resetAt - start) };
}

/**
 * Fraction of a window elapsed, clamped to 0..1, anchored by windowSpan.
 */
export function windowElapsed(resetAt, winSec, bornSec, nowSec) {
  const { start, span } = windowSpan(resetAt, winSec, bornSec);
  return Math.max(0, Math.min(1, (nowSec - start) / span));
}
