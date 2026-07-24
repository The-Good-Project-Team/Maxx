#!/usr/bin/env node
/**
 * maxx emit — the log-shipper half of centralized, omni-surface budget.
 *
 * The problem it solves: subscription budget (5h/weekly %) is only observable
 * from an interactive Claude Code client (the laptop statusline). Cloud routines
 * can't read /usage at all. But EVERY surface can count its own tokens. So instead
 * of asking each surface "what % of the wall am I at?" (unreachable), we ship the
 * raw per-turn usage metadata to a central tally, and anchor the tally to the
 * authoritative % whenever an interactive session observes it (rate_limits → rl.json).
 *
 * This is the on-box emitter. It reads only token/usage metadata — never prompt or
 * message content — from ~/.claude/projects, tallies everything NEW since the last
 * emit (cursor), attaches the current rate-limit anchor if one is fresh, and POSTs
 * one envelope to the central logs endpoint. Run it on an interval (like a log
 * shipper). The cloud side ships the same envelope via the account-wide maxx MCP
 * connector; both feed one tally store keyed by the user's handle.
 *
 * Config (~/.maxx/config.json): handle (userid), secret (bearer), installId (surface),
 * logsUrl (base, default https://meetmaxx.co). Cursor in ~/.maxx/emit-cursor.json.
 *
 * Usage:
 *   node maxx/emit.mjs               — DRY RUN: print the envelope, don't send, don't advance cursor
 *   node maxx/emit.mjs --send        — POST the envelope and advance the cursor on success
 *   node maxx/emit.mjs --since ISO   — override the cursor (re-emit from a timestamp)
 *   node maxx/emit.mjs --json        — print the raw envelope JSON only
 *   node maxx/emit.mjs --dir PATH    — override projects dir
 *   node maxx/emit.mjs --signup H    — claim handle H on the tally server, write ~/.maxx/config.json
 *   node maxx/emit.mjs --dash        — open the owner dashboard (magic link, no secret in URL)
 *   node maxx/emit.mjs --install-agent — keep --watch running at login (launchd on macOS)
 *
 * Wire contract: see maxx/LOGS.md.
 */
import { createReadStream, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSetupToken } from "./token.mjs";

const HOME = homedir();
const DEFAULT_DIR = path.join(HOME, ".claude", "projects");
const CONFIG = path.join(HOME, ".maxx", "config.json");
const CURSOR = path.join(HOME, ".maxx", "emit-cursor.json");
const ANCHOR_MAX_AGE_SEC = 30 * 60; // an anchor older than this is not trustworthy

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, send: false, json: false, since: null, watch: false, signup: null, installAgent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send" || a === "send") out.send = true;
    else if (a === "--json" || a === "json") out.json = true;
    else if (a === "--watch" || a === "watch") { out.watch = true; out.send = true; }
    else if (a === "--since") out.since = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--signup" || a === "signup") { const n = argv[i + 1]; out.signup = n && !n.startsWith("-") ? argv[++i] : true; }
    else if (a === "--install-agent") out.installAgent = true;
    else if (a === "--set-token") out.setToken = true;
    else if (a === "--only") out.only = argv[++i];
    else if (a === "--watchdog") out.watchdog = true;
    else if (a === "--dash" || a === "dash") out.dash = true;
  }
  return out;
}

async function recentFiles(dir, cutoffMs) {
  const files = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return files; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await recentFiles(full, cutoffMs)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      try { if ((await stat(full)).mtimeMs >= cutoffMs) files.push(full); } catch {}
    }
  }
  return files;
}

// Map a file to its owning ROOT session (same nesting rule as agents.mjs).
function classify(dir, file) {
  const rel = path.relative(dir, file).split(path.sep);
  const project = rel[0] || "?";
  if (rel.length === 2) return { project, root: rel[1].replace(/\.jsonl$/, "") };
  return { project, root: rel[1] };
}

const projShort = (p) => p.replace(/^-(Users|home)-[^-]+-(Classified-)?/, "").replace(/^-+/, "") || "?";
const modelFamily = (m) => {
  if (!m) return "other";
  const s = String(m).toLowerCase();
  if (s.includes("opus")) return "Opus";
  if (s.includes("sonnet")) return "Sonnet";
  if (s.includes("haiku")) return "Haiku";
  if (s.includes("fable") || s.includes("mythos")) return "Fable";
  return "other";
};

