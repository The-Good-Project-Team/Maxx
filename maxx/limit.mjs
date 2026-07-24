#!/usr/bin/env node
/**
 * maxx rate-limit watchdog — the solo wall that actually hurts.
 *
 * Claude's plan limits are ~5-hour rolling windows. This sums your token usage in
 * the last 5h across ALL sessions, measures your burn rate, and calibrates the cap
 * from YOUR OWN history (the biggest 5h window you've ever sustained ≈ your real
 * ceiling — where you got throttled). No opaque published number, no guess.
 *
 *   node limit.mjs            # write ~/.maxx/window.json (the cache the bar reads)
 *   node limit.mjs --json     # print the report
 *
 * Usage/timing metadata only.
 */
import { createReadStream, writeFileSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
// Per-login session scope: a CLAUDE_CONFIG_DIR session scans ITS OWN projects dir,
// keys identity off ITS OWN .claude.json, and gets its own copies of the derived
// caches (name suffix, e.g. window-gmail.json) — two logins rendering concurrently
// must never fight over one file. Fleet-shared files (config, accounts) stay plain.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const OAUTH = path.join(process.env.CLAUDE_CONFIG_DIR || HOME, ".claude.json");
const SUF = process.env.CLAUDE_CONFIG_DIR ? "-" + path.basename(CLAUDE_DIR).replace(/^\.claude-?/, "") : "";
const PROJECTS = path.join(CLAUDE_DIR, "projects");
const OUT = path.join(HOME, ".maxx", `window${SUF}.json`);
const CONFIG = path.join(HOME, ".maxx", "config.json");
const RL = path.join(HOME, ".maxx", `rl${SUF}.json`);   // render drops the live %s here to anchor caps
const LIMITHIT = path.join(HOME, ".maxx", `limit-hit${SUF}.json`); // newest "hit your weekly limit" banner seen in transcripts
const CURSOR = path.join(HOME, ".maxx", `scan${SUF}.json`); // per-file byte offsets for the incremental tail
const ACCOUNTS = path.join(HOME, ".maxx", "accounts.json"); // which Claude account owns which slice of the local logs
const WINDOW_MS = 5 * 60 * 60 * 1000;     // Claude's ~5-hour limit window
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;  // the 7-day wall
// Coin model (mirrors server/tally.mjs): a fixed self-set tank, not a cap inferred from
// Anthropic's opaque %. cap = weekly tank (COINS_MAX); the 5h bar paces an even share of
// it. The statusline and the budget gate compute from the SAME constant, so they agree.
const COINS_MAX = 1e9;
const COINS_FIVE = Math.round((COINS_MAX * WINDOW_MS) / WEEK_MS); // ≈ 29.76M / 5h window
const BUCKET_MS = 30 * 1000;              // 30-sec buckets: fine enough that the momentum + recovery step every ~30s, still cheap to re-sum every render tick

async function files(dir) {
  const out = [];
  async function walk(d) {
    let es; try { es = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(f);
    }
  }
  await walk(dir);
  return out;
}

// one transcript line → [ts, weightedTokens] or null. weight by quota pressure, using price
// as the proxy (per-token: cache-reads ~0.1x, cache-writes 1.25x, output 5x input; per-model:
// Sonnet=1, Haiku 1/3, Opus 5/3, Fable 10/3). A Haiku subagent token drains ~1/10 the quota of
// a Fable token — unweighted they'd look the same. The cap anchor (cap = burned / used%) still
// absorbs any residual price→quota mapping error. Shared by full scan and incremental tail.
// live weights from ~/.maxx/prices.json (refreshed daily by prices.mjs); built-ins as fallback
const PRICE_W = (() => {
  const fallback = { fable: 10 / 3, mythos: 10 / 3, opus: 5 / 3, sonnet: 1, haiku: 1 / 3 };
  try {
    const p = JSON.parse(readFileSync(path.join(homedir(), ".maxx", "prices.json"), "utf8"));
    return { ...fallback, ...p.weights };
  } catch { return fallback; }
})();
const modelWeight = m => {
  for (const fam in PRICE_W) if (m.includes(fam)) return PRICE_W[fam];
  return PRICE_W.sonnet;   // unknown/synthetic → baseline
};
// One request's usage → weighted tokens. Exported so the statusline can price a
// single turn with the SAME formula the scanner uses, instead of a second copy of
// the weights drifting out of sync with this one.
export function weighUsage(u, model = "") {
  if (!u) return 0;
  return ((u.input_tokens || 0) + (u.output_tokens || 0) * 5
        + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1)
        * modelWeight(model);
}
// weekly-limit banner → epoch seconds of its "resets 7pm (America/Chicago)" clause. The banner is
// ground truth the rate_limits payload can contradict (seen live: payload 55% while /usage read 100%
// and cloud tasks were hard-blocked) — so the reset time must come from the banner itself.
// Handles "resets 7pm (TZ)" and "resets Jul 23 at 7pm (TZ)". Unparseable → banner ts + 24h.
export function parseResetAt(text, atMs) {
  const m = /resets\s+(?:[A-Z][a-z]{2}\s+\d{1,2}\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text || "");
  if (!m) return Math.round(atMs / 1000) + 24 * 3600;
  const [, hh, mm, ap, tz] = m;
  const h = (+hh % 12) + (ap.toLowerCase() === "pm" ? 12 : 0), min = +(mm || 0);
  try {
    // tz offset at atMs via Intl round-trip (minute precision; ≤1h off across a DST flip — acceptable)
    const off = new Date(new Date(atMs).toLocaleString("en-US", { timeZone: tz })).getTime() - atMs;
    const local = new Date(atMs + off);
    local.setHours(h, min, 0, 0);
    while (local.getTime() - off <= atMs) local.setDate(local.getDate() + 1); // next occurrence after the banner
    return Math.round((local.getTime() - off) / 1000);
  } catch { return Math.round(atMs / 1000) + 24 * 3600; }
}
let limitHit = null; // newest banner seen this scan; persisted by persistLimitHit()
function noteLimitHit(r) {
  // ONLY the harness's own synthetic banner counts — an ordinary assistant message QUOTING the
  // phrase (seen live: an analysis session discussing the banner) must never pin an account to 100%.
  if (r?.message?.model !== "<synthetic>") return;
  const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
  if (!Number.isFinite(ts) || (limitHit && ts <= limitHit.at)) return;
  const text = (Array.isArray(r.message?.content) ? r.message.content : []).map(c => c.text || "").join(" ");
  limitHit = { at: ts, resetAt: parseResetAt(text, ts) };
}
function persistLimitHit() {
  if (!limitHit) return;
  const prev = readJSON(LIMITHIT, null);
  if (!prev || limitHit.at > prev.at) { try { writeFileSync(LIMITHIT, JSON.stringify(limitHit)); } catch {} }
}
// if an unexpired banner exists, it beats the payload: week pinned to 100%, reset to the banner's.
function limitHitOverride(week, weekResetAt, now) {
  const h = readJSON(LIMITHIT, null);
  if (h && h.resetAt * 1000 > now && h.at <= now) return { week: 1, weekResetAt: h.resetAt };
  return { week, weekResetAt };
}
function parseLine(line, seen) {
  if (!line || line[0] !== "{") return null;
  let r; try { r = JSON.parse(line); } catch { return null; }
  if (line.includes("hit your weekly limit")) noteLimitHit(r);
  const u = r?.message?.usage; if (!u) return null;
  const tok = weighUsage(u, r?.message?.model || "");
  if (!tok) return null;
  const id = r.requestId || r.uuid; if (id && seen) { if (seen.has(id)) return null; seen.add(id); }
  const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(ts) ? [ts, tok] : null;
}

// collect (ts, tokens) for every billed turn across all sessions — the authoritative full scan.
async function collect() {
  const pts = [];
  const seen = new Set();
  for (const f of await files(PROJECTS)) {
    let rl;
    try { rl = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity }); }
    catch { continue; }
    for await (const line of rl) { const p = parseLine(line, seen); if (p) pts.push(p); }
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}

