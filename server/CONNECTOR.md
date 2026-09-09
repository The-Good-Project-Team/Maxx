# Maxx connector — deploy + wire-up

## Self-serve — anyone can use the hosted server

One account = one **handle** + one **secret**, minted once at signup (first come,
first served). Everything is per-handle: your own tally, budget, feed, and the
budget-gate rules ship automatically to every agent that carries your connector.
Every Claude account keeps its own timeline — there is no global one.

Three ways to sign up (all hit `POST /api/signup`):
- **Web:** meetmaxx.co → "Track every machine & cloud session" → claim a handle,
  the connector URL is shown once in the browser.
- **Zero-input CLI:** `node ~/.claude/skills/maxx/emit.mjs --signup` (no handle)
  derives the handle from the signed-in Claude login and binds the account uuid.
- **Named CLI:** `--signup <handle>` as below.

```bash
# 1. install the statusline + skill (also places emit.mjs/watch.mjs)
curl -fsSL https://raw.githubusercontent.com/The-Good-Project-Team/Maxx/main/maxx/install.sh | bash

# 2. claim your handle (writes ~/.maxx/config.json, prints your connector URL)
node ~/.claude/skills/maxx/emit.mjs --signup <your-handle>

# 3. live-ship this machine's usage at login (launchd on macOS)
node ~/.claude/skills/maxx/emit.mjs --install-agent
```

Then add the printed URL as a custom connector (claude.ai → Settings →
Connectors → Add custom connector, name `Maxx`):
`https://api.meetmaxx.co/mcp?handle=<you>&k=<secret>`. Any agent (cloud routine,
claude.ai chat, another machine) with that connector gets the budget-gate
`instructions` on initialize and can call `maxx_emit` / `maxx_budget` against
**your** account only.

Your own eyes: `node ~/.claude/skills/maxx/watch.mjs` (live dashboard) ·
`tail -f ~/.maxx/emit.log` (shipper log) ·
`GET /api/u/<you>/feed?n=50` (server-side event feed; owner max 10,000, public max 200).

### The four verdicts (the contract every agent gates on)

`maxx_budget` returns one of four verdicts. The server owns this policy — agents
read it, they do not re-derive their own staleness tolerance, and a routine prompt
should never hand-roll a fifth rule.

| verdict | what it means | what an agent should do |
|---|---|---|
| `ok` | fresh /usage anchor, under every wall | proceed; pace against `block_share_pct` vs `block_used_pct` |
| `degraded` | no machine has read /usage in the last 45m, but the weekly standing is still live from the server's own billed ledger | **proceed** on the weekly numbers (`usage_week_pct`, `block_share_pct`); ignore the 5h-window fields; re-check more often |
| `over` | a wall is hit (weekly ≥99%, 5h ≥99%, or nothing left after reserves) | stop; `tokens_again` says when it lifts |
| `stale` | genuinely blind — no anchor at all, or one over 12h old | stop |

**Why `degraded` exists.** Only a real Claude surface can read `/usage`, so the
anchor comes from an interactive Claude Code session's statusline. When every
linked machine is asleep the anchor ages — and before `degraded` existed, that
flipped the account to `stale` and hard-blocked every cloud routine, including the
ones whose burn report would have refreshed the tally. Self-reinforcing.

But the anchor only *calibrates* caps against Anthropic's percentages, and those
caps move on a 7-day window — hours-old calibration still prices the weekly tank
correctly, and the server holds the full billed ledger from every surface either
way. So an aged anchor degrades to weekly-only instead of blinding the account.

**A cloud agent cannot clear `stale` by calling `maxx_emit`.** Emit ships event
counts; anchors come from `/usage`, which cloud has no access to (that is why the
`maxx_emit` schema says to leave `anchor` unset). Any "re-emit to re-anchor, then
re-read" retry loop is a no-op that logs a self-heal which did not happen. To
re-anchor, open a Claude Code session on any linked machine.

### The hard gate (PreToolUse deny)

The connector's `instructions` are advisory. install.sh also wires the HARD gate:
a PreToolUse hook (`gate.mjs`) that DENIES expensive spawns (Agent / Task /
Workflow / ScheduleWakeup / CronCreate) when the tally says `over`/`stale`/
a spent block share. Fail-closed: no fresh verdict = deny. Cloud routines honor
repo `.claude/settings.json` hooks, so to enforce in cloud add to the repo:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Agent|Task|Workflow",
  "hooks": [{ "type": "command", "command": "node maxx/gate.mjs", "timeout": 10 }] } ] } }
