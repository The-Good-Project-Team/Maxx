# maxx centralized budget — wire contract

Subscription budget (5h + weekly %) is observable **only** from an interactive
Claude Code client (the laptop statusline's `rate_limits`). Cloud routines can't
read `/usage` at all. So we don't ship the *percentage* from every surface — we
ship the *raw token counts* every surface can see, tally them centrally, and
**anchor** the tally to the authoritative % whenever an interactive session
observes one. See [[maxx-cloud-cannot-self-derive-budget]].

Two producers, one store, one reader:

```
 laptop/on-box ──emit.mjs──┐
                           ├──▶  meetmaxx.co  ──(tally + windows + anchor)──▶  /budget  ──▶ gate
 cloud routines ──MCP──────┘        (keyed by user handle)
```

- **Laptop** ships via `maxx/emit.mjs` (exact usage from `~/.claude/projects/**`).
- **Cloud** ships via the **account-wide `maxx` MCP connector** — NOT a repo skill
  (a skill only exists in routines that clone that repo; a connector is attached
  once to the claude.ai account and available to every session). The connector
  exposes `maxx_emit` + `maxx_budget`, talking this same contract.

**Privacy invariant:** only token/usage **metadata** ever leaves a surface —
counts, timestamps, model family, session title/branch. Never prompt or message
content. The emitter enforces this by construction (it reads only `usage` blocks).

---

## 1. Emit — `POST /api/u/{handle}/logs`

`Authorization: Bearer {secret}` · body:

```jsonc
{
  "v": 1,
  "surface": "laptop:3b1cc3c3" | "dino:tgp" | "cloud:<routine-or-session>",   // MAXX_SURFACE overrides; MAXX_HOST pins the install stamp inside a container
  "install_id": "<uuid or env id>",
  "handle": "reif",
  "emitted_at": "<ISO>",
  "since": "<ISO|null>",                 // cursor lower bound this batch covers
  "cursor": "<opaque str>",              // server dedupes on (surface, cursor)
  "totals": { "billed": int, "output": int, "sessions": int },
  "sessions": [
    {
      "root": "<uuid>", "project": "nonprofit-atlas",
      "name": "<title>", "branch": "<git>", "cc_version": "<claude-code ver|null>",
      "billed": int,                     // QUOTA-WEIGHTED (limit.mjs formula) — matches the statusline
      "output": int, "turns": int,
      "by_model": { "Opus": int, "Sonnet": int, "Haiku": int, "Fable": int, "other": int },
      "input": int, "cache_read": int, "cache_write": int,   // raw usage split (cache-hit analytics)
      "raw": int,                        // unweighted input+output+cache_creation+cache_read
      "tool_calls": int,                 // count of tool_use blocks (types only, never args)
      "agent_turns": int,                // turns from subagent sidechains
      "first_ts": "<ISO>", "last_ts": "<ISO>"
    }
  ],
  "anchor": null | {                     // only when an interactive session saw one, fresh <30m
    "five_pct": 0..1, "week_pct": 0..1,  // authoritative subscription utilization
    "five_reset": <epoch>, "week_reset": <epoch>,
    "observed_at": "<ISO>"
  }
}
```

Response: `{ "ok": true, "accepted": int, "deduped": int }`. The emitter advances
its cursor only on a 2xx.

**Backfill vs delta:** the first emit (no cursor) ships **all history** — a one-time
bulk load so the server has complete ground truth to reconstruct usage over time and
true-up cap estimates against every past anchor. Every run after streams only the
delta past the cursor.

**Idempotency:** the server keys stored batches by `(handle, surface, cursor, root)`
so a re-sent batch (cursor not advanced after a failed send) is a no-op. Windows are
reconstructed from each session-delta's `last_ts`, not from arrival time — so old
backfill records fall outside the live 5h/weekly windows and never distort live
budget; they're retained purely for anchor true-up. Proven on-box: a full envelope
through `server/tally.mjs` reproduces the anchor's weekly % exactly.

---

## 2. Tally + anchor (server side)

- **Rolling 5h:** sum `billed` where `last_ts > now − 5h`, across all surfaces.
- **Weekly:** sum `billed` where `last_ts > week_reset − 7d` (fixed window).
- **Cap calibration (the anchor):** at each `anchor`, `cap = summed_tokens ÷ pct`.
  Between anchors, hold the last cap and extrapolate `pct = summed ÷ cap`.
- **Weighting:** the server may weight `by_model` (Opus drains the quota faster
  than Haiku) — mirror `limit.mjs`'s weights; raw counts are sent so the weighting
  policy lives in one place.

**Exact vs estimated (state this honestly to the gate):** token *tally* is exact
and omni-surface; *% of wall* is fresh only to the last anchor and drifts between
them. Still strictly better than the laptop-only signal, which is simply absent
when the laptop sleeps.

---

## 3. Read — `GET /api/u/{handle}/budget`

`Authorization: Bearer {secret}` · returns the shape the gate already consumes
(compatible with the board's `signals.budget`):

```jsonc
{
  // PERCENTAGES ONLY — no token count is published. Anthropic's reading is the one
  // number that is not an estimate, so everything is expressed against it.
  "usage_week_pct": 0..1, "usage_five_pct": 0..1,   // their real utilization, null unanchored
  "usage_week_live": bool, "usage_five_live": bool, // is the anchored window still current
  "five_reset": <epoch>, "week_reset": <epoch>,
  "block_share_pct": float, "block_used_pct": float, "on_pace": bool,
  "blocks_left_week": int,
  "week_elapsed_pct": float, "week_bank_pct": float,        // clock vs spend, + = ahead
  "burn_pct_per_hour": float, "sustainable_pct_per_hour": float,
  "projected_wall_at": <epoch>|null,
  "reserved_pct": float, "leases": int,
  "verdict": "ok" | "degraded" | "over" | "stale" | "calibrating",
  "fresh": bool,                         // anchor within trust window
  "anchor_age_sec": int, "stored_at": "<ISO>",
  // the odometer — proof every surface is counted. NOT a budget reading.
  "lifetime_billed": int, "burn_5m": int,
  "surfaces":    [ { "surface": "...", "week_pct": float, "five_pct": float } ],
  "top_burners": [ { "surface": "...", "session": "...", "project": "...", "name": "...",
                     "week_pct": float, "five_pct": float,
                     "cost_index": float } ]   // tokens/action vs this account's median
}
```

`verdict: "stale"` when `anchor_age_sec` exceeds the trust window — the gate then
decides fail-closed vs conservative-floor (a spend-risk policy call, not the
server's).

---

## 4. Cloud MCP connector — tool mirror

The account-wide `maxx` connector exposes the same two operations as tools any
routine can call (no repo skill needed):

- `maxx_emit({ sessions, anchor? })` → same as §1. A cloud routine self-reports the
  output tokens it generated this run (it can count its own turns; it cannot read
  `/usage`, so `anchor` is almost always null from cloud).
- `maxx_budget()` → same as §3. The routine's budget gate reads this instead of
  curling the laptop-fed dashboard.

The connector server IS the tally store — emit, read, and storage in one hosted
endpoint, keyed by handle.

---

## Config (`~/.maxx/config.json`)

Reuses the fields the pre-teardown pusher already had: `handle` (userid),
`secret` (bearer), `installId` (surface id), plus `logsUrl` (base, default
`https://meetmaxx.co`). Cursor in `~/.maxx/emit-cursor.json`.
