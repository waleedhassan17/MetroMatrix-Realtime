// ============================================================================
// TURN credential minting for in-app WebRTC calls.
//
// WHY THIS ENDPOINT EXISTS AT ALL
// -------------------------------
// A peer connection needs ICE servers. STUN alone is free and anonymous, but
// it only works when the two peers can reach each other directly — which fails
// on most mobile carrier networks (symmetric NAT). TURN relays the media in
// that case, and a relay costs money, so it is authenticated: every TURN
// session needs a username/credential pair.
//
// Those pairs are minted from a long-lived Cloudflare API token. That token
// must NEVER reach the app: anyone who extracts it from a bundle can relay
// unlimited traffic on our account. So the app asks US, we mint a short-lived
// pair with the secret, and the app receives only the result.
//
// This is also why the credential is fetched immediately before each call
// rather than cached: it expires (TURN_TTL_SECONDS), and a stale pair fails at
// exactly the worst moment — mid-connection, looking like a network fault.
// ============================================================================

const asyncHandler = require('express-async-handler');

const CF_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

const DEFAULT_TTL_SECONDS = 3600;

// Cloudflare hands back entries on port 53. react-native-webrtc has a
// long-standing problem parsing them (port 53 is DNS; some networks and some
// versions of the parser reject it), and they add nothing — the 3478 entry is
// the same server. Dropping them here means every client is spared the bug.
//
// The port must be matched EXACTLY, not as a substring: `turns:…:5349` — the
// standard TURN-over-TLS port, and frequently the only one that survives a
// restrictive corporate or mobile network that blocks UDP — contains ":53".
// A naive `includes(':53')` silently throws away the most valuable relay
// candidate we have.
const REJECTED_PORT_RE = /:53(?=$|[?/])/;

const isConfigured = () =>
  typeof process.env.CF_TURN_TOKEN_ID === 'string' &&
  process.env.CF_TURN_TOKEN_ID.length > 0 &&
  typeof process.env.CF_TURN_API_TOKEN === 'string' &&
  process.env.CF_TURN_API_TOKEN.length > 0;

/**
 * WARN at boot — deliberately not throw.
 *
 * Same reasoning as INTERNAL_API_KEY (see middleware/internalAuth.js): this
 * service already owns chat and calling in production. A new variable that is
 * fatal when unset means one forgetful deploy takes messaging down to gain a
 * feature that did not exist a release ago. Unset degrades exactly one thing —
 * calls cannot fetch ICE servers and fail with a clear message — while chat,
 * signalling and history keep working.
 */
function assertTurnConfig() {
  if (!isConfigured()) {
    console.warn(
      '[turn] CF_TURN_TOKEN_ID / CF_TURN_API_TOKEN are not set. ' +
        'GET /api/turn/credentials will return 503 and in-app calls cannot connect. ' +
        'Chat, signalling and call history are unaffected.'
    );
  }
}

const ttlSeconds = () => {
  const raw = Number(process.env.TURN_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TTL_SECONDS;
};

/**
 * Drop the unusable port-53 URLs, and drop any server left with no URLs.
 * Everything else passes through exactly as Cloudflare sent it — we are a
 * conduit, not a translator, and rewriting ICE payloads is how subtle
 * connection bugs get introduced.
 */
function sanitizeIceServers(iceServers) {
  if (!Array.isArray(iceServers)) return [];

  return iceServers
    .map((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const kept = urls.filter((u) => typeof u === 'string' && !REJECTED_PORT_RE.test(u));
      return { ...server, urls: kept };
    })
    .filter((server) => server.urls.length > 0);
}

// @desc  GET /api/turn/credentials — short-lived ICE servers for one call
// @access Private (same `protect` JWT gate as chat and push)
const getTurnCredentials = asyncHandler(async (req, res) => {
  if (!isConfigured()) {
    console.warn('[turn] refused: TURN credentials are not configured on this dyno');
    return res.status(503).json({
      success: false,
      message: 'Calling is temporarily unavailable.',
    });
  }

  let response;
  try {
    response = await fetch(
      `${CF_API_BASE}/${process.env.CF_TURN_TOKEN_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        // customIdentifier tags relay usage per user, so abuse can be traced to
        // an account without us storing anything. req.auth.id — NOT req.user,
        // which does not exist in this service (see middleware/auth.js).
        body: JSON.stringify({ ttl: ttlSeconds(), customIdentifier: req.auth.id }),
      }
    );
  } catch (e) {
    // Network-level failure reaching Cloudflare. The message is safe to log —
    // it never contains the Authorization header.
    console.error(`[turn] mint request failed to reach Cloudflare: ${e.message}`);
    return res.status(502).json({
      success: false,
      message: 'Could not start the call. Please try again.',
    });
  }

  if (response.status !== 201 && response.status !== 200) {
    // Status ONLY. The body of a failed mint can echo request details, and the
    // request contains the bearer token.
    console.error(`[turn] Cloudflare returned ${response.status} for user=${req.auth.id}`);
    return res.status(502).json({
      success: false,
      message: 'Could not start the call. Please try again.',
    });
  }

  const body = await response.json().catch(() => null);
  const iceServers = sanitizeIceServers(body && body.iceServers);

  if (!iceServers.length) {
    console.error(`[turn] Cloudflare returned no usable ICE servers for user=${req.auth.id}`);
    return res.status(502).json({
      success: false,
      message: 'Could not start the call. Please try again.',
    });
  }

  // Log that a mint happened and for whom — never the username or credential.
  console.log(`[turn] minted ice servers user=${req.auth.id} count=${iceServers.length}`);

  return res.json({ success: true, data: { iceServers } });
});

module.exports = { getTurnCredentials, assertTurnConfig };
