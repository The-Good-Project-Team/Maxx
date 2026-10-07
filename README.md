# maxx

### Keep pace with your Claude subscription.

🌐 [meetmaxx.co](https://meetmaxx.co) · [Install](#install-humans)

`/usage` tells you how much of the week is gone. It does not tell you whether that is fine.
"62% used" means nothing on its own. "62% used on Tuesday, 2x over pace" is a decision.

maxx counts real spend across every machine and every agent, prices it per model, and answers one
question: **are you on pace to land the week on its reset, and if not, when do you run out.**

It answers as a rate. Your burn in %/hr against the %/hr that exactly spends the week:

> **Over pace — the week ends early**
> Burning 13.00%/hr against 0.44%/hr sustainable. At this rate you are out in 1.7h (Thu 6 PM),
> 2d before the reset. Cut to 0.44%/hr to make it.

The number sits in the statusline every two seconds, and in the gate your agents hit before they
fan out. Local. No account.

**maxx counts. Anthropic limits.** Nothing here can deny you work — a counter that can deny is a
limit nobody agreed to. The only things that stop a call are Anthropic's own 5h and weekly
windows, and they enforce themselves by rejecting it.

## Install (humans)

```bash
curl -fsSL https://meetmaxx.co/install | bash
```

Restart Claude Code and the bar is there. That is the whole install.

<details>
<summary>Or install as a Claude Code plugin</summary>

```
/plugin marketplace add reif-y/Maxx
/plugin install maxx
/maxx wire
```

A plugin can place skills but it **cannot** write to `settings.json`, so `/plugin install` alone
gets you the `/maxx` and `/fenix` commands with no statusline and no hooks. `/maxx wire` adds
those. (Run `/maxx` without it and the card tells you what is missing.)
</details>

## Using it

**The bar shows up on its own.** One reading per wall, left to right:

```
@you · opus  │  chat 39%  │  session 6% · 3h55m  │  week 151h/18h  │  Maxx · main · f6a931d9  │  /maxx
```

| | |
|---|---|
| `chat 39%` | how full this conversation is, out of 100 where **100 is the hand-off line** — the point to `/fenix` and `/clear`. Amber from 71, red from 85. |
| `session 6% · 3h55m` | the 5-hour window: spent, and when it resets. |
| `week 151h/18h` | **clock against runway.** 151h until the weekly reset; the budget lasts 18h at your current burn. Runway short of the clock is red — you run dry early, and the gap is how long you sit locked out. A `+3h` beside it means easing off just bought you three hours back. |
| `f6a931d9` | this chat's id. Paste it to another session; `/maxx who f6a931d9` resolves it. |

**Commands, in the order you'll want them:**

```
/maxx              totals, cache-hit rate, streak
/maxx session      what's safe to spend right now, in plain language
/maxx accounts     every login on this box — which is live, which is walled, when it frees up
/maxx who <id>     resolve an 8-char session tag back to its repo and account
/maxx turn         what the last turn cost
/maxx switch       move to the account with the most room (`eval "$(maxx switch)"`)
```

**When a chat fills up, you don't lose the thread.** At ~85% the bar's chat reading is near its
line and fenix says so on its own:

> `fenix: chat 87% of its hand-off line. Run /fenix to write the handoff, then /clear — the next
> session resumes this thread automatically.`

Type `/fenix`, then `/clear`. The next session in that directory wakes up already knowing the
branch, the uncommitted files, the open PRs, and what you were in the middle of — no "remind me
where we were" round-trip. That is the loop: **maxx knows how full the chat is, fenix carries the
thread across the clear that empties it.**

Nothing else to learn. The rest is the bar telling you when to care.

Stays current on its own: if you keep the background shipper running (`--install-agent`, or
the installer's default), it checks in with the server every 30 minutes and reinstalls itself
the moment a new version ships — same command as above, run for you. Nothing to remember, no
cron to set up. A dev checkout (`--link`) is exempt; it's never overwritten.

## Local by default

**The install claims nothing and calls nobody.** Your numbers come from Anthropic itself: the 5-hour
and weekly percentages ride in on every session, already summed across every machine and every agent
on that login. maxx reads them, prices the local ledger against them, and draws the bar. No account,
no network, nothing to be down.

That is also why there is no "collate my machines" step. Anthropic's number *is* the collation —
measured on a two-account box: the tally returned 83.0%/17.0% for a handle, byte-identical to what
the local session already had, because the tally anchors to that same number.

`server/` holds an optional tally for people who want one page across several machines. Nothing
the statusline, the gate or `/maxx accounts` does needs it, verified with the API blackholed.

The budget gate **fails open**. It denies on a real weekly wall and never on its own
unreachability — a counter that stops your work because it cannot reach itself is inventing a
limit, which is the one thing this project promises not to do. `gate.mjs --fail closed` if you
want the stricter posture.

## Your stuff stays yours

Nothing leaves your machine. maxx reads token counts, timestamps and model names from Claude Code's
own logs. Never a prompt, never a message, never your code.

## Development

Requires Node 18+.

```bash
npm test    # node --test maxx/*.test.mjs fenix/*.test.mjs server/*.test.mjs
```

`server/` is the tally: `tally.mjs` is pure (ingest, budget, watchdog); `handler.mjs`
wraps it in HTTP + MCP. `maxx/emit.mjs` ships counts from a machine; `maxx/render.mjs` draws the
statusline bar. `fenix/fenix.mjs` writes and resumes the handoffs.

## License

MIT. See [LICENSE](LICENSE).