```

Toggle at agent level — any session's user can overturn, but it's RECORDED
(local `~/.maxx/gate.log` + a `⚠ GATE OVERTURNED` event in the central feed):

```bash
node ~/.claude/skills/maxx/gate.mjs --status
node ~/.claude/skills/maxx/gate.mjs --overturn "shipping a prod hotfix"   # off, noted
node ~/.claude/skills/maxx/gate.mjs --on                                  # re-enable, noted
```

The secret is shown once at signup and stored only in `~/.maxx/config.json` —
treat it like a password (it's a rotatable metadata token; no content ever
leaves the machine, only token counts). Signup endpoint: `POST /api/signup
{"handle":"you"}`.

## LIVE NOW — api.meetmaxx.co (CF-direct) on lucky (hardware)

Routing: `api.meetmaxx.co → Cloudflare (proxied) → lucky named tunnel → server`.
No Netlify in the API path (confirmed by `cf-ray` header). meetmaxx.co (Netlify,
`site/`) serves the **landing page only** — `/mcp` there is 404 by design.

- **Connector URL: `https://api.meetmaxx.co/mcp?handle=reif_tgp`** (Bearer). One
  handle per Claude ACCOUNT — every account has its own timeline, there is no
  global one. `reif` = the reiftauati@gmail.com account (live again since
  2026-07-22); `reif_tgp` = the reif@thegoodproject.net account (active since
  2026-07-20). The laptop's account ledger (`~/.maxx/accounts.json`, maintained
  by `limit.mjs`) marks which account owns which slice of the local logs.
- **Login cutover (2026-07-22):** the shipper routes per ACCOUNT. `~/.maxx/config.json`
  holds `accounts: { <claude-account-uuid>: {handle, secret} }`; emit scans every
  login root (`~/.claude` plus each `~/.claude-*` CLAUDE_CONFIG_DIR) and ships each
  root's burn to the handle of the account that root is signed into. An account with
  no mapped handle is SKIPPED loudly, never poured into another timeline. Anchors
  are per account too: render stamps the observer's uuid into `rl.json`/`status.json`
  and emit only attaches an anchor to its own account's envelope. Still single-account:
  `gate-cache.json`/statusline net (follows the default `~/.claude` login only).
- **CF DNS:** proxied CNAME `api.meetmaxx.co` → `51665939-…​.cfargotunnel.com` in the
  meetmaxx.co zone (needs a CF token with Zone:DNS:Edit on meetmaxx.co — lucky's
  tunnel cert only covers luckymachines.co).
- **lucky tunnel ingress** (`~/.cloudflared/config.yml`): `api.meetmaxx.co →
  http://127.0.0.1:8791`, before the 404 catch-all. Reload with SIGHUP to the
  `cloudflared tunnel run lucky` process (`config.yml.bak-premaxx` is the backup).

Behind the tunnel — the server itself:

- **Server:** `node server/serve.mjs --port 8791` as lucky job (queue:false daemon),
  cwd `/home/agent/maxxbudget` (shallow clone of the `maxx-budget` branch),
  state `/home/agent/maxxbudget-state`, `MAXX_SECRET` from `…-state/.secret`.
- **Reverse proxy:** `site_deploy name=maxxbudget target=8791` — the `/maxxbudget`
  prefix is stripped before the upstream, so routes are clean.
- **Public base:** `https://luckymachines.co/maxxbudget`
  - MCP connector URL: `https://luckymachines.co/maxxbudget/mcp?handle=reif`
  - emit / budget: `…/maxxbudget/api/u/reif/{logs,budget}`
- **Laptop:** `~/.maxx/config.json` → `logsUrl=https://luckymachines.co/maxxbudget`,
  matching `secret`. Continuous ship via launchd agent `co.meetmaxx.emit`
  (`emit.mjs --watch`, logs `~/.maxx/emit.log`).
- **Redeploy after a code change (current, 2026-09):** the server is the `maxx` podman
  container on the **dino** box (`ssh dino`), built from `~/Classified/dino/maxx/`
  (docker-compose.yml + Containerfile, context `../../Maxx`, tracks `main`). Push main, then:
  `ssh dino 'export PATH=$HOME/.local/bin:$PATH; cd ~/Classified/Maxx && git pull --ff-only origin main; cd ~/Classified/dino/maxx; export MAXX_GIT_SHA=$(git -C ../../Maxx rev-parse HEAD); podman-compose build && podman-compose down && podman-compose up -d'`
  then `curl -s https://api.meetmaxx.co/api/version` must equal the pushed SHA. The
  lucky `maxx-tally` systemd recipe around this line is dead: do not look on lucky.
