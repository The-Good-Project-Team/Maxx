// maxx as the ONE place an account's Claude OAuth credential lives (Reif, 2026-08-17).
//
// The tests that matter here are not "does it round-trip" -- they are the four rules that make a
// counter safe to turn into a credential store. Each has a mutation named on it, because the
// failure modes are silent by construction: a leaked secret still returns 200.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { emptyStore } from "./tally.mjs";
import {
  credKey, seal, open as openCred, fingerprint, credentialStatus,
  putCredential, reportBoxState, auditFetch, CREDENTIALS_KEY,
} from "./credentials.mjs";

const KEY_ENV = "k".repeat(48);
const ACCESS = "cred-access-token-for-the-sync-agent";
const SECRET = "budget-secret-every-agent-already-has";
const TOKEN = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-EXAMPLE", expiresAt: 1 } });

function memStore() {
  const docs = new Map();
  return {
    docs,
    // A HANDLE doc must default to emptyStore(), not {} -- computeBudget reads .anchors/.events
    // and a bare {} throws inside the route, which surfaces as a harness TypeError and would
    // have masked whatever the leak assertion was actually going to say. Index docs (the
    // underscore-prefixed ones) are plain objects and default to {}.
    load: async (k) => structuredClone(docs.get(k) ?? (String(k).startsWith("_") ? {} : emptyStore())),
    save: async (k, v) => void docs.set(k, structuredClone(v)),
    getSecret: async () => SECRET,
  };
}

function handlerWith(env = {}) {
  const prev = { ...process.env };
  Object.assign(process.env, { MAXX_CRED_KEY: KEY_ENV, MAXX_CRED_ACCESS: ACCESS, ...env });
  const store = memStore();
  const h = createHandler({ store });
  return { h, store, restore: () => { process.env = prev; } };
}

const req = (method, path, { body, headers } = {}) => ({
  method, url: `http://x${path}`, body: body ? JSON.stringify(body) : "",
  headers: { authorization: `Bearer ${SECRET}`, ...(headers || {}) },
});

async function call(h, method, path, opts) {
  const r = req(method, path, opts);
  const res = await h(r);
  // `raw` must be a STRING for every response shape. It was `res.body` directly, which is
  // undefined for a bodiless response -- and a leak test that reads undefined.includes() throws
  // instead of asserting, which would have masked a real leak behind a harness error.
  const raw = typeof res?.body === "string" ? res.body
    : res?.body != null ? JSON.stringify(res.body) : "";
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
  return { status: res?.status, body: parsed, raw };
}

// ---- rule 1: budget auth is NEVER enough -----------------------------------------------------

test("THE BUDGET SECRET CANNOT FETCH A CREDENTIAL", async () => {
  // The per-handle bearer lives in ~/.maxx/config.json on every box and is read by a dozen
  // scripts and by every agent that calls maxx_budget before spending tokens. If it could also
  // pull the OAuth token, all of them could take the account. This is the single most important
  // assertion in the repo.
  //
  // MUTATION: drop the credAccessOk() check from the GET branch and this goes RED.
  const { h, restore } = handlerWith();
  try {
    await call(h, "PUT", "/api/u/reif/credential",
      { body: { credential: TOKEN }, headers: { "x-cred-key": ACCESS } });

    const stolen = await call(h, "GET", "/api/u/reif/credential");   // budget auth only
    assert.equal(stolen.status, 403);
    assert.equal(stolen.body.error, "credential_access_required");
    assert.ok(!stolen.raw.includes("sk-ant-oat"), "the token must not appear in a denial");
  } finally { restore(); }
});

test("a WRONG cred key is refused, and storing needs it too", async () => {
  const { h, restore } = handlerWith();
  try {
    const put = await call(h, "PUT", "/api/u/reif/credential", { body: { credential: TOKEN } });
    assert.equal(put.status, 403, "writing a credential must need cred access as well");

    await call(h, "PUT", "/api/u/reif/credential",
      { body: { credential: TOKEN }, headers: { "x-cred-key": ACCESS } });
    const bad = await call(h, "GET", "/api/u/reif/credential",
      { headers: { "x-cred-key": "cred-access-token-for-the-sync-agenT" } });
    assert.equal(bad.status, 403);
  } finally { restore(); }
});

