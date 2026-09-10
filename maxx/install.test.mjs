// The installer is the only code every customer runs, on a machine we have never seen, and it
// edits ~/.claude/settings.json — the file their whole Claude Code setup lives in. These cover
// the two ways that goes wrong for someone who is not the author: their settings get eaten, or
// everything wires up to a `node` their hooks cannot actually find.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.join(HERE, "install.sh");

function run(home, { expectFail = false } = {}) {
  try {
    const out = execFileSync("bash", [INSTALL], {
      env: { ...process.env, HOME: home, MAXX_HANDLE: "", MAXX_SECRET: "" },
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ok(!expectFail, "installer was expected to refuse, but it succeeded");
    return { code: 0, out };
  } catch (e) {
    assert.ok(expectFail, `installer failed unexpectedly: ${e.stderr || e.message}`);
    return { code: e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

const settingsPath = (home) => path.join(home, ".claude", "settings.json");
const freshHome = () => mkdtempSync(path.join(tmpdir(), "maxx-install-"));

test("install wires every hook to an ABSOLUTE node — hooks run without the user's login PATH", () => {
  const home = freshHome();
  run(home);
  const s = JSON.parse(readFileSync(settingsPath(home), "utf8"));
  const cmds = [
    s.statusLine.command,
    ...s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command)),
    ...(s.hooks.SessionStart || []).flatMap((e) => e.hooks.map((h) => h.command)),
  ];
  for (const c of cmds) {
    assert.doesNotMatch(c, /^node\s/, `"${c}" relies on PATH — under nvm/fnm a hook shell has no node`);
    assert.match(c, /^\//, `"${c}" must start with an absolute interpreter path`);
    assert.ok(existsSync(c.split(" ")[0]), `interpreter ${c.split(" ")[0]} does not exist`);
  }
});

test("a settings.json we cannot parse is left ALONE, with a message that says where the backup is", () => {
  const home = freshHome();
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  // the shape a real user arrives with: a trailing comma, or an editor's comments
  const original = '{\n  "model": "opus",\n  // my notes\n  "theme": "dark",\n}\n';
  writeFileSync(settingsPath(home), original);

  const { code, out } = run(home, { expectFail: true });
  assert.equal(code, 2, "must exit non-zero so a scripted install stops here");
  assert.equal(readFileSync(settingsPath(home), "utf8"), original, "the user's settings were modified");
  assert.match(out, /not valid JSON/);
  assert.match(out, /bak-maxx/, "must point at the backup — silence is how the old version lost configs");
});

test("existing settings and other tools' hooks survive the install", () => {
  const home = freshHome();
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(home), JSON.stringify({
    model: "opus",
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/true" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "/opt/other/tool --wake" }] }],
    },
  }, null, 2));

  run(home);
  const s = JSON.parse(readFileSync(settingsPath(home), "utf8"));
  assert.equal(s.model, "opus", "unrelated top-level settings must be preserved");
  assert.deepEqual(s.permissions, { allow: ["Bash(ls:*)"] });
  const pre = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  const start = (s.hooks.SessionStart || []).flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(pre.includes("/usr/bin/true"), "another tool's PreToolUse hook was dropped");
  assert.ok(start.includes("/opt/other/tool --wake"), "another tool's SessionStart hook was dropped");
  assert.ok(pre.some((c) => c.includes("gate.mjs")), "maxx's own gate hook is missing");
});

test("re-running the installer does not stack duplicate maxx hooks", () => {
  const home = freshHome();
  run(home);
  run(home);
  const s = JSON.parse(readFileSync(settingsPath(home), "utf8"));
  const count = (needle) =>
    [...s.hooks.PreToolUse, ...(s.hooks.SessionStart || [])]
      .flatMap((e) => e.hooks.map((h) => h.command))
      .filter((c) => c.includes(needle)).length;
  assert.equal(count("gate.mjs"), 1, "upgrading must replace maxx's hook, not append another");
  assert.equal(count("fenix.mjs"), 0, "fenix moved to its own repo — maxx installs no fenix hook");
});

// Upgrading FROM a maxx that shipped fenix: the old SessionStart hook points at
// $SKILLDIR/fenix.mjs, a file this version no longer installs. Left in place it fails on
// every session start, so the installer strips its own stale hook — and only its own.
test("upgrading strips the fenix hook a previous maxx left behind", () => {
  const home = freshHome();
  const p = settingsPath(home);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `node ${home}/.claude/skills/maxx/fenix.mjs --wake` }] },
        { hooks: [{ type: "command", command: "/opt/other/tool --wake" }] },
      ],
    },
  }));
  run(home);
  const s = JSON.parse(readFileSync(p, "utf8"));
  const start = (s.hooks.SessionStart || []).flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(!start.some((c) => c.includes("fenix.mjs")), "stale maxx fenix hook must be removed");
  assert.ok(start.includes("/opt/other/tool --wake"), "another tool's SessionStart hook must survive");
});
