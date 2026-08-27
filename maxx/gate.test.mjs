// The directive channel has to reach the sessions that actually run away — and those are
// rarely the ones spawning agents. A builder grinding a single file past the context wall
// calls Edit and Bash all day and never touches a gated tool, so delivery cannot be tied to
// the gated path alone. These cover that: ungated tools carry the advisory, cheaply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "gate.mjs");

// A stand-in tally that hands out one clear directive and counts who asked.
function directiveServer(directives) {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ directives }));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      hits,
      close: () => srv.close(),
    }));
  });
}

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-gate-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  writeFileSync(path.join(home, ".maxx", "config.json"),
    JSON.stringify({ handle: "ha", secret: "sa" }));
  return home;
}

// Runs the hook and returns whatever it printed (empty string = silent allow). Async on
// purpose: the stand-in tally lives in THIS process, and a sync spawn would block the event
// loop so the server could never answer the request the hook is waiting on.
const run = promisify(execFile);
async function hook(home, url, { tool, session }) {
  const child = run("node", [GATE], {
    env: { ...process.env, HOME: home, MAXX_LOGS_URL: url, CLAUDE_CONFIG_DIR: "" },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify({ tool_name: tool, session_id: session }));
  return (await child).stdout.trim();
}

test("gate: a clear directive reaches a session whose only tool is an ungated one", async () => {
  const srv = await directiveServer([{ action: "clear", note: "ctx 613k" }]);
  try {
    const out = await hook(makeHome(), srv.url, { tool: "Edit", session: "s-grinder" });
    assert.ok(out, "ungated tool delivered nothing — the directive never reaches this session");
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(j.hookSpecificOutput.additionalContext, /\/clear this session/);
    assert.match(j.hookSpecificOutput.additionalContext, /ctx 613k/, "the note must survive");
    assert.equal(j.hookSpecificOutput.permissionDecision, undefined, "an ungated tool must never be denied");
  } finally { srv.close(); }
});

test("gate: an ungated tool polls at most once a minute per session", async () => {
  const srv = await directiveServer([]);
  try {
    const home = makeHome();
    for (let i = 0; i < 3; i++) await hook(home, srv.url, { tool: "Edit", session: "s-chatty" });
    assert.equal(srv.hits.length, 1, `polled ${srv.hits.length}× — a per-tool-call fetch is too hot`);
    // a DIFFERENT session must not be silenced by its neighbour's poll
    await hook(home, srv.url, { tool: "Edit", session: "s-other" });
    assert.equal(srv.hits.length, 2, "one session's poll suppressed another's");
  } finally { srv.close(); }
});

// The whole point of rise: /clear is a keystroke no hook can send, so an unattended session
// past the wall must be handed a sequence it can run itself — handoff first, then relaunch.
test("gate: a past-the-wall directive orders handoff-then-stop, not a note for the user", async () => {
  const srv = await directiveServer([{ action: "clear", rise: true, note: "ctx 613k is past the 250k wall" }]);
  try {
    const out = await hook(makeHome(), srv.url, { tool: "Edit", session: "s-past-wall" });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /--rise/, "the rise chain was removed — it never reached a second generation");
    assert.match(ctx, /\.fenix\/handoff\.md/, "the model must write the handoff — fenix's fallback is a raw transcript tail");
    assert.ok(ctx.indexOf(".fenix/handoff.md") < ctx.indexOf("END YOUR TURN"), "write the handoff BEFORE ending the turn, or the thread is lost");
    assert.doesNotMatch(ctx, /tell the user to \/clear/, "nobody is there to tell");
    assert.match(ctx, /ctx 613k is past the 250k wall/, "keep the reason");
    // the rise starts a successor, it does not kill this session — carrying on after it means
    // the fat context keeps billing AND two sessions run at once
    assert.match(ctx, /END YOUR TURN/, "without this the risen pair both keep burning");
    assert.match(ctx, /END YOUR TURN/, "past the wall the session must STOP — every further turn re-bills the fat context");
  } finally { srv.close(); }
});

test("gate: a clear WITHOUT rise stays advisory — no handoff for a merely pricey session", async () => {
  const srv = await directiveServer([{ action: "clear", note: "cost per turn is climbing" }]);
  try {
    const out = await hook(makeHome(), srv.url, { tool: "Edit", session: "s-climbing" });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /handoff\.md/, "a session that is merely getting pricey should not be told to hand off");
    assert.match(ctx, /tell the user to \/clear/);
  } finally { srv.close(); }
});

