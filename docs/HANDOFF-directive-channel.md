# Handoff: build the directive channel (fleet command plane)

> **DONE 2026-07-19** (commit d4fe2a1, deployed to lucky, proven live: pause →
> gate deny on prod, resume lifts, clear → additionalContext, feed audited).
> Read semantics: GET consumes; `?peek=1` inspects without consuming. Open
> items 2–5 below still stand.

Written 2026-07-18 (session 90e767c1, ctx-fat, pre-/clear). Everything below is
deployed and verified unless marked TODO. Full system context: memory file
`maxx-central-budget-tally` (auto-loaded).

## The task

Close the coordination loop: orchestrator → specific agent commands, delivered
through the infrastructure that already exists. Design agreed with Reif:

- `POST /api/u/:h/directive {session, surface?, action, note?, ttl_sec?}` —
  queue a directive for one session (or `session:"*"` broadcast). Actions to
  support first: `clear` (advise /clear — inject as context), `pause`
  (deny expensive tools for this session until ttl/refill), `resume`.
- `GET /api/u/:h/directives?session=X` — agent-side read; consuming marks done.
- Delivery point = the EXISTING PreToolUse hook `maxx/gate.mjs` (installed
  laptop-wide, cloud honors repo `.claude/settings.json`). Hook stdin carries
  `session_id` — match against pending directives:
  - `pause` → permissionDecision deny with the directive's note
  - `clear` → hookSpecificOutput additionalContext injection ("orchestrator
    asks: /clear — your ctx is Xk ≈Yk/action") — or deny-with-message if
    additionalContext unsupported for PreToolUse; check hooks docs
- Store: per-handle store doc, add `directives: []` (tally.mjs emptyStore),
  prune consumed/expired like leases. Idempotent, ttl default 1h.
- MCP tool `maxx_directive` so cloud orchestrators (M) can send commands.
- Every directive + consumption = event in the feed (audit, like overturns).
- Tests: mirror issue18.test.mjs style (time-injected, pure tally fns) +
  integration curl. Then deploy (see Deploy below) and prove: send `pause` to a
  scratch session → its next Agent spawn denied with the note; `clear`
  directive surfaces in the target's context.

## Why (the vision, user's words)

Orchestrator tails the logs, sends specific messages to specific agents —
clear context, drain queue, throttle — "real time token optimization and
centralized coordination in a decentralized architecture." Sensing half is
DONE (feed/watch with per-session ctx + cost_per_action, webhooks, top_burners);
allocation DONE (maxx_reserve leases); enforcement DONE (gate.mjs). Command
channel is the last piece.

## Current live state (all verified today)

- Server: lucky, systemd `maxx-tally`, port 8791, state `/home/agent/maxxbudget-state`,
  behind CF tunnel at `https://api.meetmaxx.co`. Deploy: push branch `maxx-budget`
  (kept == main) → `mcp lucky run: cd /home/agent/maxxbudget && git pull -q origin
  maxx-budget && systemctl --user restart maxx-tally`.
- Budget signal v2 (issue #18 CLOSED with evidence): webhooks (over/refill/
  week-80/90/95/runaway, 30s sweep), top_burners, burn_5m/empties_at,
  maxx_reserve leases, lifetime_billed. 990 dash registered as webhook consumer
  (format dash).
- Gate: `maxx/gate.mjs` PreToolUse deny on Agent|Task|Workflow|ScheduleWakeup|
  CronCreate; policy knobs --mode paced|spree --margin --weekly-stop --fail;
  overturn recorded to feed. (Stale as of 2026-08-08: this said gate.mjs superseded
  spend-guard and that spend-guard was removed from settings. Both are registered on
  this matcher today and either can deny — see `docs/SESSION-MANAGEMENT.md`.)
- Emit: launchd `co.meetmaxx.emit` --watch; log lines carry per-session
  attribution + `ctx Xk ≈Yk/action` + pace line. Weekly matches statusline
  (0.45% structural floor).
- Multi-tenant self-serve: POST /api/signup, per-handle secrets (_auth.json),
  emit.mjs --signup/--install-agent. Connector attaches to NEW routines only;
  all 4 existing 990 routines patched by hand today (Maxx attached).
- Card: meetmaxx.co/u/reif (Stripe-verified style, 15.6B raw lifetime hero,
  all-time daily graph, availability rows). Static snapshot. Netlify site
  9d292916-b706-4e72-8078-73e672571c64, deploy `npx -y netlify-cli deploy
  --prod --dir site --site <id>` from repo root.

## Open items (ranked)

1. **Directive channel** (this handoff's task).
2. **scout-reply health-check burn**: `org.anthropic.scout-reply` launchd, every
   300s runs `claude -p "OK"` from `/` → new session each time, ~1.2M weighted/day,
   pollutes session counts ("? — <root> [HEAD]" in feed). Fix in
   nonprofit-atlas/scripts/mac/scout-reply.py: health-check via `claude --version`.
   Reif aware, approved implicitly ("say the word" pending).
3. **Card auto-rerender**: 15-min cron re-render from /budget + local scan.
4. **Routine prompts** still gate on board signals.budget (laptop-pushed via
   old path); should call maxx_budget + maxx_reserve directly. Needs prompt
   edits via RemoteTrigger update (IDs in memory/trigger list).
5. CF token `cfut_pRx1…` revocation (from memory, still outstanding).

## Gotchas learned today

- `wait` in test scripts catches background servers → hang. Kill by PID.
- Local ports 8799/8807 had stray listeners; use fresh high ports, pkill after.
- windowedBilled has +60s clock-skew slop — synthetic tests must place events
  >60s past the anchor or caps inflate.
- applyEnvelope dedup key = (surface|cursor|root): same-root chunks in ONE
  envelope dedup wrongly — distinct cursors per chunk if ever chunking backfill.
- store docs from before a field existed lack it — always `(s.field||[])`.
- prices.json weights override the fallback (Fable weighs ~5 live, not 10/3) —
  cost_per_action already uses modelWeight() correctly.
