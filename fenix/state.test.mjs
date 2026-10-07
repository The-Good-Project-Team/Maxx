// state — tests. The context is a cache, .fenix/state.md is the truth.
// Covers: transcript → text extraction (tool noise + injected plumbing dropped), the cursor
// (no turn counted twice), the debounce, the recursion guard, a successful distill through a
// fake `claude`, a failed distill leaving state untouched, and wake output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extractTurns, ingest, distillNow, brief, cleanState } from "./state.mjs";

const SELF = path.join(path.dirname(new URL(import.meta.url).pathname), "state.mjs");
const line = (o) => JSON.stringify(o) + "\n";
const user = (content, extra = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const asst = (content, extra = {}) => line({ type: "assistant", message: { role: "assistant", content }, ...extra });

const sampleJsonl = () =>
  user("fix the login bug") +
  asst([{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]) +
  asst([{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/auth.js", old_string: "a", new_string: "b" } }]) +
  user([{ type: "tool_result", tool_use_id: "t1", content: "a.js\nb.js" }]) +
  asst([{ type: "text", text: "Found it in auth.js. Patching." }]) +
  user("<system-reminder>injected</system-reminder>ship it") +
  user([{ type: "text", text: "<command-name>/clear</command-name><local-command-stdout>ok</local-command-stdout>" }]) +
  asst([{ type: "text", text: "sidechain noise" }], { isSidechain: true }) +
  line({ type: "attachment", attachment: {} }) +
  "garbage not json\n";

test("extractTurns keeps prose + edited paths, drops tool calls/results, thinking, sidechains, injected plumbing", () => {
  const t = extractTurns(sampleJsonl());
  assert.equal(t, "USER: fix the login bug\n\nASSISTANT: Found it in auth.js. Patching.\n\nUSER: ship it\n\nTOUCHED: src/auth.js");
});

test("cleanState keeps the document from '# State' on and strips fences and agent preamble", () => {
  assert.equal(cleanState("Let me look at the filesystem.\n\n# State\n## Next\n- x\n"), "# State\n## Next\n- x");
  assert.equal(cleanState("```markdown\n# State\n- y\n```\n"), "# State\n- y");
  assert.equal(cleanState("I cannot help with that."), "", "no document → failed, state untouched");
});

test("ingest advances the cursor so a turn is never counted twice, and only whole lines count", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-"));
  const tp = path.join(cwd, "s.jsonl");
  writeFileSync(tp, user("one") + asst([{ type: "text", text: "two" }]));
  assert.equal(ingest(cwd, "sid", tp), "USER: one\n\nASSISTANT: two".length);
  assert.equal(ingest(cwd, "sid", tp), "USER: one\n\nASSISTANT: two".length, "second ingest adds nothing");
  appendFileSync(tp, user("three").slice(0, -1));                       // half-written line, no newline yet
  assert.equal(ingest(cwd, "sid", tp), "USER: one\n\nASSISTANT: two".length, "partial line waits");
  appendFileSync(tp, "\n");
  assert.equal(readFileSync(path.join(cwd, ".fenix", "state.pending.md"), "utf8").endsWith("USER: three"), false);
  ingest(cwd, "sid", tp);
  assert.ok(readFileSync(path.join(cwd, ".fenix", "state.pending.md"), "utf8").endsWith("USER: three"));
});

// a fake `claude` that answers with a canned STATE, or fails, by env
function fakeClaude(dir, mode) {
  const p = path.join(dir, "claude");
  writeFileSync(p, mode === "fail"
    ? "#!/bin/sh\necho 'Not logged in · Please run /login'; exit 1\n"
    : "#!/bin/sh\n# record the prompt so the test can inspect the brief\ncat > /dev/null; printf '%s\\n' \"$@\" > " + JSON.stringify(path.join(dir, "args.txt")) + "\nprintf 'Let me check.\\n\\n# State\\n## Goal\\nfix login\\n## Next\\n- run tests\\n'\n");
  chmodSync(p, 0o755);
  return p;
}

test("distillNow rewrites state.md from pending through claude, consumes pending, stamps lastDistill", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-"));
  const tp = path.join(cwd, "s.jsonl");
  writeFileSync(tp, sampleJsonl());
  ingest(cwd, "sid", tp);
  process.env.MAXX_STATE_CLAUDE = fakeClaude(cwd, "ok");
  assert.equal(distillNow(cwd), "ok");
  const st = readFileSync(path.join(cwd, ".fenix", "state.md"), "utf8");
  assert.match(st, /^# State\n## Goal\nfix login/);
  assert.equal(readFileSync(path.join(cwd, ".fenix", "state.pending.md"), "utf8"), "", "pending consumed");
  assert.ok(JSON.parse(readFileSync(path.join(cwd, ".fenix", "state.cursor.json"), "utf8")).lastDistill > 0);
  const args = readFileSync(path.join(cwd, "args.txt"), "utf8");
  assert.match(args, /--model\nhaiku\n--tools\n\n--system-prompt\nYou are a note-taker/, "one cheap Haiku call, no tools, no agent persona");
  assert.match(args, /USER: fix the login bug/, "the brief carries the turns");
  assert.equal(distillNow(cwd), "nothing", "nothing pending → no call");
});

test("a failed distill leaves state.md untouched and keeps pending for the next try", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-"));
  const tp = path.join(cwd, "s.jsonl");
  writeFileSync(tp, sampleJsonl());
  ingest(cwd, "sid", tp);
  writeFileSync(path.join(cwd, ".fenix", "state.md"), "# State\nold truth\n");
  process.env.MAXX_STATE_CLAUDE = fakeClaude(cwd, "fail");
  assert.equal(distillNow(cwd), "failed");
  assert.equal(readFileSync(path.join(cwd, ".fenix", "state.md"), "utf8"), "# State\nold truth\n");
  assert.ok(readFileSync(path.join(cwd, ".fenix", "state.pending.md"), "utf8").length > 0);
});

test("brief carries old state and new turns, asks for markdown only", () => {
  const b = brief("# State\nold", "USER: hi");
  assert.match(b, /=== CURRENT STATE.md ===\n# State\nold/);
  assert.match(b, /=== NEW TURNS ===\nUSER: hi/);
  assert.match(b, /Output ONLY the new STATE.md/);
});

const runHook = (cmd, stdin, env = {}) =>
  spawnSync(process.execPath, [SELF, cmd], { input: JSON.stringify(stdin), encoding: "utf8", env: { ...process.env, ...env } });

test("stop hook: ingests, never blocks (exit 0, silent), debounces below the distill line", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-"));
  const tp = path.join(cwd, "s.jsonl");
  writeFileSync(tp, user("small") + asst([{ type: "text", text: "turn" }]));
  const r = runHook("stop", { cwd, session_id: "sid", transcript_path: tp }, { MAXX_STATE_DISTILL_AT: "100000", MAXX_STATE_DISTILL_MIN: "9999" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(existsSync(path.join(cwd, ".fenix", "state.pending.md")));
  assert.ok(!existsSync(path.join(cwd, ".fenix", "state.md")), "below the line: no distill");
});

test("flush hook: distills synchronously (PreCompact / SessionEnd)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-"));
  const tp = path.join(cwd, "s.jsonl");
  writeFileSync(tp, sampleJsonl());
  const r = runHook("flush", { cwd, session_id: "sid", transcript_path: tp }, { MAXX_STATE_CLAUDE: fakeClaude(cwd, "ok") });
  assert.equal(r.status, 0);
  assert.match(readFileSync(path.join(cwd, ".fenix", "state.md"), "utf8"), /fix login/);
});

test("recursion guard: inside a distill child every hook is a no-op", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-"));
  const tp = path.join(cwd, "s.jsonl");
  writeFileSync(tp, sampleJsonl());
  const r = runHook("flush", { cwd, session_id: "sid", transcript_path: tp }, { MAXX_STATE_DISTILL: "1", MAXX_STATE_CLAUDE: fakeClaude(cwd, "ok") });
  assert.equal(r.status, 0);
  assert.ok(!existsSync(path.join(cwd, ".fenix")), "nothing touched");
});

test("wake: prints state.md for startup/clear/compact, nothing on resume or when absent", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "state-"));
  assert.equal(runHook("wake", { cwd, source: "startup" }).stdout, "");
  mkdirSync(path.join(cwd, ".fenix")); writeFileSync(path.join(cwd, ".fenix", "state.md"), "# State\n## Next\n- ship\n");
  const out = runHook("wake", { cwd, source: "clear" }).stdout;
  assert.match(out, /\[state\] \.fenix\/state\.md is the running truth/);
  assert.match(out, /## Next\n- ship/);
  assert.equal(runHook("wake", { cwd, source: "resume" }).stdout, "", "resume already has the thread");
});