test("the sync agent WITH the cred key gets the credential back intact", async () => {
  const { h, restore } = handlerWith();
  try {
    const put = await call(h, "PUT", "/api/u/reif/credential",
      { body: { credential: TOKEN }, headers: { "x-cred-key": ACCESS } });
    assert.equal(put.status, 200);
    assert.equal(put.body.present, true);
    assert.ok(!put.raw.includes("sk-ant-oat"), "the PUT response must not echo what it stored");

    const got = await call(h, "GET", "/api/u/reif/credential", { headers: { "x-cred-key": ACCESS } });
    assert.equal(got.status, 200);
    assert.equal(got.body.credential, TOKEN);
    assert.equal(got.body.fingerprint, fingerprint(TOKEN));
  } finally { restore(); }
});

// ---- rule 2: encrypted at rest ---------------------------------------------------------------

test("the stored blob is ciphertext, not the token", async () => {
  // MUTATION: store b.credential directly instead of seal()ing it -- this goes RED. A store dump
  // must yield ciphertext, not logins.
  const { h, store, restore } = handlerWith();
  try {
    await call(h, "PUT", "/api/u/reif/credential",
      { body: { credential: TOKEN }, headers: { "x-cred-key": ACCESS } });
    const dumped = JSON.stringify(store.docs.get(CREDENTIALS_KEY));
    assert.ok(!dumped.includes("sk-ant-oat"), "plaintext token found in the store");
    assert.ok(!dumped.includes("accessToken"), "plaintext structure found in the store");
    assert.ok(dumped.includes("\"ct\""), "expected a sealed envelope");
  } finally { restore(); }
});

test("no key configured DISABLES the store rather than falling back to plaintext", () => {
  // "It stored fine on the box with no key configured" is how plaintext secrets get written.
  assert.equal(credKey({ MAXX_CRED_KEY: "" }), null);
  assert.equal(credKey({ MAXX_CRED_KEY: "too-short" }), null, "a weak key is no key");
  assert.throws(() => seal(TOKEN, null), /MAXX_CRED_KEY/);
});

test("a tampered envelope fails loudly instead of returning garbage", () => {
  const key = credKey({ MAXX_CRED_KEY: KEY_ENV });
  const sealed = seal(TOKEN, key);
  const flipped = { ...sealed, ct: Buffer.from("not-the-ciphertext").toString("base64") };
  assert.throws(() => openCred(flipped, key));
  // Garbage that decrypts "successfully" would be written over a WORKING credential file on a
  // box. GCM authenticates, so it cannot.
  const wrongKey = credKey({ MAXX_CRED_KEY: "z".repeat(48) });
  assert.throws(() => openCred(sealed, wrongKey));
});

// ---- rule 3: never in a payload --------------------------------------------------------------

test("credentialStatus carries no ciphertext, no key material, no token", () => {
  const key = credKey({ MAXX_CRED_KEY: KEY_ENV });
  const index = putCredential({}, "reif", TOKEN, key, 1000);
  const status = credentialStatus(index, "reif");
  const dumped = JSON.stringify(status);
  for (const forbidden of ["sk-ant-oat", "accessToken", "ct", "iv", "tag"]) {
    assert.ok(!dumped.includes(forbidden), `${forbidden} leaked into the status shape`);
  }
  assert.equal(status.present, true);
  assert.equal(status.fingerprint, fingerprint(TOKEN));
});

test("the budget payload never carries a credential", async () => {
  // Structural: the surfaces the whole fleet reads constantly must be unable to carry this.
  const { h, restore } = handlerWith();
  try {
    await call(h, "PUT", "/api/u/reif/credential",
      { body: { credential: TOKEN }, headers: { "x-cred-key": ACCESS } });
    for (const path of ["/api/u/reif/budget", "/api/u/reif/pool"]) {
      const res = await call(h, "GET", path);
      assert.ok(!res.raw.includes("sk-ant-oat"), `${path} leaked the token`);
      assert.ok(!res.raw.includes("\"ct\""), `${path} leaked the envelope`);
    }
  } finally { restore(); }
});

