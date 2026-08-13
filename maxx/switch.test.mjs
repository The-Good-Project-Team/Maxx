import test from "node:test";
import assert from "node:assert/strict";
import { bindingUsage, rankAccounts, pickAccount, switchCommand } from "./switch.mjs";

// Live shape, 2026-08-13: two accounts, one walled on the week, one with room.
const TGP = { handle: "reif_tgp", configDir: `${process.env.HOME}/.claude`, usage: { weekPct: 1.0, fivePct: 0.0 } };
const REIF = { handle: "reif", configDir: `${process.env.HOME}/.claude-reif`, usage: { weekPct: 0.82, fivePct: 0.26 } };

test("the binding window is whichever is closer to its wall", () => {
  assert.equal(bindingUsage({ weekPct: 0.82, fivePct: 0.26 }), 0.82);
  assert.equal(bindingUsage({ weekPct: 0.10, fivePct: 0.97 }), 0.97);  // a spent 5h block binds
  assert.equal(bindingUsage({}), null);
  assert.equal(bindingUsage(), null);
});

test("picks the account with room over the one at its weekly wall", () => {
  const pick = pickAccount([TGP, REIF]);
  assert.equal(pick.handle, "reif");
  assert.equal(pick.walled, false);
  assert.deepEqual(pick.alternatives, ["reif_tgp"]);
});

test("order of the input does not decide the answer", () => {
  assert.equal(pickAccount([TGP, REIF]).handle, pickAccount([REIF, TGP]).handle);
});

test("emptiest-first, not first-fit — this is where it parts from account_pool.sh", () => {
  // Both accounts are under the 0.95 gate, so atlas's fixed-order failover would take
  // whichever comes first in ACCOUNT_POOL_ORDER and keep draining it. Balance takes the
  // emptier one, which is what makes the two converge instead of one becoming a reserve.
  const busy = { handle: "busy", usage: { weekPct: 0.80, fivePct: 0.1 } };
  const fresh = { handle: "fresh", usage: { weekPct: 0.05, fivePct: 0.1 } };
  assert.equal(pickAccount([busy, fresh]).handle, "fresh");
});

test("an unreadable account is never mistaken for an empty one", () => {
  const dark = { handle: "dark" };                       // no usage at all
  const nearly = { handle: "nearly", usage: { weekPct: 0.94, fivePct: 0.5 } };
  assert.equal(pickAccount([dark, nearly]).handle, "nearly");
  assert.equal(rankAccounts([dark, nearly])[1].handle, "dark", "unknown must sort last");
});

test("nothing readable yields null, not a guess", () => {
  assert.equal(pickAccount([{ handle: "a" }, { handle: "b" }]), null);
  assert.equal(pickAccount([]), null);
});

test("every account walled still returns the emptiest, flagged", () => {
  const pick = pickAccount([TGP, { handle: "other", usage: { weekPct: 0.96, fivePct: 0.9 } }]);
  assert.equal(pick.handle, "other");
  assert.equal(pick.walled, true, "caller must be able to say 'all accounts are walled'");
});

test("the gate matches account_pool.sh's 0.95, not the 0.99 hard wall", () => {
  const at96 = { handle: "at96", usage: { weekPct: 0.96, fivePct: 0.1 } };
  const at94 = { handle: "at94", usage: { weekPct: 0.94, fivePct: 0.1 } };
  assert.equal(pickAccount([at96, at94]).handle, "at94");
  assert.equal(pickAccount([at96]).walled, true);
});

test("switch command is the env var, and refuses to invent a config dir", () => {
  assert.equal(switchCommand(REIF), `export CLAUDE_CONFIG_DIR="${process.env.HOME}/.claude-reif"`);
  assert.equal(switchCommand({ handle: "nodir" }), null);
});