// Quota-pressure weighting — MUST match limit.mjs so the tally's token amounts
// agree with the /usage-anchored statusline (not raw billed, which is ~10x higher
// because cache reads dominate). Per-token: output 5x, cache-write 1.25x,
// cache-read 0.1x. Per-model weight from ~/.maxx/prices.json (daily-refreshed) or
// the built-in fallback. `billed` we ship IS this weighted number.
const PRICE_W = (() => {
  const fallback = { fable: 10 / 3, mythos: 10 / 3, opus: 5 / 3, sonnet: 1, haiku: 1 / 3 };
  try { return { ...fallback, ...(readJSON(path.join(HOME, ".maxx", "prices.json"), {}).weights || {}) }; }
  catch { return fallback; }
})();
const modelWeight = (m) => { m = String(m || "").toLowerCase(); for (const fam in PRICE_W) if (m.includes(fam)) return PRICE_W[fam]; return PRICE_W.sonnet; };
const weightedTok = (u, model) =>
  ((u.input_tokens || 0) + (u.output_tokens || 0) * 5 +
   (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) * modelWeight(model);

// Sum only usage records strictly newer than `sinceSec`, per file, keeping the
// root labels + per-model billed. Returns the new records' contribution.
async function ingestSince(file, sinceSec, seen) {
  let billed = 0, out = 0, turns = 0, first = 0, last = 0;
  let inp = 0, cacheR = 0, cacheW = 0, raw = 0, tools = 0, agentTurns = 0;
  let ctx = 0, lastModel = null; // live context size = latest request's full input
  let errors = 0; // API/token errors (rate-limit, overloaded) — CC flags these rows
  const byModel = {};
  let custom = null, ai = null, agent = null, branch = null, version = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.customTitle) custom = rec.customTitle;
    if (rec.aiTitle) ai = rec.aiTitle;
    if (rec.agentName) agent = rec.agentName;
    if (rec.gitBranch) branch = rec.gitBranch;
    if (rec.version) version = rec.version;
    if (rec.isApiErrorMessage) {
      const et = Date.parse(rec.timestamp || 0) / 1000;
      if (Number.isFinite(et) && et > sinceSec) errors++;
    }
    const u = rec?.message?.usage || rec?.usage;
    const ts = rec?.timestamp;
    if (!u || !ts) continue;
    const t = Date.parse(ts) / 1000;
    if (!Number.isFinite(t) || t <= sinceSec) continue; // only NEW records
    const model = rec?.message?.model || rec?.model;
    const b = Math.round(weightedTok(u, model)); // quota-weighted, matches limit.mjs
    if (!b) continue;
    // dedup repeated usage rows (retries/resumptions log the same turn twice) —
    // matches limit.mjs, or the tally over-counts vs the /usage-anchored statusline.
    const rid = rec.requestId || rec.uuid;
    if (rid && seen) { if (seen.has(rid)) continue; seen.add(rid); }
    billed += b;
    out += u.output_tokens || 0;
    inp += u.input_tokens || 0;
    cacheR += u.cache_read_input_tokens || 0;
    cacheW += u.cache_creation_input_tokens || 0;
    raw += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    // tool-use COUNT only (block types, never arguments or results)
    const content = rec?.message?.content;
    if (Array.isArray(content)) for (const c of content) if (c?.type === "tool_use") tools++;
    if (rec.isSidechain) agentTurns++;
    turns++;
    byModel[modelFamily(model)] = (byModel[modelFamily(model)] || 0) + b;
    if (!first || t < first) first = t;
    if (t >= last) {
      last = t;
      ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      lastModel = model;
    }
  }
  return {
    billed, out, turns, byModel, first, last, name: custom || ai || agent || null, branch, version,
    inp, cacheR, cacheW, raw, tools, agentTurns, ctx, lastModel, errors,
  };
}

