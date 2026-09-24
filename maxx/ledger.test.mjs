// Shared transcripts: every login's projects/ is a symlink to ONE folder, so each scanner sees
// every account's files. Burn must be attributed by the session-accounts ledger, per turn, and
// each turn counted once — never once per login. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountAt, loadLedger, backfill, sessionOfFile } from "./ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = "aaaa1111-0000-0000-0000-000000000001";
const B = "bbbb2222-0000-0000-0000-000000000002";
const C = "cccc3333-0000-0000-0000-000000000003";
const EXPECT = { [A]: 110, [B]: 1200, [C]: 5000 };

// Three logins (~/.claude = A, ~/.claude-b = B, ~/.claude-c = C) sharing ~/.claude-shared/projects.
// s3 was started on A and resumed on B: its first turn is A's, its second is B's.
function makeHome({ ledger = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-ledger-"));
  const now = Date.now();
  const at = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
  const row = (sid, id, ts, n) => JSON.stringify({
    sessionId: sid, timestamp: ts, requestId: id,
    message: { model: "claude-sonnet-5", usage: { input_tokens: n, output_tokens: 0 } },
  }) + "\n";
  const shared = path.join(home, ".claude-shared", "projects");
  const put = (proj, sid, rows) => { mkdirSync(path.join(shared, proj), { recursive: true }); writeFileSync(path.join(shared, proj, `${sid}.jsonl`), rows.join("")); };
  put("-proja", "s1", [row("s1", "r1", at(60), 100)]);
  put("-projb", "s2", [row("s2", "r2", at(50), 200)]);
  put("-projc", "s3", [row("s3", "r3", at(40), 10), row("s3", "r4", at(10), 1000)]);
  put("-projd", "s4", [row("s4", "r5", at(30), 5000)]);
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: A, emailAddress: "a@x.com" } }));
  for (const [d, u] of [[".claude", null], [".claude-b", B], [".claude-c", C]]) {
    mkdirSync(path.join(home, d), { recursive: true });
    if (u) writeFileSync(path.join(home, d, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: u, emailAddress: `${d}@x.com` } }));
    symlinkSync(shared, path.join(home, d, "projects"));
  }
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  writeFileSync(path.join(home, ".maxx", "accounts.json"), JSON.stringify({
    accounts: [A, B, C].map((uuid) => ({ uuid, from: 0 })),
    dirs: { [path.join(home, ".claude")]: A, [path.join(home, ".claude-b")]: B, [path.join(home, ".claude-c")]: C },
  }));
  writeFileSync(path.join(home, ".maxx", "config.json"), JSON.stringify({
    handle: "ha", secret: "sa", logsUrl: "https://example.invalid",
    accounts: { [A]: { handle: "ha", secret: "sa" }, [B]: { handle: "hb", secret: "sb" }, [C]: { handle: "hc", secret: "sc" } },
  }));
  if (ledger) {
    const resume = now - 15 * 60000;
    writeFileSync(path.join(home, ".maxx", "session-accounts.jsonl"), [
      { sessionId: "s1", account: A, ts: 0 }, { sessionId: "s2", account: B, ts: 0 },
      { sessionId: "s3", account: A, ts: 0 }, { sessionId: "s3", account: B, ts: resume },
      { sessionId: "s4", account: C, ts: 0 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  return home;
}

const envFor = (home, uuid) => {
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.MAXX_LEDGER;
  if (uuid === B) env.CLAUDE_CONFIG_DIR = path.join(home, ".claude-b");
  if (uuid === C) env.CLAUDE_CONFIG_DIR = path.join(home, ".claude-c");
  return env;
};
const run = (file, args, home, uuid) =>
  execFileSync("node", [path.join(HERE, file), ...args], { env: envFor(home, uuid), encoding: "utf8" });

test("ledger: a resumed session's turns split at the resume", () => {
  const led = loadLedger(path.join(makeHome(), ".maxx", "session-accounts.jsonl"));
  assert.equal(accountAt(led, "s3", Date.now() - 40 * 60000), A);
  assert.equal(accountAt(led, "s3", Date.now()), B);
  assert.equal(accountAt(led, "nope", Date.now()), null);
  assert.equal(sessionOfFile("/p/-x/s9/subagents/agent-1.jsonl"), "s9");
});

test("ledger: backfill tags every session in a login's projects dir, once", () => {
  const home = makeHome({ ledger: false });
  const file = path.join(home, ".maxx", "session-accounts.jsonl");
  const prev = process.env.HOME;
  process.env.HOME = home; // accountOf() resolves ~/.claude against HOME
  try {
    assert.equal(backfill(path.join(home, ".claude-b"), file).added, 4);
    assert.equal(backfill(path.join(home, ".claude-c"), file).added, 0, "already-tagged sessions are skipped");
  } finally { process.env.HOME = prev; }
  assert.equal(loadLedger(file).get("s1")[0].account, B);
});

test("tracker: each login counts only its own turns from the shared folder", () => {
  const home = makeHome();
  for (const uuid of [A, B, C]) {
    const j = JSON.parse(run("tracker.mjs", ["--json"], home, uuid));
    assert.equal(j.totals.tokens, EXPECT[uuid], `account ${uuid.slice(0, 4)}`);
  }
});

test("limit: the weekly window sums only this login's turns", () => {
  const home = makeHome();
  for (const uuid of [A, B, C]) {
    const j = JSON.parse(run("limit.mjs", ["--json"], home, uuid));
    assert.equal(Math.round(j.weekUsed), EXPECT[uuid], `account ${uuid.slice(0, 4)}`);
  }
});

test("emit: three roots over one folder ship each turn once, to its owner", () => {
  const home = makeHome();
  const out = run("emit.mjs", ["--json"], home, A);
  const envs = JSON.parse(out.slice(out.indexOf("[")));
  const billed = Object.fromEntries(envs.map((e) => [e.account, e.totals.billed]));
  assert.deepEqual(billed, EXPECT);
});

test("shared folder with no ledger: an untagged session is not counted once per login", () => {
  const home = makeHome({ ledger: false });
  const total = [A, B, C].reduce((s, u) => s + JSON.parse(run("tracker.mjs", ["--json"], home, u)).totals.tokens, 0);
  assert.ok(total <= 6310, `counted ${total} tokens from 6310 on disk`);
});
