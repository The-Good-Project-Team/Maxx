// GET /api/version — what a client CLI compares its own stamped install_sha against to decide
// whether to reinstall (see maxx/update.mjs, emit.mjs --watch). No auth: describes the deploy
// itself, not any account's data — same posture as GET /api/model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { createMemoryStore } from "./store.mjs";

const get = (url) => ({ method: "GET", url, headers: {} });

test("reports the sha this deploy was built from", async () => {
  const h = createHandler({ store: createMemoryStore(), gitSha: "abc123def456" });
  const res = await h(get("/api/version"));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { sha: "abc123def456" });
});

test("defaults to \"unknown\" when the deploy never stamped a sha", () => {
  // Containerfile's ARG defaults the same way — a deploy built without the git-sha build-arg
  // (e.g. a shallow clone with no .git, or a manual `podman build` that skipped it) must read
  // as "no signal" to a client's update check, never as a sha nothing will ever match.
  return (async () => {
    const h = createHandler({ store: createMemoryStore() }); // gitSha omitted
    const res = await h(get("/api/version"));
    assert.deepEqual(JSON.parse(res.body), { sha: "unknown" });
  })();
});

test("no auth required — same posture as /api/model", async () => {
  const h = createHandler({ store: createMemoryStore(), gitSha: "abc123", allowUnconfigured: false });
  const res = await h(get("/api/version"));
  assert.equal(res.status, 200, "must not require a bearer token or ?k=");
});
