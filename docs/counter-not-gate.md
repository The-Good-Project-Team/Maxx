# maxx is a counter

**maxx counts. Anthropic limits.** Everything below follows from that one sentence, and every
bug in this document came from breaking it.

A counter that can deny is a limit nobody agreed to. maxx tracks what you have spent across
every surface and every account, tells you what pace keeps your week alive, and switches you to
the account with room. It does not decide whether you may work. The only things that stop work
are Anthropic's 5-hour and weekly windows, and those enforce themselves — they reject the call.

---

## The four commands

```bash
maxx setup       # walk every account, link the ones that aren't reporting, print the week
maxx session     # used / advised wall / hard wall — three marks, one denominator
maxx switch      # the account with the most room left, as a CLAUDE_CONFIG_DIR export
maxx report      # where the week went, per account, and what to do about it
```

There is no daemon. Nothing runs in the background. A counter does not need one.

### `maxx setup`

One interactive pass over every account in `~/.maxx/config.json`. It says which are reporting
live usage, offers to mint the long-lived probe token for the ones that aren't (`claude
setup-token`, ~1 year, `user:inference` scope), then prints the week.

```
maxx · setup

  2 accounts in /Users/you/.maxx/config.json

  @reif_tgp       ✓ week 100% · 5h 0%
  @reif           ✓ week  84% · 5h 38%
```

The probe token is what lets the server pull Anthropic's real `/usage` when your laptop is
asleep. It is stored server-side per account, never rotated by maxx, and separate from the
credential your CLI logs in with.

### `maxx session` — three marks, one denominator

A session shows where you are, where we suggest stopping, and where Anthropic stops you —
all as percentages of **this 5-hour window**, so they compare without arithmetic:

```
  used       48%     of this 5h window · resets in 14m
  advise     2.4%    your weekly share, in this window's terms — the wall we recommend
  wall       100%    Anthropic's hard 5h limit — hitting it locks you out mid-task
  this block 0.6%    of the WEEK is yours now · 23 blocks left before it resets
  week       86% used    resets in 4d · the only wall that can stop you
```

Expressing the share as a percentage of the WEEK next to usage as a percentage of the WINDOW
is what made the old pacing unreadable: `0.6%` and `48%` look like an enormous margin and are
in fact the same side of the same line. `advise` is that share converted into the window's own
terms.

**The advised wall is never the whole window** — capped below the hard limit for two reasons.
The 5h wall is a *lockout*: planning to it means discovering it mid-task, with the work half
done and nothing to do but wait. And 5-hour windows are not spent evenly — you sleep through
some and burst through others — so a plan that takes every window to the wall assumes the
flattest possible week, which is the one week nobody has.

The number underneath is `block_share_pct`: what remains of your week, divided by the 5-hour
blocks left in it. The obvious alternative — *used ÷ your 5h limit* — is wrong in a way that
takes a week to notice. It reads fine at 100% every block, because the window refills. Spend
to it six blocks running and the week is gone by Wednesday, and every individual session was
"within limits" the whole time.

Going past your share is **amber, never red** — it borrows from later blocks and breaches
nothing.

### `maxx switch` — round-robin by what's left

Claude's limits are per account and refill on two clocks, so one account is idle capacity while
another is walled. Each account already lives in its own `CLAUDE_CONFIG_DIR`, so switching is
an env var, not a re-login.

```
ranked (emptiest first):
   reif      binding=83%
   reif_tgp  binding=100%
pick: reif
export CLAUDE_CONFIG_DIR="/Users/you/.claude-reif"
```

Not a rotation counter: taking accounts strictly in turn spends the walled one's turn on
nothing. Emptiest-first converges to even burn on its own, because using an account is what
stops it being the emptiest. The *binding* window is whichever of week/5h is closer to its wall.

An account with **no live reading sorts last, never first** — an unreadable account is not an
empty one, and confusing the two is what caused the outage below.

> **Relationship to `account_pool.sh`** (nonprofit-atlas): same signal, same 0.95 gate, same
> unknown-is-not-empty rule. It differs in one deliberate way — `account_pool` is *first-fit
> failover* over a fixed order, which drains account one to 95% before account two does any
> work. That is right for "keep the fleet running" and wrong for "burn evenly". Strict failover
> stays there; this is the balancer.

### `maxx report`

Per-account percentages, the spread between fullest and emptiest, the surface eating the week,
and any account that isn't reporting. Every finding carries the move it implies, and none fires
without evidence — a report that always says something says nothing.

```
  • 55% of @reif's week went to one surface: laptop:6fc4c2bc · nonprofit-atlas
    → Worth a look — that share is usually one loop or one automation, not steady work.