// ---- rule 4: fetches are audited -------------------------------------------------------------

test("every fetch is audited, including the ones that find nothing", async () => {
  const { h, store, restore } = handlerWith();
  try {
    await call(h, "GET", "/api/u/reif/credential",
      { headers: { "x-cred-key": ACCESS, "x-cred-who": "lucky2-sync" } });
    const audit = store.docs.get(CREDENTIALS_KEY).audit;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].who, "lucky2-sync");
    assert.equal(audit[0].ok, false, "a miss is still a read attempt worth recording");
  } finally { restore(); }
});

test("the audit is capped and newest-first", () => {
  let log = [];
  for (let i = 0; i < 600; i++) log = auditFetch(log, "reif", { who: `w${i}`, now: i, ok: true });
  assert.equal(log.length, 500);
  assert.equal(log[0].who, "w599", "newest first -- recent reads answer 'who pulled this'");
});

// ---- the invisibility this feature exists to end ---------------------------------------------

test("a box can report its credential DEAD, and that is visible without the secret", async () => {
  // The failure that started this: reif_tgp's credential on lucky2 was a 15-byte stub with no
  // keychain entry, it could not run at all, and nothing anywhere knew. ALL_ACCOUNTS_EXHAUSTED
  // fired 761 times and read as a budget problem. A dead account must be as loud as a broke one.
  const { h, restore } = handlerWith();
  try {
    await call(h, "POST", "/api/u/reif_tgp/credential/state",
      { body: { ok: false, note: "credentials.json is a 15-byte stub; no keychain entry" } });
    const st = await call(h, "GET", "/api/u/reif_tgp/credential/status");
    assert.equal(st.status, 200, "status must be readable with ORDINARY auth, or nobody sees it");
    assert.equal(st.body.box_ok, false);
    assert.match(st.body.box_note, /15-byte stub/);
  } finally { restore(); }
});

test("storage and usability are separate facts", () => {
  const key = credKey({ MAXX_CRED_KEY: KEY_ENV });
  let index = putCredential({}, "reif", TOKEN, key, 1000);
  index = reportBoxState(index, "reif", { ok: false, note: "logged out elsewhere", now: 2000 });
  const st = credentialStatus(index, "reif");
  assert.equal(st.present, true, "maxx HAS it");
  assert.equal(st.box_ok, false, "and the machine says it does not work");
});

test("an unknown handle reads absent, never throws", () => {
  const st = credentialStatus({}, "nobody");
  assert.equal(st.present, false);
  assert.equal(st.fingerprint, null);
});

// ---- hardening found in review of this very change -------------------------------------------

test("the browser cookie CANNOT stand in for the bearer on a credential fetch", async () => {
  // GET /credential originally used readTokenOf(), which also accepts the maxx_k HttpOnly cookie
  // (it exists so an operator's dashboard can read without a secret in the URL). Ambient cookie
  // authority is exactly wrong for the one operation that hands out a login: the caller must
  // prove intent by presenting the bearer. Not exploitable today -- a custom x-cred-key header
  // needs a CORS preflight this server never grants -- but it goes live the day CORS is added.
  //
  // MUTATION: change tokenOf back to readTokenOf in the GET branch and this goes RED.
  const { h, restore } = handlerWith();
  try {
    await call(h, "PUT", "/api/u/reif/credential",
      { body: { credential: TOKEN }, headers: { "x-cred-key": ACCESS } });

    const res = await h({
      method: "GET", url: "http://x/api/u/reif/credential", body: "",
      headers: { cookie: `maxx_k=${encodeURIComponent(SECRET)}`, "x-cred-key": ACCESS },
    });
    assert.equal(res.status, 401, "a cookie must not authenticate a credential fetch");
    assert.ok(!String(res.body ?? "").includes("sk-ant-oat"));
  } finally { restore(); }
});

