/**
 * maxx tally — the pure server-side brain behind centralized budget.
 *
 * Ingests emit envelopes (from emit.mjs on-box, or the maxx MCP connector in the
 * cloud) into a per-handle store, and computes the budget the gate reads. No I/O,
 * no HTTP — the Netlify function / MCP server is a thin wrapper that persists the
 * store (e.g. Netlify Blobs keyed by handle) and calls these functions. Kept pure
 * so the whole pipeline is testable on-box with a real envelope.
 *
 * Design notes:
 * - The emitter ships DELTAS per root (new tokens since its cursor). The server
 *   SUMS them, deduped by (surface, cursor, root) so a re-sent batch is a no-op.
 * - First run ships ALL history (bulk backfill). Old records carry old `last_ts`,
 *   so they fall OUTSIDE the live 5h/weekly windows and never distort live budget —
 *   they're retained for true-up: reconciling cap estimates against past anchors.
 * - A token's effective time is its session-delta `last_ts`. For frequent deltas
 *   (last_ts ≈ now) this is accurate; for the one-time backfill it's coarse, but
 *   backfill records are historical and out-of-window anyway.
 * - Cap is anchored: at each observed `anchor`, cap = windowed_tokens ÷ pct. The
 *   latest fresh anchor wins; between anchors we hold the cap and extrapolate.
 */

const FIVE_H = 5 * 3600;
const WEEK = 7 * 24 * 3600;
// There is no tank. We used to set our own (COINS_MAX = 1e9 "coins") and pace against it;
// every account outspent it and every field derived from it pinned dead — reif_tgp read
// week=1.0 / session_to_spend=0 / coin_spree 0–0 on 2026-08-17 while Anthropic's real week
// was at 96% and its 5h window at 1%. A counter that reads empty forever is worse than no
// counter: fleets parse it as "no budget". So every limit here is now IMPLIED by Anthropic's
// own reading — limit = our billed window ÷ their %, in our units, null when unanchored.
export const ANCHOR_TRUST_SEC = 45 * 60; // matches the routines' staleness gate
// Past ANCHOR_TRUST_SEC the anchor no longer describes the live 5h window, but the
// weekly caps it calibrated move on a 7-day window — hours-old calibration still
// prices the weekly tank fine, and the server owns the full billed ledger from every
// surface regardless. So an aged anchor DEGRADES (weekly standing only) instead of
// blinding the account: only a laptop can read /usage, and a sleeping laptop used to
// hard-block every cloud routine. Past this, calibration is genuinely too old → stale.
const ANCHOR_DEGRADE_SEC = 12 * 3600;

const sec = (iso) => (iso ? Date.parse(iso) / 1000 : 0);

// This block's share of the week, as percentages of one denominator so the two compare.
// Returns nulls rather than guesses when there is no live weekly reading to divide.
function blockShare(anchor, weekBilled, weekReset, fiveBilled, now) {
  const pct = anchor && anchor.week_pct != null ? anchor.week_pct : null;
  const fivePct = anchor && anchor.five_pct != null ? anchor.five_pct : null;
  const resetIn = weekReset ? weekReset - now : null;
  const none = { block_share_pct: null, block_used_pct: null, blocks_left_week: null, on_pace: null,
                 session_used_pct: null, session_advised_pct: null, session_wall_pct: 100 };
  if (!pct || pct <= 0 || pct > 1 || !resetIn || resetIn <= 0 || !weekBilled) return none;

  const weekLimit = weekBilled / pct;                       // implied, never configured
  const blocksLeft = Math.max(1, Math.ceil(resetIn / FIVE_H));
  const share = Math.max(0, 1 - pct) / blocksLeft;
  const used = (fiveBilled || 0) / weekLimit;

  // THE THREE MARKS, all on ONE denominator — this 5h window — so a reader can compare them
  // without doing arithmetic (Reif, 2026-08-13: "it should show your session usage, the hard
  // wall, and the wall that we recommend"). Expressing the share as a % of the WEEK and the
  // usage as a % of the 5h WINDOW is the mistake that made pacing unreadable: 0.6% and 46%
  // look like a huge margin and are in fact the same side of the same line.
  //
  //   session_used_pct     where you are now, against Anthropic's 5h window
  //   session_advised_pct  the same share as above, converted into this window's terms
  //   session_wall_pct     Anthropic's hard 5h wall — always 100, stated so nothing infers it
  // The advised wall is NEVER the full 5h window, even when the weekly share would cover it
  // (Reif: "we dont recommend using all of the 5hr session limit because those limits are not
  // evenly paced"). Two reasons, both load-bearing:
  //   1. The 5h wall is a hard LOCKOUT. Planning to it means discovering it mid-task, with the
  //      work half-done and nothing to do but wait for the reset.
  //   2. 5h windows are not spent evenly. You sleep through some and burst through others, so
  //      a plan that plans every window to the wall is a plan that assumes the flattest
  //      possible week — which is the one week nobody has.
  // So the advice is the smaller of the weekly share and a margin below the wall.
  const WALL_MARGIN_PCT = 85;
  const fiveLimit = fivePct && fivePct > 0 ? (fiveBilled || 0) / fivePct : null;
  const advised = fiveLimit
    ? Math.min(WALL_MARGIN_PCT, ((share * weekLimit) / fiveLimit) * 100)
    : null;

  return {
    block_share_pct: Math.round(share * 1000) / 10,         // percent OF THE WEEK, one decimal
    block_used_pct: Math.round(used * 1000) / 10,           // percent OF THE WEEK
    blocks_left_week: blocksLeft,
    on_pace: used <= share,
    session_used_pct: fivePct != null ? Math.round(fivePct * 1000) / 10 : null,
    session_advised_pct: advised != null ? Math.round(advised * 10) / 10 : null,
    session_wall_pct: 100,
  };
}