```

### For agents: `GET /api/model`

A page a human opens cannot reach an agent mid-run, so the rules live in the API too:

```bash
curl https://api.meetmaxx.co/api/model     # plain markdown, no auth
```

It states the rule, what to pace against, what the hard stops are, and that the derived fields
are counters. The `maxx_budget` MCP tool description points at it, so an agent that has only
ever seen the payload can still find the reasoning.

The payload carries the numbers already computed, so no client re-derives them — three clients
had written three versions of this arithmetic and two were wrong the same way:

```
block_share_pct · block_used_pct · blocks_left_week · on_pace
session_used_pct · session_advised_pct · session_wall_pct
```

One caution learned the hard way: compute these **server-side**. The server sees every surface
on an account; one machine sees one. A local derivation of the advised wall gave 20.5% where
the server said 2.4% for the same window — not rounding, a different denominator.

---

## What happened on 2026-08-13

A fleet spawned **zero builders for 26 hours**. Four separate bugs, each of which alone would
have been survivable, stacked into silence. All four are the same mistake in different costumes:
**treating "I could not measure" as "you may not spend."**

### 1. An HTTP status is not a network failure

```
$ curl -A "Python-urllib/3.11" https://api.meetmaxx.co/api/u/reif_tgp/budget
403     body: "error code: 1010"     server: cloudflare
```

Cloudflare's bot-fight was refusing one box's Python client — error 1010 is a banned client
fingerprint. maxx has **no 403 path at all**: its auth failure is `401`, and `GET /budget`
doesn't even require a token. But the client caught `HTTPError` in the same `except` as
`URLError`, so an edge denial was reported as `maxx_unreachable`, which mapped to `standby`,
which exits.

Every log said the meter was unreachable. The meter was reachable and being refused.

**Fixed:** the error label carries the status (`maxx_http_403` vs `maxx_unreachable`), and a WAF
skip rule on `http.host eq "api.meetmaxx.co"` stopped the edge from doing it.

### 2. Our own counter could deny

`verdict` was `weekPct >= 1 || weekWallHit || fiveWallHit`, where `weekPct` is measured against
**maxx's own configured 1B weekly cap** and the two `WallHit`s are Anthropic's real anchors.

```
reif_tgp   week_billed 1.377B vs our 1B cap    Anthropic's real week: 100%
reif       week_billed 1.405B vs our 1B cap    Anthropic's real week:  82%
```

Both read `over`. The second had 242M real tokens it was not permitted to spend.

**Fixed:** only `weekWallHit || fiveWallHit`. A spent tank throttles pacing advice and denies
nothing. The same fix landed in `gate.mjs`, which had been refusing `Agent`/`Task`/`Workflow`
spawns on `session_to_spend <= 0` — a condition our own counter made true for both accounts.

### 3. The store was re-read from the beginning of time

Even with the above fixed, clients kept timing out. The cause was not the network:

```
$ curl -o /dev/null -w "%{time_total}" http://127.0.0.1:8791/api/u/reif_tgp/budget
26.616729s   22.690071s   22.850560s        ← at the ORIGIN, inside the VM
```

One account's store had grown to **82,150 events / 37MB**, parsed and re-scanned on every single
request. The edge served that as intermittent 502s (8/12 succeeded), and every client turned the
timeout into "unreachable". No client timeout survives a 23-second answer; raising it only
trades a fast failure for a slow one.

**Fixed:** retention (10 days — the widest window any reader uses is 7), anchors capped on every
write path (one account had accumulated 39,852), and dropped events summed into `lifetime_base`
so the odometer never moves when history is retired.

### 4. Reads waited at all

The deeper fix is architectural, and it is the reason this can't come back:

> *"Just set the stake, and that runs after the last check, so the delay is 0, and the worst
> case is the next one uses up all the tokens and is stopped by the wall."*

A budget read now returns the last known number **immediately**, however old, and recomputes
behind it. Only the very first read of a handle blocks. Concurrent readers share one recompute
instead of stampeding a 37MB parse, and a failed refresh serves the last good value rather than
taking the endpoint down.

This is safe *because* maxx is a counter. Being one pass out of date costs at most one
overspend, which Anthropic's wall stops by itself. Being slow cost 26 hours.

Invalidation is exact rather than a TTL: the store is wrapped so **every** `save()` drops that
handle's memo. There are 23 write sites; a cache each of them has to opt into is a cache that
goes stale the first time someone adds a 24th.

### The result

| | before | after |
|---|---|---|
| origin latency | 22–27s | 0.004–2.6s |
| edge reliability | 8/12, intermittent 502s | 10/10 |
| fleet headroom probe | `TimeoutError` → 0 tokens | 1.6s → 240.5M |
| builders per pass | 1 | 13 |
| meter verdict | `standby` (`maxx_unreachable`) | `taper` on `@reif` |

---

## Rules that follow

1. **An unreadable meter never stops work.** It reports `tier=full` with an `error` tag. Loud
   about the failure, never halting on it.
2. **An HTTP status is never a network failure.** `maxx_http_403` is something you can fix in
   minutes; `maxx_unreachable` is not. Collapsing them costs you the difference.
3. **An unknown account is not an empty one.** It sorts last in every ranking.
4. **Only Anthropic's windows deny.** Everything maxx computes is advice.
5. **A read never waits.** Stale-and-instant beats fresh-and-slow for a counter, every time.

## Per-user isolation

State is one document per handle; secrets live in a separate auth doc. Writes require that
handle's own secret, and a signed-up user's secret takes precedence over any shared operator
secret — the operator cannot read a signed-up user's data with `MAXX_SECRET`. Unclaimed handles
reject writes on any public deploy (`allowUnconfigured: false`, the default in both entrypoints;
set `MAXX_OPEN=1` for localhost dev).

**One thing to know:** `GET /api/u/:handle/budget` answers unauthenticated callers with an
anonymized magnitudes view — that's the shareable dash. Project names, session ids, and
directive text never leave without the secret, but *how much a handle burned this week* is
public by design.
