// maxx — tests for the correctness-critical paths: the roll-session governor gate (rollSession) and the
// "used pinned to Anthropic's real %" invariant (the 2× cache-inflation fix). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rollSession } from "./limit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.now();
const in6d = NOW / 1000 + 6 * 24 * 3600; // 6 days of week left → 6*24/5 = 28.8 five-hour windows

test("rollSession: safe = weekly-left ÷ 5h-windows-left, under the raw 5h wall", () => {
  const r = rollSession(30e6, 200e6, 0, 50e6, in6d, NOW);
  assert.ok(Math.abs(r.sessionSafe - 5.21e6) < 0.15e6, `safe ${r.sessionSafe}`); // (200-50)/28.8
  assert.equal(r.sessionToSpend, r.sessionSafe);                                 // used5 = 0
  assert.equal(r.sessionOver, 0);
});

test("rollSession: over the paced share → toSpend 0, over positive (governor blocks here)", () => {
  const r = rollSession(30e6, 200e6, 10e6, 50e6, in6d, NOW);
  assert.equal(r.sessionToSpend, 0);
  assert.ok(r.sessionOver > 4e6 && r.sessionOver < 6e6, `over ${r.sessionOver}`);
});

test("rollSession: capped at the raw 5h wall when the paced share is larger", () => {
  const r = rollSession(2e6, 900e6, 0, 0, in6d, NOW);
  assert.equal(r.sessionSafe, 2e6); // 900M/28.8 ≫ 2M wall → capped to the wall
});

test("rollSession: banking — a lighter week raises the safe share", () => {
  const light = rollSession(30e6, 200e6, 0, 20e6, in6d, NOW);
  const heavy = rollSession(30e6, 200e6, 0, 120e6, in6d, NOW);
  assert.ok(light.sessionSafe > heavy.sessionSafe, "frugal → more fuel");
});

test("rollSession: no weekly data → falls back to the raw 5h cap", () => {
  const r = rollSession(30e6, 0, 0, 0, 0, NOW);
  assert.equal(r.sessionSafe, 30e6);
});

test("render --status: the weekly bar IS Anthropic's 7d %, and the cap is inferred from it", () => {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-test-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  const stdin = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 6, resets_at: in6d },
      seven_day: { used_percentage: 37, resets_at: in6d },
    },
    context_window: { used_percentage: 10 },
    model: { display_name: "Opus" },
  });
  const out = execFileSync("node", [path.join(HERE, "render.mjs"), "--status"],
    { input: stdin, env: { ...process.env, HOME: home }, encoding: "utf8" });
  const s = JSON.parse(out);
  // What MOVES the bar is Anthropic's own 7d %: it rides in on stdin every render, so it can't
  // collapse the way the local bucket sum does mid-rewrite, and the bar reads what /usage says.
  assert.equal(s.weekly.usedPct, 37, "week bar must track Anthropic's 7d %");
  // The token CAP is inferred (ledger ÷ their %) — a fresh HOME has no ledger to divide, so
  // there is no cap to state. 0 here means "not estimable yet", and the bar is unaffected: the
  // fill comes from the %, not from the estimate. We used to publish a fixed 1e9 tank instead,
  // which read full-of-fuel on an account Anthropic had at 96%.
  assert.equal(s.weekly.cap, 0, "no local ledger ⇒ nothing to divide ⇒ no cap claimed");
  assert.equal(s.session.rawUsedPct, 6, "raw 5h wall still matches /usage five_hour %");
});

// The anchor is only as good as its fallback: no live % (offline, pre-first-/usage) must not
// blank the bar — it drops back to the local bucket sum rather than reading a stale 37%.
test("render --status: no 7d % on stdin → week bar falls back to the local bucket sum", () => {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-test-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  const stdin = JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 6, resets_at: in6d } },
    context_window: { used_percentage: 10 },
    model: { display_name: "Opus" },
  });
  const out = execFileSync("node", [path.join(HERE, "render.mjs"), "--status"],
    { input: stdin, env: { ...process.env, HOME: home }, encoding: "utf8" });
  const s = JSON.parse(out);
  assert.equal(s.weekly.cap, 0, "no % to divide by and no ledger ⇒ no cap invented");
  assert.equal(s.weekly.usedPct, 0, "no live % and no staged burn → nothing to draw");
});

