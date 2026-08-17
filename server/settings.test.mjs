// The per-diem is ADVICE. Every test here exists to keep it advice.
//
// maxx has now shipped two computed budgets that became hard stops by accident — a 1e9 coin
// tank, then limits implied from billed÷pct — and both ended the same way: a number that could
// never clear, consumers reading it as "no budget", and a fleet idle beside windows that were
// nowhere near full. The per-diem is the third computed budget. These tests are the difference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, resolveSettings, daysLeft, perDiem, DAY } from "./settings.mjs";

const NOW = 1_800_000_000;

// ── the per-diem itself ────────────────────────────────────────────────────────────────────

test("per-diem is remaining cap divided by days left", () => {
  // 50% used against a 92.5% cap, 4 days left -> 42.5/4 = 10.625%/day
  const r = perDiem({ weekPct: 0.5, weekReset: NOW + 4 * DAY, now: NOW });
  assert.equal(r.per_diem_days_left, 4);
  assert.equal(r.per_diem_pct, 10.625);
  // usable is the 95% slice of it
  assert.equal(r.per_diem_usable_pct, Math.round(10.625 * 0.95 * 1000) / 1000);
  assert.equal(r.over_per_diem, false);
});

test("hourly is the usable per-diem over 24, and only when asked for", () => {
  const hourly = perDiem({ weekPct: 0.5, weekReset: NOW + 4 * DAY, now: NOW });
  assert.equal(hourly.per_diem_hourly_pct, Math.round((10.625 * 0.95 / 24) * 1000) / 1000);

  const daily = perDiem({
    weekPct: 0.5, weekReset: NOW + 4 * DAY, now: NOW,
    settings: { ...DEFAULTS, per_diem_granularity: "day" },
  });
  // Not 0 — null. A caller pacing hourly against a 0 would stop entirely, and a caller that
  // asked for daily cadence never wanted an hourly figure to exist.
  assert.equal(daily.per_diem_hourly_pct, null);
  assert.equal(daily.per_diem_pct, 10.625, "the daily figure is unaffected by granularity");
});

test("a per-diem past the cap goes NEGATIVE and is never clamped to zero", () => {
  // The live reading the day this shipped: 98% used, 92.5% cap, 3.3 days left.
  const r = perDiem({ weekPct: 0.98, weekReset: NOW + Math.round(3.3 * DAY), now: NOW });
  assert.ok(r.per_diem_pct < 0, `expected negative, got ${r.per_diem_pct}`);
  assert.equal(r.over_per_diem, true);
  // Clamping would erase the difference between "exactly at the cap" and "5.5% past it" --
  // which is the difference between easing off and stopping.
  const atCap = perDiem({ weekPct: 0.925, weekReset: NOW + DAY, now: NOW });
  assert.equal(atCap.per_diem_pct, 0);
  assert.equal(atCap.over_per_diem, true, "at the cap is over it: nothing left to spend today");
  assert.ok(r.per_diem_pct < atCap.per_diem_pct, "5.5% past the cap must read worse than at it");
});

test("over_per_diem is a FLAG, never a verdict -- maxx cannot deny work", () => {
  const r = perDiem({ weekPct: 0.99, weekReset: NOW + DAY, now: NOW });
  assert.equal(r.over_per_diem, true);
  // The whole contract in one assertion: nothing this module returns is a gating token.
  assert.equal("verdict" in r, false);
  assert.equal("gated" in r, false);
  assert.equal("blocked" in r, false);
});

test("unknown inputs read null, never zero", () => {
  // "Treating a failed measurement as a spent budget is the single most expensive mistake in
  // this system's history" -- 0 would be exactly that, restated in a new unit.
  for (const bad of [
    { weekPct: null, weekReset: NOW + DAY, now: NOW },
    { weekPct: 0.5, weekReset: null, now: NOW },
    { weekPct: 0.5, weekReset: NOW - DAY, now: NOW },   // already reset: describes nothing
  ]) {
    const r = perDiem(bad);
    assert.equal(r.per_diem_pct, null, JSON.stringify(bad));
    assert.equal(r.per_diem_usable_pct, null);
    assert.equal(r.over_per_diem, null, "unknown is not 'over'");
  }
});