const iso = (sec) => new Date(sec * 1000).toISOString();
// human time for LOG DISPLAY only (wire stays ISO/UTC): laptop-local, e.g. "Jul 18 22:10:25"
const localT = (sec) => new Date(sec * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const args = parseArgs(process.argv.slice(2));
const cfg = readJSON(CONFIG, {});
const handle = cfg.handle || "unknown";
const secret = cfg.secret || "";
const installId = cfg.installId || hostname();
const base = (process.env.MAXX_LOGS_URL || cfg.logsUrl || "https://api.meetmaxx.co").replace(/\/$/, "");
const surface = cfg.surface || `laptop:${installId.slice(0, 8)}`;

// The signed-in Claude account — Claude Code only works logged in, so this identity is always
// there to key off. Stamped on signup + every envelope; timelines are per account, never global.
function claudeAccount(file = path.join(HOME, ".claude.json")) {
  try {
    const oa = JSON.parse(readFileSync(file, "utf8")).oauthAccount || {};
    return { uuid: oa.accountUuid || null, email: oa.emailAddress || null };
  } catch { return { uuid: null, email: null }; }
}

// Every Claude login root on this box: the default (~/.claude.json + ~/.claude/projects)
// plus each alternate CLAUDE_CONFIG_DIR (~/.claude-*). Each root is signed into its own
// account, and burn ships to THAT account's handle — a login switch cuts the stream over
// instead of pouring a foreign account's burn into the pinned handle.
function claudeRoots() {
  if (args.dir !== DEFAULT_DIR) // explicit --dir override: single root, legacy identity
    return [{ dir: args.dir, acctFile: path.join(HOME, ".claude.json"), isDefault: true }];
  const roots = [{ dir: DEFAULT_DIR, acctFile: path.join(HOME, ".claude.json"), isDefault: true }];
  try {
    for (const e of readdirSync(HOME, { withFileTypes: true }))
      if (e.isDirectory() && e.name.startsWith(".claude-") && existsSync(path.join(HOME, e.name, ".claude.json")))
        roots.push({ dir: path.join(HOME, e.name, "projects"), acctFile: path.join(HOME, e.name, ".claude.json"), isDefault: false });
  } catch {}
  return roots;
}

// Resolve each root to its ship target via the per-account map (cfg.accounts:
// uuid → {handle, secret}). The legacy single handle migrates onto whatever account
// the default login is on the first time this runs. An account with no handle is
// SKIPPED loudly, never mixed into another account's timeline.
const warnedRoots = new Set();
function resolveRoots() {
  const map = cfg.accounts || (cfg.accounts = {});
  const out = [];
  let migrated = false;
  for (const r of claudeRoots()) {
    const acct = claudeAccount(r.acctFile);
    if (r.isDefault && acct.uuid && cfg.handle && secret && !map[acct.uuid] &&
        !Object.values(map).some((a) => a.handle === cfg.handle)) {
      map[acct.uuid] = { handle: cfg.handle, secret, email: acct.email };
      migrated = true;
    }
    const t = acct.uuid ? map[acct.uuid]
      : r.isDefault && cfg.handle ? { handle: cfg.handle, secret } : null; // no oauth info readable → pre-cutover behavior
    if (!t) {
      const key = acct.uuid || r.dir;
      if (!warnedRoots.has(key))
        console.log(`  SKIP ${r.dir} — account ${acct.email || "?"} (${(acct.uuid || "?").slice(0, 8)}) has no handle; its burn is NOT shipped. Run --signup under that login, or add it to accounts in ${CONFIG}.`);
      warnedRoots.add(key);
      continue;
    }
    out.push({ ...r, uuid: acct.uuid, email: acct.email, handle: t.handle, secret: t.secret });
  }
  if (migrated && args.send) { try { writeFileSync(CONFIG, JSON.stringify(cfg, null, 2)); } catch {} }
  return out;
}

// --signup: claim a handle on the tally server, persist handle/secret/logsUrl.
// `--signup` with no handle derives one from the Claude login (email local part) — zero-input onboarding.
if (args.signup) {
  // sign up AS the login of the session you're in — a CLAUDE_CONFIG_DIR session is that dir's account
  const acct = claudeAccount(path.join(process.env.CLAUDE_CONFIG_DIR || HOME, ".claude.json"));
  const derived = args.signup === true;
  if (derived) {
    const local = (acct.email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[-_]+/, "");
    if (local.length < 3) { console.error("can't derive a handle (no Claude login found) — run --signup <handle>."); process.exit(1); }
    args.signup = local;
  }
  const claim = (handle) => fetch(`${base}/api/signup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, account: acct.uuid, email: acct.email }),
    signal: AbortSignal.timeout(15000),
  });
  let res = await claim(args.signup);
  // derived name taken → one silent retry with a stable account-uuid suffix (zero-input path
  // must not dead-end on a common email local part); an EXPLICIT name failing stays an error.
  if (res.status === 409 && derived && acct.uuid) res = await claim(`${args.signup}-${acct.uuid.slice(0, 4)}`);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`signup failed (${res.status}): ${out.error || "?"}`); process.exit(1); }
  mkdirSync(path.dirname(CONFIG), { recursive: true });
  // per-account map entry always; the top-level handle only on FIRST signup — a later
  // signup under another login must not clobber the existing account's handle
  const accounts = { ...(cfg.accounts || {}) };
  if (acct.uuid) accounts[acct.uuid] = { handle: out.handle, secret: out.secret, email: acct.email };
  const top = cfg.handle && cfg.secret ? {} : { handle: out.handle, secret: out.secret };
  writeFileSync(CONFIG, JSON.stringify({ ...cfg, ...top, accounts, logsUrl: base }, null, 2));
  console.log(`maxx: handle "${out.handle}" claimed — config written to ${CONFIG}`);
  console.log(`\n  Cloud connector — optional, only needed for claude.ai/cloud sessions:`);
  console.log(`    open  https://claude.ai/settings/connectors  → Add custom connector`);
  console.log(`    Name: Maxx\n    URL:  ${out.mcp_url}`);
  console.log(`    (attaches automatically to NEW routines only — add it to existing ones by hand)`);
  console.log(`\n  Laptop live-ship (start at login):\n    node ${fileURLToPath(import.meta.url)} --install-agent`);
  console.log(`\n  Watch it with your own eyes:\n    node ${path.join(path.dirname(fileURLToPath(import.meta.url)), "watch.mjs")}\n`);
  process.exit(0);
}

// --set-token: mint a long-lived probe credential per account and register it server-side,
// so the tally can PULL a fresh limit anchor whenever that account's laptop stops pushing
// one (asleep/off). Run at onboarding (installer calls this) or any time to (re)set it.
// `claude setup-token` is interactive (browser) — best-effort: a missing binary or a
// non-interactive shell skips cleanly with the manual one-liner, never blocks the install.
if (args.setToken) {
  const { spawnSync } = await import("node:child_process");
  let targets = resolveRoots();
  if (args.only) {
    const want = String(args.only).replace(/^@/, "").toLowerCase();
    targets = targets.filter((r) => r.handle.toLowerCase() === want);
    if (!targets.length) { console.error(`maxx: no linked account @${want} — run without --only to see all, or --signup under that login.`); process.exit(1); }
  }
  if (!targets.length) { console.error("maxx: no linked account — run --signup first."); process.exit(1); }
  let ok = 0;
  for (const r of targets) {
    // CLAUDE_CONFIG_DIR is the account's config DIR. For the default login that's
    // ~/.claude (its .claude.json sits at ~/.claude.json, so dirname would wrongly give
    // HOME); non-default logins keep their .claude-<x>/ dir.
    const cfgDir = r.isDefault ? path.join(HOME, ".claude") : path.dirname(r.acctFile);
    process.stdout.write(`maxx: minting probe token for @${r.handle} (${r.email || cfgDir}) — complete the browser login…\n`);
    // inherit stdin/stderr so the user can drive the OAuth prompt; capture stdout for the token
    const run = spawnSync("claude", ["setup-token"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir },
      encoding: "utf8", stdio: ["inherit", "pipe", "inherit"],
    });
    if (run.error) { console.error(`  skip @${r.handle}: cannot run \`claude setup-token\` (${run.error.code || run.error.message}). Set later: node ${fileURLToPath(import.meta.url)} --set-token`); continue; }
    const token = extractSetupToken(run.stdout);
    if (!token) { console.error(`  skip @${r.handle}: no token in setup-token output.`); continue; }
    const res = await fetch(`${base}/api/u/${encodeURIComponent(r.handle)}/config?k=${encodeURIComponent(r.secret)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe_token: token }), signal: AbortSignal.timeout(15000),
    }).catch((e) => ({ ok: false, status: 0, _err: e }));
    const j = res.ok ? await res.json().catch(() => ({})) : {};
    if (res.ok && j.probe) { console.log(`  ✓ @${r.handle}: probe token registered (server pulls an anchor when this laptop is away).`); ok++; }
    else console.error(`  ✗ @${r.handle}: server rejected the token (${res.status || res._err?.message || "?"}).`);
  }
  console.log(`maxx: probe token set for ${ok}/${targets.length} account(s).`);
  process.exit(ok ? 0 : 1);
}

// --install-agent: run `emit.mjs --watch` at login. launchd on macOS; prints a
// systemd user unit elsewhere.
// --dash: open the owner dashboard via a magic link — the secret authenticates the
// mint (bearer, request header), the link itself is single-use and dies in 120s, so
// nothing durable ever lands in browser history or URLs.
if (args.dash) {
  if (!cfg.handle || !cfg.secret) { console.error("no handle/secret in ~/.maxx/config.json — run --signup first"); process.exit(1); }
  const r = await fetch(`${base}/api/u/${cfg.handle}/magic`, { method: "POST", headers: { authorization: `Bearer ${cfg.secret}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) { console.error(`magic link failed: HTTP ${r.status}`); process.exit(1); }
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(opener, [j.url], { stdio: "ignore" });
    console.log(`dashboard opening — link is single-use, expires in ${j.expires_in_sec}s`);
  } catch {
    console.log(`open this (single-use, ${j.expires_in_sec}s):\n  ${j.url}`);
  }
  process.exit(0);
}

// --watchdog: one-shot wedge detector, run by launchd every 5 min. The --watch
// process has twice wedged silently (cycle timeouts; once even its KeepAlive
// respawn wedged) — sessions kept writing while the shipper went dark, and every
// surface honestly reported "nothing spent". Signal: some session .jsonl grew in
// the last 10 min but emit.log hasn't been written in 10 min → the emitter is
// dark while there's work, so kick it hard. A false kick is harmless (KeepAlive).
if (args.watchdog) {
  const STALE_MS = 10 * 60 * 1000;
  const now = Date.now();
  let logM = 0; try { logM = statSync(path.join(HOME, ".maxx", "emit.log")).mtimeMs; } catch {}
  if (now - logM >= STALE_MS) {
    let sessionsFresh = false;
    outer: for (const r of claudeRoots()) {
      let dirs = []; try { dirs = readdirSync(r.dir, { withFileTypes: true }); } catch { continue; }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const pdir = path.join(r.dir, d.name);
        let files = []; try { files = readdirSync(pdir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          try { if (now - statSync(path.join(pdir, f)).mtimeMs < STALE_MS) { sessionsFresh = true; break outer; } } catch {}
        }
      }
    }
    if (sessionsFresh) {
      const { execSync } = await import("node:child_process");
      const stamp = new Date().toISOString();
      try {
        execSync(`launchctl kickstart -k gui/${process.getuid()}/co.meetmaxx.emit`);
        console.log(`[watchdog] ${stamp} emitter silent ${Math.round((now - logM) / 60000)}m while sessions are writing — kickstarted co.meetmaxx.emit`);
      } catch (e) {
        console.log(`[watchdog] ${stamp} kickstart failed: ${e.message}`);
      }
    }
  }
  process.exit(0);
}

if (args.installAgent) {
  if (!cfg.handle || !cfg.secret) { console.error("no handle/secret in ~/.maxx/config.json — run --signup <handle> first."); process.exit(1); }
  const self = fileURLToPath(import.meta.url);
  if (process.platform === "darwin") {
    const label = "co.meetmaxx.emit";
    const plist = path.join(HOME, "Library", "LaunchAgents", `${label}.plist`);
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${self}</string><string>--watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(HOME, ".maxx", "emit.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(HOME, ".maxx", "emit.log")}</string>
</dict></plist>\n`);
    const { execSync } = await import("node:child_process");
    const uid = process.getuid();
    try { execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null`); } catch {}
    execSync(`launchctl bootstrap gui/${uid} ${plist}`);
    execSync(`launchctl kickstart -k gui/${uid}/${label}`);
    // watchdog: the --watch process has wedged silently before; a 5-min one-shot
    // check restarts it whenever sessions are writing but the shipper has gone dark.
    const wdLabel = "co.meetmaxx.watchdog";
    const wdPlist = path.join(HOME, "Library", "LaunchAgents", `${wdLabel}.plist`);
    writeFileSync(wdPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${wdLabel}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${self}</string><string>--watchdog</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${path.join(HOME, ".maxx", "watchdog.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(HOME, ".maxx", "watchdog.log")}</string>
</dict></plist>\n`);
    try { execSync(`launchctl bootout gui/${uid}/${wdLabel} 2>/dev/null`); } catch {}
    execSync(`launchctl bootstrap gui/${uid} ${wdPlist}`);
    console.log(`maxx: launchd agent ${label} installed + running (log: ~/.maxx/emit.log)`);
    console.log(`maxx: watchdog ${wdLabel} installed — every 5 min, restarts a wedged emitter (log: ~/.maxx/watchdog.log)`);
  } else {
    console.log(`maxx: no launchd here — create a systemd user unit:\n
  ~/.config/systemd/user/maxx-emit.service:
    [Unit]\n    Description=maxx emit --watch
    [Service]\n    ExecStart=${process.execPath} ${self} --watch\n    Restart=always
    [Install]\n    WantedBy=default.target

  systemctl --user daemon-reload && systemctl --user enable --now maxx-emit`);
  }
  process.exit(0);
}

// One emit cycle: for EACH login root, read its cursor, scan NEW usage past it,
// attach the anchor if this root's account observed it, print (dry) or POST (send)
// and advance that root's cursor only on a 2xx. First run of a root (no cursor)
// ships ALL its history — a one-time bulk backfill so the server has complete
// ground truth to reconstruct usage over time and true-up caps against every anchor.
async function runOnce({ quiet = false } = {}) {
  const nowSec = Date.now() / 1000;
  const cursorAll = readJSON(CURSOR, {});
  cursorAll.roots = cursorAll.roots || {};

  // Anchor: the authoritative subscription %s an interactive statusline observed —
  // per LOGIN ROOT. Each root's sessions write suffixed rl/status files (same suffix
  // rule as render/limit/gate), and an anchor must only ever calibrate the account
  // that observed it (belt: filename scope; suspenders: the stamped account uuid).
  // Only attach if fresh — never ship a stale anchor with a new timestamp.
  const anchorFor = (root) => {
    const suf = root.isDefault ? "" : "-" + path.basename(path.dirname(root.acctFile)).replace(/^\.claude-?/, "");
    const rl = readJSON(path.join(HOME, ".maxx", `rl${suf}.json`), null);
    if (!rl || !rl.ts || (Date.now() - rl.ts) / 1000 >= ANCHOR_MAX_AGE_SEC || (rl.quota == null && rl.week == null)) return null;
    if (rl.account && root.uuid && rl.account !== root.uuid) return null;
    if (!rl.account && !root.isDefault) return null; // unstamped legacy anchor: default root only
    const anchor = {
      five_pct: rl.quota ?? null, week_pct: rl.week ?? null,
      five_reset: rl.fiveResetAt ?? null, week_reset: rl.weekResetAt ?? null,
      observed_at: iso(rl.ts / 1000),
    };
    // Statusline passthrough: ship the bar's OWN computed numbers (its units) so every
    // surface shows what the CLI shows, instead of re-deriving from the coarse integer %.
    const st = readJSON(path.join(HOME, ".maxx", `status${suf}.json`), null);
    if (st && st.ts && (Date.now() - st.ts) / 1000 < ANCHOR_MAX_AGE_SEC && st.weekly?.cap > 0 &&
        (!st.account || !rl.account || st.account === rl.account)) {
      anchor.sl = {
        five_used: st.session?.rawUsed ?? null, five_cap: st.session?.rawCap ?? null,
        to_spend: st.session?.toSpend ?? null, over: st.session?.over ?? null,
        week_used: st.weekly.used ?? null, week_cap: st.weekly.cap,
        bank: st.session?.bank ?? null, net_per_min: st.netPerMin ?? null,
        at: iso(st.ts / 1000),
      };
    }
    return anchor;
  };

  const jsonOut = [];
  let maxAll = 0, failed = false;
  for (const root of resolveRoots()) {
    const r = await emitRoot(root, { quiet, nowSec, cursorAll, anchor: anchorFor(root) });
    if (r.envelope && args.json) jsonOut.push(r.envelope);
    if (r.failed) failed = true;
    if (r.maxTs > maxAll) maxAll = r.maxTs;
  }
  if (args.json && !quiet) console.log(JSON.stringify(jsonOut, null, 2));
  if (failed && !args.watch) process.exit(1);
  return maxAll;
}

async function emitRoot(root, { quiet, nowSec, cursorAll, anchor }) {
  const cur = cursorAll.roots[root.dir] || (root.isDefault ? { lastTs: cursorAll.lastTs, at: cursorAll.at } : {});
  const sinceSec = args.since ? Date.parse(args.since) / 1000 : (cur.lastTs || 0);

  const files = await recentFiles(root.dir, (sinceSec - 120) * 1000 || 0);
  const roots = new Map();
  let maxTs = sinceSec;
  const seen = new Set(); // dedup requestId/uuid across all files this cycle
  for (const f of files) {
    const s = await ingestSince(f, sinceSec, seen);
    if (!s.billed) continue;
    const c = classify(root.dir, f);
    const key = `${c.project}/${c.root}`;
    let r = roots.get(key);
    if (!r) { r = { root: c.root, project: projShort(c.project), name: null, branch: null, version: null, billed: 0, output: 0, turns: 0, input: 0, cache_read: 0, cache_write: 0, raw: 0, tool_calls: 0, agent_turns: 0, errors: 0, ctx: 0, lastModel: null, byModel: {}, first: 0, last: 0 }; roots.set(key, r); }
    r.billed += s.billed; r.output += s.out; r.turns += s.turns;
    r.input += s.inp; r.cache_read += s.cacheR; r.cache_write += s.cacheW;
    r.raw += s.raw; r.tool_calls += s.tools; r.agent_turns += s.agentTurns; r.errors += s.errors || 0;
    if (s.last >= r.last) { r.ctx = s.ctx; r.lastModel = s.lastModel; }
    for (const k in s.byModel) r.byModel[k] = (r.byModel[k] || 0) + s.byModel[k];
    if (s.name) r.name = s.name;
    if (s.branch) r.branch = s.branch;
    if (s.version) r.version = s.version;
    if (!r.first || s.first < r.first) r.first = s.first;
    if (s.last > r.last) r.last = s.last;
    if (s.last > maxTs) maxTs = s.last;
  }

  const sessions = [...roots.values()]
    .sort((a, b) => b.billed - a.billed)
    .map((r) => ({
      root: r.root, project: r.project, name: r.name, branch: r.branch, cc_version: r.version,
      billed: r.billed, output: r.output, turns: r.turns, by_model: r.byModel,
      input: r.input, cache_read: r.cache_read, cache_write: r.cache_write,
      raw: r.raw, tool_calls: r.tool_calls, agent_turns: r.agent_turns, errors: r.errors,
      ctx: r.ctx, cost_per_action: Math.round(r.ctx * 0.1 * modelWeight(r.lastModel)),
      first_ts: r.first ? iso(r.first) : null, last_ts: r.last ? iso(r.last) : null,
    }));
  const totalBilled = sessions.reduce((a, s) => a + s.billed, 0);
  const totalOutput = sessions.reduce((a, s) => a + s.output, 0);

  const envelope = {
    v: 1, surface, install_id: installId, handle: root.handle,
    account: root.uuid,                  // which Claude account this burn counted against
    emitted_at: iso(nowSec), since: sinceSec ? iso(sinceSec) : null,
    cursor: String(Math.round(maxTs)),
    totals: { billed: totalBilled, output: totalOutput, sessions: sessions.length },
    sessions, anchor,
  };

  if (!quiet && !args.json)
    console.log(`MAXX_EMIT handle=${root.handle} surface=${surface} new_billed=${totalBilled} output=${totalOutput} sessions=${sessions.length} anchor=${anchor ? "yes" : "no"} target=${base}/api/u/${root.handle}/logs mode=${args.send ? "send" : "dry"}`);
  // Idle heartbeat: no new burn still refreshes the server's anchor. Without this an
  // idle laptop lets the anchor age out and every fail-closed gate blocks on "stale"
  // while budget sits unused. Throttled off the cursor stamp; needs a fresh local
  // anchor PAIRED TO THIS ROOT'S ACCOUNT to ship (a blind machine still goes stale).
  const lastSendAt = Date.parse(cur.at || 0) || 0;
  const hbMin = process.env.MAXX_HEARTBEAT_MIN !== undefined ? Number(process.env.MAXX_HEARTBEAT_MIN) : 5;
  const hbDue = args.send && anchor && Date.now() - lastSendAt > hbMin * 60_000;
  if (!totalBilled && !hbDue) { if (!quiet && !args.json) console.log("  nothing new since cursor."); return { envelope, maxTs }; }
  if (!totalBilled && !quiet && !args.json) console.log("  idle heartbeat — anchor-only refresh.");

  if (!args.send) {
    if (!quiet && !args.json) {
      console.log(`\n  DRY RUN — would POST to ${base}/api/u/${root.handle}/logs:`);
      for (const s of sessions.slice(0, 8)) {
        const mm = Object.entries(s.by_model).map(([k, v]) => `${k} ${Math.round(v / 1e3)}k`).join(" ");
        console.log(`    ${String(Math.round(s.billed / 1e3)).padStart(6)}k  ${s.project} — ${s.name || s.root.slice(0, 8)}  (${mm})`);
      }
      console.log(`  anchor: ${anchor ? `5h ${Math.round((anchor.five_pct || 0) * 100)}% · week ${Math.round((anchor.week_pct || 0) * 100)}%` : "none fresh"}`);
      console.log(`  cursor would advance ${sinceSec ? iso(sinceSec) : "(start)"} → ${iso(maxTs)}\n  run with --send to ship it.\n`);
    }
    return { envelope, maxTs };
  }

  // --send
  if (!root.secret) { process.stderr.write(`maxx emit: no secret for ${root.handle} in ~/.maxx/config.json.\n`); return { envelope, maxTs, failed: true }; }
  try {
    const res = await fetch(`${base}/api/u/${encodeURIComponent(root.handle)}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${root.secret}` },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text().catch(() => "");
    if (res.ok) {
      cursorAll.roots[root.dir] = { lastTs: Math.round(maxTs), at: iso(nowSec) };
      if (root.isDefault) { cursorAll.lastTs = Math.round(maxTs); cursorAll.at = iso(nowSec); }
      writeFileSync(CURSOR, JSON.stringify(cursorAll));
      // Cache the ACCOUNT-WIDE budget so the local statusline can show the account net
      // (not just this machine's). The watcher is the network-talking component; gate.mjs
      // writes the same {at,b} file on gate checks, but only agent spawns trigger that —
      // this keeps it fresh every batch so render.mjs never falls back to a local-only net.
      // One gate-cache per login root (suffix rule matches render/gate) — each session
      // gates on and displays ITS OWN account's net.
      try {
        const suf = root.isDefault ? "" : "-" + path.basename(path.dirname(root.acctFile)).replace(/^\.claude-?/, "");
        const br = await fetch(`${base}/api/u/${encodeURIComponent(root.handle)}/budget`,
          { headers: { authorization: `Bearer ${root.secret}` }, signal: AbortSignal.timeout(8000) });
        if (br.ok) writeFileSync(path.join(HOME, ".maxx", `gate-cache${suf}.json`),
          JSON.stringify({ at: Date.now() / 1000, b: await br.json() }));
      } catch {}
      console.log(`  sent ✓ ${res.status} ${root.handle} +${fmtK(totalBilled)} · ${localT(maxTs)} · ${body.slice(0, 120)}`);
      // who/what per session, so a tail of this log is attributable on its own:
      // billed · project — session name [branch] (model mix)
      for (const s of sessions.slice(0, 6)) {
        const mm = Object.entries(s.by_model).map(([k, v]) => `${k} ${fmtK(v)}`).join(" ");
        // ctx = how fat this session is; /action = quota cost of its NEXT tool call.
        // High /action → a /clear or a fresh session pays for itself immediately.
        const cost = s.cost_per_action ? ` · ctx ${fmtK(s.ctx)} ≈${fmtK(s.cost_per_action)}/action` : "";
        console.log(`      ${fmtK(s.billed).padStart(6)}  ${s.project} — ${s.name || s.root.slice(0, 8)}${s.branch ? ` [${s.branch}]` : ""}  (${mm})${cost}`);
      }
      // pace context — the "so what" for the numbers above, from the local
      // statusline state (window.json): position vs the paced share + the walls.
      const w = root.isDefault ? readJSON(path.join(HOME, ".maxx", "window.json"), null) : null;
      if (w && w.ts && Date.now() - w.ts < 10 * 60_000) {
        const pace = w.sessionOver > 0
          ? `OVER share by ${fmtK(w.sessionOver)}`
          : `${fmtK(w.sessionToSpend)} left of ${fmtK(w.sessionSafe)} share`;
        console.log(`      pace: ${pace} · window ${fmtK(w.used5)}/${fmtK(w.cap5)} · week ${Math.round((w.weekPct || 0) * 100)}% (${fmtK(Math.max(0, (w.weekCap || 0) - (w.weekUsed || 0)))} left) · ${w.sessionsLeft} windows to reset`);
      }
    } else {
      console.log(`  send FAILED ${res.status} ${root.handle} — cursor NOT advanced · ${body.slice(0, 200)}`);
      return { envelope, maxTs, failed: true };
    }
  } catch (e) {
    console.log(`  send error ${root.handle} — cursor NOT advanced · ${e.message}`);
    return { envelope, maxTs, failed: true };
  }
  return { envelope, maxTs };
}

const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "k";

if (!args.watch) {
  await runOnce();
} else {
  // Live stream: a session's .jsonl is appended per-turn WHILE it runs, so tailing
  // the projects dir emits each turn's usage as it lands. Debounce bursts; a slow
  // interval backstops any watch event the OS drops.
  const { watch } = await import("node:fs");
  console.log(`MAXX_EMIT watch=on surface=${surface} target=${base} — live-streaming turns as they land (Ctrl-C to stop)`);
  await runOnce({ quiet: true });
  // The watcher is the whole data pipeline: if it stops, every surface goes dark and
  // the tally silently reports "nothing spent". It ran 2h45m wedged exactly once —
  // `running` latched true and every later cycle hit `if (running) return`, while the
  // process stayed alive and healthy-looking. So: reset in a finally (a throw inside
  // the catch used to strand it), cap a cycle so it can never hang forever, and let a
  // cycle that overruns be superseded rather than blocking the next one for good.
  const CYCLE_MAX_MS = 120000;
  // Crash-only escape hatch: a cycle timeout aborts the race, not the work — a wedged
  // runOnce keeps its streams/state in-process, and every later cycle hits the same
  // wedge (observed 3.5h of back-to-back timeouts; a restart cured it instantly). The
  // process can't heal itself, so after 3 straight timeouts exit(1) and let launchd
  // (KeepAlive) respawn a clean one. Any successful cycle resets the count.
  const TIMEOUTS_BEFORE_EXIT = 3;
  let consecTimeouts = 0;
  let timer = null, running = false, startedAt = 0;
  const kick = () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (running) {
        if (Date.now() - startedAt < CYCLE_MAX_MS) return;
        console.log(`  cycle overran ${Math.round((Date.now() - startedAt) / 1000)}s — starting a fresh one`);
      }
      running = true; startedAt = Date.now();
      try {
        await Promise.race([
          runOnce({ quiet: true }),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`cycle timeout after ${CYCLE_MAX_MS}ms`)), CYCLE_MAX_MS)),
        ]);
        consecTimeouts = 0;
      } catch (e) {
        try { console.log("  cycle error:", (e && e.message) || String(e)); } catch {}
        if (e && /cycle timeout/.test(String(e.message))) {
          consecTimeouts += 1;
          if (consecTimeouts >= TIMEOUTS_BEFORE_EXIT) {
            try { console.log(`  ${consecTimeouts} consecutive cycle timeouts — process state is wedged, exiting for launchd to respawn clean`); } catch {}
            process.exit(1);
          }
        } else {
          consecTimeouts = 0;
        }
      } finally {
        running = false;
      }
    }, 2000); // debounce 2s
  };
  for (const r of claudeRoots()) {
    try { watch(r.dir, { recursive: true }, (_e, f) => { if (f && f.endsWith(".jsonl")) kick(); }); }
    catch { /* recursive watch unsupported, or root has no projects dir yet — 60s backstop covers it */ }
  }
  setInterval(kick, 60000); // 60s backstop
}
