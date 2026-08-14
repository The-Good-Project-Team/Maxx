// The rise chain has to be able to WORK, and the handoff has to carry facts nobody had to
// remember. Both were broken in ways that only showed up in production use:
//
//   · Every --rise this machine ever ran (6 logs, nonprofit-atlas/.fenix/) ended by asking for
//     permission or refusing to continue. `.fenix/generation` still read {"gen":1} after weeks.
//     The child spawned with NO --allowedTools, so a detached headless process hit its first
//     `git status` and stopped, forever.
//   · Of 98 real handoffs, ~35% carried the sections the skill asks for and 13% pasted any
//     command output. The rest is prose remembered at 70-90% context — the worst moment for
//     recall, about facts git already knows exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const FENIX = fileURLToPath(new URL("./fenix.mjs", import.meta.url));

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "fenix-test-"));
  const git = (...a) => run("git", ["-C", dir, ...a]);
  return { dir, git };
}

test("rise grants the tools a headless session needs to finish a unit of work", () => {
  const src = readFileSync(FENIX, "utf8");
  const flags = src.slice(src.indexOf("const DEFAULT_RISE_FLAGS"), src.indexOf("// --rise:"));
  // The exact commands the six dead rise logs were denied.
  for (const tool of ["git status", "git commit", "git push", "git checkout",
                      "gh pr create", "gh pr merge", "pytest"]) {
    assert.ok(flags.includes(tool),
      `a risen session cannot run '${tool}' — this is why the chain never reached generation 2`);
  }
});

test("rise refuses the three things the next generation could not undo", () => {
  const src = readFileSync(FENIX, "utf8");
  const flags = src.slice(src.indexOf("const DEFAULT_RISE_FLAGS"), src.indexOf("// --rise:"));
  const disallowed = flags.slice(flags.indexOf("--disallowedTools"));
  // A bad merge is revertible. A rewritten history and a popped sibling stash are not.
  for (const never of ["git push --force", "git push origin main", "git stash"]) {
    assert.ok(disallowed.includes(never), `rise lost its guardrail against: ${never}`);
  }
});

test("--state reports branch, HEAD and a dirty tree from git, not from memory", async () => {
  const { dir, git } = repo();
  await git("init", "-q");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one");
  await git("add", "-A");
  await git("commit", "-qm", "first commit");
  writeFileSync(path.join(dir, "b.txt"), "uncommitted");

  const { stdout } = await run("node", [FENIX, "--state"], { cwd: dir });
  assert.match(stdout, /first commit/, "the HEAD subject is missing");
  assert.match(stdout, /uncommitted change/, "a dirty tree was not reported");
  assert.match(stdout, /b\.txt/, "the actual uncommitted file was not named");
});

test("--state warns loudly when commits exist only on this machine", async () => {
  const { dir, git } = repo();
  const originDir = mkdtempSync(path.join(tmpdir(), "fenix-origin-"));
  await run("git", ["init", "-q", "--bare", originDir]);
  await git("init", "-q");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one");
  await git("add", "-A");
  await git("commit", "-qm", "pushed commit");
  await git("remote", "add", "origin", originDir);
  await git("push", "-q", "-u", "origin", "HEAD:main");
  writeFileSync(path.join(dir, "c.txt"), "local only");
  await git("add", "-A");
  await git("commit", "-qm", "NEVER PUSHED");

  const { stdout } = await run("node", [FENIX, "--state"], { cwd: dir });
  assert.match(stdout, /UNPUSHED/, "unpushed work was not flagged");
  assert.match(stdout, /NEVER PUSHED/, "the unpushed commit was not listed");
});

test("--state resurfaces the previous handoff's 'In motion' so a dropped thread is visible", async () => {
  const { dir, git } = repo();
  await git("init", "-q");
  await git("config", "user.email", "t@t.t");
  await git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one");
  await git("add", "-A");
  await git("commit", "-qm", "c");
  mkdirSync(path.join(dir, ".fenix"), { recursive: true });
  writeFileSync(path.join(dir, ".fenix", "handoff.consumed-2026-01-01T00-00-00-000Z.md"),
    "# handoff\n\n## In motion (do this first)\n\nFinish the scoring model, it is HALF-WRITTEN.\n\n## Just landed\n\n- nothing\n");

  const { stdout } = await run("node", [FENIX, "--state"], { cwd: dir });
  assert.match(stdout, /Finish the scoring model/,
    "the prior handoff's ask vanished — this is how a thread silently dies between generations");
  assert.match(stdout, /done \/ still in motion \/ dropped/,
    "the new handoff is not being asked to account for the prior ask");
});

test("--state degrades honestly outside a git repo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fenix-nogit-"));
  const { stdout } = await run("node", [FENIX, "--state"], { cwd: dir });
  assert.match(stdout, /not a git repository/);
});
