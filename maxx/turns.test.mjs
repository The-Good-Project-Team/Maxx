import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { turnCount } from "./turns.mjs";

let clock = 1_000_000;
const fresh = () => {
  const home = mkdtempSync(path.join(tmpdir(), "maxx-turns-"));
  mkdirSync(path.join(home, ".maxx"), { recursive: true });
  mkdirSync(path.join(home, "proj"), { recursive: true });
  clock += 100_000;                       // past the 10s agent-file list cache
  return { home, opts: { home, now: clock } };
};
const msg = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const inference = (rid, blocks = []) => JSON.stringify({
  type: "assistant", requestId: rid, isSidechain: false,
  message: { role: "assistant", content: blocks, usage: { input_tokens: 10, output_tokens: 5 } },
});
const toolResult = () => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
const agentInference = (rid) => JSON.stringify({
  type: "assistant", requestId: rid, isSidechain: true,
  message: { role: "assistant", content: [], usage: { input_tokens: 90, output_tokens: 4 } },
});

// A session where the human spoke twice and the model inferred four times.
function rootSession(home, sid) {
  const tp = path.join(home, "proj", sid + ".jsonl");
  writeFileSync(tp, [
    msg("do the thing"),
    inference("req-1", [{ type: "tool_use", name: "Bash" }]),
    toolResult(),
    inference("req-2", [{ type: "text", text: "done" }]),
    msg("now the other thing"),
    inference("req-3", [{ type: "tool_use", name: "Read" }]),
    toolResult(),
    inference("req-4", [{ type: "text", text: "done" }]),
  ].join("\n") + "\n");
  return tp;
}

test("counts every inference, not every message", () => {
  const { home, opts } = fresh();
  const tp = rootSession(home, "s1");
  const r = turnCount(tp, "s1", 50_000, opts);
  assert.equal(r.msgs, 2, "two human messages");
  assert.equal(r.turns, 4, "four inferences — tool results are not turns, and each call re-bills");
});

// THE POINT OF THE FEATURE: work handed to subagents is invisible in the root transcript.
test("recurses into subagent and workflow transcripts", () => {
  const { home, opts } = fresh();
  const tp = rootSession(home, "s2");
  const subs = path.join(home, "proj", "s2", "subagents");
  mkdirSync(path.join(subs, "workflows", "wf_1"), { recursive: true });
  // a depth-1 subagent: 3 inferences
  writeFileSync(path.join(subs, "agent-aaa.jsonl"),
    ["a1", "a2", "a3"].map(agentInference).join("\n") + "\n");
  // a depth-2 agent nested under a workflow: 2 more
  writeFileSync(path.join(subs, "workflows", "wf_1", "agent-bbb.jsonl"),
    ["b1", "b2"].map(agentInference).join("\n") + "\n");

  const r = turnCount(tp, "s2", 50_000, opts);
  assert.equal(r.msgs, 2, "spawned agents are not messages you sent");
  assert.equal(r.turns, 9, "4 root + 3 subagent + 2 nested workflow agent");
});

test("streaming rows of one request are one turn", () => {
  const { home, opts } = fresh();
  const tp = path.join(home, "proj", "s3.jsonl");
  writeFileSync(tp, [
    msg("go"),
    inference("req-1", [{ type: "text", text: "thinking" }]),
    inference("req-1", [{ type: "tool_use", name: "Bash" }]),   // same request, streamed
    inference("req-1", [{ type: "tool_use", name: "Grep" }]),
  ].join("\n") + "\n");
  assert.equal(turnCount(tp, "s3", 50_000, opts).turns, 1);
});

test("incremental: appended turns are counted once", () => {
  const { home, opts } = fresh();
  const tp = rootSession(home, "s4");
  assert.equal(turnCount(tp, "s4", 50_000, opts).turns, 4);
  appendFileSync(tp, inference("req-5", []) + "\n");
  const r = turnCount(tp, "s4", 50_000, opts);
  assert.equal(r.turns, 5, "one new inference, not four re-counted");
  assert.equal(r.msgs, 2);
});

test("a compact restarts the count, like the context beside it", () => {
  const { home, opts } = fresh();
  const tp = rootSession(home, "s5");
  assert.equal(turnCount(tp, "s5", 100_000, opts).turns, 4);
  const after = turnCount(tp, "s5", 20_000, opts);       // context collapsed — /compact
  assert.equal(after.turns, 0);
  assert.equal(after.msgs, 0);
});

test("state written by the old message-counting version is recounted, not inherited", () => {
  const { home, opts } = fresh();
  const tp = rootSession(home, "s6");
  // The real hazard is a MID-FILE offset: the old version counted 1 message over the first
  // half of the transcript and stored no `msgs` key at all. Resuming from there would keep
  // that 1 as if it were an inference count and increment an undefined `msgs` into NaN.
  const half = readFileSync(tp, "utf8").split("\n").slice(0, 4).join("\n").length + 1;
  writeFileSync(path.join(home, ".maxx", "turns.json"),
    JSON.stringify({ s6: { off: half, n: 1, ctx: 50_000 } }));
  const r = turnCount(tp, "s6", 50_000, opts);
  assert.equal(r.msgs, 2, "both messages, and a number — not NaN");
  assert.equal(r.turns, 4, "recounted from the top as inferences, not resumed from a message count");
});

// What the chat has COST, in the scanner's own quota-weighted tokens (weighUsage): the number the
// bar divides by the weekly cap to say "this chat is 12% of your week".
test("weighs every deduped inference, root and agents alike", () => {
  const { home, opts } = fresh();
  const tp = rootSession(home, "s7");                      // 4 × (10 + 5·5) = 140
  const subs = path.join(home, "proj", "s7", "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(path.join(subs, "agent-ccc.jsonl"),
    ["c1", "c1", "c2"].map(agentInference).join("\n") + "\n");  // streamed dup, then one more: 2 × (90 + 4·5) = 220
  assert.equal(turnCount(tp, "s7", 50_000, opts).weighted, 360);
});

test("a compact restarts turns but keeps what the chat has already cost", () => {
  const { home, opts } = fresh();
  const tp = rootSession(home, "s8");
  assert.equal(turnCount(tp, "s8", 100_000, opts).weighted, 140);
  appendFileSync(tp, inference("req-5", []) + "\n");
  const after = turnCount(tp, "s8", 20_000, opts);          // context collapsed — /compact
  assert.equal(after.turns, 0);
  assert.equal(after.weighted, 140, "spend survives the compact — it was billed, the window resetting does not refund it");
  appendFileSync(tp, inference("req-6", []) + "\n");
  assert.equal(turnCount(tp, "s8", 25_000, opts).weighted, 175, "and keeps growing from there");
});