// the incremental tail: read only bytes appended since the last run (per-file byte offsets in
// scan.json). Only the active session file grows, so a refresh reads a few KB, not 11B tokens.
// Returns { pts, offsets } — pts are the new turns since last scan. Partial trailing line (a
// half-written record) is left unconsumed; its offset stays put so next run picks it up whole.
async function collectIncremental(offsets) {
  const pts = [];
  const newOff = { ...offsets };
  const seen = new Set();
  for (const f of await files(PROJECTS)) {
    let size; try { size = statSync(f).size; } catch { continue; }
    let off = offsets[f] || 0;
    if (off > size) off = 0;                 // truncated / rotated → reread whole
    if (off === size) { newOff[f] = size; continue; }
    const len = size - off;
    const buf = Buffer.allocUnsafe(len);
    let fd, got = 0;
    try { fd = openSync(f, "r"); got = readSync(fd, buf, 0, len, off); } catch { continue; }
    finally { if (fd !== undefined) closeSync(fd); }
    const chunk = buf.toString("utf8", 0, got);
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) { newOff[f] = off; continue; }          // no complete line yet
    const complete = chunk.slice(0, lastNl);
    newOff[f] = off + Buffer.byteLength(complete, "utf8") + 1; // advance past the last newline
    for (const line of complete.split("\n")) { const p = parseLine(line, seen); if (p) pts.push(p); }
  }
  return { pts, offsets: newOff };
}

