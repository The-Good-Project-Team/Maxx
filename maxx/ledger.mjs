#!/usr/bin/env node
/**
 * Which account spent each turn — once every login shares one transcripts folder.
 *
 * Before: each CLAUDE_CONFIG_DIR had its own projects/, so "the dir a file sits in" WAS the
 * account that burned it. After: ~/.claude, ~/.claude-phil and ~/.claude-gmail all symlink
 * projects/ to ~/.claude-shared/projects, so any chat can be resumed from any login — and every
 * scanner walking "its" projects dir now sees all three accounts' burn. Counting it all would
 * triple-count; counting by folder is meaningless.
 *
 * Transcripts are Claude Code's files, so the account tag lives beside them: a hook
 * (SessionStart + UserPromptSubmit) appends {sessionId, account, ts} to
 * ~/.maxx/session-accounts.jsonl. A turn belongs to the account of the newest ledger entry for
 * its session at or before the turn's timestamp — so a chat started on phil and resumed on gmail
 * splits at the resume, which is what actually happened to the two quotas.
 *
 *   node ledger.mjs hook                 — the hook (stdin: hook JSON). Silent, always exit 0.
 *   node ledger.mjs backfill DIR...      — tag every existing session under DIR/projects with
 *                                          DIR's account (ts 0 = "from the start"). Run BEFORE
 *                                          sharing; sessions already in the ledger are skipped.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HOME = () => process.env.HOME || homedir();
export const ledgerPath = () => process.env.MAXX_LEDGER || path.join(HOME(), ".maxx", "session-accounts.jsonl");

/** sessionId → [{ts, account}] sorted by ts. Malformed lines are skipped. */
export function loadLedger(file = ledgerPath()) {
  const map = new Map();
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return map; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e.sessionId || !e.account) continue;
    const list = map.get(e.sessionId) || [];
    list.push({ ts: Number(e.ts) || 0, account: e.account });
    map.set(e.sessionId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.ts - b.ts);
  return map;
}

/** The account that owned `sessionId` at `tsMs`, or null if the session was never tagged. */
export function accountAt(ledger, sessionId, tsMs) {
  const list = ledger.get(sessionId);
  if (!list) return null;
  let who = list[0].account; // a turn before the first tag is still that session's first account
  for (const e of list) { if (e.ts <= tsMs) who = e.account; else break; }
  return who;
}

/** The account a config dir is logged into. ~/.claude keeps its login in ~/.claude.json. */
export function accountOf(configDir) {
  const file = path.resolve(configDir) === path.join(HOME(), ".claude")
    ? path.join(HOME(), ".claude.json") : path.join(configDir, ".claude.json");
  try { return JSON.parse(readFileSync(file, "utf8")).oauthAccount?.accountUuid || null; } catch { return null; }
}

/** Is this projects dir the shared folder (a symlink), rather than a login's private one? */
export function isShared(projectsDir) {
  try { return lstatSync(projectsDir).isSymbolicLink(); } catch { return false; }
}

/**
 * keep(rec, file) → does this transcript record belong to `account`?
 * The record's own sessionId wins (a resume that copies old turns keeps their original id);
 * the file name is the fallback. An untagged session in a PRIVATE projects dir is the dir's own,
 * as it always was. In the SHARED dir an untagged session has no owner we can prove, so it is
 * left out rather than counted once per login.
 */
export function makeKeep(projectsDir, account, ledger = loadLedger()) {
  const shared = isShared(projectsDir);
  return (rec, file) => {
    const ts = Date.parse(rec?.timestamp || "") || 0;
    const fileSid = file ? sessionOfFile(file) : null;
    const who = (rec?.sessionId && accountAt(ledger, rec.sessionId, ts)) || (fileSid && accountAt(ledger, fileSid, ts));
    if (who) return !account || who === account;
    return !shared;
  };
}

/** <proj>/<sid>.jsonl → sid; <proj>/<sid>/subagents/agent-x.jsonl → sid (the parent session). */
export function sessionOfFile(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf("subagents");
  if (i > 0) return parts[i - 1];
  return path.basename(file, ".jsonl");
}

export function append(sessionId, account, ts = Date.now(), file = ledgerPath()) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ sessionId, account, ts }) + "\n");
}

/** Tag every top-level session under configDir/projects that the ledger does not know yet. */
export function backfill(configDir, file = ledgerPath()) {
  const account = accountOf(configDir);
  if (!account) throw new Error(`${configDir}: no logged-in account`);
  const known = loadLedger(file);
  const root = path.join(configDir, "projects");
  let added = 0;
  for (const proj of readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const f of readdirSync(path.join(root, proj.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const sid = f.slice(0, -6);
      if (known.has(sid)) continue;
      append(sid, account, 0, file);
      known.set(sid, [{ ts: 0, account }]);
      added++;
    }
  }
  return { account, added };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  const cmd = process.argv[2];
  if (cmd === "hook") {
    // never block or slow a prompt: any failure is swallowed
    try {
      const j = JSON.parse(readFileSync(0, "utf8") || "{}");
      const dir = process.env.CLAUDE_CONFIG_DIR || path.join(HOME(), ".claude");
      const account = accountOf(dir);
      if (j.session_id && account) append(j.session_id, account);
    } catch {}
  } else if (cmd === "backfill") {
    for (const d of process.argv.slice(3)) {
      if (!existsSync(path.join(d, "projects"))) { console.error(`  ${d}: no projects dir`); continue; }
      const r = backfill(d);
      console.log(`  ${d}: ${r.added} sessions tagged ${r.account}`);
    }
  } else {
    console.error("usage: ledger.mjs hook | backfill DIR...");
    process.exitCode = 1;
  }
}
