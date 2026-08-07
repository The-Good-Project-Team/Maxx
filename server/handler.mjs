/**
 * maxx tally server — transport-agnostic request handler.
 *
 * Serves BOTH surfaces from one store, keyed by user handle:
 *   REST  (laptop emit.mjs):
 *     POST /api/u/:handle/logs      → ingest an envelope
 *     GET  /api/u/:handle/budget    → read the budget
 *   MCP   (account-wide cloud connector, Streamable HTTP / JSON-RPC 2.0):
 *     POST /mcp[?handle=]           → initialize | tools/list | tools/call
 *       tools: maxx_emit(envelope)  → same as POST logs
 *              maxx_budget()        → same as GET budget
 *
 * Storage-agnostic (inject a store adapter) and clock-injectable (for tests).
 * The Netlify function and a local node http server are both thin wrappers.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { applyEnvelope, computeBudget, transitionEvents, addDirective, pendingDirectives, logOp, autoAdvise, anchorAgeSec, ANCHOR_TRUST_SEC } from "./tally.mjs";
import { probeAnchor } from "./probe.mjs";

const TOOLS = [
  {
    name: "maxx_emit",
    description: "Report this session's token-usage metadata (counts only, never content) to the central maxx budget tally. Call at checkpoints during a long run and once at the end. A cloud routine cannot read /usage, so leave `anchor` unset.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", description: "User handle (budget owner)." },
        surface: { type: "string", description: "e.g. cloud:<routine-or-session-id>" },
        sessions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              root: { type: "string" }, project: { type: "string" },
              name: { type: "string" }, branch: { type: "string" },
              billed: { type: "integer" }, output: { type: "integer" }, turns: { type: "integer" },
              by_model: { type: "object" },
              first_ts: { type: "string" }, last_ts: { type: "string" },
            },
            required: ["root", "billed"],
          },
        },
        anchor: { type: ["object", "null"] },
      },
      required: ["surface", "sessions"],
    },
  },
  {
    name: "maxx_budget",
    description: "Read the current omni-surface subscription budget from the central maxx tally: verdict (ok/degraded/over/stale/calibrating — degraded = no fresh /usage anchor, weekly standing still live, proceed on the weekly numbers; calibrating = account has never been anchored, hard stop until a Claude Code session runs), session_to_spend (tokens SAFE to use now — weekly-paced, capped at the 5h wall, nets reserves), session_burst (the top of the coin-spree band, ≥ safe), coin_spree_low / coin_spree_high (the safe spend band for THIS window — 85–97% of the ESTIMATED Anthropic 5h room, since we set the weekly tank but only estimate their 5h window from their %; a hint, not a promise — Anthropic's real wall may cut in sooner), net_per_min (sustainable weekly pace − recent burn: + = under pace, − = over pace), sustainable_per_min (weekly reserve ÷ time to reset), weekly_left_tokens, and the 5h/weekly reset clocks. Plan agent work against session_to_spend; session_burst is the ceiling if you must exceed pace (it eats future weeks). A negative net_per_min means you're spending faster than sustainable — re-check before each expensive step.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { handle: { type: "string" } },
    },
  },
  {
    name: "maxx_reserve",
    description: "Reserve part of session_to_spend before spawning agents, so concurrent dispatchers don't double-spend the same allowance. Granted leases subtract from the session_to_spend other callers see and auto-expire at ttl_sec. Returns {granted, lease_id, remaining}. Call before a fan-out; size tokens to the fleet you're about to spawn. Pass your existing lease_id to RENEW: the old lease is replaced by the new grant (resize/extend) instead of stacking. When the fan-out completes, call maxx_release — the spend has landed via emits, so a lingering lease double-throttles everyone else until TTL.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        handle: { type: "string" },
        tokens: { type: "integer", description: "Tokens to reserve" },
        ttl_sec: { type: "integer", description: "Lease lifetime (default 3600)" },
        label: { type: "string", description: "Who/what this lease is for" },
        lease_id: { type: "string", description: "Your existing lease to replace (renew/resize) instead of stacking a new one" },
      },
      required: ["tokens"],
    },
  },
  {
    name: "maxx_release",
    description: "Release a reservation lease when the fan-out it guarded completes (or is cancelled). The tokens actually spent are already in the tally via maxx_emit; releasing returns the UNSPENT hold to session_to_spend immediately instead of after TTL. Returns {ok, released}.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        handle: { type: "string" },
        lease_id: { type: "string", description: "The lease_id maxx_reserve returned" },
      },
      required: ["lease_id"],
    },
  },
  {
    name: "maxx_directive",
    description:
      "Send a command to a specific live session (or '*' broadcast) through the fleet command plane. " +
      "Actions: pause (deny that session's expensive tool calls until ttl or resume — use to throttle a runaway or protect budget), " +
      "resume (lift pauses), clear (advise the session to /clear — injected as context when its context is bloated). " +
      "Target sessions come from maxx_budget top_burners or the feed. Delivery + consumption are audited in the feed.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        handle: { type: "string" },
        session: { type: "string", description: "Target session id, or '*' for all" },
        action: { type: "string", enum: ["clear", "pause", "resume"] },
        note: { type: "string", description: "Why — shown to the target session" },
        ttl_sec: { type: "integer", description: "Directive lifetime (default 3600, max 86400)" },
        surface: { type: "string", description: "Optional surface filter, e.g. laptop:abc123" },
      },
      required: ["session", "action"],
    },
  },
];

// meetmaxx.co favicon — served from api.meetmaxx.co too, and advertised in serverInfo.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(265 60% 94%)"/><text x="32" y="47" text-anchor="middle" font-family="ui-monospace,'SF Mono',Menlo,Consolas,monospace" font-size="44" font-weight="700" fill="hsl(264 66% 54%)">m</text></svg>`;

// Browser callers (the meetmaxx.co signup form) live on a different origin than the API — open
// CORS is safe here: auth is the bearer/`?k=` secret, never cookies, and only usage metadata moves.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };

// ---- live card page (GET /u/{handle}) ------------------------------------------------------
const fmtN = (n) => Math.round(n).toLocaleString("en-US");
const humanN = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n)));
// ---- range series for the chart toggle: hourly / daily / monthly / all time.
// Buckets are computed server-side so pages embed aggregates only, never raw events.
// Shared by the public card and the owner dashboard — one source for the bucket math.
function usageRanges(s) {
  const rawOf = (e) => e.raw || e.billed || 0;
  const lifetime = s.events.reduce((a, e) => a + rawOf(e), 0);
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const humanDay = (t) => { const d = new Date(t); return `${MO[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const evs = s.events.filter((e) => e.ts > 0).map((e) => ({ ts: e.ts * 1000, v: rawOf(e) }));
  const nowMs = Date.now();
  const bucketed = (startMs, stepMs, count, fmt) => {
    const vals = new Array(count).fill(0), labels = [];
    for (let i = 0; i < count; i++) labels.push(fmt(startMs + i * stepMs));
    for (const e of evs) { const i = Math.floor((e.ts - startMs) / stepMs); if (i >= 0 && i < count) vals[i] += e.v; }
    return { labels, vals };
  };
  const HOUR = 3600e3, DAY = 86400e3;
  const hourStart = Math.floor(nowMs / HOUR) * HOUR - 47 * HOUR;
  const dayStart = Math.floor(nowMs / DAY) * DAY - 29 * DAY;
  const fmtHour = (t) => `${humanDay(t)} ${String(new Date(t).getUTCHours()).padStart(2, "0")}:00`;
  // monthly: last 12 calendar months (UTC), irregular steps → bucket by month key
  const monthly = (() => {
    const nowD = new Date(nowMs);
    const keys = [], labels = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - i, 1));
      keys.push(d.toISOString().slice(0, 7));
      labels.push(`${MO[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`);
    }
    const vals = new Array(12).fill(0);
    for (const e of evs) { const i = keys.indexOf(new Date(e.ts).toISOString().slice(0, 7)); if (i >= 0) vals[i] += e.v; }
    return { labels, vals };
  })();
  // all time: dense daily since first event so idle days show as dips, not skipped
  const firstTs = evs.length ? Math.min(...evs.map((e) => e.ts)) : nowMs;
  const allDays = Math.max(2, Math.floor((Math.floor(nowMs / DAY) * DAY - Math.floor(firstTs / DAY) * DAY) / DAY) + 1);
  const RANGES = {
    hourly: { ...bucketed(hourStart, HOUR, 48, fmtHour), sub: "tokens · last 48 hours" },
    daily: { ...bucketed(dayStart, DAY, 30, humanDay), sub: "tokens · last 30 days" },
    monthly: { ...monthly, sub: "tokens · last 12 months" },
    all: { ...bucketed(Math.floor(firstTs / DAY) * DAY, DAY, allDays, humanDay), sub: "lifetime tokens" },
  };
  // embed-ready form (rounded vals, no extra fields)
  const json = JSON.stringify(Object.fromEntries(Object.entries(RANGES).map(([k, r]) => [k, { labels: r.labels, vals: r.vals.map((v) => Math.round(v)), sub: r.sub }])));
  return { lifetime, RANGES, json };
}

// Chart drawing + range-pill wiring, shared verbatim by card and dash. Expects in scope:
// R (ranges object), pill buttons in #ranges, svg paths #cLine/#cArea/#cDots, #peak,
// #capL/#capR, #chart/#tip/#guide, and an onDraw(key, total, sub) callback for the hero.
const CHART_JS = `
  var cur='all',labels=[],vals=[];
  var hum=function(n){return n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':''+n};
  var _svg=document.getElementById('cSvg');
  var W=+_svg.getAttribute('data-w')||1080,H=+_svg.getAttribute('data-h')||150;
  function draw(key){
    cur=key;var r=R[key];labels=r.labels;vals=r.vals;
    var n=Math.max(2,vals.length),peak=Math.max.apply(null,[1].concat(vals));
    var pts=vals.map(function(v,i){return [(i*W/(n-1)),(H-(v/peak)*(H-10)-4)]});
    var line='M'+pts.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1)}).join('L');
    document.getElementById('cLine').setAttribute('d',line);
    document.getElementById('cArea').setAttribute('d',line+'L'+W+','+H+'L0,'+H+'Z');
    document.getElementById('cDots').innerHTML=n<=60?pts.map(function(p){
      return '<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.5" fill="#5b52e8" stroke="#fff" stroke-width="1"/>'}).join(''):'';
    // peak label pins top-right (design spec) — never clips, never collides with the line
    var pi=vals.indexOf(Math.max.apply(null,vals)),pk=document.getElementById('peak');
    if(vals[pi]>0){pk.style.display='block';pk.textContent='peak '+hum(vals[pi])+' · '+labels[pi];}
    else pk.style.display='none';
    document.getElementById('capL').textContent=labels[0]||'';
    document.getElementById('capR').textContent=key==='hourly'?'now':labels[labels.length-1]||'today';
    var total=vals.reduce(function(a,v){return a+v},0);
    onDraw(key,total,r.sub,total/Math.max(1,vals.length),vals[pi]||0);
    var bs=document.querySelectorAll('#ranges button');
    for(var i=0;i<bs.length;i++)bs[i].className=bs[i].getAttribute('data-r')===key?'on':'';
  }
  document.getElementById('ranges').addEventListener('click',function(ev){
    var k=ev.target.getAttribute&&ev.target.getAttribute('data-r');if(k)draw(k);
  });
  draw('all');
  var chart=document.getElementById('chart'),tip=document.getElementById('tip'),guide=document.getElementById('guide');
  chart.addEventListener('mousemove',function(ev){
    var r=chart.getBoundingClientRect(),x=ev.clientX-r.left;
    var i=Math.max(0,Math.min(labels.length-1,Math.round(x/r.width*(labels.length-1))));
    var cx=i/(labels.length-1)*r.width;
    tip.style.display='block';tip.style.left=Math.max(60,Math.min(r.width-60,cx))+'px';tip.style.top='34px';
    tip.textContent=labels[i]+' · '+hum(vals[i])+' tokens';
    guide.style.display='block';guide.style.left=cx+'px';
  });
  chart.addEventListener('mouseleave',function(){tip.style.display='none';guide.style.display='none';});
`;

// The chart markup the CHART_JS above drives — same skeleton on card and dash,
// geometry per page (the card runs a taller hero chart than the dash).
const chartHtml = (w = 1080, h = 150, accent = "#5b52e8") => `
  <svg id="cSvg" data-w="${w}" data-h="${h}" width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;height:${h > 200 ? "250px" : "auto"}">
   <defs><linearGradient id="areaG" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${accent}" stop-opacity="0.16"/><stop offset="100%" stop-color="${accent}" stop-opacity="0.05"/>
   </linearGradient></defs>
   <path id="cArea" d="" fill="url(#areaG)"/>
   <path id="cLine" d="" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
   <g id="cDots"></g>
  </svg>
  <div class="guide" id="guide"></div><div class="tip" id="tip"></div>
  <div class="peak" id="peak" style="display:none"></div>`;
const RANGE_PILLS = `<button data-r="hourly">Hourly</button><button data-r="daily">Daily</button><button data-r="monthly">Monthly</button><button data-r="all" class="on">All time</button>`;

function renderCard(h, s, b, setup = null) {
  // hero = RAW lifetime (the number a human recognizes); weighted units stay on the weekly row.
  const rawOf = (e) => e.raw || e.billed || 0;
  const { lifetime, json: rangesJson } = usageRanges(s);
  // bars data (initial paint; live.json tick keeps it current). Stale/calibrating
  // honesty markers ride in the bar text — same semantics the old rows carried.
  const bars0 = JSON.stringify({
    five_billed: b.five_billed, available: b.session_to_spend, week: b.week, quota: b.quota,
    weekly_left: b.weekly_left_tokens, session_over: b.session_over, burn_5m: b.burn_5m,
    week_billed: b.week_billed, week_bank: b.week_bank, net_per_min: b.net_per_min,
    week_reset_in_sec: b.week_reset_in_sec, fresh: b.fresh, anchor_age_sec: b.anchor_age_sec,
    verdict: b.verdict,
  });
  // badge: "live" only when data actually flows; a retired handle says so
  const lastEvt = s.events.reduce((a, e) => (e.ts > a ? e.ts : a), 0);
  const idleDays = lastEvt ? (Date.now() / 1000 - lastEvt) / 86400 : Infinity;
  const badge = idleDays < 2 ? "✓ Verified usage · live" : `✓ Verified usage · idle ${Math.round(idleDays)}d`;
  // where it burns: lifetime split by surface class (public — classes and magnitudes only)
  const bySurf = new Map();
  for (const e of s.events) { const k = String(e.surface || "unknown").split(":")[0]; bySurf.set(k, (bySurf.get(k) || 0) + rawOf(e)); }
  const surfSplit = [...bySurf.entries()].sort((a, b2) => b2[1] - a[1])
    .map(([k, v]) => `${k} ${lifetime ? Math.round(v / lifetime * 100) : 0}% (${humanN(v)})`).join(" · ");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  // the SHAREABLE page is the dash — viewers without the secret get it name-redacted
  const url = `https://meetmaxx.co/u/${h}/dash`;
  // owner-only setup panel (present when the page was opened with ?k=<secret>)
  const agoTxt = (sec) => sec == null ? "never" : sec < 90 ? `${sec}s ago` : sec < 5400 ? `${Math.round(sec / 60)}m ago` : sec < 172800 ? `${Math.round(sec / 3600)}h ago` : `${Math.round(sec / 86400)}d ago`;
  // ok: true | false | "warn" — "warn" is degraded-but-working (amber), so a tenant whose
  // laptop simply sleeps at night doesn't see a red ❌ on a healthy install.
  const setupRow = (ok, label, ago, fix) =>
    `<li><span>${ok === true ? "✅" : ok === "warn" ? "⚠️" : "❌"} <b>${label}</b> <span class="sub">· ${agoTxt(ago)}</span></span>${ok === true ? "" : `<span class="fix">${fix}</span>`}</li>`;
  const setupHtml = !setup ? "" : `
 <div class="setup"><h3>Setup check <span class="sub">— only you can see this (opened with your secret)</span></h3><ul>
  ${setupRow(setup.cli.ok, "Claude CLI shipping", setup.cli.ago, `run: <code>curl -fsSL https://meetmaxx.co/install | MAXX_HANDLE=${h} MAXX_SECRET=&lt;your-secret&gt; bash</code>`)}
  ${setupRow(setup.connector.ok, "claude.ai connector", setup.connector.ago, `add the connector at <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">claude.ai → Connectors</a> (name Maxx, your mcp URL)`)}
  ${setupRow(setup.anchor.ok, "Anchor fresh (/usage)", setup.anchor.ago, setup.anchor.ok === "warn"
    ? `no machine has read /usage recently, so budget runs on the weekly ledger only (verdict "degraded" — agents still work). Open a Claude Code session on any linked machine to re-anchor.`
    : `open a Claude Code session on the linked machine — the statusline ships the authoritative %`)}
 </ul></div>`;
  const desc = `${humanN(lifetime)} lifetime Claude tokens · live tally, anchored to Anthropic /usage · verified by Maxx`;
  const shareTxt = `${humanN(lifetime)} lifetime Claude tokens, verified by @meetmaxx`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h} — Verified coin usage · Maxx</title>
<meta property="og:title" content="${h} — verified Claude coin usage">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Maxx">
<meta property="og:image" content="https://meetmaxx.co/og-card.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="Maxx — verified Claude coin usage, every machine and cloud session">
<meta property="og:image:width" content="2400"><meta property="og:image:height" content="1260">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${h} — verified Claude coin usage">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="https://meetmaxx.co/og-card.png">
<link rel="icon" href="https://meetmaxx.co/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#eceef3;--card:#fff;--line:#e7e9f0;--ink:#132038;--ink-2:#3a4356;--ink-25:#6c7688;--ink-3:#98a1b2;--accent:#5b52e8;--green:#159a52;--red:#c23a3a;--sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;--mono:'JetBrains Mono',ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;gap:22px}
.card{width:1180px;max-width:100%;background:var(--card);border-radius:26px;box-shadow:0 30px 70px -30px rgba(20,28,55,.30),0 4px 16px rgba(20,28,55,.06);padding:44px 52px 40px;display:flex;flex-direction:column}
.top{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:23px;letter-spacing:-.01em}
.brand .m{color:var(--accent);font-size:24px;font-weight:700}
.who{font-family:var(--mono);font-size:17px;color:var(--ink-25);font-weight:400}
.badge{display:inline-flex;align-items:center;gap:7px;background:#ecebfb;color:var(--accent);border-radius:999px;padding:9px 16px;font-size:15px;font-weight:600}
.livepill{display:inline-flex;align-items:center;gap:8px;background:#eaf7ef;color:#178a4e;font-weight:600;font-size:13.5px;padding:8px 14px;border-radius:999px}
.livepill .ldot{width:8px;height:8px;border-radius:50%;background:#2fb768;animation:pulse 1.6s ease-in-out infinite}
.klabel{font-size:12px;font-weight:700;letter-spacing:.1em;color:var(--ink-3);font-family:var(--mono)}
.cmeta{font-family:var(--mono);font-size:13px;color:#8a93a5;margin-left:auto}
.hero{margin-top:24px;display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}
.hero .n{font-size:clamp(38px,7vw,84px);font-weight:800;letter-spacing:-.03em;line-height:.92;font-variant-numeric:tabular-nums}
.hero .l{color:var(--ink-25);font-size:20px;padding-bottom:8px}
.ranges{margin-top:24px;display:flex;gap:10px;flex-wrap:wrap}
.ranges button{border:1px solid #e4e6ee;background:#fff;color:#5a6478;border-radius:999px;padding:8px 18px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--sans)}
.ranges button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.chart{margin-top:18px;position:relative}
.chart .cap{display:flex;justify-content:space-between;align-items:center;gap:10px;color:var(--ink-3);font-size:14.5px;margin-top:8px}
.chart .cap span:nth-child(2){color:var(--ink-25)}
.peak{position:absolute;top:6px;right:4px;font-size:14.5px;color:var(--ink);font-weight:600;white-space:nowrap;z-index:2}
/* ONE grid for both rows (bars are display:contents) so the session and week
   tracks share column widths — sized per-row, the longer number string shrank
   its own track and the two rails no longer lined up. */
