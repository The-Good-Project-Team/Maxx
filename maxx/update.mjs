/**
 * Self-update decision — pulled out of emit.mjs so it's importable without executing the
 * whole CLI script (emit.mjs runs top-level side effects on load; this file has none).
 *
 * "dev" is install.sh --link's sentinel for a live dev checkout that IS the source of truth —
 * never overwrite a developer's own edits out from under them. "unknown" means no signal on
 * that side (a build/install that couldn't resolve a sha) — treated the same way: nothing to
 * compare against, so stay quiet rather than guess.
 */
export function shouldUpdate(mine, serverSha) {
  if (!mine || mine === "dev" || mine === "unknown") return false;
  if (!serverSha || serverSha === "unknown") return false;
  return serverSha !== mine;
}
