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

/**
 * Fail fast at boot rather than at the first emit. A missing key would
 * otherwise mean every room event silently 401s in production, which is exactly
 * the class of quiet failure this whole change exists to remove. Mirrors how
 * src/config/db.js throws on a missing MONGODB_URI.
 */
function assertInternalKeyConfig() {
  const key = process.env.INTERNAL_API_KEY;
  if (!key || key.length < 16) {
    throw new Error(
      'INTERNAL_API_KEY is not set (or is shorter than 16 chars) — the main backend cannot publish room events without it'
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
  const provided = req.get(HEADER);
  if (!provided || !timingSafeEqual(provided, process.env.INTERNAL_API_KEY)) {
    // Log the path only — never the provided value.
    console.warn(`[internal] rejected ${req.method} ${req.path}`);
    return res.status(401).json({ success: false, message: 'Invalid internal key' });
  }
  return next();
}

module.exports = { requireInternalKey, assertInternalKeyConfig, HEADER };