test("days are anchored to week_reset, floored at an hour, never zero", () => {
  assert.equal(daysLeft(NOW + 2 * DAY, NOW), 2);
  assert.equal(daysLeft(NOW - 1, NOW), null, "a passed reset describes no window");
  assert.equal(daysLeft(0, NOW), null);
  // Last minutes of a week: real budget remains, and dividing by ~0 would report it infinite.
  const sliver = daysLeft(NOW + 60, NOW);
  assert.equal(sliver, 1 / 24);
  const r = perDiem({ weekPct: 0.5, weekReset: NOW + 60, now: NOW });
  assert.ok(Number.isFinite(r.per_diem_pct), "must stay finite in the last minutes of a week");
});

// ── settings resolution ────────────────────────────────────────────────────────────────────

test("defaults are Reif's 2026-08-17 specification", () => {
  const { settings } = resolveSettings({});
  assert.equal(settings.weekly_max, 0.925);
  assert.equal(settings.per_diem_use, 0.95);
  assert.equal(settings.per_diem_granularity, "hour");
  assert.equal(settings.account_strategy, "round_robin");
  assert.equal(settings.allow_session_reserve, true);
});

test("invalid settings fall back to the default and are REPORTED, never silently kept", () => {
  const { settings, rejected } = resolveSettings({
    weekly_max: "none",          // the dangerous one: must not read as "no ceiling"
    per_diem_use: 4,             // out of range
    account_strategy: "random",  // not a strategy
    per_diem_granularity: "week",
  });
  assert.equal(settings.weekly_max, DEFAULTS.weekly_max);
  assert.equal(settings.per_diem_use, DEFAULTS.per_diem_use);
  assert.equal(settings.account_strategy, DEFAULTS.account_strategy);
  assert.equal(settings.per_diem_granularity, DEFAULTS.per_diem_granularity);
  assert.equal(rejected.length, 4);
  // A pane that displays a value it did not actually save is worse than one that refuses it.
  assert.ok(rejected.every((r) => r.reason === "invalid"));
});

test("valid settings are honoured, including a stricter cap", () => {
  const { settings, rejected } = resolveSettings({
    weekly_max: 0.5, per_diem_use: 1, account_strategy: "exhaustion",
    per_diem_granularity: "day", allow_session_reserve: false,
  });
  assert.deepEqual(rejected, []);
  assert.equal(settings.weekly_max, 0.5);
  assert.equal(settings.account_strategy, "exhaustion");
  assert.equal(settings.allow_session_reserve, false);
  const r = perDiem({ weekPct: 0.4, weekReset: NOW + 2 * DAY, now: NOW, settings });
  assert.equal(r.per_diem_pct, 5, "(0.5-0.4)/2 days = 5%/day");
  assert.equal(r.weekly_max_pct, 50);
});

test("overburn flags merge per-window and reject non-booleans individually", () => {
  const { settings, rejected } = resolveSettings({
    allow_session_overburn: { five_h: false, one_h: "yes" },
  });
  assert.equal(settings.allow_session_overburn.five_h, false, "explicit false is honoured");
  assert.equal(settings.allow_session_overburn.three_h, true, "unmentioned keeps its default");
  assert.equal(settings.allow_session_overburn.one_h, true, "invalid falls back, not through");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].key, "allow_session_overburn.one_h");
});

test("resolveSettings never mutates DEFAULTS", () => {
  const { settings } = resolveSettings({ weekly_max: 0.1 });
  settings.allow_session_overburn.five_h = false;
  assert.equal(DEFAULTS.weekly_max, 0.925);
  assert.equal(DEFAULTS.allow_session_overburn.five_h, true);
});