.bars{margin-top:20px;background:#f0f0fa;border-radius:14px;padding:18px 20px;font-family:var(--mono);font-size:14.5px;display:grid;grid-template-columns:64px minmax(120px,1fr) auto;gap:14px 15px;align-items:center}
.bar{display:contents}
.bar .lab{color:#8a93a5}
.bar .track{height:16px;background:#e3e2f4;border-radius:5px;position:relative;overflow:hidden}
.bar.hot .track{border-right:5px solid #d23b3b}
.bar.hot .fill{background:linear-gradient(90deg,#f2b8b5,#d23b3b)}
.bar .fill{position:absolute;top:0;bottom:0;left:0;background:linear-gradient(90deg,#9be3b0,#4fbe7e 55%,#159a52);border-radius:5px}
.bar .num{color:var(--ink-2);white-space:nowrap}
.bar .num b{color:var(--ink);font-weight:700}
.bar .num .good{color:var(--green);font-weight:700}
.bar .num .bad{color:var(--red);font-weight:700}
.foot{margin-top:24px;display:flex;justify-content:space-between;align-items:baseline;color:var(--ink-3);font-size:14.5px;gap:10px;flex-wrap:wrap}
.foot .lt{font-family:var(--mono);font-size:13px}
.foot a{color:var(--accent);font-weight:600;text-decoration:none}
.share{display:flex;gap:14px}
.share button,.share a{border:1px solid #e2e4ec;background:#fff;color:var(--ink-2);border-radius:12px;padding:12px 24px;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;font-family:var(--sans)}
.share .primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700;box-shadow:0 8px 20px -8px rgba(91,82,232,.7)}
.tip{position:absolute;pointer-events:none;display:none;background:#152036;color:#fff;font-family:var(--mono);font-size:13.5px;font-weight:500;padding:8px 13px;border-radius:9px;white-space:nowrap;transform:translate(-50%,-130%);z-index:3}
.guide{position:absolute;top:0;bottom:28px;width:1.5px;background:#c7c3f2;display:none;pointer-events:none;z-index:1}
.setup{margin-top:18px;background:#f4f5fa;border-radius:14px;padding:18px 22px}
.setup h3{font-size:15.5px;font-weight:700;color:var(--ink)}
.setup ul{list-style:none;margin-top:10px;font-size:15px}
.setup li{display:flex;justify-content:space-between;gap:14px;padding:6px 0;flex-wrap:wrap}
.setup .sub{color:var(--ink-3)}
.setup .fix{color:var(--ink-2);font-size:13.5px}
.setup code{font-family:var(--mono);font-size:12.5px;background:#e9ebf3;padding:2px 6px;border-radius:6px}
.feed{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}
.feed h3{font-size:12px;color:var(--ink-3);font-weight:700;letter-spacing:.1em;text-transform:uppercase;display:flex;align-items:center;gap:10px;font-family:var(--mono)}
.feed h3 .dot{width:10px;height:10px;border-radius:50%;background:#2fb768;animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.82)}}
.feed ul{list-style:none;margin-top:10px;font-family:var(--mono);font-size:15.5px;color:var(--ink-2)}
.feed li{display:flex;justify-content:space-between;padding:5px 0}
.feed li b{color:var(--ink);font-weight:700;font-size:16.5px}
.feed .sub{color:var(--ink-3)}
@media (max-width:640px){
.hero .n{font-size:34px}.badge{font-size:12.5px;padding:5px 12px}.peak{display:none}
.card{padding:26px 20px 22px}
.chart .cap span:nth-child(2){display:none}
.bars{padding:12px 14px;font-size:12px;grid-template-columns:52px minmax(60px,1fr);gap:10px}
.bar .num{grid-column:1/-1;white-space:normal}
}
@media(prefers-color-scheme:dark){
:root{color-scheme:dark;--bg:#0d1420;--card:#171f30;--ink:#e7eaf3;--ink-2:#c2c9d6;--ink-3:#727c93;--line:#29334c;--accent:#8079f2}
.card{box-shadow:0 30px 70px -30px rgba(0,0,0,.55),0 4px 16px rgba(0,0,0,.30)}
.bars{background:#1e2740}
.bar .track{background:#2c3652}
.badge{background:#231f4d}
.livepill{background:#16281d}
.setup{background:#1b2333;border-color:#29334c}
.ranges button{background:#1b2333;border-color:#2c3652}
.ranges button.on{background:var(--accent);border-color:var(--accent)}
}
</style></head><body>
<div class="card">
 <div class="top">
  <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h}</span></div>
  <span style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
   <span class="badge">${badge}</span>
   <span class="livepill"><span class="ldot"></span> live</span>
  </span>
 </div>
 <div class="hero"><div class="n" id="hero">${fmtN(lifetime)}</div><div class="l" id="heroSub">lifetime coins</div></div>
 <div class="ranges" id="ranges">${RANGE_PILLS}<span class="cmeta" id="cMeta"></span></div>
 <div class="chart" id="chart">${chartHtml(1000, 260)}
  <div class="cap"><span id="capL"></span><span>all machines &amp; cloud · this Claude account</span><span id="capR">today</span></div>
 </div>
 <div class="bars" id="bars"></div>
${setupHtml}
 <div class="feed"><h3><span class="dot"></span> live feed</h3><ul id="feed"><li><span class="sub">listening…</span></li></ul></div>
 <div class="foot">
  <span class="lt">⌵ Verified by Maxx — counted from session logs, anchored to Anthropic /usage · <span id="stamp">${stamp}</span></span>
  <a href="https://meetmaxx.co">See your usage at meetmaxx.co →</a>
 </div>
</div>
<div class="share">
 <button class="primary" id="sh">Share</button>
 <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(shareTxt)}&url=${encodeURIComponent(url)}" target="_blank" rel="noopener">Post on X</a>
 <button id="cp">Copy link</button>
</div>
<script>
document.getElementById('sh').addEventListener('click',function(){
  if(navigator.share)navigator.share({title:document.title,text:"${shareTxt}",url:"${url}"}).catch(function(){});
  else{navigator.clipboard.writeText("${url}");this.textContent="Copied";}
});
document.getElementById('cp').addEventListener('click',function(){navigator.clipboard.writeText("${url}");this.textContent="Copied";setTimeout(()=>this.textContent="Copy link",1500);});
// range toggle + chart: draw the selected series client-side (hourly/daily/monthly/all time)
(function(){
  var R=${rangesJson};
  var LIFE=${Math.round(lifetime)};
  function onDraw(key,total,sub,avg,pk){
    document.getElementById('hero').textContent=(key==='all'?LIFE:total).toLocaleString('en-US');
    document.getElementById('heroSub').textContent=sub;
    var hm=function(n){return n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'k':''+Math.round(n)};
    document.getElementById('cMeta').textContent=avg>0?'avg '+hm(avg)+' · peak '+hm(pk):'';
  }
${CHART_JS}
  window.__setLife=function(n){LIFE=n;if(cur==='all')document.getElementById('hero').textContent=Math.round(n).toLocaleString('en-US')};
})();
// live feed: poll the public counts-only endpoint; one row PER CHANNEL (cloud, machine 1, …),
// not per turn — tick the hero odometer + session/week bars in place
(function(){
  var feed=document.getElementById('feed');
  var hum=function(n){return n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':''+n};
  var ago=function(s){return s<60?s+'s':s<3600?Math.round(s/60)+'m':s<86400?Math.round(s/3600)+'h':Math.round(s/86400)+'d'};
  var kf=function(n){return Math.round(n/1000).toLocaleString('en-US')+'k'};
  // IDENTICAL semantics + geometry to the dash renderBudget — session is the netBar
  // (green from left = banked standing, red from right = over), week is the fuel tank
  // (fill = what's LEFT, ╎ even-pace tick). Numbers: signed STANDING (available, not
  // used) + net rate (sustainable weekly pace − recent burn, sign follows the NET). One ruler.
  var GRAD={green:'linear-gradient(90deg,#9be3b0,#4fbe7e 55%,#159a52)',amber:'linear-gradient(90deg,#f4d9a6,#e0a93e 55%,#c98a12)'};
  function renderBars(d){
    var bar=function(lab,spec,num){
      var g=Math.max(0,Math.min(100,(spec.green||0)*100));
      var r=Math.max(0,Math.min(100,(spec.red||0)*100));
      var tick=spec.tick!=null?Math.max(0,Math.min(100,spec.tick*100)):null;
      return '<div class="bar"><span class="lab">'+lab+'</span><span class="track">'+
        (g>=0.5?'<span class="fill" style="width:'+g.toFixed(1)+'%;background:'+GRAD[spec.col||'green']+'"></span>':'')+
        (r>=0.5?'<span class="fill" style="left:auto;right:0;width:'+r.toFixed(1)+'%;background:linear-gradient(270deg,#f2b8b5,#d23b3b)"></span>':'')+
        (tick!=null?'<span style="position:absolute;left:'+tick.toFixed(1)+'%;top:0;bottom:0;width:2px;background:#152036;z-index:2"></span>':'')+
        '</span><span class="num">'+num+'</span></div>';
    };
    // never anchored → neutral setup state, not red deficits
    if(d.verdict==='calibrating'){
      document.getElementById('bars').innerHTML=
        bar('session',{green:0},'<span style="color:#98a1b2">calibrating</span>')+
        bar('week',{green:0},'<span style="color:#98a1b2">open a Claude Code session to anchor caps</span>');
      return;
    }
    // "stale" is a hard-stop word now; a sleeping laptop is "degraded" and the weekly
    // numbers on this card are still real. Say which one it actually is.
    var vw=d.verdict==='degraded'?'degraded':'stale';
    var stale=!d.fresh?(d.anchor_age_sec!=null?' · '+vw+' · anchored '+ago(d.anchor_age_sec)+' ago':' · '+vw):'';
    var calib=d.week!=null&&d.week<0.05?' · calibrating':'';
    // net = sustainable weekly pace − burn (server-computed, one ruler with dash/statusline)
    var prog=d.net_per_min!=null?d.net_per_min:0,up=prog>=0;
    var avail=d.available!=null?d.available:0,over=d.session_over||0,banked=avail>0;
    var sNum=(banked?'+'+kf(avail):'<span class="bad">−'+kf(over)+'</span>')+
      (Math.abs(prog)>=500?' · <span class="'+(up?'good':'bad')+'">'+(up?'+':'−')+kf(Math.abs(prog))+'/min</span>':'')+stale;
    var bank=d.week_bank;
    var wNum=(d.weekly_left!=null?kf(d.weekly_left)+' left':'—')+
      (bank!=null?(bank>=0?' · <span class="good">+'+kf(bank)+' banked</span>':' · <span class="bad">−'+kf(-bank)+' over</span>'):'')+
      (d.week_reset_in_sec!=null?' · '+ago(d.week_reset_in_sec):'')+calib;
    // session netBar: standing / realMax (green), over / room-to-lockout (red)
    var realMax=(d.five_billed||0)+avail-over;
    var fiveCap=d.quota>0?(d.five_billed||0)/d.quota:null;
    var overRoom=fiveCap&&fiveCap>realMax?fiveCap-realMax:Math.max(realMax,1);
    var sSpec={green:realMax>0?avail/realMax:0,red:over/overRoom,col:'green'};
    // week fuel tank: fill = LEFT, pace tick from bank, CLI color thresholds
    var weekCap=(d.week_billed||0)+(d.weekly_left||0);
    var leftFrac=weekCap>0?(d.weekly_left||0)/weekCap:0;
    var wTick=weekCap>0&&bank!=null?Math.min(1,Math.max(0,((d.weekly_left||0)-bank)/weekCap)):null;
    var wRatio=wTick!=null&&wTick>0.02?leftFrac/wTick:1;
    var wCol=(leftFrac<0.1||wRatio<0.5)?'red':wRatio<0.85?'amber':'green';
    document.getElementById('bars').innerHTML=
      bar('session',sSpec,sNum)+bar('week',{green:leftFrac,tick:wTick,col:wCol},wNum);
  }
  renderBars(${bars0});
  // odometer: creep the hero at the REAL burn rate between polls (burn_5m/300 tok/s),
  // snap up to server truth on each poll. Moving = actually burning; idle = honest still.
  var odo={cur:null,rate:0};
  setInterval(function(){
    if(odo.cur!=null&&odo.rate>0&&window.__setLife){odo.cur+=odo.rate/8;window.__setLife(odo.cur);}
  },125);
  function tick(){
    fetch('/u/${h}/live.json').then(function(r){return r.json()}).then(function(j){
      if(j.lifetime&&window.__setLife){
        odo.cur=odo.cur==null?j.lifetime:Math.max(odo.cur,j.lifetime);
        odo.rate=(j.burn_5m||0)/300;
        window.__setLife(odo.cur);
      }
      if(j.five_billed!=null)renderBars(j);
      if(j.feed&&j.feed.length)feed.innerHTML=j.feed.slice(0,8).map(function(e){
        return '<li><span>'+e.channel+' · '+ago(e.ago_sec)+' ago</span><b>'+(e.tokens_1h>0?'+'+hum(e.tokens_1h)+' <span class="sub">/1h</span>':'<span class="sub">idle</span>')+'</b></li>';}).join('');
      document.getElementById('stamp').textContent=new Date().toLocaleString([],{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    }).catch(function(){});
  }
  tick();setInterval(tick,15000);
})();
setTimeout(function(){location.reload()},300000);
</script>
</body></html>`;
}

// ---- owner dashboard (GET /u/{handle}/dash?k={secret}) ------------------------------------
// "What's running right now, and where is the budget going" — top_burners carry session and
// project NAMES, so this page is owner-only: no valid ?k= → 401, nothing rendered.
// The shell is static; the data comes from the already-authed /api endpoints (budget + feed),
// polled every 10s, so the page and the API can never disagree.
// Unauthenticated dash hit → paste-your-secret form. POSTs the secret in the request
// BODY to /api/u/:h/login (never a URL), gets the HttpOnly cookie back, reloads.
function renderLogin(h) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h} — owner login · Maxx</title>
<meta name="robots" content="noindex">
<link rel="icon" href="https://meetmaxx.co/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#eceef3;--card:#fff;--line:#edeef4;--ink:#132038;--ink-2:#2a3346;--ink-3:#98a1b2;--accent:#5b52e8;--sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;--mono:'JetBrains Mono',ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:440px;max-width:100%;background:var(--card);border-radius:26px;box-shadow:0 30px 70px -30px rgba(20,28,55,.30),0 4px 16px rgba(20,28,55,.06);padding:36px 40px}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:21px;letter-spacing:-.01em}
.brand .m{color:var(--accent);font-size:22px;font-weight:700}
.who{font-family:var(--mono);font-size:15px;color:var(--ink-3);font-weight:400}
p{color:var(--ink-2);font-size:14.5px;margin-top:14px;line-height:1.5}
input{width:100%;margin-top:16px;padding:11px 14px;border:1px solid #e3e2f4;background:#f6f6fb;border-radius:12px;font-family:var(--mono);font-size:14px;color:var(--ink)}
input:focus{outline:none;border-color:var(--accent);background:#fff}
button{width:100%;margin-top:12px;padding:12px;border:none;border-radius:12px;background:var(--accent);color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--sans)}
button:hover{filter:brightness(1.08)}
.err{color:#c23a3a;font-size:13.5px;margin-top:10px;display:none}
.hint{color:var(--ink-3);font-size:12.5px;margin-top:12px}
.hint code{font-family:var(--mono);background:#f0f0fa;padding:2px 6px;border-radius:6px;font-size:11.5px}
.or{color:var(--ink-3);font-size:12.5px;margin-top:18px}
.cmd{display:flex;align-items:center;gap:10px;margin-top:8px;padding:10px 12px;background:#f0f0fa;border:1px solid #e3e2f4;border-radius:12px;cursor:pointer;transition:border-color .12s}
.cmd:hover{border-color:var(--accent)}
.cmd .ct{font-family:var(--mono);font-size:12.5px;color:var(--ink-2);overflow-x:auto;white-space:nowrap;flex:1}
.cmd .cp{font-family:var(--sans);font-size:11px;font-weight:600;color:var(--accent);background:#fff;border:1px solid #e3e2f4;border-radius:7px;padding:3px 8px;flex-shrink:0}
@media(prefers-color-scheme:dark){
:root{color-scheme:dark;--bg:#0d1420;--card:#171f30;--ink:#e7eaf3;--ink-2:#c2c9d6;--ink-3:#8b94a8;--accent:#8079f2}
.card{box-shadow:0 30px 70px -30px rgba(0,0,0,.55),0 4px 16px rgba(0,0,0,.30)}
input{background:#1b2333;border-color:#2c3652}
input:focus{background:#0d1420}
.hint code{background:#232c40}
.cmd{background:#1b2333;border-color:#2c3652}
.cmd .cp{background:#0d1420;border-color:#2c3652}
}
</style></head><body>
<form class="card" id="f">
 <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h} · owner dashboard</span></div>
 <p>Paste your secret to sign in. It's sent once in the request body and stored as an HttpOnly cookie — it never appears in a URL.</p>
 <input id="s" type="password" placeholder="your maxx secret" autocomplete="current-password" autofocus>
 <button>Sign in</button>
 <div class="err" id="err">Wrong secret.</div>
 <div class="or">No secret handy? Open it straight from your terminal — one command, nothing to paste:</div>
 <div class="cmd" id="cmd" title="click to copy"><span class="ct">node ~/.claude/skills/maxx/emit.mjs --dash</span><span class="cp" id="cp">copy</span></div>
 <div class="hint">It mints a single-use link and opens your dashboard. The secret above still lives in <code>~/.maxx/config.json</code>.</div>
</form>
<script>
document.getElementById('f').addEventListener('submit',function(ev){
  ev.preventDefault();
  fetch('/api/u/${h}/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({secret:document.getElementById('s').value.trim()})})
  .then(function(r){if(r.ok)location.replace('/u/${h}/dash');else document.getElementById('err').style.display='block';})
  .catch(function(){document.getElementById('err').style.display='block';});
});
document.getElementById('cmd').addEventListener('click',function(){
  var cmd=document.querySelector('#cmd .ct').textContent,cp=document.getElementById('cp');
  var done=function(){cp.textContent='copied';setTimeout(function(){cp.textContent='copy';},1400);};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(cmd).then(done).catch(done);}
  else{var r=document.createRange();r.selectNodeContents(document.querySelector('#cmd .ct'));var sel=getSelection();sel.removeAllRanges();sel.addRange(r);try{document.execCommand('copy');}catch(e){}done();}
});
</script>
</body></html>`;
}

// Owner settings — the control surface: fleet directives (pause/resume/clear per live
// session), runaway thresholds, webhooks. Mutations ride the auth cookie + same-origin
// Origin header (see mutAuthed); nothing here is reachable without the owner secret.
function renderSettings(h, s, b) {
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cfg = s.config || {};
  const burners = (b.top_burners || []).filter((a) => a.tokens_1h > 0);
  const fleetRows = burners.map((a) => `
   <tr><td><b>${esc(a.name || a.project || (a.session || "").slice(0, 8))}</b> <span class="mono">${esc((a.session || "").slice(0, 8))}</span></td>
   <td class="mono">${esc(a.surface)}</td><td class="num">${a.rate_5m > 0 ? Math.round(a.rate_5m / 1000) + "k/5m" : "idle"}</td>
   <td class="act"><button data-s="${esc(a.session)}" data-a="pause">pause</button><button data-s="${esc(a.session)}" data-a="resume">resume</button><button data-s="${esc(a.session)}" data-a="clear">clear</button></td></tr>`).join("");
  const hookRows = (s.webhooks || []).map((w) => `
   <tr><td class="mono">${esc(w.url)}</td><td>${esc(w.format || "json")}</td>
   <td class="act"><button data-del="${esc(w.url)}">remove</button></td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h} — settings · Maxx</title>
<meta name="robots" content="noindex">
<link rel="icon" href="https://meetmaxx.co/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#eceef3;--card:#fff;--line:#edeef4;--ink:#132038;--ink-2:#2a3346;--ink-25:#6c7688;--ink-3:#98a1b2;--accent:#5b52e8;--green:#178a4e;--red:#c23a3a;--sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;--mono:'JetBrains Mono',ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;padding:24px;display:flex;flex-direction:column;align-items:center;gap:14px}
.card{width:1100px;max-width:100%;background:var(--card);border-radius:26px;box-shadow:0 30px 70px -30px rgba(20,28,55,.30),0 4px 16px rgba(20,28,55,.06);padding:36px 42px 30px}
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:21px;letter-spacing:-.01em}
.brand .m{color:var(--accent);font-size:22px;font-weight:700}
.who{font-family:var(--mono);font-size:16px;color:var(--ink-25);font-weight:400}
.top a{color:var(--accent);font-weight:600;text-decoration:none;font-size:14px}
${TABS_CSS}
h2{font-size:12px;color:var(--ink-3);font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:28px;font-family:var(--mono)}
h2 .sub{text-transform:none;letter-spacing:0;font-weight:400;font-family:var(--sans);font-size:12.5px}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13.5px}
th{text-align:left;color:var(--ink-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;padding:6px 8px;border-bottom:1px solid var(--line);font-family:var(--mono)}
td{padding:8px;border-bottom:1px solid #f0f1f6;font-variant-numeric:tabular-nums}
td.mono{font-family:var(--mono);font-size:12.5px;color:var(--ink-25)}
td.num{text-align:right;font-family:var(--mono);font-size:12.5px;color:var(--ink-25)}
td.act{text-align:right;white-space:nowrap}
button{border:1px solid #e3e2f4;background:var(--card);color:var(--ink-2);border-radius:9px;padding:6px 13px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--sans);margin-left:6px;transition:border-color .15s,color .15s}
button:hover{border-color:var(--accent);color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{color:#fff;filter:brightness(1.08)}
input{padding:8px 12px;border:1px solid #e3e2f4;background:#f6f6fb;border-radius:9px;font-family:var(--mono);font-size:13px;color:var(--ink)}
input:focus{outline:none;border-color:var(--accent);background:#fff}
.row{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
.row label{font-size:13.5px;color:var(--ink-2);min-width:220px}
input{max-width:100%}
#hookUrl{flex:1 1 260px;min-width:0}
@media(max-width:640px){td.act{white-space:normal}td.act button{margin:3px 0 3px 6px}}
.empty{color:var(--ink-3);padding:10px;font-size:13.5px}
.note{color:var(--ink-3);font-size:12.5px;margin-top:8px}
.flash{display:none;margin-left:10px;font-size:13px;font-weight:600;font-family:var(--mono)}
.flash.ok{color:var(--green)}.flash.err{color:var(--red)}
@media(prefers-color-scheme:dark){
:root{color-scheme:dark;--bg:#0d1420;--card:#171f30;--ink:#e7eaf3;--ink-2:#c2c9d6;--ink-25:#929cb0;--ink-3:#727c93;--line:#29334c;--accent:#8079f2}
.card{box-shadow:0 30px 70px -30px rgba(0,0,0,.55),0 4px 16px rgba(0,0,0,.30)}
input{background:#1b2333;border-color:#2c3652}
input:focus{background:#0d1420}
button{background:#171f30;border-color:#2c3652}
button:hover{border-color:var(--accent)}
td{border-bottom-color:#222b40}
}
</style></head><body>
<div class="card">
 <div class="top">
  <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h} · settings</span></div>
  <span><a href="/u/${h}">public card</a></span>
 </div>
 ${tabsHtml(h, "settings", true)}

 <h2>Fleet control <span class="sub">— live sessions (last hour); directives deliver on the session's next gate poll</span></h2>
 <table><thead><tr><th>Session</th><th>Surface</th><th style="text-align:right">Rate</th><th></th></tr></thead>
 <tbody id="fleet">${fleetRows || '<tr><td colspan="4" class="empty">nothing burning in the last hour</td></tr>'}</tbody>
 <tbody><tr><td><b>ALL SESSIONS</b> <span class="mono">broadcast</span></td><td></td><td></td>
  <td class="act"><button data-s="*" data-a="pause">pause all</button><button data-s="*" data-a="resume">resume all</button></td></tr></tbody></table>
 <span class="flash" id="fleetFlash"></span>

 <h2>Runaway detection <span class="sub">— sustained burn that trips the runaway webhook event</span></h2>
 <div class="row"><label>Rate threshold (coins / 5 min)</label><input id="rrate" value="${cfg.runaway_rate_5m ?? 500000}" size="12"></div>
 <div class="row"><label>Sustained for (minutes)</label><input id="rmin" value="${cfg.runaway_min ?? 10}" size="12"></div>
 <div class="row"><button class="primary" id="cfgSave">Save</button><span class="flash" id="cfgFlash"></span></div>

 <h2>Webhooks <span class="sub">— push on over / recovered / week-80/90/95 / runaway</span></h2>
 <table><thead><tr><th>URL</th><th>Format</th><th></th></tr></thead>
 <tbody id="hooks">${hookRows || '<tr><td colspan="3" class="empty">none registered</td></tr>'}</tbody></table>
 <div class="row"><input id="hookUrl" placeholder="https://…" size="46"><input id="hookFmt" placeholder="json | dash" size="10"><button class="primary" id="hookAdd">Add</button><span class="flash" id="hookFlash"></span></div>
 <div class="note">Directives, thresholds and webhooks act account-wide for @${h}. Session/project names on this page never appear publicly.</div>
</div>
<script>
if(location.search)history.replaceState(null,'',location.pathname);
(function(){
  var flash=function(id,ok,msg){var f=document.getElementById(id);f.className='flash '+(ok?'ok':'err');f.textContent=msg;f.style.display='inline';setTimeout(function(){f.style.display='none'},2500)};
  var post=function(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})};
  document.addEventListener('click',function(ev){
    var b=ev.target;
    if(b.dataset&&b.dataset.s&&b.dataset.a){
      post('/api/u/${h}/directive',{session:b.dataset.s,action:b.dataset.a,note:'from settings'}).then(function(r){
        flash('fleetFlash',r.ok,r.ok?b.dataset.a+' sent':'failed: '+(r.j.error||''));});
    }
    if(b.dataset&&b.dataset.del){
      fetch('/api/u/${h}/webhooks',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({url:b.dataset.del})})
        .then(function(r){if(r.ok)location.reload();else flash('hookFlash',false,'failed');});
    }
  });
  document.getElementById('cfgSave').addEventListener('click',function(){
    post('/api/u/${h}/config',{runaway_rate_5m:Number(document.getElementById('rrate').value),runaway_min:Number(document.getElementById('rmin').value)})
      .then(function(r){flash('cfgFlash',r.ok,r.ok?'saved':'failed: '+(r.j.error||''))});
  });
  document.getElementById('hookAdd').addEventListener('click',function(){
    post('/api/u/${h}/webhooks',{url:document.getElementById('hookUrl').value.trim(),format:document.getElementById('hookFmt').value.trim()||null})
      .then(function(r){if(r.ok)location.reload();else flash('hookFlash',false,'failed: '+(r.j.error||''))});
  });
})();
</script>
</body></html>`;
}

// Owner dashboard = the Maxx Cockpit (claude.ai/design 'Maxx Cockpit' spec), two panes:
// LEFT = live burn cockpit — CLI-spec statusline bars, burn-rate trio, tokens/min chart
// (last 48 min), pace-vs-even gauges, source + model split, active sessions, channels.
// RIGHT = the activity tail (emits + ops), CLI-style. Every panel renders from real
// tally data (budget + feed + ops, 10s poll) — nothing simulated.
// PUBLIC (no-secret) reads of the dash data: magnitudes stay, content goes. Labels are
// stable within one response (same session/surface → same anonymous name) so charts and
// boards still line up; session/project names, branches, surface ids, and directive
// text never leave without the secret.
function publicAnon() {
  const surf = new Map(); let mi = 0, ci = 0;
  const sess = new Map(); let si = 0;
  return {
    surface: (x) => {
      const k = String(x || "?");
      if (!surf.has(k)) surf.set(k, k.split(":")[0] === "cloud" ? `cloud ${++ci}` : `machine ${++mi}`);
      return surf.get(k);
    },
    root: (x) => {
      const k = String(x || "?");
      if (!sess.has(k)) sess.set(k, `session-${++si}`);
      return sess.get(k);
    },
  };
}

// ---- week-vs-wall series: cumulative weighted burn across the CURRENT weekly window,
// against the anchored cap — "usage over time relative to the limit". Hourly buckets,
// summed server-side from the ledger; the cap and used come from computeBudget so the
// chart shares one ruler with the verdict (the Jul 23 postmortem: the bar and the wall
// must be the same line). null cap → the card says "calibrating" instead of guessing.
function weekWallSeries(s, nowS) {
  const b = computeBudget(s, nowS);
  const end = b.week_reset || nowS;
  const start = end - 7 * 86400;
  const hours = Math.max(1, Math.ceil((Math.min(nowS, end) - start) / 3600));
  const vals = new Array(hours).fill(0);
  for (const e of s.events) {
    if (e.ts <= start || e.ts > nowS + 60) continue;
    const i = Math.min(hours - 1, Math.floor((e.ts - start) / 3600));
    vals[i] += e.billed || 0;
  }
  let c = 0;
  const cum = vals.map((v) => Math.round((c += v)));
  // week-window attribution: billed by project and by model (events carry both).
  const byProject = new Map(), byModel = new Map();
  for (const e of s.events) {
    if (e.ts <= start || e.ts > nowS + 60) continue;
    const pj = e.project || String(e.surface || "?").split(":")[0];
    byProject.set(pj, (byProject.get(pj) || 0) + (e.billed || 0));
    for (const m in e.by_model || {}) byModel.set(m, (byModel.get(m) || 0) + (Number(e.by_model[m]) || 0));
  }
  const top = (map, n) => {
    const rows = [...map.entries()].sort((a, b2) => b2[1] - a[1]);
    const head = rows.slice(0, n).map(([k, v]) => [k, Math.round(v)]);
    const rest = rows.slice(n).reduce((a2, [, v]) => a2 + v, 0);
    if (rest > 0) head.push(["other", Math.round(rest)]);
    return head;
  };
  return {
    start, end, now: nowS, cum, cap: b.week_cap_tokens, used: b.week_used_tokens, pct: b.week,
    projAt: b.projected_wall_at, rate: b.burn_6h_per_min,
    byProject: top(byProject, 6), byModel: top(byModel, 6),
  };
}

// tab strip shared by the dash / analytics / settings pages. Settings is owner-only.
const TABS_CSS = `
.tabs{display:flex;gap:4px;margin-top:16px;border-bottom:1px solid var(--line)}
.tabs a{padding:9px 16px;font-size:13.5px;font-weight:600;color:var(--ink-25);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a.on{color:var(--accent);border-bottom-color:var(--accent)}
.tabs a:hover{color:var(--accent)}`;
const tabsHtml = (h, on, owner) => `
 <div class="tabs">
  <a href="/u/${h}/dash"${on === "overview" ? ' class="on"' : ""}>overview</a>
  <a href="/u/${h}/analytics"${on === "analytics" ? ' class="on"' : ""}>analytics</a>
  ${owner ? `<a href="/u/${h}/settings"${on === "settings" ? ' class="on"' : ""}>settings</a>` : ""}
 </div>`;

// WEEK VS THE WALL — cumulative burn across the current weekly window against the
// anchored cap (red dash) and the even-pace diagonal (grey dots). Server-embedded at
// render; the wall and the line share computeBudget's ruler by construction.
// Markup + JS as helpers so any page (analytics today) can mount it; the JS expects
// esc/hum/clockAt in scope and the ww* element ids from the markup.
const WW_HTML = `
  <div style="position:relative;margin-top:12px" id="wwWrap">
   <svg id="wwSvg" width="100%" viewBox="0 0 1080 190" preserveAspectRatio="none" style="display:block;border-radius:6px"></svg>
   <div class="guide48" id="wwGuide"></div>
  </div>
  <div class="axis48"><span id="wwL"></span><span id="wwM"></span><span id="wwR"></span></div>
  <div class="tip48" id="wwTip"></div>`;
const wwJs = (ww) => `
  var WW=${JSON.stringify(ww)};
  (function(){
    var meta=document.getElementById('wwMeta');
    if(!WW||!WW.cap||!WW.cum.length){if(meta)meta.textContent='calibrating — needs a /usage anchor';return}
    var W=1080,H=190,P=8;
    var span=Math.max(1,WW.end-WW.start);
    var last=WW.cum[WW.cum.length-1];
    var ymax=Math.max(WW.cap,last)*1.06;
    var X=function(t){return (t-WW.start)/span*W},Y=function(v){return H-P-(v/ymax)*(H-2*P)};
    var pts=WW.cum.map(function(v,i){return X(WW.start+(i+1)*3600).toFixed(1)+','+Y(v).toFixed(1)});
    var capY=Y(WW.cap).toFixed(1);
    var line='M'+X(WW.start).toFixed(1)+','+Y(0).toFixed(1)+' L'+pts.join(' L');
    var g='<path d="'+line+' L'+X(WW.start+WW.cum.length*3600).toFixed(1)+','+Y(0).toFixed(1)+'Z" fill="#5b52e8" fill-opacity="0.07"/>';
    g+='<line x1="0" y1="'+Y(0)+'" x2="'+W+'" y2="'+Y(WW.cap).toFixed(1)+'" stroke="#98a1b2" stroke-width="1" stroke-dasharray="2 6"/>';
    g+='<line x1="0" y1="'+capY+'" x2="'+W+'" y2="'+capY+'" stroke="#c23a3a" stroke-width="1.5" stroke-dasharray="7 5"/>';
    g+='<path d="'+line+'" fill="none" stroke="#5b52e8" stroke-width="2.5" stroke-linejoin="round"/>';
    // projection: trailing-6h pace, dotted, from the line's tip. Red to an early wall
    // hit (server's projected_wall_at), grey to the reset when the pace makes the week.
    var tLast=WW.start+WW.cum.length*3600, projTxt='';
    if(WW.rate>0&&WW.pct<0.99&&tLast<WW.end){
      if(WW.projAt&&WW.projAt<WW.end){
        g+='<line x1="'+X(tLast).toFixed(1)+'" y1="'+Y(last).toFixed(1)+'" x2="'+X(WW.projAt).toFixed(1)+'" y2="'+capY+'" stroke="#c23a3a" stroke-width="2" stroke-dasharray="2 5"/>';
        g+='<circle cx="'+X(WW.projAt).toFixed(1)+'" cy="'+capY+'" r="5" fill="none" stroke="#c23a3a" stroke-width="2.5"/>';
        projTxt=' · at this pace: WALL '+new Date(WW.projAt*1000).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});
      }else{
        var vEnd=Math.min(ymax,last+WW.rate*((WW.end-tLast)/60));
        g+='<line x1="'+X(tLast).toFixed(1)+'" y1="'+Y(last).toFixed(1)+'" x2="'+X(WW.end).toFixed(1)+'" y2="'+Y(vEnd).toFixed(1)+'" stroke="#98a1b2" stroke-width="1.5" stroke-dasharray="2 5"/>';
        projTxt=' · at this pace: makes the week';
      }
    }
    if(WW.pct>=0.99)g+='<circle cx="'+X(WW.now).toFixed(1)+'" cy="'+capY+'" r="5" fill="#c23a3a"/>';
    document.getElementById('wwSvg').innerHTML=g;
    var used=WW.used!=null?WW.used:last;
    if(meta)meta.textContent=hum(used)+' of '+hum(WW.cap)+' cap · '+Math.round((WW.pct||used/WW.cap)*100)+'% · resets '+clockAt(WW.end-WW.now)+(WW.end-WW.now>86400?' +'+Math.floor((WW.end-WW.now)/86400)+'d':'')+projTxt;
    var dl=function(t){var d=new Date(t*1000);return d.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})};
    document.getElementById('wwL').textContent=dl(WW.start);
    document.getElementById('wwM').textContent=dl(WW.start+span/2);
    document.getElementById('wwR').textContent='reset '+dl(WW.end);
    var wrap=document.getElementById('wwWrap'),tip=document.getElementById('wwTip'),guide=document.getElementById('wwGuide');
    wrap.addEventListener('mousemove',function(ev){
      var r=wrap.getBoundingClientRect(),fx=(ev.clientX-r.left)/r.width;
      var i=Math.max(0,Math.min(WW.cum.length-1,Math.round(fx*span/3600)-1));
      var t=WW.start+(i+1)*3600,pace=WW.cap*(t-WW.start)/span,d=WW.cum[i]-pace;
      guide.style.display='block';guide.style.left=((t-WW.start)/span*100)+'%';
      tip.innerHTML=esc(dl(t)+' '+new Date(t*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))+' · <b>'+hum(WW.cum[i])+'</b> burned · '+(d<=0?'<span style="color:#15803d">'+hum(-d)+' under pace</span>':'<span style="color:#c2703a">'+hum(d)+' over pace</span>');
    });
    wrap.addEventListener('mouseleave',function(){guide.style.display='none';tip.textContent=''});
  })();`;

// Analytics — its own tab. The week-vs-wall line (usage over time relative to the
// limit) leads; the tokens-over-time ranges chart (hourly/daily/monthly/all) follows.
// Magnitudes only — no session/project names — so like the dash it serves a public
// (viewer) variant with identical numbers; owner just gets the settings tab.
function renderAnalytics(h, s, { owner = true, ww = null } = {}) {
  const { json: rangesJson } = usageRanges(s);
  // THIS WEEK breakdowns, rendered server-side (static per load, like the chart data).
  // Project names are owner-visible only — viewers get stable anonymous labels, same
  // contract as the shared dash. Model names aren't sensitive; shown to everyone.
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hbars = (rows, label) => {
    if (!rows || !rows.length) return `<div class="hEmpty">nothing this week yet</div>`;
    const max = Math.max(...rows.map((r) => r[1]), 1);
    const total = rows.reduce((a, r) => a + r[1], 0) || 1;
    return rows.map(([k, v]) => `
   <div class="hbar"><span class="hname" title="${esc(label(k))}">${esc(label(k))}</span>
    <span class="htrack"><span class="hfill" style="width:${(v / max * 100).toFixed(1)}%"></span></span>
    <span class="hval">${humanN(v)} · ${Math.round(v / total * 100)}%</span></div>`).join("");
  };
  let anonI = 0; const anonMap = new Map();
  const projLabel = (k) => {
    if (owner || k === "other" || k === "laptop" || k === "cloud") return k;
    if (!anonMap.has(k)) anonMap.set(k, `project ${++anonI}`);
    return anonMap.get(k);
  };
  const projBars = hbars(ww && ww.byProject, projLabel);
  const modelBars = hbars(ww && ww.byModel, (k) => k.replace(/^claude-/, ""));
  // the chart embed must NOT carry the attribution maps — raw project names inside the
  // page script would undo the anonymized labels above (caught by the render test).
  const { byProject: _bp, byModel: _bm, ...wwChart } = ww || {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${h} — analytics · Maxx</title>
<meta name="robots" content="noindex">
<link rel="icon" href="https://meetmaxx.co/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#eceef3;--card:#fff;--line:#edeef4;--ink:#132038;--ink-2:#2a3346;--ink-25:#6c7688;--ink-3:#98a1b2;--accent:#5b52e8;--green:#178a4e;--red:#c23a3a;--sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;--mono:'JetBrains Mono',ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;padding:24px;display:flex;flex-direction:column;align-items:center;gap:14px}
.card{width:1100px;max-width:100%;background:var(--card);border-radius:26px;box-shadow:0 30px 70px -30px rgba(20,28,55,.30),0 4px 16px rgba(20,28,55,.06);padding:36px 42px 30px}
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:21px;letter-spacing:-.01em}
.brand .m{color:var(--accent);font-size:22px;font-weight:700}
.who{font-family:var(--mono);font-size:16px;color:var(--ink-25);font-weight:400}
.top a{color:var(--accent);font-weight:600;text-decoration:none;font-size:14px}
.klabel{font-size:12px;font-weight:700;letter-spacing:.1em;color:var(--ink-3);font-family:var(--mono)}
${TABS_CSS}
.axis48{display:flex;justify-content:space-between;font-family:var(--mono);font-size:11.5px;color:#a3abba;margin-top:6px}
.tip48{min-height:19px;margin-top:4px;font-family:var(--mono);font-size:12.5px;font-weight:500;color:#5b6474;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.guide48{position:absolute;top:0;bottom:0;width:1.5px;background:#c7c3f2;display:none;pointer-events:none;z-index:1}
.ranges{margin-top:16px;display:flex;gap:10px;flex-wrap:wrap}
.ranges button{border:1px solid #e4e6ee;background:var(--card);color:#5a6478;border-radius:999px;padding:7px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--sans)}
.ranges button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.chart{margin-top:16px;position:relative}
.chart .cap{display:flex;justify-content:space-between;align-items:center;gap:10px;color:var(--ink-3);font-size:13.5px;margin-top:8px;font-family:var(--mono)}
.peak{position:absolute;top:6px;right:4px;font-size:13.5px;color:var(--ink);font-weight:600;white-space:nowrap;z-index:2;font-family:var(--mono)}
.tip{position:absolute;pointer-events:none;display:none;background:#152036;color:#fff;font-family:var(--mono);font-size:13px;font-weight:500;padding:8px 13px;border-radius:9px;white-space:nowrap;transform:translate(-50%,-130%);z-index:3}
.guide{position:absolute;top:0;bottom:28px;width:1.5px;background:#c7c3f2;display:none;pointer-events:none;z-index:1}
.split{display:grid;grid-template-columns:1fr 1fr;gap:34px;margin-top:28px}
@media(max-width:640px){.split{grid-template-columns:1fr}body{padding:12px}.card{padding:22px 16px 18px}.tabs a{padding:9px 11px}}
.hbar{display:grid;grid-template-columns:minmax(90px,150px) 1fr auto;gap:10px;align-items:center;font-size:13px;margin-top:9px}
.hname{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.htrack{display:block;background:#e9e9f6;border-radius:4px;height:13px;overflow:hidden}
.hfill{display:block;height:100%;border-radius:4px 0 0 4px;background:linear-gradient(90deg,#8d86ef,var(--accent))}
.hval{font-family:var(--mono);font-size:12px;color:var(--ink-25);white-space:nowrap}
.hEmpty{color:var(--ink-3);font-size:13px;margin-top:10px}
@media(prefers-color-scheme:dark){
.htrack{background:#252e47}
:root{color-scheme:dark;--bg:#0d1420;--card:#171f30;--ink:#e7eaf3;--ink-2:#c2c9d6;--ink-25:#929cb0;--ink-3:#727c93;--line:#29334c;--accent:#8079f2}
.card{box-shadow:0 30px 70px -30px rgba(0,0,0,.55),0 4px 16px rgba(0,0,0,.30)}
.ranges button{border-color:#2c3652}
}
</style></head><body>
<div class="card">
 <div class="top">
  <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h} · analytics</span></div>
  ${owner ? "" : `<a href="/u/${h}/dash?login=1">owner sign-in</a>`}
 </div>
 ${tabsHtml(h, "analytics", owner)}

 <div style="margin-top:24px">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
   <span class="klabel">WEEK VS THE WALL</span>
   <span style="font-family:var(--mono);font-size:13px;color:#8a93a5" id="wwMeta"></span>
  </div>
  ${WW_HTML}
 </div>

 <div class="split">
  <div>
   <div class="klabel">THIS WEEK · BY PROJECT</div>
   ${projBars}
  </div>
  <div>
   <div class="klabel">THIS WEEK · BY MODEL</div>
   ${modelBars}
  </div>
 </div>

 <div style="margin-top:28px">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
   <span class="klabel">TOKENS OVER TIME</span>
   <span style="font-family:var(--mono);font-size:13px;color:#8a93a5" id="rMeta"></span>
  </div>
  <div class="ranges" id="ranges">${RANGE_PILLS}</div>
  <div class="chart" id="chart">
   ${chartHtml(1080, 150)}
   <div class="cap"><span id="capL"></span><span id="capR"></span></div>
  </div>
 </div>
</div>
<script>
if(location.search)history.replaceState(null,'',location.pathname);
(function(){
  var esc=function(x){var d=document.createElement('span');d.textContent=x==null?'':String(x);return d.innerHTML};
  var hum=function(n){return n==null?'—':n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'k':''+Math.round(n)};
  var clockAt=function(fromNow){return new Date(Date.now()+fromNow*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})};
  ${wwJs(wwChart)}
  var R=${rangesJson};
  var onDraw=function(key,total,sub){document.getElementById('rMeta').textContent=sub+' · total '+hum(total)};
  ${CHART_JS}
})();
</script>
</body></html>`;
}

function renderDash(h, s, { owner = true } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${h} — ${owner ? "dash" : "live usage"} · Maxx</title>
<meta property="og:title" content="@${h} — live Claude token usage">
<meta property="og:description" content="Every machine, every cloud agent, one live tally — burn rate, budget rails, and the live activity tail.">
<meta property="og:url" content="https://meetmaxx.co/u/${h}/dash">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Maxx">
<meta property="og:image" content="https://meetmaxx.co/og-card.png">
<meta property="og:image:width" content="2400"><meta property="og:image:height" content="1260">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="@${h} — live Claude token usage">
<meta name="twitter:image" content="https://meetmaxx.co/og-card.png">
<meta name="robots" content="noindex">
<link rel="icon" href="https://meetmaxx.co/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#eceef3;--card:#fff;--line:#edeef4;--ink:#132038;--ink-2:#2a3346;--ink-25:#6c7688;--ink-3:#98a1b2;--accent:#5b52e8;--green:#178a4e;--amber:#c98a12;--red:#c23a3a;--sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;--mono:'JetBrains Mono',ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;padding:24px;display:flex;flex-direction:column;align-items:center;gap:14px}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;width:1780px;max-width:100%;align-items:stretch}
@media(max-width:1000px){.wrap{grid-template-columns:minmax(0,1fr)}}
.card{min-width:0;background:var(--card);border-radius:26px;box-shadow:0 30px 70px -30px rgba(20,28,55,.30),0 4px 16px rgba(20,28,55,.06);padding:36px 42px 30px}
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:21px;letter-spacing:-.01em}
.brand .m{color:var(--accent);font-size:22px;font-weight:700}
.who{font-family:var(--mono);font-size:16px;color:var(--ink-25);font-weight:400}
.top a{color:var(--accent);font-weight:600;text-decoration:none;font-size:14px}
${TABS_CSS}
.livepill{display:inline-flex;align-items:center;gap:8px;background:#eaf7ef;color:var(--green);font-weight:600;font-size:13.5px;padding:7px 13px;border-radius:999px}
.livepill .dot{width:8px;height:8px;border-radius:50%;background:#2fb768;animation:pulse 1.6s ease-in-out infinite}
.badge{display:inline-flex;align-items:center;border-radius:999px;padding:6px 13px;font-size:13.5px;font-weight:600;background:#ecebfb;color:var(--accent)}
.badge.over{background:#fdeeee;color:var(--red)}
.badge.stale,.badge.degraded,.badge.calibrating{background:#fdf6e7;color:var(--amber)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
.bars{margin-top:20px;background:#f0f0fa;border-radius:14px;padding:15px 18px;font-family:var(--mono);font-size:13.5px;display:flex;flex-direction:column;gap:12px}
.bar{display:grid;grid-template-columns:60px minmax(100px,1fr) 335px;gap:14px;align-items:center}
@media(max-width:1500px){.bar{grid-template-columns:60px minmax(100px,1fr) auto}}
@media(max-width:900px){.bar{grid-template-columns:60px minmax(80px,1fr) auto}}
.bar .lab{color:#8a93a5}
.bar .track{height:15px;background:#e3e2f4;border-radius:5px;position:relative;overflow:hidden}
.bar.hot .track{border-right:5px solid #d23b3b}
.bar.hot .fill{background:linear-gradient(90deg,#f2b8b5,#d23b3b)}
.bar .fill{position:absolute;top:0;bottom:0;left:0;background:linear-gradient(90deg,#9be3b0,#4fbe7e 55%,#159a52);border-radius:5px}
.bar .num{color:var(--ink-2);white-space:nowrap}
.bar .num b{color:var(--ink);font-weight:700}
.bar .num .good{color:var(--green);font-weight:700}
.bar .num .bad{color:var(--red);font-weight:700}
.klabel{font-size:12px;font-weight:700;letter-spacing:.1em;color:var(--ink-3);font-family:var(--mono)}
.warns{margin-top:12px;display:flex;flex-direction:column;gap:7px;font-family:var(--mono);font-size:12.5px}
.walert{padding:8px 13px;border-radius:9px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.walert b{font-weight:700}
.walert.red{background:#fdeeee;color:#b02f2f}
.walert.amber{background:#fdf6e7;color:#8f660e}
.walert.ok{background:#eaf7ef;color:#178a4e}
/* the wall row carries a link — it must never truncate into an unclickable ellipsis */
.walert.wrap{white-space:normal;overflow:visible;text-overflow:clip}
.walert.wrap a{text-decoration:underline}
/* The trio reflows on its OWN width, not the viewport's: on the landing page the dash is
   embedded beside the activity terminal, so the card is ~590px inside a 1230px viewport —
   a viewport media query never fires and three 42px numerals got cropped by the overflow
   clip below. auto-fit drops it to 2-up, then 1-up, wherever it is. The 1px gap over a
   --line background draws the dividers, so they stay right however the tiles wrap. */
.trio{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:1px;margin-top:20px;background:var(--line);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.trio>div{padding:18px 22px;background:var(--card);min-width:0}
.trio .big{display:flex;align-items:baseline;gap:7px;margin-top:9px;font-family:var(--mono)}
.trio .big .v{font-size:42px;font-weight:800;line-height:1;letter-spacing:-.02em;color:var(--ink)}
.trio .big .u{font-size:19px;font-weight:600;color:#8a93a5}
.trio .sub{font-family:var(--mono);font-size:13.5px;color:#8a93a5;margin-top:7px;overflow-wrap:anywhere}
.chart48{position:relative;height:170px;margin-top:12px}
.chart48 .zero{position:absolute;left:0;right:0;bottom:0;border-top:1.5px solid #d4d7e2;z-index:1}
.chart48 .avgline{position:absolute;left:0;right:0;border-top:1.5px dashed #e8b58a;z-index:2}
.chart48 .avglab{position:absolute;left:0;font-family:var(--mono);font-size:11px;color:#c2703a;background:#fff;padding:0 4px;z-index:3}
.chart48 .cols{position:absolute;inset:0;display:flex;gap:3px}
.chart48 .col{position:relative;flex:1}
/* Bars are TOKENS OUT per minute, grown from the bottom baseline. Orange once a
   minute crosses the sustainable pace line. (Was: net = pace − out, which pegged
   every idle minute at the ceiling and left the whole lower half of the box empty.) */
.chart48 .col .bar{position:absolute;left:0;right:0;bottom:0;border-radius:2px 2px 0 0;background:linear-gradient(0deg,#bfdbfe,#3b82f6);transition:height .6s ease}
.chart48 .col .bar.idle{background:#dfe3ec}
/* signed against pace: banked above the line, spent-over below it */
.chart48 .col .bar.pos{background:linear-gradient(0deg,#a7f3d0,#22c55e)}
.chart48 .col .bar.neg{background:linear-gradient(180deg,#fed7aa,#f97316);border-radius:0 0 2px 2px}
/* outside the fetched range — no baseline stub, so "no data" never reads as "idle" */
.chart48 .col.nodata{background:repeating-linear-gradient(135deg,transparent,transparent 5px,#eef0f5 5px,#eef0f5 6px);opacity:.65}
/* the live minute is marked by outline, not colour — colour now carries the sign */
.chart48 .col.live .bar{outline:1.5px solid #64748b;outline-offset:1px}
.chart48 .marks span{position:absolute;top:-2px;width:7px;height:7px;border-radius:50%;transform:translateX(-50%);z-index:2}
/* Sits INSIDE the chart box. It used to be translate(-50%,-110%) off top:36px, which
   lifted it clear out of the chart and over the "TOKENS / MIN" heading above. */
/* The hover readout used to be a floating dark card pinned inside the plot, which
   covered the bars it was describing. It reads BELOW the axis now — the height is
   reserved so nothing shifts when it appears — and a thin guide ties it to the
   hovered minute. */
.tip48{min-height:19px;margin-top:4px;font-family:var(--mono);font-size:12.5px;font-weight:500;color:#5b6474;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tip48 .pr{color:#b4801f}
.tip48 .mut{color:#98a1b0}
.guide48{position:absolute;top:0;bottom:0;width:1.5px;background:#c7c3f2;display:none;pointer-events:none;z-index:1}
.axis48{display:flex;justify-content:space-between;font-family:var(--mono);font-size:12.5px;color:#a3abba;margin-top:7px}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13.5px}
th{text-align:left;color:var(--ink-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;padding:6px 8px;border-bottom:1px solid var(--line);font-family:var(--mono)}
td{padding:8px;border-bottom:1px solid #f0f1f6;font-variant-numeric:tabular-nums}
td.mono{font-family:var(--mono);font-size:12.5px;color:var(--ink-25)}
td.num,th.num{text-align:right}
td b{font-weight:700}
.cmeta{font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-top:3px;letter-spacing:0}
/* a directive hangs under the channel it is waiting on, indented and quieter than the row above */
tr.dirrow td{background:#faf8f2;border-bottom:1px solid #f0f1f6;padding-left:22px;font-size:12px;line-height:1.5}
.empty{color:var(--ink-3);padding:10px;font-size:13.5px}
.foot{margin-top:22px;border-top:1px solid #e7e9f0;padding-top:14px;color:var(--ink-3);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
.foot .lt{font-family:var(--mono)}
.foot a{color:var(--accent);font-weight:600;text-decoration:none}
.term{background:#0b1220;border-radius:26px;border:1px solid #1c2740;padding:0;display:flex;flex-direction:column;position:sticky;top:24px;max-height:calc(100vh - 48px);min-height:420px;min-width:0}
.term .thead{display:flex;align-items:center;gap:8px;padding:15px 20px;border-bottom:1px solid #1c2740;color:#8ea3c0;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-family:var(--mono)}
.term .thead .dot{width:8px;height:8px;border-radius:50%;background:#2fb768;animation:pulse 1.6s ease-in-out infinite}
.term .lines{overflow-y:auto;padding:12px 18px 16px;font-family:var(--mono);font-size:12px;line-height:1.8;flex:1}
.term .ln{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.term .t{color:#5b6e8c}
.term .s{color:#7dd3fc}
.term .v{color:#4ade80;font-weight:600}
.term .p{color:#e2e8f0}
.term .d{color:#8ea3c0}
.term .o{color:#fbbf24;font-weight:600}
.term .chip{display:inline-block;padding:0 6px;border-radius:4px;background:#16213a;font-weight:600}
.term .cx{color:#8ea3c0}
.term .cx.warn{color:#fbbf24;font-weight:600}
.term .cx.hot{color:#fb7185;font-weight:700}
.term .insight{padding:10px 20px;border-bottom:1px solid #1c2740;font-family:var(--mono);font-size:12px;color:#fbbf24;background:#131b30;display:none}
.term .insight b{color:#fb7185}
@media(max-width:640px){
body{padding:12px}
.card{padding:22px 16px 18px}
.bar{grid-template-columns:52px minmax(60px,1fr);gap:10px}
.bar .num{grid-column:1/-1;white-space:normal}
/* source/model/session splits: drop the decorative track bar, let values wrap —
   the fixed name + nowrap value column was pushing the page past the viewport */
table{font-size:12px;min-width:480px}
.walert{white-space:normal;overflow:visible;text-overflow:clip}
.tabs a{padding:9px 11px}
.term{position:static;max-height:60vh}
}
/* Dark mode — additive: only overrides glaring light surfaces, so light mode is
   untouched. Structural colors ride the vars; the neutral panel/track fills and
   status tints get dark equivalents. Data-viz gradients read fine on both. */
@media(prefers-color-scheme:dark){
:root{color-scheme:dark;--bg:#0d1420;--card:#171f30;--ink:#e7eaf3;--ink-2:#c2c9d6;--ink-25:#929cb0;--ink-3:#727c93;--line:#29334c;--accent:#8079f2}
.card{box-shadow:0 30px 70px -30px rgba(0,0,0,.55),0 4px 16px rgba(0,0,0,.30)}
.bars{background:#1e2740}
.bar .track{background:#2c3652}
.chart48 .zero{border-top-color:#39435e}
.chart48 .cols div{filter:none}
td{border-bottom-color:#222b40}
.foot{border-top-color:#29334c}
.badge{background:#231f4d}
.badge.over{background:#3a1f24}.badge.stale,.badge.degraded,.badge.calibrating{background:#382f1a}
.livepill{background:#16281d}
.walert.red{background:#331b1e;color:#f0a0a0}
.walert.amber{background:#33291a;color:#e6c07a}
.walert.ok{background:#16281d;color:#63d29a}
}
</style></head><body>
<div class="wrap">
<div class="card">
 <div class="top">
  <div class="brand"><span class="m">⩗</span> maxx <span class="who">· @${h} · ${owner ? "dash" : "live usage"}</span></div>
  <span style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
   ${owner
     ? ""
     : `<span class="badge" title="Sessions and projects are anonymized on this shared view">shared view — names hidden</span> <a href="/u/${h}/dash?login=1">owner sign-in</a>`}
   <span class="badge" id="verdict">…</span>
   <span class="livepill"><span class="dot"></span> live · updates every 10s</span>
  </span>
 </div>
 ${tabsHtml(h, "overview", owner)}

 <div class="bars" id="bars"></div>

 <div class="warns" id="warns"></div>

 <div class="trio">
  <div>
   <div class="klabel">NET / MIN</div>
   <div class="big"><span class="v" id="netV">—</span><span class="u" id="netU"></span></div>
   <div class="sub" id="netSub"></div>
  </div>
  <div>
   <div class="klabel">WEEK LEFT</div>
   <div class="big"><span class="v" id="remV" style="font-size:38px">—</span></div>
   <div class="sub" id="remSub"></div>
  </div>
  <div>
   <div class="klabel">THIS SESSION</div>
   <div class="big"><span class="v" id="runV" style="font-size:38px">—</span></div>
   <div class="sub" id="runSub"></div>
  </div>
  <div>
   <div class="klabel">SURFACES</div>
   <div class="big"><span class="v" id="surfV" style="font-size:38px">—</span></div>
   <div class="sub" id="surfSub"></div>
  </div>
 </div>

 <div style="margin-top:24px">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
   <span class="klabel">BANKED / SPENT-OVER · LAST 48 MIN</span>
   <span style="font-family:var(--mono);font-size:13px;color:#8a93a5" id="chartMeta"></span>
  </div>
  <div class="chart48" id="chart48">
   <div class="zero"></div>
   <div class="avgline" id="avgline" style="display:none"></div>
   <div class="avglab" id="avglab" style="display:none">avg</div>
   <div class="cols" id="cols"></div>
   <div class="marks" id="marks"></div>
   <div class="guide48" id="guide48"></div>
  </div>
  <div class="axis48"><span>-48m</span><span>-24m</span><span>now</span></div>
  <div class="tip48" id="tip48"></div>
 </div>

 <div style="margin-top:24px">
  <div class="klabel">CHANNELS · MACHINE × PROJECT</div>
  <div style="overflow-x:auto"><table><thead><tr><th>Channel</th><th>Last update</th><th class="num">+1h</th><th class="num">Billed 5h</th><th style="width:30%"></th></tr></thead>
  <tbody id="channels"><tr><td colspan="5" class="empty">…</td></tr></tbody></table></div>
 </div>

 <div class="foot">
  <span class="lt">⌵ counted from session logs · anchored to Anthropic /usage · lifetime <span id="lifeF">—</span> · <span id="stamp"></span></span>
  ${owner
    ? `<span><a href="/u/${h}/dash" onclick="navigator.clipboard.writeText(location.origin+'/u/${h}/dash');this.textContent='link copied';return false">share this dash (viewers see it name-redacted) →</a> · <a href="/u/${h}">compact card →</a></span>`
    : `<a href="/u/${h}">compact card →</a>`}
 </div>
</div>
<div class="term">
 <div class="thead"><span class="dot"></span> activity — live <span style="text-transform:none;letter-spacing:0;font-weight:400">· emits + mcp + directives + auth</span></div>
 <div class="insight" id="insight"></div>
 <div class="lines" id="term"><div class="ln d">listening…</div></div>
</div>
</div>
<script>
if(location.search)history.replaceState(null,'',location.pathname);
(function(){
  var esc=function(x){var d=document.createElement('span');d.textContent=x==null?'':String(x);return d.innerHTML};
  var hum=function(n){return n==null?'—':n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'k':''+Math.round(n)};
  var kf=function(n){return Math.round(n/1000).toLocaleString('en-US')+'k'};
  var ago=function(s){return s<60?Math.round(s)+'s':s<3600?Math.round(s/60)+'m':s<86400?Math.round(s/3600)+'h':Math.round(s/86400)+'d'};
  var dur=function(sec){sec=Math.max(0,Math.round(sec));var hh=Math.floor(sec/3600),mn=Math.floor(sec%3600/60);return hh>0?hh+'h '+mn+'m':mn>0?mn+'m':sec+'s'};
  // where a row was emitted from, at a glance. Matches both raw surfaces
  // (laptop:xx, cloud:routine) and their public-redacted labels (machine N, cloud N).
  var surfIcon=function(s){s=String(s||'');return s.indexOf('cloud')===0?'☁️':(s.indexOf('laptop')===0||s.indexOf('machine')===0)?'💻':'✳️'};
  var clockAt=function(fromNow){return new Date(Date.now()+fromNow*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})};
  var FIVE_H=5*3600,WEEK=7*86400,CTX_WALL=250e3;

  // Context trajectory from the feed — the useful signal in the emitter lane. Each
  // batch carries ctx; grouping by session and sloping the recent tail gives ctx
  // GROWTH per turn and turns-to-wall (/fenix at 250k). A /clear drops ctx → the
  // tail slope resets, so a freshly-cleared session reads as holding, not climbing.
  // Also returns prev-ctx per batch so the tail can annotate growth inline.
  function ctxTrends(){
    var ev=(window.__ev||[]).slice().sort(function(a,b){return new Date(a.ts)-new Date(b.ts)});
    var g={},prev={};
    ev.forEach(function(e){
      var k=e.name||((e.project||e.surface||'?')+'');
      var gr=g[k]||(g[k]={name:e.name,project:e.project,s:[]});
      prev[e.ts+'|'+k]=gr.s.length?gr.s[gr.s.length-1].ctx:null;
      gr.s.push({ctx:e.ctx||0,turns:e.turns||0});
    });
    var sessions=Object.keys(g).map(function(k){
      var s=g[k].s,last=s[s.length-1],tail=s.slice(-6),f=tail[0];
      var dctx=last.ctx-f.ctx,dt=0;for(var i=1;i<tail.length;i++)dt+=tail[i].turns;
      var vel=dt>0?dctx/dt:0,ttw=vel>0?(CTX_WALL-last.ctx)/vel:Infinity;
      return {name:g[k].name,project:g[k].project,ctx:last.ctx,vel:vel,ttw:ttw};
    }).filter(function(x){return x.ctx>0});
    return {sessions:sessions,prev:prev};
  }
  var keyOfEv=function(e){return e.name||((e.project||e.surface||'?')+'')};

  // verdict + bars + trio, repainted every SECOND. Between polls the numbers drift
  // deterministically at the known rates (standing moves at net/min, week drains at
  // burn/min) and snap to truth on each poll — the card's odometer, here.
  function renderBudget(){
    var b=window.__b;if(!b)return;
    var drift=window.__bAt?(Date.now()-window.__bAt)/1000:0;

    var vd=document.getElementById('verdict');
    vd.textContent=b.verdict==='ok'?'✓ ok':b.verdict;
    vd.className='badge'+(b.verdict==='ok'?'':' '+esc(b.verdict));
    // never anchored: tokens are counted, caps are unknown — say so once, neutrally,
    // instead of painting a brand-new account as over-budget everywhere
    if(b.verdict==='calibrating'){
      document.getElementById('bars').innerHTML='<div style="font-size:12.5px;color:#8a93a5;padding:2px 0">calibrating — coins are being counted; caps appear after the first Claude Code session anchors <span style="color:#5b6474">/usage</span></div>';
      [['netV','—','/min','tracking'],['remV','—','','waiting for first anchor'],['runV','—','','open Claude Code once']].forEach(function(x){
        var v=document.getElementById(x[0]);v.textContent=x[1];v.style.color='var(--ink-3)';
        if(x[0]==='netV')document.getElementById('netU').textContent=x[2];
        document.getElementById(x[0].replace('V','Sub')).textContent=x[3];
      });
      return;
    }
    // Bars mirror the CLI's geometry, not just its numbers. SESSION = the netBar:
    // green grows from the LEFT = banked standing (fraction of realMax), red grows
    // from the RIGHT = over, scaled to the hard 5h wall (full red = lockout, not
    // "past pace"). WEEK = the fuel tank: fill = what's LEFT, draining right→left,
    // with the ╎ even-pace tick — fill short of the tick = burning too fast.
    var GRAD={green:'linear-gradient(90deg,#9be3b0,#4fbe7e 55%,#159a52)',amber:'linear-gradient(90deg,#f4d9a6,#e0a93e 55%,#c98a12)',red:'linear-gradient(90deg,#f2b8b5,#e06661 55%,#d23b3b)'};
    var bar=function(lab,spec,num){
      var g=Math.max(0,Math.min(100,(spec.green||0)*100));
      var r=Math.max(0,Math.min(100,(spec.red||0)*100));
      var tick=spec.tick!=null?Math.max(0,Math.min(100,spec.tick*100)):null;
      return '<div class="bar"><span class="lab">'+lab+'</span><span class="track">'+
        (g>=0.5?'<span class="fill" style="width:'+g.toFixed(1)+'%;background:'+GRAD[spec.col||'green']+'"></span>':'')+
        (r>=0.5?'<span class="fill" style="left:auto;right:0;width:'+r.toFixed(1)+'%;background:linear-gradient(270deg,#f2b8b5,#d23b3b)"></span>':'')+
        (tick!=null?'<span style="position:absolute;left:'+tick.toFixed(1)+'%;top:0;bottom:0;width:2px;background:#152036;z-index:2"></span>':'')+
        '</span><span class="num">'+num+'</span></div>';
    };
    // CLI statusline semantics (render.mjs meterContent), mirrored exactly:
    // session number = signed STANDING (available to spend: + banked / − over), NOT used.
    // rate = refuel − live burn (tank refills at rolling-5h-burn ÷ 300); its sign and
    // color follow the STANDING, never the raw rate. week = left · even-pace bank · reset.
    var burnMin=b.burn_5m!=null?b.burn_5m/5:0;
    // NET = sustainable weekly pace − recent burn (server-computed, one ruler). + under
    // pace (you'll make the week) / − over pace (dry early). The 5h-refill model is gone.
    var prog=b.net_per_min!=null?b.net_per_min:0;
    var up=prog>=0;
    // live drift: standing moves at net/min, week reserve drains at burn/min
    var standing=(b.session_to_spend||0)-(b.session_over||0)+prog*drift/60;
    var toSpend=Math.max(0,standing),over=Math.max(0,-standing);
    var weekLeft=Math.max(0,(b.weekly_left_tokens||0)-Math.max(0,burnMin)*drift/60);
    var bank=b.week_bank!=null?b.week_bank-Math.max(0,burnMin)*drift/60:null;
    var banked=toSpend>0;
    var progStr=(up?'+':'−')+kf(Math.abs(prog))+'/min';
    var sNum=(banked?'+'+kf(toSpend):'<span class="bad">−'+kf(over)+'</span>')+
      (Math.abs(prog)>=500?' · <span class="'+(up?'good':'bad')+'">'+progStr+'</span>':'');
    var wNum=(b.weekly_left_tokens!=null?kf(weekLeft)+' left':'—')+
      (bank!=null?(bank>=0?' · <span class="good">+'+kf(bank)+' banked</span>':' · <span class="bad">−'+kf(-bank)+' over</span>'):'')+
      (b.week_reset_in_sec!=null?' · '+ago(b.week_reset_in_sec):'');
    // session spec: standing vs realMax (green), over vs room-to-lockout (red)
    var realMax=(b.five_billed||0)+(b.session_to_spend||0)-(b.session_over||0);
    var fiveCap=b.quota>0?(b.five_billed||0)/b.quota:null;
    var overRoom=fiveCap&&fiveCap>realMax?fiveCap-realMax:Math.max(realMax,1);
    var sSpec={green:realMax>0?toSpend/realMax:0,red:over/overRoom,col:'green'};
    // week spec: fuel left, pace tick from the shipped bank ((left − bank) ÷ cap), CLI colors
    var weekCap=(b.week_billed||0)+(b.weekly_left_tokens||0);
    var leftFrac=weekCap>0?weekLeft/weekCap:0;
    var wTick=weekCap>0&&bank!=null?Math.min(1,Math.max(0,(weekLeft-bank)/weekCap)):null;
    var wRatio=wTick!=null&&wTick>0.02?leftFrac/wTick:1;
    var wCol=(leftFrac<0.1||wRatio<0.5)?'red':wRatio<0.85?'amber':'green';
    document.getElementById('bars').innerHTML=bar('session',sSpec,sNum)+bar('week',{green:leftFrac,tick:wTick,col:wCol},wNum)+
      '<div style="font-size:11.5px;color:#a3abba">bar = what\\'s left · <span style="color:#152036">╎</span> = even pace</div>';

    // NET / MIN = sustainable weekly pace − recent burn. + under pace, − over pace.
    var netV=document.getElementById('netV'),netU=document.getElementById('netU'),netSub=document.getElementById('netSub');
    var nh=hum(Math.abs(prog));
    if(Math.abs(prog)<1000){netV.textContent='0';netU.textContent='/min';netV.style.color='var(--ink)';}
    else{netV.textContent=(up?'+':'−')+nh.slice(0,-1);netU.textContent=nh.slice(-1)+'/min';netV.style.color=up?'var(--green)':'var(--red)';}
    netSub.textContent=up?'under weekly pace':'over weekly pace';
    // WEEK LEFT: the weekly reserve, with the pace bank as context
    var remV=document.getElementById('remV'),remSub=document.getElementById('remSub');
    remV.textContent=hum(weekLeft);remV.style.color='var(--ink)';
    remSub.textContent=(bank!=null?(bank>=0?'+'+hum(bank)+' ahead of pace':hum(-bank)+' over pace'):'—')+
      (b.week_reset_in_sec!=null?' · resets '+ago(b.week_reset_in_sec):'');
    // THIS SESSION: safe-to-spend (weekly-paced) with the hard 5h burst ceiling as context
    var runV=document.getElementById('runV'),runSub=document.getElementById('runSub');
    if(banked){
      runV.textContent='+'+hum(toSpend);runV.style.color='var(--ink)';
      runSub.textContent='safe to spend'+(b.session_burst!=null?' · coin-spree '+hum(b.coin_spree_low)+'–'+hum(b.coin_spree_high):'');
    }else{
      runV.textContent=over>0?'−'+hum(over):'0';runV.style.color='var(--red)';
      runSub.textContent='over pace'+(b.session_burst!=null?' · coin-spree '+hum(b.coin_spree_low)+'–'+hum(b.coin_spree_high):'');
    }
    // SURFACES: how many machines and cloud agents are pouring into this one tally — the
    // count IS the product claim, and it is the one number no per-machine /usage can show.
    var surfV=document.getElementById('surfV'),surfSub=document.getElementById('surfSub');
    // "directive" is the bookkeeping channel the orchestrator writes through, not a machine
    var sf=(b.surfaces||[]).filter(function(s){return (s.surface||'')!=='directive'});
    var nCloud=sf.filter(function(s){return /^cloud/.test(s.surface||'')}).length;
    surfV.textContent=sf.length;surfV.style.color='var(--ink)';
    surfSub.textContent=sf.length?(sf.length-nCloud)+' machine'+(sf.length-nCloud===1?'':'s')+' · '+nCloud+' cloud':'none reporting';
  }

  function renderAll(){
    var b=window.__b;if(!b)return;
    var ev=window.__ev||[];
    var ct=ctxTrends();window.__ctxS=ct.sessions;window.__ctxPrev=ct.prev;
    var t=Date.now()/1000;
    renderBudget();
    var h1=ev.filter(function(e){var ts=new Date(e.ts).getTime()/1000;return ts>t-3600});
    var h1b=h1.reduce(function(a,e){return a+e.billed},0),h1t=h1.reduce(function(a,e){return a+(e.turns||0)},0);
    window.__perTurn=h1t>0?hum(h1b/h1t)+' /turn · '+h1t+' turns/1h':'';

    // 48-min tokens/min chart from the feed
    // An emit is a per-session DELTA covering every turn since the emitter's cursor, so
    // one record can span many minutes. Dropping it all in the minute it finished made a
    // batch look like a 30M spike in 60 seconds and left the minutes it actually covered
    // empty. Spread each record evenly across the minutes between ts0 and ts.
    var buckets=new Array(48).fill(0);
    ev.forEach(function(e){
      var ts=new Date(e.ts).getTime()/1000;if(!(ts>0))return;
      var ts0=e.ts0?new Date(e.ts0).getTime()/1000:ts;
      if(!(ts0>0)||ts0>ts)ts0=ts;
      var lo=47-Math.floor((t-ts)/60), hi=47-Math.floor((t-ts0)/60);
      if(hi<lo){var sw=lo;lo=hi;hi=sw;}
      lo=Math.max(0,lo);hi=Math.min(47,hi);
      // No overlap with the window: drop it. This used to fold the record's WHOLE billed
      // into buckets[lo], and lo had already been clamped up to 0 — so every record that
      // merely aged past the 48-minute edge piled onto the -48m bar instead of scrolling
      // off. Measured live: 1.7M heaped on one bar from 36 expired records, making it the
      // tallest bar, setting the peak, and pushing the window average from 307k (under
      // pace) to 342k (over pace). The oldest bar was a garbage bin, not a minute.
      if(hi<0||lo>47||hi<lo)return;
      var span=hi-lo+1, share=e.billed/span;
      for(var i=lo;i<=hi;i++)buckets[i]+=share;
    });
    // How far back the data actually reaches. The feed is capped at 200 events, so with
    // several sessions emitting the newest 200 may only span a few minutes — the rest of
    // the 48 were never FETCHED, not idle. Plotting them as zero and averaging over all
    // 48 understated burn ~3x and printed "under pace" through a 3x-over-pace stretch.
    // Judge only over the minutes we actually have.
    // Only when the feed came back FULL (n=200) is it truncated. Short of that the oldest
    // event is where this account's activity actually begins, and the earlier minutes are
    // genuinely idle — hatching those would be the same lie pointed the other way.
    var oldest=t;
    ev.forEach(function(e){var x=new Date(e.ts0||e.ts).getTime()/1000;if(x>0&&x<oldest)oldest=x});
    var covLo=ev.length>=200?Math.max(0,Math.min(47,47-Math.floor((t-oldest)/60))):0,cov=48-covLo;
    var mx=Math.max.apply(null,buckets.concat([1]));
    var pace=b.sustainable_per_min!=null?b.sustainable_per_min:(b.five_billed||0)/300;
    var H=140,BOX=170;
    // SIGNED against pace. Every minute grants one pace-worth: spend less and the
    // difference is BANKED (bar up, green); spend more and you are DOWN by it (bar
    // down, orange). Use 200k against a 342k allowance and you are +142k. This is
    // the same arithmetic the tooltip has always shown — the bars just say it too.
    var nets=buckets.map(function(v){return pace-v});
    var posMax=0,negMax=0;
    for(var ni=covLo;ni<48;ni++){var nv=nets[ni];if(nv>0){if(nv>posMax)posMax=nv}else if(-nv>negMax)negMax=-nv}
    // An earlier attempt at this gave the positive half a fixed 42px, so every idle
    // minute — net = exactly pace, the largest positive value there is — clipped flat
    // against the ceiling and the whole thing was reverted as "a flat wall". That was
    // the scaling, not the idea. Here ONE scale serves both directions (shared
    // denominator, sqrt compression) and the box is split in proportion to how far
    // each side actually reaches, so whichever side reaches furthest defines the
    // split and neither can clip.
    var M=Math.max(posMax,negMax,1);
    var pn=Math.sqrt(posMax/M),nn=Math.sqrt(negMax/M),sum=(pn+nn)||1;
    var posH=H*pn/sum,negH=H*nn/sum;
    var barH=function(v){return Math.max(2,Math.sqrt(Math.abs(v)/M)*H/sum)};
    document.getElementById('cols').innerHTML=nets.map(function(nv,i){
      // Beyond the data's reach: render nothing at all. A stub here would be a claim
      // we cannot make — that the minute was quiet.
      if(i<covLo)return '<div class="col nodata"></div>';
      var live=i===47?' live':'';
      var h=barH(nv);
      return nv>=0
        ? '<div class="col'+live+'"><div class="bar pos" style="bottom:'+negH.toFixed(0)+'px;height:'+h.toFixed(0)+'px"></div></div>'
        : '<div class="col'+live+'"><div class="bar neg" style="bottom:'+Math.max(0,negH-h).toFixed(0)+'px;height:'+h.toFixed(0)+'px"></div></div>';
    }).join('');
    var winTot=buckets.reduce(function(a,v){return a+v},0);
    var al=document.getElementById('avgline'),ab=document.getElementById('avglab');
    var covLab=cov>=48?'48m':'last '+cov+'m';
    // The line is the PACE line — net zero, where spending exactly the allowance lands.
    // Above it you banked that minute, below it you were down. It sits wherever the
    // split put it rather than at a fixed height.
    var zeroY=BOX-negH;
    var netAvg=pace-(winTot/cov);
    var banking=netAvg>=0;
    al.style.display='block';al.style.top=zeroY.toFixed(0)+'px';al.style.borderTopColor='#9aa3b2';
    ab.style.display='block';ab.style.top=Math.max(0,zeroY-14).toFixed(0)+'px';ab.style.color=banking?'#15803d':'#c2703a';
    ab.textContent='pace '+hum(pace)+'/min · '+covLab+' net '+(banking?'+':'−')+hum(Math.abs(netAvg))+'/min · '+(banking?'banking':'over');
    if(winTot<=0){
      // An idle window is a real state, not a zero to plot. Every minute banked the
      // full allowance, which the bars now say on their own.
      document.getElementById('chartMeta').textContent='nothing spent in the last 48 minutes · banking the full '+hum(pace)+'/min'+(window.__perTurn?' · '+window.__perTurn:'');
    }else{
      document.getElementById('chartMeta').textContent='banked (up) vs spent-over (down) per minute · '+covLab+' net '+(banking?'+':'−')+hum(Math.abs(netAvg))+'/min vs pace '+hum(pace)+'/min · worst minute −'+hum(Math.max(0,mx-pace))+' · √'
        +(cov<48?' · older minutes not fetched (feed caps at 200 events)':'')
        +(window.__perTurn?' · '+window.__perTurn:'');
    }
    // intervention markers: red = gate held spend / pause delivered, amber = other maxx ops
    var opsMin={};
    (window.__ops||[]).forEach(function(o){
      var oi=47-Math.floor((t-o.ts)/60);
      if(oi<0||oi>47)return;
      var prot=/over|held|pause|stale/i.test(o.op+' '+(o.d||''));
      var m=opsMin[oi]||(opsMin[oi]={prot:false,items:[]});
      m.items.push(o.op+(o.d?' · '+o.d:''));
      if(prot)m.prot=true;
    });
    window.__chartMins={buckets:buckets,ops:opsMin,t:t,pace:pace};
    document.getElementById('marks').innerHTML=Object.keys(opsMin).map(function(i){
      var m=opsMin[i];
      return '<span style="left:'+((+i+0.5)/48*100).toFixed(1)+'%;background:'+(m.prot?'#d23b3b':'#e0a13a')+'"></span>';
    }).join('');

    // WARNINGS — the left pane's deterministic alert list. Fixed rules, fixed
    // vocabulary; only numbers change. Empty = one green all-clear line.
    var warns=[];
    if(b.verdict==='degraded')warns.push({s:'amber',t:'signal <b>degraded</b> · no /usage anchor · weekly numbers only'});
    else if(b.verdict==='calibrating')warns.push({s:'amber',t:'<b>calibrating</b> · open a Claude Code session on a linked machine to anchor your caps'});
    // 'over' is a LIVE verdict — the wall/over rows below carry it; only stale-class
    // verdicts mean the numbers themselves are not live
    else if(b.verdict!=='ok'&&b.verdict!=='over')warns.push({s:'red',t:'signal <b>'+esc(b.verdict)+'</b> · numbers not live'});
    // the 5h wall itself (burst exhausted): Claude has stopped you anyway — offer the view
    if(b.verdict!=='calibrating'&&b.session_burst!=null&&b.session_burst<=0)
      warns.push({s:'red wrap',t:'you hit the session wall — sorry. time for some contemplation → <a href="https://www.youtube.com/watch?v=linlz7-Pnvw" target="_blank" rel="noopener" style="color:inherit;font-weight:700">Swiss Alps in 8K</a>'+(b.five_reset_in_sec!=null?' · back in '+ago(b.five_reset_in_sec):'')});
    else if(b.verdict!=='calibrating'&&b.session_to_spend!=null&&b.session_to_spend<=0)warns.push({s:'red',t:'session over by <b>'+hum(b.session_over||0)+'</b> · ease off'});
    // context warnings are TRAJECTORY-based, not size-based: a session holding at
    // 105k is fine (no warn); one climbing shows +k/turn and turns-to-wall. Most
    // urgent (soonest wall) first. window.__ctxS is set at the top of renderAll.
    (window.__ctxS||[]).filter(function(x){return x.ctx>120e3||x.ttw<25}).sort(function(a,b2){return a.ttw-b2.ttw}).slice(0,3).forEach(function(x){
      var nm=esc((x.name||x.project||'').slice(0,18));
      var climb=x.vel>0?' · +'+hum(x.vel)+'/t':'';
      var ttw=isFinite(x.ttw)?' · →'+Math.round(x.ttw)+'t':'';
      if(x.ctx>CTX_WALL)warns.push({s:'red',t:'ctx <b>'+hum(x.ctx)+'</b> '+nm+' · past wall · <b>/fenix</b>'});
      else if(x.vel>0&&x.ttw<15)warns.push({s:'red',t:'ctx <b>'+hum(x.ctx)+'</b> '+nm+climb+ttw+' · <b>/fenix</b>'});
      else if(x.vel>0&&x.ctx>120e3)warns.push({s:'amber',t:'ctx <b>'+hum(x.ctx)+'</b> '+nm+climb+ttw});
      else if(x.ctx>200e3)warns.push({s:'amber',t:'ctx <b>'+hum(x.ctx)+'</b> '+nm+' · holding'});
    });
    var werrs=h1.reduce(function(a,e){return a+(e.errors||0)},0);
    if(werrs>0)warns.push({s:'amber',t:'<b>'+werrs+'</b> token error'+(werrs===1?'':'s')+' · last hour'});
    var wheld=(window.__ops||[]).filter(function(o){return /held|OVER|pause/i.test((o.op||'')+' '+(o.d||''))&&o.ts>t-1800}).sort(function(x,y){return y.ts-x.ts})[0];
    if(wheld)warns.push({s:'amber',t:'🛡 gate held spend · '+ago(Math.max(0,t-wheld.ts))+' ago'});
    var wBurn=b.burn_5m!=null?b.burn_5m/5:0,wPace=b.sustainable_per_min||0;
    // A burn multiple on its own is a number, not an answer. Name the session driving
    // it, its context size, and the action — the cause is nearly always one session
    // past the context wall re-billing its whole context every turn.
    if(wBurn>=5e5&&wPace>0&&wBurn>2*wPace){
      var mult=Math.round(wBurn/wPace*10)/10;
      var hot=(b.top_burners||[]).filter(function(a){return a.rate_5m>0})
                .sort(function(x,y){return y.rate_5m-x.rate_5m});
      var lead=hot[0],cause='';
      if(lead){
        var lrate=lead.rate_5m/5,share=wBurn>0?Math.round(lrate/wBurn*100):0;
        cause=' — <b>'+esc(lead.name||lead.project||(lead.session||'').slice(0,8))+'</b> '+hum(lrate)+'/min'+
              (share>=15?' ('+share+'%)':'')+
              (lead.ctx?' at ctx'+hum(lead.ctx):'')+
              (lead.ctx>CTX_WALL?' · past wall · <b>/fenix</b> it':'');
        if(hot[1]&&hot[1].rate_5m/5>=wBurn*0.15)
          cause+=', then <b>'+esc(hot[1].name||hot[1].project||'session')+'</b> '+hum(hot[1].rate_5m/5)+'/min'+
                 (hot[1].ctx>CTX_WALL?' (also past wall)':'');
      }
      warns.push({s:mult>=5?'red':'amber',t:'burn <b>'+hum(wBurn)+'/min</b> · '+mult+'× weekly pace'+cause});
    }
    if(b.anchor_age_sec!=null&&b.anchor_age_sec>90)warns.push({s:'amber',t:'anchor <b>'+b.anchor_age_sec+'s</b> old'});
    document.getElementById('warns').innerHTML=(warns.length?warns:[{s:'ok',t:'all clear'}]).map(function(w){
      return '<div class="walert '+w.s+'">'+w.t+'</div>';
    }).join('');

    // deterministic advisory: worst live session by ctx, with the numbers that justify
    // the action (every turn re-bills ~ctx) and the action itself, thresholded:
    // >250k ctx → run /fenix NOW · 120-250k → consider /clear soon
    var ins=document.getElementById('insight');
    var lines=[];
    // the single most-urgent context session, as a headline over the tail (the
    // full trajectory list lives in the left-pane warnings). Climbing sessions only.
    var urgent=(window.__ctxS||[]).filter(function(x){return x.ctx>150e3&&(x.vel>0||x.ctx>CTX_WALL)}).sort(function(a,b2){return a.ttw-b2.ttw})[0];
    if(urgent){
      var sev=urgent.ctx>CTX_WALL||(urgent.vel>0&&urgent.ttw<15);
      lines.push((sev?'⚠ ':'· ')+'<b>'+esc((urgent.name||urgent.project||'').slice(0,40))+'</b> ctx '+hum(urgent.ctx)+
        (urgent.vel>0?' · +'+hum(urgent.vel)+'/turn'+(isFinite(urgent.ttw)?' · ~'+Math.round(urgent.ttw)+' turns to wall':''):'')+
        ' → '+(sev?'<b>/fenix now</b>':'/clear soon'));
    }
    var errs=h1.reduce(function(a,e){return a+(e.errors||0)},0);
    if(errs>0)lines.push('⚠ <b>'+errs+' error'+(errs===1?'':'s')+'</b> last hour (rate-limit / API) — the wall is pushing back');
    var held=(window.__ops||[]).filter(function(o){return /held|OVER|pause/i.test((o.op||'')+' '+(o.d||''))&&o.ts>t-1800}).sort(function(x,y){return y.ts-x.ts})[0];
    if(held)lines.push('🛡 maxx protected you · '+esc(held.op+(held.d?' · '+held.d:''))+' · '+ago(Math.max(0,t-held.ts))+' ago');
    if(lines.length){ins.style.display='block';ins.innerHTML=lines.join('<br>');}
    else ins.style.display='none';
    document.getElementById('lifeF').textContent=hum(b.lifetime_billed);
    document.getElementById('stamp').textContent=new Date().toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    renderChannels();
  }

  // channels = budget.surfaces (surface × project) merged with the feed for last-seen + 1h
  function renderChannels(){
    var b=window.__b;if(!b)return;
    var sf=b.surfaces||[],ev=window.__ev||[],t=Date.now()/1000;
    var keyOf=function(surface,project){return project?surface+' · '+project:surface};
    var by={};
    sf.forEach(function(x){by[x.surface]={surface:x.surface,b5:x.billed_5h,last:0,h1:0}});
    ev.forEach(function(e){
      var k=keyOf(e.surface,e.project);
      var c=by[k]||(by[k]={surface:k,b5:0,last:0,h1:0});
      var ts=new Date(e.ts).getTime()/1000;
      // the channel's own live state = its most-recent emit: where the session is
      // (turn), what the last turn cost, and how full the context is (the danger signal).
      if(ts>=c.last){c.last=ts;if(e.turn_end>0)c.turn=e.turn_end;if(e.ctx>0)c.ctx=e.ctx;if(e.billed>0)c.lastTurn=e.billed;}
      if(ts>t-3600)c.h1+=e.billed;
    });
    var rows=Object.keys(by).map(function(k){return by[k]}).sort(function(a,b2){return b2.b5-a.b5});
    var max=Math.max.apply(null,[1].concat(rows.map(function(c){return c.b5})));
    // orders waiting on each channel, shown WITH the channel — a directive nobody
    // can see is a directive nobody acts on
    var dirs=b.pending_directives||[],placed={};
    var dirRow=function(d){
      var mark=d.action==='pause'?'⏸':d.action==='clear'?'⌫':'▶';
      return '<tr class="dirrow"><td colspan="5" class="mono">'+
        '<span style="color:'+(d.action==='pause'?'var(--red)':'var(--amber, #d08a2a)')+'">'+mark+' '+esc(d.action)+'</span>'+
        ' <span style="color:var(--ink-3)">→ '+esc(d.session==='*'?'all sessions':d.session.slice(0,8))+
        (d.auto?' · auto':'')+(d.delivered?' · delivered':' · waiting')+'</span>'+
        (d.note?'<br><span style="color:var(--ink-3)">'+esc(d.note)+'</span>':'')+'</td></tr>';
    };
    // Exactly ONE home per directive. An exact "surface · project" match wins; a bare
    // surface (what top_burners gives the watchdog) falls to the busiest channel on that
    // machine — rows are billed-sorted, so find() picks it. Without this a bare surface
    // matched every project on the box and one order rendered three times.
    var assign={};
    dirs.forEach(function(d){
      if(!d.surface)return;
      var exact=rows.filter(function(c){return c.surface===d.surface})[0];
      var pre=exact||rows.filter(function(c){return c.surface.indexOf(d.surface+' · ')===0})[0];
      if(pre){assign[d.id]=pre.surface;placed[d.id]=1;}
    });
    var body=rows.map(function(c){
      var mine=dirs.filter(function(d){return assign[d.id]===c.surface});
      // live-state sub-line: turn · last-turn cost · context, ctx colored as the danger
      // rail (red past the 250k /fenix wall, amber past 120k) — same thresholds the feed uses.
      var meta='';
      if(c.turn||c.ctx){
        var cc=c.ctx>250e3?'var(--red, #d23b3b)':c.ctx>120e3?'#d08a2a':'var(--ink-3)';
        meta='<div class="cmeta">'+(c.turn?'t'+c.turn:'')+
          (c.lastTurn?' · +'+hum(c.lastTurn)+' last':'')+
          (c.ctx?' · <span style="color:'+cc+'">ctx'+hum(c.ctx)+(c.ctx>250e3?' ⚠':'')+'</span>':'')+'</div>';
      }
      return '<tr><td class="mono">'+surfIcon(c.surface)+' '+esc(c.surface)+meta+'</td>'+
        '<td>'+(c.last?ago(Math.max(0,t-c.last))+' ago':'—')+'</td>'+
        '<td class="num">'+(c.h1>0?'<b>+'+hum(c.h1)+'</b>':'idle')+'</td>'+
        '<td class="num">'+hum(c.b5)+'</td>'+
        '<td><div style="height:8px;border-radius:4px;background:#5b52e8;opacity:.65;width:'+Math.max(2,Math.round(c.b5/max*100))+'%"></div></td></tr>'+
        mine.map(dirRow).join('');
    }).join('');
    // broadcasts and anything we could not pin to a channel still have to be visible
    var loose=dirs.filter(function(d){return !placed[d.id]});
    document.getElementById('channels').innerHTML=(body||loose.length)
      ? body+loose.map(dirRow).join('')
      : '<tr><td colspan="5" class="empty">no channels yet</td></tr>';
  }

  // right pane: emits (green) + ops (amber) merged chronologically, viewer-local times
  function renderTerm(){
    var el=document.getElementById('term');
    var tl=function(ts){var d=new Date(ts);
      return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0')};
    var items=[];
    // channel identity = PROJECT (colored chip), not the repeated machine id; ctx is
    // colored as the cost signal it is (every turn re-bills ~ctx)
    var chipCols=['#7dd3fc','#4ade80','#f0abfc','#fbbf24','#a5b4fc','#fb7185'];
    var chipCol=function(k){var n=0;for(var i=0;i<k.length;i++)n+=k.charCodeAt(i);return chipCols[n%chipCols.length]};
    // Owner rows carry a project (or a cloud:<routine> surface). Public rows carry
    // neither — only the anonymized root ("session-N") — so mask them as ******N:
    // reads as "redacted", stays stable per session so lanes still tell apart.
    var projOf=function(e){
      if(e.project)return e.project;
      var s=String(e.surface||'');
      if(s.indexOf('cloud:')===0)return s.slice(6);
      var m=String(e.root||'').match(/^session-([0-9]+)$/);
      return m?'******'+m[1]:'?';
    };
    // Dropping the name costs nothing UNLESS two sessions of the same project are both
    // emitting — then the chip alone no longer tells their rows apart. Tag the root only
    // in that case, so the common case stays clean.
    var rootsBy={};
    (window.__ev||[]).forEach(function(e){var p=projOf(e);(rootsBy[p]=rootsBy[p]||{})[e.root]=1});
    // When 2+ sessions share a project, tag EVERY one of that project's rows — not just the
    // switch points. The 4-char id (= the statusline's "id abcd") is how the owner reads a row
    // back to a specific terminal; a gap of untagged rows between switches leaves them
    // ambiguous, which is exactly the "which agent is burning?" question the tag exists to
    // answer. Single-session projects stay clean (no collision, nothing to disambiguate).
    (window.__ev||[]).slice().filter(function(e){return new Date(e.ts).getTime()>0})
      .sort(function(a,b){return new Date(a.ts)-new Date(b.ts)}).forEach(function(e){
      var ms=new Date(e.ts).getTime();
      var proj=projOf(e);
      var tag=(Object.keys(rootsBy[proj]||{}).length>1)?String(e.root).slice(0,4):'';
      // The session NAME was printed on every row — identical for every emit of a
      // session, so the widest column repeated a constant. Turn numbers go there
      // instead: where this session is, and which turns this batch covered.
      var tn='';
      if(e.turn_end>0)tn=e.turn_start===e.turn_end?'t'+e.turn_end:'t'+e.turn_start+'–'+e.turn_end;
      var extra=[];
      // turn count is implicit in the range; only fall back to the delta if an older
      // server is answering and turn_end is absent
      if(!tn&&e.turns)extra.push(e.turns+'t');
      if(e.tool_calls)extra.push(e.tool_calls+'tc');
      var cxCls=e.ctx>250e3?'cx hot':e.ctx>120e3?'cx warn':'cx';
      // ctx delta from this session's previous batch — growth per batch, right in
      // the lane. ▲ grew (amber), ▼ dropped = a /clear or /fenix reset (green).
      var pc=(window.__ctxPrev||{})[e.ts+'|'+keyOfEv(e)];
      var dc=pc!=null?e.ctx-pc:0;
      var dStr=Math.abs(dc)>=1000?' <span style="color:'+(dc>0?'#e0a13a':'#4ade80')+'">'+(dc>0?'▲':'▼')+hum(Math.abs(dc))+'</span>':'';
      items.push({ms:ms,html:'<div class="ln"><span class="t">'+tl(ms)+'</span> '+surfIcon(e.surface)+' '+
        '<span class="chip" style="color:'+chipCol(proj)+'">'+esc(proj)+'</span> '+
        '<span class="v">+'+hum(e.billed)+'</span>'+
        (tag?' <span class="d">'+esc(tag)+'</span>':'')+
        (tn?' <span class="p">'+tn+'</span>':'')+
        (extra.length?' <span class="d">'+extra.join(' ')+'</span>':'')+
        (e.ctx?' <span class="'+cxCls+'">ctx'+hum(e.ctx)+'</span>'+dStr:'')+
        (e.errors>0?' <span class="cx hot">⚠'+e.errors+'err</span>':'')+'</div>'});
    });
    (window.__ops||[]).forEach(function(o){
      var ms=o.ts*1000;
      if(!(ms>0))return;
      items.push({ms:ms,html:'<div class="ln"><span class="t">'+tl(ms)+'</span> <span class="o">'+esc(o.op)+'</span>'+
        (o.d?' <span class="d">'+esc(o.d)+'</span>':'')+'</div>'});
    });
    if(!items.length){el.innerHTML='<div class="ln d">no activity yet</div>';return}
    items.sort(function(a,b2){return a.ms-b2.ms});
    var pinned=el.scrollHeight-el.scrollTop-el.clientHeight<40;
    el.innerHTML=items.slice(-250).map(function(i){return i.html}).join('');
    if(pinned)el.scrollTop=el.scrollHeight;
  }

  function tick(){
    fetch('/api/u/${h}/budget').then(function(r){return r.json()}).then(function(j){window.__b=j;window.__bAt=Date.now();renderAll();}).catch(function(){});
    fetch('/api/u/${h}/feed?n=200').then(function(r){return r.json()}).then(function(j){
      window.__ev=(j.events||[]).filter(function(e){return e.billed>0&&e.surface!=='directive'});
      renderAll();renderTerm();
    }).catch(function(){});
    fetch('/api/u/${h}/ops?n=100').then(function(r){return r.json()}).then(function(j){
      window.__ops=j.ops||[];renderAll();renderTerm();
    }).catch(function(){});
  }
  // hover: per-minute tokens + what maxx did in that minute
  (function(){
    var c48=document.getElementById('chart48'),tip=document.getElementById('tip48'),g48=document.getElementById('guide48');
    c48.addEventListener('mousemove',function(evt){
      var st=window.__chartMins;if(!st)return;
      var r=c48.getBoundingClientRect();
      var idx=Math.max(0,Math.min(47,Math.floor((evt.clientX-r.left)/r.width*48)));
      var ts=new Date((st.t-(47-idx)*60)*1000);
      var hh=String(ts.getHours()).padStart(2,'0')+':'+String(ts.getMinutes()).padStart(2,'0');
      // one line, below the axis: lead with the signed number the bar is drawing,
      // then the arithmetic behind it. Never covers the bars it describes.
      var out=st.buckets[idx],pc=st.pace||0,over=out>pc;
      var html=esc(hh)+' · <span style="color:'+(over?'#c2703a':'#15803d')+'">'+(over?'−':'+')+esc(hum(Math.abs(pc-out)))+(over?' over':' banked')+'</span>'+
        ' <span class="mut">· '+esc(hum(out))+' out of '+esc(hum(pc))+'/min allowance</span>';
      var m=st.ops[idx];
      if(m)m.items.slice(0,2).forEach(function(x){html+=' <span class="pr">· '+(m.prot?'🛡 ':'')+esc(x)+'</span>'});
      tip.innerHTML=html;
      g48.style.display='block';
      g48.style.left=((idx+0.5)/48*r.width).toFixed(1)+'px';
    });
    c48.addEventListener('mouseleave',function(){tip.innerHTML='';g48.style.display='none'});
  })();
  tick();setInterval(tick,10000);
  setInterval(renderBudget,1000); // liveness: drift the bars + tiles every second, snap on poll
})();
</script>
</body></html>`;
}

const json = (status, obj) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const rpcOk = (id, result) => json(200, { jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => json(200, { jsonrpc: "2.0", id, error: { code, message } });

// secretFor(handle) = PER-HANDLE secret only (e.g. MAXX_SECRET_<HANDLE> env);
// fallbackSecret = shared operator secret that also gates unclaimed handles on a
// public deploy — it must NOT make handles look "taken" to signup.
export function createHandler({ store, secretFor = () => null, fallbackSecret = null, now = () => Date.now() / 1000, probe = probeAnchor }) {
  // ---- per-handle mutex -----------------------------------------------------
  // Every mutating path here is load → mutate → save with an await in the middle. Two
  // requests for the same handle therefore both read the PRE-write doc, and the second
  // save silently drops whatever the first added — which is exactly the product's own
  // workload: a laptop and a cloud routine emitting at the same second. The tally runs as
  // one process, so serializing per handle makes each request's read-modify-write atomic.
  // Keyed by handle, so different customers never wait on each other.
  const chains = new Map();
  function withHandleLock(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);            // a failed predecessor must not skip us
    const tail = run.catch(() => {});         // ...and must not poison the chain either
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  }
  // Which handle a request touches. Everything handle-scoped is /u/{h} or /api/u/{h};
  // signup writes the shared _auth doc, and an MCP call carries its handle in the query.
  const lockKey = (req) => {
    try {
      const u = new URL(req.url, "http://x");
      const m = u.pathname.match(/^\/(?:api\/)?u\/([a-zA-Z0-9][a-zA-Z0-9_-]{2,31})/);
      if (m) return m[1].toLowerCase();
      if (u.pathname === "/api/signup") return "_auth";
      if (u.pathname === "/mcp") {
        // The handle may ride in the JSON-RPC body (args.handle) instead of the query.
        // Locking those on "_mcp" serialized them with each other but NOT with query-form
        // MCP or HTTP requests for the same handle — so two dispatchers reserving through
        // different transports held different locks, both read the pre-write doc, and
        // both granted the same allowance (double-spend).
        let h = u.searchParams.get("handle");
        if (!h) { try { h = JSON.parse(req.body || "{}").params?.arguments?.handle; } catch {} }
        return (h || "_mcp").toLowerCase();
      }
    } catch {}
    return null;
  };

  const bearer = (headers) => {
    const h = headers.authorization || headers.Authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1] : "";
  };
  // Token from the Bearer header OR a ?k= query param — the query form lets a
  // claude.ai custom connector self-authenticate via the URL alone (it can't
  // always set an Authorization header).
  const tokenOf = (headers, url) => bearer(headers) || url.searchParams.get("k") || "";
  // Browser auth: HttpOnly cookie set by POST /api/u/:h/login, so the secret never
  // has to appear in a URL (history, logs, screenshots). Honored for GET READS ONLY
  // — mutating endpoints stay bearer/?k=, which closes the CSRF door (SameSite=Lax
  // is the backstop). The cookie carries the secret itself: single owner per handle,
  // stateless, nothing server-side to expire.
  const cookieK = (headers) => {
    const m = /(?:^|;\s*)maxx_k=([^;]+)/.exec(headers.cookie || headers.Cookie || "");
    return m ? decodeURIComponent(m[1]) : "";
  };
  const readTokenOf = (headers, url) => tokenOf(headers, url) || cookieK(headers);
  const setCookie = (v) => `maxx_k=${encodeURIComponent(v)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
  // Mutations from the BROWSER (settings page): cookie accepted only when the Origin
  // header is same-origin — the standard CSRF defense (SameSite=Lax is the backstop).
  // Bearer/?k= callers (CLI, MCP, curl) are unaffected: no cookie, no Origin needed.
  const sameOrigin = (headers) => {
    const o = headers.origin || headers.Origin || "";
    if (!o) return false;
    const host = (headers["x-forwarded-host"] || headers.host || "").split(",")[0].trim();
    try { return new URL(o).host === host || new URL(o).host === "meetmaxx.co"; } catch { return false; }
  };
  const mutAuthed = async (h, headers, url) => {
    if (await authed(h, tokenOf(headers, url))) return true;
    const ck = cookieK(headers);
    return !!ck && sameOrigin(headers) && (await authed(h, ck));
  };
  // A token compared with === leaks its prefix through timing. Over the public internet that
  // is a weak channel, but it costs nothing to close and this is the only credential check.
  const sameSecret = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const x = Buffer.from(a), y = Buffer.from(b);
    if (x.length !== y.length) return false;      // length still leaks; the secret is fixed-length
    return timingSafeEqual(x, y);
  };

  // ---- credential kinds -----------------------------------------------------
  // The ACCOUNT SECRET is the master credential: it can rotate itself, mint connector
  // tokens, and open the dashboard. It must never end up in a URL.
  // A CONNECTOR TOKEN (ct_…) is what goes in the claude.ai connector URL, because that
  // client cannot always set an Authorization header. It is therefore assumed to be
  // exposed — query strings land in proxy logs, browser history and screenshots — so it
  // is separately revocable and may NOT rotate the secret, mint more tokens, or mint a
  // dashboard login. Losing it costs the customer a revoke, not their account.
  // ---- auth throttle --------------------------------------------------------
  // Guessing was free: unlimited 401s, no record, nothing to alert on. 144 bits is not
  // brute-forceable, but a leaked-and-partially-redacted token, a log scrape or a bad
  // future credential all become cheap without a ceiling. Per handle+IP so one attacker
  // cannot lock out the real owner, and the window is short so a fat-fingered CLI
  // recovers on its own rather than filing a support ticket.
  const FAIL_MAX = 10;              // attempts before the door shuts
  const FAIL_WINDOW_SEC = 900;      // rolling window and lockout length
  const fails = new Map();          // key -> {n, first, until}
  const failKey = (handle, headers) =>
    `${handle}|${String(headers["x-forwarded-for"] || headers["cf-connecting-ip"] || headers["x-real-ip"] || "?").split(",")[0].trim()}`;
  const throttled = (key, t) => {
    const f = fails.get(key);
    return !!(f && f.until && f.until > t);
  };
  const noteFail = (key, t) => {
    const f = fails.get(key);
    if (!f || t - f.first > FAIL_WINDOW_SEC) { fails.set(key, { n: 1, first: t, until: 0 }); return; }
    f.n += 1;
    if (f.n >= FAIL_MAX) f.until = t + FAIL_WINDOW_SEC;
    // bound the map so a spray across handles cannot grow it without limit
    if (fails.size > 5000) for (const [k, v] of fails) { if (t - v.first > FAIL_WINDOW_SEC && !(v.until > t)) fails.delete(k); }
  };
  const noteOk = (key) => fails.delete(key);

  const CONNECTOR_PREFIX = "ct_";
  const isConnectorToken = (t) => typeof t === "string" && t.startsWith(CONNECTOR_PREFIX);
  const connectorTokens = async (handle) => ((await store.load(handle)).connector_tokens || []);

  // Self-serve secrets (signup) live in the store; env secrets (MAXX_SECRET*) are
  // the operator fallback that also gates unclaimed handles on a public deploy.
  const authed = async (handle, token) => {
    const want = (await store.getSecret?.(handle)) || (await secretFor(handle)) || fallbackSecret;
    if (!want) return true; // no secret configured at all → open (local/dev)
    if (!token) return false;
    if (sameSecret(token, want)) return true;
    if (isConnectorToken(token)) {
      const live = await connectorTokens(handle);
      return live.some((t) => !t.revoked && sameSecret(token, t.token));
    }
    return prevSecretOk(await store.load(handle), token, now());
  };
  // The just-rotated secret, honored until its grace window closes, so a fleet can be
  // updated machine by machine instead of all going dark the instant rotation happens.
  const prevSecretOk = (s, token, t) =>
    !!(s?.secret_prev && s.secret_prev.expires > t && sameSecret(token, s.secret_prev.secret));
  // Full authority: the master secret only. Guards the endpoints where a stolen
  // connector token would otherwise be as good as the account itself.
  const ownerAuthed = async (handle, token) => {
    const want = (await store.getSecret?.(handle)) || (await secretFor(handle)) || fallbackSecret;
    if (!want) return true;
    if (!token) return false;
    if (sameSecret(token, want)) return true;
    // a mid-rotation machine still holds the old secret and is still the owner
    return prevSecretOk(await store.load(handle), token, now());
  };

  // ---- webhook push (#1/#3): fire transition events to registered URLs.
  // Fire-and-forget with a timeout; a dead consumer never blocks ingest.
  function fireWebhooks(handle, s, events) {
    for (const hook of s.webhooks || []) {
      for (const ev of events) {
        const payload = { ...ev, handle };
        const isDash = hook.format === "dash";
        const body = isDash
          ? JSON.stringify({ source: "maxx", kind: `budget-${ev.event}`, payload: { text: `maxx: ${ev.event} verdict=${ev.verdict} spend=${ev.session_to_spend} week=${Math.round((ev.week || 0) * 100)}%${ev.session ? ` session=${ev.session}` : ""}` } })
          : JSON.stringify(payload);
        fetch(hook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(hook.secret ? { authorization: `Bearer ${hook.secret}` } : {}),
            ...(hook.headers || {}),
          },
          body,
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }
    }
  }

  // Recompute state + fire any transition webhooks. Used after every ingest AND
  // by the periodic sweep (refills happen on the clock, not on an ingest).
  function settle(handle, s) {
    const t = now();
    s.leases = (s.leases || []).filter((l) => l.expires > t);   // prune expired
    const b = computeBudget(s, t);
    const events = transitionEvents(s, b, t);
    if (events.length) fireWebhooks(handle, s, events);
    return { budget: b, events };
  }

  async function ingest(handle, env) {
    const s = await store.load(handle);
    const res = applyEnvelope(s, env || {}, now());
    settle(handle, s);
    // Watchdog runs on the ingest path because that is the one thing guaranteed to
    // fire while a session is burning: every interactive turn ships an emit.
    const advised = autoAdvise(s, now());
    for (const a of advised)
      logOp(s, "watchdog", `advised /clear → ${(a.name || a.session).slice(0, 32)} · ctx ${Math.round(a.ctx / 1e3)}k · ${Math.round(a.rate / 1e3)}k/min`, now());
    await store.save(handle, s);
    return advised.length ? { ...res, advised: advised.length } : res;
  }
  // Pull-on-miss: the anchor is a cache of Anthropic's limit state that the laptop
  // normally PUSHES. When the push is missing (asleep, off, account switched) the
  // anchor ages past TRUST and the fleet reads stale/over on an untouched budget.
  // So pull one. Costs ~1 token, and only ever fires while the push is already gone.
  // Rate-limited by probe_at, which is stamped BEFORE the call so a failing probe
  // (dead token, network) backs off exactly like a successful one.
  const PROBE_MIN_INTERVAL = 300;
  async function maybeRefreshAnchor(handle, s, t) {
    const token = s.probe?.token;
    if (!token) return false;
    if (anchorAgeSec(s, t) <= ANCHOR_TRUST_SEC) return false;
    if (t - (s.probe.at || 0) < PROBE_MIN_INTERVAL) return false;
    s.probe.at = t;
    const anchor = await probe(token, { now: t });
    if (!anchor) { logOp(s, "probe", "failed — no usable ratelimit headers", t); return false; }
    s.anchors.push(anchor);
    if (s.anchors.length > 500) s.anchors = s.anchors.slice(-500);
    logOp(s, "probe", `pulled anchor · 5h ${Math.round(anchor.five_pct * 100)}% · 7d ${Math.round(anchor.week_pct * 100)}%`, t);
    return true;
  }

  async function budget(handle) {
    const s = await store.load(handle);
    const t = now();
    if (await maybeRefreshAnchor(handle, s, t)) await store.save(handle, s);
    return computeBudget(s, t);
  }

  // #4: grant a lease against the CURRENT allowance (which already subtracts
  // other active leases) — two concurrent dispatchers can't double-spend.
  // Bounded so a retry loop can't grow the doc without limit: total lease tokens are
  // already capped by the allowance, but 1-token grants could stack thousands of rows.
  const MAX_LEASES = 100;
  async function reserve(handle, { tokens, ttl_sec = 3600, label = null, lease_id = null } = {}) {
    tokens = Math.round(Number(tokens));
    if (!(tokens > 0)) return { granted: false, error: "tokens must be > 0" };
    const s = await store.load(handle);
    const t = now();
    s.leases = (s.leases || []).filter((l) => l.expires > t);
    // renew: passing your own lease_id REPLACES that lease (resize/extend) instead of
    // stacking a second one — the old hold doesn't count against the new grant's allowance.
    if (lease_id) s.leases = s.leases.filter((l) => l.id !== lease_id);
    if (s.leases.length >= MAX_LEASES)
      return { granted: false, error: `too many active leases (max ${MAX_LEASES})` };
    await maybeRefreshAnchor(handle, s, t);   // a fan-out must not be sized off a dead anchor
    const b = computeBudget(s, t);
    const avail = b.session_to_spend ?? 0;
    // degraded (no fresh /usage anchor, weekly standing still live) still grants —
    // otherwise a sleeping laptop leaves fan-outs unreserved and unguarded.
    if (!(b.verdict === "ok" || b.verdict === "degraded") || tokens > avail)
      return { granted: false, remaining: avail, verdict: b.verdict };
    const lease = { id: randomBytes(8).toString("hex"), tokens, expires: Math.round(t + Math.min(Math.max(ttl_sec, 60), 6 * 3600)), label };
    s.leases.push(lease);
    logOp(s, "reserve", `${Math.round(tokens / 1000)}k granted${label ? ` · ${label}` : ""}`, t);
    await store.save(handle, s);
    return { granted: true, lease_id: lease.id, tokens, remaining: avail - tokens, expires_at: lease.expires };
  }

  // The other half of the lease contract: a fan-out that lands must give its hold back.
  // The spend already reached the ledger via emits, so a lingering lease double-throttles
  // every other dispatcher's session_to_spend until the TTL runs out.
  async function release(handle, { lease_id = null } = {}) {
    const s = await store.load(handle);
    const t = now();
    s.leases = (s.leases || []).filter((l) => l.expires > t);
    const before = s.leases.length;
    s.leases = s.leases.filter((l) => l.id !== lease_id);
    const released = before - s.leases.length;
    if (released) logOp(s, "release", `lease ${String(lease_id).slice(0, 8)} released`, t);
    await store.save(handle, s);
    return { ok: true, released };
  }

  // periodic sweep for time-driven transitions (refill while idle) — serve.mjs
  // calls this on an interval; handles without webhooks are skipped cheaply.
  async function sweepTransitions() {
    if (!store.listHandles) return;
    for (const h of await store.listHandles()) {
      // same lock as the request path: the sweep is a load→mutate→save too, and it runs on a
      // timer, so without it the one writer that is guaranteed to collide with a live emit is us
      await withHandleLock(h, async () => {
        const s = await store.load(h);
        if (!(s.webhooks || []).length) return;
        const { events } = settle(h, s);
        await store.save(h, s);
        if (events.length) console.log(`sweep: ${h} fired ${events.map((e) => e.event).join(",")}`);
      });
    }
  }

  // route() does the work; handle() wraps every response with CORS (and answers preflights) so the
  // web signup form can call the API cross-origin.
  async function handle(req) {
    if ((req.method || "GET") === "OPTIONS") return { status: 204, headers: { ...CORS }, body: "" };
    const key = lockKey(req);
    // Throttle at the outermost edge rather than inside each check: every route funnels its
    // rejection through a 401, so one place here covers all ~18 auth sites and cannot drift
    // out of sync with them as routes are added.
    const t = now();
    const fk = key ? failKey(key, req.headers || {}) : null;
    if (fk && throttled(fk, t))
      return {
        status: 429,
        headers: { ...CORS, "content-type": "application/json", "retry-after": String(FAIL_WINDOW_SEC) },
        body: JSON.stringify({ error: "too many failed auth attempts for this handle — try again shortly" }),
      };
    const r = key ? await withHandleLock(key, () => route(req)) : await route(req);
    // Only failures are counted, never reset on success: a public 200 (the shareable card)
    // needs no credential, so crediting it would hand an attacker a free counter reset.
    if (fk && r.status === 401) noteFail(fk, t);
    return { ...r, headers: { ...CORS, ...(r.headers || {}) } };
  }

  async function route(req) {
    const { method = "GET", headers = {}, body = "" } = req;
    let url;
    try { url = new URL(req.url, "http://x"); } catch { return json(400, { error: "bad url" }); }
    const p = url.pathname;

    if (method === "GET" && (p === "/" || p === "/health")) return json(200, { ok: true, service: "maxx-tally" });
    if (method === "GET" && (p === "/favicon.svg" || p === "/favicon.ico" || p === "/icon"))
      return { status: 200, headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }, body: FAVICON };

    // ---- live public card: GET /u/{handle} — renders from the tally on every hit, so the page a
    // user shares is always current (the old static card went stale the moment it was deployed).
    // meetmaxx.co/u/* rewrites here. Public by design: usage totals only, same as the static card.
    const mc = p.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,31})(\/live\.json)?\/?$/);
    if (mc && method === "GET") {
      const h = mc[1];
      const s = await store.load(h);
      // No events yet: a REGISTERED handle (freshly web-claimed, first emit still in
      // flight) renders the page empty — the installer prints these URLs immediately
      // and they must not be dead links. Only unregistered names 404.
      if (!s.events.length && !((await store.getSecret?.(h)) || (await secretFor(h)))) return mc[2]
        ? json(404, { error: "no data" })
        : { status: 404, headers: { "content-type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><title>maxx</title><p style="font-family:sans-serif;padding:40px">No usage for <b>@${h}</b> yet — <a href="https://meetmaxx.co/install">install the tracker</a>.</p>` };
      const budget = computeBudget(s, now());
      // live.json — PUBLIC, counts-only poll target for the card's live feed: lifetime odometer,
      // availability, and the last events as {ago_sec, surface CLASS, tokens}. Never session/project
      // names here — those stay behind auth; the public card leaks no content, only magnitudes.
      if (mc[2]) {
        const t = now();
        // real burn only: zero-ts / zero-token / directive rows are bookkeeping, not usage
        // (legacy events surfaced as "cloud · 20655d ago +0" — epoch-0 timestamps).
        // One row PER CHANNEL (a stable surface id = one machine / one cloud routine), not per
        // turn. Labels are anonymized by first-seen order ("machine 1", "cloud 1") — real surface
        // ids stay behind auth; the public card leaks no content, only magnitudes.
        const real = s.events.filter((e) => e.ts > 0 && (e.raw || e.billed) > 0 && e.surface !== "directive");
        const chans = new Map(); // surface → rollup, insertion order = first-seen order
        let mi = 0, ci = 0;
        for (const e of real) {
          let c = chans.get(e.surface);
          if (!c) {
            const cls = String(e.surface || "").split(":")[0];
            c = { channel: cls === "cloud" ? `cloud ${++ci}` : `machine ${++mi}`, last: 0, h1: 0 };
            chans.set(e.surface, c);
          }
          if (e.ts > c.last) c.last = e.ts;
          if (e.ts > t - 3600) c.h1 += e.raw || e.billed;
        }
        const feed = [...chans.values()].sort((a, b2) => b2.last - a.last)
          .map((c) => ({ channel: c.channel, ago_sec: Math.max(0, Math.round(t - c.last)), tokens_1h: c.h1 }));
        const lifetime = s.events.reduce((a, e) => a + (e.raw || e.billed || 0), 0);
        return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
          body: JSON.stringify({
            lifetime, available: budget.session_to_spend, burn_5m: budget.burn_5m,
            // magnitudes for the card's session/week bars — counts only, same class of
            // data as "available"; never names
            five_billed: budget.five_billed, week: budget.week, quota: budget.quota,
            weekly_left: budget.weekly_left_tokens, session_over: budget.session_over,
            week_billed: budget.week_billed, week_bank: budget.week_bank, net_per_min: budget.net_per_min,
            five_reset_in_sec: budget.five_reset_in_sec, week_reset_in_sec: budget.week_reset_in_sec,
            fresh: budget.fresh, anchor_age_sec: budget.anchor_age_sec, verdict: budget.verdict, feed,
          }) };
      }
      // owner view: /u/{h}?k={secret} adds the private setup-check panel — "is my install right?"
      // Three signals, each with its fix: CLI shipping (laptop events), connector connected (authed
      // mcp ping), anchor fresh (an interactive session saw /usage recently).
      let setup = null;
      const tok = readTokenOf(headers, url);
      if (tok && (await authed(h, tok))) {
        const t = now();
        const lastOf = (pfx) => s.events.reduce((a, e) => (String(e.surface || "").startsWith(pfx) && e.ts > a ? e.ts : a), 0);
        const lastLaptop = lastOf("laptop"), lastCloud = Math.max(s.mcp_seen || 0, lastOf("cloud"));
        setup = {
          cli: { ok: t - lastLaptop < 1800, ago: lastLaptop ? Math.round(t - lastLaptop) : null },
          connector: { ok: t - lastCloud < 7 * 86400, ago: lastCloud ? Math.round(t - lastCloud) : null },
          anchor: { ok: budget.fresh ? true : budget.verdict === "degraded" ? "warn" : false, ago: budget.anchor_age_sec },
        };
      }
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": setup ? "no-store" : "public, max-age=60" }, body: renderCard(h, s, budget, setup) };
    }

    // ---- owner dashboard: GET /u/{handle}/dash?k={secret}. Session/project NAMES render here,
    // so unlike the public card this is auth-required — no valid secret, no page.
    const md = p.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,31})\/dash\/?$/);
    if (md && method === "GET") {
      const h = md[1];
      // magic link (?m=): single-use, short-TTL token minted by POST /api/u/:h/magic.
      // Consume it → set the auth cookie → clean redirect. Being one-shot makes the
      // URL harmless in history/logs the moment it's used.
      // NO server-side redirects here: the Netlify proxy re-appends the original query
      // string to Location headers, which turns a strip-the-token redirect into a loop.
      // Instead: serve the dash directly with Set-Cookie, and the page itself cleans the
      // address bar via history.replaceState — the token/secret URL never even survives
      // as a history entry.
      const s = await store.load(h);
      const dashPage = (cookieVal, owner = true) => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(cookieVal ? { "set-cookie": setCookie(cookieVal) } : {}) },
        body: renderDash(h, s, { owner }),
      });
      const mtok = url.searchParams.get("m");
      if (mtok) {
        const t = now();
        const live = (s.magic || []).filter((x) => x.exp > t);
        const hit = live.find((x) => x.t === mtok);
        s.magic = live.filter((x) => x !== hit);
        await store.save(h, s);
        if (hit) {
          logOp(s, "auth:magic", "link consumed", t);
          await store.save(h, s);
          const want = (await store.getSecret?.(h)) || (await secretFor(h)) || fallbackSecret;
          return dashPage(want);
        } // invalid/expired → fall through to cookie check / login form
      }
      const tok = readTokenOf(headers, url);
      if (!tok || !(await authed(h, tok))) {
        // no secret → the dash IS the shareable card: same page, but every data
        // endpoint it polls serves the redacted (names-hidden) view. ?login=1 is
        // the owner's way in from the shared page.
        if (url.searchParams.get("login"))
          return { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: renderLogin(h) };
        if (!s.events.length && !((await store.getSecret?.(h)) || (await secretFor(h))))
          return { status: 404, headers: { "content-type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><title>maxx</title><p style="font-family:sans-serif;padding:40px">No usage for <b>@${h}</b> yet — <a href="https://meetmaxx.co/install">install the tracker</a>.</p>` };
        return dashPage(null, false);
      }
      // legacy ?k= link: convert the secret to the cookie; replaceState scrubs it client-side
      const qk = url.searchParams.get("k");
      return dashPage(qk || null);
    }

    // ---- analytics tab: week-vs-wall + tokens-over-time. Magnitudes only (no names),
    // so it mirrors the dash's viewer model: owner cookie → settings tab shows; anyone
    // else gets the same numbers as the shared dash. ?k= works like the dash's.
    const man = p.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,31})\/analytics\/?$/);
    if (man && method === "GET") {
      const h = man[1];
      const s = await store.load(h);
      if (!s.events.length && !((await store.getSecret?.(h)) || (await secretFor(h))))
        return { status: 404, headers: { "content-type": "text/html" }, body: `<!doctype html><meta charset="utf-8"><title>maxx</title><p style="font-family:sans-serif;padding:40px">No usage for <b>@${h}</b> yet — <a href="https://meetmaxx.co/install">install the tracker</a>.</p>` };
      const tok = readTokenOf(headers, url);
      const owner = !!(tok && (await authed(h, tok)));
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        body: renderAnalytics(h, s, { owner, ww: weekWallSeries(s, now()) }),
      };
    }

    // ---- magic link mint: CLI (holding the secret as bearer) asks for a one-time
    // sign-in URL — single-use, 120s TTL, opens the dash with zero copy-paste.
    // ---- rotate the account secret -------------------------------------------
    // Needed the day a secret is exposed — and ours were, in every ?k= URL that reached a
    // proxy log before connector tokens existed. A hard swap would break every surface at
    // once (each machine holds the secret in ~/.maxx/config.json), so the old one keeps
    // working for a grace window: rotate, update machines, let the old expire. Expand then
    // contract, the same shape a schema migration uses.
    const rt = p.match(/^\/api\/u\/([^/]+)\/rotate-secret$/);
    if (rt && method === "POST") {
      const h = decodeURIComponent(rt[1]);
      if (!store.setSecret) return json(404, { error: "rotation not enabled on this deploy" });
      if (!(await ownerAuthed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let b = {}; try { b = JSON.parse(body || "{}"); } catch {}
      const graceSec = Math.min(Math.max(Number(b.grace_sec) || 1800, 0), 24 * 3600);
      const t = now();
      const old = await store.getSecret(h);
      const next = randomBytes(18).toString("base64url");
      const s = await store.load(h);
      s.secret_prev = old && graceSec > 0 ? { secret: old, expires: Math.round(t + graceSec) } : null;
      logOp(s, "auth:rotate", `secret rotated, old valid ${Math.round(graceSec / 60)}m`, t);
      await store.save(h, s);
      await store.setSecret(h, next);
      return json(200, {
        ok: true, secret: next,
        old_valid_until: s.secret_prev ? s.secret_prev.expires : null,
        next: [
          "SAVE it — shown once.",
          `On every machine: edit ~/.maxx/config.json and replace "secret" (${graceSec / 60}m before the old one stops working).`,
          "Connector URLs are unaffected: they carry a ct_ token, not this secret.",
        ],
      });
    }

    // ---- connector tokens: the credential that is allowed to live in a URL ----
    // GET  lists them (never the token itself — it is shown once, like the secret)
    // POST mints one, DELETE {id} revokes. Master secret only: a token must never be able
    // to mint its own replacement or revoke a sibling.
    const ctm = p.match(/^\/api\/u\/([^/]+)\/connector-tokens\/?$/);
    if (ctm) {
      const h = decodeURIComponent(ctm[1]);
      if (!(await ownerAuthed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      const s = await store.load(h);
      s.connector_tokens = s.connector_tokens || [];
      const t = now();
      if (method === "GET")
        return json(200, {
          tokens: s.connector_tokens.map(({ id, label, created, revoked, last_used }) =>
            ({ id, label, created, revoked: !!revoked, last_used: last_used || null })),
        });
      if (method === "POST") {
        let b = {}; try { b = JSON.parse(body || "{}"); } catch {}
        const token = CONNECTOR_PREFIX + randomBytes(24).toString("base64url");
        const rec = { id: randomBytes(6).toString("hex"), token, label: String(b.label || "connector").slice(0, 64), created: Math.round(t), revoked: false };
        s.connector_tokens = [...s.connector_tokens, rec].slice(-20);
        logOp(s, "auth:connector-token", `minted ${rec.id} (${rec.label})`, t);
        await store.save(h, s);
        const base2 = `https://${headers["x-forwarded-host"] || headers.host || "api.meetmaxx.co"}`;
        return json(200, { ok: true, id: rec.id, token, mcp_url: `${base2}/mcp?handle=${h}&k=${token}`, note: "shown once — revoke and re-mint if exposed" });
      }
      if (method === "DELETE") {
        const id = url.searchParams.get("id") || "";
        const rec = s.connector_tokens.find((x) => x.id === id);
        if (!rec) return json(404, { error: "no such token" });
        rec.revoked = true;
        logOp(s, "auth:connector-token", `revoked ${id}`, t);
        await store.save(h, s);
        return json(200, { ok: true, revoked: id });
      }
    }

    const mg = p.match(/^\/api\/u\/([^/]+)\/magic$/);
    if (mg && method === "POST") {
      const h = decodeURIComponent(mg[1]);
      // Master secret only. A magic link is a full owner login, so letting the connector
      // token mint one would hand back everything the token was scoped away from.
      if (!(await ownerAuthed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" }); // bearer/?k= only, never cookie
      const s = await store.load(h);
      const t = now();
      const tok = randomBytes(16).toString("base64url");
      s.magic = [...(s.magic || []).filter((x) => x.exp > t), { t: tok, exp: Math.round(t + 120) }].slice(-5);
      await store.save(h, s);
      const host = headers["x-forwarded-host"] || headers.host || "api.meetmaxx.co";
      // hand back the public-site URL when minted against the api host — same page, prettier link
      const site = host === "api.meetmaxx.co" ? "meetmaxx.co" : host;
      return json(200, { url: `https://${site}/u/${h}/dash?m=${tok}`, expires_in_sec: 120 });
    }

    // ---- owner settings: same auth model as the dash (cookie; ?k= sets the cookie) ----
    const ms = p.match(/^\/u\/([a-z0-9][a-z0-9_-]{2,31})\/settings\/?$/);
    if (ms && method === "GET") {
      const h = ms[1];
      const tok = readTokenOf(headers, url);
      if (!tok || !(await authed(h, tok)))
        return { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: renderLogin(h) };
      const s = await store.load(h);
      const qk = url.searchParams.get("k");
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(qk ? { "set-cookie": setCookie(qk) } : {}) }, body: renderSettings(h, s, computeBudget(s, now())) };
    }

    // ---- browser login: secret arrives in the BODY, leaves as an HttpOnly cookie ----
    const ml = p.match(/^\/api\/u\/([^/]+)\/login$/);
    if (ml && method === "POST") {
      const h = decodeURIComponent(ml[1]);
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const secret = String(b.secret || "");
      // The dashboard cookie carries whatever authenticated here, so a connector token must
      // not be a login — it would become a durable browser session for a URL-borne credential.
      const ok = secret && (await ownerAuthed(h, secret));
      { const so = await store.load(h); logOp(so, "auth:login", ok ? "ok" : "FAILED attempt", now()); await store.save(h, so); }
      if (!ok) return json(401, { error: "wrong secret" });
      return { status: 200, headers: { "content-type": "application/json", "set-cookie": setCookie(secret) }, body: JSON.stringify({ ok: true }) };
    }

    // ---- signup: claim a handle, mint its secret (first come, first served) ----
    if (p === "/api/signup" && method === "POST") {
      if (!store.setSecret) return json(404, { error: "signup not enabled on this deploy" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const h = String(b.handle || "").toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(h))
        return json(400, { error: "handle must be 3-32 chars: a-z 0-9 - _ (no leading - or _)" });
      if ((await store.getSecret(h)) || (await secretFor(h)) || (await store.load(h)).events.length)
        return json(409, { error: `handle "${h}" is taken` });
      const secret = randomBytes(18).toString("base64url");
      await store.setSecret(h, secret);
      // Optional Claude-account binding: Claude only works logged in, so the account uuid is the one
      // identity every surface can key off. Emits carry it too; stored here so a handle is findable
      // by account later (multi-machine join, per-account timelines).
      if (b.account) { const s = await store.load(h); s.account = String(b.account).slice(0, 64); s.account_email = String(b.email || "").slice(0, 128); await store.save(h, s); }
      const base = `https://${headers["x-forwarded-host"] || headers.host || "api.meetmaxx.co"}`;
      // The connector URL gets a SCOPED token, never the account secret. That URL is pasted
      // into claude.ai and travels through proxy logs and browser history; whatever is in it
      // should be revocable on its own, without resetting the customer's account.
      const ct = CONNECTOR_PREFIX + randomBytes(24).toString("base64url");
      { const s0 = await store.load(h);
        s0.connector_tokens = [{ id: randomBytes(6).toString("hex"), token: ct, label: "signup", created: Math.round(now()), revoked: false }];
        await store.save(h, s0); }
      return json(200, {
        ok: true, handle: h, secret, connector_token: ct,
        mcp_url: `${base}/mcp?handle=${h}&k=${ct}`,
        logs_url: `${base}/api/u/${h}/logs`,
        budget_url: `${base}/api/u/${h}/budget`,
        feed_url: `${base}/api/u/${h}/feed`,
        next: [
          "SAVE the secret — it is shown once and not recoverable.",
          `Install: curl -fsSL https://meetmaxx.co/install | MAXX_HANDLE=${h} MAXX_SECRET=${secret} bash`,
          `Cloud (optional): open https://claude.ai/settings/connectors → Add custom connector → name "Maxx", URL = mcp_url above. Every agent with it gets the budget-gate rules automatically. NOTE: it auto-attaches to NEW routines only — add it to pre-existing routines by hand.`,
        ],
      });
    }

    // ---- REST ----
    let m = p.match(/^\/api\/u\/([^/]+)\/logs$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let env; try { env = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const res = await ingest(h, env);
      return json(200, { ok: true, ...res });
    }
    m = p.match(/^\/api\/u\/([^/]+)\/budget$/);
    if (m && method === "GET") {
      const h = decodeURIComponent(m[1]);
      // cookie accepted: GET read, powers the owner dashboard
      const b = await budget(h);
      if (await authed(h, readTokenOf(headers, url))) return json(200, b);
      // PUBLIC read — feeds the shareable dash. Magnitudes/verdict stay; session and
      // project names, surface ids, and directive text are anonymized or dropped.
      const a = publicAnon();
      const merged = new Map(); // surface keys can embed "· project" — strip + merge
      for (const x of b.surfaces || []) {
        const k = a.surface(String(x.surface).split(" · ")[0]);
        merged.set(k, (merged.get(k) || 0) + (x.billed_5h || 0));
      }
      return {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
        body: JSON.stringify({
          ...b,
          top_burners: (b.top_burners || []).map((t) => ({ ...t, surface: a.surface(t.surface), session: a.root(t.session), project: null, name: null })),
          surfaces: [...merged].map(([surface, billed_5h]) => ({ surface, billed_5h })),
          pending_directives: [],
          public: true,
        }),
      };
    }
    // ---- webhooks (#1): register push consumers for state transitions ----
    m = p.match(/^\/api\/u\/([^/]+)\/webhooks$/);
    if (m) {
      const h = decodeURIComponent(m[1]);
      if (!(method === "GET" ? await authed(h, readTokenOf(headers, url)) : await mutAuthed(h, headers, url)))
        return json(401, { error: "unauthorized" });
      const s = await store.load(h);
      s.webhooks = s.webhooks || [];
      if (method === "GET")
        return json(200, { webhooks: s.webhooks.map((w) => ({ url: w.url, format: w.format || "json", secret: w.secret ? "(set)" : null })) });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      if (method === "DELETE") {
        s.webhooks = s.webhooks.filter((w) => w.url !== b.url);
        await store.save(h, s);
        return json(200, { ok: true, webhooks: s.webhooks.length });
      }
      if (method === "POST") {
        if (!/^https?:\/\//.test(b.url || "")) return json(400, { error: "url required" });
        s.webhooks = s.webhooks.filter((w) => w.url !== b.url);
        s.webhooks.push({ url: b.url, secret: b.secret || null, headers: b.headers || null, format: b.format || null });
        await store.save(h, s);
        return json(200, { ok: true, webhooks: s.webhooks.length, events: ["over", "recovered", "week-80", "week-90", "week-95", "runaway"] });
      }
    }
    // ---- reservation lease (#4) ----
    m = p.match(/^\/api\/u\/([^/]+)\/reserve$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      return json(200, await reserve(h, b));
    }
    m = p.match(/^\/api\/u\/([^/]+)\/release$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      return json(200, await release(h, b));
    }
    // ---- per-handle config (#3 overrides: runaway_rate_5m, runaway_min) ----
    m = p.match(/^\/api\/u\/([^/]+)\/config$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await mutAuthed(h, headers, url))) return json(401, { error: "unauthorized" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const s = await store.load(h);
      s.config = { ...(s.config || {}) };
      for (const k of ["runaway_rate_5m", "runaway_min"]) if (b[k] != null) s.config[k] = Number(b[k]);
      // Probe credential: WRITE-ONLY. Kept off s.config so it can never ride out in the
      // config echo below. "" clears it. A setup-token (sk-ant-oat…, user:inference) —
      // it lets the server pull an anchor when the laptop stops pushing one.
      if (b.probe_token != null) s.probe = b.probe_token ? { token: String(b.probe_token), at: 0 } : null;
      await store.save(h, s);
      return json(200, { ok: true, config: s.config, probe: !!s.probe });
    }
    // ---- directive channel: queue a command / agent-side consume ----
    m = p.match(/^\/api\/u\/([^/]+)\/directive$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await mutAuthed(h, headers, url))) return json(401, { error: "unauthorized" });
      let b; try { b = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const s = await store.load(h);
      const res = addDirective(s, b, now());
      if (res.ok) { logOp(s, "directive", `${b.action} → ${b.session}${b.note ? ` · ${b.note}` : ""}`, now()); await store.save(h, s); }
      return json(res.ok ? 200 : 400, res);
    }
    m = p.match(/^\/api\/u\/([^/]+)\/directives$/);
    if (m && method === "GET") {
      const h = decodeURIComponent(m[1]);
      if (!(await authed(h, tokenOf(headers, url)))) return json(401, { error: "unauthorized" });
      const session = url.searchParams.get("session") || "";
      if (!session) return json(400, { error: "session query param required" });
      const peek = url.searchParams.get("peek") === "1";
      const s = await store.load(h);
      const directives = pendingDirectives(s, { session, surface: url.searchParams.get("surface"), peek }, now());
      if (!peek) {
        // delivery is the intervention moment — log it so the cockpit can show it
        if (directives.length) logOp(s, "directive:delivered", `${directives.map((d) => d.action).join(",")} → ${session.slice(0, 8)}`, now());
        await store.save(h, s);
      }
      return json(200, { directives });
    }
    // Ops ring (newest first) — everything on the tally besides emits: MCP gate
    // checks, reserves, directives, auth events. Owner read (cookie ok).
    m = p.match(/^\/api\/u\/([^/]+)\/ops$/);
    if (m && method === "GET") {
      const h = decodeURIComponent(m[1]);
      // ops lines are free text (session names, directive notes, auth events) — the
      // public dash gets an empty ring, not a 401, so the shared page renders clean.
      if (!(await authed(h, readTokenOf(headers, url)))) return json(200, { ops: [], public: true });
      const n = Math.min(300, Math.max(1, Number(url.searchParams.get("n")) || 100));
      const s = await store.load(h);
      return json(200, { ops: (s.ops || []).slice(-n).reverse() });
    }

    // Client-side maxx events (fenix, skills, local tooling) land in the same ops
    // ring the server-side actions use, so the dash tail shows them. Mutation auth.
    m = p.match(/^\/api\/u\/([^/]+)\/op$/);
    if (m && method === "POST") {
      const h = decodeURIComponent(m[1]);
      if (!(await mutAuthed(h, headers, url))) return json(401, { error: "unauthorized" });
      let r; try { r = JSON.parse(body || "{}"); } catch { return json(400, { error: "bad json" }); }
      const op = String(r.op || "").slice(0, 40).replace(/[^\w:.-]/g, "");
      if (!op) return json(400, { error: "op required" });
      const s = await store.load(h);
      logOp(s, op, String(r.d || ""), now());
      await store.save(h, s);
      return json(200, { ok: true });
    }

    // Recent emit events (newest first) — the "who's emitting" feed for `maxx watch`.
    m = p.match(/^\/api\/u\/([^/]+)\/feed$/);
    if (m && method === "GET") {
      const h = decodeURIComponent(m[1]);
      // cookie accepted: GET read, powers the owner dashboard
      const isOwner = await authed(h, readTokenOf(headers, url));
      const n = Math.min(200, Math.max(1, Number(url.searchParams.get("n")) || 30));
      const s = await store.load(h);
      // Absolute turn numbers per session. `turns` on an event is a per-batch DELTA, so
      // counting it up from the returned slice would restart at whatever the window
      // happens to contain and label a session's 200th turn "turn 3". Accumulate over
      // the WHOLE store instead, chronologically, so the numbers mean what they say.
      const run = Object.create(null), endOf = new Map();
      for (const e of s.events) endOf.set(e, (run[e.root] = (run[e.root] || 0) + (e.turns || 0)));
      const events = s.events.slice(-n).reverse().map((e) => ({
        turn_end: endOf.get(e) || 0,
        turn_start: Math.max(1, (endOf.get(e) || 0) - (e.turns || 0) + 1),
        surface: e.surface, root: e.root, ts: new Date(e.ts * 1000).toISOString(),
        ts0: new Date((e.ts0 || e.ts) * 1000).toISOString(),
        billed: e.billed, output: e.output || 0,
        project: e.project || null, name: e.name || null, branch: e.branch || null,
        by_model: e.by_model || {}, turns: e.turns || 0, tool_calls: e.tool_calls || 0,
        agent_turns: e.agent_turns || 0, errors: e.errors || 0, raw: e.raw || 0,
        cache_read: e.cache_read || 0, cache_write: e.cache_write || 0,
        ctx: e.ctx || 0, cost_per_action: e.cost_per_action || 0,
      }));
      if (isOwner) return json(200, { count: s.events.length, events });
      // PUBLIC read — feeds the shareable dash. Directive rows carry free text (their
      // `name` IS the directive) so they're dropped entirely; everything else keeps
      // magnitudes with names/projects/branches nulled and ids anonymized.
      const a = publicAnon();
      const pub = events.filter((e) => e.surface !== "directive")
        .map((e) => ({ ...e, surface: a.surface(e.surface), root: a.root(e.root), project: null, name: null, branch: null }));
      return {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
        body: JSON.stringify({ count: s.events.length, events: pub, public: true }),
      };
    }

    // ---- MCP (JSON-RPC 2.0 over Streamable HTTP) ----
    if (p === "/mcp" && method === "POST") {
      let rpc; try { rpc = JSON.parse(body || "{}"); } catch { return rpcErr(null, -32700, "parse error"); }
      const { id = null, method: rm, params = {} } = rpc;
      // Setup-check heartbeat: claude.ai pings initialize the moment the connector is added, and
      // every session opens with one — so an AUTHED mcp hit is proof "the connector looks correct".
      // Stamped only when the token matches (an unauthenticated ping proves nothing).
      {
        const hh = url.searchParams.get("handle");
        if (hh && (rm === "initialize" || rm === "tools/call") && (await authed(hh, tokenOf(headers, url)))) {
          try { const sh = await store.load(hh); sh.mcp_seen = now(); await store.save(hh, sh); } catch {}
        }
      }
      if (rm === "initialize") {
        // Icon MUST be same-origin with the server URL — MCP clients (claude.ai included) reject
        // cross-origin icons, which is why the connector page showed no logo while the icon pointed
        // at meetmaxx.co from an api.meetmaxx.co server. Echo a known protocolVersion back too:
        // icons/websiteUrl only render on 2025+ revisions.
        const base = `https://${headers["x-forwarded-host"] || headers.host || "api.meetmaxx.co"}`;
        const KNOWN = ["2024-11-05", "2025-03-26", "2025-06-18"];
        return rpcOk(id, {
          protocolVersion: KNOWN.includes(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "Maxx", version: "1", title: "Maxx",
            websiteUrl: "https://meetmaxx.co",
            icons: [{ src: `${base}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }],
          },
          // Server-level directive injected wherever the Maxx connector is enabled —
          // the closest MCP gets to a mandatory gate (still advisory; a PreToolUse
          // hook is the hard block).
          instructions:
            "BUDGET GATE — before any token-expensive work (spawning agents/subagents, long " +
            "generations, builds, large batches) you MUST first call `maxx_budget`. It returns the " +
            "whole account's live budget (all machines + cloud combined). STOP if: verdict is " +
            "\"over\" or \"stale\", or session_to_spend <= 0. \"degraded\" means no machine has read " +
            "/usage recently (a laptop asleep) — the weekly standing is still live from the ledger, so " +
            "PROCEED, but against the weekly numbers (weekly_left_tokens, session_to_spend) and re-check " +
            "more often; do not trust the 5h window fields. If verdict is \"ok\", plan your work against " +
            "session_to_spend — the SAFE envelope: weekly budget paced across the remaining 5h windows " +
            "(so future windows keep giving you fair shares), capped at the 5h wall, net of reserves. " +
            "session_burst is the HARD 5h ceiling you can physically spend to now — use it only if you " +
            "must exceed pace, it eats into future weeks. Two cautions: (1) net_per_min is sustainable " +
            "pace − recent burn; if negative you're spending faster than the week can sustain, so re-check " +
            "before each expensive step, not just once. (2) Before a FAN-OUT (spawning multiple agents at " +
            "once) call `maxx_reserve` for the tokens you'll need FIRST — otherwise every concurrent agent " +
            "sees the same full allowance and the fleet can overspend it — and call `maxx_release` with the " +
            "lease_id when the fan-out completes: the spend is already in the tally via emits, so an unreleased " +
            "lease double-throttles every other dispatcher until its TTL. Hard gate — check it every run. " +
            "BURN REPORT — the gate is half the contract; the other half is that YOUR burn appears in the " +
            "tally. At the END of every run (and at checkpoints in a long one) you MUST call `maxx_emit` " +
            "with surface \"cloud:<routine-name>\" and one sessions[] entry carrying your best-effort " +
            "output-token count for this run (name it after the task so the owner's board can show WHO " +
            "burned WHAT). Leave `anchor` unset — cloud cannot read /usage, and the laptop anchor trues " +
            "totals up. A run that gates but never emits makes the whole account's budget read " +
            "optimistically wrong for every other agent. A BLOCKED run emits nothing — that's fine.",
        });
      }
      if (rm === "notifications/initialized" || rm === "notifications/cancelled")
        return { status: 202, headers: {}, body: "" };
      if (rm === "ping") return rpcOk(id, {});
      if (rm === "tools/list") return rpcOk(id, { tools: TOOLS });
      if (rm === "tools/call") {
        const name = params.name;
        const args = params.arguments || {};
        const h = args.handle || url.searchParams.get("handle") || "";
        if (!h) return rpcOk(id, { isError: true, content: [{ type: "text", text: "no handle (pass args.handle or ?handle=)" }] });
        if (!(await authed(h, tokenOf(headers, url))))
          return rpcOk(id, { isError: true, content: [{ type: "text", text: "unauthorized" }] });
        try {
          if (name === "maxx_emit") {
            const res = await ingest(h, { handle: h, ...args });
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify({ ok: true, ...res }) }] });
          }
          if (name === "maxx_budget") {
            // ops feed: a cloud agent checking the gate is an event the owner wants to
            // see — WITH the outcome, so "maxx held the spend" is visible, not implied
            const bb = await budget(h);
            try {
              const so = await store.load(h);
              logOp(so, "mcp:budget", bb.verdict === "ok" ? "gate check · ok"
                : bb.verdict === "degraded" ? `gate check · DEGRADED — no anchor ${bb.anchor_age_sec}s, weekly standing rules`
                : `gate check · ${String(bb.verdict).toUpperCase()} — spend held`, now());
              await store.save(h, so);
            } catch {}
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(bb) }] });
          }
          if (name === "maxx_reserve") {
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(await reserve(h, args)) }] });
          }
          if (name === "maxx_release") {
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(await release(h, args)) }] });
          }
          if (name === "maxx_directive") {
            const s = await store.load(h);
            const res = addDirective(s, args, now());
            if (res.ok) { logOp(s, "directive", `${args.action} → ${args.session}`, now()); await store.save(h, s); }
            return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(res) }] });
          }
          return rpcOk(id, { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
        } catch (e) {
          return rpcOk(id, { isError: true, content: [{ type: "text", text: `error: ${e.message}` }] });
        }
      }
      return rpcErr(id, -32601, `method not found: ${rm}`);
    }

    return json(404, { error: "not found" });
  }

  handle.sweepTransitions = sweepTransitions;   // for the runner's interval
  return handle;
}

export { TOOLS };