// merge new (ts, tok) points into an existing bucket array, re-binning and dropping >7d buckets.
function mergeBuckets(base, pts, now) {
  const cutoff = now - WEEK_MS;
  const m = new Map();
  for (const [t, k] of base) if (t > cutoff) m.set(t, k);
  for (const [ts, tok] of pts) {
    if (ts <= cutoff) continue;
    const b = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    m.set(b, (m.get(b) || 0) + tok);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, k]) => [t, Math.round(k)]);
}

function readJSON(p, d) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } }

// biggest token sum over any `win`-ms span in history = your sustained ceiling
function historicalPeak(pts, win = WINDOW_MS) {
  let peak = 0, sum = 0, i = 0;
  for (let j = 0; j < pts.length; j++) {
    sum += pts[j][1];
    while (pts[i][0] < pts[j][0] - win) { sum -= pts[i][1]; i++; }
    if (sum > peak) peak = sum;
  }
  return peak;
}

// ACCOUNT EPOCH — rate limits are per Claude ACCOUNT, but the local logs are per MACHINE. After an
// account switch the old account's burn still sits inside the current 5h/7d spans, so summing blindly
// anchors caps against a % the burn never counted toward (seen live: cap7 ballooned to 1.27B = 1.23B
// old-account tokens ÷ the new account's 1%). Fix: track the signed-in account (~/.claude.json
// oauthAccount) in a ledger and only count buckets since the current account was first seen here.
// Re-entering a previously seen account also restamps `from` — interleaved foreign burn would corrupt
// its windows anyway, and rate-limit windows are ≤7d so history past the switch has no budget value.
export function accountEpoch(now) {
  let uuid = null, email = null;
  try {
    const oa = JSON.parse(readFileSync(OAUTH, "utf8")).oauthAccount || {};
    uuid = oa.accountUuid || null; email = oa.emailAddress || null;
  } catch {}
  if (!uuid) return { uuid: null, since: 0 }; // can't tell → no clamp (pre-switch behavior)
  let led = readJSON(ACCOUNTS, {});
  if (!Array.isArray(led.accounts)) led = { accounts: [] };
  led.dirs = led.dirs || {};
  let e = led.accounts.find((a) => a.uuid === uuid);
  // The switch that poisons windows is a login change WITHIN one dir (its logs then
  // interleave two accounts). Track current per CONFIG DIR: two logins running
  // concurrently in separate dirs are both stably "current" in their own dir —
  // the old global `current` flapped on every alternating render and restamped
  // `from` to now, collapsing both accounts' windows to zero.
  if (!e || led.dirs[CLAUDE_DIR] !== uuid) {
    if (e && led.dirs[CLAUDE_DIR] && led.dirs[CLAUDE_DIR] !== uuid) e.from = now;
    else if (!e) { e = { uuid, email, from: now }; led.accounts.push(e); }
    led.dirs[CLAUDE_DIR] = uuid;
    led.current = uuid; // legacy readers; last-active, no longer drives restamps
    try { mkdirSync(path.dirname(ACCOUNTS), { recursive: true }); writeFileSync(ACCOUNTS, JSON.stringify(led)); } catch {}
  }
  return { uuid, since: e.from };
}

