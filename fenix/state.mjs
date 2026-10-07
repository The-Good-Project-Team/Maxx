#!/usr/bin/env node
/**
 * state — the context is a cache, .fenix/state.md is the truth.
 *
 * WHY: a session's context grows every turn and 90% of a long session's budget goes to re-reading
 * it. Auto-compact only fires at the wall, and the model cannot /compact or /clear itself. The
 * fix is to make the context disposable: write the state of the work to disk AS IT HAPPENS, so
 * any session can be dropped at any moment (by a human /clear, by auto-compact, by a timer in
 * away mode) and the next one continues from state.md with no handoff ceremony. /fenix stays
 * available for a hand-authored handoff, but it is no longer required.
 *
 * HOW (four entry points, all fail-open, none ever blocks a tool or a turn):
 *   stop    Stop hook. Reads the transcript from this session's cursor to its end, keeps only the
 *           human-readable text (user prompts + assistant prose; tool calls and results are the
 *           98% noise), appends it to .fenix/state.pending.md, advances the cursor. When enough
 *           text is pending (or enough time has passed) it spawns a DETACHED distill so the hook
 *           returns at once and the next turn is never delayed.
 *   flush   PreCompact + SessionEnd hooks. Same, but the distill runs synchronously: the detail is
 *           about to be thrown away, so capture it now.
 *   wake    SessionStart hook. Prints state.md into the new session's context. Skipped on
 *           source:"resume" (the replayed transcript already has it) and inside a distill child.
 *   distill Internal worker: one `claude -p --model haiku --tools ""` call that rewrites
 *           state.md from (old state.md + pending). Guarded against recursion by
 *           MAXX_STATE_DISTILL=1 in the child's env: every entry point exits at once under it.
 *
 * Cost: a Haiku -p call measured at ~24K context (10K cache write, 14K cache read): roughly 7% of
 * one mid-session Fable turn. Debounced to MAXX_STATE_DISTILL_AT chars (default 3000) or
 * MAXX_STATE_DISTILL_MIN minutes (default 10), whichever comes first.
 *
 * Test: node --test fenix/state.test.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const DISTILL_AT = Number(process.env.MAXX_STATE_DISTILL_AT || 3000);     // pending chars before a distill
const DISTILL_MIN = Number(process.env.MAXX_STATE_DISTILL_MIN || 10);     // or minutes since the last one
const PER_MSG = 1500;            // chars kept per message in pending (keeps a pasted wall of text from dominating)
const MAX_STATE = 8000;          // chars; a state.md past this is a sign Haiku ignored the brief
const WAKE_MAX_AGE_H = 24 * 7;   // a week-old state is history, not a thread
const claudeBin = () => process.env.MAXX_STATE_CLAUDE || "claude";   // read at call time (tests swap it)
const model = () => process.env.MAXX_STATE_MODEL || "haiku";

const paths = (cwd) => {
  const dir = path.join(cwd, ".fenix");
  return {
    dir,
    state: path.join(dir, "state.md"),
    pending: path.join(dir, "state.pending.md"),
    cursor: path.join(dir, "state.cursor.json"),
    lock: path.join(dir, "state.lock"),
  };
};

const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } };
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const writeAtomic = (p, s) => { const t = p + ".tmp." + process.pid; writeFileSync(t, s); renameSync(t, p); };
const readStdin = () => { try { return process.stdin.isTTY ? {} : JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return {}; } };

// ── transcript → text ──────────────────────────────────────────────────────────────────────────
// Keep what a human would read: user prompts and assistant prose. Drop tool_use, tool_result,
// thinking, sidechains (subagents live in their own files anyway) and the harness's injected
// <system-reminder> / slash-command plumbing — none of it is the state of the WORK.
const stripInjected = (s) => s
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
  .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, "")
  .replace(/<local-command-std(out|err)>[\s\S]*?<\/local-command-std(out|err)>/g, "")
  .trim();

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
};

// Files the assistant edited are the one thing tool calls carry that prose does not (a session
// says "patched the hook", the tool_use says WHICH file). Keep those paths, mechanically.
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const touchedOf = (content) => Array.isArray(content)
  ? content.filter((b) => b && b.type === "tool_use" && EDIT_TOOLS.has(b.name) && b.input?.file_path).map((b) => b.input.file_path)
  : [];

/** JSONL text (any slice, whole lines) → "USER: …\nASSISTANT: …\nTOUCHED: …" turns, or "" */
export function extractTurns(jsonl) {
  const out = [], touched = new Set();
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain) continue;
    if (r.type !== "user" && r.type !== "assistant") continue;
    for (const p of touchedOf(r.message?.content)) touched.add(p);
    let t = stripInjected(textOf(r.message?.content));
    if (!t) continue;
    if (t.length > PER_MSG) t = t.slice(0, PER_MSG) + " …";
    out.push((r.type === "user" ? "USER: " : "ASSISTANT: ") + t);
  }
  if (touched.size) out.push("TOUCHED: " + [...touched].join(", "));
  return out.join("\n\n");
}

