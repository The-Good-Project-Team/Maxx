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
 *   node fenix.mjs --status [--local]   Every pending handoff on the box (--local: cwd only).
 *   node fenix.mjs --recover <id>       Print the handoff with that id, from ANY directory.
 *   node fenix.mjs --compact [--list] [--keep N]   Bound the archive (default keep 20).
 *
 * A HANDOFF IS WRITTEN IN ONE DIRECTORY AND LOOKED FOR FROM ANOTHER (Reif, 2026-08-27:
 * "make fenix global"). The handoff lives per-repo and that is correct — a session wakes
 * into its OWN thread, so --wake stays cwd-scoped. But every LOOKUP was cwd-scoped too,
 * and that silently lied: `--status` run from Maxx reported "pending: none · consumed: 4"
 * while fx-fleet-kit-20260827-0045-472fd7a4 sat alive and pending in fleet-kit/.fenix/.
 * `--recover` on that id answered "no handoff matching" from the wrong directory — for an
 * id that literally NAMES its repo. A pointer you can only resolve while already standing
 * on the thing it points at is not a pointer.
 *
 * So: every directory that writes a handoff registers itself in ~/.claude/maxx/fenix-index.json,
 * and the read paths (--status, --recover) resolve across the whole index. The index is a
 * CACHE, not the truth — the .fenix/ dirs are — so a miss falls back to a bounded scan and
 * a stale entry is pruned on sight.
 */
