#!/usr/bin/env node
/**
 * fenix — burn down, rise with context. The maxx rebirth loop.
 *
 * The /fenix skill has the AGENT write .fenix/handoff.md (what's in motion, decisions,
 * next steps), then the human clears context. This file is the OTHER half:
 *
 *   node fenix.mjs --wake     SessionStart hook. If the cwd has a fresh unconsumed
 *                             handoff, print it (hook stdout becomes session context)
 *                             and mark it consumed — read=consume, exactly like the
 *                             maxx directive channel. Silent no-op otherwise.
 *   node fenix.mjs --status   Show pending/consumed handoffs for this directory.
 *
 * Unattended continuation (the "cron" half): after /fenix you can also relaunch
 * headless — `claude -p "$(cat .fenix/handoff.md)"` — or let the next interactive
 * session in this directory pick it up automatically via --wake.
 */
import { readFileSync, writeFileSync, writeSync, renameSync, statSync, readdirSync, existsSync, openSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";

const DIR = path.join(process.cwd(), ".fenix");
const HANDOFF = path.join(DIR, "handoff.md");
const MAX_AGE_H = 48; // a stale handoff is history, not context — never auto-inject old state

// Every fenix moment is a maxx event the owner wants in the dash tail — post it to the
// tally's ops ring. Best-effort with a hard timeout: fenix must never hang or fail on network.
async function postOp(op, d) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(process.env.HOME || "", ".maxx", "config.json"), "utf8"));
    if (!cfg.handle || !cfg.secret) return;
    const base = (process.env.MAXX_LOGS_URL || cfg.logsUrl || "https://api.meetmaxx.co").replace(/\/$/, "");
    await fetch(`${base}/api/u/${cfg.handle}/op`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ op, d }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
}

const arg = process.argv[2] || "--wake";

if (arg === "--wake") {
  // SessionStart hooks get {source: startup|clear|resume|compact} on stdin — after a /clear
  // with NO handoff, say so (the observed first-run failure: user cleared without /fenix
  // first, then "continue" had nothing to continue from). Manual runs (TTY) stay quiet.
  let src = "";
  try { if (!process.stdin.isTTY) src = (JSON.parse(readFileSync(0, "utf8") || "{}").source || ""); } catch {}
  try {
    const st = statSync(HANDOFF);
    const ageH = (Date.now() - st.mtimeMs) / 3600000;
    if (ageH > MAX_AGE_H) process.exit(0);
    const body = readFileSync(HANDOFF, "utf8");
    // DELIVERY IS NOT USE. Archiving on the first read meant the handoff belonged to
    // whichever session started first — and a SessionStart hook cannot make the model
    // take a turn, so a /clear you glance at and walk away from consumed the thread
    // without a single word of work being done. Observed exactly that: session
    // 92bd14d2 took the 16:48 handoff on a /clear, produced zero assistant turns, and
    // the real work happened in a session that started 30s later and got nothing.
    // So: keep the handoff live for a grace window and deliver it to every session that
    // starts inside it. Re-delivering a thread costs a duplicate paragraph; losing it
    // costs the thread.
    const GRACE_MIN = parseInt(process.env.MAXX_WAKE_GRACE_MIN || "20", 10);
    const dpath = path.join(DIR, "delivered.json");
    let dlv = null;
    try { dlv = JSON.parse(readFileSync(dpath, "utf8")); } catch {}
    if (dlv && dlv.handoff_mtime !== st.mtimeMs) dlv = null; // a NEW handoff supersedes
    const firstAt = dlv?.first_at || Date.now();
    const nth = (dlv?.count || 0) + 1;
    // Past the grace window the thread has been picked up (or abandoned) — archive it
    // quietly rather than injecting stale state into an unrelated session days later.
    if (Date.now() - firstAt > GRACE_MIN * 60000) {
      renameSync(HANDOFF, path.join(DIR, `handoff.consumed-${new Date().toISOString().replace(/[:.]/g, "-")}.md`));
      try { writeFileSync(dpath, JSON.stringify({ archived_at: Date.now() })); } catch {}
      process.exit(0);
    }
    const text =
      `🔥 FENIX — this session rises from a cleared one. The handoff below is what was in motion ` +
      `(written ${Math.round(ageH * 60)}m ago).` +
      (nth > 1 ? ` (Also delivered to ${nth - 1} earlier session${nth > 2 ? "s" : ""} in the last ${GRACE_MIN}m — if that work is already underway elsewhere, say so instead of redoing it.)` : "") +
      ` Resume it now without being asked: ` +
      `state in one line what you are picking up, verify its claims against the working tree, ` +
      `then continue that work.\n\n${body}\n`;
    // writeSync, not process.stdout.write: stdout is a PIPE here, so the async write returns
    // before the bytes land and the process.exit(0) below truncates whatever is still buffered.
    // Measured: a 320K handoff delivered exactly 65536 bytes (one pipe buffer) of invalid JSON.
    writeSync(1, JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }) + "\n");
    // Record the delivery only AFTER it is on the wire — a lost write must not count as
    // delivered, for the same reason the archive used to happen too early.
    try { writeFileSync(dpath, JSON.stringify({ first_at: firstAt, count: nth, handoff_mtime: st.mtimeMs })); } catch {}
    // Fire-and-forget: telemetry must never sit between delivery and exit.
    postOp("fenix:rise", `${path.basename(process.cwd())} · handoff consumed (${Math.round(ageH * 60)}m old)`).catch(() => {});
  } catch {
    if (src === "clear")
      writeSync(1, JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "fenix: no handoff in this directory — nothing carried over. Sequence is /fenix BEFORE /clear " +
            "(handoffs are per-directory, written to .fenix/handoff.md; fenix cannot resurrect an already-wiped thread).",
        },
      }) + "\n");
  }
  process.exit(0);
}

