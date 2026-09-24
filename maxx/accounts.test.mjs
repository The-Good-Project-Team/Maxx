// `switch` probed every account, ranked them, and printed one export line — throwing away the
// answer to "what have I got". You found out you were walled by hitting the wall, and you found
// out a second login had been idle all day by not finding out. These cover the two questions a
// fleet of logins raises: what do I have, and whose chat is this tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loginDirs, sufFor, untilText, readLogin, buildRows, renderAccounts, resolveSession, renderWho, paceOf, paceText } from "./accounts.mjs";

const NOW_S = Date.now() / 1000;

// A box with two logins: the default (~/.claude) and one alternate, each signed into its own
// account — the shape this laptop actually has.
function box(opts = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-acct-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  const login = (dir, uuid, email) => {
    mkdirSync(path.join(home, dir), { recursive: true });
    writeFileSync(path.join(home, dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } }));
  };
  login(".claude", "uuid-default", "primary@example.com");
  login(".claude-alt", "uuid-alt", "alt@example.com");
  // an unauthenticated dir must never count as a login
  mkdirSync(path.join(home, ".claude-empty"), { recursive: true });
  const rl = (suf, quota, week, fiveResetAt) => writeFileSync(
    path.join(home, ".maxx", `rl${suf}.json`),
    JSON.stringify({ quota, week, fiveResetAt, weekResetAt: NOW_S + 6 * 24 * 3600, ts: Date.now() }));
  if (opts.rlDefault !== false) rl("", opts.defaultQuota ?? 0.11, opts.defaultWeek ?? 0.06, NOW_S + 3600);
  if (opts.rlAlt !== false) rl("-alt", opts.altQuota ?? 0.08, opts.altWeek ?? 0.06, NOW_S + 3600);
  writeFileSync(path.join(home, ".maxx", "config.json"), JSON.stringify({
    accounts: { "uuid-default": { handle: "primary" }, "uuid-alt": { handle: "second" } },
  }));
  return home;
}

test("accounts: a login is a dir that is SIGNED IN, not one that is named right", () => {
  const home = box();
  const dirs = loginDirs(home).map((d) => path.basename(d.dir)).sort();
  assert.deepEqual(dirs, [".claude", ".claude-alt"],
    "an unauthenticated .claude-* dir is not a login");
});

// Every maxx file is suffixed from the config dir, and the DEFAULT login's files are unsuffixed.
// Getting this wrong reports one account's walls under another's name.
test("accounts: each login reads its OWN rl file, default unsuffixed", () => {
  const home = box();
  assert.equal(sufFor(path.join(home, ".claude")), "");
  assert.equal(sufFor(path.join(home, ".claude-alt")), "-alt");
  assert.equal(readLogin(path.join(home, ".claude"), home, NOW_S).fivePct, 11);
  assert.equal(readLogin(path.join(home, ".claude-alt"), home, NOW_S).fivePct, 8);
});

test("accounts: a login maxx has never rendered says so instead of reading zero", () => {
  const home = box({ rlAlt: false });
  const rows = buildRows(home, NOW_S, null);
  const alt = rows.find((r) => r.uuid === "uuid-alt");
  assert.equal(alt.reading, false, "no rl file means no reading");
  assert.match(renderAccounts(rows), /not set up yet/, "and the render must say that, not '0%'");
});

// The one fact the list cannot give you about itself.
test("accounts: the live account is marked", () => {
  const home = box();
  const out = renderAccounts(buildRows(home, NOW_S, "uuid-alt"));
  const live = out.split("\n").find((l) => l.includes("live now"));
  assert.ok(live && live.includes("@second"), `the signed-in account carries the mark: ${out}`);
});

// The whole point of seeing them side by side: one is idle while the other is walled.
test("accounts: a walled login next to a free one names the move", () => {
  const home = box({ defaultQuota: 0.95, altQuota: 0.08 });
  const out = renderAccounts(buildRows(home, NOW_S, "uuid-default"));
  assert.match(out, /FULL/, "a 95% 5h reading is the wall");
  assert.match(out, /free again in \d+/, "and a wall must say when it lifts");
  assert.match(out, /maxx switch/, "with a free account in hand, name the move");
  assert.match(out, /@second/, "and name which one");
});

