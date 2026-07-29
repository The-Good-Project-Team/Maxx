// The directive channel has to reach the sessions that actually run away — and those are
// rarely the ones spawning agents. A builder grinding a single file past the context wall
// calls Edit and Bash all day and never touches a gated tool, so delivery cannot be tied to
// the gated path alone. These cover that: ungated tools carry the advisory, cheaply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "gate.mjs");

// A stand-in tally that hands out one clear directive and counts who asked.
function directiveServer(directives) {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ directives }));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${srv.address().port}`,
      hits,
      close: () => srv.close(),
    }));
  });
}

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-gate-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  writeFileSync(path.join(home, ".maxx", "config.json"),
    JSON.stringify({ handle: "ha", secret: "sa" }));
  return home;
}

// Runs the hook and returns whatever it printed (empty string = silent allow). Async on
// purpose: the stand-in tally lives in THIS process, and a sync spawn would block the event
// loop so the server could never answer the request the hook is waiting on.
const run = promisify(execFile);
async function hook(home, url, { tool, session }) {
  const child = run("node", [GATE], {
    env: { ...process.env, HOME: home, MAXX_LOGS_URL: url, CLAUDE_CONFIG_DIR: "" },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify({ tool_name: tool, session_id: session }));
  return (await child).stdout.trim();
}

test("gate: a clear directive reaches a session whose only tool is an ungated one", async () => {
  const srv = await directiveServer([{ action: "clear", note: "ctx 613k" }]);
  try {
    const out = await hook(makeHome(), srv.url, { tool: "Edit", session: "s-grinder" });
    assert.ok(out, "ungated tool delivered nothing — the directive never reaches this session");
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(j.hookSpecificOutput.additionalContext, /\/clear this session/);
    assert.match(j.hookSpecificOutput.additionalContext, /ctx 613k/, "the note must survive");
    assert.equal(j.hookSpecificOutput.permissionDecision, undefined, "an ungated tool must never be denied");
  } finally { srv.close(); }
});

test("gate: an ungated tool polls at most once a minute per session", async () => {
  const srv = await directiveServer([]);
  try {
    const home = makeHome();
    for (let i = 0; i < 3; i++) await hook(home, srv.url, { tool: "Edit", session: "s-chatty" });
    assert.equal(srv.hits.length, 1, `polled ${srv.hits.length}× — a per-tool-call fetch is too hot`);
    // a DIFFERENT session must not be silenced by its neighbour's poll
    await hook(home, srv.url, { tool: "Edit", session: "s-other" });
    assert.equal(srv.hits.length, 2, "one session's poll suppressed another's");
  } finally { srv.close(); }
});

test("gate: no directive pending → ungated tool stays silent", async () => {
  const srv = await directiveServer([]);
  try {
    assert.equal(await hook(makeHome(), srv.url, { tool: "Edit", session: "s-quiet" }), "");
  } finally { srv.close(); }
});