// ROLL-SESSION — the safe spend for THIS 5h window = weekly-tokens-LEFT ÷ 5h-windows-left, capped at the
// raw 5h wall. THIS is the number a governor gates on: cap an unattended/overnight agent to its sustainable
// per-window share and the week never drains in one burst — yet it can still run all night, and if it banks
// (underspends a window) the share climbs so it can burst later. Everything anchored to Anthropic's %s.
export function rollSession(cap5, cap7, used5, weekUsed, weekResetAt, now) {
  const weekLeftSec = weekResetAt ? Math.max(0, weekResetAt - now / 1000) : 0;
  const sessionsLeft = Math.max(1, weekLeftSec / (5 * 3600));         // 5h windows until the weekly resets
  const weekLeft = Math.max(0, (cap7 || 0) - weekUsed);
  const safe = (cap7 && weekResetAt) ? Math.min(cap5 || Infinity, Math.round(weekLeft / sessionsLeft)) : (cap5 || 0);
  return {
    sessionSafe: safe,                                 // tokens good to use this 5h window
    sessionToSpend: Math.max(0, safe - used5),         // headroom left this window (0 → governor should pause)
    sessionOver: Math.max(0, used5 - safe),            // spent past the safe share (governor blocks when > 0)
    sessionsLeft: Math.round(sessionsLeft * 10) / 10,
  };
}

function report(pts, now, weekLo = now - WEEK_MS, quota = 0, week = 0, weekResetAt = 0) {
  const used = pts.filter(([t]) => t > now - WINDOW_MS).reduce((a, [, k]) => a + k, 0);
  // burn = tokens in the last 30 min, extrapolated to /hr
  const recent = pts.filter(([t]) => t > now - 30 * 60000).reduce((a, [, k]) => a + k, 0);
  const burnPerHr = recent * 2;
  const peak = historicalPeak(pts);
  // 5h bar: a fixed even-pace share of the coin tank (COINS_FIVE), not a cap inferred from
  // the /usage %. pct = coins used this window ÷ that share. (Anthropic's real 5h % is still
  // read as `quota` for the safety-wall display; it no longer sizes the cap.)
  const cap = COINS_FIVE;
  const pct = Math.min(1, used / cap);
  const minsToCap = (cap && burnPerHr > 0 && used < cap) ? Math.round((cap - used) / burnPerHr * 60) : null;
  // window reset: when the oldest token in the window ages out
  const inWin = pts.filter(([t]) => t > now - WINDOW_MS);
  const resetInMins = inWin.length ? Math.max(0, Math.round((inWin[0][0] + WINDOW_MS - now) / 60000)) : 0;
  // weekly limit — the other Claude plan wall. Anthropic's is a FIXED window that zeroes at resets_at, not a
  // rolling sum, so cut at the window start (weekLo = resets_at − 7d). Cap ANCHORED to Anthropic's 7d %:
  // weekCap = used ÷ realPct, weekPct = the real %. Consumers MUST gate on weekPct / sessionOver — NEVER a
  // raw bucket sum ÷ a hardcoded cap (that read 760M ÷ 750M = 101% and false-blocked at a real 37%).
  const weekUsed = pts.filter(([t]) => t > weekLo).reduce((a, [, k]) => a + k, 0);
  // Weekly tank is the fixed COINS_MAX, same for every account — the standing that made the
  // two-account comparison sane and killed the low-% cap blow-up. weekPct = coins ÷ tank.
  const weekCap = COINS_MAX;
  const weekPct = Math.min(1, weekUsed / weekCap);
  const roll = rollSession(cap, weekCap, used, weekUsed, weekResetAt, now);
  return { used, cap, peak, pct, burnPerHr, minsToCap, resetInMins, weekUsed, weekCap, weekPct, weekResetAt, ...roll, ts: now };
}