// The complaint that prompted this: "why do I need a phd to read this". The list answers
// "which login do I use", so it must lead with the answer and print room LEFT, never used.
test("accounts: leads with the pick and prints room left, not used", () => {
  const home = box({ defaultQuota: 0.01, altQuota: 0.01, defaultWeek: 0.54, altWeek: 0.05 });
  const out = renderAccounts(buildRows(home, NOW_S, "uuid-default"));
  const first = out.split("\n")[0];
  assert.match(first, /USE →/, `the first line names the pick: ${out}`);
  assert.match(first, /@second/, "and it is the account with the most week left (95% vs 46%)");
  assert.match(out, /95% left/, "prints what is LEFT");
  assert.match(out, /46% left/, "for every account");
  assert.ok(!/week 5%/.test(out), `never percent-USED, which reads as its own opposite: ${out}`);
  assert.ok(!/\d+h\d+m/.test(out), `no raw hour counts to convert: ${out}`);
});

// A 5h window that is nearly full is the only time it changes the answer.
test("accounts: the 5h window shows only when it is about to bite", () => {
  const quiet = renderAccounts(buildRows(box({ defaultQuota: 0.1, altQuota: 0.1 }), NOW_S, null));
  assert.ok(!/5h/.test(quiet), `a quiet 5h window is noise: ${quiet}`);
  const tight = renderAccounts(buildRows(box({ defaultQuota: 0.8, altQuota: 0.1 }), NOW_S, null));
  assert.match(tight, /5h nearly full \(20% left\)/, "a tight one is the brake, so it is named");
});

// A real bug on this box: a writer built "-" + "" and dropped the DEFAULT login's readings into
// rl-.json while rl.json sat at 0 bytes. The tank was known; only the filename was wrong.
test("accounts: a reading under a mangled filename is still found, by account stamp", () => {
  const home = box();
  writeFileSync(path.join(home, ".maxx", "rl.json"), "");            // empty, as seen
  writeFileSync(path.join(home, ".maxx", "rl-.json"), JSON.stringify({
    quota: 0.02, week: 0.31, weekResetAt: NOW_S + 3 * 86400, ts: Date.now(),
    account: "uuid-default",
  }));
  const row = buildRows(home, NOW_S, null).find((r) => r.uuid === "uuid-default");
  assert.equal(row.reading, true, "the stamp names the account, so the tank is known");
  assert.equal(row.weekPct, 31);
  assert.match(renderAccounts(buildRows(home, NOW_S, null), NOW_S), /69% left/);
});

// The same box also held a 63-day-old reading whose week had already reset. 67%-used was not a
// stale-ish number; it described a different week entirely.
test("accounts: a reading whose window already reset is refused, not printed as current", () => {
  const home = box();
  writeFileSync(path.join(home, ".maxx", "rl.json"), JSON.stringify({
    quota: 0.02, week: 0.67, weekResetAt: NOW_S - 60 * 86400, ts: Date.now() - 63 * 86400000,
    account: "uuid-default",
  }));
  const row = buildRows(home, NOW_S, null).find((r) => r.uuid === "uuid-default");
  assert.equal(row.reading, false, "an expired window is not a reading");
  assert.equal(row.stale, true, "but it is different from never having one");
  const out = renderAccounts(buildRows(home, NOW_S, null));
  assert.match(out, /tank unknown/, `say the tank is unknown: ${out}`);
  assert.match(out, /expired 60d ago/, "and how long ago it stopped being true");
  assert.ok(!/67/.test(out), `never print the dead number: ${out}`);
});

