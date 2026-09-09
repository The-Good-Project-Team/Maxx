#!/usr/bin/env node
/**
 * maxx agents — the whole board a token-allocating orchestrator acts on:
 * WHO is burning, LOCAL and CLOUD, with burn velocity across time buckets.
 *
 * Orchestrators are platform-agnostic — they run local sessions AND cloud
 * routines at the same time. So this shows BOTH in one ranked picture:
 *
 *   LOCAL  — read from ~/.claude/projects/**\/*.jsonl on this box. Session logs
 *            nest: a root at <project>/<ROOT>.jsonl owns everything under
 *            <ROOT>/subagents/** (subagent spawns AND workflow fan-outs), so a
 *            300-agent workflow is ONE root's burn, not 300 strangers. Rolled up
 *            to the root, labeled customTitle > aiTitle > agentName + git branch.
 *   CLOUD  — scheduled claude.ai routines. The node script can't reach the
 *            OAuth-gated API, so the orchestrator pipes in `RemoteTrigger list`
 *            output: save its JSON, pass `--cloud <file>`. Merged as its own
 *            section (schedule / enabled / last-fired / next-run / model / repo).
 *
 * VELOCITY — every local root's billed tokens are bucketed by recency:
 *            last 10s · 30s · 1m · 5m · 1h · 2h (cumulative — a token 5s ago
 *            counts in all six). This is the accelerate/decelerate signal an
 *            allocator needs, not just a window total.
 *
 * Usage:
 *   node maxx/agents.mjs                    — ranked local roots + velocity, last 2h
 *   node maxx/agents.mjs --mins 30          — window minutes (default 120 = covers the 2h bucket)
 *   node maxx/agents.mjs --children         — also list each root's live descendants
 *   node maxx/agents.mjs --cloud FILE       — merge cloud routines from a RemoteTrigger-list JSON
 *   node maxx/agents.mjs --json             — machine payload (local roots + buckets + cloud)
 *   node maxx/agents.mjs --dir PATH         — override: read ONE projects dir instead of every login root
 *
 * Agent-readable: first stdout line is a single `MAXX_AGENTS …` record (grep it).
 * On-box: reads only usage/token metadata + titles locally; cloud data is
 * whatever the orchestrator already fetched. Sends nothing itself.
 */
