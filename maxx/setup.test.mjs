import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAccounts, probeAccount } from "./setup.mjs";

const tmpConfig = (cfg) => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "maxx-setup-")), "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
};

test("reads both the accounts map and the single-account top level, without duplicates", () => {
  const p = tmpConfig({
    logsUrl: "https://api.example",
    handle: "reif", secret: "s1",
    accounts: { a: { handle: "reif", secret: "s1" }, b: { handle: "reif_tgp", secret: "s2" } },
  });
  const { base, accounts } = readAccounts(p);
  assert.equal(base, "https://api.example");
  assert.deepEqual(accounts.map((a) => a.handle), ["reif", "reif_tgp"]);
});

test("an account without a secret is not an account", () => {
  const p = tmpConfig({ accounts: { a: { handle: "nosecret" } } });
  assert.deepEqual(readAccounts(p).accounts, []);
});

test("a missing config is empty, not a crash", () => {
  assert.deepEqual(readAccounts("/nope/does-not-exist.json").accounts, []);
});

test("an HTTP status is reported as that status — never as idle", async () => {
  // The whole outage in one assertion: a 403 from the edge must not read as "no usage".
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  try {
    const r = await probeAccount("https://api.example", { handle: "h", secret: "s" });
    assert.equal(r.error, "HTTP 403");
    assert.equal(r.weekPct, undefined, "a denied request must not produce a usage number");
  } finally { globalThis.fetch = orig; }
});

test("a payload without a live anchor is dark, not zero", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ usage_week_live: false, usage_week_pct: 0.4 }) });
  try {
    const r = await probeAccount("https://api.example", { handle: "h", secret: "s" });
    assert.equal(r.error, "no live /usage anchor");
    assert.equal(r.weekPct, undefined);
  } finally { globalThis.fetch = orig; }
});

test("a live payload comes back as percentages plus surfaces", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    usage_week_live: true, usage_five_live: true, usage_week_pct: 0.82, usage_five_pct: 0.26,
    week_billed: 1_405_413_743, surfaces: [{ surface: "laptop:a", billed_5h: 95e6 }],
  }) });
  try {
    const r = await probeAccount("https://api.example", { handle: "reif", secret: "s" });
    assert.equal(r.error, null);
    assert.equal(r.weekPct, 0.82);
    assert.deepEqual(r.surfaces, [{ surface: "laptop:a", billed: 95e6 }]);
  } finally { globalThis.fetch = orig; }
});

test("a thrown network error is a finding, not a crash", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("socket hang up"); };
  try {
    assert.equal((await probeAccount("https://api.example", { handle: "h", secret: "s" })).error, "socket hang up");
  } finally { globalThis.fetch = orig; }
});
