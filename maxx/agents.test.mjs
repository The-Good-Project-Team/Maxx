// maxx agents — the board reads EVERY Claude login root on the box (~/.claude + ~/.claude-*),
// because burn follows the login and one root is not the week. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS = path.join(HERE, "agents.mjs");

function row(tokens) {
  return JSON.stringify({
    timestamp: new Date().toISOString(), requestId: "r" + tokens, customTitle: "t" + tokens,
    message: { model: "claude-sonnet-5", usage: { input_tokens: tokens, output_tokens: 0 } },
  }) + "\n";
}
// ~/.claude holds 100 tokens, ~/.claude-gmail holds 900.
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-agents-"));
  mkdirSync(path.join(home, ".claude", "projects", "-proja"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "projects", "-proja", "s1.jsonl"), row(100));
  mkdirSync(path.join(home, ".claude-gmail", "projects", "-projb"), { recursive: true });
  writeFileSync(path.join(home, ".claude-gmail", "projects", "-projb", "s2.jsonl"), row(900));
  return home;
}
const run = (home, ...extra) => JSON.parse(execFileSync("node", [AGENTS, "--json", ...extra],
  { env: { ...process.env, HOME: home }, encoding: "utf8" }).replace(/^MAXX_AGENTS.*\n/, ""));

test("agents: the board sums every login root, and names the account per row", () => {
  const out = run(makeHome());
  assert.equal(out.totalBilled, 1000, "one root read as the whole box");
  assert.deepEqual(out.local.map((r) => r.account).sort(), ["gmail", "main"]);
});

test("agents: --dir narrows to one projects dir", () => {
  const out = run(makeHome(), "--dir", path.join(makeHome(), ".claude", "projects"));
  assert.equal(out.totalBilled, 100);
});

// Streaming writes one line per content block, all carrying the same requestId + usage.
test("agents: a request logged twice is billed once", () => {
  const home = makeHome();
  writeFileSync(path.join(home, ".claude", "projects", "-proja", "s1.jsonl"), row(100) + row(100));
  assert.equal(run(home).totalBilled, 1000, "the duplicate line was billed twice");
});
