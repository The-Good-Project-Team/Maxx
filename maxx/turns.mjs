// TURNS — the number that actually multiplies context.
//
// "How many messages have I sent" is not the cost of a chat. Every tool call is another
// inference, every inference re-bills the whole window, and a subagent spawns a window of
// its own that spawns more. Measured on a real session: 12 human messages, 86 calls in the
// root transcript, 695 more inside 8 subagent transcripts — 781, or 65x what "12 turns"
// claimed. The count that was being shown was the one number in the pile that does not grow.
//
// So this counts BOTH, and the pair is the point: msgs is what you did, turns is what it cost.
//
// A turn = one inference = one row carrying message.usage, deduped by requestId. Streaming
// writes several rows per request (a text block, then each tool_use) and they land adjacent,
// so remembering the last id is enough — verified against a 297-row transcript: adjacent
// dedup and full-set dedup both give 183.
//
// Subagent transcripts live under <project>/<sid>/subagents/, and workflow agents nest one
// level deeper (subagents/workflows/wf_*/). The tree is walked, not assumed: depth-2 spawns
// are real. Everything is INCREMENTAL — transcripts run to megabytes and this renders every
// two seconds, so each file's byte offset and running count are persisted and only the bytes
// appended since the last look are read.
import { statSync, openSync, readSync, closeSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { weighUsage } from "./limit.mjs";

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };

// Read the bytes appended since `off`, whole lines only: a render can land mid-append, so we
// stop at the last newline and leave the fragment for next time rather than dropping the row
// or counting it twice. Returns null when there is nothing new.
function tail(file, off) {
  let size; try { size = statSync(file).size; } catch { return null; }
  if (size < off) off = 0;                                        // replaced or truncated
  if (size <= off) return { text: "", off, size };
  let text = "";
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - off);
    readSync(fd, buf, 0, size - off, off);
    closeSync(fd);
    text = buf.toString("utf8");
  } catch { return { text: "", off, size }; }
  const cut = text.lastIndexOf("\n");
  if (cut < 0) return { text: "", off, size };
  return { text: text.slice(0, cut + 1), off: off + Buffer.byteLength(text.slice(0, cut + 1), "utf8"), size };
}

// Scan one transcript's new bytes. `st` is {off, n, msgs, rid} and is mutated in place.
// msgs counts only what the HUMAN sent: a "user" row whose content is a string, or blocks with
// no tool_result in them. Tool results arrive as "user" rows too and outnumber real messages
// twenty to one, and a sidechain "user" row is the harness prompting an agent, not a person.
function scan(file, st) {
  const t = tail(file, st.off);
  if (!t) return st;
  if (t.off < st.off || t.off === 0) { st.n = 0; st.msgs = 0; st.rid = null; }
  for (const line of t.text.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "user" && !r.isSidechain) {
      const c = r.message && r.message.content;
      if (typeof c === "string") st.msgs++;
      else if (Array.isArray(c) && !c.some((b) => b && b.type === "tool_result")) st.msgs++;
    }
    if (r.message && r.message.usage) {
      const rid = r.requestId || r.uuid || null;
      // w: what the inference cost in quota-weighted tokens — the scanner's own formula, so the
      // chat's share of the week and the week's own gauge are the same arithmetic.
      if (rid !== st.rid) { st.n++; st.rid = rid; st.w = (st.w || 0) + weighUsage(r.message.usage, r.message.model || ""); }
    }
  }
  st.off = t.off;
  return st;
}

// Every .jsonl under <project>/<sid>/ — subagents, and workflow agents nested below them.
// Cached briefly: the offsets make re-reading cheap, but re-walking the tree every tick is not.
const listCache = new Map();
export function agentFiles(tp, sid, now = Date.now()) {
  if (!tp || !sid) return [];
  const dir = path.join(path.dirname(tp), sid);
  const hit = listCache.get(dir);
  if (hit && now - hit.at < 10000) return hit.files;
  const files = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name.endsWith(".jsonl")) files.push(f);
    }
  };
  walk(dir, 0);
  listCache.set(dir, { at: now, files });
  return files;
}

/**
 * @returns {{msgs:number, turns:number, weighted:number, epoch:number}} msgs = what you sent,
 * turns = inferences it cost, root plus every agent it spawned; weighted = those inferences in
 * quota-weighted tokens, whole chat; epoch = the same since the last compact (what THIS context cost).
 */
export function turnCount(tp, sid, ctxNow, opts = {}) {
  const home = opts.home || homedir();
  const p = path.join(home, ".maxx", "turns.json");
  const db = readJSON(p, {});
  const key = sid || "unknown";
  let cur = db[key] || { off: 0, n: 0, msgs: 0, ctx: 0, rid: null, w: 0, w0: 0, subs: {} };
  // A state file written before turns meant inferences holds a MESSAGE count in `n` and no
  // `msgs` at all. Carrying it forward would print the old number under the new label and
  // NaN the new one, so an entry that predates the shape is recounted from the top.
  if (typeof cur.msgs !== "number") cur = { off: 0, n: 0, msgs: 0, ctx: cur.ctx || 0, rid: null, subs: {} };
  if (!cur.subs) cur.subs = {};
  if (!tp) return { msgs: cur.msgs || 0, turns: cur.n || 0, weighted: cur.w || 0, epoch: Math.max(0, (cur.w || 0) - (cur.w0 || 0)) };
  // /clear and /compact collapse the context, and this sits beside the context reading, so it
  // restarts with it: "72 turns" next to a freshly emptied window would be a lie about both.
  // The tell is the context itself halving — Claude Code keeps the session id across a compact.
  if (ctxNow > 0 && cur.ctx > 0 && ctxNow < cur.ctx * 0.5) {
    let size = 0; try { size = statSync(tp).size; } catch {}
    // The SPEND does not restart: it was billed, and the window emptying does not refund it. Agent
    // files keep their offsets for the same reason — re-reading them would bill their turns twice.
    // But the EPOCH does: w0 marks the total at this compact, and epoch = total - w0 is what the
    // context now in the window has cost. That is the number the chat score uses. A chat that
    // just compacted is cheap again, and scoring its sunk spend would order a hand-off that
    // changes nothing, since the context is already small. Sunk spend stays in `weighted`.
    const subs = {};
    let sum = cur.w || 0;
    for (const [f, st] of Object.entries(cur.subs)) { subs[f] = { ...st, n: 0 }; sum += st.w || 0; }
    cur = { off: size, n: 0, msgs: 0, ctx: 0, rid: null, w: cur.w || 0, w0: sum, subs };
  }
  if (ctxNow > 0) cur.ctx = ctxNow;
  scan(tp, cur);
  let turns = cur.n, weighted = cur.w || 0;
  for (const f of agentFiles(tp, sid, opts.now)) {
    const st = cur.subs[f] || { off: 0, n: 0, msgs: 0, rid: null, w: 0 };
    scan(f, st);
    cur.subs[f] = st;
    turns += st.n;                                     // agent msgs are harness prompts, not yours
    weighted += st.w || 0;
  }
  db[key] = cur;
  const keys = Object.keys(db);                        // don't grow forever
  if (keys.length > 12) for (const k of keys.slice(0, keys.length - 12)) delete db[k];
  try { writeFileSync(p, JSON.stringify(db)); } catch {}
  return { msgs: cur.msgs, turns, weighted, epoch: Math.max(0, weighted - (cur.w0 || 0)) };
}