// bucket the last 7d of (ts, tokens) into 5-min bins so the renderer can re-sum the rolling
// window against the live clock each tick — that's what makes "idle → the bar recovers" real.
function bucketize(pts, now) {
  const cutoff = now - WEEK_MS, m = new Map();
  for (const [ts, tok] of pts) {
    if (ts <= cutoff) continue;
    const b = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    m.set(b, (m.get(b) || 0) + tok);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, k]) => [t, Math.round(k)]);
}

// ─── --nazi: an hourly posture check an AGENT runs on itself ──────────────────────────────────────
// Reads what maxx already knows — status.json (ctx/cache/model/sessions), window.json (roll-session +
// weekPct + burn history), CLAUDE.md sizes (the always-on context tax) — and returns ranked token
// drains + the one highest-leverage lever for this hour. Machine `NAZI …` first line for grepping.
function fileTok(p) { try { return Math.round(readFileSync(p, "utf8").length / 4); } catch { return 0; } }
function nazi(wantJSON) {
  const num = (x) => Math.round(x || 0).toLocaleString("en-US");
  const tk = (x) => Math.round(Math.abs(x || 0) / 1000).toLocaleString("en-US") + "k";
  const st = readJSON(path.join(HOME, ".maxx", `status${SUF}.json`), null);
  if (!st) {
    const msg = "token nazi — no status yet. Open Claude Code so the statusline writes ~/.maxx/status.json, then retry.";
    process.stdout.write((wantJSON ? JSON.stringify({ error: "no-status" }) : msg) + "\n"); return;
  }
  const S = st.session || {}, W = st.weekly || {};
  const win = readJSON(OUT, null);
  let burn1h = 0, burn6h = 0, burnPrev1h = 0;
  if (win && Array.isArray(win.buckets)) {
    const n0 = Date.now(), sum = (lo, hi) => win.buckets.reduce((s, b) => (b[0] > n0 - hi && b[0] <= n0 - lo ? s + b[1] : s), 0);
    burn1h = sum(0, 3600e3); burnPrev1h = sum(3600e3, 7200e3); burn6h = sum(0, 6 * 3600e3);
  }
  const trend = burn1h > burnPrev1h * 1.25 ? "rising" : burn1h < burnPrev1h * 0.75 ? "cooling" : "steady";
  const cwd = process.cwd();
  const mdFiles = [
    ["global CLAUDE.md", path.join(HOME, ".claude", "CLAUDE.md")],
    ["global RTK.md", path.join(HOME, ".claude", "RTK.md")],
    ["repo CLAUDE.md", path.join(cwd, "CLAUDE.md")],
  ].map(([label, p]) => ({ label, tok: fileTok(p) })).filter((f) => f.tok > 0);
  const claudeMdTok = mdFiles.reduce((s, f) => s + f.tok, 0);
  const ctxPct = st.ctxPct || 0, cachePct = st.cachePct ?? 100, sessions = st.sessions || 1, model = st.model || "?";
  const sessOver = (S.over || 0) > 0;
  const weekHot = (W.usedPct || 0) > (W.elapsedPct || 0) + 5 && (W.usedPct || 0) >= 50;
  const verdict = sessOver || (W.usedPct || 0) >= 90 ? "over" : weekHot || (S.usedPct || 0) >= 90 ? "hot" : "ok";
  const drains = [];
  if (model === "Opus") drains.push({ sink: "model", detail: "Opus burns the quota fastest", lever: "drop to Sonnet for routine work (one keystroke)", weight: sessOver || weekHot ? 90 : 55 });
  if (sessions > 1) drains.push({ sink: "sessions", detail: `${sessions} sessions burning in parallel → ~${sessions}× the rate`, lever: `close the ${sessions - 1} you're not driving`, weight: 40 + sessions * 12 });
  if (cachePct < 85) drains.push({ sink: "cache", detail: `cache ${cachePct}% — misses pay full freight`, lever: "stop rewriting early context; append instead of editing history", weight: cachePct < 60 ? 80 : 45 });
  if (ctxPct >= 65) drains.push({ sink: "context", detail: `context ${ctxPct}% full — every turn re-sends it all`, lever: "commit at a clean stop, then /compact", weight: ctxPct >= 85 ? 85 : 50 });
  if (claudeMdTok >= 4000) drains.push({ sink: "claude.md", detail: `~${tk(claudeMdTok)} tokens of CLAUDE.md loaded EVERY message`, lever: "trim/compress the global + repo instructions", weight: 30 + Math.min(30, claudeMdTok / 400) });
  if (trend === "rising") drains.push({ sink: "trend", detail: `burn rising — ${tk(burn1h)}/hr vs ${tk(burnPrev1h)}/hr prior`, lever: "you're accelerating; ease off or you'll hit the wall early", weight: 60 });
  drains.sort((a, b) => b.weight - a.weight);
  const topMove = drains[0]?.lever || (verdict === "ok" ? "on track — keep shipping the smallest thing that works" : "wrap up cleanly before the wall");
  const machine = `NAZI verdict=${verdict} weekly_left=${W.headroom || 0} weekly_pct=${W.usedPct || 0} session_tospend=${S.toSpend || 0} session_permin=${S.spendPerMin || 0} ctx_pct=${ctxPct} cache_pct=${cachePct} claudemd_tok=${claudeMdTok} sessions=${sessions} model=${model} burn_1h=${Math.round(burn1h)} burn_6h=${Math.round(burn6h)} trend=${trend} top_lever="${topMove}"`;
  if (wantJSON) {
    process.stdout.write(JSON.stringify({
      verdict, weekly: { left: W.headroom || 0, usedPct: W.usedPct || 0, resetIn: W.resetIn || "?" },
      session: { name: "session", fuel: S.toSpend || 0, perMin: S.spendPerMin || 0, over: S.over || 0, resetIn: S.resetIn || "?" },
      burn: { last1h: Math.round(burn1h), last6h: Math.round(burn6h), trend },
      context: { ctxPct, cachePct, claudeMdTok, claudeMdFiles: mdFiles }, sessions, model, drains, topMove,
    }, null, 2) + "\n"); return;
  }
  const L = [machine, "", `token nazi — hourly posture  ·  verdict: ${verdict.toUpperCase()}`, "",
    `  week          ${num(W.headroom)} left  ·  ${W.usedPct || 0}% used  ·  resets ${W.resetIn || "?"}`,
    sessOver ? `  session       ${num(S.over)} over your paced share  ·  ease off — future windows recover it  ·  ${S.resetIn || "?"}`
             : `  session       ${num(S.toSpend)} safe to spend  ·  weekly-paced, capped at the 5h wall  ·  ${S.resetIn || "?"}`,
    `  burn          ${tk(burn1h)}/hr now  ·  ${tk(burn6h)} last 6h  ·  ${trend}`, ""];
  if (drains.length) { L.push("  biggest drains (highest leverage first):"); for (const d of drains) L.push(`    · ${d.sink.padEnd(9)} ${d.detail}  →  ${d.lever}`); }
  else L.push("  no standout drains — cache warm, context light, single session.");
  L.push("", `  do this hour →  ${topMove}`);
  process.stdout.write(L.join("\n") + "\n");
}