export function emptyStore() {
  // webhooks: [{url, secret, headers, format}] · leases: [{id, tokens, expires, label}]
  // signal: last-notified state for transition webhooks · config: per-handle overrides
  // directives: [{id, session, surface, action, note, rise, created, expires, delivered_to}]
  // connector_tokens: [{id, token, label, created, revoked}] — the scoped credential the
  // claude.ai connector URL carries, so the account secret never has to travel in a query string
  // lifetime_base: billed total of events that compaction has already dropped, so the
  // lifetime odometer survives retention (see compact()).
  return { events: [], anchors: [], seen: {}, webhooks: [], leases: [], signal: null, config: {}, directives: [], ops: [], connector_tokens: [], lifetime_base: 0 };
}

// Ops ring: everything that happens ON the tally besides emits — MCP budget checks,
// reserve leases, directives, auth events. Capped so it can never bloat the store.
export function logOp(store, op, detail = "", now) {
  store.ops = store.ops || [];
  store.ops.push({ ts: Math.round(now), op, d: String(detail).slice(0, 120) });
  if (store.ops.length > 300) store.ops = store.ops.slice(-300);
}

/**
 * Merge one envelope into the store. Idempotent on (surface, cursor, root).
 * Returns { accepted, deduped, billed } — billed is the token sum actually
 * recorded by THIS call (dedupes excluded), so the emitting session can show
 * its human what just landed on the tally.
 */
export function applyEnvelope(store, env, now = Math.floor(Date.now() / 1000)) {
  let accepted = 0, deduped = 0, billed = 0;
  // A sender may ship neither first_ts/last_ts nor emitted_at, and Date.parse turns a
  // malformed one into NaN. Either way the old `sec(a) || sec(b)` chain stored ts 0 (or
  // NaN), and every window test in windowedBilled is `e.ts > lo` — so that spend became
  // INVISIBLE to the 5h and weekly gates while still counting in the lifetime odometer.
  // The budget then read higher than the account really had. Observed in production:
  // surface "cloud:mcloud-dispatch-20260721-1650" billed 8,000,000 stamped 1970-01-01.
  // Receipt time is the safe fallback: a slightly late timestamp is a rounding error,
  // an uncounted 8M is a blown budget.
  const at = (...vals) => { for (const v of vals) { const n = sec(v); if (Number.isFinite(n) && n > 0) return n; } return now; };
  const surface = env.surface || "unknown";
  const cursor = String(env.cursor ?? "");
  for (const s of env.sessions || []) {
    const key = `${surface}|${cursor}|${s.root}`;
    if (store.seen[key]) { deduped++; continue; }
    store.seen[key] = 1;
    store.events.push({
      surface,
      root: s.root,
      ts: at(s.last_ts, env.emitted_at),
      // when the batch STARTED. The emitter ships a per-session delta covering every
      // turn since its cursor, so without this the whole batch lands in the single
      // minute it finished — which is what made the 48-minute chart show 30M "in one
      // minute". Kept so consumers can spread a batch across the minutes it spans.
      ts0: at(s.first_ts, s.last_ts, env.emitted_at),
      billed: s.billed || 0,
      output: s.output || 0,
      by_model: s.by_model || {},
      // attribution + analytics metadata (optional on the wire, counts only)
      project: s.project || null,
      name: s.name || null,
      branch: s.branch || null,
      raw: s.raw || 0,
      cache_read: s.cache_read || 0,
      cache_write: s.cache_write || 0,
      tool_calls: s.tool_calls || 0,
      agent_turns: s.agent_turns || 0,
      errors: s.errors || 0,
      turns: s.turns || 0,
      ctx: s.ctx || 0,
      cost_per_action: s.cost_per_action || 0,
    });
    accepted++;
    billed += s.billed || 0;
  }
  if (env.anchor && (env.anchor.five_pct != null || env.anchor.week_pct != null)) {
    store.anchors.push({
      ts: sec(env.anchor.observed_at) || sec(env.emitted_at),
      five_pct: env.anchor.five_pct,
      week_pct: env.anchor.week_pct,
      five_reset: env.anchor.five_reset,
      week_reset: env.anchor.week_reset,
      // statusline passthrough (its units) — number-sanitized, everything optional
      sl: env.anchor.sl && Number(env.anchor.sl.week_cap) > 0 ? {
        five_used: Number(env.anchor.sl.five_used) || 0,
        five_cap: Number(env.anchor.sl.five_cap) || 0,
        to_spend: Number(env.anchor.sl.to_spend) || 0,
        over: Number(env.anchor.sl.over) || 0,
        week_used: Number(env.anchor.sl.week_used) || 0,
        week_cap: Number(env.anchor.sl.week_cap),
        // signed stats — Number() keeps negatives; null when the emitter predates them
        bank: Number.isFinite(Number(env.anchor.sl.bank)) && env.anchor.sl.bank != null ? Number(env.anchor.sl.bank) : null,
        net_per_min: Number.isFinite(Number(env.anchor.sl.net_per_min)) && env.anchor.sl.net_per_min != null ? Number(env.anchor.sl.net_per_min) : null,
      } : null,
    });
  }
  compact(store, now);
  return { accepted, deduped, billed };
}

