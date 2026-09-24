/**
 * maxx accounts — every login on this box, side by side.
 *
 * `switch` already knew all of this and threw it away: it probes every account, ranks them and
 * prints one export line. The question "what have I got" has no answer anywhere — you find out
 * you are walled by hitting the wall, and you find out a second login was idle all day by not
 * finding out. A fleet of logins you cannot see is a fleet you cannot use.
 *
 * One row per account: who it is, which config dir it lives in, how much of each window it has
 * spent, and — the one thing no other surface says — WHEN a walled one comes back.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { windowElapsed } from "./pace.mjs";

const HOME = homedir();

/**
 * Every authenticated Claude config dir on the box, as {dir, email, uuid, isDefault}.
 *
 * Discovery is by WHO IS SIGNED IN, not by directory naming — the same lesson configDirFor
 * learned the hard way: this laptop has ~/.claude, ~/.claude-gmail and ~/.claude-reif_personal,
 * and a ~/.claude-<handle> rule guesses wrong for most of them. A dir counts only if it carries
 * a readable .claude.json with an oauthAccount, which is exactly what "logged in" means.
 */
export function loginDirs(home = HOME) {
  const out = [];
  const add = (dir, isDefault) => {
    try {
      const j = JSON.parse(readFileSync(path.join(dir, ".claude.json"), "utf8"));
      const oa = j.oauthAccount;
      if (!oa?.accountUuid) return;
      out.push({ dir, isDefault, email: oa.emailAddress || null, uuid: oa.accountUuid });
    } catch { /* not an authenticated config dir */ }
  };
  add(path.join(home, ".claude"), true);
  try {
    for (const e of readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith(".claude-")) continue;
      add(path.join(home, e.name), false);
    }
  } catch {}
  return out;
}

/**
 * maxx writes one status/rl file per login, suffixed from the config dir (render.mjs's SUF rule).
 * The DEFAULT login's files are unsuffixed. Returns the suffix for a given dir so a reading is
 * always matched to the account it belongs to — the wrong file would report another login's walls.
 */
export function sufFor(dir, home = HOME) {
  const base = path.basename(dir);
  return base === ".claude" ? "" : "-" + base.replace(/^\.claude-?/, "");
}

