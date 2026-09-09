#!/usr/bin/env node
/**
 * maxx gate — the HARD budget gate. PreToolUse hook that DENIES token-expensive
 * tool calls (Agent / Task / Workflow spawns) when the central tally says the
 * account is over budget or the signal is stale. The MCP connector's
 * instructions are advisory; this is the enforcement layer — a PreToolUse deny
 * blocks the tool even in bypass mode, and cloud routines honor repo
 * .claude/settings.json hooks too.
 *
 * Hook mode (stdin JSON from Claude Code):
 *   deny  → {"hookSpecificOutput":{"permissionDecision":"deny", ...}}
 *   allow → exit 0, no output (normal permission flow continues)
 *
 * CLI:
 *   node gate.mjs --status              current gate state + policy + live verdict
 *   node gate.mjs --off                 disable (same as overturn, reason "manual off")
 *   node gate.mjs --on                  re-enable
 *   node gate.mjs --overturn "reason"   disable AND record the overturn: noted in
 *                                       ~/.maxx/gate.json + gate.log AND shipped to
 *                                       the central tally feed (visible in maxx watch)
 *
 * Fleet policy (every change is recorded to the central feed, like an overturn):
 *   --mode paced|spree     paced (default): hold to the per-window share.
 *                          spree: ignore pacing, spend until the weekly wall.
 *   --margin <pct>         paced only: allow spending <pct>% PAST the window share
 *                          (kept for config compatibility; pacing no longer denies).
 *   --weekly-stop <pct>    the hard reserve wall (default 99). Even spree stops at
 *                          this weekly %. Set 90 to always keep a 10% reserve.
 *   --fail open|closed     no fresh verdict: closed (default) denies, open allows.
 *
 * Fail-closed: no fresh verdict (server unreachable AND cache >10m old) → deny.
 * That is the whole point — an invisible budget must read as "no budget".
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

const HOME = homedir();
const DIR = path.join(HOME, ".maxx");
const CONFIG = path.join(DIR, "config.json");
const GATE = path.join(DIR, "gate.json");
// per-login: a CLAUDE_CONFIG_DIR session gates on ITS account's budget — the watcher
// writes one gate-cache per login root (suffix rule matches render/limit/emit)
const SUF = process.env.CLAUDE_CONFIG_DIR ? "-" + path.basename(process.env.CLAUDE_CONFIG_DIR).replace(/^\.claude-?/, "") : "";
const CACHE = path.join(DIR, `gate-cache${SUF}.json`);
const POLL = path.join(DIR, `directive-poll${SUF}.json`);
const STATUS = path.join(DIR, `status${SUF}.json`);        // the statusline's tick: per-chat standing lives in .chats
const HANDOFF = path.join(DIR, `handoff-told${SUF}.json`); // session → when it was last ordered to hand off
const HANDOFF_EVERY_SEC = 30 * 60;  // a chat past its line is told once, then left alone for half an hour
const POLL_EVERY_SEC = 60;        // an ungated tool call polls for directives at most this often
const LOG = path.join(DIR, "gate.log");
const CACHE_FRESH_SEC = 60;       // reuse a verdict this fresh without a network call
// Server unreachable: trust the last verdict this long. 10m was tuned for a fleet the author
// could see; for a paying customer it turns a routine blip — wifi drop, a deploy, a DNS hiccup —
// into "you cannot spawn agents", which reads as the product breaking their tool. An hour-old
// verdict is still a far better estimate than none, and the weekly wall moves slowly.
const CACHE_GRACE_SEC = 3600;
const GATED = /^(Agent|Task|Workflow|ScheduleWakeup|CronCreate)$/;

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const log = (line) => { try { mkdirSync(DIR, { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} };

const cfg = readJSON(CONFIG, {});
// Route to THIS session's account: its login (CLAUDE_CONFIG_DIR-aware .claude.json)
// resolved through cfg.accounts → that account's handle/secret. Fallback: the
// legacy top-level handle (single-account box).
try {
  const oa = JSON.parse(readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || HOME, ".claude.json"), "utf8")).oauthAccount;
  const t = cfg.accounts?.[oa?.accountUuid];
  if (t) { cfg.handle = t.handle; cfg.secret = t.secret; }
} catch {}
const base = (process.env.MAXX_LOGS_URL || cfg.logsUrl || "https://api.meetmaxx.co").replace(/\/$/, "");

async function budget() {
  const c = readJSON(CACHE, null);
  const age = c ? Date.now() / 1000 - c.at : Infinity;
  if (c && age < CACHE_FRESH_SEC) return c.b;
  try {
    const res = await fetch(`${base}/api/u/${encodeURIComponent(cfg.handle)}/budget`, {
      headers: { authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const b = await res.json();
    writeFileSync(CACHE, JSON.stringify({ at: Date.now() / 1000, b }));
    return b;
  } catch (e) {
    if (c && age < CACHE_GRACE_SEC) return c.b;   // brief outage: last verdict stands
    return { verdict: "unreachable", error: e.message };  // fail closed upstream
  }
}

// Ship a note into the central tally feed (billed:0 — visible, never counted).
async function note(kind, text) {
  try {
    await fetch(`${base}/api/u/${encodeURIComponent(cfg.handle)}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify({
        v: 1, surface: `gate:${hostname().slice(0, 8)}`, handle: cfg.handle,
        emitted_at: new Date().toISOString(), cursor: `${kind}-${Date.now()}`,
        sessions: [{ root: `${kind}-${Date.now()}`, name: text, billed: 0, last_ts: new Date().toISOString() }],
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

const args = process.argv.slice(2);
const gate = readJSON(GATE, {});
// policy with defaults — gate.json only stores what was explicitly set
const pol = {
  enabled: gate.enabled !== false,
  mode: gate.mode || "paced",
  margin: gate.margin_pct || 0,
  weeklyStop: gate.weekly_stop_pct ?? 99,
  fail: gate.fail_mode || "closed",
};
const polLine = () => `mode=${pol.mode} margin=${pol.margin}% weekly_stop=${pol.weeklyStop}% fail=${pol.fail}`;
const savePol = () => writeFileSync(GATE, JSON.stringify({
  enabled: pol.enabled, mode: pol.mode, margin_pct: pol.margin,
  weekly_stop_pct: pol.weeklyStop, fail_mode: pol.fail,
  ...(gate.overturn && !pol.enabled ? { overturn: gate.overturn } : {}),
}, null, 2));

if (args.includes("--status")) {
  const b = await budget();
  console.log(JSON.stringify({
    gate: pol.enabled ? "ON" : "OFF", mode: pol.mode, margin_pct: pol.margin,
    weekly_stop_pct: pol.weeklyStop, fail_mode: pol.fail, overturn: gate.overturn || null,
    verdict: b.verdict, week: b.usage_week_pct ?? null, week_live: !!b.usage_week_live,
    block_share_pct: b.block_share_pct ?? null, block_used_pct: b.block_used_pct ?? null,
    on_pace: b.on_pace ?? null,
    tokens_again: b.tokens_again ?? null,
  }, null, 2));
  process.exit(0);
}
if (args.includes("--on")) {
  pol.enabled = true; delete gate.overturn; savePol();
  log("gate ON");
  await note("gate-on", "GATE RE-ENABLED");
  console.log("maxx gate: ON");
  process.exit(0);
}
if (args.includes("--off") || args.includes("--overturn")) {
  const i = args.indexOf("--overturn");
  const reason = (i >= 0 && args[i + 1]) || "manual off";
  gate.overturn = { ts: new Date().toISOString(), reason, host: hostname() };
  pol.enabled = false; savePol();
  log(`gate OVERTURN: ${reason}`);
  await note("gate-overturn", `⚠ GATE OVERTURNED: ${reason}`);
  console.log(`maxx gate: OFF — overturn RECORDED (local gate.log + central feed): "${reason}"`);
  console.log("re-enable: node gate.mjs --on");
  process.exit(0);
}
// ---- fleet policy settings: every change is recorded like an overturn ----
if (args.some((a) => ["--mode", "--margin", "--weekly-stop", "--fail"].includes(a))) {
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const m = val("--mode");
  if (m) { if (!/^(paced|spree)$/.test(m)) { console.error("--mode paced|spree"); process.exit(1); } pol.mode = m; }
  const mg = val("--margin");
  if (mg != null) { const n = Number(mg); if (!(n >= 0 && n <= 500)) { console.error("--margin 0..500"); process.exit(1); } pol.margin = n; }
  const ws = val("--weekly-stop");
  if (ws != null) { const n = Number(ws); if (!(n >= 10 && n <= 100)) { console.error("--weekly-stop 10..100"); process.exit(1); } pol.weeklyStop = n; }
  const fm = val("--fail");
  if (fm) { if (!/^(open|closed)$/.test(fm)) { console.error("--fail open|closed"); process.exit(1); } pol.fail = fm; }
  savePol();
  log(`policy: ${polLine()}`);
  await note("gate-policy", `GATE POLICY: ${polLine()}`);
  console.log(`maxx gate policy set — RECORDED to central feed:\n  ${polLine()}`);
  if (pol.mode === "spree") console.log(`  ⚠ SPREE: pacing off — spending until the ${pol.weeklyStop}% weekly wall.`);
  process.exit(0);
}

// ---- hook mode: PreToolUse JSON on stdin ----
let input = "";
for await (const chunk of process.stdin) input += chunk;
let hook = {};
try { hook = JSON.parse(input); } catch { process.exit(0); }   // not a hook call → allow

const tool = hook.tool_name || "";
const gated = GATED.test(tool);

const riseText = (note) =>
  `MAXX DIRECTIVE — THIS CHAT IS PAST ITS LINE${note ? ` (${note})` : ""}. ` +
  `Every turn from here re-bills your whole context, so do not start new work. ` +
  `Finish only the step in flight, then PRESERVE THE THREAD, in this order: ` +
  `(1) write .fenix/handoff.md exactly per ~/.claude/skills/fenix/SKILL.md — what is in motion, ` +
  `decisions made, the next concrete step; (2) tell the user its id and that /clear picks it ` +
  `up; (3) END YOUR TURN — do not keep working here, every further turn re-bills this fat ` +
  `context. You cannot clear yourself: /clear is a human keystroke and no hook can send it.`;
// The LOCAL trigger for the same order. The statusline scores every chat against two lines —
// context vs the hand-off line, and spend vs one session's paced share of the week — and writes
// the standing to status.json each tick. Past either line, this chat is told to hand off, once
// per half hour: the point is one clear instruction at the right moment, not a nag on every
// tool call (each of which would re-bill the very context it is warning about).
function localHandoff(session) {
  if (!session) return null;
  const c = readJSON(STATUS, {}).chats?.[session];
  if (!c || Date.now() - (c.ts || 0) > 10 * 60 * 1000) return null;   // stale tick → unknown, not over
  const overCtx = c.ctxLine > 0 && c.ctxPct >= c.ctxLine;
  const overShare = c.shareLine > 0 && c.sharePct >= c.shareLine;
  if (!overCtx && !overShare) return null;
  const told = readJSON(HANDOFF, {});
  const now = Date.now() / 1000;
  if (now - (told[session] || 0) < HANDOFF_EVERY_SEC) return null;
  for (const [sid, at] of Object.entries(told)) if (now - at > 24 * 3600) delete told[sid];
  told[session] = now;
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(HANDOFF, JSON.stringify(told)); } catch {}
  const why = [
    overShare ? `this chat has spent ${c.sharePct}% of the week, past its ${c.shareLine}% share` : null,
    overCtx ? `context ${c.ctxPct}% is past the ${c.ctxLine}% hand-off line` : null,
  ].filter(Boolean).join("; ");
  log(`local handoff session=${session} ${why}`);
  return riseText(why);
}
// Advice, not a verdict: the handoff order carries even when the gate is OFF or this box has no
// maxx account — neither has anything to do with whether THIS chat is past its line.
const sayHandoff = (session) => {
  const h = localHandoff(session);
  if (h) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: h } }));
};
if (!pol.enabled) {
  // overturned — allow, already noted at overturn time; keep a local trace
  if (gated) log(`allow (gate OFF${gate.overturn ? `, overturn: ${gate.overturn.reason}` : ""}) tool=${tool}`);
  sayHandoff(hook.session_id);
  process.exit(0);
}
if (!cfg.handle || !cfg.secret) { sayHandoff(hook.session_id); process.exit(0); } // no maxx account → not our call, but still our chat

// A session that only edits and runs commands never spawns a gated tool, so gating the
// directive fetch on those alone left the loudest sessions — the ones grinding a build past
// the context wall — unreachable. Any tool call can carry a directive; ungated ones just poll
// at most once a minute, so the channel costs one request per session per minute, not one per
// tool call. Budget verdicts still ride only on the gated path, where the spend actually is.
function pollDue(session) {
  if (gated) return true;
  if (!session) return false;
  const now = Date.now() / 1000;
  const seen = readJSON(POLL, {});
  if (now - (seen[session] || 0) < POLL_EVERY_SEC) return false;
  // prune: a session id is dead once it stops calling tools, so don't grow this file forever
  for (const [s, at] of Object.entries(seen)) if (now - at > 3600) delete seen[s];
  seen[session] = now;
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(POLL, JSON.stringify(seen)); } catch {}
  return true;
}

// ---- directive channel: orchestrator → THIS session, via the tally ----
// GET consumes (clear = one-shot, pause = sticky until ttl/resume). Fail-open:
// a directive miss must never deny — the budget checks below still run.
async function directives(session) {
  if (!session) return [];
  try {
    const res = await fetch(
      `${base}/api/u/${encodeURIComponent(cfg.handle)}/directives?session=${encodeURIComponent(session)}`,
      { headers: { authorization: `Bearer ${cfg.secret}` }, signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()).directives || [];
  } catch { return []; }
}
const dirs = pollDue(hook.session_id) ? await directives(hook.session_id) : [];
const clearDir = dirs.find((d) => d.action === "clear");
// Two strengths. The advisory one asks for a /clear — fine when a human is watching the
// session. `rise` means the session is PAST the context wall, where every further turn
// re-bills the whole context: there, the priority is that the THREAD survives, so the
// directive orders the handoff written and the turn ended, in that order. The handoff is
// written by the model on purpose — fenix's own fallback is a raw transcript tail, which is
// a far worse thing to wake up to.
//
// It used to order `fenix.mjs --rise` here, which spawned a headless successor. That was
// removed 2026-08-27: it never produced a second generation in six attempts. Nothing can
// clear a session but the human — hooks talk through stdout/exit codes and cannot send a
// slash command — so the honest instruction is "save the thread and stop", not "renew
// yourself". Promising self-renewal it could not deliver is how the thread got lost.
const clearCtx = clearDir
  ? clearDir.rise
    ? riseText(clearDir.note)
    : `MAXX DIRECTIVE (orchestrator asks): /clear this session${clearDir.note ? ` — ${clearDir.note}` : ""}. ` +
      `Finish the immediate step cheaply, then tell the user to /clear (or /compact) before continuing.`
  : localHandoff(hook.session_id);

// Ungated tool: no spend to weigh, so the only thing to carry is the advisory. Never deny here —
// a pause still lands on the gated path, where the expensive work it means to stop actually is.
if (!gated) {
  if (clearCtx) {
    log(`clear-directive delivered on ungated tool=${tool}`);
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: clearCtx },
    }));
  }
  process.exit(0);
}

const deny = (why) => {
  log(`DENY tool=${tool} ${why} [${polLine()}]`);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `MAXX BUDGET GATE (${polLine()}): ${why} — no tokens for expensive work (${tool}). ` +
        `Do cheap work or wait — or the USER may adjust policy / explicitly overturn (recorded to the central feed): ` +
        `node ~/.claude/skills/maxx/gate.mjs --overturn "<reason>"` +
        (clearCtx ? ` | ${clearCtx}` : ""),
    },
  }));
  process.exit(0);
};
// allow, delivering any pending clear advisory as injected context
const allow = (why) => {
  log(`allow (${why}) tool=${tool}${clearCtx ? " +clear-directive" : ""}`);
  if (clearCtx)
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: clearCtx },
    }));
  process.exit(0);
};

const paused = dirs.find((d) => d.action === "pause");
if (paused)
  deny(`ORCHESTRATOR PAUSE${paused.note ? ` — "${paused.note}"` : ""}. This session is paused until ` +
       `${new Date(paused.expires * 1000).toISOString()} or a resume directive (maxx_directive action=resume)`);

const b = await budget();

// 1. signal health: stale/unreachable → fail per policy. "degraded" (no fresh /usage
// anchor, weekly standing still live off the server ledger) is NOT a stop — it falls
// through to the weekly wall and standing checks below, which are the real limits.
if (b.verdict === "calibrating") {
  deny("budget calibrating — no /usage anchor yet for this account. Open an interactive Claude Code session on a linked machine so the statusline can anchor the caps, then retry");
}
if (b.verdict === "stale" || b.verdict === "unreachable") {
  if (pol.fail === "open") allow(`fail-open, verdict=${b.verdict}`);
  // Fail-closed is the point of a budget gate — an invisible budget must read as no budget.
  // But a denial the user cannot act on is just a broken tool, so name the two ways out.
  deny(
    b.verdict === "unreachable"
      ? `cannot reach the maxx tally (${base}) and the cached verdict is over ${Math.round(CACHE_GRACE_SEC / 60)}m old, ` +
        `so spending is unmeasured (fail-closed). Check your connection, or work without the gate: ` +
        `node ~/.claude/skills/maxx/gate.mjs --fail open   (revert with --fail closed)`
      : `budget signal stale — no machine has read /usage recently enough to trust any wall. ` +
        `Open an interactive Claude Code session on a linked machine to re-anchor, or: ` +
        `node ~/.claude/skills/maxx/gate.mjs --fail open`,
  );
}
// 2. the weekly wall — absolute, even in spree, and ANTHROPIC's number or nothing. There is
// no longer a fallback estimate to fall back TO: the tank that used to supply one read 100%
// for two accounts whose real weeks were 100% and 82% (2026-08-13), denying work Anthropic
// was still serving. No live reading = no wall to enforce = fall through.
const realWeek = b.usage_week_live && b.usage_week_pct != null ? b.usage_week_pct : null;
if (realWeek != null && realWeek * 100 >= pol.weeklyStop) {
  // a weekly wall only lifts at week_reset — the 5h refill doesn't lower week %
  const wh = b.week_reset_in_sec != null ? `${Math.round(b.week_reset_in_sec / 3600)}h` : "?";
  deny(`weekly at ${Math.round(realWeek * 100)}% ≥ weekly_stop ${pol.weeklyStop}%. ` +
       `Tokens again: at week_reset (${wh})`);
}
// 3. spree: pacing off, wall already checked
if (pol.mode === "spree") allow("spree");
// 4. pacing is ADVICE, and advice does not deny (Reif, 2026-08-13: "it's just a counter").
// The payload is percentages now, so the advice is one comparison: what this block has spent
// against what it may spend, both as a share of the week. Overspending borrows from later
// blocks; only the checks above can stop a call, because only Anthropic can.
allow(
  b.on_pace === false
    ? `over this block's share (${b.block_used_pct}% of the week spent vs a ${b.block_share_pct}% share) — borrowing from later blocks`
    : "under budget",
);
