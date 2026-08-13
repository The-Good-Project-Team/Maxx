import test from "node:test";
import assert from "node:assert/strict";
import { weeklyReport, renderReport } from "./report.mjs";

// The live pool, 2026-08-13.
const TGP = { handle: "reif_tgp", weekPct: 1.0, fivePct: 0.0, weekBilled: 1_377_386_233 };
const REIF = { handle: "reif", weekPct: 0.82, fivePct: 0.26, weekBilled: 1_405_413_743 };

const ids = (r) => r.findings.map((f) => f.id);

test("names the uneven burn, and which account to move to", () => {
  const r = weeklyReport([{ ...TGP, weekPct: 0.9 }, { ...REIF, weekPct: 0.2 }]);
  assert.ok(ids(r).includes("uneven-burn"));
  const f = r.findings.find((x) => x.id === "uneven-burn");
  assert.match(f.text, /@reif_tgp is at 90%.*@reif sits at 20%/);
  assert.match(f.action, /@reif\b/, "must say which account to run on, not just that it is uneven");
});

test("an even pool produces no spread finding", () => {
  const r = weeklyReport([{ ...TGP, weekPct: 0.5 }, { ...REIF, weekPct: 0.55 }]);
  assert.equal(ids(r).includes("uneven-burn"), false);
  assert.deepEqual(ids(r), ["clean"], "a report that always says something says nothing");
});

test("a walled account is told whether it is blocked or simply done", () => {
  const withRoom = weeklyReport([TGP, { ...REIF, weekPct: 0.3 }]);
  assert.match(withRoom.findings.find((f) => f.id === "walled").action, /switch rather than wait/);
  const allSpent = weeklyReport([TGP, { ...REIF, weekPct: 0.97 }]);
  assert.match(allSpent.findings.find((f) => f.id === "walled").action, /done, not blocked/);
});

test("one surface eating the week is surfaced with its share", () => {
  const r = weeklyReport([{ ...REIF, surfaces: [
    { surface: "cron:fanout", billed: 900e6 },
    { surface: "laptop:code", billed: 100e6 },
  ] }]);
  const f = r.findings.find((x) => x.id === "concentrated");
  assert.match(f.text, /90% of @reif's week went to one surface: cron:fanout/);
});

test("evenly spread surfaces are not flagged", () => {
  const r = weeklyReport([{ ...REIF, surfaces: [
    { surface: "a", billed: 100e6 }, { surface: "b", billed: 100e6 }, { surface: "c", billed: 100e6 },
  ] }]);
  assert.equal(ids(r).includes("concentrated"), false);
});

test("an unreadable account is reported as unreadable, never as idle", () => {
  // This is where the 26-hour outage began: an unknown that nobody was told about.
  const r = weeklyReport([REIF, { handle: "dark" }]);
  const f = r.findings.find((x) => x.id === "unreadable");
  assert.match(f.text, /No live usage for @dark/);
  assert.equal(r.accounts.length, 1, "a dark account must not be counted as a live reading");
});

test("renders without an account, without throwing", () => {
  assert.match(renderReport(weeklyReport([])), /`maxx setup` links one/);
});

test("renders the pool, the total and every finding", () => {
  const text = renderReport(weeklyReport([TGP, { ...REIF, weekPct: 0.2 }]));
  assert.match(text, /@reif_tgp\s+week 100%/);
  assert.match(text, /2\.78B tokens across 2 accounts · 80% spread/);
  assert.match(text, /→ /, "every finding carries the move it implies");
});
