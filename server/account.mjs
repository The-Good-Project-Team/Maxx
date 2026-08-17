// account — several handles, one owner, one pool.
//
// maxx has always stored usage PER HANDLE (reif, reif_tgp) while the human paying for them has
// one weekly budget and one question: which one should the next job use. signup already writes
// `s.account` and `s.account_email` onto each handle's doc — and until now nothing ever read
// them back, so two handles belonging to one person were two unrelated budgets that happened
// to sit in the same store.
//
// This module is the missing read. It groups handles by account and answers "who next", which
// is what a fleet dispatcher actually needs and what every consumer had been reinventing badly:
// nonprofit-atlas walked a hardcoded ACCOUNT_POOL_ORDER, and the ordering could not react to
// how much of each week was actually left.
//
// NOTHING HERE GATES. Same contract as the rest of the payload: it ranks and reports. A caller
// that gets `null` from pick() has no account with headroom by ITS OWN reckoning, and the
// correct response is still to try — Anthropic rejecting a call is the only real stop.

/** The membership index lives in the shared `_auth`-adjacent doc so it works on EVERY store
 * adapter. The production blob store has no listHandles(), so a scan-every-handle design would
 * work locally and silently do nothing in prod (handler.mjs already guards `if
 * (!store.listHandles) return`). Keyed by account id -> [handle]. */
export const ACCOUNTS_KEY = "_accounts";

/** Normalize an account id. Email is the natural key — it is what signup collects and what a
 * human recognizes — but it must be case-folded, or Reif@x and reif@x become two pools. */
export const accountId = (raw) => String(raw || "").trim().toLowerCase().slice(0, 128);

/**
 * Add a handle to an account's member list. Pure: takes and returns the index.
 * Idempotent — re-linking a handle already in the account is a no-op, not a duplicate, because
 * signup can run more than once for the same machine.
 */
export function linkHandle(index, account, handle) {
  const id = accountId(account);
  if (!id || !handle) return index;
  const out = { ...(index || {}) };
  const members = new Set(out[id] || []);
  members.add(String(handle));
  out[id] = [...members].sort();
  // A handle belongs to exactly ONE account. Moving it must REMOVE it from any previous owner,
  // or its usage would be counted twice in a pooled total and the pool would think it had more
  // headroom than it does.
  for (const other of Object.keys(out)) {
    if (other === id) continue;
    const kept = (out[other] || []).filter((x) => x !== String(handle));
    if (kept.length) out[other] = kept; else delete out[other];
  }
  return out;
}

/** Every handle for an account, or [] when unknown. */
export const handlesFor = (index, account) => (index || {})[accountId(account)] || [];

/** The account a handle belongs to, or null. Reverse lookup for the per-handle surfaces. */
export function accountOf(index, handle) {
  for (const [id, members] of Object.entries(index || {}))
    if ((members || []).includes(String(handle))) return id;
  return null;
}

/**
 * Rank candidate accounts and pick the next one to use.
 *
 * `members`: [{handle, usage_week_pct, usage_week_live, weekly_max, last_used}]
 *   usage_week_pct  Anthropic's real reading, or null when unknown
 *   usage_week_live false when the anchored window has already rolled — that reading describes
 *                   a window that no longer exists, so it is treated as UNKNOWN, not as full
 *   last_used       epoch of the last dispatch, for round_robin's turn order
 *
 * Returns {handle, why, ranked[]} or null when there are no members at all.
 *
 * AN UNKNOWN READING IS NOT AN EXHAUSTED ONE. A handle whose meter cannot be read stays a
 * candidate and ranks as if mid-pack, because the alternative — treating unreadable as full —
 * is the single most expensive mistake this system has made, twice.
 */
export function pick(members, { strategy = "round_robin", weeklyMax = 0.925 } = {}) {
  const list = (members || []).filter((m) => m && m.handle);
  if (!list.length) return null;

  const headroom = (m) => {
    const live = m.usage_week_live !== false;
    const pct = m.usage_week_pct;
    if (pct == null || !Number.isFinite(pct) || !live) return null;   // unknown, not empty
    return (m.weekly_max ?? weeklyMax) - pct;                          // may be negative
  };

  const annotated = list.map((m) => ({ ...m, headroom: headroom(m) }));
  const withRoom = annotated.filter((m) => m.headroom == null || m.headroom > 0);
  // Everyone is over their ceiling. Return the LEAST over rather than null: the caller asked
  // who is next, and "nobody" is a gate. Anthropic still decides whether the call lands.
  const pool = withRoom.length ? withRoom : annotated;

  let ranked;
  let why;
  if (strategy === "exhaustion") {
    // Drain one, keep the next clean as a reserve. Order is the caller's order, first with
    // room wins — the pre-2026-08-17 behaviour, kept because a held-back account is a real
    // strategy when a human wants a private remainder.
    ranked = pool;
    why = "exhaustion — first with headroom, keeping the rest in reserve";
  } else if (strategy === "lowest_usage") {
    ranked = [...pool].sort((a, b) => (b.headroom ?? 0.5) - (a.headroom ?? 0.5));
    why = "lowest usage — most headroom first";
  } else {
    // round_robin (default): least-recently-used first, so both accounts deplete together and
    // neither reaches its 5h wall first during a fanout. Ties break on headroom so a cold pool
    // still starts with the healthier account rather than an arbitrary one.
    ranked = [...pool].sort((a, b) =>
      (a.last_used || 0) - (b.last_used || 0) || (b.headroom ?? 0.5) - (a.headroom ?? 0.5));
    why = "round robin — least recently used, spreading the burn evenly";
  }

  return { handle: ranked[0].handle, why, ranked };
}
