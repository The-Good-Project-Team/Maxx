// settings — the knobs, and the per-diem they drive.
//
// Everything here is ADVICE. Nothing in this file can deny a caller work: maxx counts,
// Anthropic limits (see docs/, GET /api/model). A computed number that can gate is the coin
// failure with a new name — it was a fixed 1e9 tank, every account outspent it, every derived
// field pinned dead, and consumers read "no budget" for weeks while the real windows were
// nowhere near full. So per_diem_pct can go NEGATIVE and say so, and `verdict` never changes
// because of it. The only hard stops remain Anthropic's own 5h and weekly walls.
//
// THE PER-DIEM, in one line: what is left of your self-imposed weekly cap, divided by the days
// left in Anthropic's week. It is the same shape as blockShare()'s "remaining ÷ blocks left",
// on a day boundary instead of a 5h one, and it exists because a weekly number alone cannot
// answer "can I afford this today" — the question every operator actually asks.

/** Day length in seconds. Days are measured against Anthropic's week_reset (see daysLeft). */
export const DAY = 24 * 3600;

/**
 * The knobs, with the defaults Reif specified 2026-08-17.
 *
 * Every value is a FRACTION (0..1) except where a name ends in _pct. Fractions compare
 * directly against Anthropic's usage_week_pct without conversion, which is the whole reason
 * the payload speaks percent — a unit change between the setting and the reading it is
 * compared to is how a limit silently becomes 100x too loose.
 */
export const DEFAULTS = Object.freeze({
  // Ceiling on the real Anthropic weekly window, across ALL accounts. 0.925 leaves 7.5% of
  // every week unspent as headroom for the human, which is the whole point: the fleet yields
  // the remainder rather than racing the operator for it.
  weekly_max: 0.925,

  // How much of a day's computed per-diem to actually plan against. The gap absorbs a bad
  // estimate without immediately overrunning the weekly cap.
  per_diem_use: 0.95,

  // "hour" publishes an hourly rate (per-diem ÷ 24) alongside the daily figure; "day" reports
  // the daily figure only. Hourly is the default because a fleet that wakes hourly needs a
  // per-tick allowance, not a per-day one it has no way to subdivide.
  per_diem_granularity: "hour",

  // How the pool picks between accounts that BOTH have headroom.
  //   "round_robin"    spread evenly; both accounts deplete together. Best for parallel
  //                    fanout — no single account reaches its 5h wall first.
  //   "exhaustion"     drain one, then the next. Keeps one account clean as a reserve.
  //   "lowest_usage"   always pick the most headroom right now; self-balancing.
  account_strategy: "round_robin",

  // May a single session burn past its advised share of a window? Reported, never enforced
  // here — a consumer that wants to honour it reads these and decides.
  allow_session_overburn: { five_h: true, three_h: true, one_h: true },

  // May a session take a RESERVE against the weekly total, visible to every other surface?
  // The lease machinery already exists (store.leases, reserved_pct); this is the switch that
  // says whether sessions are allowed to use it.
  allow_session_reserve: true,
});

const NUM01 = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const STRATEGIES = new Set(["round_robin", "exhaustion", "lowest_usage"]);
const GRANULARITIES = new Set(["hour", "day"]);

/**
 * Merge stored config over the defaults, DROPPING anything invalid rather than throwing.
 *
 * Fails safe toward the default, never toward "unlimited": a settings blob corrupted into
 * `weekly_max: "none"` must not read as no ceiling. Returns {settings, rejected[]} so a caller
 * can surface what it ignored instead of silently disagreeing with what the pane displays —
 * a setting that reads back differently than it was saved is worse than one that refuses.
 */
