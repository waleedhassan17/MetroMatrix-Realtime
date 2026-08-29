// ============================================================================
// Presence — who has a live socket right now, and when we last saw them.
//
// WHY THIS EXISTS
// ---------------
// The chat header used to render "online" whenever the VIEWER's own socket was
// connected. That is a different question entirely: it says "my messages are
// sending", not "the other person is there". A provider could force-close their
// app and the customer would still be told they were online, indefinitely.
// Nothing on the server could answer the real question, because nothing tracked
// it. This does.
//
// A user is online when at least one authenticated socket is connected for
// them. Two devices, or a reconnect that briefly overlaps the old socket, mean
// the set has more than one entry — which is exactly why this is a Set of
// socket ids per user and not a boolean. Going offline is "the set became
// empty", not "a socket closed".
//
// NO APPLICATION HEARTBEAT, ON PURPOSE
// ------------------------------------
// Socket.IO's own engine ping already runs at pingInterval 25s / pingTimeout
// 20s (see sockets/index.js), so a device that dies without closing its socket
// is reaped in at most ~45s and lands in the disconnect handler like any other.
// An app-level ping on top of that would duplicate the transport's job, cost a
// message every few seconds per client, and still not detect anything sooner.
//
// LAST SEEN IS IN-MEMORY AND DOES NOT SURVIVE A RESTART. A dyno cycle drops the
// timestamps, so a user who was last seen before the restart reads as offline
// with no time — which the client renders as plain "Offline". That is the
// honest degradation: better than persisting a write on every disconnect to a
// collection the main backend owns, and better than inventing a timestamp.
//
// SCALING: this Map is per-process, the same constraint the busy map carries
// (services/callService.js) and for the same reason — Socket.IO without a Redis
// adapter mandates a single dyno. At 2+ dynos a user connected to another dyno
// would read as offline here, which would wrongly fail their calls as
// 'unavailable'. Moving to 2+ dynos means moving presence, the busy map and the
// rate limiter to Redis together.
// ============================================================================

/** userId -> Set<socketId>. Presence of a key does NOT imply online; see below. */
const online = new Map();

/** userId -> epoch ms of the moment their last socket went away. */
const lastSeen = new Map();

// lastSeen would otherwise grow once per user who has ever connected and never
// shrink. Bounded the same way utils/access.js bounds its cache.
const LAST_SEEN_MAX = 5000;

function rememberLastSeen(userId, at) {
  if (lastSeen.size >= LAST_SEEN_MAX && !lastSeen.has(userId)) {
    // Map preserves insertion order — drop the oldest entry.
    lastSeen.delete(lastSeen.keys().next().value);
  }
  lastSeen.set(userId, at);
}

/**
 * Record an authenticated socket for a user.
 * @returns {boolean} true only on the transition offline -> online, so callers
 *   broadcast once per transition rather than once per socket.
 */
function register(userId, socketId) {
  if (!userId || !socketId) return false;
  const uid = String(userId);
  let sockets = online.get(uid);
  if (!sockets) {
    sockets = new Set();
    online.set(uid, sockets);
  }
  const wasOffline = sockets.size === 0;
  sockets.add(socketId);
  if (wasOffline) lastSeen.delete(uid);
  return wasOffline;
}

/**
 * Drop a socket. The user stays online while any other socket remains — a
 * reconnect that overlaps the dying socket must not flap them offline.
 * @returns {boolean} true only on the transition online -> offline.
 */
function deregister(userId, socketId) {
  if (!userId || !socketId) return false;
  const uid = String(userId);
  const sockets = online.get(uid);
  if (!sockets) return false;

  sockets.delete(socketId);
  if (sockets.size > 0) return false;

  online.delete(uid);
  rememberLastSeen(uid, Date.now());
  return true;
}

function isOnline(userId) {
  const sockets = online.get(String(userId));
  return Boolean(sockets && sockets.size > 0);
}

/**
 * @returns {{ userId: string, status: 'online'|'offline', lastSeen: string|null }}
 *   lastSeen is an ISO string, or null when unknown (never seen this process, or
 *   currently online).
 */
function getPresence(userId) {
  const uid = String(userId);
  const at = lastSeen.get(uid);
  return {
    userId: uid,
    status: isOnline(uid) ? 'online' : 'offline',
    lastSeen: isOnline(uid) || !at ? null : new Date(at).toISOString(),
  };
}

/** Count of distinct users with at least one live socket — for /health. */
function onlineCount() {
  return online.size;
}

/**
 * Called from the SIGTERM path. Every connected user is about to lose their
 * socket, so stamp them all as last-seen-now rather than leaving the map to be
 * discarded with the process.
 */
function clearAllOnShutdown() {
  const at = Date.now();
  for (const uid of online.keys()) rememberLastSeen(uid, at);
  online.clear();
}

module.exports = {
  register,
  deregister,
  isOnline,
  getPresence,
  onlineCount,
  clearAllOnShutdown,
};
