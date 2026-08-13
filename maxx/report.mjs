/**
 * The weekly report: where the week went, per account, and what to do differently.
 *
 * Everything here is derived from what maxx already stores — Anthropic's own usage
 * percentages plus the per-surface billed totals. No new collection, no daemon: the counter
 * has been running all along, this reads it back.
 *
 * The findings are the point. A number nobody acts on is a number nobody reads, so each one
 * pairs an observation with the move it implies, and only fires when the evidence is actually
 * there — a report that always says something says nothing.
 */

const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const abbr = (n) => {
  n = Math.round(Math.abs(n || 0));
  return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : `${n}`;
};

/**
 * @param {Array<{handle, weekPct, fivePct, weekBilled, surfaces?: Array<{surface, billed}>}>} accounts
 * @returns {{accounts, totalBilled, spread, findings: Array<{id, text, action}>}}
 */
export function weeklyReport(accounts = []) {
  const live = accounts.filter((a) => Number.isFinite(a?.weekPct));
  const totalBilled = accounts.reduce((s, a) => s + (a.weekBilled || 0), 0);

  // Spread = the gap between the fullest and emptiest account's week. It is the one number
  // that says whether the pool is being used as a pool: two accounts at 90%/10% hold the same
  // total as two at 50%/50%, but the first pair is one wall away from stopping.
  const spread = live.length > 1
    ? Math.max(...live.map((a) => a.weekPct)) - Math.min(...live.map((a) => a.weekPct))
    : null;

  const findings = [];

  if (spread != null && spread >= 0.25) {
    const full = live.reduce((m, a) => (a.weekPct > m.weekPct ? a : m));
    const empty = live.reduce((m, a) => (a.weekPct < m.weekPct ? a : m));
    findings.push({
      id: "uneven-burn",
      text: `@${full.handle} is at ${pct(full.weekPct)} of its week while @${empty.handle} sits at ${pct(empty.weekPct)} — a ${pct(spread)} spread.`,
      action: `Run the next sessions on @${empty.handle}: \`maxx switch\` picks it automatically.`,
    });
  }

  for (const a of live) {
    if (a.weekPct >= 0.95) {
      findings.push({
        id: "walled",
        text: `@${a.handle} spent its week (${pct(a.weekPct)}).`,
        action: live.some((o) => o.weekPct < 0.8)
          ? "Another account still has room — switch rather than wait for the reset."
          : "Every account is near its wall; this week's work is done, not blocked.",
      });
    }
  }

  // Concentration: one surface eating the week is the single most actionable thing in here,
  // because it is usually one runaway loop or one chatty automation, not "usage".
  for (const a of live) {
    const surfaces = [...(a.surfaces || [])].sort((x, y) => (y.billed || 0) - (x.billed || 0));
    const top = surfaces[0];
    const acctTotal = surfaces.reduce((s, x) => s + (x.billed || 0), 0);
    if (top && acctTotal > 0 && top.billed / acctTotal >= 0.5) {
      findings.push({
        id: "concentrated",
        text: `${pct(top.billed / acctTotal)} of @${a.handle}'s week went to one surface: ${top.surface} (${abbr(top.billed)}).`,
        action: "Worth a look — that share is usually one loop or one automation, not steady work.",
      });
    }
  }

  const dark = accounts.filter((a) => !Number.isFinite(a?.weekPct));
  if (dark.length) {
    findings.push({
      id: "unreadable",
      text: `No live usage for ${dark.map((a) => `@${a.handle}`).join(", ")}.`,
      // The 26-hour outage began exactly here, as a silent unknown nobody was told about.
      action: "Run `maxx setup` for that account — an unreadable account is not an idle one.",
    });
  }

  if (!findings.length && live.length) {
    findings.push({ id: "clean", text: "Burn is even and no account is near a wall.", action: "Nothing to change." });
  }

  return { accounts: live, totalBilled, spread, findings };
}

/** The report as text. Kept plain so it works in a terminal, an email, or a commit body. */
export function renderReport(report, { title = "maxx · your week" } = {}) {
  const out = [title, ""];
  if (!report.accounts.length) {
    out.push("  No account has a live usage reading yet. `maxx setup` links one.");
    return out.join("\n");
  }
  for (const a of report.accounts) {
    out.push(`  @${a.handle.padEnd(12)} week ${String(pct(a.weekPct)).padStart(4)}   5h ${String(pct(a.fivePct)).padStart(4)}   ${abbr(a.weekBilled)} counted`);
  }
  out.push("");
  out.push(`  ${abbr(report.totalBilled)} tokens across ${report.accounts.length} account${report.accounts.length === 1 ? "" : "s"}${report.spread != null ? ` · ${pct(report.spread)} spread` : ""}`);
  out.push("");
  for (const f of report.findings) {
    out.push(`  • ${f.text}`);
    out.push(`    → ${f.action}`);
  }
  return out.join("\n");
}
