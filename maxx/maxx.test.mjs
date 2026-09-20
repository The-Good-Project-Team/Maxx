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
  // The week beside it is Anthropic's 7d % (covered by the --status tests above); what matters
  // HERE is only that the session reading did not leak into the week's cell.
  const w = bar.match(/week (\d+)/);
  assert.ok(w, `no week reading in the bar: ${JSON.stringify(bar)}`);
  assert.equal(Number(w[1]), 22, "week reading must equal stdin's seven_day used_percentage");
});

// "Fable 5.1" fell through to the 8-glyph cut and printed "fable 5." — a family that reads as a
// typo. Every family on the bar is its name alone; the version is inferable from what you typed.
test("render: fable is a family, not an 8-glyph cut", () => {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-test-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  const stdin = JSON.stringify({
    session_id: "fam",
    rate_limits: {
      five_hour: { used_percentage: 26, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 22, resets_at: in6d },
    },
    context_window: { used_percentage: 10, context_window_size: 1000000 },
    model: { display_name: "Fable 5.1" },
  });
  const env = { ...process.env, HOME: home, COLUMNS: "200" };
  const bar = execFileSync("node", [path.join(HERE, "render.mjs")], { input: stdin, env, encoding: "utf8" })
    .replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  assert.match(bar, /\bfable +│/, `expected "fable" in the bar: ${JSON.stringify(bar)}`);
  assert.doesNotMatch(bar, /fable 5\./);
});