test("render stamps the signed-in account on rl.json/status.json (CLAUDE_CONFIG_DIR-aware)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-test-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  writeFileSync(path.join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "acct-default", emailAddress: "a@x.com" } }));
  const alt = path.join(home, ".claude-alt");
  mkdirSync(alt, { recursive: true });
  writeFileSync(path.join(alt, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "acct-alt", emailAddress: "b@y.com" } }));
  const stdin = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 6, resets_at: in6d },
      seven_day: { used_percentage: 37, resets_at: in6d },
    },
    context_window: { used_percentage: 10 },
    model: { display_name: "Opus" },
  });
  const run = (env) => JSON.parse(execFileSync("node", [path.join(HERE, "render.mjs"), "--status"],
    { input: stdin, env: { ...process.env, HOME: home, ...env }, encoding: "utf8" }));
  assert.equal(run({ CLAUDE_CONFIG_DIR: "" }).account, "acct-default");
  assert.equal(JSON.parse(readFileSync(path.join(home, ".maxx", "rl.json"), "utf8")).account, "acct-default");
  assert.equal(run({ CLAUDE_CONFIG_DIR: alt }).account, "acct-alt", "a session in an alternate config dir is that dir's account");
});

// The first wall is named after the thing that runs out — the chat — not after the unit it is
// measured in. "ctx" named the unit; every other wall on the line (session, week) names the thing.
test("render: the first wall is labelled chat, not ctx", () => {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-test-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  const stdin = JSON.stringify({
    session_id: "labelchat",
    rate_limits: {
      five_hour: { used_percentage: 26, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 22, resets_at: in6d },
    },
    context_window: { used_percentage: 10, context_window_size: 1000000 },
    model: { display_name: "Opus" },
  });
  const env = { ...process.env, HOME: home, COLUMNS: "200" };
  const bar = execFileSync("node", [path.join(HERE, "render.mjs")], { input: stdin, env, encoding: "utf8" })
    .replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  // one reading out of 100: context 10% against the 35% hand-off line = 29
  assert.match(bar, /chat 29%/, `expected "chat 29%" in the bar: ${JSON.stringify(bar)}`);
  assert.doesNotMatch(bar, /\bctx\b/, "the old jargon label must be gone");
});

// REGRESSION, seen live 2026-08-14: /usage said "26% used" while the bar said "session 100%" in
// red. The displayed session reading had been taken from q5 — used5 ÷ realMax, our own paced share
// of the week, clamped to 1 — so running past our SOFT line printed Anthropic's HARD wall. The
// mirror image showed up on a fresh box as "session 0%": no local coin history, so the ratio is 0
// while Anthropic is already several percent in. The reading beside a percent-of-window standard
// must be the percent of that window, which is exactly what stdin's five_hour carries.
test("render: the session reading is Anthropic's 5h %, not our paced-share ratio", () => {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-test-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  const stdin = JSON.stringify({
    session_id: "regress5h",
    rate_limits: {
      five_hour: { used_percentage: 26, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 22, resets_at: in6d },
    },
    context_window: { used_percentage: 10, context_window_size: 1000000 },
    model: { display_name: "Opus" },
  });
  const env = { ...process.env, HOME: home, COLUMNS: "200" };
  const bar = execFileSync("node", [path.join(HERE, "render.mjs")], { input: stdin, env, encoding: "utf8" })
    .replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const m = bar.match(/session (\d+)/);
  assert.ok(m, `no session reading in the bar: ${JSON.stringify(bar)}`);
  assert.equal(Number(m[1]), 26, "session reading must equal stdin's five_hour used_percentage");
  // and the week beside it answers on the same denominator
  const w = bar.match(/week (\d+)/);
  assert.ok(w, "no week reading in the bar");
  assert.equal(Number(w[1]), 22, "week reading must equal stdin's seven_day used_percentage");
});
