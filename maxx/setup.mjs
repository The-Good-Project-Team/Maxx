#!/usr/bin/env node
/**
 * `maxx setup` — one interactive pass over every account you have.
 *
 * The pieces already existed and nothing chained them: emit.mjs --set-token mints the
 * long-lived probe per account, the server pulls Anthropic's real /usage with it, and the
 * budget endpoint reads it back. What was missing was a single place that walks the accounts,
 * says which ones are actually reporting, and offers to fix the ones that are not.
 *
 * No daemon is involved and none is needed — maxx is a counter. This is the whole setup.
 */
import { readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { weeklyReport, renderReport } from "./report.mjs";

const CONFIG = process.env.MAXX_CONFIG || path.join(homedir(), ".maxx", "config.json");
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function readAccounts(configPath = CONFIG) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { base: "https://api.meetmaxx.co", accounts: [] };
  }
  const seen = new Set();
  const accounts = [];
  for (const a of [...Object.values(cfg.accounts || {}), cfg]) {
    if (!a?.handle || !a?.secret || seen.has(a.handle)) continue;
    seen.add(a.handle);
    accounts.push({ handle: a.handle, secret: a.secret, email: a.email || null });
  }
  return { base: cfg.logsUrl || "https://api.meetmaxx.co", accounts };
}

/** One account's live state. Never throws — a dark account is a finding, not a crash. */
export async function probeAccount(base, { handle, secret }) {
  try {
    const res = await fetch(`${base}/api/u/${encodeURIComponent(handle)}/budget`, {
      headers: { authorization: `Bearer ${secret}`, "user-agent": "maxx-setup/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { handle, error: `HTTP ${res.status}` };
    const b = await res.json();
    const live = b.usage_week_live && b.usage_five_live;
    return {
      handle,
      // usage_*_pct are fractions; null when the account has never been anchored.
      weekPct: live ? b.usage_week_pct : undefined,
      fivePct: live ? b.usage_five_pct : undefined,
      weekBilled: b.week_billed || 0,
      surfaces: (b.surfaces || []).map((s) => ({ surface: s.surface, billed: s.billed_5h || 0 })),
      error: live ? null : "no live /usage anchor",
    };
  } catch (e) {
    return { handle, error: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

/** `claude setup-token` is interactive (browser + TTY), so this is offered, never forced. */
function offerToken(handle) {
  process.stdout.write(`\n  @${handle} has no live reading. Mint its probe token now? [y/N] `);
  let answer = "";
  try {
    const buf = Buffer.alloc(8);
    const n = readSync(0, buf, 0, 8, null);
    answer = buf.slice(0, n).toString().trim().toLowerCase();
  } catch { answer = ""; }
  if (answer !== "y") {
    console.log(`  skipped — later: node ${path.join(HERE, "emit.mjs")} --set-token`);
    return false;
  }
  const run = spawnSync(process.execPath, [path.join(HERE, "emit.mjs"), "--set-token"], { stdio: "inherit" });
  return run.status === 0;
}

export async function main({ interactive = process.stdin.isTTY } = {}) {
  const { base, accounts } = readAccounts();
  if (!accounts.length) {
    console.log("maxx · setup\n\n  No accounts in ~/.maxx/config.json yet.");
    console.log("  Link one:  curl -fsSL https://meetmaxx.co/install | bash");
    return 1;
  }

  console.log(`maxx · setup\n\n  ${accounts.length} account${accounts.length === 1 ? "" : "s"} in ${CONFIG}\n`);
  const probed = [];
  for (const a of accounts) {
    const r = await probeAccount(base, a);
    const state = r.error ? `✗ ${r.error}` : `✓ week ${Math.round(r.weekPct * 100)}% · 5h ${Math.round(r.fivePct * 100)}%`;
    console.log(`  @${a.handle.padEnd(14)} ${state}`);
    probed.push(r);
  }

  const dark = probed.filter((r) => r.error);
  if (dark.length && interactive) {
    for (const d of dark) if (offerToken(d.handle)) console.log(`  @${d.handle} linked.`);
  } else if (dark.length) {
    console.log(`\n  ${dark.length} account${dark.length === 1 ? "" : "s"} without a live reading. Re-run in a terminal to link, or:`);
    console.log(`    node ${path.join(HERE, "emit.mjs")} --set-token`);
  }

  console.log("");
  console.log(renderReport(weeklyReport(probed)));
  console.log("\n  That is the whole setup — maxx counts, it does not run anything in the background.");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