export function resolveSettings(config = {}) {
  // Object.freeze is SHALLOW, so a bare {...DEFAULTS} hands every caller the same nested
  // allow_session_overburn object. One caller mutating its own settings would silently rewrite
  // the defaults for every later caller in the process — a per-request setting leaking into
  // global state, which is the worst possible bug in a module whose whole job is limits.
  const out = { ...DEFAULTS, allow_session_overburn: { ...DEFAULTS.allow_session_overburn } };
  const rejected = [];
  const take = (key, ok) => {
    if (!(key in (config || {}))) return;
    const v = config[key];
    if (ok(v)) out[key] = v;
    else rejected.push({ key, value: v, reason: "invalid" });
  };

  take("weekly_max", NUM01);
  take("per_diem_use", NUM01);
  take("per_diem_granularity", (v) => GRANULARITIES.has(v));
  take("account_strategy", (v) => STRATEGIES.has(v));
  take("allow_session_reserve", (v) => typeof v === "boolean");

  if ("allow_session_overburn" in (config || {})) {
    const v = config.allow_session_overburn;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const merged = { ...DEFAULTS.allow_session_overburn };
      for (const k of Object.keys(DEFAULTS.allow_session_overburn)) {
        if (k in v) {
          if (typeof v[k] === "boolean") merged[k] = v[k];
          else rejected.push({ key: `allow_session_overburn.${k}`, value: v[k], reason: "invalid" });
        }
      }
      out.allow_session_overburn = merged;
    } else {
      rejected.push({ key: "allow_session_overburn", value: v, reason: "invalid" });
    }
  }

  return { settings: out, rejected };
}

/**
 * Days remaining in Anthropic's weekly window, measured from week_reset.
 *
 * Anchored to week_reset rather than a calendar midnight (Reif's call, 2026-08-17) so a day
 * boundary never drifts against the window that actually matters. A calendar day would forgive
 * an 11:50pm burst ten minutes later while the weekly window kept counting it.
 *
 * Floored at a partial day rather than 0: on the last afternoon of a week there is real budget
 * left and dividing by zero would report it as infinite. Returns null when there is no usable
 * reset (unknown, never assumed).
 */
export function daysLeft(weekReset, now) {
  if (!weekReset || !now || weekReset <= now) return null;
  return Math.max((weekReset - now) / DAY, 1 / 24); // never below one hour's worth
}

/**
 * The per-diem, as a percent OF THE WEEK per day, plus the hourly slice.
 *
 * Returns nulls (never zeros) when it cannot be computed — an unknown per-diem is unknown, and
 * publishing 0 would read to every consumer as "spend nothing", which is the exact
 * failed-measurement-as-spent-budget mistake that cost this system its worst outage.
 *
 * NEGATIVE IS A REAL ANSWER and is deliberately not clamped: it means the weekly cap is already
 * overspent, and by how much. Clamping to 0 would erase the distinction between "exactly at the
 * cap" and "5.5% past it", which is the difference between easing off and stopping.
 */
export function perDiem({ weekPct, weekReset, now, settings = DEFAULTS }) {
  const none = {
    per_diem_pct: null, per_diem_usable_pct: null, per_diem_hourly_pct: null,
    per_diem_days_left: null, weekly_max_pct: settings.weekly_max * 100,
    over_per_diem: null,
  };
  if (weekPct == null || !Number.isFinite(weekPct)) return none;
  const days = daysLeft(weekReset, now);
  if (days == null) return none;

  // Budget remaining against OUR ceiling, not Anthropic's. Negative when already past it.
  const remaining = settings.weekly_max - weekPct;          // fraction of the week
  const perDiemFrac = remaining / days;                     // fraction of the week per day
  const usableFrac = perDiemFrac * settings.per_diem_use;

  const pct = (f) => Math.round(f * 1000 * 100) / 1000;     // fraction -> percent, 3dp
  return {
    per_diem_pct: pct(perDiemFrac),
    per_diem_usable_pct: pct(usableFrac),
    // Published only when the operator asked for an hourly cadence; "day" callers get null
    // rather than a number they did not ask for and might pace against by accident.
    per_diem_hourly_pct: settings.per_diem_granularity === "hour" ? pct(usableFrac / 24) : null,
    per_diem_days_left: Math.round(days * 100) / 100,
    weekly_max_pct: Math.round(settings.weekly_max * 1000) / 10,
    // A flag, not a gate. Consumers decide what to do with it; maxx never refuses a call.
    over_per_diem: remaining <= 0,
  };
}
