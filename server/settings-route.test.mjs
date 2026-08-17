// The settings routes. Two things here are easy to get quietly wrong, so both are pinned:
// the auth boundary (settings are policy, not a public magnitude) and the memo bust (the
// budget payload is cached, so a saved setting that the payload ignores looks like a no-op).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { emptyStore } from "./tally.mjs";
import { DEFAULTS } from "./settings.mjs";

const T = 1_800_000_000;
const SECRET = "s3cret-owner-token";

function harness({ now = () => T } = {}) {
  const docs = new Map();
  const store = {
    async load(h) { return docs.get(h) || emptyStore(); },
    async save(h, s) { docs.set(h, s); },
  };
  return { docs, h: createHandler({ store, secretFor: () => SECRET, now }) };
}
const auth = { authorization: `Bearer ${SECRET}` };
const parse = (res) => JSON.parse(res.body);

test("GET settings returns the resolved knobs and the defaults beside them", async () => {
  const { h } = harness();
  const res = await h({ method: "GET", url: "/api/u/x/settings", headers: auth });
  assert.equal(res.status, 200);
  const b = parse(res);
  assert.equal(b.settings.weekly_max, 0.925);
  assert.equal(b.settings.account_strategy, "round_robin");
  // The pane needs the defaults to render a "reset to default" affordance without hardcoding
  // a second copy that drifts from the server's.
  assert.deepEqual(b.defaults, DEFAULTS);
});

test("settings are OWNER-ONLY, unlike the public budget read", async () => {
  const { h } = harness();
  for (const method of ["GET", "PUT"]) {
    const res = await h({ method, url: "/api/u/x/settings", headers: {}, body: "{}" });
    assert.equal(res.status, 401, `${method} settings must not be public`);
  }
  // ...while /budget stays publicly readable, which is the distinction being drawn: a
  // magnitude can be shared anonymously, an operator's own policy has no reason to be.
  const pub = await h({ method: "GET", url: "/api/u/x/budget", headers: {} });
  assert.equal(pub.status, 200);
});

test("PUT merges over stored config, so a pane can send one field", async () => {
  const { h } = harness();
  await h({ method: "PUT", url: "/api/u/x/settings", headers: auth,
            body: JSON.stringify({ weekly_max: 0.8 }) });
  await h({ method: "PUT", url: "/api/u/x/settings", headers: auth,
            body: JSON.stringify({ account_strategy: "exhaustion" }) });
  const b = parse(await h({ method: "GET", url: "/api/u/x/settings", headers: auth }));
  assert.equal(b.settings.weekly_max, 0.8, "the earlier field must survive the second write");
  assert.equal(b.settings.account_strategy, "exhaustion");
});

test("an invalid value is rejected AND never persisted", async () => {
  const { h, docs } = harness();
  const res = await h({ method: "PUT", url: "/api/u/x/settings", headers: auth,
                        body: JSON.stringify({ weekly_max: "none", per_diem_use: 0.5 }) });
  const b = parse(res);
  assert.equal(b.settings.weekly_max, DEFAULTS.weekly_max, "must not read as 'no ceiling'");
  assert.equal(b.settings.per_diem_use, 0.5, "the valid field in the same PUT still lands");
  assert.equal(b.rejected.length, 1);
  assert.equal(b.rejected[0].key, "weekly_max");
  // The store must not hold a config that reads back as something else.
  assert.equal(docs.get("x").config.weekly_max, DEFAULTS.weekly_max);
});

test("saving a setting takes effect on the NEXT budget read, not after the memo ages out", async () => {
  // The budget payload is memoised per (handle, generation), so a saved setting the payload
  // keeps serving from a stale memo would look saved and do nothing -- the exact failure a
  // settings pane exists to avoid.
  //
  // The invalidation lives in the wrapped store (`save:` does bump + budgetMemo.delete on
  // every write), NOT in the settings route. That is worth pinning here rather than trusting:
  // this test is what catches someone making the settings write bypass the wrapped store --
  // e.g. calling rawStore.save directly -- which would reintroduce the stale read silently.
  let clock = T;
  const { h } = harness({ now: () => clock });
  const before = parse(await h({ method: "GET", url: "/api/u/x/budget", headers: auth }));
  assert.equal(before.settings.weekly_max, 0.925);

  await h({ method: "PUT", url: "/api/u/x/settings", headers: auth,
            body: JSON.stringify({ weekly_max: 0.5 }) });

  clock = T + 1;   // a later second, but the SAME generation would still serve the old memo
  const after = parse(await h({ method: "GET", url: "/api/u/x/budget", headers: auth }));
  assert.equal(after.settings.weekly_max, 0.5, "the new ceiling must be live immediately");
});

test("a stricter ceiling immediately changes the per-diem the payload advertises", async () => {
  // End to end: the knob is not decoration, it moves the number every consumer paces against.
  let clock = T;
  const { h } = harness({ now: () => clock });
  await h({ method: "POST", url: "/api/u/x/logs", headers: auth, body: JSON.stringify({
    surface: "laptop", sessions: [{ session: "a", billed: 1_000_000 }],
    anchor: { week_pct: 0.5, five_pct: 0.1, week_reset: T + 4 * 86400, five_reset: T + 3600 },
  }) });

  clock = T + 1;
  const loose = parse(await h({ method: "GET", url: "/api/u/x/budget", headers: auth }));
  assert.equal(loose.per_diem_pct, 10.625, "(0.925-0.5)/4 days");

  await h({ method: "PUT", url: "/api/u/x/settings", headers: auth,
            body: JSON.stringify({ weekly_max: 0.6 }) });
  clock = T + 2;
  const tight = parse(await h({ method: "GET", url: "/api/u/x/budget", headers: auth }));
  assert.equal(tight.per_diem_pct, 2.5, "(0.6-0.5)/4 days");
  assert.equal(tight.over_per_diem, false);
  assert.equal(tight.verdict, loose.verdict, "a settings change must never move the verdict");
});

test("a bad body is a 400, not a 500 or a silent default-write", async () => {
  const { h, docs } = harness();
  for (const body of ["{oops", "[1,2]", '"a string"']) {
    const res = await h({ method: "PUT", url: "/api/u/x/settings", headers: auth, body });
    assert.equal(res.status, 400, `body ${body} should be rejected`);
  }
  assert.equal(docs.has("x"), false, "a rejected write must not create a config doc");
});