/** Read bytes [from, end) of a file without loading the (possibly huge) prefix. */
function readFrom(file, from) {
  const size = statSync(file).size;
  if (from >= size) return { text: "", end: size };
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    // only hand back whole lines; a half-written last line waits for the next stop
    let s = buf.toString("utf8");
    const nl = s.lastIndexOf("\n");
    if (nl === -1) return { text: "", end: from };
    return { text: s.slice(0, nl + 1), end: from + Buffer.byteLength(s.slice(0, nl + 1)) };
  } finally { closeSync(fd); }
}

// ── pending buffer ─────────────────────────────────────────────────────────────────────────────
/** Append this session's new turns to pending; returns pending size in chars. */
export function ingest(cwd, sid, transcript) {
  const P = paths(cwd);
  mkdirSync(P.dir, { recursive: true });
  const cur = readJson(P.cursor, {});
  const from = Number(cur[sid] || 0);
  const { text, end } = readFrom(transcript, from);
  const turns = extractTurns(text);
  if (turns) writeFileSync(P.pending, (readText(P.pending) ? readText(P.pending) + "\n\n" : "") + turns);
  cur[sid] = end;
  writeAtomic(P.cursor, JSON.stringify(cur));
  return readText(P.pending).length;
}

function distillDue(cwd, pendingChars) {
  if (pendingChars <= 0) return false;
  if (pendingChars >= DISTILL_AT) return true;
  const last = Number(readJson(paths(cwd).cursor, {}).lastDistill || 0);
  return Date.now() - last > DISTILL_MIN * 60_000;
}

function lockHeld(P) {
  const l = readJson(P.lock, null);
  if (!l) return false;
  if (Date.now() - (l.at || 0) > 5 * 60_000) return false;        // stale lock
  try { process.kill(l.pid, 0); return true; } catch { return false; }
}

// ── the distill ────────────────────────────────────────────────────────────────────────────────
const SYSTEM = "You are a note-taker with no tools and no filesystem. You never act, ask, or explain. " +
  "You read a conversation and output one markdown document, starting with the line '# State'.";

