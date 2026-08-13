#!/usr/bin/env node
/**
 * maxx tracker — parse ~/.claude/projects/*.jsonl into a local stats card.
 *
 * Usage:
 *   node maxx/tracker.mjs            — pretty summary
 *   node maxx/tracker.mjs session    — delegate to render.mjs (how much to spend)
 *   node maxx/tracker.mjs --json     — machine-readable stats payload
 *   node maxx/tracker.mjs --dir PATH — override projects dir
 *
 * Fully on-box: reads only usage/token metadata, sends nothing anywhere, never
 * emits prompt or message content.
 */
import { createReadStream, realpathSync, readFileSync, statSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOME = homedir();
// a session launched with CLAUDE_CONFIG_DIR lives entirely in that dir — its logs,
// its login. Stats and the card signature follow THIS session's account, not ~/.claude.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const DEFAULT_DIR = path.join(CLAUDE_DIR, "projects");
// session-scoped cache suffix — same rule as render/limit/gate/emit
const SUF = process.env.CLAUDE_CONFIG_DIR ? "-" + path.basename(CLAUDE_DIR).replace(/^\.claude-?/, "") : "";
const CONFIG_DIR = path.join(HOME, ".maxx"); // local state dir (window.json / rl.json) — read-only here

// ─── args ───────────────────────────────────────────────────────────────────
// forms:
//   (none)            → card
//   session [raw]     → delegate to render.mjs (--session / --status)
//   json | --json     → JSON payload
// flags: --dir PATH
function parseArgs(argv) {
  const out = { cmd: "card", dir: DEFAULT_DIR, raw: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "session") out.cmd = "session";
    else if (a === "setup") out.cmd = "setup";
    else if (a === "switch" || a === "use") out.cmd = "switch";
    else if (a === "report" || a === "week") out.cmd = "report";
    else if (a === "turn") out.cmd = "turn";
    else if (a === "refresh") out.cmd = "refresh";
    else if (a === "config") out.cmd = "config";
    else if (a === "light" || a === "dark" || a === "auto") { out.cmd = "theme"; out.theme = a; }
    else if (a === "raw") out.raw = true;
    else if (a === "--json" || a === "json") { if (out.cmd === "session" || out.cmd === "turn") out.raw = true; else out.cmd = "json"; }
    else if (a === "--dir") out.dir = argv[++i];
    else rest.push(a);
  }
  if (out.cmd === "config") { out.key = rest[0]; out.val = rest.length > 1 ? rest.slice(1).join(" ") : undefined; }
  return out;
}

