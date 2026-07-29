// The connector URL is pasted into claude.ai and travels through Cloudflare logs, Netlify
// logs, browser history and the occasional screenshot. Whatever rides in it must therefore be
// (a) not the account secret and (b) revocable on its own. These pin that boundary, plus the
// throttle that makes guessing cost something.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { createMemoryStore } from "./store.mjs";

const J = (r) => JSON.parse(r.body);

async function setup() {
  const store = createMemoryStore();
  const handler = createHandler({ store, now: () => 1_800_000_000 });
  const signup = await handler({ method: "POST", url: "/api/signup", headers: { host: "api.meetmaxx.co" }, body: JSON.stringify({ handle: "acme" }) });
  return { store, handler, ...J(signup) };
}

test("signup puts a SCOPED token in the connector URL, never the account secret", async () => {
  const { secret, connector_token, mcp_url } = await setup();
  assert.ok(connector_token?.startsWith("ct_"), "signup must mint a connector token");
  assert.ok(mcp_url.includes(connector_token), "the URL should carry the scoped token");
  assert.ok(!mcp_url.includes(secret), "the account secret must never appear in a URL");
});

test("a connector token works for the connector's job — and nothing more", async () => {
  const { handler, connector_token, secret } = await setup();

  const budget = await handler({ method: "GET", url: "/api/u/acme/budget", headers: { authorization: `Bearer ${connector_token}` } });
  assert.equal(budget.status, 200, "the token must authenticate the reads MCP actually makes");

  // a magic link is a full owner login; a URL-borne credential must not be able to mint one
  const magic = await handler({ method: "POST", url: `/api/u/acme/magic?k=${connector_token}`, headers: {} });
  assert.equal(magic.status, 401, "a leaked connector token could otherwise open the dashboard");
  const magicOwner = await handler({ method: "POST", url: `/api/u/acme/magic?k=${secret}`, headers: {} });
  assert.equal(magicOwner.status, 200, "the real secret still works");

  // nor should it become a durable browser session
  const login = await handler({ method: "POST", url: "/api/u/acme/login", headers: {}, body: JSON.stringify({ secret: connector_token }) });
  assert.equal(login.status, 401, "a connector token must not be a dashboard login");

  // nor mint or revoke its own siblings
  const mint = await handler({ method: "POST", url: `/api/u/acme/connector-tokens?k=${connector_token}`, headers: {}, body: "{}" });
  assert.equal(mint.status, 401, "a token that can mint tokens is not scoped at all");
});

test("revoking a connector token takes effect immediately and leaves the account alone", async () => {
  const { handler, secret } = await setup();
  const minted = J(await handler({ method: "POST", url: `/api/u/acme/connector-tokens?k=${secret}`, headers: { host: "api.meetmaxx.co" }, body: JSON.stringify({ label: "laptop" }) }));
  assert.ok(minted.token.startsWith("ct_"));

  assert.equal((await handler({ method: "GET", url: `/api/u/acme/budget?k=${minted.token}`, headers: {} })).status, 200);
  const del = await handler({ method: "DELETE", url: `/api/u/acme/connector-tokens?k=${secret}&id=${minted.id}`, headers: {} });
  assert.equal(del.status, 200);
  assert.equal((await handler({ method: "GET", url: `/api/u/acme/budget?k=${minted.token}`, headers: {} })).status, 200,
    "budget stays publicly readable — but redacted, which the payload test covers");

  // the revoked token must not pass anywhere authentication actually matters
  const emit = await handler({ method: "POST", url: `/api/u/acme/logs?k=${minted.token}`, headers: {}, body: "{}" });
  assert.equal(emit.status, 401, "a revoked token still writes to the ledger");
  // and the account secret is untouched by a revoke
  assert.equal((await handler({ method: "POST", url: `/api/u/acme/logs?k=${secret}`, headers: {}, body: "{}" })).status, 200);
});

test("listing connector tokens never returns the tokens themselves", async () => {
  const { handler, secret } = await setup();
  await handler({ method: "POST", url: `/api/u/acme/connector-tokens?k=${secret}`, headers: {}, body: "{}" });
  const list = await handler({ method: "GET", url: `/api/u/acme/connector-tokens?k=${secret}`, headers: {} });
  assert.equal(list.status, 200);
  assert.ok(!list.body.includes("ct_"), "a list endpoint that echoes secrets re-leaks them on every read");
  assert.ok(J(list).tokens.length >= 1);
});

test("repeated wrong credentials get throttled, per handle+IP", async () => {
  const { handler } = await setup();
  const attempt = (ip, k) => handler({ method: "POST", url: `/api/u/acme/logs?k=${k}`, headers: { "x-forwarded-for": ip }, body: "{}" });

  let last;
  for (let i = 0; i < 12; i++) last = await attempt("10.0.0.1", `guess-${i}`);
  assert.equal(last.status, 429, "guessing must stop being free");
  assert.match(last.headers["retry-after"] || "", /^\d+$/, "a 429 without retry-after is unactionable");

  // one attacker must not be able to lock the real owner out
  const other = await attempt("10.0.0.2", "still-wrong");
  assert.equal(other.status, 401, "a different client is judged on its own record, not the attacker's");
});

test("credential comparison does not depend on a shared prefix", async () => {
  const { handler, secret } = await setup();
  const near = secret.slice(0, -1) + (secret.slice(-1) === "a" ? "b" : "a");
  assert.equal((await handler({ method: "POST", url: `/api/u/acme/logs?k=${near}`, headers: { "x-forwarded-for": "10.9.9.9" }, body: "{}" })).status, 401,
    "an almost-right secret must be as rejected as a wholly wrong one");
});