// Retention. Nothing here reads an event older than the weekly window, but every request
// loaded and re-scanned all of them forever: reif_tgp's doc reached 82,150 events / 36MB and
// its budget call took 22-27s at the ORIGIN, which the edge turned into intermittent 502s and
// every client turned into "unreachable" — the 6s timeouts that started this whole hunt.
// reif had 39,852 anchors for the same reason: the probe path caps at 500, the PUSH path
// never capped at all.
//
// The odometer must not move: dropped events are summed into lifetime_base first, so
// lifetime_billed is identical before and after a compaction. Retention is deliberately much
// wider than the widest window that is actually read (7d), because a wrong retention silently
// changes numbers and a generous one only costs disk.
// 10 days, not 30. The widest window any reader uses is WEEK (7d); 30 days was picked to be
// "generous" and turned out to be the thing keeping 82,150 events resident — none of them old
// enough to age out, all of them re-scanned per request. 10d keeps three full days of margin
// past the only window that is read, and the lifetime odometer is unaffected either way
// (dropped billed goes to lifetime_base). MAXX_RETENTION_DAYS overrides for a box that wants
// a longer local history.
export const RETENTION_SEC = Number(process.env.MAXX_RETENTION_DAYS || 10) * 24 * 3600;
export const MAX_ANCHORS = 500;

export function compact(store, now) {
  const cutoff = now - RETENTION_SEC;
  if (store.events.length) {
    const keep = [];
    let dropped = 0;
    for (const e of store.events) {
      if (e.ts >= cutoff) keep.push(e);
      else dropped += e.billed || 0;
    }
    if (keep.length !== store.events.length) {
      store.lifetime_base = (store.lifetime_base || 0) + dropped;
      store.events = keep;
    }
  }
  // Anchors are readings, not history: only the newest matters, plus enough tail for the
  // sl-cap lookback. 500 is what the probe path already enforced.
  if (store.anchors.length > MAX_ANCHORS) store.anchors = store.anchors.slice(-MAX_ANCHORS);
  return store;
}

export const latestAnchor = (store) =>
  store.anchors.length ? store.anchors.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;

// The most recent anchor that carried the CLI's absolute caps (`sl`). A CAP is a weekly
// constant; a probe anchor (pct-only, from server/probe.mjs) or any sl-less anchor must
// NOT wipe it and force the server back to deriving cap = billed ÷ pct — that derivation
// is a DIFFERENT number than the CLI shows, and the two disagreeing was the whole bug.
// Caps are sticky (carried until a newer sl updates them); only readings are live.
export const latestSlAnchor = (store) => {
  let best = null;
  for (const x of store.anchors) if (x.sl && Number(x.sl.week_cap) > 0 && (!best || x.ts > best.ts)) best = x;
  return best;
};

// Seconds since the freshest anchor (Infinity when never anchored). Exported so the
// handler can decide to PULL one (server/probe.mjs) before the push goes stale.
export const anchorAgeSec = (store, now) => {
  const a = latestAnchor(store);
  return a ? now - a.ts : Infinity;
};

// Sum billed across all surfaces whose effective ts is within (lo, now].
const windowedBilled = (events, now, win, lo = now - win) => {
  let sum = 0;
  for (const e of events) if (e.ts > lo && e.ts <= now + 60) sum += e.billed;
  return sum;
};

// Anthropic's weekly limit is a FIXED window that zeroes at week_reset, not a rolling
// sum (limit.mjs computes weekUsed the same way — this is what makes tally == statusline).
// Start = week_reset − 7d, rolled forward if the reset has already passed.
const weekLoFor = (weekReset, now) => {
  let lo = weekReset - WEEK;
  while (lo + WEEK < now) lo += WEEK;
  return lo;
};

/**
 * Compute the budget the gate consumes. Shape-compatible with the board's
 * signals.budget. `now` in seconds.
 */
