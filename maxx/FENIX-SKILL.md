---
name: fenix
description: "Burn down, rise with context — write a handoff of what's in motion, clear the session, resume the thread in the next one. Use when the user types /fenix, says 'fenix', or wants to clear context without losing the thread (high ctx%, context bloat, fresh start)."
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

0. **Run `node ~/.claude/skills/maxx/fenix.mjs --state` and paste its output into the
   handoff verbatim.** It prints branch, HEAD, uncommitted files, UNPUSHED commits, what
   landed in the last 6h, and open PRs — read from git and gh, not from your memory. It
   also resurfaces the LAST handoff's "In motion" so you must say what happened to it.

   Why this is step zero: you are writing at 70-90% context, which is the worst moment
   for recall, about facts a command knows exactly. Measured over 98 real handoffs, only
   ~35% carried the sections below and 13% pasted any command output — the rest was
   remembered prose, and a misremembered SHA is worse than no SHA. Spend your words on
   the part no tool can produce: WHY, what is next, and which traps cost you time.

1. **Write `.fenix/handoff.md` — in ONE Write call.** The Write tool creates
   the directory itself: no separate mkdir, no preamble commands, nothing else before the
   save. A fenix run can die mid-turn (token wall, /clear arriving early) — observed
   in the wild: an empty `.fenix/` dir and a lost thread. The handoff IS the mission;
   land it before anything else. (Then, if a repo: add `.fenix/` to `.gitignore`.)
   Be concrete — the next session has NONE of your context. Sections:

   ```markdown
   # fenix handoff — <one-line mission>
   Written: <ISO time> · by session: <what this session was doing>

   > Do NOT paste branch / HEAD / dirty files / unpushed / open PRs into the handoff.
   > The wake injection computes them FRESH at read time (the micro-compact block), so a
   > handoff written an hour ago cannot assert a PR that has since merged. Facts written
   > here go stale; facts read at wake cannot. Spend your words on WHY, decisions and traps.

   ## Carried forward
   - <what the LAST handoff asked for: done / still in motion / dropped because X>
     (--state prints it; an item that silently disappears between generations is the
      exact failure this mechanism exists to stop)

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

3. **Hand back.** Say exactly:

   `handoff written → .fenix/handoff.md · <id> · hit /clear, then send anything ("go") — it picks up from there.`

   Then **END YOUR TURN**. The handoff stays live for a grace window (default 20m,
   `MAXX_WAKE_GRACE_MIN`) and is delivered to EVERY session started inside it, so a
   `/clear` you walk away from no longer burns the thread; it archives once the window
   passes.

   **Never promise that `/clear` "resumes automatically."** It resumes on the next
   keystroke. A SessionStart hook can only ADD CONTEXT — it cannot make a model take a
   turn, and it cannot trigger `/clear` either (hooks talk through stdout/stderr/exit
   codes only; they cannot invoke slash commands). Verified: a `/clear` at 16:48
   injected the handoff correctly, then sat at zero assistant turns until abandoned.

   **`--rise` was REMOVED (2026-08-27, Reif: "stop the whole rise thing — it doesn't
   work, remove it").** It spawned a detached headless continuation and was the default
   for two weeks. It never once produced a second generation: zero of six rise attempts
   on this machine reached generation 2, and `.fenix/generation` still read `{"gen":1}`
   after weeks. Two separate root causes were found and fixed (missing `--allowedTools`,
   then a shattered flag string) and the chain still did not sustain. Do not reintroduce
   it; a test asserts it stays gone. If you want unattended continuation, run the
   headless command yourself and watch it: `claude -p "$(cat .fenix/handoff.md)"`.

4. Do NOT delete or edit the handoff after writing it — `fenix.mjs --wake` consumes
   it on next session start. `node ~/.claude/skills/maxx/fenix.mjs --status` shows
   every pending handoff ON THE WHOLE BOX with its id and directory; `--local` narrows
   it to here.

   **Lookups are global; the handoff itself stays per-directory.** A session must wake
   into its OWN thread, so `--wake` is cwd-scoped and always will be. But `--status` and
   `--recover` search every fenix site (registry at `~/.claude/maxx/fenix-index.json`,
   plus a scan — `MAXX_FENIX_ROOTS` overrides). This was a real failure, not a nicety:
   cwd-scoped lookups reported `pending handoff: none` from one directory over while
   `fx-fleet-kit-20260827-0045-472fd7a4` sat alive on disk, and `--recover` denied an id
   that literally names its own repo. The thread was declared lost while intact.

5. **Every handoff has an ID** — `fx-<session>-<YYYYMMDD-HHMM>-<hash8>`, a hash over the
   claude session id, the timestamp and the session name. Report it when you hand back, so
   the human can name the thread they are resuming:

   ```
   node ~/.claude/skills/maxx/fenix.mjs --status              # EVERY pending handoff on the box
   node ~/.claude/skills/maxx/fenix.mjs --status --local      # just this directory, + its id
   node ~/.claude/skills/maxx/fenix.mjs --recover <id>        # print that handoff, from ANY directory
   node ~/.claude/skills/maxx/fenix.mjs --compact [--list]    # manual prune (rarely needed)
   ```

   **Pruning is automatic** — every archive event trims the tail it just extended, so the
   archive is bounded by construction (keeps 20; `MAXX_FENIX_KEEP` overrides). `--compact`
   is only for changing the window or inspecting it with `--list`.

   Why an ID exists at all: a filename is the same nine bytes every generation, so "which
   handoff?" had no answer. This follows the checkpoint+write-ahead-log split every crash
   recovery system uses — recovery reads a small POINTER and resolves it, rather than
   scanning history. `--recover` is that resolution; the auto-prune on archive is the truncation that
   keeps recovery bounded (measured: 139 archived handoffs, 1.3MB, before it existed -- a
   manual command nobody runs is the same as no truncation at all).

## Fenix yourself — do not wait to be asked

`/fenix` is not only a command the human types. It is what you do when you are running
out of room, and you do it WITHOUT asking, the same way you would save a file.

Trigger it yourself on any of these:
- **a maxx directive says you are past the context wall** — that is the machine telling
  you directly, with numbers; do not ask whether it means it;
- ctx ≥70% on the statusline;
- your turn is ending with work still in motion;
- a long task is about to start that deserves a clean context.

Then run the sequence: write the handoff, report the id, end your turn. WRITING the
handoff needs no permission — it is a save, not a decision. What follows is Reif's
keystroke, and that is the honest shape of it: fenix preserves the thread, it does not
continue the work by itself.