// Budget alone cannot be judged. 21% left is healthy on the last day and a fire on Monday --
// the ratio of budget spent to time elapsed is what decides, and it is what the user asked for.
test("pace: the same budget reads opposite ways at different points in the week", () => {
  const WEEK = 7 * 86400;
  // 79% spent, 95% of the week gone: underspent, plenty of room for the time left.
  const late = { reading: true, weekPct: 79, weekResetAt: NOW_S + 0.05 * WEEK };
  const pl = paceOf(late, NOW_S);
  assert.ok(pl.ratio < 0.9, `late-week 79% is under pace, got ${pl.ratio}`);
  assert.match(paceText(pl), /under/);

  // The same 79%, but on Monday: burning 4x too fast.
  const early = { reading: true, weekPct: 79, weekResetAt: NOW_S + 0.8 * WEEK };
  const pe = paceOf(early, NOW_S);
  assert.ok(pe.ratio > 3.5 && pe.ratio < 4.5, `early-week 79% is ~4x over, got ${pe.ratio}`);
  assert.match(paceText(pe), /OVER pace/);
});

test("pace: spending in step with the clock is on pace", () => {
  const WEEK = 7 * 86400;
  const even = { reading: true, weekPct: 50, weekResetAt: NOW_S + 0.5 * WEEK };
  assert.equal(paceText(paceOf(even, NOW_S)), "on pace");
});

test("pace: no window means no verdict, never a guessed one", () => {
  assert.equal(paceOf({ reading: true, weekPct: 50, weekResetAt: null }, NOW_S), null);
  assert.equal(paceText(null), null);
});

// The pick must follow pace, not raw budget: more budget at a worse point in the week is worse.
test("accounts: the pick follows pace, not the biggest raw number", () => {
  const WEEK = 7 * 86400;
  const rows = [
    { reading: true, handle: "rich_but_early", weekPct: 60, weekResetAt: NOW_S + 0.8 * WEEK, dir: "/a", uuid: "a" },
    { reading: true, handle: "lean_but_late",  weekPct: 80, weekResetAt: NOW_S + 0.05 * WEEK, dir: "/b", uuid: "b" },
  ];
  const out = renderAccounts(rows, NOW_S);
  assert.match(out.split("\n")[0], /@lean_but_late/,
    `20% left late beats 40% left on Monday: ${out}`);
});

test("accounts: untilText counts down, and says nothing about a reset already past", () => {
  assert.equal(untilText(NOW_S + 90 * 60, NOW_S), "1h30m");
  assert.equal(untilText(NOW_S + 45 * 60, NOW_S), "45m");
  assert.equal(untilText(NOW_S - 60, NOW_S), null);
  assert.equal(untilText(0, NOW_S), null);
});

// ── who ───────────────────────────────────────────────────────────────────────────────────────
// The bar prints 8 chars of the session uuid so a chat can be named to a peer. That is a PREFIX,
// and a prefix nothing resolves is a label rather than an identifier — the peer holding it cannot
// ask which repo it was, which login it ran under, or whether it is still going.
function withChat(home, suf, sid, pct, projDir) {
  writeFileSync(path.join(home, ".maxx", `status${suf}.json`),
    JSON.stringify({ ts: Date.now(), chats: { [sid]: { ts: Date.now(), pct } } }));
  const dir = path.join(home, suf ? `.claude${suf}` : ".claude", "projects", projDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sid}.jsonl`), "{}\n");
}

test("who: the 8 chars on the bar resolve to a repo, an account and a full id", () => {
  const home = box();
  const sid = "f6a931d9-b5b0-48a9-b7a0-50e9d5aaf056";
  withChat(home, "-alt", sid, 100, "-Users-reify-Classified-Maxx");
  const res = resolveSession("f6a931d9", home);
  assert.ok(!res.error, `expected a hit: ${res.error}`);
  assert.equal(res.hits.length, 1);
  const out = renderWho(res, Date.now());
  assert.match(out, /Classified\/Maxx/, `must name the repo: ${out}`);
  assert.match(out, /@second/, "must name the login it ran under");
  assert.match(out, new RegExp(sid), "must give the full id, since 8 chars is only a handle");
});

test("who: an unknown tag says so rather than guessing", () => {
  const home = box();
  assert.match(resolveSession("deadbeef", home).error || "", /no session starting with/);
});

// 4 hex chars is 65k values and collides across a day of sessions; refusing a too-short prefix is
// better than confidently naming the wrong chat.
test("who: too short a prefix is refused", () => {
  const home = box();
  assert.match(resolveSession("f6a", home).error || "", /at least 4/);
});