import { createReadStream, readFileSync, readdirSync, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
const LIVE_SEC = 5 * 60;

// Every Claude login root on this box: ~/.claude plus each ~/.claude-<account>. Burn follows
// the login, so a board that reads one root reports that root as the whole — the laptop showed
// 306M for a week that was 2.6B (2026-09-08), 92% of it under ~/.claude-gmail.
function loginRoots() {
  const out = [];
  try {
    for (const e of readdirSync(HOME, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^\.claude(-|$)/.test(e.name)) continue;
      const p = path.join(HOME, e.name, "projects");
      if (existsSync(p)) out.push(p);
    }
  } catch {}
  return out.length ? out : [path.join(HOME, ".claude", "projects")];
}
// ~/.claude → "main", ~/.claude-gmail → "gmail": the login a root's burn counts against.
const acctOf = (dir) => path.basename(path.dirname(dir)).replace(/^\.claude-?/, "") || "main";

// Cumulative recency buckets: "billed in the last N seconds". A token 5s old
// counts in every bucket. This is burn velocity — the allocator's core signal.
const BUCKETS = [
  { key: "s10", sec: 10, label: "10s" },
  { key: "s30", sec: 30, label: "30s" },
  { key: "s60", sec: 60, label: "1m" },
  { key: "s300", sec: 300, label: "5m" },
  { key: "h1", sec: 3600, label: "1h" },
  { key: "h2", sec: 7200, label: "2h" },
];
const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
const addBuckets = (into, from) => { for (const b of BUCKETS) into[b.key] += from[b.key]; };

function parseArgs(argv) {
  const out = { dirs: loginRoots(), mins: 120, json: false, children: false, cloud: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "json") out.json = true;
    else if (a === "--children" || a === "children") out.children = true;
    else if (a === "--mins") out.mins = Number(argv[++i]) || 120;
    else if (a === "--cloud") out.cloud = argv[++i];
    else if (a === "--dir") out.dirs = [argv[++i]];
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

// Map a file path under the projects dir to its owning root session.
//   <project>/<root>.jsonl                              → root itself   (kind: own)
//   <project>/<root>/subagents/.../agent-*.jsonl        → child         (kind: sub)
//   <project>/<root>/subagents/workflows/<wf>/agent-*   → child         (kind: wf)
function classify(dir, file) {
  const rel = path.relative(dir, file).split(path.sep);
  const project = rel[0] || "?";
  if (rel.length === 2) {
    return { project, root: rel[1].replace(/\.jsonl$/, ""), kind: "own" };
  }
  const root = rel[1]; // the ROOT-UUID directory
  const kind = rel.includes("workflows") ? "wf" : "sub";
  return { project, root, kind };
}

async function ingest(file, cutoffSec, nowSec) {
  let tok = 0, out = 0, turns = 0, last = 0;
  let custom = null, ai = null, agent = null, branch = null, cwd = null;
  const buckets = emptyBuckets();
  const seen = new Set(); // one usage row per request — streaming logs the same turn once per content block (tracker/emit dedupe the same way)
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.customTitle) custom = rec.customTitle;
    if (rec.aiTitle) ai = rec.aiTitle;
    if (rec.agentName) agent = rec.agentName;
    if (rec.gitBranch) branch = rec.gitBranch;
    if (rec.cwd) cwd = rec.cwd;
    const rid = rec.requestId || rec.uuid;
    if (rid) { if (seen.has(rid)) continue; seen.add(rid); }
    const u = rec?.message?.usage || rec?.usage;
    const ts = rec?.timestamp;
    if (!u || !ts) continue;
    const t = Date.parse(ts) / 1000;
    if (!Number.isFinite(t) || t < cutoffSec) continue;
    const billed = (u.input_tokens || 0) + (u.output_tokens || 0) +
                   (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    tok += billed;
    out += u.output_tokens || 0;
    turns++;
    if (t > last) last = t;
    const age = nowSec - t;
    for (const b of BUCKETS) if (age <= b.sec) buckets[b.key] += billed;
  }
  return { tok, out, turns, last, custom, ai, agent, branch, cwd, buckets };
}

// Metadata-only scan of a root's own .jsonl — no token/window filter. Backfills
// name+branch+cwd for roots whose own log fell outside the window but whose
// children are still live (idle root, bleeding descendants). Stops when it has both.
async function readMeta(file) {
  let custom = null, ai = null, agent = null, branch = null, cwd = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.customTitle) custom = rec.customTitle;
    if (rec.aiTitle) ai = rec.aiTitle;
    if (rec.agentName) agent = rec.agentName;
    if (rec.gitBranch) branch = rec.gitBranch;
    if (rec.cwd) cwd = rec.cwd;
    if (custom && branch) break;
  }
  rl.close();
  return { name: custom || ai || agent || null, branch, cwd };
}

// Parse a `RemoteTrigger list` payload (full response or its .data array) into
// cloud routine rows. Best-effort field extraction — the API exposes schedule
// and lifecycle, not per-routine token counts, so cloud rows carry no billed.
function parseCloud(raw, nowSec) {
  let doc;
  try { doc = JSON.parse(raw); } catch {
    // tolerate a leading "HTTP 200\n" line that RemoteTrigger prepends
    const brace = raw.indexOf("{");
    doc = brace >= 0 ? JSON.parse(raw.slice(brace)) : null;
  }
  const list = Array.isArray(doc) ? doc : (doc?.data || []);
  return list.map((t) => {
    const ccr = t?.job_config?.ccr?.session_context || {};
    const repo = ccr.sources?.[0]?.git_repository?.url || "";
    const lastSec = t.last_fired_at ? Date.parse(t.last_fired_at) / 1000 : null;
    return {
      id: t.id,
      name: t.name || t.id,
      cron: t.cron_expression || "",
      enabled: t.enabled !== false,
      model: (ccr.model || "").replace(/^claude-/, ""),
      repo: repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, ""),
      lastFired: t.last_fired_at || null,
      nextRun: t.next_run_at || null,
      firedAgoMin: lastSec ? Math.round((nowSec - lastSec) / 60) : null,
    };
  });
}

