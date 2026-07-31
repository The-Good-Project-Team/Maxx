#!/usr/bin/env node
/**
 * maxx statusline renderer — the LOOK, in Node (no binary, no build step).
 *
 * Reads Claude Code's stdin JSON (rate_limits.five_hour/seven_day = the real
 * session/weekly walls, same numbers as /usage) + ~/.maxx/state.json the brain
 * writes (advice / intent / presence), then paints a clean two-pane cockpit:
 * quota + model on the left, a coach thought on the right, presence at the edges.
 *
 * Ships as plain Node because the rest of maxx already needs Node (the /maxx skill
 * and the coach hook) — nothing extra to install, nothing to compile. A tiny ANSI
 * compositor stands in for lipgloss.
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { weekPaceToken, plausibleReset } from "./pace.mjs";
import { weighUsage, COINS_MAX, COINS_FIVE } from "./limit.mjs";

// ─── color: one HSL→hex + an rgb→hsl round-trip for shading ────────────────────
function hsl2hex(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const k = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p; };
    r = k(h + 1 / 3); g = k(h); b = k(h - 1 / 3);
  }
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
const hsl = hsl2hex;
// theme: `/maxx dark` / `/maxx light` writes cfg.theme — an explicit override that pins
// maxx's own purple palette. With no override (`/maxx auto`) the bar matches the terminal
// it lives in: the ghostty theme's actual colors when detectable (background/foreground/
// ANSI palette), else the host CLI's light/dark from its own .claude.json (default
// ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json — the statusline inherits the env),
// so two logins side by side each match their window.
const CFG_THEME = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".maxx", "config.json"), "utf8")).theme; } catch { return undefined; } })();
const CLI_DARK = (() => {
  try {
    const state = process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
      : path.join(homedir(), ".claude.json");
    return String(JSON.parse(readFileSync(state, "utf8")).theme || "").startsWith("dark");
  } catch { return false; }
})();
let DARK = CFG_THEME === "dark" || (CFG_THEME !== "light" && CLI_DARK);
const T = (light, dark) => (DARK ? dark : light);
let BG     = T(hsl(265, 0.62, 0.91), hsl(265, 0.32, 0.15)); // panel — baby purple / deep plum
let INK    = T(hsl(266, 0.46, 0.26), hsl(266, 0.55, 0.88)); // primary text
let DIM    = T(hsl(266, 0.24, 0.52), hsl(266, 0.20, 0.63)); // muted secondary text
let BRAND  = T(hsl(264, 0.66, 0.54), hsl(264, 0.75, 0.70)); // vivid periwinkle accent
let BORDER = T(hsl(266, 0.36, 0.66), hsl(266, 0.26, 0.42)); // meter caps / soft frame
let TRACK  = T(hsl(266, 0.42, 0.82), hsl(266, 0.32, 0.23)); // the meter's unlit groove — a shade off the panel bg
let GREEN  = T(hsl(150, 0.48, 0.37), hsl(150, 0.45, 0.48)); // sage = safe (dark spent fill; glint + cushion read off it)
let AMBER  = T(hsl(38, 0.66, 0.53),  hsl(38, 0.72, 0.58));  // amber = elevated
let RED    = T(hsl(354, 0.50, 0.58), hsl(354, 0.62, 0.64)); // rose = danger
let START  = T(hsl(266, 0.40, 0.44), hsl(266, 0.38, 0.62)); // the start post (0)
let WALL   = T(hsl(352, 0.62, 0.30), hsl(352, 0.68, 0.56)); // the finish post = the limit (reads past the overshoot)

// ─── terminal-match (the `auto` default): adopt the ghostty theme's own colors ─
// Panel = the theme's background tinted toward its blue accent; text = its foreground;
// safe/elevated/danger = its ANSI green/yellow-orange/red (bright variants on dark).
(() => {
  if (CFG_THEME === "dark" || CFG_THEME === "light") return; // explicit override wins
  if (process.env.TERM_PROGRAM !== "ghostty" && !process.env.GHOSTTY_RESOURCES_DIR) return;
  const hexrgb = (h) => { h = h.replace("#", ""); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const blend = (a, b, t) => { const A = hexrgb(a), B = hexrgb(b); return "#" + [0, 1, 2].map((i) => Math.round(A[i] + (B[i] - A[i]) * t).toString(16).padStart(2, "0")).join(""); };
  const lum = (c) => { const [r, g, b] = hexrgb(c); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  const parse = (txt, out) => {
    for (const raw of txt.split("\n")) {
      const m = raw.trim().match(/^([a-z-]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      if (k === "theme") out.theme = v;
      else if (k === "background" || k === "foreground") { if (/^#?[0-9a-fA-F]{6}$/.test(v)) out[k] = v.startsWith("#") ? v : "#" + v; }
      else if (k === "palette") { const p = v.match(/^(\d+)\s*=\s*#?([0-9a-fA-F]{6})$/); if (p) out.palette[+p[1]] = "#" + p[2]; }
    }
  };
  const cfgDir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "ghostty");
  const user = { palette: {} };
  try { parse(readFileSync(path.join(cfgDir, "config"), "utf8"), user); } catch {}
  let name = user.theme || "";
  if (name.includes(":")) { // theme = light:A,dark:B — take the host CLI's side
    const side = Object.fromEntries(name.split(",").map((s) => s.split(":").map((x) => x.trim())));
    name = (CLI_DARK ? side.dark : side.light) || "";
  }
  const themed = { palette: {} };
  for (const dir of [path.join(cfgDir, "themes"), process.env.GHOSTTY_RESOURCES_DIR && path.join(process.env.GHOSTTY_RESOURCES_DIR, "themes"), "/Applications/Ghostty.app/Contents/Resources/ghostty/themes"].filter(Boolean)) {
    if (!name) break;
    try { parse(readFileSync(path.join(dir, name), "utf8"), themed); break; } catch {}
  }
  const bg = user.background || themed.background, fg = user.foreground || themed.foreground;
  if (!bg || !fg) return; // no resolvable colors — keep the CLI light/dark palette
  const pal = { ...themed.palette, ...user.palette };
  DARK = lum(bg) < 0.5;
  const t = (l, d) => (DARK ? d : l);
  BRAND  = pal[t(4, 12)] || pal[4] || BRAND;                 // the theme's blue accent
  BG     = blend(bg, BRAND, t(0.12, 0.16));                  // panel — bg tinted toward the accent
  INK    = fg;
  DIM    = blend(fg, bg, 0.38);
  BORDER = blend(fg, bg, 0.58);
  TRACK  = blend(BG, fg, 0.13);
  GREEN  = pal[t(2, 10)] || GREEN;
  AMBER  = pal[t(3, 11)] || AMBER;
  RED    = pal[t(1, 9)]  || RED;
  START  = blend(BRAND, t("#000000", "#ffffff"), 0.25);
  WALL   = blend(RED,   t("#000000", "#ffffff"), t(0.4, 0.12));
})();

// ─── ANSI: every glyph carries the panel bg so the band stays unbroken ─────────
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// blend hex toward a target (default white) by t∈[0,1] — used to shade the meter fill so it
// reads as a rounded tube (lit through the middle) instead of a flat slab.
function mix(hex, t, target = "#ffffff") {
  const a = rgb(hex), b = rgb(target);
  return "#" + [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t).toString(16).padStart(2, "0")).join("");
}
// intensity shade along a fill: frac 0 = lightest (near white), 0.5 = the base color, 1 = darkest (near
// black). Lets a bar deepen from its base toward its leading edge, so more fill reads as more intense.
function shade(hex, frac) {
  frac = Math.max(0, Math.min(1, frac));
  return frac < 0.5 ? mix(hex, (0.5 - frac) * 0.7, "#ffffff") : mix(hex, (frac - 0.5) * 0.2, "#000000");
}
// Apple's Terminal.app has no 24-bit color (verified on Sequoia: 38;2 renders as black/garbage,
// even though shells there often export COLORTERM=truecolor). Downconvert to the xterm-256 cube
// for it; every other mainstream terminal (iTerm2/Ghostty/Warp/Alacritty/kitty/VS Code) gets 24-bit.
const USE_256 = process.env.TERM_PROGRAM === "Apple_Terminal";
function to256([r, g, b]) {
  // grayscale ramp (232-255) when the channels are close — keeps the lilac track from banding weirdly
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) {
    const v = Math.round((r + g + b) / 3);
    if (v < 8) return 16;
    if (v > 238) return 231;
    return 232 + Math.round((v - 8) / 10);
  }
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
const sgrFg = (c) => (USE_256 ? `38;5;${to256(c)}` : `38;2;${c[0]};${c[1]};${c[2]}`);
const sgrBg = (c) => (USE_256 ? `48;5;${to256(c)}` : `48;2;${c[0]};${c[1]};${c[2]}`);
function esc(fgHex, bgHex, s) {
  return `\x1b[${sgrFg(rgb(fgHex))};${sgrBg(rgb(bgHex))}m${s}\x1b[0m`;
}
const fg = (c, s) => esc(c, BG, s);
// italic variant (adds SGR 3) — for the calm coach line; degrades gracefully if unsupported
function ital(fgHex, s) {
  return `\x1b[3;${sgrFg(rgb(fgHex))};${sgrBg(rgb(BG))}m${s}\x1b[0m`;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
// OSC 8 hyperlink — supported terminals make the text clickable, the rest render it as plain text
const link = (url, s) => `\x1b]8;;${url}\x1b\\${s}\x1b]8;;\x1b\\`;
const dispWidth = (s) => [...stripAnsi(s)].length;
function trunc(s, w) {
  const r = [...s];
  if (r.length <= w) return s;
  if (w < 1) return "…";
  return r.slice(0, w - 1).join("") + "…";
}
const blank = (w) => fg(BG, " ".repeat(Math.max(0, w)));
function padLine(s, w, align = "left") {
  const extra = w - dispWidth(s);
  if (extra <= 0) return s;
  if (align === "right") return blank(extra) + s;
  if (align === "center") { const l = Math.floor(extra / 2); return blank(l) + s + blank(extra - l); }
  return s + blank(extra);
}

function resetIn(ts) {
  if (!ts || ts <= 0) return "";
  const d = ts - Date.now() / 1000;
  if (d <= 0) return "now";
  if (d >= 86400) return `${Math.floor(d / 86400)}d`;
  const h = Math.floor(d / 3600);
  if (h > 0) return `${h}h${Math.floor((d % 3600) / 60)}m`;
  return `${Math.floor(d / 60)}m`;
}

// pace: is a wall headed for a lockout, and how bad? You're ahead exactly when %used runs
// past %elapsed (fixed window: resets_at = block start + winSec). This just judges hot +
// severity + how long a catch-up break would be; the actual human MOVE (switch model, close
// spare sessions, warm the cache, take that break) is chosen by the renderer, which can see
// what you're actually doing. 2pt margin so it doesn't flap near even.
function paceOf(rl, winSec, usedFrac) {
  if (!rl || !rl.resets_at) return { ok: false, hot: false };
  const remain = rl.resets_at - Date.now() / 1000;
  const used = usedFrac * 100;
  const elapsed = (100 * (winSec - remain)) / winSec;
  if (elapsed < 1 || used < 2 || remain <= 0) return { ok: true, hot: false }; // too early / idle
  if (used <= elapsed + 2) return { ok: true, hot: false };                    // on pace / banking
  const col = used >= 90 || used >= 2 * elapsed ? RED : AMBER;
  const breakMin = Math.round(((used - elapsed) / 100) * winSec / 60);         // pause this long → clock catches up
  return { ok: true, hot: true, col, breakMin };
}

// fine token count for the live deltas (cushion/over, momentum): always in thousands with comma
// grouping, so you watch usage tick by the thousand at every scale — 56k, 112k, 4,112k, 129,148k.
function tkf(n) {
  return Math.round(Math.abs(n) / 1000).toLocaleString("en-US") + "k";
}
// full token count, comma-grouped — ticks by the single token: 77,732,145
function tkfull(n) {
  return Math.round(Math.abs(n)).toLocaleString("en-US");
}
// `/maxx session` brief — reads the snapshot the statusline writes and answers the one question:
// how much can I spend this session? First line is machine-ingestible (KEY=value); the rest is human.
function sessionBrief(st) {
  if (!st || !st.session) return "maxx — no usage data yet. Open Claude Code so the statusline can write ~/.maxx/status.json, then retry.";
  const s = st.session, w = st.weekly || {};
  const toSpend = s.toSpend != null ? s.toSpend : Math.max(0, (s.cap || 0) - (s.used || 0));
  const over = s.over != null ? s.over : Math.max(0, (s.used || 0) - (s.cap || 0));
  const burst = s.rawHeadroom || 0;                                    // hard 5h ceiling right now
  const sustainable = w.minLeft > 0 ? Math.round((w.headroom || 0) / w.minLeft) : 0; // weekly pace /min
  const net = st.netPerMin != null ? st.netPerMin : 0;                 // sustainable − recent burn
  const sess = st.sessionsLeftInWeek;
  // short, glanceable magnitudes: 18.2M, 457M, 61k. The raw counts stay in the machine line above.
  const abbr = (n) => { n = Math.round(Math.abs(n || 0)); return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : "" + n; };
  const row = (label, val, ctx) => `  ${label.padEnd(11)}${String(val).padEnd(14)}${ctx}`;
  const out = [];
  // machine line: SAFE is weekly-paced (plan against it); BURST is the hard 5h ceiling.
  out.push(`SESSION_SAFE=${toSpend} SESSION_BURST=${burst} NET_PER_MIN=${net} SUSTAINABLE_PER_MIN=${sustainable} OVER=${over} SESSION_RESETS_IN_MIN=${s.minLeft ?? "?"} RAW_5H_CAP=${s.rawCap ?? "?"} RAW_5H_USED_PCT=${s.rawUsedPct ?? "?"} WEEKLY_LEFT=${w.headroom || 0} WEEKLY_RESETS_IN=${w.resetIn || "?"} SESSIONS_LEFT_WEEK=${sess ?? "?"}`);
  out.push("");
  out.push("maxx · this session");
  out.push("");
  out.push(row("safe", abbr(toSpend), "plan against this — weekly budget ÷ windows left, capped at the 5h wall"));
  out.push(row("burst", abbr(burst), "hard 5h ceiling — reachable now, but it borrows from future windows"));
  out.push(row("net", (net >= 0 ? "+" : "−") + abbr(net) + "/min", net >= 0 ? "under weekly pace — the week will last" : "over weekly pace — easing off recovers it"));
  out.push(row("week", abbr(w.headroom || 0) + " left", `· ${sess ?? "?"} windows left · resets in ${w.resetIn || "?"}`));
  out.push("");
  out.push("  SAFE = your weekly coins ÷ the 5h windows left this week. Plan work against it: future");
  out.push("  windows keep giving fair shares, so an overspend now is recovered later — you don't have to");
  out.push("  claw it back this window. BURST past pace reaches the hard 5h wall but eats into future weeks.");
  return out.join("\n");
}

// zone = a function of time left: project your burn to reset (used ÷ elapsed). Under the pace
// line → safe, on it → elevated, headed past the wall → danger. Colors the meter + the number.
function zoneCol(u, e) {
  const proj = u / Math.max(e, 0.02); // projected fullness at reset if you hold this pace
  return u >= 0.9 || proj >= 1.25 ? RED : proj >= 0.9 ? AMBER : GREEN;
}

// FUEL gauge — the bar is what's LEFT, not what's spent. Full budget = full tank; spending drains it
// (green shrinks from the right), and for the roll-session the rolling window REFILLS it as old usage
// ages out — so banking visibly GAINS fuel. A pace tick marks the fuel you'd have at even burn: tank
// past the tick = ahead/banked (green), short of it = burning too fast (amber → red near empty).
function fuelMeter(fuelFrac, e, w) {
  fuelFrac = Math.max(0, Math.min(1, fuelFrac));
  const fuelN = Math.round(fuelFrac * w);
  const paceFuel = Math.max(0, Math.min(1, 1 - e));            // fuel remaining if spending at even burn
  const paceN = Math.min(w - 1, Math.round(paceFuel * w));
  const ratio = paceFuel > 0.02 ? fuelFrac / paceFuel : 1;    // >1 = more fuel than pace (banked)
  const col = (fuelFrac < 0.1 || ratio < 0.5) ? RED : ratio < 0.85 ? AMBER : GREEN;
  let s = fg(START, "▐"); // full-tank end
  for (let i = 0; i < w; i++) {
    const cell = i < fuelN ? shade(col, fuelN > 1 ? i / (fuelN - 1) : 0.5) : null;
    if (i === paceN) s += cell ? esc("#ffffff", cell, "╎")           // in the fill: thin white line on the fuel color
                              : fg(BORDER, "╎");                     // in the drained zone: the thin marker
    else s += cell ? fg(cell, "█") : fg(TRACK, "█");
  }
  return s + fg(WALL, "▌"); // empty end
}

// NET bar — one directional fill for your STANDING (signed fuel = realMax − rolling usage). NEGATIVE
// (over your paced share) grows RED in from the RIGHT edge, right→left, longer the more over. As the
// rolling window ages out (or you ease off) the deficit shrinks and the red RECEDES — live, per second.
// Cross into POSITIVE (banked fuel) and GREEN grows from the LEFT, left→right. Scale = realMax (the
// session budget), so a full tank's worth of over/under = a full bar; smaller = a proportional sliver.
function netBar(standing, greenScale, redScale, w) {
  // green (banking) scales to your PACED share; red (over) scales to the HARD 5h wall — so full red means
  // lockout is imminent, not merely "past your soft pace". Just over pace → a light-red sliver creeping in.
  const frac = standing >= 0
    ? Math.min(1, standing / Math.max(greenScale, 1))
    : Math.min(1, -standing / Math.max(redScale, 1));
  const n = Math.round(frac * w);
  let out = fg(START, "▐"); // same framing as the week fuel tank
  // gradient gauged to the FULL width (not the fill length), so the light→dark spread runs across the
  // whole span: a short fill stays light, only a fill reaching the far edge hits full dark. Both fills
  // are lightest at their anchor edge and deepen toward the leading edge (green→right, red→left/wall).
  const W1 = Math.max(1, w - 1);
  for (let i = 0; i < w; i++) {
    const red = standing < 0 && i >= w - n;  // red deficit anchored at the RIGHT
    const green = standing > 0 && i < n;      // green banked fuel anchored at the LEFT
    out += red ? fg(shade(RED, (w - 1 - i) / W1), "█")
      : green ? fg(shade(GREEN, i / W1), "█")
      : fg(TRACK, "█"); // solid track = same weight as the week tank
  }
  return out + fg(WALL, "▌");
}

// ─── sidecar state ─────────────────────────────────────────────────────────────
const HOME = homedir();
const readJSON = (p, d = {}) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
// Per-login session scope: a CLAUDE_CONFIG_DIR session reads/writes its own copies of
// the session-derived caches (rl-gmail.json, window-gmail.json, …) — two logins
// rendering concurrently must never fight over one file. Suffix rule matches
// limit.mjs/emit.mjs. Fleet-shared files (config, accounts, state) stay plain.
const SUF = process.env.CLAUDE_CONFIG_DIR ? "-" + path.basename(process.env.CLAUDE_CONFIG_DIR).replace(/^\.claude-?/, "") : "";
const MAXX = (name) => path.join(HOME, ".maxx", name.replace(/(\.json)$/, `${SUF}$1`));
// Which Claude ACCOUNT this session is signed into. Anchors are per account, and the
// shipper must never calibrate another account's timeline with them — so every rl.json/
// status.json write carries the observer's uuid. A session launched with CLAUDE_CONFIG_DIR
// keeps its oauth state in that dir, not ~/.claude.json.
const sessAccount = (() => {
  try {
    const f = path.join(process.env.CLAUDE_CONFIG_DIR || HOME, ".claude.json");
    return JSON.parse(readFileSync(f, "utf8")).oauthAccount?.accountUuid || null;
  } catch { return null; }
})();
const statePath = path.join(HOME, ".maxx", "state.json");
const sprintPath = path.join(HOME, ".maxx", "sprint.json");
const sessionsCache = path.join(HOME, ".maxx", ".sessions");

// sprint timing lives in its OWN file so this 1s renderer and the per-turn brain
// never write the same JSON (state.json is brain-owned; we only read it).
function sprintTimer(sp) {
  const now = Date.now() / 1000;
  let start = sp.sess_start || 0;
  const last = sp.sess_last || 0;
  if (start === 0 || now - last > 300 || now - start >= 1800) start = now;
  sp.sess_start = start; sp.sess_last = now;
  return { left: Math.max(1, Math.round(30 - (now - start) / 60)), start };
}

// What the LAST FEW TURNS of this session actually cost. The 5-minute burn rate is
// account-wide and lags; per-turn cost is the number that moves first when a session
// starts going bad, because a turn re-bills the whole context. Reads only the tail of
// the transcript (256KB), so it stays cheap on a render tick.
function lastTurns(tp, n) {
  if (!tp) return [];
  let size; try { size = statSync(tp).size; } catch { return []; }
  if (!size) return [];
  const len = Math.min(size, 256 * 1024);
  let text = "";
  try {
    const fd = openSync(tp, "r");
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    text = buf.toString("utf8");
  } catch { return []; }
  const lines = text.split("\n");
  if (size > len) lines.shift();            // first line is probably a fragment
  const costs = [];
  const seen = new Set();                   // one request can appear several times in the
  for (const line of lines) {               // transcript; count it once, same as limit.mjs
    if (!line || line[0] !== "{") continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const u = r?.message?.usage; if (!u) continue;
    const id = r.requestId || r.uuid;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const t = weighUsage(u, r?.message?.model || "");
    if (t > 0) costs.push({ id: id || `t${costs.length}-${Math.round(t)}`, cost: t });
  }
  return costs.slice(-n);
}

// Keep a short history of per-turn costs per session in ~/.maxx/turns.json. A 256KB
// transcript tail only reaches ~3 turns on a heavy session, which is enough to show
// the current cost but never enough to show a TREND. Rather than read further back on
// every tick (slow), we remember: each render appends whatever turns it has not seen
// before, keyed by request id, and keeps the last 12.
function turnHistory(sid, fresh, ctxNow) {
  const p = path.join(HOME, ".maxx", "turns.json");
  let db = {};
  try { db = JSON.parse(readFileSync(p, "utf8")) || {}; } catch {}
  const key = sid || "unknown";
  let cur = db[key] || { ids: [], costs: [], ctx: 0 };
  // /clear and /compact start the turn cost over from nothing, so carrying the old
  // ring across makes the first cheap turns of a fresh context look like a saving and
  // hides the real climb. Claude Code keeps the session id, so the tell is the context
  // itself collapsing: a drop to under half of what it was is a reset, not a turn.
  if (ctxNow > 0 && cur.ctx > 0 && ctxNow < cur.ctx * 0.5) cur = { ids: [], costs: [], ctx: 0 };
  if (ctxNow > 0) cur.ctx = ctxNow;
  for (const t of fresh) {
    if (cur.ids.includes(t.id)) continue;
    cur.ids.push(t.id); cur.costs.push(Math.round(t.cost));
  }
  cur.ids = cur.ids.slice(-12); cur.costs = cur.costs.slice(-12);
  db[key] = cur;
  // don't let the file grow forever: keep the 12 most recently touched sessions
  const keys = Object.keys(db);
  if (keys.length > 12) for (const k of keys.slice(0, keys.length - 12)) delete db[k];
  try { writeFileSync(p, JSON.stringify(db)); } catch {}
  return cur.costs;
}

// YOUR concurrent sessions: transcripts across ~/.claude/projects touched in the last
// 5 min. Throttled (~20s cache) so we don't walk the whole history every render tick.
function localSessions() {
  try { const c = JSON.parse(readFileSync(sessionsCache, "utf8")); if (Date.now() - c.at < 20000) return c.n; } catch {}
  const cutoff = Date.now() - 5 * 60 * 1000;
  let n = 0;
  const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".jsonl")) { try { if (statSync(f).mtimeMs > cutoff) n++; } catch {} } } };
  walk(path.join(HOME, ".claude", "projects"));
  try { writeFileSync(sessionsCache, JSON.stringify({ at: Date.now(), n })); } catch {}
  return n;
}

function tryRead(p) { try { return readFileSync(p, "utf8").trim(); } catch { return null; } }
function gitBranch(dir) {
  for (let d = dir; d && d !== "/"; d = path.dirname(d)) {
    const head = tryRead(path.join(d, ".git", "HEAD"));
    if (head == null) continue;
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
    return head.length >= 7 ? head.slice(0, 7) : "";
  }
  return "";
}

function modelFamily(name = "") {
  const l = name.toLowerCase();
  if (l.includes("opus")) return "Opus";
  if (l.includes("haiku")) return "Haiku";
  if (l.includes("sonnet")) return "Sonnet";
  return [...name].slice(0, 8).join("");
}

// coachLine: product/build guidance. brain advice (fresh) > intention > new-sprint > ctx > ship.
function coachLine(st, ctxPct, sprintStart) {
  const adv = st.advice, advTs = st.advice_ts || 0;
  if (adv && Date.now() - advTs < 300_000) return [adv, AMBER]; // advice_ts is ms
  const intent = st.intent, intentStart = st.intent_start || 0;
  if (intent && Math.abs(intentStart - sprintStart) < 1) return ["→ " + intent, BRAND];
  const now = Date.now() / 1000;
  if (now - sprintStart > 0 && now - sprintStart < 180 && !intent) return ["new sprint — what are you shipping?", AMBER];
  if (ctxPct >= 75) return ["context heavy — commit at a clean stop, then /compact", AMBER];
  return ["running clean — ship the smallest thing that works", GREEN];
}

// ─── compositor: panes are arrays of width-w rows; join them side by side ──────
function pane(lines, w, h, valign = "top", halign = "left") {
  let rows = lines.map((l) => padLine(l, w, halign));
  if (rows.length > h) rows = rows.slice(0, h);
  const miss = h - rows.length;
  if (miss > 0) {
    if (valign === "center") { const t = Math.floor(miss / 2); rows = [...Array(t).fill(blank(w)), ...rows, ...Array(miss - t).fill(blank(w))]; }
    else rows = [...rows, ...Array(miss).fill(blank(w))];
  }
  return rows;
}
function joinH(...panes) {
  const h = Math.max(...panes.map((p) => p.length));
  return Array.from({ length: h }, (_, r) => panes.map((p) => p[r] ?? "").join(""));
}
function wrap(text, w) {
  const out = []; let cur = "";
  for (const word of text.split(/\s+/)) {
    if (!cur) cur = word;
    else if (dispWidth(cur) + 1 + dispWidth(word) <= w) cur += " " + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out.flatMap((l) => { const r = []; let s = l; while (dispWidth(s) > w) { r.push([...s].slice(0, w).join("")); s = [...s].slice(w).join(""); } r.push(s); return r; });
}

function main() {
  const wantStatus = process.argv.includes("--status");
  const wantSession = process.argv.includes("--session"); // `/maxx session` — how much to spend now
  let p = {}, rawIn = "";
  // don't block on an interactive TTY: `node render.mjs --status` from a shell has no piped JSON,
  // so reading fd 0 would hang forever. Only slurp stdin when it's actually a pipe.
  if (!process.stdin.isTTY) { try { rawIn = readFileSync(0, "utf8"); p = JSON.parse(rawIn); } catch {} }
  // raw stdin snapshot — ground truth for debugging what Claude Code actually reports (rl.json and
  // status.json are post-merge; when a wall time looks wrong this is the only unlaundered record).
  try { if (rawIn.trim()) writeFileSync(path.join(HOME, ".maxx", ".laststdin.json"), rawIn); } catch {}
  // `--status`/`--session` with no stdin (a user or agent calling us directly) → read the last
  // snapshot the live statusline wrote. Nothing fresh to compute without Claude Code's JSON.
  if ((wantStatus || wantSession) && !rawIn.trim()) {
    const st = readJSON(MAXX("status.json"), null);
    if (wantSession) { process.stdout.write(sessionBrief(st) + "\n"); return; }
    process.stdout.write((st ? JSON.stringify(st, null, 2) : "{}") + "\n");
    return;
  }
  const cols = parseInt(process.env.COLUMNS || "130", 10) || 130;

  const st = readJSON(statePath);
  // coach is per-session: read this session's slot (never another session's). If we can't tell
  // which session we are, fall back to the legacy global slot. Presence stays global (from st).
  const sid = p.session_id || null;
  const coachSt = sid ? ((st.sessions && st.sessions[sid]) || {}) : st;
  const cw_ = p.context_window || {};
  const ctxPct = cw_.used_percentage || 0;
  const cu = cw_.current_usage || {};
  const total = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0);
  const cache = total > 0 ? (cu.cache_read_input_tokens || 0) / total : 0;

  const rl = p.rate_limits || {};
  // Cross-account pollution guard: a session launched under a PREVIOUS login keeps reporting that
  // account's walls (seen live: five_hour resets_at a day in the past next to a 97% week from the
  // retired account). Any wall whose reset is already behind us marks the whole payload as a stale
  // snapshot from another login — drop it entirely; one bad wall poisons both. 60s grace for the
  // legit moment right at a reset boundary.
  const nowSec_ = Date.now() / 1000;
  if ((rl.five_hour && rl.five_hour.resets_at < nowSec_ - 60) || (rl.seven_day && rl.seven_day.resets_at < nowSec_ - 60)) { delete rl.five_hour; delete rl.seven_day; }
  // stdin sometimes arrives without rate_limits (or with five_hour only). Zeroing out then is
  // catastrophic for the week row: elapsed→0 pins the pace tick to the far right and the fill
  // unpins from /usage — a self-contradicting gauge. Fall back to the recently cached %s and
  // reset times instead; only a LIVE rate_limits payload may refresh that cache (no laundering
  // stale values with a fresh timestamp).
  const liveRL = !!(rl.five_hour || rl.seven_day);
  const rlCache = readJSON(MAXX("rl.json"), null);
  const cacheFresh = rlCache && rlCache.ts && Date.now() - rlCache.ts < 30 * 60 * 1000;
  // Concurrent sessions on one account see different rate-limit snapshots: one lags a whole
  // window behind (its 5h block rolled), or lags within the window (used% behind). Alternating
  // writes to the shared cache made every gauge flap and every cap anchor balloon. Merge rule:
  // the LATER resets_at wins (newest window); within the same window used% is monotonic, so
  // take the MAX. A session with no stdin payload rides the fresh cache entirely.
  // A far-future resets_at is a "not-limited" sentinel, not a newer window — reject it on both
  // the live payload and the cache before the "later reset wins" race, or it renders 95082d and
  // a phantom pace flip. The % is still ground truth, so we keep it; only the bogus reset dies.
  const mergeWall = (live, cPct, cReset0) => {
    const nowSec = Date.now() / 1000;
    const cReset = plausibleReset(cReset0, nowSec);
    const havePrev = cacheFresh && cReset > 0;
    if (!live) return havePrev ? { pct: cPct || 0, reset: cReset } : null;
    const lPct = (live.used_percentage || 0) / 100, lReset = plausibleReset(live.resets_at || 0, nowSec);
    if (havePrev && cReset > lReset) return { pct: cPct || 0, reset: cReset };
    if (havePrev && cReset === lReset) return { pct: Math.max(lPct, cPct || 0), reset: lReset };
    return { pct: lPct, reset: lReset };
  };
  const wall5 = mergeWall(rl.five_hour, rlCache && rlCache.quota, rlCache && rlCache.fiveResetAt);
  const wall7 = mergeWall(rl.seven_day, rlCache && rlCache.week, rlCache && rlCache.weekResetAt);
  if (wall5) rl.five_hour = { used_percentage: wall5.pct * 100, resets_at: wall5.reset };
  if (wall7) rl.seven_day = { used_percentage: wall7.pct * 100, resets_at: wall7.reset };
  const haveQuota = !!rl.five_hour;
  let haveWeek = !!rl.seven_day;
  const quota = wall5 ? wall5.pct : 0;
  let week = wall7 ? wall7.pct : 0;
  // mergeWall zeroes a sentinel reset but keeps the wall (its % is real). When the reset is
  // unknown the pace bank (cap×elapsed − used) is meaningless — elapsed collapses — so suppress
  // the pace token rather than print a sign-flipped phantom off a fabricated elapsed.
  const weekResetOk = haveWeek && rl.seven_day.resets_at > 0;

  // hand the authoritative %s to limit.mjs (the brain reruns it) so it can anchor token caps.
  // stash seven_day.resets_at too: limit.mjs (no stdin of its own) needs it to cut the weekly
  // sum at the real window start instead of a blind rolling 7d — see weekLo below.
  try { if (liveRL && haveQuota) writeFileSync(MAXX("rl.json"), JSON.stringify({ quota, week, fiveResetAt: rl.five_hour.resets_at || 0, weekResetAt: haveWeek ? rl.seven_day.resets_at : 0, ts: Date.now(), account: sessAccount })); } catch {}
  // rl history: append every CHANGE in the observed walls (not every tick) — the audit trail that
  // lets a "bar said 55%, /usage said 100%" incident be reconstructed after the fact.
  try {
    const w7r = haveWeek ? rl.seven_day.resets_at : 0, w5r = haveQuota ? rl.five_hour.resets_at || 0 : 0;
    if (liveRL && haveQuota && (!rlCache || rlCache.quota !== quota || rlCache.week !== week || rlCache.fiveResetAt !== w5r || rlCache.weekResetAt !== w7r))
      appendFileSync(path.join(HOME, ".maxx", `rl-history${SUF}.jsonl`), JSON.stringify({ quota, week, fiveResetAt: w5r, weekResetAt: w7r, ts: Date.now(), account: sessAccount }) + "\n");
  } catch {}
  // weekly-limit banner override — AFTER the rl.json stamp so the observation cache stays pure
  // payload. A synthetic "hit your weekly limit" turn is ground truth over the payload (seen live:
  // payload 55% while /usage read 100% and cloud tasks were blocked). Until the banner's own reset
  // passes, the week rail reads 100%.
  const limitHit = readJSON(MAXX("limit-hit.json"), null);
  if (limitHit && limitHit.resetAt * 1000 > Date.now() && limitHit.at <= Date.now()) {
    week = 1;
    haveWeek = true;
    rl.seven_day = { used_percentage: 100, resets_at: limitHit.resetAt };
  }
  // session-reset flag: the 5h wall's resets_at jumps forward when a fresh block starts. Track
  // the last one; when it leaps (>5min later), the window just cleared — flag it for ~5 min.
  const marksPath = MAXX("marks.json");
  const marks = readJSON(marksPath, {});
  let freshReset = false;
  if (haveQuota) {
    const cur = rl.five_hour.resets_at, nowS = Date.now() / 1000;
    let at = marks.sessResetAt || 0;
    if (marks.sessReset && cur > marks.sessReset + 300) at = nowS; // block leapt → just reset
    freshReset = at > 0 && nowS - at < 300;
    try { writeFileSync(marksPath, JSON.stringify({ sessReset: cur, sessResetAt: at })); } catch {}
  }
  // tokens burned in each window, re-summed against the live clock so idle time visibly
  // recovers (old 5-min buckets fall out the back). cap anchored → tok/cap == the real %.
  const win = readJSON(MAXX("window.json"), null);
  let tok5 = null, tok5roll = null, cap5 = null, tok7 = null, cap7 = null, burn5 = null, burn60 = 0, refuelPerMin = 0;
  if (win && Array.isArray(win.buckets) && win.buckets.length) {
    const now = Date.now();
    // account clamp: buckets before the current Claude account's epoch (limit.mjs stamps it from the
    // accounts ledger) belong to a different account's rate limits — never count them here.
    const acctLo = win.accountSince || 0;
    const bkts = acctLo ? win.buckets.filter((b) => b[0] > acctLo) : win.buckets;
    const sum = (ms) => { const c = now - ms; let s = 0; for (const b of bkts) if (b[0] > c) s += b[1]; return s; };
    const sumFrom = (lo) => { let s = 0; for (const b of bkts) if (b[0] > lo) s += b[1]; return s; };
    // SMOOTH rolling window (age-weighted decay): every bucket's weight fades LINEARLY from 1 (just now)
    // to 0 (5h old), so all recent spend is continuously decaying — not a hard cutoff that only drops the
    // trailing bucket. `now` advances every render (~1s), so the weighted sum shrinks a little each second
    // and the fuel tank refills smoothly per second while you idle, at ~(last-5h spend)/5h per second.
    // A spend fully "returns" 5h after it happened; idling just lets the decay run. This is the roll-
    // session's own pacing clock, not Anthropic's hard 5h wall (that stays in the raw* fields).
    const decaySum = (winMs) => { let s = 0; for (const b of bkts) { const age = now - b[0]; if (age >= winMs) continue; s += b[1] * (1 - age / winMs); } return s; };
    // session: sum from the real window start (resets_at − 5h), same as weekly below — NOT a blind
    // rolling 5h. So the instant the wall resets (resets_at leaps +5h), pre-reset burn stops counting
    // and the bar drops to ~0 immediately, instead of decaying stale over the next 5 hours.
    const FIVE = 5 * 3600 * 1000;
    const fiveLo = Math.max(now - FIVE, haveQuota ? rl.five_hour.resets_at * 1000 - FIVE : 0);
    tok5 = sumFrom(fiveLo); cap5 = win.cap5;
    // ROLLING 5h window for the roll-session fuel: sum the trailing 5h regardless of Anthropic's fixed
    // reset boundary. Old buckets age out the back continuously, so idling REFILLS the tank (bank by
    // chilling) instead of waiting for a cliff at resets_at. This is the roll-session's own clock; the
    // hard Anthropic 5h wall stays exposed via the raw* fields (quota).
    tok5roll = decaySum(FIVE);
    // refuel = how fast the rolling tank refills (in-window burn decays over 300 min) → the "progress"
    // trend below is refuel − live burn: + = standing improving (recovering/banking), − = losing ground.
    refuelPerMin = Math.round(sum(FIVE) / 300);
    // weekly: sum from Anthropic's actual window start (resets_at − 7d), not a blind now − 7d, so a
    // pre-reset burst stops counting the instant the wall zeroed. max() = never loosen past the
    // rolling window, so a stale/absent resets_at falls back to old behavior (never counts more).
    const WK = 7 * 24 * 3600 * 1000;
    const weekLo = Math.max(now - WK, haveWeek ? rl.seven_day.resets_at * 1000 - WK : 0);
    tok7 = sumFrom(weekLo); cap7 = win.cap7;
    // gross tokens burned in the last 5 min (always ≥ 0). This is the live "are you actually using
    // the session" signal — coloured against the maximize pace, and shown as "idle" when it's ~0.
    burn5 = sum(5 * 60 * 1000);
    // live per-min burn, age-weighted (glides down each render as a spike ages out) — feeds the trend.
    burn60 = Math.round(decaySum(60 * 1000) * 2);
  }

  const usd = (p.cost || {}).total_cost_usd || 0;
  const fam = modelFamily((p.model || {}).display_name);
  const branch = gitBranch((p.workspace || {}).project_dir || "");

  const sp = readJSON(sprintPath);
  const { left, start: sprintStart } = sprintTimer(sp);
  try { writeFileSync(sprintPath, JSON.stringify(sp)); } catch {}

  const mine = localSessions();          // your concurrent sessions (local — mtimes only)

  const col = (v) => (v >= 0.9 ? RED : v >= 0.75 ? AMBER : GREEN);
  // STABLE token cap per window. We anchor the cap to the wall (tok ÷ wall%) — that's the honest
  // magnitude — but re-anchor ONLY when the wall % actually ticks, holding it steady in between.
  // If we recomputed tok÷quota every render, a flat quota with rising tok would inflate the cap as
  // you burn, so "coins left" would go UP while spending — backwards. Cached in caps.json so the
  // held value survives across renders (and across a reset, since the cap itself doesn't change).
  const capsPath = MAXX("caps.json");
  const caps = readJSON(capsPath, {});
  // caps anchored under a DIFFERENT Claude account are meaningless against this one's %s — flush and
  // re-anchor fresh on the first render after a switch (window.json carries the current account uuid).
  if (win && win.accountUuid && caps.acct !== win.accountUuid) for (const k of Object.keys(caps)) delete caps[k];
  const anchorCap = (have, pct, tok, prevPct, prevCap, brainCap) => {
    // a held cap below the tokens already counted against it is nonsense (a cold-start render can pin
    // cap=1 right after an account switch) — drop it so the brain's cap or a fresh anchor takes over.
    if (prevCap && tok != null && prevCap < tok) prevCap = 0;
    if (have && pct > 0.02 && tok != null) {
      if (prevCap && prevPct != null && Math.abs(prevPct - pct) < 0.005) return prevCap; // wall % steady → hold
      // wall ticked → re-anchor, but EMA-smooth the jump (½ old, ½ new). The cap is an estimate (tok is
      // cache-inflated, so tok/pct can leap on a tick); blending keeps roll-session from lurching on noise
      // while still tracking the real magnitude over a few ticks. First-ever anchor: take it straight.
      return prevCap ? Math.round(0.5 * prevCap + 0.5 * (tok / pct)) : Math.round(tok / pct);
    }
    return prevCap || brainCap || 0; // below the 2% floor (or no stdin) → keep the last good cap
  };
  // Coin model (mirrors limit.mjs / server tally): the cap is a FIXED tank, not `tok ÷ pct`.
  // No inference to smooth or cache — a coarse low % can't blow it up, and every surface reads
  // the same ruler. The 5h bar paces an even share of the weekly tank.
  const cap5s = COINS_FIVE;
  const cap7s = COINS_MAX;
  // did the cap just re-anchor (first anchor OR the wall % ticked ≥0.5pt)? If so we re-snapshot the
  // bucket sum as the new "anchor tok" — the live delta below is measured from there, so it resets to
  // ~0 at every tick and can never accumulate into the old 2× drift.
  const didAnchor = (have, pct, tok, prevPct, prevCap) =>
    have && pct > 0.02 && tok != null && !(prevCap && prevPct != null && Math.abs(prevPct - pct) < 0.005);
  const tok5a = didAnchor(haveQuota, quota, tok5, caps.q5, caps.cap5) ? tok5 : (caps.tok5a ?? (tok5 ?? 0));
  const tok7a = didAnchor(haveWeek, week, tok7, caps.q7, caps.cap7) ? tok7 : (caps.tok7a ?? (tok7 ?? 0));
  try { writeFileSync(capsPath, JSON.stringify({ q5: haveQuota ? quota : caps.q5, cap5: cap5s, tok5a, q7: haveWeek ? week : caps.q7, cap7: cap7s, tok7a, acct: (win && win.accountUuid) || caps.acct })); } catch {}
  // LIVE used = authoritative base + scaled burn since the last %-tick. The base (wall% × cap) is
  // Anthropic's truth — what /usage shows. On top we add the tokens burned since the anchor, but the raw
  // bucket delta over-counts (cache reads at full weight), so we scale it by the deflation factor we can
  // MEASURE right now: f = base ÷ tok = how many Anthropic-charged tokens per maxx-counted token over the
  // window. That makes "left" tick down every render as you spend (≈1s cadence) while staying pinned to
  // the real % — and f→0 as the gap widens, so the live add is bounded (worst case ~2× base, never the
  // old unbounded drift). Falls back to the raw bucket sum only with no wall data (offline).
  const liveUsed = (have, pct, capS, tok, toka) => {
    if (!have || !capS) return tok != null ? Math.round(tok) : 0;
    const base = pct * capS;
    const f = Math.max(0, Math.min(1, tok > 0 ? base / tok : 1)); // measured deflation, clamped
    const delta = tok != null ? tok - (toka ?? tok) : 0;          // burn since the last %-tick
    return Math.max(0, Math.min(capS, Math.round(base + f * delta)));
  };
  // roll-session usage = the ROLLING 5h bucket sum (recovers as old buckets age out → fuel refills when
  // you idle). Falls back to the fixed-block pinned value when buckets are missing. Weekly stays PINNED to
  // Anthropic's seven_day % (the weekly bar must match /usage). Both in the same (maxx) token units as the
  // caps, so the fuel fractions below are honest ratios even though the absolute magnitudes are estimates.
  // Coin model: used = the LEDGER coin count (our own burn), NOT pct×cap. The gauge measures
  // what we spent against the fixed tank, so the bars can diverge from Anthropic's % — the point.
  const used5 = tok5roll != null ? Math.round(tok5roll) : Math.round(tok5 || 0);
  // Week USED is anchored to Anthropic's own 7d % (robust — it arrives on stdin every render and
  // never collapses), scaled to the coin tank. The local bucket sum (tok7) is a FALLBACK for when
  // there's no live %: it can transiently read ~0 (account switch, first render, mid-rewrite of
  // window.json), which used to snap the week bar to "just started" mid-week. Pinning to the % also
  // makes the bar match /usage exactly.
  const used7 = haveWeek ? Math.round(week * cap7s) : Math.round(tok7 || 0);
  // ROLL-SESSION — one sentence: weekly tokens LEFT ÷ the 5h windows left this week = tokens good to use
  // this session. Spend up to it and the week lasts; max Anthropic's raw 5h wall instead and you're out in
  // days. It BANKS: it's LIVE, so as you spend, weekly-left drops and it ticks down (~1:1); when you go
  // light, windows-left counts down with the clock and it ticks UP — frugal now = more later, no ledger.
  // Capped at the hard 5h wall (can't spend past it); falls back to the raw 5h cap with no weekly data.
  // The cap-smoothing above keeps this from jittering on estimate noise — it moves for spend + time only.
  const nowS0 = Date.now() / 1000;
  const weekLeftSec = haveWeek ? Math.max(0, rl.seven_day.resets_at - nowS0) : 0;
  const sessionsLeft = Math.max(1, weekLeftSec / (5 * 3600));         // 5h windows until the weekly resets
  const realMax = haveWeek && cap7s
    ? Math.min(cap5s || Infinity, Math.round(Math.max(0, cap7s - used7) / sessionsLeft))
    : cap5s;
  // session bar is now the REAL session: used against realMax, not the raw 5h wall.
  const q5 = realMax ? Math.min(1, used5 / realMax) : (haveQuota ? quota : 0);
  // week FILL is the coin fraction of the tank — our meter reads our burn, not Anthropic's %.
  const w7 = haveWeek ? week : (cap7s ? Math.min(1, used7 / cap7s) : 0);
  const qcol = col(q5), wcol = col(w7);
  // how far into each window you are (the pace line): elapsed = time-in / window-span. The span
  // start clamps to the account epoch — a just-switched account did NOT start its window resets−7d
  // ago, and the unclamped math read "51% elapsed, 50pts behind" on an account 90 minutes old.
  const nowS = Date.now() / 1000;
  const acctS = ((win && win.accountSince) || 0) / 1000;
  const spanOf = (resetAt, winSec) => { const start = Math.max(resetAt - winSec, acctS); return { start, span: Math.max(1, resetAt - start) }; };
  const elapsedOf = (resetAt, winSec) => { const { start, span } = spanOf(resetAt, winSec); return Math.max(0, Math.min(1, (nowS - start) / span)); };
  const e5 = haveQuota ? elapsedOf(rl.five_hour.resets_at, 5 * 3600) : 0;
  const e7 = haveWeek ? elapsedOf(rl.seven_day.resets_at, 7 * 24 * 3600) : 0;
  // cache reuse as a plain %, colored by the same heat thresholds (low reuse = burning
  // fresh tokens). A number, not a mood word, so it can't read as "all's well" next to
  // an off-pace line.
  const cacheV = `${Math.round(cache * 100)}%`;
  let cacheCol = GREEN;
  if (cache < 0.6) cacheCol = RED; else if (cache < 0.85) cacheCol = AMBER;
  let hcol = GREEN;
  if (q5 >= 0.9 || w7 >= 0.9) hcol = RED;
  else if (q5 >= 0.75 || w7 >= 0.75 || cache < 0.6) hcol = AMBER;

  const qv = haveQuota ? `${Math.min(99, Math.floor(q5 * 100))}%` : "—";
  const wv = haveWeek ? `${Math.min(99, Math.floor(w7 * 100))}%` : "—";
  const qr = resetIn(haveQuota ? rl.five_hour.resets_at : 0);
  const wr = resetIn(haveWeek ? rl.seven_day.resets_at : 0);

  // pace per wall: session (5h) and weekly (7d) — will either hit its cap before it resets?
  const p5 = haveQuota ? paceOf(rl.five_hour, spanOf(rl.five_hour.resets_at, 5 * 3600).span, quota) : { ok: false, hot: false };
  const p7 = haveWeek ? paceOf(rl.seven_day, spanOf(rl.seven_day.resets_at, 7 * 24 * 3600).span, week) : { ok: false, hot: false };

  // ── derived, machine-readable: every number the bars compute — time left, tokens burned, and
  //    needPerMin — as plain fields, so an agent can read ~/.maxx/status.json (or
  //    `node render.mjs --status`) instead of scraping ANSI.
  //    needPerMin = the rate that MAXIMIZES throughput: burn all the way to the session cap right as
  //    it resets, since unused session budget just evaporates (the week is maximized by never
  //    leaving a session on the table). = headroom-to-cap ÷ minutes left. Falls to 0 once you're at
  //    the cap — "without going over the session max" — so it never tells you to overshoot.
  function windowStat(tokV, capV, usedFrac, resetAt, winSec) {
    const secLeft = resetAt ? Math.max(0, Math.round(resetAt - nowS)) : 0;
    const minLeft = secLeft / 60;
    const cap = capV || 0;
    const used = tokV != null ? Math.round(tokV) : Math.round(usedFrac * cap);
    const headroom = Math.max(0, cap - used);                    // room left before the session max
    const needPerMin = cap && minLeft > 0 ? Math.round(headroom / minLeft) : 0; // fully use it by reset
    const pacePerMin = cap ? Math.round(cap / (winSec / 60)) : 0; // even burn that lands at 100%
    return { usedPct: Math.round(usedFrac * 1000) / 10, used, cap, headroom, resetAt: resetAt || 0,
             secLeft, minLeft: Math.round(minLeft), resetIn: resetIn(resetAt), needPerMin, pacePerMin };
  }
  const sStat = windowStat(used5, realMax, q5, haveQuota ? rl.five_hour.resets_at : 0, haveQuota ? spanOf(rl.five_hour.resets_at, 5 * 3600).span : 5 * 3600);
  const wStat = windowStat(used7, cap7s, w7, haveWeek ? rl.seven_day.resets_at : 0, haveWeek ? spanOf(rl.seven_day.resets_at, 7 * 24 * 3600).span : 7 * 24 * 3600);
  // pace gap (points): elapsed − used. + = behind even-burn (under-using), − = ahead. Cap-independent.
  sStat.elapsedPct = Math.round(e5 * 100); sStat.behindPts = Math.round((e5 - q5) * 100);
  wStat.elapsedPct = Math.round(e7 * 100); wStat.behindPts = Math.round((e7 - w7) * 100);
  // Net rate = sustainable weekly PACE − recent burn, ACCOUNT-WIDE. gate.mjs (and the
  // emit watcher) cache the server budget; use its net_per_min when fresh (<90s) so all
  // surfaces agree. Local fallback (cache stale/idle): weekly headroom ÷ minutes-to-reset
  // minus this machine's 5-min burn — the same pace model, just from local data.
  const gc = readJSON(MAXX("gate-cache.json"), null);
  const gcFresh = gc && gc.at && Date.now() / 1000 - gc.at < 90 && gc.b && gc.b.net_per_min != null;
  const wMinLeft = wStat.secLeft > 0 ? wStat.secLeft / 60 : 0;
  const localPace = wMinLeft > 0 ? wStat.headroom / wMinLeft : 0;
  const netPerMin = gcFresh ? gc.b.net_per_min : Math.round(localPace - (burn5 || 0) / 5);
  // is the weekly the binding wall (realMax below the raw 5h cap)? = the session allowance is being
  // held down to protect the week. Kept for agents; no longer a separate tag on the bar.
  sStat.weeklyPaced = !!(haveWeek && cap5s && realMax < cap5s);
  // ── hard-to-misread contract for consumers. A downstream "governor" read session.cap as the raw
  //    5h wall and concluded "plenty of headroom, run flat-out" — the opposite of the truth. So make
  //    the meaning explicit: session.cap IS realMax (the weekly-paced budget, NOT the 5h wall).
  //    toSpend/over/spendPerMin are the actionable pace numbers. raw* are the ACTUAL 5h window, for a
  //    consumer that genuinely wants "% of the 5h window" instead of misreading the paced one.
  sStat.toSpend = Math.max(0, realMax - used5);                     // safe to spend this session (≥ 0)
  sStat.bank = Math.round((cap7s || 0) * e7 - used7);               // + banked vs even-pace, − spent-ahead (the roll)
  sStat.over = Math.max(0, used5 - realMax);                        // past your sustainable share (≥ 0)
  sStat.name = "roll-session";                                     // brand: weekly-left ÷ windows-left, banks when light
  sStat.capKind = sStat.weeklyPaced ? "weekly-paced" : "5h-cap";   // what set session.cap / realMax
  sStat.sessionResetsInMin = sStat.minLeft;                         // minutes until the 5h wall resets
  sStat.spendPerMin = sStat.toSpend > 0 && sStat.minLeft > 0 ? Math.round(sStat.toSpend / sStat.minLeft) : 0;
  // raw* = Anthropic's ACTUAL fixed 5h wall (from quota), NOT the rolling roll-session usage above. Pinned
  // to the five_hour % so it matches /usage; the roll-session uses its own rolling window.
  const rawUsedFixed = Math.round((haveQuota ? quota : 0) * (cap5s || 0));
  sStat.rawCap = cap5s || 0;                                        // Anthropic's real 5h token cap
  sStat.rawUsed = rawUsedFixed;
  sStat.rawUsedPct = haveQuota ? Math.round(quota * 1000) / 10 : 0; // % of the ACTUAL fixed 5h window (= /usage)
  sStat.rawHeadroom = Math.max(0, (cap5s || 0) - rawUsedFixed);     // tokens left before the 5h wall
  const status = {
    ts: Date.now(), account: sessAccount, model: fam, ctxPct: Math.round(ctxPct), cachePct: Math.round(cache * 100),
    costUsd: Math.round(usd * 100) / 100, sessions: mine,
    // session.cap = realMax (weekly-derived sustainable budget), NOT Anthropic's raw 5h cap.
    session: sStat, weekly: wStat,
    sessionsLeftInWeek: Math.round(sessionsLeft * 10) / 10, // 5h windows remaining until the weekly resets
    burn5m: burn5 != null ? Math.round(burn5) : null,       // gross tokens spent in the last 5 min (≥ 0)
    netPerMin,                                              // account-wide net (gate-cache when fresh) — one net, every surface
  };
  try { writeFileSync(MAXX("status.json"), JSON.stringify(status)); } catch {}
  if (wantStatus) { process.stdout.write(JSON.stringify(status, null, 2) + "\n"); return; }

  // refresh window.json (the rolling-token cache limit.mjs owns; the bar + the governor read it). The
  // statusline ticks every ~1s, so gate the rescan: incremental tail every 5s (cheap, keeps burn near-
  // live even mid-turn), authoritative --full every 5 min to reconcile any drift. Detached + unref'd so
  // it never blocks a render. This lived in brain.mjs (a Stop hook); moved here so the data stays fresh
  // WHILE the agent works, not only at turn end — which is what an unattended overnight governor needs.
  const dueFor = (mark, ms) => { try { return Date.now() - Number(readFileSync(mark, "utf8")) > ms; } catch { return true; } };
  const markNow = (mark) => { try { writeFileSync(mark, String(Date.now())); } catch {} };
  const scanMark = path.join(HOME, ".maxx", ".limit-scan" + SUF), fullMark = path.join(HOME, ".maxx", ".limit-full" + SUF);
  if (dueFor(scanMark, 5000)) {
    markNow(scanMark);
    const full = dueFor(fullMark, 5 * 60 * 1000); if (full) markNow(fullMark);
    try {
      spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "limit.mjs"), ...(full ? ["--full"] : [])],
            { detached: true, stdio: "ignore" }).unref();
    } catch {}
  }

  // paceMove: when a wall's hot, the ONE thing the human can actually flip right now — ranked
  // by leverage against what the bar already sees. Opus burns the cap fastest (one keystroke
  // to Sonnet); N parallel sessions burn N×; a cold cache pays full freight; else just step
  // away (the catch-up break) or ease off for the day. null when you'll coast → "on track".
  function paceMove() {
    const sHot = p5.hot, wHot = p7.hot;
    if (!sHot && !wHot) return null;
    const col = (sHot && p5.col === RED) || (wHot && p7.col === RED) ? RED : AMBER;
    const label = sHot && wHot ? "both" : sHot ? "session" : "weekly";
    let lever;
    if (fam === "Opus") lever = "try Sonnet";
    else if (mine > 1) lever = `close ${mine - 1} sess`;
    else if (cache < 0.85) lever = "warm cache";
    else if (sHot && p5.breakMin <= 45) lever = `break ~${Math.max(1, p5.breakMin)}m`;
    else lever = "wrap up"; // no switch left to flip — stop cleanly before the wall
    const heat = col === RED ? "running hot" : "running a little hot";
    return { text: `${label} — ${lever}`, phrase: `${label} ${heat} — ${lever}`, col };
  }
  // Context colour fires on whichever wall arrives first: a share of the window (small windows) or
  // a hard coin count (1M windows, where 65% is already 650k — long past the point of restarting).
  // Red at 500k = the driver's own line for "/fenix instead of carrying this context further".
  const ctxCol = (total >= 500_000 || ctxPct >= 85) ? RED : (total >= 350_000 || ctxPct >= 65) ? AMBER : DIM;
  // WHOSE numbers these are (the session login's handle via the accounts map), so a multi-login box
  // is legible at a glance. Lives at the LEFT edge of the meta row, not the right: the right side is
  // the first thing a half-width pane cuts, and the handle is the one field you can't infer from the
  // rest of the row. It's a live link to the dash (OSC 8); plain text on terminals without it.
  const who = (() => {
    try {
      const c = JSON.parse(readFileSync(path.join(HOME, ".maxx", "config.json"), "utf8"));
      const h = c.accounts?.[sessAccount]?.handle || c.handle;
      return h && h !== "unknown" ? "@" + h : "";
    } catch { return ""; }
  })();

  // Narrow terminal: no rails — one line that PACKS in priority order and stops when the width runs
  // out, instead of cliffing to the same two numbers on every small pane. Order is decision-value:
  // the two walls first, then the context number (the /fenix trigger), then which pane this even is.
  // The rails themselves survive down to ~70 cols (the meter floor is 20 cells + a 46-cell label and
  // badge budget, and the optional badges already drop themselves via fits()), so hand off there.
  if (cols < 70) {
    const cand = [
      fg(DIM, "sess ") + fg(qcol, qv),
      fg(DIM, "week ") + fg(wcol, wv),
      total > 0 ? fg(ctxCol, tkf(total)) : null,
      sid ? fg(DIM, String(sid).slice(0, 4)) : null,
      branch ? fg(DIM, trunc(branch, 18)) : null,
      who ? fg(BRAND, who) : null,
    ].filter(Boolean);
    let l = "";
    for (const seg of cand) {
      const add = (l ? fg(DIM, " · ") : "") + seg;
      if (dispWidth(l) + dispWidth(add) > cols - 2) break; // priority order — once one won't fit, stop
      l += add;
    }
    process.stdout.write(padLine(l, cols) + "\n");
    return;
  }

  // ── quiet rail: borderless, airy, lowercase, calm. no frame — every line is just the dark
  //    panel bg, indented, so it reads as one soft band, not a box.
  const PAD = 2; // margin pulled left so the bars run wide and the movement is easy to feel
  const W = Math.max(40, cols - PAD * 2 - 2); // -2 = a right safety margin so nothing gets clipped
  // meter width: wide, but CAPPED so it can't swallow the whole line — always leave room for the
  // label before it and the (comma'd, up to ~16-char) cushion/over after it, plus a badge.
  // widen with the terminal: no fixed 90-cell cap (that left half a wide screen empty). Scale to
  // ~0.68 of the rail, leaving ~46 cells for the label + cushion/over + time-left + need/min badges.
  const mw = Math.max(20, Math.min(Math.round(W * 0.4), 64, W - 46));
  const row = (s) => padLine(blank(PAD) + s, cols); // one banded line, left-indented
  const fits = (s, add) => dispWidth(s) + dispWidth(add) <= W; // only append if the row can hold it

  // ODOMETER — every shown number counts toward its target by AT MOST ±1 (in display units, k) per
  // render: the ones digit rolls before the tens, values NEVER jump. Slow to calibrate after a big move,
  // by design. First sight snaps (no count-up from 0). State persists per-key in odo.json across renders.
  const odoPath = path.join(HOME, ".maxx", "odo.json");
  const odo = readJSON(odoPath, {});
  const step1 = (key, targetK) => {
    const k = (sid || "s") + ":" + key; // per-session → concurrent panes each step on their OWN repaints
    const t = Math.round(targetK);
    const p = Number.isFinite(odo[k]) ? odo[k] : t;
    const gap = t - p;
    // ±1 per frame for the odometer roll on normal moves; FAST catch-up on a big swing so a huge jump
    // doesn't take minutes (which made the number lie vs the instant bar). >40k gap → close ~1/3 per frame.
    const d = Math.abs(gap) <= 1 ? gap : Math.abs(gap) > 40 ? Math.round(gap * 0.34) : Math.sign(gap);
    const nxt = p + d;
    odo[k] = nxt;
    return nxt;
  };
  const kstr = (kv) => Math.round(Math.abs(kv)).toLocaleString("en-US") + "k"; // signed value already in k

  // a wall's row, plain-language. SESSION: "X to spend" — your sustainable allowance for THIS window
  // (realMax − used); counts down as you burn, climbs back after a break. Negative → "over — ease
  // off" (you're starting to eat future weeks). WEEKLY: "X left" — the reserve. + time left.
  const meterContent = (label, u, e, uv, isSession, stat) => {
    // SESSION bar IS the directional standing fill (one bar: green-from-left when banked, red-from-right
    // when over). WEEK keeps the fuel tank (bar = weekly reserve LEFT, draining as you spend).
    const standing = isSession && stat && stat.cap ? Math.round(stat.cap - stat.used) : 0;
    // red scales to the hard 5h wall: over-room = rawCap − realMax (paced share → lockout). Falls back to
    // the paced share when there's no soft buffer (realMax already == the raw wall).
    const overRoom = isSession && stat ? Math.max(1, (stat.rawCap || stat.cap || 0) - (stat.cap || 0)) : 1;
    let s = fg(DIM, label) + (isSession && stat && stat.cap
      ? netBar(standing, stat.cap, overRoom, mw)
      : fuelMeter(1 - u, e, mw));
    if (stat && stat.cap) {
      if (isSession) {
        // signed standing: banked → "+Xk" (ink), over → "−Xk" (red). The sign IS the meaning — no "over"
        // word. Odometer-counted (fast-jump on big swings, else ±1k) — bar snaps, number rolls to catch up.
        const standK = step1("sess", standing / 1000);
        const over_ = standK < 0;
        const d = fg(DIM, "  ") + fg(over_ ? zoneCol(u, e) : INK, (over_ ? "−" : "+") + kstr(standK));
        if (fits(s, d)) s += d;
        // trailing rate = refill − recent (5-MIN) burn, SIGN and COLOR follow the NET itself.
        // This is the one net every surface shows (dash, card, agent budget all use
        // five/300 − burn_5m/5). NOT burn60/standing-signed: a 60-second window flips to
        // "+banking" on a single quiet second while the 5-min trend is still burning, and
        // signing by standing hid a real burn behind a positive cushion. Honest > cushioned.
        const prog = netPerMin;
        if (Math.abs(prog) >= 500) {
          const pos = prog >= 0;
          const pr = fg(DIM, "  ·  ") + fg(pos ? GREEN : RED, (pos ? "+" : "−") + tkf(prog) + "/min");
          if (fits(s, pr)) s += pr;
        }
      } else {
        // WEEK line answers ONE question: am I over? LEFT = tokens remaining against the
        // weekly cap — that IS the over/under answer (LEFT > 0 → not over). The second token
        // is a PACE signal, not the budget: bank = cap7×elapsed − used7 = ahead of / behind a
        // straight-line burn through the week. It used the word "over" in RED — the same word
        // and colour the fleet-killing cap verdict uses — so a −3.6M pace wobble against a 289M
        // week (1.3%, noise) read as "you breached your weekly cap" while 91% of the tank
        // remained. Fixed: "ahead pace"/"behind pace" (never "over"), AMBER not RED (RED belongs
        // only to the real verdict), and dead-banded so a sub-5%-of-cap wobble prints nothing.
        const leftK = step1("wkleft", stat.headroom / 1000);
        const d = fg(DIM, "  ") + fg(INK, kstr(leftK)) + fg(DIM, " left"); if (fits(s, d)) s += d;
        // pace token (weekPaceToken): decided on the RAW bank so it's deterministic; the
        // odometer only rolls the shown digits. See pace.mjs for why it's never "over"/red.
        const pace = weekResetOk ? weekPaceToken(cap7s * e7 - used7, cap7s) : null;
        if (pace) {
          const b = fg(DIM, "  ·  ") + fg(pace.role === "good" ? GREEN : AMBER, (pace.ahead ? "+" : "−") + pace.pct + "% pace");
          if (fits(s, b)) s += b;
        }
        if (stat.resetIn) { const d = fg(DIM, "  ·  ") + fg(DIM, stat.resetIn); if (fits(s, d)) s += d; }
      }
    } else if (uv) { const d = fg(DIM, "  ") + fg(wcol, uv) + fg(DIM, " used"); if (fits(s, d)) s += d; } // no cap → raw %
    return s;
  };

  // one calm meta line, lowercase, airy dot separators. ctx + cache carry contextual color.
  // The session tag is the FIRST 4 chars of this session's id — the exact same slice the
  // owner-dashboard feed tags a row with when 2+ sessions share a project (handler.mjs
  // `String(e.root).slice(0,4)`). Two agents in one directory now name themselves: read the
  // tag here, match it to the burning row there. Only shown when we know the session id.
  // Order: model · last-turn coins · context coins · branch · session-id. Signed with the login
  // handle at the right (footStr). Colour rides the last-turn number (vs its own recent average)
  // and the context size. Cache %, $ cost, and the ctx % are dropped — noise the driver can't act on.
  // last-turn coins — colour compares it against the last 10 turns of THIS session (▲ dearer).
  const hist = turnHistory(sid, lastTurns(p.transcript_path, 10), total);
  let lastSeg = "";
  if (hist.length >= 1) {
    const win = hist.slice(-10);
    const avg = win.reduce((x, y) => x + y, 0) / win.length;
    const last = hist[hist.length - 1];
    const r = avg > 0 ? last / avg : 1;
    const lCol = r >= 1.35 ? RED : r >= 1.12 ? AMBER : r <= 0.88 ? GREEN : DIM;
    // "65k/72 turns" — last turn's coins over how many turns this session has run. The pair is
    // what makes the context number add up: turns × typical turn ≈ where the context sits.
    lastSeg = fg(lCol, tkf(last)) + fg(DIM, "/" + hist.length + " turn" + (hist.length === 1 ? "" : "s"));
  }
  const dot = fg(DIM, "  ·  ");
  const segs = [];
  if (who) segs.push(link(`https://meetmaxx.co/u/${who.slice(1)}/dash`, fg(BRAND, who)));
  segs.push(fg(DIM, fam.toLowerCase()));
  if (lastSeg) segs.push(lastSeg);
  if (total > 0) segs.push(fg(ctxCol, tkf(total)) + fg(DIM, " session"));
  if (branch) segs.push(fg(DIM, trunc(branch, 34)));
  if (sid) segs.push(fg(DIM, "id " + String(sid).slice(0, 4)));
  // padLine never truncates — an over-wide row WRAPS and breaks the rail into five lines. A long
  // branch name on a half-width pane is enough to do it, so drop segments off the tail until it fits.
  while (segs.length > 1 && dispWidth(segs.join(dot)) > W) segs.pop();
  let metaRow = segs.join(dot);

  // coach pulled for now — the meters + cushion/over carry it. keep /maxx as a quiet sign-off at
  // the right of the stats line; it's the one thing here that's fine to lose on a narrow pane.
  const footStr = fg(DIM, "/maxx");
  const metaFull = dispWidth(metaRow) + 3 + dispWidth(footStr) <= W
    ? metaRow + blank(W - dispWidth(metaRow) - dispWidth(footStr)) + footStr
    : metaRow;

  const out = [
    // "session" — the rolling-5h fuel tank (weekly-left ÷ windows-left, capped at the raw 5h wall; banks
    // when you go light). "week" — the weekly reserve. Labels padded to equal width so the bars align.
    row(meterContent("session  ", q5, e5, qv, true, sStat)),
    row(""), // one air line so the two rails don't fuse into one blob
    row(meterContent("week     ", w7, e7, wv, false, wStat)),
    // the 5h wall: Claude has stopped you anyway — same contemplation link as the dash
    ...(haveQuota && quota >= 0.99 ? [row(
      fg(RED, "you hit the session wall — time for some contemplation → ")
      + link("https://www.youtube.com/watch?v=linlz7-Pnvw", fg(BRAND, "Swiss Alps in 8K"))
      + (sStat.resetIn ? fg(DIM, " · back in " + sStat.resetIn) : ""),
    )] : []),
    row(metaFull),
  ];
  try { writeFileSync(odoPath, JSON.stringify(odo)); } catch {} // persist the odometer counters for next render
  process.stdout.write(out.join("\n") + "\n");
}
// The statusline is the product's face, and it is rendered by a hook: if this process throws,
// Claude Code shows NOTHING — no bar, no error — and the user concludes maxx is broken with no
// way to find out why. Any corrupt file under ~/.maxx (truncated write, disk full, a permission
// change) can do it. Fail visibly and cheaply instead: one line the user can act on, exit 0 so
// the hook itself is never the thing that looks broken.
try {
  main();
} catch (e) {
  process.stdout.write(`maxx: statusline error — ${String(e && e.message || e).slice(0, 120)}\n`);
  process.stderr.write(`maxx render failed: ${e && e.stack || e}\n`);
}