// ── the week reads as USED/PACE percents ────────────────────────────────────────────────────
// "week 116h/0h" answered nothing: the runway projection rides a 5-minute burn window and read as
// zero or absurd far more often than it read true. The pair the session cell uses — used % against
// the calendar's pace % on Anthropic's denominator — is what the week is asked at a glance.
// Runway and its delta stay in status.json for the gate; they no longer occupy the bar cell.
//
// A ledger is still required for the status tests: burn comes from ~/.maxx/window.json, and
// CLAUDE_CONFIG_DIR suffixes every file under it (render.mjs:323), so it is cleared or the render
// writes its status somewhere this test cannot find.
const ESC = "";
const cellOf = (raw) => raw.match(new RegExp(`week[\\s\\S]*?(?=${ESC}\\[2;38;2;129;103;162m {2})`))[0];
const cleanEnv = (home) => { const e = { ...process.env, HOME: home, COLUMNS: "200" }; delete e.CLAUDE_CONFIG_DIR; return e; };
// render.mjs sums "the last 5 minutes" as every bucket NEWER than now−5min (`b[0] > c`), so a
// bucket sitting exactly on the boundary counts too. Place the recent one a minute in and the rest
// well outside the window, or `last5m` is not what the render actually reads.
const ledger = (home, last5m, rest = 2_000_000) => {
  const now = Date.now();
  const buckets = [[now - 60 * 1000, last5m]];                   // inside the 5-min window
  for (let i = 1; i < 12; i++) buckets.push([now - (5 + i * 5) * 60 * 1000, rest]); // safely outside
  writeFileSync(path.join(home, ".maxx", "window.json"),
    JSON.stringify({ buckets, cap7: 1_000_000_000, accountCreatedAt: now - 60 * 24 * 3600 * 1000 }));
};
const weekStdin = (sid) => JSON.stringify({
  session_id: sid,
  rate_limits: {
    five_hour: { used_percentage: 26, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    seven_day: { used_percentage: 22, resets_at: in6d },
  },
  context_window: { used_percentage: 10, context_window_size: 1000000 },
  model: { display_name: "Opus" },
});
const renderRaw = (home, stdin) =>
  execFileSync("node", [path.join(HERE, "render.mjs")], { input: stdin, env: cleanEnv(home), encoding: "utf8" });
const renderBar = (home, stdin) => renderRaw(home, stdin)
  .replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const statusOf = (home) => JSON.parse(readFileSync(path.join(home, ".maxx", "status.json"), "utf8"));
const freshHome = () => {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-test-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  return home;
};

test("render: the week is used% over pace%, never hours", () => {
  const home = freshHome();
  ledger(home, 2_000_000);                       // a hot burn must not drag hours back onto the bar
  const bar = renderBar(home, weekStdin("wk-pct"));
  const m = bar.match(/week (\d+)\/(\d+)%/);
  assert.ok(m, `expected "week <used>/<pace>%" in the bar: ${JSON.stringify(bar)}`);
  assert.equal(Number(m[1]), 22, "used = Anthropic's seven_day used_percentage");
  // reset is 6d out of a 7d window → 1 day elapsed → pace ≈ 14%
  assert.ok(Number(m[2]) >= 13 && Number(m[2]) <= 15, `pace must be the calendar's elapsed share: ${m[2]}`);
  assert.doesNotMatch(bar, /week \d+h/, "the hours reading is gone, not printed beside the pair");
});

// Runway jitters with the 5-minute burn window, so its CHANGE is what carries signal: it is the
// only number on the bar that answers "did easing off in the last ten minutes actually help".
// Measured against the previous render's reading, which status.json already carries.
//
// Driven through --status, NOT the bar: a bar render spawns limit.mjs detached to refresh
// window.json (render.mjs:866), which overwrites the ledger this test just wrote and leaves the
// second render with no buckets at all — burn null, runway null, no delta. --status returns before
// that spawn, so two readings in one home stay reproducible.
test("render: easing off buys runway, and the delta says how much", () => {
  const home = freshHome();
  const status = () => JSON.parse(execFileSync("node", [path.join(HERE, "render.mjs"), "--status"],
    { input: weekStdin("wk-delta"), env: cleanEnv(home), encoding: "utf8" }));

  ledger(home, 2_000_000);                       // render 1: hot
  const first = status().runway;
  assert.ok(first.hours > 0, "a live burn must project a runway");
  assert.equal(first.deltaH, null, "the first reading has nothing to compare against");

  ledger(home, 200_000);                         // render 2: eased off 10x
  const s = status().runway;
  assert.ok(s.hours > first.hours, `a lighter burn must project a longer runway: ${first.hours} → ${s.hours}`);
  assert.ok(s.deltaH > 0, `easing off must show a positive delta: ${s.deltaH}`);
});

// The id on the bar exists to name THIS chat when talking to another one. That only works if it is
// the same string the other surfaces use: the owner dashboard names a session by an 8-char slice
// (server/handler.mjs top_burners), so a 4-char tag could not be pasted anywhere — and 4 hex chars
// is 65k values, close enough to collide across a day of sessions that it might name two chats.
test("render: the session id is a true 8-char handle, matching the dashboard", () => {
  const home = freshHome();
  const sid = "7bf3a19c-dead-beef-cafe-000000000000";
  const bar = renderBar(home, weekStdin(sid));
  assert.match(bar, /7bf3a19c/, `the bar must carry 8 chars of the id: ${JSON.stringify(bar)}`);
  assert.equal(statusOf(home).sessionId, sid, "status.json carries the FULL id for agents");
});

// Seen live right after the 4→8 widening: the bar came back as "… week 151h/18h │ Maxx · main │
// /maxx" — repo and branch present, the id gone. It was rank 10, the highest on the whole bar, so
// it shed FIRST; at four cells it usually squeaked in, and at eight it stopped fitting.
//
// That is backwards. Repo and branch are already on the prompt line and in the terminal title, so
// losing them costs nothing. The id appears nowhere else on screen, and it is the whole reason the
// tag exists — naming this chat to another one. It must be the LAST of the three to go.
test("render: a narrow pane sheds branch and repo before the session id", () => {
  const home = freshHome();
  const sid = "7bf3a19c-dead-beef-cafe-000000000000";
  const stdin = JSON.stringify({
    session_id: sid,
    workspace: { project_dir: "/Users/someone/Classified/Maxx" },
    gitBranch: "main",
    rate_limits: {
      five_hour: { used_percentage: 26, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 22, resets_at: in6d },
    },
    context_window: { used_percentage: 10, context_window_size: 1000000 },
    model: { display_name: "Opus" },
  });
  const at = (cols) => {
    const env = { ...process.env, HOME: home, COLUMNS: String(cols) };
    delete env.CLAUDE_CONFIG_DIR;
    return execFileSync("node", [path.join(HERE, "render.mjs")], { input: stdin, env, encoding: "utf8" })
      .replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  };
  // wide: everything fits, so the id is there to begin with
  assert.match(at(200), /7bf3a19c/, "a wide pane must show the id");

  // squeeze until something in the trailing group gives. The id survives every width at which
  // ANY of the three is still standing — that is the invariant, whatever the exact cut points are.
  for (let cols = 200; cols >= 60; cols -= 5) {
    const bar = at(cols);
    const hasId = bar.includes("7bf3a19c");
    if (bar.includes("main") || bar.includes("Maxx")) {
      assert.ok(hasId, `at ${cols} cols the id shed before repo/branch: ${JSON.stringify(bar)}`);
    }
  }
});

// Seen live on the tgp login: "chat 100%" one turn into a fresh chat, and every OTHER chat on that
// account also pinned at 100 — the tell that the denominator was wrong, not the chat.
//
// cap7 is inferred as spend ÷ Anthropic's %. limit.mjs divides a full-history transcript scan;
// render.mjs divides `tok`, a per-render anchor snapshot. On a box whose local ledger is thin
// against account-wide spend, tok/pct under-shoots hard: both logins sat at q7 = 0.06, gmail
// anchored 144M off a tok7a of 8.7M, tgp anchored 9M off a tok7a of 831k while its own window.json
// carried a brain cap of 95M. The chat row divides by that, so a perfectly ordinary 654k-token chat
// scored 7% of the week against a 5% line and clamped to 100.
test("render: a thin local ledger cannot under-infer the weekly cap past the brain's scan", () => {
  const home = freshHome();
  const now = Date.now();
  // the live shape: a brain cap far above what this box's own buckets would imply
  writeFileSync(path.join(home, ".maxx", "window.json"), JSON.stringify({
    buckets: [[now - 60 * 1000, 831_509]],       // thin: one small bucket is all this machine saw
    cap7: 95_099_583,                            // limit.mjs's full-history scan of the SAME account
    accountCreatedAt: now - 60 * 24 * 3600 * 1000,
  }));
  const stdin = JSON.stringify({
    session_id: "46296dc1-thin-ledger",
    rate_limits: {
      five_hour: { used_percentage: 8, resets_at: Math.floor(now / 1000) + 3600 },
      seven_day: { used_percentage: 6, resets_at: in6d },   // the live q7
    },
    context_window: { used_percentage: 13, context_window_size: 1000000 },
    model: { display_name: "Opus" },
  });
  const s = JSON.parse(execFileSync("node", [path.join(HERE, "render.mjs"), "--status"],
    { input: stdin, env: cleanEnv(home), encoding: "utf8" }));

  // 831509 / 0.06 = 13.9M, an order of magnitude under the brain's 95M — the anchor must defer.
  assert.ok(s.weekly.cap >= 95_099_583 / 3,
    `a thin ledger must not pin the weekly cap under a third of the brain's: ${s.weekly.cap}`);
});

// …and the consequence that made it visible: with a sane denominator an ordinary chat is not 100.
// The chat row divides epoch spend by cap7, so this is the same bug wearing the face the user sees.
test("render: an ordinary chat does not read 100% because the cap collapsed", () => {
  const home = freshHome();
  const now = Date.now();
  writeFileSync(path.join(home, ".maxx", "window.json"), JSON.stringify({
    buckets: [[now - 60 * 1000, 831_509]],
    cap7: 95_099_583,
    accountCreatedAt: now - 60 * 24 * 3600 * 1000,
  }));
  // The chat needs real epoch spend for the SHARE line to score at all — seeded straight into
  // turns.json (what turnCount reads) rather than synthesised as a transcript. 653908 is the live
  // figure from the session that showed this. Against the collapsed 13.9M cap that is 5% of the
  // week — dead on the 5% line — and against the true 95M cap it is well under 1%.
  writeFileSync(path.join(home, ".maxx", "turns.json"), JSON.stringify({
    "46296dc1-thin-ledger": { off: 0, n: 12, msgs: 24, ctx: 13, rid: null, w: 653_908, w0: 0, subs: {} },
  }));
  const stdin = JSON.stringify({
    session_id: "46296dc1-thin-ledger",
    rate_limits: {
      five_hour: { used_percentage: 8, resets_at: Math.floor(now / 1000) + 3600 },
      seven_day: { used_percentage: 6, resets_at: in6d },
    },
    context_window: { used_percentage: 13, context_window_size: 1000000 },  // 13 against a 35 line
    model: { display_name: "Opus" },
  });
  const bar = execFileSync("node", [path.join(HERE, "render.mjs")], { input: stdin, env: cleanEnv(home), encoding: "utf8" })
    .replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const m = bar.match(/chat (\d+)%/);
  assert.ok(m, `no chat reading in the bar: ${JSON.stringify(bar)}`);
  // With the true cap this chat is scored by its CONTEXT (13 against a 35 line = 37) because its
  // spend share is under 1%. With the collapsed cap the share line took over and drove it to 94.
  // Assert the context reading, not merely "< 100": the clamp means a badly wrong denominator can
  // still land under 100 and a loose bound would call that a pass.
  assert.equal(Number(m[1]), 37,
    `a chat 13% into its context is scored by context, not by a collapsed week: got ${m[1]}`);
});