export function computeBudget(store, now) {
  const a = latestAnchor(store);
  const anchorAge = a ? now - a.ts : Infinity;
  const fresh = anchorAge <= ANCHOR_TRUST_SEC;

  // The 5h limit is ALSO a fixed window (zeroes at five_reset), not a rolling sum — a
  // rolling 5h right after a wall reset still carries the pre-wall burn and shows a
  // fresh window as ~full (dash said "+146,460k · 0 left" while the statusline was at
  // 8.5M). Window start = five_reset − 5h when the anchor's reset is still ahead of us;
  // stale/absent reset falls back to rolling (and the verdict is stale then anyway).
  const fr = a?.five_reset || 0;
  // fr ahead → current window began at fr−5h. fr already PASSED (wall reset since the
  // last anchor, no fresh one yet) → the new window began AT fr: count only events
  // after it, never the pre-reset burn. No usable fr → rolling fallback.
  const fiveLo = fr > now ? fr - FIVE_H : fr && now - fr < FIVE_H ? fr : undefined;
  let five = windowedBilled(store.events, now, FIVE_H, fiveLo);
  const wr = a?.week_reset || 0;
  let week = windowedBilled(store.events, now, WEEK, wr ? weekLoFor(wr, now) : undefined);

  // ── Percentages only. No token count reaches a caller. ────────────────────
  // We published token figures twice, and both were wrong in the same way: first against a
  // 1e9 tank we set ourselves, then implied from Anthropic's % (billed ÷ pct). Our ledger is
  // cache-weighted and does not agree with Anthropic's billing, so every token number we ever
  // printed was an estimate wearing a decimal point. Their % is the one reading that is not a
  // guess, so the payload is expressed in it and nothing else.
  //
  // ONE denominator throughout: percent OF THE WEEK. Block allowance, block spend, reserves
  // and per-surface burn all compare directly, with no arithmetic left to the reader.
  const weekPctReal = a && a.week_pct != null ? a.week_pct : null;
  const fivePctReal = a && a.five_pct != null ? a.five_pct : null;
  // A surface's share of the LEDGER, restated as a share of the real week. The ledger's
  // absolute magnitude is untrustworthy; the RATIO between two surfaces inside it is not, and
  // multiplying that ratio by Anthropic's % lands it on the only scale that means anything.
  // A 0% reading apportions nothing: 0 would read as 'this surface burned nothing', which is
  // the opposite of 'we cannot tell yet'. Null is the only honest answer.
  const pctOfWeek = (billed) => (weekPctReal > 0 && week > 0 ? Math.round((billed / week) * weekPctReal * 1000) / 10 : null);
  const pctOfFive = (billed) => (fivePctReal > 0 && five > 0 ? Math.round((billed / five) * fivePctReal * 1000) / 10 : null);
  // Anthropic's real utilization is the only wall. Honored only while the anchor's window is
  // still LIVE (fr/wr ahead of now); a stale anchor describing a dead, pre-reset window must
  // never re-block a fresh one (that was the 2026-07-23 reif_tgp false-over).
  const weekWallHit = a && a.week_pct >= 0.99 && wr > now;
  const fiveWallHit = a && a.five_pct >= 0.99 && fr > now;
  // The week bar's ╎ mark, in percent: how far the CLOCK is through the week, minus how far
  // the SPEND is. Positive = ahead of pace. Elapsed needs a LIVE reset — without one, or with
  // a sentinel far-future reset, elapsed collapses toward 0 and the mark lands sign-flipped,
  // so suppress it rather than draw it in the wrong place.
  const weekElapsed = wr > now && wr - now <= 8 * 24 * 3600
    ? Math.min(1, Math.max(0, 1 - (wr - now) / WEEK))
    : null;
  const weekElapsedPct = weekElapsed != null ? Math.round(weekElapsed * 1000) / 10 : null;
  const weekBankPct = weekElapsedPct != null && weekPctReal != null
    ? Math.round((weekElapsedPct - weekPctReal * 100) * 10) / 10
    : null;

  // #4 reservation leases: active leases subtract from the allowance other
  // callers see (the grantee tracks its own lease). Expired leases are ignored
  // here and pruned on write in the handler.
  const activeLeases = (store.leases || []).filter((l) => l.expires > now);
  // A lease holds a slice OF THE WEEK — same denominator as block_share_pct, so a dispatcher
  // subtracts it from its allowance without converting anything.
  const reservedPct = Math.round(activeLeases.reduce((acc, l) => acc + (l.pct || 0), 0) * 10) / 10;

  // "degraded" = no fresh /usage anchor, but the weekly standing is still computable
  // from our own ledger against the last known caps. Callers may proceed on it (weekly
  // wall and standing still apply); "stale" stays a hard stop — genuinely no signal.
  // Staleness is about the AGE of the reading, never about whether we could divide by it. An
  // account 0.1% into its week has a perfectly live anchor and simply no implied limit yet;
  // folding that into "stale" would fail closed on the healthiest possible account.
  const degradable = anchorAge <= ANCHOR_DEGRADE_SEC;
  let verdict = "ok";
  // never-anchored ≠ stale: a fresh account has no caps YET (nobody opened a Claude
  // Code session), which is a setup state, not a dead signal. Callers still hard-stop
  // on it, but pages can say "calibrating" instead of painting red deficits.
  if (!a) verdict = "calibrating";
  else if (!fresh && !degradable) verdict = "stale";
  // over = GENUINELY out, and ONLY Anthropic can say so: a real wall hit on a live window.
  // Nothing we compute votes. That was the tank's sin — measured 2026-08-13, both fleet
  // accounts read verdict=over from our own `week >= 1` alone while Anthropic had them at 100%
  // and 82% of the real week. The 82% account had 242M tokens it was not allowed to spend, and
  // the fleet reading this field opened zero PRs for 26 hours. Everything softer — an exhausted
  // paced share, a held reserve — only THROTTLES session_to_spend so fan-outs back off.
  else if (weekWallHit || fiveWallHit) verdict = "over";
  else if (!fresh) verdict = "degraded";

  // Channel = surface × project: two CC instances on one laptop (different project
  // dirs) are distinct channels, not one blob. Events without a project (cloud
  // routines — already unique per surface — and legacy rows) stay surface-only.
  // Owner-facing (authed budget/dash); the public card never sees these keys.
  // TWO windows per surface, because "what ate my week" and "what is burning right now" are
  // different questions. Each is summed on the same bound as the total it will be divided by —
  // mixing a rolling sum into a fixed-window one printed a surface at 648% of a 5h window.
  const surfacesWeek = {}, surfacesFive = {};
  const fiveStart = fiveLo != null ? fiveLo : now - FIVE_H;
  const weekStart = wr ? weekLoFor(wr, now) : now - WEEK;
  for (const e of store.events) {
    const key = e.project ? `${e.surface} · ${e.project}` : e.surface;
    if (e.ts > weekStart) surfacesWeek[key] = (surfacesWeek[key] || 0) + e.billed;
    if (e.ts > fiveStart) surfacesFive[key] = (surfacesFive[key] || 0) + e.billed;
  }

  // lifetime odometer: the whole store, backfill included (weighted units), plus whatever
  // compaction has already retired — so retention never rolls the odometer backwards.
  const lifetime = (store.lifetime_base || 0) + store.events.reduce((s, e) => s + e.billed, 0);

  // #5 burn rate (account-wide, last 5m) + time-to-empty at that rate
  const burn5m = store.events.reduce((s, e) => (e.ts > now - 300 && e.ts <= now + 60 ? s + e.billed : s), 0);
  const ratePerSec = burn5m / 300;

  // PACE, in percent. Rate comes from the trailing 6h (smooths the spikes a live session
  // throws) as a share of the ledger, restated against Anthropic's %. sustainable is the %/hr
  // that spends exactly what's left by the reset — the two are directly comparable, and
  // burning above sustainable means the week ends early. projected_wall_at says when.
  const burn6h = windowedBilled(store.events, now, 6 * 3600);
  const burn6hPct = pctOfWeek(burn6h);
  const burnPctPerHour = burn6hPct != null ? Math.round((burn6hPct / 6) * 100) / 100 : null;
  const hoursLeft = wr && wr > now ? (wr - now) / 3600 : null;
  const weekLeftPct = weekPctReal != null ? Math.max(0, 100 - weekPctReal * 100) : null;
  const sustainablePctPerHour = hoursLeft && weekLeftPct != null
    ? Math.round((weekLeftPct / hoursLeft) * 100) / 100
    : null;
  const projectedWallAt =
    burnPctPerHour > 0 && weekLeftPct != null && hoursLeft
      ? (weekLeftPct / burnPctPerHour < hoursLeft ? Math.round(now + (weekLeftPct / burnPctPerHour) * 3600) : null)
      : null;

  // #2 attribution: heaviest sessions of the last hour, with live 5m rate
  const burners = new Map();
  for (const e of store.events) {
    if (e.ts <= now - 3600 || e.ts > now + 60) continue;
    const key = `${e.surface}|${e.root}`;
    let b = burners.get(key);
    if (!b) { b = { surface: e.surface, session: e.root, project: null, name: null, tokens_1h: 0, rate_5m: 0, ctx: 0, cost_per_action: 0, _ts: 0 }; burners.set(key, b); }
    b.tokens_1h += e.billed;
    if (e.ts > now - 300) b.rate_5m += e.billed;
    if (e.project) b.project = e.project;
    if (e.name) b.name = e.name;
    if (e.ts >= b._ts && e.ctx) { b._ts = e.ts; b.ctx = e.ctx; b.cost_per_action = e.cost_per_action || 0; }
  }
  const ranked = [...burners.values()].sort((x, y) => y.tokens_1h - x.tokens_1h);
  // COST INDEX — the efficiency reading, and the number that says which surface to fix.
  // Absolute tokens-per-action means nothing to a reader; the same user's OWN surfaces
  // compared against each other mean everything. 1.0 = this account's median session,
  // 1.8 = burning 80% more per action than typical. No benchmark to invent, no count to ship.
  const costs = ranked.map((x) => x.cost_per_action).filter((c) => c > 0).sort((x, y) => x - y);
  const medianCost = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
  const topBurners = ranked.slice(0, 5).map((x) => ({
    surface: x.surface, session: x.session, project: x.project, name: x.name,
    week_pct: pctOfWeek(x.tokens_1h), five_pct: pctOfFive(x.rate_5m),
    cost_index: medianCost > 0 && x.cost_per_action > 0 ? Math.round((x.cost_per_action / medianCost) * 100) / 100 : null,
  }));

  // when tokens come back: session_to_spend refills at five_reset (next 5h
  // window); a weekly wall only lifts at week_reset. Shipped as countdowns so
  // an agent doesn't have to do epoch math to answer "how long until tokens?".
  const fiveReset = a?.five_reset || null;
  const resetIn = (t) => (t && t > now ? Math.round(t - now) : null);

  return {
    // Anthropic's REAL /usage utilization, straight off the freshest anchor — the only
    // numbers here that describe the actual subscription, and now the source every other
    // number below is derived from. Null when never anchored; pair with anchor_age_sec
    // (below) — an old anchor describes a possibly-dead window, so treat a stale reading
    // as unknown, never as empty.
    usage_week_pct: a && a.week_pct != null ? a.week_pct : null,
    usage_five_pct: a && a.five_pct != null ? a.five_pct : null,
    // the anchor's own window ends — how to tell a live reading from one describing a
    // window that has already reset (the 2026-07-23 false-over)
    usage_week_live: !!(a && a.week_pct != null && wr > now),
    usage_five_live: !!(a && a.five_pct != null && fr > now),
    five_reset: fiveReset, week_reset: wr || null,
    five_reset_in_sec: resetIn(fiveReset), week_reset_in_sec: resetIn(wr),
    // ---- the number an agent should actually pace against -------------------------------
    // Computed HERE, server-side, so every caller gets the same answer without re-deriving it
    // — three separate clients had already written three versions of this arithmetic, and two
    // of them were wrong in the same direction (pacing off our own tank instead of Anthropic's
    // window). block_share_pct is what THIS 5h block may spend as a percentage of
    // the WEEK: what remains, divided by the 5h blocks left before the weekly reset.
    //
    // Why not "% of your 5h limit": that reads 100%-is-fine every block, because the 5h window
    // refills. Spend to it six blocks running and the week ends on Wednesday, with every
    // individual session inside its limits the whole way.
    ...blockShare(a, week, wr, five, now),
    tokens_again: weekWallHit
      ? `weekly wall — the week reopens at week_reset (${resetIn(wr) != null ? Math.round(resetIn(wr) / 3600) + "h" : "?"})`
      : `next 5h window (${resetIn(fiveReset) != null ? Math.round(resetIn(fiveReset) / 60) + "m" : "?"}) opens a fresh block share`,
    // ---- pace, all percent of the week ----------------------------------------------------
    // week_bank_pct: clock elapsed − spend used, + = ahead of pace. burn/sustainable are %/hr
    // on the same scale, so "am I going to make the week" is one comparison. No token figure
    // appears anywhere in this payload, by design.
    week_elapsed_pct: weekElapsedPct,
    week_bank_pct: weekBankPct,
    burn_pct_per_hour: burnPctPerHour,
    sustainable_pct_per_hour: sustainablePctPerHour,
    projected_wall_at: projectedWallAt,
    reserved_pct: reservedPct, leases: activeLeases.length,
    top_burners: topBurners,
    verdict, fresh,
    // what is queued FOR each channel, so the dash can show a channel and the orders
    // waiting on it in the same place instead of burying them in the feed
    pending_directives: (store.directives || [])
      .filter((d) => d.expires > now)
      .map((d) => ({
        id: d.id, session: d.session, surface: d.surface || null, action: d.action,
        note: d.note || null, auto: !!d.auto, expires: d.expires,
        delivered: (d.delivered_to || []).length,
      })),
    anchor_age_sec: Number.isFinite(anchorAge) ? Math.round(anchorAge) : null,
    stored_at: new Date(now * 1000).toISOString(),
    // THE ODOMETER, and the only counts that survive. These are not budget readings and must
    // never be paced against — they are the product's proof that every surface is being seen
    // at all. lifetime_billed drives the hero counter; burn_5m makes it creep between polls.
    lifetime_billed: lifetime, burn_5m: burn5m,
    // Which surface ate the account, on the week's own scale. This is the answer to "where did
    // it go" — a laptop project at 12.4% of your week is a sentence you can act on.
    surfaces: Object.entries(surfacesWeek)
      .sort((x, y) => y[1] - x[1])
      .map(([surface, billed]) => ({
        surface,
        week_pct: pctOfWeek(billed),
        five_pct: pctOfFive(surfacesFive[surface] || 0),
      })),
  };
}

