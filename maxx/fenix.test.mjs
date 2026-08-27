// The handoff has to carry facts nobody had to remember, and it has to be FINDABLE from
// wherever the human is standing. Both were broken in ways that only showed up in real use:
//
//   · Of 98 real handoffs, ~35% carried the sections the skill asks for and 13% pasted any
//     command output. The rest is prose remembered at 70-90% context — the worst moment for
//     recall, about facts git already knows exactly.
//   · Every LOOKUP was cwd-scoped, so `--status` run one directory over reported
//     "pending handoff: none" while a live handoff sat on disk, and `--recover <id>` answered
//     "no handoff matching" for an id that NAMES its own repo. Measured 2026-08-27 on
//     fx-fleet-kit-20260827-0045-472fd7a4: the thread was declared lost while intact.
//
// (--rise, the self-spawning chain, was REMOVED 2026-08-27. It never worked: zero of six
// generations on this machine ever reached generation 2. Its tests went with it.)
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

test("--wake skips injection on source:\"resume\" — a resume already carries full context", async () => {
  // 2026-08-21: context-governor fires on a resume's own inherited transcript bloat before
  // any real work happens. Stacking fenix's handoff on top of that same first turn only made
  // it bigger for no benefit — a resumed session's context already HAS everything the handoff
  // would say. startup/clear/compact are genuinely fresh and must keep getting it.
  const { dir } = repo();
  mkdirSync(path.join(dir, ".fenix"), { recursive: true });
  writeFileSync(path.join(dir, ".fenix", "handoff.md"), "# Handoff\n\nIn motion: the thing.\n");

  // execFile's `input` option does not reliably reach a child that reads fd 0 directly
  // (fenix.mjs uses readFileSync(0, ...), not process.stdin) — shell out through `sh -c`
  // with a real pipe instead, the same shape proven working by hand against the live file.
  const wake = (source) => run("sh", ["-c", `echo '${JSON.stringify({ source })}' | node "${FENIX}" --wake`], { cwd: dir });

  const resumed = await wake("resume");
  assert.equal(resumed.stdout.trim(), "", "source:\"resume\" must inject nothing");

  const started = await wake("startup");
  assert.match(started.stdout, /FENIX/, "source:\"startup\" must still inject the handoff");
  assert.match(started.stdout, /In motion: the thing/, "the actual handoff body must ride along");
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

// GLOBAL LOOKUP (2026-08-27). The bug these exist for is not a crash — it is a confident
// wrong answer. `--status` and `--recover` searched only $PWD/.fenix, so from any other
// directory fenix reported a live handoff as absent. A human reading "pending: none" concludes
// the thread was LOST and goes digging through transcripts for state that is intact on disk.
//
// Both tests run the command from a directory that is NOT the one holding the handoff — the
// exact condition that failed. MAXX_FENIX_ROOTS points the scan at the tmp parent so the test
// never depends on the real box's ~/Classified.
test("--recover resolves a handoff id from a DIFFERENT directory", async () => {
  const a = repo(); // holds the handoff
  const b = repo(); // where we stand
  mkdirSync(path.join(a.dir, ".fenix"), { recursive: true });
  writeFileSync(path.join(a.dir, ".fenix", "handoff.md"), "# the thread\nbody that must come back\n");
  // Mint the id the way a real write does.
  await run("node", [FENIX, "--status", "--local"], { cwd: a.dir, env: { ...process.env, MAXX_FENIX_ROOTS: a.dir, MAXX_FENIX_ALLOW_TMP: "1" } });
  const rec = JSON.parse(readFileSync(path.join(a.dir, ".fenix", "handoff.id"), "utf8"));
  assert.ok(rec.id, "no handoff id was minted");

  const { stdout } = await run("node", [FENIX, "--recover", rec.id], {
    cwd: b.dir, // <-- standing somewhere else, which is what used to fail
    env: { ...process.env, MAXX_FENIX_ROOTS: path.dirname(a.dir), MAXX_FENIX_ALLOW_TMP: "1" },
  });
  assert.match(stdout, /body that must come back/,
    "--recover could not resolve an id from another directory — the pointer is not a pointer");
});

test("--recover takes a PARTIAL id, the way a human pastes one off a status line", async () => {
  const a = repo(), b = repo();
  mkdirSync(path.join(a.dir, ".fenix"), { recursive: true });
  writeFileSync(path.join(a.dir, ".fenix", "handoff.md"), "# partial\nthe body\n");
  const env = { ...process.env, MAXX_FENIX_ROOTS: path.dirname(a.dir), MAXX_FENIX_ALLOW_TMP: "1" };
  await run("node", [FENIX, "--status", "--local"], { cwd: a.dir, env });
  const { id } = JSON.parse(readFileSync(path.join(a.dir, ".fenix", "handoff.id"), "utf8"));
  // The trailing hash alone — the shortest thing anyone would realistically paste.
  const { stdout } = await run("node", [FENIX, "--recover", id.slice(-8)], { cwd: b.dir, env });
  assert.match(stdout, /the body/, "a partial id resolved when archived but not while pending");
});

test("--status reports handoffs pending in OTHER directories", async () => {
  const a = repo();
  const b = repo();
  mkdirSync(path.join(a.dir, ".fenix"), { recursive: true });
  writeFileSync(path.join(a.dir, ".fenix", "handoff.md"), "# elsewhere\n");
  const { stdout } = await run("node", [FENIX, "--status"], {
    cwd: b.dir,
    env: { ...process.env, MAXX_FENIX_ROOTS: path.dirname(a.dir), MAXX_FENIX_ALLOW_TMP: "1" },
  });
  assert.match(stdout, /pending handoff/,
    "--status from another directory claimed nothing was pending while a handoff sat on disk");
  assert.ok(stdout.includes(a.dir), "--status did not name the directory holding the handoff");
});

test("--status --local stays scoped to one directory", async () => {
  const a = repo();
  const b = repo();
  mkdirSync(path.join(a.dir, ".fenix"), { recursive: true });
  writeFileSync(path.join(a.dir, ".fenix", "handoff.md"), "# elsewhere\n");
  const { stdout } = await run("node", [FENIX, "--status", "--local"], {
    cwd: b.dir,
    env: { ...process.env, MAXX_FENIX_ROOTS: path.dirname(a.dir), MAXX_FENIX_ALLOW_TMP: "1" },
  });
  assert.match(stdout, /no pending handoff here/,
    "--local leaked handoffs from other directories");
});

// --rise is GONE. Nothing should reintroduce a self-spawning chain by accident: it burned
// budget for weeks and never once produced a second generation.
test("no rise chain survives in the source", () => {
  const src = readFileSync(FENIX, "utf8");
  assert.ok(!/arg === "--rise"/.test(src), "--rise came back");
  assert.ok(!/DEFAULT_RISE_FLAGS/.test(src), "the rise flag list came back");
  assert.ok(!/\bspawn\b/.test(src), "fenix spawns a child process again");
});