- **Durable:** systemd user unit `maxx-tally.service` supervises the server
  (auto-restarts, survives reboot) — do NOT kill the pid or start a lucky job
  for it; the unit respawns in seconds and a second copy just hits EADDRINUSE.
  Secret is a rotatable metadata token.

---


The account-wide **Maxx** connector is how every Claude Code cloud routine reports
its token burn to the central tally (and reads budget back). It's a standard
custom MCP connector added through Claude's official connector setup — one MCP
endpoint that also serves the laptop's REST emit. Both talk the [LOGS.md](../maxx/LOGS.md)
contract to one per-handle store.

Why a connector and not a repo skill: a skill only exists in routines that clone
that repo; a connector is attached once to your claude.ai account and reaches
**every** session you enable it on, regardless of repo. It must include the cloud
routines or their burn is invisible — and a missing surface biases the tally
optimistically (see [[maxx-cloud-cannot-self-derive-budget]]).

## 1. Deploy the server (meetmaxx.co, Netlify)

The server is transport-agnostic; the Netlify wrapper is `server/netlify-fn.mjs`.

1. Place `server/netlify-fn.mjs` in the site's functions dir (e.g.
   `netlify/functions/maxx.mjs`) with `handler.mjs` / `tally.mjs` / `store.mjs`
   reachable by its imports; ensure `@netlify/blobs` is available.
2. Set env in Netlify: `MAXX_SECRET` (shared bearer) or `MAXX_SECRET_<HANDLE>`
   (per user, e.g. `MAXX_SECRET_REIF`). This must match the `secret` in the
   laptop's `~/.maxx/config.json`.
3. Deploy (manual, per project convention): `netlify deploy --prod --dir site …`.
4. Verify: `curl https://meetmaxx.co/health` → `{"ok":true,"service":"maxx-tally"}`.

Endpoints once live:
- `POST /api/u/{handle}/logs` · `GET /api/u/{handle}/budget` (laptop emit)
- `POST /mcp` (the connector; Streamable HTTP / JSON-RPC 2.0)

## 2. Add the official connector in Claude

claude.ai → **Settings → Connectors → Add custom connector**:
- **Name:** `Maxx`
- **URL:** `https://meetmaxx.co/mcp?handle=<yourhandle>` (the `handle` query pins
  the budget owner; alternatively pass `handle` in each tool call's arguments)
- **Auth:** Bearer — the same secret as the server env / laptop config.

It exposes four tools:
- `maxx_emit({ surface, sessions[], anchor? })` — report usage metadata (counts
  only). Cloud routines leave `anchor` unset (they can't read /usage).
- `maxx_budget()` — read the omni-surface budget to gate spend.
- `maxx_reserve({ tokens, ttl_sec?, label?, lease_id? })` — hold part of
  a PERCENT of the week before a fan-out so concurrent dispatchers can't
  double-spend the same allowance. Pass your own `lease_id` to renew/resize
  (replaces the lease instead of stacking). Leases auto-expire at `ttl_sec`
  (default 1h, max 6h).
- `maxx_release({ lease_id })` — give the hold back when the fan-out lands or is
  cancelled. The spend is already in the tally via `maxx_emit`; an unreleased
  lease keeps throttling every other dispatcher until its TTL.

## 3. Enable it on the routines + gate on it

For each cloud routine (claude.ai/code/routines → the routine → connectors),
include **Maxx**, and update the routine prompt:

- **Report burn** (so the tally is complete): near the end of the run, and at
  checkpoints in a long run, call `maxx_emit` with `surface:"cloud:<routine>"` and
  a `sessions` entry carrying the output tokens generated this run (best-effort;
  the anchor trues it up). This is the live-stream from cloud.
- **Gate on the central budget** instead of the laptop-fed dashboard: replace the
  `curl …/api/pm/board … signals.budget` gate with a `maxx_budget()` call, and
  apply the same FAIL-CLOSED rule on `verdict` in `("over","stale")` /
  a spent block share.

## 4. Keep the laptop shipping (the anchor source)

The laptop is the only surface that carries the authoritative `/usage` anchor.
Keep it streaming:
- one-shot: `node maxx/emit.mjs --send` (cron/launchd every few minutes), or
- live: `node maxx/emit.mjs --watch` (tails `.jsonl` appends, ships each turn as
  it lands during a running session).

Config in `~/.maxx/config.json`: `handle`, `secret`, `installId`, `logsUrl`
(default `https://meetmaxx.co`). Cursor in `~/.maxx/emit-cursor.json`.