// --rise: the SELF-SUSTAINING rebirth. /clear is a human keystroke the model can't press —
// but a new process is a fresh context by construction. Each risen generation carries the
// standing order to fenix AGAIN when its context gets heavy or its turn would end with work
// in motion — so the chain continues until the mission is done or a brake trips:
//   · generation cap (.fenix/generation, default 5, MAXX_RISE_MAX_GEN overrides) — counted PER
//     UNIT OF WORK: the counter resets whenever HEAD moved since the last rise, so a chain that
//     keeps landing commits never trips it; only a chain landing nothing does.
//   · budget brake: at the 5h wall the rise is not refused but DELAYED — a detached sleeper
//     re-runs --rise right after the window refills (the "cron" half, no crontab needed).
// Child flags: --permission-mode acceptEdits by default; MAXX_RISE_FLAGS overrides.
if (arg === "--rise") {
  if (!existsSync(HANDOFF)) { console.error("fenix: no pending handoff to rise from."); process.exit(1); }
  const GEN_F = path.join(DIR, "generation");
  // The cap is a RUNAWAY brake, not a lifetime quota. Counting every rise a directory ever did
  // kills the chain at generation 5 even when each generation landed clean work — punishing the
  // healthy long-running case at exactly the moment continuity matters most. So the counter is
  // scoped to a unit of work: it RESETS whenever HEAD moved (something landed) since the last
  // rise. Cap now means "5 rises in a row that landed nothing", which is the actual runaway.
  const head = (() => {
    try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return ""; } // not a git repo → no landing signal, fall back to plain lifetime counting
  })();
  const prev = (() => {
    try {
      const v = JSON.parse(readFileSync(GEN_F, "utf8"));
      return typeof v === "number" ? { gen: v, head: "" } : { gen: v.gen || 0, head: v.head || "" };
    } catch { return { gen: 0, head: "" }; }
  })();
  const landed = Boolean(head && prev.head && head !== prev.head);
  const gen = landed ? 0 : prev.gen;
  if (landed) console.log(`fenix: work landed since last rise (${prev.head.slice(0, 7)} → ${head.slice(0, 7)}) — generation counter reset.`);
  const maxGen = parseInt(process.env.MAXX_RISE_MAX_GEN || "5", 10);
  if (gen >= maxGen) { console.error(`fenix: generation cap (${gen}/${maxGen} rises with NOTHING landed) — chain ends here. Commit progress and rise again, or rm .fenix/generation.`); process.exit(1); }
  // budget brake — the maxx window cache knows if we're at the wall
  const HOME = process.env.HOME || "";
  let win = null, rl = null;
  try { win = JSON.parse(readFileSync(path.join(HOME, ".maxx", "window.json"), "utf8")); } catch {}
  try { rl = JSON.parse(readFileSync(path.join(HOME, ".maxx", "rl.json"), "utf8")); } catch {}
  const atWall = win && (win.sessionToSpend === 0 || win.sessionOver > 0);
  if (atWall && !process.env.MAXX_RISE_NOW) {
    const resetAt = rl && rl.fiveResetAt ? rl.fiveResetAt * 1000 : Date.now() + 3600000;
    const delaySec = Math.max(60, Math.round((resetAt - Date.now()) / 1000) + 120);
    const self = process.argv[1];
    const sleeper = spawn("sh", ["-c", `sleep ${delaySec} && MAXX_RISE_NOW=1 node "${self}" --rise`],
      { cwd: process.cwd(), detached: true, stdio: "ignore" });
    sleeper.unref();
    console.log(`fenix: at the wall — rise scheduled in ${Math.round(delaySec / 60)}m (when the window refills). sleeper pid ${sleeper.pid}`);
    await postOp("fenix:delayed", `${path.basename(process.cwd())} · at the wall, rise in ${Math.round(delaySec / 60)}m`);
    process.exit(0);
  }
  const body = readFileSync(HANDOFF, "utf8");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(HANDOFF, path.join(DIR, `handoff.consumed-${ts}.md`)); // consume FIRST: the child's --wake hook must not double-inject
  writeFileSync(GEN_F, JSON.stringify({ gen: gen + 1, head }));
  const log = path.join(DIR, `rise-${ts}.log`);
  const fd = openSync(log, "a");
  const flags = (process.env.MAXX_RISE_FLAGS || "--permission-mode acceptEdits").split(/\s+/).filter(Boolean);
  const prompt =
    `🔥 FENIX RISE — generation ${gen + 1}/${maxGen}. You are the continuation of a cleared session. ` +
    `Resume the handoff below; verify its claims against the working tree first.\n\n` +
    `STANDING ORDER (this is what makes you a phoenix, not a fork): when your context passes ~70%, ` +
    `or you must stop with work still in motion, run /fenix again — write .fenix/handoff.md exactly per ` +
    `the fenix skill, then run \`node ${process.argv[1]} --rise\` and END your turn. The next generation ` +
    `continues. If the mission is COMPLETE, write .fenix/DONE.md with the outcome instead and stop.\n\n${body}`;
  const child = spawn("claude", ["-p", prompt, ...flags], { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  console.log(`fenix: risen — generation ${gen + 1}/${maxGen} · pid ${child.pid} · log ${log}`);
  await postOp("fenix:risen", `${path.basename(process.cwd())} · generation ${gen + 1}/${maxGen}`);
  process.exit(0);
}

if (arg === "--status") {
  if (!existsSync(DIR)) { console.log("fenix: no .fenix/ here — nothing pending."); process.exit(0); }
  const pending = existsSync(HANDOFF) ? `PENDING (${Math.round((Date.now() - statSync(HANDOFF).mtimeMs) / 60000)}m old)` : "none";
  const consumed = readdirSync(DIR).filter((f) => f.startsWith("handoff.consumed-")).length;
  console.log(`fenix: pending handoff: ${pending} · consumed: ${consumed}`);
  process.exit(0);
}

console.error("fenix: unknown arg (use --wake | --rise | --status)");
process.exit(1);