// ---- directive channel: orchestrator → specific session commands ----------
// Actions: clear (advise /clear — injected as context, one-shot per session),
// pause (deny expensive tools until ttl/resume — sticky, re-delivered every
// read), resume (lifts pending pauses immediately, never queued).
// session "*" = broadcast. Every create/delivery lands in the feed as a
// billed:0 event (visible in maxx watch, never counted — same as gate notes).

const feedNote = (store, root, text, now) =>
  store.events.push({ surface: "directive", root, ts: now, billed: 0, name: text });

const pruneDirectives = (store, now) => {
  store.directives = (store.directives || []).filter((d) => d.expires > now);
};

export function addDirective(store, d, now) {
  const session = String(d.session || "").trim();
  const action = String(d.action || "");
  if (!session) return { ok: false, error: "session required ('*' = broadcast)" };
  if (!/^(clear|pause|resume)$/.test(action)) return { ok: false, error: "action must be clear|pause|resume" };
  pruneDirectives(store, now);
  if (action === "resume") {
    const before = store.directives.length;
    store.directives = store.directives.filter(
      (x) => !(x.action === "pause" && (session === "*" || x.session === session)),
    );
    const lifted = before - store.directives.length;
    feedNote(store, session, `▶ resume — ${lifted} pause${lifted === 1 ? "" : "s"} lifted`, now);
    return { ok: true, action, lifted };
  }
  const ttl = Math.min(Math.max(Number(d.ttl_sec) || 3600, 60), 24 * 3600);
  const dir = {
    id: `d${Math.round(now)}-${(store.directives.length + 1).toString(36)}`,
    session, surface: d.surface || null, action, note: d.note || null,
    // rise = "advising a /clear is not enough here". An unattended session has no human to
    // press the key, so the gate escalates this one to a handoff-then-relaunch instead.
    rise: !!d.rise,
    created: Math.round(now), expires: Math.round(now + ttl), delivered_to: [],
  };
  store.directives.push(dir);
  feedNote(store, session, `⌘ ${action}→${session === "*" ? "all" : session.slice(0, 8)}${dir.note ? `: ${dir.note}` : ""}`, now);
  return { ok: true, id: dir.id, action, session, expires: dir.expires };
}

