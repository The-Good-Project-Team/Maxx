---
name: maxx
description: "Show your Claude Code token stats — total tokens, tokens/day, cache-hit rate, and streak — parsed from ~/.claude/projects. Use when the user types /maxx or asks about their Claude Code usage, token count, cache-hit rate, or streak."
trigger: /maxx
---

# /maxx

Parse the local Claude Code session logs (`~/.claude/projects/**/*.jsonl`) into a
shareable usage card: total tokens, tokens/day, cache-hit rate, and streak.

Reads only token/usage metadata — never prompt or message content.

## Usage

```
/maxx            # print the usage card
/maxx turn       # what the LAST TURN cost: tokens + api calls (+ subagent burn), this session
/maxx fenix      # burn down, rise with context: handoff → /clear → auto-resume (alias: /fenix)
/maxx session    # session tokens: how much to burn this rolling 5h window (plain language)
/maxx json       # print the raw stats payload (JSON)
/maxx nazi       # hourly posture check: ranked token drains + one lever (for agents)
/maxx agents     # WHO is burning: per-root-session token attribution, named (for agents)
/maxx refresh    # stuck or stale bar: clear the derived caches, rebuild the window
/maxx dark       # dark statusline theme — /maxx light switches back, /maxx auto adopts the terminal's own colors
/maxx config     # show settings, secrets masked · `config <key> <value>` sets (dotted keys ok)
```

## What to do

1. Locate the bundled tracker. It sits next to this SKILL.md as `tracker.mjs`.
   The canonical installed path is `~/.claude/skills/maxx/tracker.mjs`.