async function main() {
  const now = Date.now();
  if (process.argv.includes("--nazi")) { nazi(process.argv.includes("--json")); return; }
  // anchor the token caps to Claude's authoritative %s (render drops them in rl.json): with
  // cap = burned / used%, the token gauge reads exactly the real % — weighting quirks cancel.
  // anchors read AFTER the scan below: a weekly-limit banner discovered in this very scan must
  // override this same run, not the next one.
  const acct = accountEpoch(now);
  const anchors = () => {
    let quota = 0, week = 0, weekResetAt = 0;
    try { const rl = JSON.parse(readFileSync(RL, "utf8")); quota = rl.quota || 0; week = rl.week || 0; weekResetAt = rl.weekResetAt || 0; } catch {}
    ({ week, weekResetAt } = limitHitOverride(week, weekResetAt, now));
    // weekly window start = Anthropic's reset − 7d; max() never loosens past the rolling 7d, so a
    // stale/absent resets_at just falls back to the old behavior. Both lows also clamp to the current
    // account's epoch — burn charged to a previous account never counts against this one's walls.
    const weekLo = Math.max(now - WEEK_MS, weekResetAt ? weekResetAt * 1000 - WEEK_MS : 0, acct.since);
    return { quota, week, weekResetAt, weekLo };
  };
  const fiveLo = Math.max(now - WINDOW_MS, acct.since);

  // --json prints the full report (authoritative scan); other invocations refresh window.json.
  if (process.argv.includes("--json")) {
    const pts = (await collect()).filter(([t]) => t > acct.since);
    persistLimitHit();
    const { quota, week, weekResetAt, weekLo } = anchors();
    const r = report(pts, now, weekLo, quota, week, weekResetAt);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const cursor = readJSON(CURSOR, null);
  const forceFull = process.argv.includes("--full");
  let buckets, offsets;
  if (forceFull || !cursor) {
    // seed (first run) or periodic reconcile: authoritative full scan, then snapshot offsets so
    // subsequent runs only tail the growth.
    const pts = await collect();
    buckets = bucketize(pts, now);
    offsets = {};
    for (const f of await files(PROJECTS)) { try { offsets[f] = statSync(f).size; } catch {} }
  } else {
    // hot path: tail only appended bytes and fold them into the cached buckets.
    const prev = readJSON(OUT, {});
    const { pts, offsets: off } = await collectIncremental(cursor.offsets || {});
    buckets = mergeBuckets(prev.buckets || [], pts, now);
    offsets = off;
  }
  persistLimitHit();
  const { quota, week, weekResetAt, weekLo } = anchors();

  // re-anchor caps against the freshly-summed window each run (quota comes from the live bar).
  // Held-over caps from a DIFFERENT account are poison (anchored to that account's %s) — drop them.
  const prev = readJSON(OUT, {});
  const prevOk = !acct.uuid || prev.accountUuid === acct.uuid;
  let used = 0, weekUsed = 0;
  for (const [t, k] of buckets) { if (t > fiveLo) used += k; if (t > weekLo) weekUsed += k; }
  // a held cap below what's already used is nonsense (seen: a cold-start run pinned cap7=1 and the
  // gate read toSpend 0 forever) — treat it as absent so the fallback re-derives a sane magnitude.
  const prev5 = prevOk && prev.cap5 >= used ? prev.cap5 : 0;
  const prev7 = prevOk && prev.cap7 >= weekUsed ? prev.cap7 : 0;
  // anchor floors: >0.005 accepts a 1% wall reading — right after an account switch that's the only
  // anchor there is, and holding a *1.05 guess instead reads "week nearly gone" on a fresh account.
  const cap5 = quota > 0.005 ? Math.round(used / quota) : (prev5 || Math.round(used * 1.05) || 1);
  const cap7 = week  > 0.005 ? Math.round(weekUsed / week) : (prev7 || Math.round(weekUsed * 1.05) || 1);
  // the roll-session gate, written into the cache so a governor reads the SAFE per-window spend directly —
  // no re-summing raw buckets, no hardcoded cap. Gate on sessionOver > 0 (or sessionToSpend === 0) to pause
  // an unattended agent until the 5h window resets; weekPct is the authoritative weekly % (= /usage).
  const roll = rollSession(cap5, cap7, used, weekUsed, weekResetAt, now);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ buckets, cap5, cap7, used5: used, weekUsed, weekPct: week, weekResetAt, accountUuid: acct.uuid, accountSince: acct.since, ...roll, ts: now }));
  writeFileSync(CURSOR, JSON.stringify({ offsets, ts: now }));
}
// run only when invoked directly (CLI / statusline), not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith("limit.mjs")) {
  main().catch(e => { process.stderr.write("limit: " + e.message + "\n"); process.exit(1); });
}