// An account's isolated login lives in its own CLAUDE_CONFIG_DIR — that is what makes
// switching an env var rather than a re-login. MAXX_DIR_<HANDLE> overrides; otherwise the
// convention nonprofit-atlas's account_pool.sh already uses on this fleet: ~/.claude-<handle>,
// with the DEFAULT ~/.claude for whichever account is the box's primary login.
function configDirFor(handle, email) {
  const env = process.env[`MAXX_DIR_${String(handle).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (env) return env;
  // Discover by WHO IS LOGGED IN, not by directory naming. Every authenticated config dir
  // records its own account in .claude.json (oauthAccount.emailAddress) and ~/.maxx/config.json
  // records each handle's email, so the two join exactly. Naming conventions do not survive
  // contact with real machines: this laptop has ~/.claude, ~/.claude-gmail and
  // ~/.claude-reif_personal, and the handle `reif` lives in none of the directories a
  // ~/.claude-<handle> rule would have guessed.
  if (email) {
    try {
      for (const d of readdirSync(homedir())) {
        if (!d.startsWith(".claude")) continue;
        const dir = path.join(homedir(), d);
        try {
          const j = JSON.parse(readFileSync(path.join(dir, ".claude.json"), "utf8"));
          if (j.oauthAccount?.emailAddress === email) return dir;
        } catch { /* not an authenticated config dir */ }
      }
    } catch { /* unreadable home */ }
  }
  const byName = path.join(homedir(), `.claude-${handle}`);
  return existsSync(byName) ? byName : null;
}

// ─── walk projects dir for .jsonl session files ───────────────────────────────
async function findSessionFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files; // dir missing → empty
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await findSessionFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

// ─── account epoch ────────────────────────────────────────────────────────────
// Every Claude ACCOUNT has its own timeline — there is no global one. Local logs
// don't carry account identity, so limit.mjs keeps a ledger (~/.maxx/accounts.json)
// of when each account was active on this machine; the card counts only records
// since the current account's epoch. No ledger yet → all-time (single-account box).
function accountEpoch() {
  try {
    const led = JSON.parse(readFileSync(path.join(CONFIG_DIR, "accounts.json"), "utf8"));
    // per-dir current (limit.mjs ledger) — this session's login, not whichever
    // login rendered last on the box
    const cur = (led.accounts || []).find((a) => a.uuid === (led.dirs?.[CLAUDE_DIR] ?? led.current));
    return cur ? cur.from : 0;
  } catch { return 0; }
}

// ─── local YYYY-MM-DD from an ISO timestamp ───────────────────────────────────
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── accumulate one session file into the running stats ───────────────────────
async function ingestFile(file, acc) {
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip malformed line, keep going
    }
    const usage = rec?.message?.usage;
    if (!usage) continue;

    const inp = usage.input_tokens || 0;
    const cc = usage.cache_creation_input_tokens || 0;
    const cr = usage.cache_read_input_tokens || 0;
    const out = usage.output_tokens || 0;
    const total = inp + cc + cr + out;
    if (total === 0) continue;

    // de-dupe: streaming can emit the same requestId multiple times
    const id = rec.requestId || rec.uuid;
    if (id) {
      if (acc.seen.has(id)) continue;
      acc.seen.add(id);
    }

    const day = localDay(rec.timestamp);
    if (!day) continue;
    if (acc.since && new Date(rec.timestamp).getTime() < acc.since) continue; // other account's burn

    acc.totals.input += inp;
    acc.totals.cacheCreate += cc;
    acc.totals.cacheRead += cr;
    acc.totals.output += out;
    acc.messages += 1;

    const d = acc.byDay.get(day) || { total: 0, output: 0, cacheRead: 0, cacheableInput: 0 };
    d.total += total;
    d.output += out;
    d.cacheRead += cr;
    d.cacheableInput += inp + cc + cr; // all input-side tokens
    acc.byDay.set(day, d);

    const model = rec?.message?.model || "unknown";
    acc.byModel.set(model, (acc.byModel.get(model) || 0) + total);

    if (rec.sessionId) acc.sessions.add(rec.sessionId);
  }
}

// ─── streak math over the set of active days ──────────────────────────────────
function computeStreaks(days) {
  if (days.length === 0) return { current: 0, longest: 0 };
  const set = new Set(days);
  const sorted = [...set].sort(); // ascending YYYY-MM-DD (lexical == chronological)

  const dayNum = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  };

  // longest run of consecutive calendar days
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (dayNum(sorted[i]) - dayNum(sorted[i - 1]) === 1) run += 1;
    else run = 1;
    if (run > longest) longest = run;
  }

  // current streak = consecutive days ending today or yesterday
  const today = localDay(new Date().toISOString());
  const todayNum = dayNum(today);
  const last = sorted[sorted.length - 1];
  const gap = todayNum - dayNum(last);
  let current = 0;
  if (gap <= 1) {
    current = 1;
    for (let i = sorted.length - 1; i > 0; i--) {
      if (dayNum(sorted[i]) - dayNum(sorted[i - 1]) === 1) current += 1;
      else break;
    }
  }
  return { current, longest };
}

// ─── live 5h session window ───────────────────────────────────────────────────
// The bar's watchdog (limit.mjs) caches the rolling 5h token window in window.json,
// and render.mjs drops the live rate-limit %s + reset time in rl.json. Reading both
// here lets /maxx (and any agent reading --json) see where the CURRENT session sits:
// tokens burned, tokens left, and minutes until the wall resets. Limit-weighted
// tokens (cache-reads count ~0.1x) so used/cap matches Claude's real quota %.
function sessionWindow() {
  let win, rl;
  try { win = JSON.parse(readFileSync(path.join(CONFIG_DIR, "window.json"), "utf8")); } catch { return null; }
  try { rl = JSON.parse(readFileSync(path.join(CONFIG_DIR, "rl.json"), "utf8")); } catch { rl = {}; }
  if (!win || !Array.isArray(win.buckets) || !win.cap5) return null;
  const now = Date.now();
  let used = 0, burn5 = 0;
  for (const b of win.buckets) {
    if (b[0] > now - 5 * 3600 * 1000) used += b[1];
    if (b[0] > now - 5 * 60 * 1000) burn5 += b[1];
  }
  used = Math.round(used);
  const cap = win.cap5;
  const left = Math.max(0, cap - used);
  const pct = cap > 0 ? used / cap : 0;
  // use-it-or-lose-it pace: to fully use a rolling 5h budget you must sustain cap/300 per minute.
  // burning less than that leaves tokens to expire — "behind pace" = under-using, not over-using.
  const needPerMin = Math.round(cap / 300);
  const nowPerMin = Math.round(burn5 / 5);
  const behind = nowPerMin < needPerMin;
  // minutes until the wall clears. Prefer Anthropic's authoritative fixed-window reset
  // (rl.json); fall back to when the oldest in-window token ages out of the rolling 5h.
  let resetInMins = null;
  if (rl.fiveResetAt) resetInMins = Math.max(0, Math.round((rl.fiveResetAt * 1000 - now) / 60000));
  else {
    const inWin = win.buckets.filter((b) => b[0] > now - 5 * 3600 * 1000);
    if (inWin.length) resetInMins = Math.max(0, Math.round((inWin[0][0] + 5 * 3600 * 1000 - now) / 60000));
  }
  return { used, cap, left, pct, resetInMins, burn5: Math.round(burn5), needPerMin, nowPerMin, behind };
}

// ─── last turn — the per-turn receipt (`maxx turn`) ───────────────────────────
// "What did that just cost?" — sums every usage block since the last real user
// prompt in the CURRENT session (newest root .jsonl for this cwd's project, falling
// back to the newest anywhere), plus any subagent burn timestamped inside the turn.
async function newestRoot(dir) {
  let best = null;
  async function walk(d) {
    let es; try { es = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl") && !full.includes(`${path.sep}subagents${path.sep}`)) {
        let mt; try { mt = statSync(full).mtimeMs; } catch { continue; }
        if (!best || mt > best.mtime) best = { file: full, mtime: mt };
      }
    }
  }
  await walk(dir);
  return best && best.file;
}

async function lastTurn(allDir) {
  // prefer the project dir Claude Code uses for this cwd (path with / → -)
  const projDir = path.join(allDir, process.cwd().replace(/[\\/.]/g, "-"));
  const root = (await newestRoot(projDir)) || (await newestRoot(allDir));
  if (!root) return null;
  // one streaming pass: remember each usage block's seq, and the seq of the last
  // REAL user prompt (external, not a tool_result wrapper) — the turn boundary.
  const rl = createInterface({ input: createReadStream(root, { encoding: "utf8" }), crlfDelay: Infinity });
  const usages = []; // { seq, u, ts }
  const prompts = []; // { seq, ts } — every real user prompt (turn boundary)
  let seq = 0;
  const seen = new Set();
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    seq++;
    if (r.type === "user" && !r.isSidechain && r.userType === "external") {
      const c = r.message && r.message.content;
      const toolResult = Array.isArray(c) && c.some((b) => b && b.type === "tool_result");
      if (!toolResult) { prompts.push({ seq, ts: r.timestamp }); continue; }
    }
    const u = r.message && r.message.usage;
    if (!u) continue;
    const id = r.requestId || r.uuid;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    usages.push({ seq, u, ts: r.timestamp });
  }
  if (!prompts.length) return null;
  // "last turn" = the last COMPLETED turn: walk prompt boundaries backwards and take the first
  // slice with usage in it. Asking `/maxx turn` right after a big turn must report THAT turn, not
  // the still-empty slice after the /maxx prompt itself.
  let inTurn = [], lastUserTs = null, turnEndTs = null;
  for (let k = prompts.length - 1; k >= 0; k--) {
    const lo = prompts[k].seq, hi = k + 1 < prompts.length ? prompts[k + 1].seq : Infinity;
    const slice = usages.filter((x) => x.seq > lo && x.seq < hi);
    if (slice.length) { inTurn = slice; lastUserTs = prompts[k].ts; turnEndTs = hi === Infinity ? null : prompts[k + 1].ts; break; }
  }
  if (!inTurn.length) return null;
  const sum = { total: 0, output: 0, cacheRead: 0, input: 0, cacheCreate: 0, calls: 0 };
  const add = (u) => {
    const t = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    if (!t) return;
    sum.total += t; sum.output += u.output_tokens || 0; sum.cacheRead += u.cache_read_input_tokens || 0;
    sum.input += u.input_tokens || 0; sum.cacheCreate += u.cache_creation_input_tokens || 0; sum.calls++;
  };
  for (const x of inTurn) add(x.u);
  // subagent burn inside the turn window: <projectDir>/<sessionId>/subagents/*.jsonl
  let agentTokens = 0, agentCalls = 0;
  const turnStart = lastUserTs ? new Date(lastUserTs).getTime() : 0;
  const turnEnd = turnEndTs ? new Date(turnEndTs).getTime() : Infinity;
  const subDir = path.join(path.dirname(root), path.basename(root, ".jsonl"), "subagents");
  try {
    for (const f of await findSessionFiles(subDir)) {
      if (statSync(f).mtimeMs < turnStart) continue; // untouched since the turn began
      const srl = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of srl) {
        if (!line || line[0] !== "{") continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        const u = r.message && r.message.usage;
        if (!u || !r.timestamp) continue;
        const t_ = new Date(r.timestamp).getTime();
        if (t_ < turnStart || t_ > turnEnd) continue;
        const id = r.requestId || r.uuid;
        if (id) { if (seen.has(id)) continue; seen.add(id); }
        const t = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        if (t) { agentTokens += t; agentCalls++; }
      }
    }
  } catch {}
  return { file: root, since: lastUserTs, ...sum, agentTokens, agentCalls, grand: sum.total + agentTokens };
}

// ─── build the public stats payload ───────────────────────────────────────────
function buildStats(acc) {
  const t = acc.totals;
  const grand = t.input + t.cacheCreate + t.cacheRead + t.output;
  const cacheableInput = t.input + t.cacheCreate + t.cacheRead;
  const cacheHit = cacheableInput > 0 ? t.cacheRead / cacheableInput : 0;

  const days = [...acc.byDay.keys()].sort();
  const activeDays = days.length;
  const perDay = days.map((day) => ({ day, ...acc.byDay.get(day) }));
  const tokensPerActiveDay = activeDays > 0 ? Math.round(grand / activeDays) : 0;

  const streaks = computeStreaks(days);

  const models = [...acc.byModel.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    generatedAt: new Date().toISOString(),
    schema: "maxx.stats.v1",
    accountSince: acc.since ? new Date(acc.since).toISOString() : null, // per-account timeline start (null = no ledger yet)
    totals: {
      tokens: grand,
      input: t.input,
      cacheCreation: t.cacheCreate,
      cacheRead: t.cacheRead,
      output: t.output,
    },
    cacheHitRate: Number(cacheHit.toFixed(4)),
    messages: acc.messages,
    sessions: acc.sessions.size,
    activeDays,
    tokensPerActiveDay,
    firstDay: days[0] || null,
    lastDay: days[activeDays - 1] || null,
    streak: streaks.current,
    longestStreak: streaks.longest,
    // RAW 5h log-scan window — NOT the pacing budget. For "how much to spend this session" use
    // `maxx session` / render.mjs --session (weekly-paced). Renamed from `.session` so consumers
    // stop mistaking this raw window for the sustainable share.
    session5hRaw: sessionWindow(),
    models,
    perDay,
  };
}

// minutes → "2h 14m" / "47m"
function fmtMins(m) {
  if (m == null) return "—";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ─── pretty print ─────────────────────────────────────────────────────────────
function fmt(n) {
  return n.toLocaleString("en-US");
}
function human(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function pretty(s) {
  const L = [];
  L.push("");
  L.push("  ⚡ maxx");
  L.push("  ─────────────────────────────────────────");
  L.push(`  total tokens      ${human(s.totals.tokens)}  (${fmt(s.totals.tokens)})`);
  L.push(`  tokens / day      ${human(s.tokensPerActiveDay)}`);
  L.push(`  cache-hit         ${(s.cacheHitRate * 100).toFixed(1)}%`);
  L.push(`  streak            ${s.streak}d   (longest ${s.longestStreak}d)`);
  L.push(`  active days       ${s.activeDays}   (${s.firstDay} → ${s.lastDay})`);
  L.push(`  sessions          ${fmt(s.sessions)}`);
  L.push(`  messages          ${fmt(s.messages)}`);
  if (s.session5hRaw) {
    const sw = s.session5hRaw;
    L.push("  ─────────────────────────────────────────");
    L.push("  5h window (raw — for pacing use `maxx session`)");
    L.push(`    used            ${human(sw.used)}  (${(sw.pct * 100).toFixed(0)}%)`);
    L.push(`    left            ${human(sw.left)}  of ${human(sw.cap)}`);
    L.push(`    resets in       ${fmtMins(sw.resetInMins)}`);
  }
  L.push("  ─────────────────────────────────────────");
  L.push("  breakdown");
  L.push(`    input           ${human(s.totals.input)}`);
  L.push(`    cache write      ${human(s.totals.cacheCreation)}`);
  L.push(`    cache read      ${human(s.totals.cacheRead)}`);
  L.push(`    output          ${human(s.totals.output)}`);
  if (s.models.length) {
    L.push("  ─────────────────────────────────────────");
    L.push("  models");
    for (const m of s.models.slice(0, 6)) {
      L.push(`    ${m.model.padEnd(28)} ${human(m.tokens)}`);
    }
  }
  L.push("");
  // sign the card — a small thank-you keyed to the handle of the account THIS
  // session is signed into (cfg.accounts map), falling back to the pinned handle
  try {
    const cfg = JSON.parse(readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));
    let h = cfg.handle;
    try {
      const oa = JSON.parse(readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || HOME, ".claude.json"), "utf8")).oauthAccount;
      h = cfg.accounts?.[oa?.accountUuid]?.handle || h;
    } catch {}
    if (h && h !== "unknown") { L.push(`  thanks for using /maxx, @${h}! · meetmaxx.co/u/${h}`); L.push(""); }
  } catch {}
  return L.join("\n");
}

// ─── main ─────────────────────────────────────────────────────────────────────
export async function collectStats(dir = DEFAULT_DIR) {
  const acc = {
    totals: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 },
    byDay: new Map(),
    byModel: new Map(),
    sessions: new Set(),
    seen: new Set(),
    messages: 0,
    since: accountEpoch(),
  };
  const files = await findSessionFiles(dir);
  for (const f of files) {
    try {
      await ingestFile(f, acc);
    } catch {
      // unreadable file → skip
    }
  }
  return buildStats(acc);
}

// Resolve both sides through symlinks so `isMain` holds when the script is run
// via a symlink (e.g. installed into ~/.claude/skills/maxx → repo).
function isMainModule() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const a = parseArgs(process.argv.slice(2));
  const w = (s) => process.stdout.write(s + "\n");
  try {
    if (a.cmd === "session") {
      // PACING is NOT computed here. The sustainable per-session budget is weekly ÷ sessions-left,
      // and only render.mjs has the weekly rate-limit data (from the statusline's stdin, via
      // status.json). tracker's own 5h log-scan is a RAW window, not the pacing budget — a consumer
      // misread it as "plenty of headroom, run flat-out", the opposite of the truth. So delegate:
      //   `maxx session`        → the weekly-paced brief (render.mjs --session)
      //   `maxx session raw`    → the full status.json (render.mjs --status)
      const renderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "render.mjs");
      try {
        const outStr = execFileSync(process.execPath, [renderPath, a.raw ? "--status" : "--session"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        w(outStr.replace(/\n+$/, ""));
      } catch {
        w(a.raw ? "{}" : "  session: no pacing data yet — open Claude Code so the statusline seeds ~/.maxx/status.json.");
      }
    } else if (a.cmd === "setup") {
      const { main: setupMain } = await import("./setup.mjs");
      process.exitCode = await setupMain();
    } else if (a.cmd === "switch") {
      // Prints the export line and nothing else when piped, so `eval "$(maxx switch)"` works;
      // adds the ranking on a terminal, where a human is the one reading it.
      const { readAccounts, probeAccount } = await import("./setup.mjs");
      const { pickAccount, rankAccounts, switchCommand } = await import("./switch.mjs");
      const { base, accounts } = readAccounts();
      const probed = await Promise.all(accounts.map(async (acct) => {
        const r = await probeAccount(base, acct);
        return { handle: r.handle, configDir: configDirFor(r.handle, acct.email),
                 usage: r.error ? undefined : { weekPct: r.weekPct, fivePct: r.fivePct } };
      }));
      const pick = pickAccount(probed);
      if (!pick) { console.error("  no account has a live usage reading — run `maxx setup`"); process.exitCode = 1; }
      else {
        if (process.stdout.isTTY) {
          for (const r of rankAccounts(probed)) {
            w(`  ${r.handle.padEnd(12)} ${r.binding == null ? "unknown" : Math.round(r.binding * 100) + "% used"}${r.handle === pick.handle ? "   ← pick" : ""}`);
          }
          if (pick.walled) w("  every account is at its wall — this is the emptiest of them");
        }
        const cmd = switchCommand(pick);
        if (cmd) w(cmd);
        else { console.error(`  @${pick.handle} has no known CLAUDE_CONFIG_DIR — set MAXX_DIR_${pick.handle.toUpperCase()}`); process.exitCode = 1; }
      }
    } else if (a.cmd === "report") {
      const { readAccounts, probeAccount } = await import("./setup.mjs");
      const { weeklyReport, renderReport } = await import("./report.mjs");
      const { base, accounts } = readAccounts();
      const probed = await Promise.all(accounts.map((acct) => probeAccount(base, acct)));
      w(renderReport(weeklyReport(probed)));
    } else if (a.cmd === "turn") {
      const t = await lastTurn(a.dir);
      if (!t) w("  turn: no session log found for this directory.");
      else if (a.raw) w(JSON.stringify(t, null, 2));
      else {
        const agents = t.agentTokens ? `  ·  +${human(t.agentTokens)} subagents (${t.agentCalls} calls)` : "";
        w(`  ⚡ last turn  ${fmt(t.grand)} tokens  ·  ${t.calls} api calls${agents}`);
        w(`     output ${human(t.output)} · cache-read ${human(t.cacheRead)} · input ${human(t.input)} · cache-write ${human(t.cacheCreate)}`);
      }
    } else if (a.cmd === "refresh") {
      // stuck bar / stale numbers → drop the derived caches and rebuild. Everything
      // here is recomputable from the logs; ledgers, config, secrets and the emit
      // cursor are NOT touched (clearing the cursor would re-ship history).
      const derived = ["scan", "window", "caps", "status", "marks", "rl"].map((n) => `${n}${SUF}.json`).concat(".live-cache.json");
      const gone = derived.filter((f) => { try { unlinkSync(path.join(CONFIG_DIR, f)); return true; } catch { return false; } });
      const limitPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "limit.mjs");
      try { execFileSync(process.execPath, [limitPath], { stdio: "ignore", timeout: 180000 }); } catch {}
      w(`  refreshed — cleared ${gone.length ? gone.join(", ") : "nothing (already clean)"}; window rebuilt.`);
      w("  the bar repaints on the next statusline tick.");
    } else if (a.cmd === "theme") {
      const cfgPath = path.join(CONFIG_DIR, "config.json");
      const cfg = (() => { try { return JSON.parse(readFileSync(cfgPath, "utf8")); } catch { return {}; } })();
      if (a.theme === "auto") delete cfg.theme; else cfg.theme = a.theme;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      w(`  theme → ${a.theme === "auto" ? "auto — each bar adopts its own terminal's colors (ghostty theme; CLI light/dark elsewhere)" : a.theme}. The bar repaints on the next statusline tick.`);
    } else if (a.cmd === "config") {
      const cfgPath = path.join(CONFIG_DIR, "config.json");
      const cfg = (() => { try { return JSON.parse(readFileSync(cfgPath, "utf8")); } catch { return {}; } })();
      if (a.key === undefined) {
        // show settings — secrets never leave the file
        const shown = JSON.parse(JSON.stringify(cfg));
        const mask = (s) => (typeof s === "string" && s.length > 6 ? s.slice(0, 4) + "…" : "•••");
        if (shown.secret) shown.secret = mask(shown.secret);
        if (shown.connectorUrl) shown.connectorUrl = shown.connectorUrl.replace(/([?&]k=)[^&]+/, "$1…");
        for (const acct of Object.values(shown.accounts || {})) if (acct.secret) acct.secret = mask(acct.secret);
        w(JSON.stringify(shown, null, 2));
        w(`\n  set:   /maxx config <key> <value>   (dotted keys ok, e.g. ticker.speed 2)`);
        w(`  file:  ${cfgPath}`);
      } else if (/secret|accounts/i.test(a.key)) {
        w(`  "${a.key}" holds credentials/handle routing — edit ${cfgPath} directly, deliberately.`);
      } else if (a.val === undefined) {
        const v = a.key.split(".").reduce((o, k) => (o == null ? o : o[k]), cfg);
        w(`  ${a.key} = ${JSON.stringify(v)}`);
      } else {
        let v; try { v = JSON.parse(a.val); } catch { v = a.val; }
        const ks = a.key.split(".");
        let o = cfg;
        for (const k of ks.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === "object" ? o[k] : {};
        o[ks.at(-1)] = v;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        w(`  ${a.key} → ${JSON.stringify(v)}`);
      }
    } else if (a.cmd === "json") {
      w(JSON.stringify(await collectStats(a.dir), null, 2));
    } else {
      w(pretty(await collectStats(a.dir)));
    }
  } catch (err) {
    process.stderr.write(`maxx: ${err.message}\n`);
    process.exit(1);
  }
}