// Fail-closed is the point of a budget gate, but the denial is the only thing the customer
// sees during an outage. If it does not name a way out it reads as "maxx broke my agents".
test("gate: an unreachable tally denies with a message the customer can act on", async () => {
  // nothing listening on this port, and a fresh HOME means no cached verdict to fall back on
  const out = await hook(makeHome(), "http://127.0.0.1:1", { tool: "Task", session: "s-outage" });
  const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /permissionDecision|cannot reach|unreachable/i);
  assert.match(reason, /--fail open/, "a denial with no escape hatch is indistinguishable from a broken tool");
  assert.match(reason, /gate\.mjs/, "name the command, not just the flag");
});

test("gate: no directive pending → ungated tool stays silent", async () => {
  const srv = await directiveServer([]);
  try {
    assert.equal(await hook(makeHome(), srv.url, { tool: "Edit", session: "s-quiet" }), "");
  } finally { srv.close(); }
});


// ---------------------------------------------------------------------------
// The gate denies on Anthropic's numbers, never on ours (2026-08-13).
//
// Live that day: both accounts had session_to_spend=0 and week=1.0 against maxx's own 1B
// tank, while Anthropic had them at 100% and 82% of the real week. This gate turned the
// second one — an account with 242M real tokens left — into a refused tool call.
// ---------------------------------------------------------------------------

// A stand-in tally that answers /budget with a fixed payload.
function budgetServer(budget) {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.includes("/budget") ? budget : { directives: [] }));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      close: () => srv.close(),
    }));
  });
}

// The gate ships disabled-by-default thresholds (weekly_stop 99); these tests set an explicit
// policy so the RULE is what is under test, not the shipped threshold.
function makeHomeWithPolicy(policy) {
  const home = makeHome();
  writeFileSync(path.join(home, ".maxx", "gate.json"), JSON.stringify({ enabled: true, mode: "paced", weekly_stop_pct: 95, ...policy }));
  return home;
}

const denial = (out) => {
  if (!out) return null;
  const j = JSON.parse(out);
  return j.hookSpecificOutput?.permissionDecision === "deny"
    ? j.hookSpecificOutput.permissionDecisionReason : null;
};

test("gate: a spent coin tank does not deny while Anthropic's week has room", async () => {
  const srv = await budgetServer({
    verdict: "ok", week: 1.0, quota: 1.0,                    // our tank: pinned, spent
    usage_week_live: true, usage_week_pct: 0.82,             // Anthropic: 18% of the week left
    usage_five_live: true, usage_five_pct: 0.26,
    session_to_spend: 0, session_over: 5e6, five_billed: 95e6,
    fresh: true, anchor_age_sec: 30,
  });
  try {
    const out = await hook(makeHomeWithPolicy(), srv.url, { tool: "Task", session: "s-coins" });
    assert.equal(denial(out), null, `coin tank denied an account Anthropic still serves: ${denial(out)}`);
  } finally { srv.close(); }
});

test("gate: Anthropic's weekly wall still denies", async () => {
  const srv = await budgetServer({
    verdict: "ok", week: 0.1,                                 // our tank: barely used
    usage_week_live: true, usage_week_pct: 0.97,              // Anthropic: at the wall
    usage_five_live: true, usage_five_pct: 0.2,
    session_to_spend: 5e6, week_reset_in_sec: 7200,
    fresh: true, anchor_age_sec: 30,
  });
  try {
    const reason = denial(await hook(makeHomeWithPolicy(), srv.url, { tool: "Task", session: "s-wall" }));
    assert.ok(reason, "Anthropic's own weekly wall no longer stops anything");
    assert.match(reason, /weekly at 97%/);
    assert.doesNotMatch(reason, /coin estimate/, "a live anchor must not be labelled an estimate");
  } finally { srv.close(); }
});

test("gate: with no live Anthropic reading, nothing may wall the account", async () => {
  // The old law let our own weekly standing deny when the real one was missing. It read 0.99
  // for accounts whose real weeks were at 82%, so a blind pass became a refused tool call.
  // Blind means UNKNOWN. Only a live /usage reading can close the gate.
  const srv = await budgetServer({
    verdict: "ok", usage_week_pct: 0.99, usage_week_live: false,
    session_to_spend: 1e6, week_reset_in_sec: 7200,
    fresh: true, anchor_age_sec: 30,
  });
  try {
    const reason = denial(await hook(makeHomeWithPolicy(), srv.url, { tool: "Task", session: "s-blind" }));
    assert.equal(reason, null, `a dead window must not wall a live account, got: ${reason}`);
  } finally { srv.close(); }
});