/** How long until a reset, as a short human string. Null when there is nothing to count down. */
export function untilText(resetSec, nowSec) {
  if (!resetSec || resetSec <= nowSec) return null;
  const m = Math.round((resetSec - nowSec) / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}

/**
 * Read one login's local view: the rl.json cache the statusline keeps per account.
 *
 * LOCAL on purpose. The server probe (`setup.probeAccount`) needs a handle, a secret and a
 * round-trip per account, and it reports the ACCOUNT's usage rather than what this box last saw.
 * `accounts` has to answer instantly and work offline, so it reads the same cache the bar reads.
 * A login maxx has never rendered simply has no reading, and says so rather than guessing zero.
 */
export function readLogin(dir, home = HOME, nowSec = Date.now() / 1000, uuid = null) {
  const suf = sufFor(dir, home);
  const mx = path.join(home, ".maxx");
  const read = (f) => { try { return JSON.parse(readFileSync(path.join(mx, f), "utf8")); } catch { return null; } };

  let rl = read(`rl${suf}.json`);
  // The file may be missing, empty, or written under a mangled suffix — a writer that built
  // "-" + "" once produced rl-.json holding the DEFAULT login's readings while rl.json sat at
  // 0 bytes, so this surface reported "no reading yet" for an account that was 67% through its
  // week. Every rl file stamps the account it belongs to, so trust that stamp over the filename:
  // scan for one claiming this uuid before concluding a tank is unknown.
  if ((!rl || rl.week == null) && uuid) {
    try {
      for (const f of readdirSync(mx)) {
        if (!/^rl.*\.json$/.test(f)) continue;
        const c = read(f);
        if (c?.account === uuid && c.week != null) { rl = c; break; }
      }
    } catch {}
  }
  if (!rl || (rl.quota == null && rl.week == null)) return { suf, reading: false };
  // A reading survives only until its own window rolls over. Past that the percentages describe
  // a week that has already reset, so they are not a small error -- they are a number for a
  // different week, and printing one as current is worse than printing none.
  const expired = rl.weekResetAt ? rl.weekResetAt <= nowSec : false;
  if (expired) return { suf, reading: false, stale: true, staleSince: rl.weekResetAt, ts: rl.ts || 0 };
  const five = typeof rl.quota === "number" ? rl.quota : null;
  const week = typeof rl.week === "number" ? rl.week : null;
  // A wall is Anthropic's own 5h reading at the top of its range — the same 90% the bar calls red.
  const walled = five != null && five >= 0.9;
  return {
    suf, reading: true,
    fivePct: five == null ? null : Math.round(five * 100),
    weekPct: week == null ? null : Math.round(week * 100),
    walled,
    freeIn: walled ? untilText(rl.fiveResetAt, nowSec) : null,
    weekIn: untilText(rl.weekResetAt, nowSec),
    // Same reset, as a weekday and clock time — "Sun 8pm" needs no arithmetic to act on.
    weekWhen: resetWhen(rl.weekResetAt, nowSec),
    weekResetAt: rl.weekResetAt || null,
    ts: rl.ts || 0,
  };
}

/** The handle maxx ships this account's burn under, when it knows one. Cosmetic; never required. */
export function handleFor(uuid, home = HOME) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(home, ".maxx", "config.json"), "utf8"));
    const a = (cfg.accounts || {})[uuid];
    if (a?.handle) return a.handle;
    return cfg.handle || null;
  } catch { return null; }
}

/**
 * Build the rows. `liveUuid` is the account this very session is signed into — the one fact a
 * human cannot get from the list itself, and the thing that makes "which one am I on" answerable.
 */
export function buildRows(home = HOME, nowSec = Date.now() / 1000, liveUuid = null) {
  return loginDirs(home).map((L) => ({
    ...L,
    handle: handleFor(L.uuid, home),
    live: !!liveUuid && L.uuid === liveUuid,
    ...readLogin(L.dir, home, nowSec, L.uuid),
  }));
}

