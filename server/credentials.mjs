// credentials — maxx as the ONE place an account's Claude OAuth credential lives.
//
// Reif, 2026-08-17, after an audit found the fleet's account identity smeared across six places
// and one of the two accounts silently dead for weeks: "it should be maxx only - not saved all
// over - so then maxx can be the sole place where this stuff lives." He was shown the blast
// radius (a maxx compromise stops being a usage-data leak and becomes a Claude-account
// compromise) and chose this deliberately.
//
// THAT CHOICE IS WHY THIS FILE IS PARANOID. maxx up to now has been a COUNTER: everything in it
// is a number about spend, and leaking the lot costs embarrassment. The moment it holds an OAuth
// token it is a credential store on the public internet behind a Cloudflare tunnel, and the
// rules that govern it are different in kind, not degree. Four of them:
//
//   1. A DIFFERENT KEY THAN THE BUDGET SECRET. The per-handle bearer lives in ~/.maxx/config.json
//      on every box and is read by a dozen scripts and every agent that calls maxx_budget before
//      spending tokens. If that secret could also fetch the OAuth token, every one of those
//      callers could steal the account. Credentials require `cred_key`, issued separately, held
//      only by the sync agent. Budget auth is NEVER sufficient. This is the single most important
//      line in the file.
//   2. ENCRYPTED AT REST, with a key the store does not contain. AES-256-GCM under MAXX_CRED_KEY
//      (env, server-side only), so dumping the blob store yields ciphertext rather than logins.
//   3. NEVER IN A PAYLOAD. The plaintext leaves only through the one route that exists to fetch
//      it. computeBudget(), the pool ranking, and the dashboard must be structurally unable to
//      carry it — see credentialStatus(), which is the ONLY shape those surfaces may see.
//   4. EVERY FETCH IS AUDITED. A credential read is a security event; an unexplained one is the
//      first sign of a compromise, and a store with no log cannot tell you it happened.
//
// What a box does with the result is write it to $CLAUDE_CONFIG_DIR/.credentials.json at 0600.
// maxx is the source of truth; the file on disk is a cache maxx provisions.

import crypto from "node:crypto";

/** Where the encrypted blobs live. Separate doc from the handle's own store entry so a bug that
 * serialises a handle doc into a response cannot take credentials with it. */
export const CREDENTIALS_KEY = "_credentials";

const ALG = "aes-256-gcm";

/** The encryption key, derived from MAXX_CRED_KEY. Returns null when unset -- which DISABLES
 * credential storage entirely rather than falling back to a default or to plaintext. A default
 * key is the same as no key, and "it stored fine on the box that had no key configured" is how
 * plaintext secrets get written. */
export function credKey(env = process.env) {
  const raw = env.MAXX_CRED_KEY;
  if (!raw || String(raw).length < 32) return null;
  // Hash to exactly 32 bytes so an operator's passphrase of any length is usable, without
  // inventing a KDF whose parameters would then need to be stored and versioned.
  return crypto.createHash("sha256").update(String(raw)).digest();
}

/** Encrypt a credential. Returns the at-rest shape: {v, iv, tag, ct}. */
export function seal(plaintext, key) {
  if (!key) throw new Error("MAXX_CRED_KEY is not configured");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

/** Decrypt. Throws on a wrong key or tampered ciphertext -- GCM authenticates, so a modified
 * blob fails loudly instead of returning garbage that a box would then write over a working
 * credential file. */
export function open(sealed, key) {
  if (!key) throw new Error("MAXX_CRED_KEY is not configured");
  if (!sealed || sealed.v !== 1) throw new Error("unknown credential envelope");
  const d = crypto.createDecipheriv(ALG, key, Buffer.from(sealed.iv, "base64"));
  d.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(sealed.ct, "base64")), d.final()]).toString("utf8");
}

/** A stable, non-reversible fingerprint so a human can confirm WHICH credential is stored, and
 * a box can tell "mine matches maxx" from "mine is stale", without either side handling the
 * secret. Truncated: 12 hex chars is plenty to compare, too little to attack. */
export const fingerprint = (plaintext) =>
  crypto.createHash("sha256").update(String(plaintext)).digest("hex").slice(0, 12);

/**
 * THE ONLY SHAPE NON-CREDENTIAL SURFACES MAY SEE. No ciphertext, no key material, no token --
 * just whether a credential exists, when it changed, and which one it is.
 *
 * This exists because the failure that started all of this was INVISIBILITY, not theft:
 * reif_tgp's credential on lucky2 was a 15-byte stub with no keychain entry, it could not run at
 * all, and nothing anywhere knew. `ALL_ACCOUNTS_EXHAUSTED` fired 761 times and read as a budget
 * problem. A dead account must be as loud as an over-budget one.
 */