const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + "B" :
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n);
const dash = (n) => (n ? fmt(n) : "·");
const pad = (s, w) => String(s).padStart(w);
const projShort = (p) => p.replace(/^-Users-reify-(Classified-)?/, "").replace(/^-+/, "") || "?";
// Per-root label: short project name, or the session's cwd when there's no real
// project dir (a `claude` run from `/` shows up as project "-" → "?").
const projLabel = (r) => { const s = projShort(r.project); return s === "?" ? (r.cwd || "?") : s; };
// "philanthropy@gmail": which login this root's burn counts against — one box, many quotas.
const acctLabel = (r) => `${projLabel(r)}@${r.acct}`;
// HH:MM (UTC) from an ISO stamp, for compact schedule display.
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "—");

const args = parseArgs(process.argv.slice(2));
const nowSec = Date.now() / 1000;
const cutoffSec = nowSec - args.mins * 60;
const liveSince = nowSec - LIVE_SEC;

// aggregate into ROOT sessions, across every login root
const roots = new Map();
for (const dir of args.dirs) for (const f of await recentFiles(dir, cutoffSec * 1000)) {
  const s = await ingest(f, cutoffSec, nowSec);
  if (!s.tok) continue;
  const c = classify(dir, f);
  const acct = acctOf(dir);
  const key = `${acct}/${c.project}/${c.root}`;
  let r = roots.get(key);
  if (!r) {
    r = { key, dir, acct, project: c.project, root: c.root, billed: 0, out: 0, own: 0, sub: 0, wf: 0,
          nSub: 0, nWf: 0, live: 0, last: 0, name: null, branch: null, cwd: null,
          buckets: emptyBuckets(), children: [] };
    roots.set(key, r);
  }
  r.billed += s.tok; r.out += s.out; r.last = Math.max(r.last, s.last);
  r[c.kind] += s.tok;
  addBuckets(r.buckets, s.buckets);
  if (c.kind === "sub") r.nSub++;
  if (c.kind === "wf") r.nWf++;
  if (s.last > liveSince) r.live++;
  if (c.kind === "own") { r.name = s.custom || s.ai || s.agent || r.name; r.branch = s.branch || r.branch; r.cwd = s.cwd || r.cwd; }
  else if (!r.name && (s.custom || s.ai || s.agent)) r.name = s.custom || s.ai || s.agent;
  if (s.last > liveSince) r.children.push({ kind: c.kind, billed: s.tok, file: path.basename(f).replace(/\.jsonl$/, "").slice(0, 12) });
}

// Backfill idle-root-with-live-children: read the root's own log directly.
for (const r of roots.values()) {
  if (r.name && r.branch) continue;
  try {
    const m = await readMeta(path.join(r.dir, r.project, r.root + ".jsonl"));
    r.name = r.name || m.name;
    r.branch = r.branch || m.branch;
    r.cwd = r.cwd || m.cwd;
  } catch {}
}

const ranked = [...roots.values()].sort((a, b) => b.billed - a.billed);
const totBilled = ranked.reduce((a, r) => a + r.billed, 0);
const totOut = ranked.reduce((a, r) => a + r.out, 0);
const liveRoots = ranked.filter((r) => r.live > 0);
const totBuckets = emptyBuckets();
for (const r of ranked) addBuckets(totBuckets, r.buckets);

// cloud routines (optional, piped in from RemoteTrigger list)
let cloud = [];
if (args.cloud) {
  try { cloud = parseCloud(readFileSync(args.cloud, "utf8"), nowSec); }
  catch (e) { process.stderr.write(`maxx agents: could not read --cloud ${args.cloud}: ${e.message}\n`); }
}
const cloudOn = cloud.filter((c) => c.enabled).length;

// ── agent-readable first line ───────────────────────────────────────────────
const label = (r) => `${acctLabel(r)}${r.name ? ":" + r.name.slice(0, 32) : ""}`;
const top = ranked.slice(0, 4).map((r) => `${label(r).replace(/\s+/g, "_")}=${fmt(r.billed)}`).join(" ");
const vel = BUCKETS.map((b) => `${b.label}=${fmt(totBuckets[b.key])}`).join(" ");
console.log(`MAXX_AGENTS window=${args.mins}m logins=${args.dirs.length} billed=${fmt(totBilled)} output=${fmt(totOut)} roots=${ranked.length} live_roots=${liveRoots.length} cloud=${cloud.length} cloud_on=${cloudOn} velocity=[${vel}] top=[${top}]`);

