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
// Coin model: we set our OWN tank instead of reverse-engineering Anthropic's opaque
// plan quota — an MPG meter, not a barrel count. One coin = one weighted (quota-pressure)
// token from the ledger. Every account paces against the SAME tank, so standings are
// directly comparable and the old `cap = ledger ÷ pct` low-% blow-up (which false-blocked
// accounts at ~15% weekly) cannot happen. Anthropic's real % is kept only as a safety wall.
export const COINS_MAX = 1e9;                               // the weekly tank, all accounts
const FIVE_SUBCAP = Math.round((COINS_MAX * FIVE_H) / WEEK); // 5h even-pace share ≈ 29.76M
export const ANCHOR_TRUST_SEC = 45 * 60; // matches the routines' staleness gate
// Past ANCHOR_TRUST_SEC the anchor no longer describes the live 5h window, but the
// weekly caps it calibrated move on a 7-day window — hours-old calibration still
// prices the weekly tank fine, and the server owns the full billed ledger from every
// surface regardless. So an aged anchor DEGRADES (weekly standing only) instead of
// blinding the account: only a laptop can read /usage, and a sleeping laptop used to
// hard-block every cloud routine. Past this, calibration is genuinely too old → stale.
const ANCHOR_DEGRADE_SEC = 12 * 3600;

const sec = (iso) => (iso ? Date.parse(iso) / 1000 : 0);

