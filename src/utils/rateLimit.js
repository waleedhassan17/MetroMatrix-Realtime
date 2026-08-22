// ============================================================================
// Per-user token buckets for socket events.
//
// SCOPE LIMIT: this is IN-MEMORY and therefore PER-DYNO. It is correct for the
// single-dyno deployment this service is designed for (see README — Socket.IO
// without a Redis adapter already requires one dyno). If you ever scale to 2+
// dynos you must move both this and the active-call map in callHandler.js to
// Redis, or a caller simply gets N times the allowance.
// ============================================================================

const buckets = new Map(); // `${name}:${userId}` -> { tokens, updatedAt }

const LIMITS = {
  // Generous enough for fast human typing; stops a runaway client loop.
  send_message: { capacity: 20, refillPerSec: 2 },
  // Ringing is expensive (writes a CallLog + sends a push), so keep it tight.
  call_ring: { capacity: 5, refillPerSec: 5 / 60 },
  // Typing indicators are chatty by nature but must not become a fan-out amp.
  typing: { capacity: 30, refillPerSec: 5 },
  // Trickle ICE arrives in a burst at connection setup — a dual-stack device
  // on Wi-Fi plus cellular can legitimately produce 30-40 candidates in a
  // couple of seconds — then goes quiet. Hence a large bucket with a modest
  // refill: it absorbs the burst without letting a looping client relay
  // forever. Without an entry here the event would be UNLIMITED, since
  // allow() returns true for any name absent from this table.
  webrtc_ice: { capacity: 120, refillPerSec: 20 },
};

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @returns {boolean} true if the action is allowed, false if rate-limited.
 */
function allow(name, userId) {
  const limit = LIMITS[name];
  if (!limit) return true;

  const key = `${name}:${userId}`;
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: limit.capacity, updatedAt: now };
    buckets.set(key, bucket);
  } else {
    const elapsedSec = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(limit.capacity, bucket.tokens + elapsedSec * limit.refillPerSec);
    bucket.updatedAt = now;
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Buckets for users who have gone away would otherwise accumulate forever.
const sweeper = setInterval(() => {
  const cutoff = Date.now() - SWEEP_INTERVAL_MS;
  for (const [key, bucket] of buckets) {
    if (bucket.updatedAt < cutoff) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
// Don't hold the event loop open on shutdown.
if (sweeper.unref) sweeper.unref();

module.exports = { allow, LIMITS };
