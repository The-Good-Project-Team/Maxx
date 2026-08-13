/**
 * Round-robin across your Claude accounts, by whichever one has the most room LEFT.
 *
 * Claude's limits are per account and they refill on two clocks (a 5h window and a week).
 * One account is therefore idle capacity while another is walled, and the switch itself is
 * cheap: each account lives in its own CLAUDE_CONFIG_DIR, so moving between them is an env
 * var, not a re-login. What was missing is the decision — which one, right now.
 *
 * "Round robin" here is deliberately NOT a rotation counter. Taking accounts in turn spends
 * the walled one's turn on nothing; the useful order is emptiest-first, which converges to
 * even burn on its own because using an account is what makes it stop being the emptiest.
 *
 * The ranking reads ONLY Anthropic's numbers (usage_week_pct / usage_five_pct). maxx's own
 * counters do not participate: on 2026-08-13 they reported both of these accounts as spent
 * while one still had 18% of its real week, which is exactly the call this would have gotten
 * wrong.
 *
 * Relationship to nonprofit-atlas's scripts/lucky2/account_pool.sh, which has run this fleet
 * for months: same signal (live usage_week_pct), same 0.95 gate, same rule that an unreadable
 * account never counts as an empty one. It differs deliberately in ONE place. account_pool is
 * FIRST-FIT FAILOVER — a fixed order ("reif tgp"), take the first that is not gated — which is
 * right for "keep the fleet running" and wrong for "burn evenly": it drains account one to 95%
 * before account two does any work at all. This ranks emptiest-first, so the two converge
 * instead of one being a reserve tank. Anything needing strict failover should keep calling
 * account_pool.sh; this is the balancer.
 */

// Anthropic's weekly wall, same default account_pool.sh uses (ACCOUNT_POOL_WEEK_GATE_PCT).
const DEFAULT_WALLED_AT = Number(process.env.MAXX_WEEK_GATE_PCT || "0.95");

/** The window that actually binds an account right now: whichever is closer to its wall. */
export function bindingUsage(usage) {
  const week = Number(usage?.weekPct);
  const five = Number(usage?.fivePct);
  const known = [week, five].filter((x) => Number.isFinite(x) && x >= 0);
  return known.length ? Math.max(...known) : null;
}

/**
 * Accounts sorted emptiest-first. Anything with no live reading sorts last — never first:
 * an unreadable account is not an empty one, and that distinction is the whole reason the
 * fleet spent a day switched off.
 *
 * @param {Array<{handle: string, usage?: {weekPct: number, fivePct: number}, configDir?: string}>} accounts
 */
export function rankAccounts(accounts = []) {
  return [...accounts]
    .map((a) => ({ ...a, binding: bindingUsage(a.usage) }))
    .sort((x, y) => {
      if (x.binding == null && y.binding == null) return 0;
      if (x.binding == null) return 1;          // unknown sorts behind every real reading
      if (y.binding == null) return -1;
      return x.binding - y.binding;
    });
}

/**
 * The account to run the next session on, or null when nothing is readable.
 * `walledAt` (default 0.95, MAXX_WEEK_GATE_PCT) is Anthropic's wall: an account at or past it has nothing to
 * give this window, so it is skipped even if it is the emptiest of a bad set — unless every
 * account is walled, in which case the emptiest is still returned and the caller can say so.
 */
export function pickAccount(accounts = [], { walledAt = DEFAULT_WALLED_AT } = {}) {
  const ranked = rankAccounts(accounts).filter((a) => a.binding != null);
  if (!ranked.length) return null;
  const usable = ranked.filter((a) => a.binding < walledAt);
  const chosen = usable[0] || ranked[0];
  return { ...chosen, walled: !usable.length, alternatives: ranked.slice(1).map((a) => a.handle) };
}

/**
 * The line a shell can eval to actually move: `export CLAUDE_CONFIG_DIR=...`.
 * Returns null without a configDir rather than inventing a path — pointing CLAUDE_CONFIG_DIR
 * at a directory that was never logged in produces a confusing auth prompt, not a switch.
 */
export function switchCommand(account) {
  if (!account?.configDir) return null;
  return `export CLAUDE_CONFIG_DIR=${JSON.stringify(account.configDir)}`;
}