// ---- watchdog: the one place maxx acts without being asked ----------------
// A session past the context wall re-bills its entire context every turn, so a
// 450k-context session costs ~450k before it does any work. That is how a 10x
// pace burn happens with nobody noticing. The dash paints it red, but only for
// someone already looking at the dash.
//
// This queues a `clear` directive against the offending session, which gate.mjs
// delivers as injected context on that session's next tool call. Advisory only:
// it never pauses or denies, because interrupting a working session on a
// heuristic is a worse failure than overspending.
const CTX_WALL = 250e3;
const WATCH_COOLDOWN = 30 * 60; // never nag the same session more than twice an hour
const kf = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

// Cost per TURN for one session, and whether it is climbing. Every emit record
// carries billed + turns, so this is free. Rising cost/turn is the leading signal:
// it climbs continuously as the context grows, whereas "past the 250k wall" only
// trips once you are already paying full freight on every turn.
function perTurnSlope(store, root, now) {
  const pts = store.events
    .filter((e) => e.root === root && e.turns > 0 && e.billed > 0 && e.ts > now - 45 * 60)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => e.billed / e.turns);
  if (pts.length < 6) return null;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const last3 = avg(pts.slice(-3)), prev3 = avg(pts.slice(-6, -3));
  return { last3, prev3, rising: prev3 > 0 && last3 > prev3 * 1.5 };
}

