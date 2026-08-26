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
 *   node fenix.mjs --recover <id>   Print the handoff with that id (live or archived).
 *   node fenix.mjs --compact [--list] [--keep N]   Bound the archive (default keep 20).
 *
 * Unattended continuation (the "cron" half): after /fenix you can also relaunch
 * headless — `claude -p "$(cat .fenix/handoff.md)"` — or let the next interactive
 * session in this directory pick it up automatically via --wake.
 */
import { readFileSync, writeFileSync, writeSync, renameSync, statSync, readdirSync, existsSync, openSync, unlinkSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const DIR = path.join(process.cwd(), ".fenix");
const HANDOFF = path.join(DIR, "handoff.md");
const MAX_AGE_H = 48; // a stale handoff is history, not context — never auto-inject old state

const IDFILE = path.join(DIR, "handoff.id");

// THE HANDOFF ID (Reif, 2026-08-26: "emit an id each time, a hash of the claude session id,
// its time stamp and the name of the session").
//
// WHY a filename was not enough: ".fenix/handoff.md" is the same nine bytes every generation.
// Asking "which handoff?" had no answer, so a respawn could not NAME what it was resuming and
// the human could not point at one. An id must be stable for one handoff, different for the
// next, and derivable from what the session already knows.
//
// Three inputs, hashed to a short token: claude session id (which conversation) + timestamp
// (which moment) + session name (which repo). The session id ALONE is insufficient -- one
// session writes many handoffs across a long day and they would collide.
function sessionName() {
  return path.basename(process.cwd()) || "session";
}
function claudeSessionId() {
  // The SessionStart hook payload carries session_id; a manual CLI run does not. Fall back to
  // the env, then to a marker -- an id that is coarse beats no id, and the timestamp still
  // makes every handoff distinct.
  return process.env.CLAUDE_SESSION_ID || process.env.MAXX_SESSION_ID || "";
}
function makeHandoffId(sid, tsMs, name) {
  const ts = new Date(tsMs).toISOString();
  const h = createHash("sha256").update([sid || "nosid", ts, name].join("|")).digest("hex").slice(0, 8);
  const stamp = ts.slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return "fx-" + name + "-" + stamp + "-" + h;
}
function readHandoffId() {
  try { return JSON.parse(readFileSync(IDFILE, "utf8")); } catch { return null; }
}
// Mint (or re-read) the id for the CURRENT pending handoff. Keyed on the handoff's mtime, so the
// id is STABLE while that handoff stands and is reminted the instant a new one is written.
function ensureHandoffId(sid) {
  let mtime = 0;
  try { mtime = statSync(HANDOFF).mtimeMs; } catch { return null; }
  const prev = readHandoffId();
  if (prev && prev.handoff_mtime === mtime && prev.id) return prev;
  const name = sessionName();
  const rec = {
    id: makeHandoffId(sid || claudeSessionId(), mtime, name),
    session_id: sid || claudeSessionId() || null,
    session_name: name,
    created_at: new Date(mtime).toISOString(),
    handoff_mtime: mtime,
  };
  try { writeFileSync(IDFILE, JSON.stringify(rec, null, 2)); } catch {}
  return rec;
}

// THE MICRO-COMPACT (Reif, same directive: "I dont like to have to have the agent spend 20
// turns trying to remember what was done ... so its like a micro-compact").
//
// The measure of a handoff is TURNS-TO-PRODUCTIVE-WORK in the next session. A handoff that is
// merely present still costs ~20 turns if the agent has to re-run git, re-read PRs and
// re-derive where it was. So the wake injection leads with a compacted HEAD BLOCK -- id, the
// one next action, and live repo facts read at WAKE time (not at write time, when they were
// already going stale) -- before the prose body. First tool call should be real work.
//
// Facts are gathered at injection because a handoff written an hour ago may name a PR that has
// since merged; stale facts asserted confidently are worse than no facts (the repo's own
// verification standard). Everything here is cheap, local, and best-effort.
function microCompact(rec) {
  const sh = (cmd, args) => {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000,
      }).trim();
    } catch { return ""; }
  };
  const L = [];
  if (rec && rec.id) L.push("handoff-id: " + rec.id);
  const inRepo = sh("git", ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (inRepo) {
    const idRecState = existsSync(HANDOFF) ? readHandoffId() : null;
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const head = sh("git", ["rev-parse", "--short", "HEAD"]);
    const subj = sh("git", ["log", "-1", "--format=%s"]);
    if (branch) L.push("branch: " + branch + " @ " + head + (subj ? " - " + subj : ""));
    const dirty = sh("git", ["status", "--porcelain"]).split("\n").filter(Boolean);
    if (dirty.length) L.push("uncommitted: " + dirty.length + " file(s)");
    const up = sh("git", ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    if (up) {
      const ahead = sh("git", ["rev-list", "--count", up + "..HEAD"]);
      if (ahead && ahead !== "0") L.push("UNPUSHED: " + ahead + " commit(s)");
    }
    const prs = sh("gh", ["pr", "list", "--limit", "6", "--json", "number,title",
                          "--jq", '.[] | "#\\(.number) \\(.title)"']);
    L.push(prs ? "open PRs: " + prs.split("\n").filter(Boolean).join(" | ") : "open PRs: none");
  }
  return L;
}
// Pull the "In motion (do this first)" section out of the handoff body -- that is the single
// line that decides the next session's first move, and it must not be buried under prose.
function firstAction(body) {
  const m = body.match(/##\s*In motion[^\n]*\n([\s\S]*?)(?:\n##\s|\s*$)/i);
  if (!m) return "";
  const line = m[1].split("\n").map((x) => x.trim())
    .find((x) => x && !x.startsWith("<!--"));
  if (!line) return "";
  // Strip list bullets and markdown emphasis so the action reads as a sentence, not as
  // half-eaten markup ("*Dispatch gh#3305" -- the leading ** of a bold run got clipped).
  return line.replace(/^[-*+]\s+/, "").replace(/\*\*/g, "").replace(/^`|`$/g, "").slice(0, 400);
}

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
  let sid = "";
  try {
    if (!process.stdin.isTTY) {
      const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
      src = payload.source || "";
      // session_id is what makes the handoff id traceable back to a real conversation.
      sid = payload.session_id || payload.sessionId || "";
    }
  } catch {}
  // source:"resume" means Claude Code just replayed the FULL prior transcript — this is
  // not a fresh/light session, so the handoff brief is redundant (the resumed context
  // already has everything it would say) and stacking it on top only adds tokens to an
  // already-large first turn, right as context-governor is about to fire on that same
  // turn for the resume itself. Observed 2026-08-21: a resume's inherited bloat alone
  // was enough to trip the governor before any real work — injecting the handoff too
  // just made that turn's context bigger for no benefit. startup/clear/compact are
  // genuinely fresh and still get the handoff normally.
  if (src === "resume") process.exit(0);
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
      const _arcId = readHandoffId();
      renameSync(HANDOFF, path.join(DIR, `handoff.consumed-${_arcId && _arcId.id ? _arcId.id : new Date().toISOString().replace(/[:.]/g, "-")}.md`));
      try { writeFileSync(dpath, JSON.stringify({ archived_at: Date.now() })); } catch {}
      process.exit(0);
    }
    // MICRO-COMPACT: lead with the id, the one next action, and repo facts read RIGHT NOW,
    // so the next session's first tool call is work rather than archaeology.
    const idRec = ensureHandoffId(sid);
    const compactLines = microCompact(idRec);
    const nextAction = firstAction(body);
    if (nextAction) compactLines.push("NEXT: " + nextAction);
    const compactBlock = compactLines.length
      ? "```\n" + compactLines.join("\n") + "\n```\n\n"
      : "";
    const text =
      `🔥 FENIX — this session rises from a cleared one. The handoff below is what was in motion ` +
      `(written ${Math.round(ageH * 60)}m ago).` +
      (nth > 1 ? ` (Also delivered to ${nth - 1} earlier session${nth > 2 ? "s" : ""} in the last ${GRACE_MIN}m — if that work is already underway elsewhere, say so instead of redoing it.)` : "") +
      ` Resume it now without being asked: ` +
      `state in one line what you are picking up, verify its claims against the working tree, ` +
      `then continue that work.\n\n${compactBlock}${body}\n`;
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

// WHY A RISEN SESSION GETS TOOLS, AND WHY THIS LIST (2026-08-14).
//
// The rise chain did not work. Measured across every --rise this machine has ever run — six
// logs in nonprofit-atlas/.fenix/ — ZERO reached a second generation, and `.fenix/generation`
// still read `{"gen":1}` after weeks. Four of the six ended by ASKING FOR PERMISSION:
//
//     "Approve those (or run /config → allow gh + git), and I'll do the salvage..."
//     "Bash(git checkout:*) Bash(git reset:*) Bash(git branch:*)"        ← the child listing
//                                                                          what it was denied
//
// The cause was one line: the child spawned with `--permission-mode acceptEdits` and NO
// --allowedTools. acceptEdits covers file edits; every git/gh/test command still prompts, and
// a detached headless process has nobody to answer the prompt. So each generation woke up,
// read its handoff, reached for `git status`, and stopped. The prompt told it to be a phoenix
// while the flags made that impossible — the standing order and the permissions disagreed, and
// the permissions won every time.
//
// Reif, 2026-08-14, asked for the full loop including merge. So: everything needed to take a
// unit of work from handoff to landed — read the tree, run the tests, commit, push, open a PR,
// and merge it through the same gates a human PR passes.
//
// The three exclusions are NOT timidity, they are the failure modes that cannot be undone by
// the next generation:
//   · `git push --force` / `--force-with-lease` — rewrites history a sibling session may hold.
//   · `git push origin main` — main is protected and deploys on merge; the PR path exists so
//     CI gates every change. A direct push skips the gate that makes autonomy safe.
//   · `git stash` — refs/stash is ONE stack shared across every worktree of a repo. A headless
//     chain popping a sibling's stash has already cost real recovery work (see
//     nonprofit-atlas docs/ops/worktree-safety.md).
// Merge is allowed and force-push is not, because a bad merge is revertible and a rewritten
// history is not.
//
// Override with MAXX_RISE_FLAGS for a narrower or wider chain; this default is what makes the
// loop self-sustaining rather than a well-documented way to generate permission requests.
const DEFAULT_RISE_FLAGS = [
  "--permission-mode", "acceptEdits",
  "--allowedTools",
  // read the world
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
  "Bash(git branch:*)", "Bash(git fetch:*)", "Bash(git ls-remote:*)", "Bash(git rev-parse:*)",
  "Bash(git rev-list:*)", "Bash(git worktree:*)",
  // change the world
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(git push:*)", "Bash(git checkout:*)",
  "Bash(git switch:*)", "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git revert:*)",
  // ship it
  "Bash(gh pr create:*)", "Bash(gh pr view:*)", "Bash(gh pr list:*)", "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)", "Bash(gh pr comment:*)", "Bash(gh pr edit:*)", "Bash(gh pr merge:*)",
  "Bash(gh run list:*)", "Bash(gh run view:*)", "Bash(gh api:*)", "Bash(gh issue:*)",
  // prove it
  "Bash(pytest:*)", "Bash(python -m pytest:*)", "Bash(python3 -m pytest:*)",
  "Bash(npm test:*)", "Bash(node --test:*)", "Bash(curl:*)",
  "Read", "Grep", "Glob", "Edit", "Write",
  "--disallowedTools",
  "Bash(git push --force:*)", "Bash(git push --force-with-lease:*)",
  "Bash(git push origin main:*)", "Bash(git stash:*)",
];
// AN ARRAY, NOT A JOINED STRING — and this cost a live generation to learn (2026-08-14).
//
// The first version of this list was `[...].join(" ")` and the spawn did `.split(/\s+/)`.
// Almost every useful grant contains a space — `Bash(git status:*)`, `Bash(gh pr merge:*)`,
// `Bash(python -m pytest:*)` — so the round trip shattered all of them into fragments, and the
// child got `-m`, `--test:*)`, `--force:*)` as bare argv tokens. Observed, first real rise:
//
//     $ cat .fenix/rise-2026-08-14T17-41-55-419Z.log
//     error: unknown option '-m'
//
// The child died in under a second, exactly like the six permission-blocked rises before it —
// same symptom (no generation 2), completely different cause. The unit tests passed throughout
// because they asserted the list CONTAINED the right tools; nothing asserted the list survives
// the trip through argv. A flag list that cannot be spawned is not a flag list.
//
// MAXX_RISE_FLAGS (a string, from the environment) still splits on whitespace: a shell env var
// has no other honest reading, and an override is a deliberate act. The DEFAULT never goes
// through a string at all.

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
  const flags = process.env.MAXX_RISE_FLAGS
    ? process.env.MAXX_RISE_FLAGS.split(/\s+/).filter(Boolean)
    : DEFAULT_RISE_FLAGS;
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

// --state: the facts, gathered by MACHINE, for the model to paste into its handoff.
//
// WHY. A handoff is written at the worst possible moment for recall — 70-90% context, right
// after a long session. Measured across the 98 handoffs in nonprofit-atlas/.fenix/, only ~35%
// carried the sections the skill asks for and 13% pasted any real command output; the rest is
// remembered prose. But the session does not need to REMEMBER any of this: git already knows
// the branch, the HEAD, what is uncommitted, and what is unpushed, and `gh` knows the open PRs.
//
// So stop asking the model for facts it can look up. This prints a block it pastes verbatim,
// and it spends its remaining context on the part no tool can produce: WHY, what is next, and
// which traps cost time. Deterministic, ~zero tokens, and it cannot misremember a SHA.
if (arg === "--state") {
  const sh = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { return ""; }
  };
  const inRepo = sh("git", ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!inRepo) { console.log("## State (machine-gathered)\n\n- not a git repository"); process.exit(0); }

  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = sh("git", ["rev-parse", "--short", "HEAD"]);
  const subject = sh("git", ["log", "-1", "--format=%s"]);
  const dirty = sh("git", ["status", "--porcelain"]).split("\n").filter(Boolean);
  const upstream = sh("git", ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const ahead = upstream ? sh("git", ["rev-list", "--count", `${upstream}..HEAD`]) : "";
  const unpushed = ahead && ahead !== "0"
    ? sh("git", ["log", "--oneline", `${upstream}..HEAD`]).split("\n").filter(Boolean)
    : [];
  // Commits this session plausibly made: today, by anyone, on this branch. Cheap and honest —
  // labelled as "today" rather than claimed as "mine", because git cannot tell the difference.
  const today = sh("git", ["log", "--since", "6 hours ago", "--oneline"]).split("\n").filter(Boolean);
  const prs = sh("gh", ["pr", "list", "--limit", "10", "--json", "number,title,headRefName",
                        "--jq", '.[] | "#\\(.number) [\\(.headRefName)] \\(.title)"'])
    .split("\n").filter(Boolean);

  const L = [];
  L.push("## State (machine-gathered — do not retype from memory)");
  L.push("");
  L.push(`- branch: \`${branch}\` @ \`${head}\` — ${subject || "(no commits)"}`);
  L.push(`- working tree: ${dirty.length ? `**${dirty.length} uncommitted change(s)**` : "clean"}`);
  if (dirty.length) {
    for (const d of dirty.slice(0, 12)) L.push(`    ${d}`);
    if (dirty.length > 12) L.push(`    …and ${dirty.length - 12} more`);
  }
  if (unpushed.length) {
    L.push(`- **UNPUSHED: ${unpushed.length} commit(s) ahead of ${upstream}** — these exist only on this machine:`);
    for (const c of unpushed.slice(0, 8)) L.push(`    ${c}`);
  } else if (upstream) {
    L.push(`- in sync with \`${upstream}\``);
  } else {
    L.push("- **no upstream** — this branch has never been pushed");
  }
  if (today.length) {
    L.push(`- landed in the last 6h (${today.length}):`);
    for (const c of today.slice(0, 10)) L.push(`    ${c}`);
  }
  if (prs.length) {
    L.push("- open PRs:");
    for (const p of prs) L.push(`    ${p}`);
  }
  // CARRY-FORWARD. The single most important line of the last handoff was its "In motion" —
  // the one thing the next session was told to do first. Nothing has ever checked whether it
  // got done. Observed 2026-08-14: a handoff correctly said "finish the multidimensional
  // scoring model, it is HALF-WRITTEN and uncommitted"; the next session was redirected into
  // a production outage within seconds and the item was still untouched eight hours later,
  // with no trace that it had been dropped. A thread that silently evaporates is exactly the
  // failure fenix exists to prevent, so surface the prior ask and make the new handoff answer
  // for it — done, still in motion, or deliberately dropped.
  try {
    const prior = readdirSync(DIR).filter(f => f.startsWith("handoff.consumed-")).sort().pop();
    if (prior) {
      const text = readFileSync(path.join(DIR, prior), "utf8");
      const m = text.match(/##\s*In motion[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
      const gist = (m ? m[1] : "").split("\n").map(s => s.trim())
        .filter(s => s && !s.startsWith("<!--")).slice(0, 4);
      if (gist.length) {
        L.push("");
        L.push(`### The LAST handoff asked the next session to do this first (${prior.replace("handoff.consumed-", "").replace(".md", "")}):`);
        for (const g of gist) L.push(`> ${g}`);
        L.push("");
        L.push("**Say what happened to it — done / still in motion / dropped and why.** An item that");
        L.push("silently disappears between generations is the failure this whole mechanism exists to stop.");
      }
    }
  } catch {}

  L.push("");
  L.push("_Everything above is read from git/gh at handoff time. Spend your words on WHY,");
  L.push("what is next, and the traps — not on restating these._");
  console.log(L.join("\n"));
  process.exit(0);
}

// --recover <id>: resolve a handoff id back to its content.
//
// WHY. An id you cannot look up is a label, not a pointer. Every crash-recovery system
// resolves a small pointer to the state it names (pg_control -> redo point -> replay the WAL);
// the pointer exists precisely so recovery never scans history. Fenix minted ids in e86d1e4
// but nothing consumed them, so "which handoff was fx-...-08d007e6?" still meant grepping a
// directory of 139 files. Now the id IS addressable: the human can quote one back, and a
// risen session can reconstitute the exact checkpoint it came from.
//
// Resolution order: the live handoff, then the id-named archive (written since e86d1e4), then
// a scan of clock-named archives from before ids existed. Bare or `fx-`-prefixed both work.
if (arg === "--recover") {
  const want = (process.argv[3] || "").trim();
  if (!want) { console.error("fenix: --recover needs a handoff id (see --status)."); process.exit(1); }
  if (!existsSync(DIR)) { console.error("fenix: no .fenix/ here."); process.exit(1); }
  const norm = (x) => x.replace(/^fx-/, "");
  const live = readHandoffId();
  if (live && live.id && norm(live.id) === norm(want) && existsSync(HANDOFF)) {
    console.log(readFileSync(HANDOFF, "utf8"));
    process.exit(0);
  }
  const direct = path.join(DIR, `handoff.consumed-${want.startsWith("fx-") ? want : "fx-" + want}.md`);
  if (existsSync(direct)) { console.log(readFileSync(direct, "utf8")); process.exit(0); }
  const hit = readdirSync(DIR)
    .filter((f) => f.startsWith("handoff.consumed-") && norm(f).includes(norm(want)));
  if (hit.length) { console.log(readFileSync(path.join(DIR, hit[0]), "utf8")); process.exit(0); }
  console.error(`fenix: no handoff matching "${want}". Try --status, or --compact --list.`);
  process.exit(1);
}

// --compact [--list] [--keep N]: bound the archive.
//
// WHY. A checkpoint truncates the log it supersedes; that is half of what makes recovery
// bounded. Fenix never truncated -- measured 139 consumed handoffs in one directory, each a
// full point-in-time state document, none of which any session will read again. They are not
// free: they are what a recovery scan walks, and they make "which handoff?" a search problem.
// Keep a recent window (the only part with any chance of being relevant), drop the rest.
if (arg === "--compact") {
  if (!existsSync(DIR)) { console.log("fenix: no .fenix/ here."); process.exit(0); }
  const rest = process.argv.slice(3);
  const listOnly = rest.includes("--list");
  const ki = rest.indexOf("--keep");
  const keep = ki >= 0 ? Math.max(0, parseInt(rest[ki + 1] || "20", 10)) : 20;
  const files = readdirSync(DIR)
    .filter((f) => f.startsWith("handoff.consumed-"))
    .map((f) => ({ f, m: statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (listOnly) {
    for (const x of files.slice(0, keep)) {
      console.log(`${new Date(x.m).toISOString().slice(0, 16).replace("T", " ")}  ${x.f.replace(/^handoff\.consumed-|\.md$/g, "")}`);
    }
    console.log(`\n${files.length} archived handoff(s); showing ${Math.min(keep, files.length)}.`);
    process.exit(0);
  }
  const drop = files.slice(keep);
  let freed = 0;
  for (const x of drop) {
    try { freed += statSync(path.join(DIR, x.f)).size; unlinkSync(path.join(DIR, x.f)); } catch {}
  }
  console.log(`fenix: compacted ${drop.length} handoff(s), kept ${Math.min(keep, files.length)}, freed ${Math.round(freed / 1024)}KB.`);
  process.exit(0);
}

if (arg === "--status") {
  if (!existsSync(DIR)) { console.log("fenix: no .fenix/ here — nothing pending."); process.exit(0); }
  const pending = existsSync(HANDOFF) ? `PENDING (${Math.round((Date.now() - statSync(HANDOFF).mtimeMs) / 60000)}m old)` : "none";
  const consumed = readdirSync(DIR).filter((f) => f.startsWith("handoff.consumed-")).length;
  const rec = existsSync(HANDOFF) ? ensureHandoffId("") : readHandoffId();
  console.log(`fenix: pending handoff: ${pending} · consumed: ${consumed}`);
  if (rec && rec.id) {
    console.log(`fenix: handoff-id: ${rec.id}`);
    console.log(`fenix:   session: ${rec.session_name} · written: ${rec.created_at}` +
                (rec.session_id ? ` · claude-session: ${rec.session_id}` : ""));
    console.log(`fenix:   recover: node fenix.mjs --recover ${rec.id}`);
  }
  process.exit(0);
}

console.error("fenix: unknown arg (use --wake | --rise | --state | --status | --recover <id> | --compact)");
process.exit(1);
