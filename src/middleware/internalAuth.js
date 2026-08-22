const crypto = require('crypto');

// ============================================================================
// Server-to-server authentication for the internal emit bridge.
//
// The caller here is the MAIN BACKEND, not a user, so `protect` (which verifies
// a user JWT) is the wrong gate — there is no user to attribute the request to,
// and minting a service JWT would mean issuing a token nobody can revoke.
//
// A shared secret is compared in constant time. A plain `!==` leaks the secret
// one byte at a time to an attacker who can measure response latency; the
// length check before it is safe to short-circuit because the length of a
// secret is not itself sensitive.
// ============================================================================

const HEADER = 'x-internal-key';

const MIN_KEY_LENGTH = 16;

const isConfigured = () => {
  const key = process.env.INTERNAL_API_KEY;
  return typeof key === 'string' && key.length >= MIN_KEY_LENGTH;
};

/**
 * WARN at boot — deliberately not throw.
 *
 * This service already owns chat and calling in production. Making a NEW
 * variable fatal means one deploy that forgets to set it takes messaging and
 * calling down completely, to gain a feature that did not exist a release ago.
 * That trade is backwards: the blast radius of failing closed here is far
 * larger than the capability being added.
 *
 * So an unset key degrades exactly one thing — the emit bridge returns 503, and
 * server-originated room events stop arriving while chat, calling and history
 * keep working. It is not a silent failure either: this warning fires at boot,
 * the bridge logs each refusal, and the main backend logs every failed publish.
 */
function assertInternalKeyConfig() {
  if (!isConfigured()) {
    console.warn(
      `[internal] INTERNAL_API_KEY is not set (or is under ${MIN_KEY_LENGTH} chars). ` +
        'The main backend cannot publish room events — booking/appointment status, ' +
        'payments and video-call events will not reach clients. Chat and calling are unaffected.'
    );
  }
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireInternalKey(req, res, next) {
  // Refuse BEFORE comparing when unconfigured. String(undefined) is the literal
  // "undefined", so comparing against an unset env var would authenticate
  // anyone who sent `x-internal-key: undefined` — an auth bypass that opens up
  // the moment a missing key stops being fatal at boot.
  if (!isConfigured()) {
    console.warn(`[internal] refused ${req.method} ${req.path} — INTERNAL_API_KEY not configured`);
    return res
      .status(503)
      .json({ success: false, message: 'Internal bridge is not configured' });
  }

  const provided = req.get(HEADER);
  if (!provided || !timingSafeEqual(provided, process.env.INTERNAL_API_KEY)) {
    // Log the path only — never the provided value.
    console.warn(`[internal] rejected ${req.method} ${req.path}`);
    return res.status(401).json({ success: false, message: 'Invalid internal key' });
  }
  return next();
}

module.exports = { requireInternalKey, assertInternalKeyConfig, HEADER };
