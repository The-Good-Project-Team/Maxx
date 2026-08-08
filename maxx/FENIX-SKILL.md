---
name: fenix
description: "Burn down, rise with context — write a handoff of what's in motion, clear the session, auto-resume in the next one. Use when the user types /fenix, says 'fenix', or wants to clear context without losing the thread (high ctx%, context bloat, fresh start)."
trigger: /fenix
---

# /fenix — the maxx rebirth loop

(Subroute of maxx: `/maxx fenix` and `/fenix` are the same flow.)

Context is the scarcest resource after tokens. Fenix trades a bloated session for a
fresh one WITHOUT losing the thread: you write the handoff, the human clears, the
next session in this directory auto-inherits the handoff (a SessionStart hook injects
it, read=consume — it fires exactly once).

**Sequence is sacred: /fenix BEFORE /clear.** Fenix saves state, then you burn; it
cannot resurrect a thread that was cleared bare. Handoffs are PER-DIRECTORY
(`.fenix/handoff.md` in the cwd) — clearing in another project finds nothing there.

## What to do

1. **Write `.fenix/handoff.md` — FIRST, in ONE Write call.** The Write tool creates
   the directory itself: no separate mkdir, no preamble commands, nothing before the
   save. A fenix run can die mid-turn (token wall, /clear arriving early) — observed
   in the wild: an empty `.fenix/` dir and a lost thread. The handoff IS the mission;
   land it before anything else. (Then, if a repo: add `.fenix/` to `.gitignore`.)
   Be concrete — the next session has NONE of your context. Sections:

   ```markdown
   # fenix handoff — <one-line mission>
   Written: <ISO time> · branch: <git branch> · by session: <what this session was doing>

   ## In motion (do this first)
   - <the exact next action, with file:line / command / URL — resumable in one step>

   ## Just landed (verified)
   - <what shipped this session, with commit SHAs and PROOF (test output, curl, screenshot)>

   ## Decisions made (don't re-litigate)
   - <decision> — <why>

   ## Gotchas / traps discovered
   - <the things that cost time — exact error + fix>

   ## State of the world
   - deploys: <what's live where> · tests: <green?> · tree: <clean/dirty>
   ```

2. **Truth check** — every "Just landed" claim needs evidence you actually have.
   Unverified work goes under "In motion", never "landed".

3. **Hand back control.** Straight truth, twice over: `/clear` is a human keystroke — no
   model, hook, or tool can clear a session's own context. And a SessionStart hook can
   only ADD CONTEXT; it cannot make the model take a turn. So after `/clear` the handoff
   is loaded and waiting, but nothing moves until the human sends one message — any
   message. Never promise that it "resumes automatically"; it resumes on the next
   keystroke. (Verified: a `/clear` at 16:48 injected the handoff correctly, then sat at
   zero assistant turns until it was abandoned.) The handoff now stays live for a grace
   window (default 20m, `MAXX_WAKE_GRACE_MIN`) and is delivered to EVERY session started
   inside it, so a `/clear` you walk away from no longer burns the thread; it archives
   once the window passes. Two exits, pick by presence:
   - **Human present:** say exactly — `handoff written → .fenix/handoff.md · hit /clear,
     then send anything ("go") — it picks up from there.`
   - **Unattended / human says "rise":** run
     `node ~/.claude/skills/maxx/fenix.mjs --rise` — consumes the handoff and
     spawns a detached headless continuation (fresh process = fresh context; log
     in `.fenix/rise-<ts>.log`). Then END your turn — the continuation owns the
     work now; doing more here defeats the rebirth.

   `--rise` is a CHAIN, not a fork: every risen generation carries the standing
   order to fenix again when its context passes ~70% or it must stop mid-mission —
   so the loop sustains itself until `.fenix/DONE.md` appears. Brakes built in:
   generation cap (`.fenix/generation`, default 5, `MAXX_RISE_MAX_GEN` overrides) — counted per
   unit of work, not for the lifetime of the directory: the counter resets whenever `HEAD` moved
   since the last rise, so the cap only trips after 5 consecutive rises that landed no commit
   and the budget wall — at the 5h wall the rise self-schedules for right after
   the window refills (detached sleeper, no crontab). Child permission flags
   default to `--permission-mode acceptEdits`; `MAXX_RISE_FLAGS` overrides.

4. Do NOT delete or edit the handoff after writing it — `fenix.mjs --wake` consumes
   it on next session start. `node ~/.claude/skills/maxx/fenix.mjs --status` shows
   pending/consumed.

## When to suggest fenix proactively

ctx% high on the statusline (≥70%), the session is looping, or a long task is about
to start that deserves a clean context. One line: "ctx heavy — /fenix?"
