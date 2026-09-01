// Per-handle secret resolution from the environment — the exact mapping serve.mjs
// uses to turn a handle into its secret.
//
// WHY THIS FILE EXISTS: on 2026-08-31 a live deployment had MAXX_SECRET set (to
// one handle's secret, serving as the shared fallback) but no MAXX_SECRET_REIF.
// Every emit for the `reif` handle 401'd. The emitter, correctly, refuses to
// advance its cursor past a failed send — so it replayed one stale event for
// 64h, the server's anchor froze, and every budget number derived from it went
// garbage (week_used === week_cap, pinned at 100%, negative per-diem rates).
// Nothing failed loudly: /api/version kept returning 200 the whole time.
//
// The existing auth tests all inject `secretFor` directly, so none of them
// exercised this env-var lookup — the one line where the outage actually lived.
import { test } from "node:test";
import assert from "node:assert/strict";

// The resolver exactly as serve.mjs defines it (serve.mjs:45-46). Kept in sync by
// the shape assertions below rather than by importing serve.mjs, which starts a
// listening server on import.
const secretFor = (h) =>
  process.env[`MAXX_SECRET_${String(h).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] || null;

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("handle maps to MAXX_SECRET_<HANDLE>, uppercased", () => {
  withEnv({ MAXX_SECRET_REIF: "s3cret" }, () => {
    assert.equal(secretFor("reif"), "s3cret");
    assert.equal(secretFor("REIF"), "s3cret", "lookup is case-insensitive on the handle");
  });
});

test("non-alphanumerics in a handle become underscores", () => {
  // reif_tgp -> MAXX_SECRET_REIF_TGP; a hyphenated handle must land on the same
  // shape, or a deploy sets an env var nothing ever reads.
  withEnv({ MAXX_SECRET_REIF_TGP: "tgp-secret" }, () => {
    assert.equal(secretFor("reif_tgp"), "tgp-secret");
    assert.equal(secretFor("reif-tgp"), "tgp-secret");
    assert.equal(secretFor("reif.tgp"), "tgp-secret");
  });
});

test("a handle with no per-handle secret resolves to null, NOT to MAXX_SECRET", () => {
  // The regression. MAXX_SECRET is the fallback for UNCLAIMED handles only —
  // it must never satisfy a handle that has no per-handle secret of its own,
  // or one account's secret silently authenticates another's writes.
  withEnv({ MAXX_SECRET: "shared-fallback", MAXX_SECRET_REIF: undefined }, () => {
    assert.equal(secretFor("reif"), null,
      "missing MAXX_SECRET_REIF must resolve null — this is the 401 that wedged the emitter");
  });
});

test("one handle's secret does not authenticate another handle", () => {
  withEnv({ MAXX_SECRET_REIF: "a-secret", MAXX_SECRET_REIF_TGP: "b-secret" }, () => {
    assert.equal(secretFor("reif"), "a-secret");
    assert.equal(secretFor("reif_tgp"), "b-secret");
    assert.notEqual(secretFor("reif"), secretFor("reif_tgp"));
  });
});

test("empty-string secret is treated as unset", () => {
  // .env files routinely carry `MAXX_SECRET_FOO=` with no value. That must not
  // authenticate an empty bearer.
  withEnv({ MAXX_SECRET_FOO: "" }, () => {
    assert.equal(secretFor("foo"), null);
  });
});
