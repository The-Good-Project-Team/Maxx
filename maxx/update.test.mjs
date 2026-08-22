// Self-update decision: emit.mjs --watch compares its own stamped install_sha against the
// server's GET /api/version and reinstalls on a mismatch. Wrong on either side is expensive —
// too eager overwrites a developer's live checkout out from under them; too quiet leaves a
// fleet of laptops running a stale CLI against a server that has moved on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUpdate } from "./update.mjs";

test("a real mismatch says update", () => {
  assert.equal(shouldUpdate("abc123", "def456"), true);
});

test("a matching sha is a no-op", () => {
  assert.equal(shouldUpdate("abc123", "abc123"), false);
});

test("\"dev\" (install.sh --link's live-checkout sentinel) never triggers an update", () => {
  // 2026-08-21: --link mode stamps "dev" instead of a real sha because the source dir IS the
  // live checkout — re-reading its sha later would always read "current", and a developer's
  // own uncommitted edits must never be silently overwritten by a reinstall.
  assert.equal(shouldUpdate("dev", "def456"), false, "a dev checkout must never be reinstalled over");
});

test("\"unknown\" on either side means no signal to compare — stays quiet", () => {
  assert.equal(shouldUpdate("unknown", "def456"), false, "no local sha to compare from");
  assert.equal(shouldUpdate("abc123", "unknown"), false, "server couldn't resolve its own sha");
});

test("a missing local install_sha (pre-update-feature install) is treated as nothing to compare", () => {
  assert.equal(shouldUpdate(undefined, "def456"), false);
  assert.equal(shouldUpdate(null, "def456"), false);
  assert.equal(shouldUpdate("", "def456"), false);
});

test("a missing/failed server response is treated as nothing to compare", () => {
  assert.equal(shouldUpdate("abc123", undefined), false);
  assert.equal(shouldUpdate("abc123", null), false);
  assert.equal(shouldUpdate("abc123", ""), false);
});