export function credentialStatus(index, handle) {
  const row = (index || {})[String(handle)];
  if (!row) return { handle: String(handle), present: false, fingerprint: null, updated_at: null };
  return {
    handle: String(handle),
    present: true,
    fingerprint: row.fingerprint || null,
    updated_at: row.updated_at || null,
    // Reported BY the box that consumes it, so maxx can show "stored here, but the machine says
    // it is not working" -- storage and usability are different facts.
    box_ok: row.box_ok ?? null,
    box_checked_at: row.box_checked_at || null,
    box_note: row.box_note || null,
  };
}

/** Put a credential into the index (pure). */
export function putCredential(index, handle, plaintext, key, now) {
  const out = { ...(index || {}) };
  out[String(handle)] = {
    ...seal(plaintext, key),
    fingerprint: fingerprint(plaintext),
    updated_at: Math.round(now),
  };
  return out;
}

/** Record what a BOX observed about this credential in practice. Storage != usability: a
 * perfectly stored token whose account has been logged out elsewhere is still dead, and only the
 * machine trying to use it can say so. */
export function reportBoxState(index, handle, { ok, note, now }) {
  const out = { ...(index || {}) };
  const row = { ...(out[String(handle)] || {}) };
  row.box_ok = !!ok;
  row.box_checked_at = Math.round(now);
  if (note != null) row.box_note = String(note).slice(0, 200);
  out[String(handle)] = row;
  return out;
}

/** Append-only audit of credential FETCHES. Capped so it cannot grow without bound, newest
 * first -- the recent reads are the ones that matter when answering "who pulled this". */
export function auditFetch(log, handle, { who, now, ok }) {
  const entry = { handle: String(handle), who: String(who || "unknown").slice(0, 64), ts: Math.round(now), ok: !!ok };
  return [entry, ...(log || [])].slice(0, 500);
}


// ---- the probe credential -------------------------------------------------------------------
//
// FOUND IN PRODUCTION 2026-08-17, and it is why this module exists at all rather than only the
// OAuth store: `$.probe.token` on the reif_tgp handle doc was a 108-character sk-ant-oat…
// setup-token in CLEARTEXT, inside a 36MB JSON blob at mode 664 -- group- and world-readable on
// the box, and copied into every backup of that state dir.
//
// The probe is the pull-on-miss anchor (server/probe.mjs): when the laptop stops pushing, maxx
// calls Anthropic itself with this token to read the rate-limit headers. So maxx genuinely does
// hold a key to the account -- Reif said so and he was right. It was simply held badly.
//
// These two functions are the whole migration. Reading goes through openProbeToken(), which
// transparently upgrades a legacy plaintext token to a sealed one and reports that it did, so
// the cleartext disappears on first use rather than needing a migration script that someone has
// to remember to run.

/** Seal a probe token onto the handle doc, removing any plaintext. Mutates `s`, returns it. */
export function setProbeToken(s, token, key, now) {
  if (!token) { s.probe = null; return s; }
  if (!key) {
    // No key configured: refuse rather than silently writing cleartext. This is the exact
    // failure being repaired; re-creating it "temporarily" is how it lasted this long.
    throw new Error("MAXX_CRED_KEY is not configured — refusing to store a probe token in cleartext");
  }
  s.probe = { sealed: seal(token, key), at: (s.probe && s.probe.at) || 0, sealed_at: Math.round(now) };
  return s;
}

/**
 * The probe token for this handle, or null.
 *
 * Returns {token, migrated} — `migrated` true means a legacy cleartext token was just sealed and
 * the caller MUST persist `s`. Never returns the plaintext to a payload; the only consumer is
 * probeAnchor().
 */
export function openProbeToken(s, key) {
  const p = s && s.probe;
  if (!p) return { token: null, migrated: false };
  if (p.sealed) {
    if (!key) return { token: null, migrated: false };   // sealed but unreadable: fail closed
    try { return { token: open(p.sealed, key), migrated: false }; }
    catch { return { token: null, migrated: false }; }
  }
  if (!p.token) return { token: null, migrated: false };
  // LEGACY CLEARTEXT. Hand it back so the probe keeps working, and upgrade it in place.
  if (!key) return { token: p.token, migrated: false };  // no key yet: still works, still loud
  const token = p.token;
  s.probe = { sealed: seal(token, key), at: p.at || 0, sealed_at: Math.round(Date.now() / 1000) };
  return { token, migrated: true };
}