/** Model output → the state document: from the first '# State' line on, fences stripped. "" if absent. */
export function cleanState(s) {
  const t = s.replace(/```(?:markdown|md)?\n?|\n?```/g, "");
  const i = t.search(/^# State\s*$/m);
  return i === -1 ? "" : t.slice(i).trim();
}

export function brief(oldState, pending) {
  return `You maintain STATE.md: the running truth of a work session in a software project, written so a fresh session with NO memory can continue the work. Rewrite it from the current STATE.md and the new conversation turns below.

Rules:
- Under 50 lines. Facts only, taken from the turns. No filler, no praise, no narration.
- Keep file paths, commands, numbers and names exact.
- Keep earlier decisions unless the new turns reverse them. Drop anything superseded. Compress old "Done" items.
- Sections, omit empty ones:
# State
## Goal      one line
## Decisions bullets
## Done      bullets, oldest first
## Files     paths touched, one per line
## Next      the single next step first, then the rest
## Open      questions waiting on the human
- Output ONLY the new STATE.md markdown. No preamble, no code fence.

=== CURRENT STATE.md ===
${oldState || "(none yet)"}

=== NEW TURNS ===
${pending}`;
}

/** Run the distill once. sync=true waits (flush); else fire a detached worker (stop). */
export function distill(cwd, { sync = false } = {}) {
  const P = paths(cwd);
  if (!sync) {
    if (lockHeld(P)) return "locked";
    const child = spawn(process.execPath, [SELF, "distill", cwd], {
      detached: true, stdio: "ignore", env: { ...process.env, MAXX_STATE_DISTILL: "1" },
    });
    child.unref();
    return "spawned";
  }
  return distillNow(cwd);
}

export function distillNow(cwd) {
  const P = paths(cwd);
  const pending = readText(P.pending);
  if (!pending.trim()) return "nothing";
  writeAtomic(P.lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  try {
    const oldState = readText(P.state);
    const env = { ...process.env, MAXX_STATE_DISTILL: "1" };
    delete env.CLAUDECODE;                      // the CLI refuses to nest; this is a worker, not a nest
    // --system-prompt REPLACES the coding-agent persona (which made Haiku narrate "let me look at
    // the filesystem" before the state) and drops its ~10K of tool/skill text from the call.
    const r = spawnSync(claudeBin(), ["-p", "--model", model(), "--tools", "", "--system-prompt", SYSTEM, "--output-format", "text", brief(oldState, pending)], {
      cwd: tmpdir(),                             // neutral cwd: no project CLAUDE.md, no project hooks
      env, encoding: "utf8", timeout: 90_000, maxBuffer: 4 << 20,
    });
    const out = cleanState(r.stdout || "");
    const ok = r.status === 0 && out.length > 40 && out.length <= MAX_STATE && !/not logged in|please run \/login/i.test(out);
    if (!ok) return "failed";                    // keep pending; next distill retries with more context
    writeAtomic(P.state, out + "\n");
    // drop exactly what we consumed; a stop may have appended more meanwhile
    const now = readText(P.pending);
    writeAtomic(P.pending, now.startsWith(pending) ? now.slice(pending.length).replace(/^\n+/, "") : "");
    const cur = readJson(P.cursor, {});
    cur.lastDistill = Date.now();
    writeAtomic(P.cursor, JSON.stringify(cur));
    return "ok";
  } finally {
    try { writeAtomic(P.lock, "{}"); } catch {}
  }
}

// ── entry points ───────────────────────────────────────────────────────────────────────────────
function hookStop({ sync }) {
  const h = readStdin();
  const cwd = h.cwd || process.cwd();
  const tp = h.transcript_path;
  const sid = h.session_id || h.sessionId || "";
  if (!tp || !sid || !existsSync(tp)) return;
  const n = ingest(cwd, sid, tp);
  if (sync) { if (n > 0) distillNow(cwd); return; }
  if (distillDue(cwd, n)) distill(cwd);
}

function hookWake() {
  const h = readStdin();
  if (h.source === "resume") return;
  const cwd = h.cwd || process.cwd();
  const P = paths(cwd);
  let st; try { st = statSync(P.state); } catch { return; }
  if ((Date.now() - st.mtimeMs) / 3600_000 > WAKE_MAX_AGE_H) return;
  const body = readText(P.state).trim();
  if (!body) return;
  const age = Math.round((Date.now() - st.mtimeMs) / 60_000);
  process.stdout.write(
    `[state] .fenix/state.md is the running truth of the work in this directory (updated ${age}m ago, ` +
    `kept current by a Stop hook, so you may /clear at any time without losing the thread). ` +
    `Continue from "Next" unless the human says otherwise.\n\n${body}\n`);
}

function main() {
  if (process.env.MAXX_STATE_DISTILL && process.argv[2] !== "distill") return;   // never recurse
  const cmd = process.argv[2];
  if (cmd === "stop") return hookStop({ sync: false });
  if (cmd === "flush") return hookStop({ sync: true });
  if (cmd === "wake") return hookWake();
  if (cmd === "distill") { const r = distillNow(process.argv[3] || process.cwd()); if (process.stdout.isTTY) console.log("distill:", r); return; }
  if (cmd === "show") { process.stdout.write(readText(paths(process.cwd()).state) || "(no state.md)\n"); return; }
  console.error("state: stop | flush | wake | distill [cwd] | show");
}

if (process.argv[1] === SELF) {
  try { main(); } catch (e) { if (process.env.MAXX_STATE_DEBUG) console.error(e); }   // fail-open
  process.exitCode = 0;
}