export function emptyStore() {
  // webhooks: [{url, secret, headers, format}] · leases: [{id, tokens, expires, label}]
  // signal: last-notified state for transition webhooks · config: per-handle overrides
  // directives: [{id, session, surface, action, note, created, expires, delivered_to}]
  return { events: [], anchors: [], seen: {}, webhooks: [], leases: [], signal: null, config: {}, directives: [], ops: [] };
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
  return { accepted, deduped, billed };
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

  // ── Coin caps: fixed, not inferred ─────────────────────────────────────────
  // The tank is a constant (COINS_MAX), same for every account. `five`/`week` are the
  // ledger's own windowed coin sums (computed above) — the meter reading. pct = coins ÷
  // tank. No `cap = ledger ÷ pct`, so a coarse low % can no longer blow the cap up or
  // down. sl passthrough is gone: the server paces on coins, and limit.mjs computes the
  // identical numbers from the same constant, so the CLI bars and the gate agree by
  // construction (nothing to reconcile).
  const fiveCap = FIVE_SUBCAP;
  const weekCap = COINS_MAX;
  const quota = Math.min(1, five / fiveCap);
  const weekPct = Math.min(1, week / weekCap);
  // Anthropic's real utilization is retained ONLY as a safety wall — the meter doesn't
  // stop the car, the real gas tank does. Honored only while the anchor's window is still
  // LIVE (fr/wr ahead of now); a stale anchor describing a dead, pre-reset window must
  // never re-block a fresh one (that was the 2026-07-23 reif_tgp false-over).
  const weekWallHit = a && a.week_pct >= 0.99 && wr > now;
  const fiveWallHit = a && a.five_pct >= 0.99 && fr > now;
  const slSpend = null, slOver = 0, slBank = null;

  const weeklyLeft = weekCap != null ? Math.max(0, weekCap - week) : null;
  // sessions-left-this-week paces the weekly headroom over the 5h windows remaining,
  // capped at the 5h wall, MINUS what this window already spent (limit.mjs rollSession).
  const windowsLeft = wr ? Math.max(1, (wr - now) / FIVE_H) : 1;
  const sessionSafe = weeklyLeft != null
    ? Math.min(fiveCap ?? Infinity, Math.round(weeklyLeft / windowsLeft)) : null;
  const sessionToSpend = slSpend != null ? slSpend : sessionSafe != null ? Math.max(0, sessionSafe - five) : null;

  // #4 reservation leases: active leases subtract from the allowance other
  // callers see (the grantee tracks its own lease). Expired leases are ignored
  // here and pruned on write in the handler.
  const activeLeases = (store.leases || []).filter((l) => l.expires > now);
  const reservedTokens = activeLeases.reduce((s, l) => s + l.tokens, 0);
  const spendAfterReserve = sessionToSpend != null ? Math.max(0, sessionToSpend - reservedTokens) : null;

  // "degraded" = no fresh /usage anchor, but the weekly standing is still computable
  // from our own ledger against the last known caps. Callers may proceed on it (weekly
  // wall and standing still apply); "stale" stays a hard stop — genuinely no signal.
  const degradable = anchorAge <= ANCHOR_DEGRADE_SEC && weekCap != null && spendAfterReserve != null;
  let verdict = "ok";
  // never-anchored ≠ stale: a fresh account has no caps YET (nobody opened a Claude
  // Code session), which is a setup state, not a dead signal. Callers still hard-stop
  // on it, but pages can say "calibrating" instead of painting red deficits.
  if (!a) verdict = "calibrating";
  else if (!fresh && !degradable) verdict = "stale";
  // over = the coin tank is spent (paced or absolute), OR Anthropic's real wall is hit on
  // a live window. The coin tank is the pacing gauge; the real wall is the hard safety.
  else if (weekPct >= 1 || quota >= 1 || spendAfterReserve === 0 || weekWallHit || fiveWallHit) verdict = "over";
  else if (!fresh) verdict = "degraded";

  // Channel = surface × project: two CC instances on one laptop (different project
  // dirs) are distinct channels, not one blob. Events without a project (cloud
  // routines — already unique per surface — and legacy rows) stay surface-only.
  // Owner-facing (authed budget/dash); the public card never sees these keys.
  const surfaces = {};
  for (const e of store.events) {
    if (e.ts > now - FIVE_H) {
      const key = e.project ? `${e.surface} · ${e.project}` : e.surface;
      surfaces[key] = (surfaces[key] || 0) + e.billed;
    }
  }

  // lifetime odometer: the whole store, backfill included (weighted units)
  const lifetime = store.events.reduce((s, e) => s + e.billed, 0);

  // #5 burn rate (account-wide, last 5m) + time-to-empty at that rate
  const burn5m = store.events.reduce((s, e) => (e.ts > now - 300 && e.ts <= now + 60 ? s + e.billed : s), 0);
  const ratePerSec = burn5m / 300;

  // The pace model: the WEEK is the budget. sustainable = the per-minute rate that
  // spends exactly the weekly reserve by the time it resets. net = sustainable − recent
  // burn: + = under weekly pace (you'll make the week), − = over (dry early). Replaces the
  // 5h-refill proxy — the 5h cap resets in a cliff, so "refill/min" was a fiction; the
  // weekly pace is the real constraint the standing is already derived from.
  const weekMinLeft = wr && wr > now ? (wr - now) / 60 : null;
  const sustainablePerMin = weeklyLeft != null && weekMinLeft ? weeklyLeft / weekMinLeft : null;
  const netPerMinVal = sustainablePerMin != null
    ? Math.round(sustainablePerMin - burn5m / 5)
    : (five != null ? Math.round(five / (FIVE_H / 60) - burn5m / 5) : null);
  // two ceilings: burst = the hard 5h wall you can physically spend to right now;
  // safe = spendAfterReserve (weekly-paced). Burst > safe means you CAN overspend.
  const fiveHeadroom = fiveCap != null ? Math.max(0, Math.round(fiveCap - five)) : null;
  // projected wall hit: trailing-6h burn extrapolated forward. 6h smooths the 5m spikes
  // a live session throws; a projection inside the current week window means "at this
  // pace you hit the wall EARLY" — the signal this week's postmortem never got.
  const burn6h = windowedBilled(store.events, now, 6 * 3600);
  const rate6hPerSec = burn6h / (6 * 3600);
  const projectedWallAt =
    weeklyLeft != null && wr && wr > now && rate6hPerSec > 0 && weeklyLeft / rate6hPerSec < wr - now
      ? Math.round(now + weeklyLeft / rate6hPerSec)
      : null;
  const emptiesAt =
    ratePerSec > 3 && spendAfterReserve != null
      ? Math.round(now + spendAfterReserve / ratePerSec)
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
  const topBurners = [...burners.values()].sort((x, y) => y.tokens_1h - x.tokens_1h).slice(0, 3);

  // when tokens come back: session_to_spend refills at five_reset (next 5h
  // window); a weekly wall only lifts at week_reset. Shipped as countdowns so
  // an agent doesn't have to do epoch math to answer "how long until tokens?".
  const fiveReset = a?.five_reset || null;
  const resetIn = (t) => (t && t > now ? Math.round(t - now) : null);

  return {
    quota, week: weekPct,
    five_reset: fiveReset, week_reset: wr || null,
    five_reset_in_sec: resetIn(fiveReset), week_reset_in_sec: resetIn(wr),
    tokens_again:
      (weekPct != null && weekPct >= 0.99)
        ? `weekly cap — tokens at week_reset (${resetIn(wr) != null ? Math.round(resetIn(wr) / 3600) + "h" : "?"})`
        : `next 5h window (${resetIn(fiveReset) != null ? Math.round(resetIn(fiveReset) / 60) + "m" : "?"}) refills session_to_spend`,
    weekly_left_tokens: weeklyLeft, session_to_spend: spendAfterReserve,
    // absolute weekly ruler for charts: cap + used in the same units as weekly_left_tokens
    week_cap_tokens: weekCap != null ? Math.round(weekCap) : null,
    week_used_tokens: weekCap != null ? Math.round(week) : null,
    session_over: slOver,
    week_bank: slBank,
    // net_per_min = sustainable weekly pace − recent (5m) burn. + under pace / − over.
    // sustainable_per_min = weekly reserve ÷ minutes to week reset. session_burst = the
    // hard 5h ceiling you can physically spend to now (≥ the paced session_to_spend).
    net_per_min: netPerMinVal,
    sustainable_per_min: sustainablePerMin != null ? Math.round(sustainablePerMin) : null,
    // trailing-6h burn per minute + where it lands: null = makes the week at this pace,
    // an epoch = projected wall hit BEFORE week_reset.
    burn_6h_per_min: Math.round(burn6h / 360),
    projected_wall_at: projectedWallAt,
    session_burst: fiveHeadroom,
    session_safe: sessionSafe,
    reserved_tokens: reservedTokens, leases: activeLeases.length,
    burn_5m: burn5m, empties_at: emptiesAt,
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
    five_billed: five, week_billed: week, lifetime_billed: lifetime,
    surfaces: Object.entries(surfaces)
      .sort((x, y) => y[1] - x[1])
      .map(([surface, billed_5h]) => ({ surface, billed_5h })),
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
  const pace = b.sustainable_per_min;
  if (!pace || pace <= 0) return [];
  const burnPerMin = (b.burn_5m || 0) / 5;
  if (burnPerMin < 3 * pace) return []; // not hot enough to interrupt anyone over
  pruneDirectives(store, now);
  store.watched = store.watched || {};
  const sent = [];
  for (const t of b.top_burners || []) {
    const rate = (t.rate_5m || 0) / 5;
    if (!t.session || rate < pace) continue;   // must actually be burning right now
    const slope = perTurnSlope(store, t.session, now);
    const pastWall = t.ctx > CTX_WALL;
    // climbing catches it on the way UP; past-wall is the backstop for a session that
    // was already fat when we started watching it
    const climbing = !!(slope && slope.rising && slope.last3 >= 150e3);
    if (!pastWall && !climbing) continue;
    const last = store.watched[t.session];
    if (last && now - last < WATCH_COOLDOWN) continue;
    const why = climbing
      ? `cost per turn is climbing — ${kf(slope.prev3)} → ${kf(slope.last3)} per turn over the last 6 turns` +
        (pastWall ? `, and ctx ${kf(t.ctx)} is past the ${kf(CTX_WALL)} wall` : "")
      : `ctx ${kf(t.ctx)} is past the ${kf(CTX_WALL)} wall`;
    const r = addDirective(store, {
      session: t.session,
      // full channel key when we know the project, so the dash pins it exactly instead
      // of falling back to "busiest channel on that machine"
      surface: t.surface ? (t.project ? `${t.surface} · ${t.project}` : t.surface) : null,
      action: "clear",
      note:
        `${why}. Burning ${kf(rate)}/min against a sustainable ${kf(pace)}/min — ` +
        `every turn re-bills the whole context`,
      ttl_sec: 3600,
    }, now);
    if (r.ok) {
      const dir = store.directives.find((d) => d.id === r.id);
      if (dir) dir.auto = true;
      store.watched[t.session] = Math.round(now);
      sent.push({ session: t.session, name: t.name || t.project || null, ctx: t.ctx, rate });
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
  return hits.map(({ id, session: s, surface: sf, action, note, created, expires }) =>
    ({ id, session: s, surface: sf, action, note, created, expires }));
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