2. Run it:
   - Card:      `node ~/.claude/skills/maxx/tracker.mjs`
   - Turn:      `node ~/.claude/skills/maxx/tracker.mjs turn`   (when the user says `turn` / "what did that cost"; `--json` for machine form. Print the two lines verbatim in your reply so the receipt lands in the transcript.)
   - Fenix:     when the user says `fenix`, follow `~/.claude/skills/fenix/SKILL.md` (write `.fenix/handoff.md`, then the human /clears — or `node ~/.claude/skills/maxx/fenix.mjs --rise` for an unattended headless continuation). fenix is a maxx subroute; /fenix is the same flow.
   - Session:   `node ~/.claude/skills/maxx/tracker.mjs session`   (when the user says `session`)
   - Setup:     `node ~/.claude/skills/maxx/tracker.mjs setup`   (walks every account, links the ones not reporting, prints the week)
   - Switch:    `node ~/.claude/skills/maxx/tracker.mjs switch`   (the account with the most room left; prints only `export CLAUDE_CONFIG_DIR=…` when piped, so `eval "$(maxx switch)"` works)
   - Report:    `node ~/.claude/skills/maxx/tracker.mjs report`   (where the week went, per account, with the move each finding implies)
   - JSON:      `node ~/.claude/skills/maxx/tracker.mjs --json`
   - Nazi:      `node ~/.claude/skills/maxx/limit.mjs --nazi`   (when the user says `nazi`; add `--json` for the machine form)
   - Agents:    `node ~/.claude/skills/maxx/agents.mjs`   (when the user says `agents`; `--children` to expand live descendants, `--mins N` window, `--json` machine form)
   - Refresh:   `node ~/.claude/skills/maxx/tracker.mjs refresh`   (when the bar looks stuck/stale; rebuild takes up to a minute on a big history)
   - Theme:     `node ~/.claude/skills/maxx/tracker.mjs dark` / `… light` / `… auto` (auto = adopt the terminal's own colors — ghostty theme palette; CLI light/dark elsewhere)
   - Config:    `node ~/.claude/skills/maxx/tracker.mjs config [key] [value]`   (no args = show, secrets masked)

   `agents` answers "what's using all the tokens" with names, not a count. Every
   session log nests: a root session at `<project>/<ROOT>.jsonl` owns everything
   under `<project>/<ROOT>/subagents/**` (subagent spawns AND workflow fan-outs).
   A 300-agent workflow is ONE root's burn. agents.mjs rolls all descendants up to
   their root, labels it with the human title (customTitle > aiTitle > agentName)
   and git branch, ranks by billed tokens over the window, and flags 🔴 anything
   with a turn in the last 5 min (live = still bleeding; idle = done, no action).
   Agent-readable: the FIRST stdout line is a single `MAXX_AGENTS window=… billed=…
   roots=… live_roots=… top=[…]` record — an agent can grep just that. `--json`
   gives the full per-root breakdown (own / subagents / workflow split, live
   children). Show the human the card verbatim.

   **Token budget — read before interpreting `session`.** THE RULE: **maxx counts,
   Anthropic limits.** Nothing maxx reports can deny work. The only things that stop a
   call are Anthropic's own 5h and weekly windows, and they enforce themselves by
   rejecting it. If a reading fails, PROCEED — an unreadable meter is not an exhausted
   account, and treating those as the same thing switched a fleet off for 26 hours.

   `session` shows THREE MARKS, all percentages of the SAME thing (this 5h window), so
   they can be compared without arithmetic:

   | mark | meaning |
   |---|---|
   | `used` | where you are now, against Anthropic's 5h window |
   | `advise` | the wall we recommend — your weekly share, in this window's terms |
   | `wall` | Anthropic's hard 5h limit. Always 100%. Hitting it is a lockout mid-task |

   The advised wall is never the whole window: 5h windows are not spent evenly (you
   sleep through some and burst through others), so planning every one to the wall
   assumes the flattest possible week. Past `advise` is fine — it borrows from later
   blocks and breaches nothing. `this block` is the same share expressed against the
   WEEK, with `blocks_left_week` blocks to go before the weekly reset.

   Do NOT pace off "% of my 5h limit" (`RAW_5H_*`, `burst`): that reads 100%-is-fine
   every window because the window refills, and six of those in a row ends the week on
   Wednesday with every session "within limits". The payload carries NO token counts — every
   figure is a percent of the week, because our ledger is cache-weighted and never agreed
   with Anthropic's billing. maxx used to publish counts against a tank it set for itself;
   on 2026-08-13 those read empty for two accounts holding 100% and 82% of their real
   Anthropic weeks, and the fleet that believed them opened zero PRs for 26 hours.

   Full model, agent-readable, no auth: `GET https://api.meetmaxx.co/api/model`.

   Pass `--dir PATH` to point at a non-default projects directory.

   `nazi` reads the live status + burn history + your CLAUDE.md tax and prints ranked
   token drains plus the one highest-leverage lever for this hour. An agent can grep
   its `NAZI …` first line. Show the output verbatim.

3. Show the tracker's output to the user verbatim (it is already formatted).
   If they asked for `json`, run with `--json`.

That's it — the script does the parsing and formatting. Do not re-implement the
parse. If the script errors, report the error; don't guess the numbers.

## Multi-login & config (for agents)

One laptop can hold several Claude logins (default `~/.claude` + any
`CLAUDE_CONFIG_DIR=~/.claude-*`). maxx keeps **everything per account**:

- `~/.maxx/config.json` → `accounts: { <claude-account-uuid>: {handle, secret, email} }`
  routes each login's burn to its own handle. The top-level `handle`/`secret` is the
  default login's (auto-bound on first run).
- **Onboard a new login:** run `node ~/.claude/skills/maxx/emit.mjs --signup` in a
  session on that login (derives handle from the email; writes the map entry). Until
  then that login's burn is skipped LOUDLY in `~/.maxx/emit.log` — never mixed into
  another account's timeline. Fixing a skip = that one command.
- **Per-login session files:** in a `CLAUDE_CONFIG_DIR` session every derived cache is
  suffixed (`status-gmail.json`, `window-gmail.json`, `rl-gmail.json`,
  `gate-cache-gmail.json`, …). Read the SUFFIXED file for this session's numbers; the
  plain names belong to the default login. The suffix is
  `basename($CLAUDE_CONFIG_DIR)` minus the `.claude-` prefix.
- The statusline is signed `@handle` — that's whose numbers the bar shows.
- **Cloud/routines:** the account-wide connector serves the contract on initialize —
  gate on `maxx_budget`, and ALWAYS report burn with `maxx_emit`
  (`surface:"cloud:<routine>"`, named sessions entry) at the end of a run. A routine
  that gates but never emits makes the tally read optimistically wrong for everyone.
- Numbers look wrong/stuck? `/maxx refresh` (clears this login's derived caches,
  rebuilds). Settings: `/maxx config` (secrets masked).

## Live status (agent-readable)

The statusline renderer writes a machine-readable snapshot every render tick to
`~/.maxx/status.json`. Read that file (or `render.mjs --status`, no stdin
needed) to check pace mid-task.

**`session.cap` is the session token budget (weekly-paced), NOT the raw 5h wall.** Pace
off these: `session.toSpend` (safe to spend now, ≥0), `session.over` (past your
share, ≥0), `session.spendPerMin` (even rate for the time left), `session.capKind`
(`weekly-paced` | `5h-cap`), `sessionsLeftInWeek`. The ACTUAL 5h window is exposed
separately as `session.rawCap / rawUsedPct / rawHeadroom` — informational only, do
not pace off it. `burn5m` = gross tokens spent in the last 5 min.

(tracker's `--json` exposes the raw 5h window as `.session5hRaw` — same warning:
raw wall, not the sustainable budget.)

## Notes

- First run scans every session file (a few seconds on a large history).
- `cache-hit` = cache-read tokens ÷ all input-side tokens.
- `streak` = consecutive local-calendar days with activity, ending today/yesterday.
- maxx is fully on-box: it reads local logs only and sends nothing anywhere.