test("index doc names are not fetchable as handles", async () => {
  // _credentials / _accounts are the store's own index docs. Probing for them is never a
  // legitimate call, so they are refused before any load happens.
  const { h, restore } = handlerWith();
  try {
    for (const name of ["_credentials", "_accounts"]) {
      const res = await call(h, "GET", `/api/u/${name}/credential`, { headers: { "x-cred-key": ACCESS } });
      assert.equal(res.status, 404, `${name} must not resolve as a handle`);
      assert.ok(!res.raw.includes("\"ct\""), "no envelope may leak through an index-doc probe");
    }
  } finally { restore(); }
});

// ---- the probe token: found in production as cleartext, migrated on read ----------------------

import { setProbeToken, openProbeToken } from "./credentials.mjs";

const KEY = credKey({ MAXX_CRED_KEY: KEY_ENV });
const PROBE = "sk-ant-oat01-" + "P".repeat(95);

test("a LEGACY cleartext probe token still works, and is sealed on first read", async () => {
  // Production 2026-08-17: $.probe.token on reif_tgp was a 108-char sk-ant-oat… in cleartext,
  // inside a 36MB doc at mode 664. It must keep working through the upgrade -- the probe is what
  // stops the whole fleet reading `stale` when the laptop sleeps -- and the cleartext must be
  // gone afterwards without anyone running a migration script.
  //
  // MUTATION: have openProbeToken return the legacy token without re-sealing it (drop the
  // migration branch) and this goes RED on the cleartext assertion.
  const s = { probe: { token: PROBE, at: 0 } };
  const { token, migrated } = openProbeToken(s, KEY);
  assert.equal(token, PROBE, "the probe must keep working across the migration");
  assert.equal(migrated, true, "the caller must be told to persist");
  assert.equal(s.probe.token, undefined, "the cleartext must be gone");
  assert.ok(s.probe.sealed, "and replaced by an envelope");
  assert.ok(!JSON.stringify(s).includes("sk-ant-oat"), "no cleartext anywhere in the doc");
});

test("a sealed probe token round-trips and never appears in the doc", () => {
  const s = setProbeToken({}, PROBE, KEY, 1000);
  assert.ok(!JSON.stringify(s).includes("sk-ant-oat"));
  assert.equal(openProbeToken(s, KEY).token, PROBE);
  assert.equal(openProbeToken(s, KEY).migrated, false, "already sealed: nothing to persist");
});

test("storing a probe token with NO key configured is REFUSED, not written in cleartext", () => {
  // "Just this once" is how the last one sat readable for weeks.
  assert.throws(() => setProbeToken({}, PROBE, null, 1000), /MAXX_CRED_KEY/);
});

test("a sealed probe token is unreadable under the wrong key, and fails CLOSED", () => {
  const s = setProbeToken({}, PROBE, KEY, 1000);
  const wrong = credKey({ MAXX_CRED_KEY: "w".repeat(48) });
  assert.equal(openProbeToken(s, wrong).token, null, "must not return garbage as a token");
  assert.equal(openProbeToken(s, null).token, null, "no key: no probe, rather than a leak");
});

test("clearing the probe token clears it", () => {
  const s = setProbeToken({ probe: { sealed: { v: 1 } } }, null, KEY, 1000);
  assert.equal(s.probe, null);
});

test("the config route seals what it stores and never echoes it", async () => {
  const { h, store, restore } = handlerWith();
  try {
    const res = await call(h, "POST", "/api/u/reif/config", { body: { probe_token: PROBE } });
    assert.equal(res.status, 200);
    assert.ok(!res.raw.includes("sk-ant-oat"), "the config echo must not carry the token");
    const doc = JSON.stringify(store.docs.get("reif"));
    assert.ok(!doc.includes("sk-ant-oat"), "the stored doc must not carry cleartext");
    assert.ok(doc.includes("sealed"), "expected a sealed envelope on the doc");
  } finally { restore(); }
});
