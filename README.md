# maxx

### One tally for what you can spend right now.

🌐 [meetmaxx.co](https://meetmaxx.co) · [For agents](#for-agents) · [Install (humans)](#install-humans)

Claude enforces two walls: a 5-hour session cap and a 7-day weekly cap. `/usage` only shows the
5-hour one. Spend every 5-hour window to the wall and the week runs out by Wednesday, with every
individual session reading "within limits" right up to the point it isn't.

maxx counts real spend across every machine and every agent, prices it per model, and answers one
question: **how much can this session safely spend right now.**

## For agents

Give any agent an MCP connector and it can check its own budget before it burns it, on its own —
no human in the loop.

```
https://api.meetmaxx.co/mcp?handle=<you>&k=<secret>
```

Point an MCP client at that URL, or call it directly:

```bash
curl -X POST "https://api.meetmaxx.co/mcp?handle=<you>&k=<secret>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"maxx_budget","arguments":{}}}'
```

Get a handle + secret in one call:

```bash
curl -X POST https://api.meetmaxx.co/api/signup -H "Content-Type: application/json" \
  -d '{"handle":"<you>"}'
```

**Tools:**

| tool | what it does |
|---|---|
| `maxx_budget` | Read live pacing: `verdict` (`ok` / `over` / `calibrating` / …), how much of this 5h block is spent vs. advised, whether you're on pace for the week. |
| `maxx_emit` | Report this session's usage back to the tally. |
| `maxx_reserve` / `maxx_release` | Hold a slice of budget before fanning out concurrent agents, release it when done — stops sibling agents from double-spending the same window. |
| `maxx_directive` | Pause, resume, or nudge a specific live session to `/clear` — fleet-wide remote control. |

**The rule: maxx counts, Anthropic limits.** Nothing `maxx_budget` returns can deny a call — only
Anthropic's own 5h/weekly windows do that, by rejecting the request. `verdict: "over"` means
Anthropic's real wall is up, not a number maxx invented. Pace against `block_share_pct` (what
this window may spend, as % of the week) vs `block_used_pct` (what it already has) — not against
"% of the 5h limit," which reads fine every window right up until the week is gone.

A brand-new handle reads `verdict: "calibrating"` until one real Claude Code session anchors it
against Anthropic's `/usage` — after that every field is live.

Full field-by-field model: `GET /api/model`.

## Install (humans)

Want the same numbers in your terminal as a live statusline, plus a `/maxx` skill?

```bash
curl -fsSL https://meetmaxx.co/install | bash
```

Restart Claude Code. `/maxx` shows totals; `/maxx session` shows what's safe to spend right now.
Details, statusline colors, and the dashboard: [meetmaxx.co](https://meetmaxx.co).

Stays current on its own: if you keep the background shipper running (`--install-agent`, or
the installer's default), it checks in with the server every 30 minutes and reinstalls itself
the moment a new version ships — same command as above, run for you. Nothing to remember, no
cron to set up. A dev checkout (`--link`) is exempt; it's never overwritten.

## Your stuff stays yours

Local by default — nothing leaves your machine until you claim a handle. After that: counts only
(tokens, timestamps, model names). Never a prompt, never a message, never your code — the emitter
never reads it.

## Development

Requires Node 18+.

```bash
npm test    # node --test maxx/*.test.mjs server/*.test.mjs
```

`server/` is the tally: `tally.mjs` is pure (ingest, budget, directives, watchdog); `handler.mjs`
wraps it in HTTP + MCP. `maxx/emit.mjs` ships counts from a machine; `maxx/render.mjs` draws the
statusline bar.

## License

MIT. See [LICENSE](LICENSE).