import { readFileSync, writeFileSync, writeSync, renameSync, statSync, readdirSync, existsSync, openSync, unlinkSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const DIR = path.join(process.cwd(), ".fenix");

// THE FLEET INDEX — how a per-directory handoff becomes globally addressable.
//
// Registered on every write (--state) and every wake, because those are the two moments a
// directory PROVES it is a live fenix site. Never registered by a read: looking for a handoff
// must not create the impression you have one.
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const INDEX = path.join(HOME, ".claude", "maxx", "fenix-index.json");

function readIndex() {
  try {
    const j = JSON.parse(readFileSync(INDEX, "utf8"));
    return Array.isArray(j?.dirs) ? j.dirs : [];
  } catch { return []; }
}
// Best-effort and silent, like autoPrune: bookkeeping must never break a wake.
// A fenix site is somewhere work LIVES. A temp directory is not — it is gone by morning, and
// an index full of /T/fenix-test-* entries makes `--status` unreadable, which is the exact
// failure this whole change exists to fix (observed: 24 "pending handoffs", 16 of them tests).
function ephemeral(d) {
  if (process.env.MAXX_FENIX_ALLOW_TMP === "1") return false; // tests build fixtures in tmpdirs
  const t = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const real = d.startsWith("/private") ? d : "/private" + d;
  return d.startsWith(t) || real.startsWith("/private" + t.replace(/^\/private/, "")) ||
         d.startsWith("/tmp/") || d.startsWith("/private/tmp/") || d.startsWith("/var/folders/") ||
         d.startsWith("/private/var/folders/");
}
function registerDir(dir) {
  try {
    const d = dir || process.cwd();
    if (ephemeral(d)) return; // never index a temp dir
    if (!existsSync(path.join(d, ".fenix"))) return;
    const dirs = readIndex();
    if (dirs.includes(d)) return;
    dirs.push(d);
    mkdirSync(path.dirname(INDEX), { recursive: true });
    writeFileSync(INDEX, JSON.stringify({ dirs: dirs.sort() }, null, 2));
  } catch {}
}
// Every fenix site the box knows about. Index first (cheap, exact), then a bounded scan of the
// usual roots so a directory that predates the index — or was written by another machine's
// checkout — is still found. Prunes index entries whose .fenix/ is gone.
function allFenixDirs() {
  const seen = new Set();
  const out = [];
  const add = (d) => {
    if (!d || seen.has(d)) return;
    seen.add(d);
    if (!ephemeral(d) && existsSync(path.join(d, ".fenix"))) out.push(d);
  };
  const indexed = readIndex();
  for (const d of indexed) add(d);
  // The scan is what makes the index a cache rather than a second source of truth.
  const roots = (process.env.MAXX_FENIX_ROOTS || `${HOME}/Classified:${HOME}/Life:${HOME}:${HOME}/automations`)
    .split(":").filter(Boolean);
  for (const root of roots) {
    add(root);
    let kids = [];
    try { kids = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const k of kids) if (k.isDirectory() && !k.name.startsWith(".")) add(path.join(root, k.name));
  }
  add(process.cwd());
  // Drop index entries that no longer exist; a recovery scan must not walk ghosts.
  const live = out.slice();
  if (indexed.some((d) => !live.includes(d))) {
    try {
      mkdirSync(path.dirname(INDEX), { recursive: true });
      writeFileSync(INDEX, JSON.stringify({ dirs: live.sort() }, null, 2));
    } catch {}
  }
  return out;
}
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
// AUTO-PRUNE (Reif, 2026-08-26: "obviously, it should happen automatically").
//
// --compact existed but only ran when a human remembered to run it, which is the same
// failure as having no truncation at all: measured 139 archived handoffs / 1.3MB before
// anyone noticed. A checkpointing system truncates its log AS PART OF checkpointing --
// it does not file a ticket asking to be tidied later. So every archive event prunes the
// tail it just extended. Bounded by construction, no cron, no human.
//
// Best-effort and silent: pruning is housekeeping and must never break a wake.
function autoPrune(keep) {
  const K = Number.isFinite(keep) ? keep : parseInt(process.env.MAXX_FENIX_KEEP || "20", 10);
  if (!(K >= 0)) return 0;
  try {
    const files = readdirSync(DIR)
      .filter((f) => f.startsWith("handoff.consumed-"))
      .map((f) => ({ f, m: statSync(path.join(DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(K);
    let n = 0;
    for (const x of files) { try { unlinkSync(path.join(DIR, x.f)); n++; } catch {} }
    return n;
  } catch { return 0; }
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
    registerDir(); // this directory is a live fenix site — make it globally findable
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
      autoPrune(); // truncate as part of checkpointing, not on a human's memory
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
  registerDir(); // --state precedes writing a handoff here; index it now
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
  const norm = (x) => x.replace(/^fx-/, "");
  const w = norm(want);
  // GLOBAL BY CONSTRUCTION. The id encodes its own repo (fx-<name>-<stamp>-<hash>), so refusing
  // to look outside the cwd was refusing to read the pointer it was handed. Search every fenix
  // site: live handoff first (a pending thread beats an archived one), then archives.
  const dirs = allFenixDirs();
  const tryLive = [];
  const tryArc = [];
  for (const d of dirs) {
    const fdir = path.join(d, ".fenix");
    const h = path.join(fdir, "handoff.md");
    let id = null;
    try { id = JSON.parse(readFileSync(path.join(fdir, "handoff.id"), "utf8")); } catch {}
    // Substring, not equality: a human recovers by pasting part of an id off a --status line,
    // and archives already matched that way. Exact-only on the LIVE handoff meant the same id
    // resolved when archived and failed while pending — the case you actually hit.
    if (id?.id && norm(id.id).includes(w) && existsSync(h)) {
      let mt = 0; try { mt = statSync(h).mtimeMs; } catch {}
      if (id.handoff_mtime === mt) tryLive.push({ file: h, dir: d, live: true });
    }
    let files = [];
    try { files = readdirSync(fdir).filter((f) => f.startsWith("handoff.consumed-")); } catch { continue; }
    for (const f of files) if (norm(f).includes(w)) tryArc.push({ file: path.join(fdir, f), dir: d, live: false });
  }
  const hits = [...tryLive, ...tryArc];
  if (hits.length) {
    const hit = hits[0];
    // Say WHERE it came from on stderr, so piping the body to a file stays clean.
    console.error(`fenix: ${hit.live ? "pending" : "archived"} handoff · ${hit.dir}`);
    if (hits.length > 1) console.error(`fenix: ${hits.length - 1} other match${hits.length > 2 ? "es" : ""} (id prefix is ambiguous — pass more of it)`);
    console.log(readFileSync(hit.file, "utf8"));
    process.exit(0);
  }
  console.error(`fenix: no handoff matching "${want}" in ${dirs.length} fenix director${dirs.length === 1 ? "y" : "ies"}. Try --status, or --compact --list.`);
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

// --status [--local]: what is pending, ACROSS THE BOX by default.
//
// WHY GLOBAL IS THE DEFAULT. The cwd-scoped version did not just omit information, it asserted
// a falsehood: "pending handoff: none" is a claim about the world, and it was wrong every time
// the thread you were looking for lived one directory over. The failure is silent and total —
// you conclude the handoff was LOST and go hunting a transcript for a thread that is sitting
// intact on disk. Measured 2026-08-27: 12 pending handoffs across the box, `--status` from
// Maxx reported none of the other 11.
//
// So --status answers "where are my threads", the question a human standing anywhere actually
// has. --local keeps the old one-directory view for a hook or a script that wants it.
if (arg === "--status") {
  const localOnly = process.argv.includes("--local");
  const dirs = localOnly ? [process.cwd()] : allFenixDirs();
  let rows = [];
  for (const d of dirs) {
    const fdir = path.join(d, ".fenix");
    const h = path.join(fdir, "handoff.md");
    if (!existsSync(h)) continue;
    let mt = 0;
    try { mt = statSync(h).mtimeMs; } catch { continue; }
    let id = null;
    try { id = JSON.parse(readFileSync(path.join(fdir, "handoff.id"), "utf8")); } catch {}
    // An id minted against an older handoff names the WRONG one — worse than no id.
    if (id && id.handoff_mtime !== mt) id = null;
    rows.push({ dir: d, ageMin: Math.round((Date.now() - mt) / 60000), id, stale: (Date.now() - mt) / 3600000 > MAX_AGE_H });
  }
  rows.sort((a, b) => a.ageMin - b.ageMin);
  // A STALE handoff (past MAX_AGE_H) will never auto-inject and is almost always an abandoned
  // directory, not a thread. Listing them by default buried the two live handoffs under 14 dead
  // ones — a fleet view that does not answer "what am I in the middle of" is not worth reading.
  const stale = rows.filter((r) => r.stale);
  const showAll = process.argv.includes("--all");
  if (!showAll) rows = rows.filter((r) => !r.stale);
  // The id is minted lazily, and a global listing must not mint ids for 16 directories. So the
  // LOCAL view — the "what is my handoff called" question — is what ensures one exists.
  if (localOnly && existsSync(HANDOFF)) {
    const r = ensureHandoffId("");
    if (r?.id && rows[0]) rows[0].id = r;
  }
  if (!rows.length) {
    console.log((localOnly ? "fenix: no pending handoff here." : "fenix: no pending handoffs on this box.") +
                (stale.length && !showAll ? ` (${stale.length} stale — --all to list)` : ""));
    process.exit(0);
  }
  console.log(`fenix: ${rows.length} pending handoff${rows.length > 1 ? "s" : ""}${localOnly ? " (this directory)" : " (whole box — --local for just here)"}:`);
  for (const r of rows) {
    const age = r.ageMin < 90 ? `${r.ageMin}m` : `${Math.round(r.ageMin / 60)}h`;
    // A handoff past MAX_AGE_H will never auto-inject — say so, or it reads as live.
    const mark = r.stale ? " · STALE (past 48h, --wake will skip it)" : r.dir === process.cwd() ? " · here" : "";
    console.log(`  ${age.padStart(4)} ago  ${r.id?.id || "(no id)"}${mark}`);
    console.log(`            ${r.dir}`);
  }
  if (stale.length && !showAll) console.log(`fenix: + ${stale.length} stale (past 48h, will not auto-inject) — --all to list`);
  console.log(`fenix: recover any of them from anywhere: node fenix.mjs --recover <id>`);
  process.exit(0);
}

console.error("fenix: unknown arg (use --wake | --state | --status | --recover <id> | --compact)");
process.exit(1);