if (args.json) {
  console.log(JSON.stringify({
    windowMins: args.mins, at: new Date(nowSec * 1000).toISOString(),
    totalBilled: totBilled, totalOutput: totOut, rootCount: ranked.length, liveRoots: liveRoots.length,
    velocity: totBuckets,
    local: ranked.map((r) => ({
      key: r.key, account: r.acct, project: projLabel(r), name: r.name, branch: r.branch,
      billed: r.billed, output: r.out, live: r.live, agoMin: Math.round((nowSec - r.last) / 60),
      buckets: r.buckets,
      breakdown: { own: r.own, subagents: r.sub, workflow: r.wf, nSub: r.nSub, nWf: r.nWf },
      liveChildren: r.children.sort((a, b) => b.billed - a.billed).slice(0, 10),
    })),
    cloud,
  }, null, 2));
  process.exit(0);
}

// ── local board ─────────────────────────────────────────────────────────────
const colW = 7;
const velHead = BUCKETS.map((b) => pad(b.label, colW)).join("");
console.log(`\n  maxx agents — the whole board  ·  last ${args.mins}m  ·  ${args.dirs.length} login root${args.dirs.length === 1 ? "" : "s"} (${args.dirs.map(acctOf).join(", ")}) + cloud routines\n`);
console.log(`  LOCAL — who's burning (rolled up to root session)`);
console.log(`  ${" ".repeat(2)} ${pad("billed", colW)}  ${pad("state", 8)}  ${velHead}  who`);
for (const r of ranked) {
  const flag = r.live ? "🔴" : "  ";
  const state = r.live ? `${r.live} live` : `idle ${Math.round((nowSec - r.last) / 60)}m`;
  const nm = r.name ? `"${r.name}"` : projLabel(r);
  const parts = [];
  if (r.sub) parts.push(`sub ${fmt(r.sub)}×${r.nSub}`);
  if (r.wf) parts.push(`wf ${fmt(r.wf)}×${r.nWf}`);
  const bd = parts.length ? `  (own ${fmt(r.own)} · ${parts.join(" · ")})` : "";
  const velCols = BUCKETS.map((b) => pad(dash(r.buckets[b.key]), colW)).join("");
  console.log(`  ${flag} ${pad(fmt(r.billed), colW)}  ${pad(state, 8)}  ${velCols}  ${acctLabel(r)} — ${nm}${bd}`);
  console.log(`     ${" ".repeat(colW)}  ${" ".repeat(8)}  ${" ".repeat(colW * BUCKETS.length)}  ${r.root.slice(0, 8)}${r.branch ? "  @" + r.branch : ""}`);
  if (args.children && r.children.length) {
    for (const c of r.children.sort((a, b) => b.billed - a.billed).slice(0, 8)) {
      console.log(`        ↳ ${pad(fmt(c.billed), colW)}  ${c.kind}  ${c.file}`);
    }
  }
}
const totVel = BUCKETS.map((b) => pad(dash(totBuckets[b.key]), colW)).join("");
console.log(`  ${"─".repeat(30 + colW * BUCKETS.length)}`);
console.log(`     ${pad(fmt(totBilled), colW)}  ${pad("", 8)}  ${totVel}  ${ranked.length} roots · ${liveRoots.length} live · velocity = billed in last N`);

// ── cloud board ─────────────────────────────────────────────────────────────
if (args.cloud) {
  console.log(`\n  CLOUD — scheduled claude.ai routines (bursts, not continuous · no per-routine token count from the API)`);
  if (!cloud.length) {
    console.log(`     (none — RemoteTrigger list returned no routines)`);
  } else {
    for (const c of cloud) {
      const dot = c.enabled ? "●" : "○";
      const meta = [c.cron && `cron ${c.cron}`, c.model && c.model, c.repo].filter(Boolean).join("  ·  ");
      console.log(`  ${dot} ${c.name}`);
      console.log(`      next ${hhmm(c.nextRun)}  ·  fired ${c.firedAgoMin != null ? c.firedAgoMin + "m ago" : "never"}  ·  ${meta}`);
    }
    console.log(`  ${"─".repeat(52)}`);
    console.log(`     ${cloud.length} routines · ${cloudOn} enabled · ${cloud.length - cloudOn} off`);
  }
} else {
  console.log(`\n  CLOUD — not fetched. For the whole picture, pipe cloud in:`);
  console.log(`     RemoteTrigger list → save JSON → node maxx/agents.mjs --cloud <file>`);
}
console.log(`\n  billed counts cache reads (count toward quota); output = generated (the costly part).`);
console.log(`  velocity buckets are cumulative: "10s" = billed in the last 10 seconds, etc.\n`);