/** A reset countdown as a day and time, not an hour count to convert in your head. */
export function resetWhen(resetSec, nowSec) {
  if (!resetSec || resetSec <= nowSec) return null;
  const d = new Date(resetSec * 1000);
  const now = new Date(nowSec * 1000);
  const days = Math.floor((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const hh = d.getHours();
  const clock = `${((hh + 11) % 12) + 1}${d.getMinutes() ? ":" + String(d.getMinutes()).padStart(2, "0") : ""}${hh < 12 ? "am" : "pm"}`;
  if (days <= 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days < 7) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${clock}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Pace: budget spent against time spent, in the same week.
 *
 * "21% of budget left" is unreadable alone -- it is healthy with a day to go and a fire on Monday
 * morning. What decides it is the ratio of the two clocks. 1.0x is exactly on pace; above it you
 * are spending faster than the week is passing and will run dry early; below it you have room.
 */
export function paceOf(r, nowSec = Date.now() / 1000, weekSec = 7 * 86400) {
  if (!r.reading || r.weekPct == null || !r.weekResetAt) return null;
  // windowElapsed, not a bare (now - reset + week) / week: it anchors to the account's birth as
  // well, so a login three days old is measured against the three days it has existed rather
  // than a full week it was never around for -- which would read as wildly under pace.
  const elapsed = windowElapsed(r.weekResetAt, weekSec, r.bornSec || 0, nowSec);
  if (!(elapsed > 0.02)) return null;           // too early for the ratio to mean anything
  const ratio = (r.weekPct / 100) / elapsed;
  return { elapsedPct: Math.round(elapsed * 100), ratio };
}

/** The pace verdict in the fewest words that still tell you what to do. */
export function paceText(p) {
  if (!p) return null;
  const { ratio } = p;
  if (ratio >= 1.15) return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}x OVER pace`;
  if (ratio <= 0.85) return `${(1 / ratio) >= 10 ? Math.round(1 / ratio) : (1 / ratio).toFixed(1)}x under — room to spend`;
  return "on pace";
}

/** How long ago a stale reading stopped being true, in the coarsest unit that is still honest. */
export function staleAge(r, nowSec = Date.now() / 1000) {
  const since = r.staleSince || (r.ts ? r.ts / 1000 : null);
  if (!since) return "some time ago";
  const days = Math.floor((nowSec - since) / 86400);
  if (days >= 1) return `${days}d ago`;
  const h = Math.max(1, Math.floor((nowSec - since) / 3600));
  return `${h}h ago`;
}

/**
 * Render. One line per account, and the answer first.
 *
 * This used to print percent-USED in both windows to match every other maxx surface. That
 * consistency cost more than it bought: the question people bring to `accounts` is "which login
 * do I use", and percent-used answers its opposite — you read 5%, then flip it to 95% left, for
 * every row, before you can compare them. Three accounts x two windows = six inversions to find
 * one word. So this surface prints what is LEFT, sorts by it, and names the pick on the first
 * line. The week window is the one that decides; the 5h is a short-term brake and rides along
 * only when it is actually biting.
 */
export function renderAccounts(rows, nowSec = Date.now() / 1000) {
  if (!rows.length) return "  no Claude logins found on this box.";

  const leftOf = (r) => (r.reading && r.weekPct != null ? 100 - r.weekPct : null);
  const usable = rows.filter((r) => r.reading && !r.walled && leftOf(r) != null);
  // Rank by pace where it is known, because raw budget lies across different points in the week:
  // 40% left on Monday is worse than 25% left on Saturday. Lower ratio = more room for the time
  // that remains. Accounts with no pace reading fall back to raw budget. Ties go to the live
  // login, since switching is not free.
  const rank = (r) => { const p = paceOf(r, nowSec); return p ? p.ratio : 1 - leftOf(r) / 100; };
  const pick = usable.sort((a, b) => (rank(a) - rank(b)) || (b.live - a.live))[0];

  const out = [];
  if (pick) {
    const who = pick.handle ? `@${pick.handle}` : (pick.email || pick.dir.replace(HOME, "~"));
    out.push(`  USE → ${who}${pick.live ? "   (already live)" : `   eval "$(maxx switch)"`}`);
    out.push("");
  }

  // Widest handle sets the column so the numbers line up and can be compared by eye alone.
  const nameOf = (r) => (r.handle ? `@${r.handle}` : (r.email || r.dir.replace(HOME, "~")));
  const w = Math.max(...rows.map((r) => nameOf(r).length));

  const rowRank = (r) => { if (!r.reading) return Infinity; const p = paceOf(r, nowSec); return p ? p.ratio : 1 - (leftOf(r) ?? 0) / 100; };
  for (const r of [...rows].sort((a, b) => rowRank(a) - rowRank(b))) {
    const name = nameOf(r).padEnd(w);
    if (!r.reading) {
      out.push(r.stale
        ? `  ${name}   tank unknown — last reading expired ${staleAge(r)}; open Claude Code on it to refresh`
        : `  ${name}   not set up yet — open Claude Code on this login once`);
      continue;
    }
    if (r.walled) {
      out.push(`  ${name}   FULL${r.freeIn ? ` — free again in ${r.freeIn}` : ""}`);
      continue;
    }
    const left = leftOf(r);
    const bits = [`${left == null ? "—" : left + "% left"}`];
    // Budget alone cannot be judged: the same number is healthy late in the week and alarming
    // early. Pace carries the time axis, so it goes beside the budget, not in a separate surface.
    const pt = paceText(paceOf(r, nowSec));
    if (pt) bits.push(pt);
    // The 5h window only matters when it is the thing about to stop you.
    if (r.fivePct != null && r.fivePct >= 70) bits.push(`5h nearly full (${100 - r.fivePct}% left)`);
    if (r.live) bits.push("live now");
    out.push(`  ${name}   ${bits.join("  ·  ")}`);
  }

  // One footer, only when it changes what you would do.
  const resets = rows.filter((r) => r.reading && r.weekWhen);
  if (pick && resets.length) {
    const p = resets.find((r) => r.uuid === pick.uuid);
    if (p) { out.push(""); out.push(`  ${pick.handle ? "@" + pick.handle : "that login"}'s week resets ${p.weekWhen}.`); }
  }
  return out.join("\n");
}

/**
 * Resolve a session tag back to a session.
 *
 * The statusline prints 8 chars of the session uuid so you can name THIS chat to another one
 * ("the fix is in f6a931d9"). That is a prefix, and a prefix nothing can look up is a label, not
 * an identifier — the peer holding it has no way to ask which repo it was, which login it ran
 * under, or whether it is still going.
 *
 * Every login's status.json carries a `chats` map keyed by full session id, and every session's
 * transcript is <id>.jsonl under that login's projects tree. Both are searched by prefix, so the
 * 8 chars on the bar are enough.
 */
export function resolveSession(prefix, home = HOME, nowMs = Date.now()) {
  const want = String(prefix || "").trim().toLowerCase();
  if (want.length < 4) return { error: "give at least 4 characters of the id" };
  const hits = [];
  for (const L of loginDirs(home)) {
    const suf = sufFor(L.dir, home);
    // the chat's own scoring, from the statusline that rendered it
    let chats = {};
    try { chats = JSON.parse(readFileSync(path.join(home, ".maxx", `status${suf}.json`), "utf8")).chats || {}; } catch {}
    for (const [sid, row] of Object.entries(chats)) {
      if (!sid.toLowerCase().startsWith(want)) continue;
      hits.push({ sid, login: L, handle: handleFor(L.uuid, home), row, where: null });
    }
  }
  // locate each hit's project directory from its transcript path — that is what says WHICH REPO,
  // the fact a peer actually wants and the one thing the chats map does not carry.
  for (const h of hits) {
    const projRoot = path.join(h.login.dir, "projects");
    try {
      for (const d of readdirSync(projRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const f = path.join(projRoot, d.name, `${h.sid}.jsonl`);
        if (existsSync(f)) { h.where = d.name.replace(/^-/, "/").replace(/-/g, "/"); h.file = f; break; }
      }
    } catch {}
  }
  if (!hits.length) return { error: `no session starting with "${want}" on this box` };
  return { hits };
}

export function renderWho(res, nowMs = Date.now()) {
  if (res.error) return `  ${res.error}`;
  const out = [];
  for (const h of res.hits) {
    const age = h.row?.ts ? Math.round((nowMs - h.row.ts) / 60000) : null;
    // "live" is a judgement about a statusline reading, so it is stated as what it is: how long
    // since that chat last rendered. A chat renders about once a second while it is being used.
    const seen = age == null ? "never rendered" : age < 2 ? "LIVE (rendering now)" : age < 90 ? `last seen ${age}m ago` : `last seen ${Math.round(age / 60)}h ago`;
    out.push(`  ${h.sid.slice(0, 8)}  ${seen}`);
    if (h.where) out.push(`     ${h.where}`);
    out.push(`     ${h.handle ? "@" + h.handle : h.login.dir.replace(HOME, "~")}${h.row?.pct != null ? `  ·  chat ${h.row.pct}%` : ""}`);
    out.push(`     full id: ${h.sid}`);
  }
  return out.join("\n");
}