export function autoAdvise(store, now) {
  const b = computeBudget(store, now);
  // Everything published is a percentage now, so the trigger is one too: burning at 3× the
  // rate the week can sustain. Same comparison as before, on a scale that is Anthropic's
  // rather than our own cache-weighted ledger's.
  const pace = b.sustainable_pct_per_hour;
  if (!pace || pace <= 0) return [];
  if (!(b.burn_pct_per_hour >= 3 * pace)) return []; // not hot enough to interrupt anyone over
  pruneDirectives(store, now);
  store.watched = store.watched || {};
  // Context size stays an internal signal — it is the thing being diagnosed, not a budget
  // reading — but it never reaches the payload or the note as a raw count.
  const ctxOf = (session) => {
    let ts = 0, ctx = 0;
    for (const e of store.events) if (e.root === session && e.ts >= ts && e.ctx) { ts = e.ts; ctx = e.ctx; }
    return ctx;
  };
  const sent = [];
  for (const t of b.top_burners || []) {
    if (!t.session || !(t.five_pct > 0)) continue;   // must actually be burning right now
    const slope = perTurnSlope(store, t.session, now);
    const pastWall = ctxOf(t.session) > CTX_WALL;
    // climbing catches it on the way UP; past-wall is the backstop for a session that
    // was already fat when we started watching it
    const climbing = !!(slope && slope.rising && slope.last3 >= 150e3);
    if (!pastWall && !climbing) continue;
    const last = store.watched[t.session];
    if (last && now - last < WATCH_COOLDOWN) continue;
    // Multipliers, not counts: "1.9× more per turn" is both truer to what we can measure and
    // easier to act on than a token figure in a unit nobody is billed in.
    const climbX = slope && slope.prev3 > 0 ? Math.round((slope.last3 / slope.prev3) * 10) / 10 : null;
    const why = climbing
      ? `cost per turn is climbing — ${climbX != null ? `${climbX}×` : "sharply up"} over the last 6 turns` +
        (pastWall ? ", and the context is past the compaction wall" : "")
      : "the context is past the compaction wall";
    const r = addDirective(store, {
      session: t.session,
      // full channel key when we know the project, so the dash pins it exactly instead
      // of falling back to "busiest channel on that machine"
      surface: t.surface ? (t.project ? `${t.surface} · ${t.project}` : t.surface) : null,
      action: "clear",
      // Past the wall every turn re-bills the whole context, so waiting for a human to press
      // /clear costs the most exactly when nobody is watching. Climbing-but-under-wall stays
      // advisory — there is still room to finish the thought.
      rise: pastWall,
      note:
        `${why}. This session is taking ${t.week_pct != null ? `${t.week_pct}% of your week` : "a large share of your week"} ` +
        `while the account burns at ${b.burn_pct_per_hour}%/hr against a sustainable ${pace}%/hr — ` +
        `every turn re-bills the whole context`,
      ttl_sec: 3600,
    }, now);
    if (r.ok) {
      const dir = store.directives.find((d) => d.id === r.id);
      if (dir) dir.auto = true;
      store.watched[t.session] = Math.round(now);
      sent.push({ session: t.session, name: t.name || t.project || null, week_pct: t.week_pct });
    }
  }
  return sent;
}

/**
 * Directives pending for one session; reading IS consuming (unless peek).
 * clear → delivered once per session; pause → sticky until expiry/resume.
 */
export function pendingDirectives(store, { session, surface = null, peek = false }, now) {
  pruneDirectives(store, now);
  const hits = store.directives.filter(
    (d) =>
      (d.session === "*" || d.session === session) &&
      (!d.surface || !surface || d.surface === surface) &&
      !(d.action === "clear" && (d.delivered_to || []).includes(session)),
  );
  if (!peek)
    for (const d of hits) {
      d.delivered_to = d.delivered_to || [];
      if (!d.delivered_to.includes(session)) {
        d.delivered_to.push(session);
        feedNote(store, d.session, `✓ ${d.action} delivered→${String(session).slice(0, 8)}`, now);
      }
    }
  return hits.map(({ id, session: s, surface: sf, action, note, rise, created, expires }) =>
    ({ id, session: s, surface: sf, action, note, rise: !!rise, created, expires }));
}

// #3 runaway detection — sessions burning ≥ rate for ≥ sustain minutes.
// Pure: returns the CURRENT offenders; the caller (notifier) diffs against
// store.signal.runaway to fire exactly one event per episode and clear on stop.
export function runawaySessions(store, now, config = {}) {
  const rate = config.runaway_rate_5m || 500_000;      // tokens per 5m
  const sustainMin = config.runaway_min || 30;
  const need = rate * (sustainMin / 5);                // sustained total over the window
  const per = new Map();
  for (const e of store.events) {
    if (e.ts <= now - sustainMin * 60 || e.ts > now + 60) continue;
    const key = `${e.surface}|${e.root}`;
    let p = per.get(key);
    if (!p) { p = { surface: e.surface, session: e.root, project: null, tokens: 0, last5: 0 }; per.set(key, p); }
    p.tokens += e.billed;
    if (e.ts > now - 300) p.last5 += e.billed;
    if (e.project) p.project = e.project;
  }
  return [...per.values()]
    .filter((p) => p.last5 >= rate && p.tokens >= need)
    .map((p) => ({ surface: p.surface, session: p.session, project: p.project, rate_5m: p.last5, duration_min: sustainMin }));
}

// #1 push on state transitions — diff current state against store.signal and
// return the webhook events to fire. Mutates store.signal (persist after).
// First observation baselines silently (no event storm on deploy).
export function transitionEvents(store, budget, now) {
  const weekBand = budget.week == null ? 0 : budget.week >= 0.95 ? 95 : budget.week >= 0.9 ? 90 : budget.week >= 0.8 ? 80 : 0;
  const runaway = runawaySessions(store, now, store.config || {});
  const runawayKeys = runaway.map((r) => `${r.surface}|${r.session}`).sort();
  const prev = store.signal;
  const projOver = !!budget.projected_wall_at;
  const cur = { verdict: budget.verdict, weekBand, runaway: runawayKeys, projOver };
  store.signal = cur;
  if (!prev) return [];                                 // baseline, fire nothing
  const events = [];
  if (prev.verdict === "ok" && budget.verdict === "over") events.push({ event: "over" });
  if (prev.verdict === "over" && budget.verdict === "ok") events.push({ event: "recovered" });
  if (weekBand > (prev.weekBand || 0)) events.push({ event: `week-${weekBand}` });
  // early warning: trailing-6h pace now lands BEFORE the weekly reset. Fires on the
  // transition into projected-overrun; recovery is silent (the bar shows it).
  if (projOver && !prev.projOver) events.push({ event: "week-projected-overrun", projected_wall_at: budget.projected_wall_at });
  for (const r of runaway)
    if (!(prev.runaway || []).includes(`${r.surface}|${r.session}`))
      events.push({ event: "runaway", ...r });
  return events.map((e) => ({
    handle: null, // filled by the notifier
    ...e,
    verdict: budget.verdict, session_to_spend: budget.session_to_spend,
    week: budget.week, ts: Math.round(now),
  }));
}
