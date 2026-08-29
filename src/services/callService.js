const CallLog = require('../models/CallLog');

// ============================================================================
// Call state.
//
// NO MEDIA PASSES THROUGH THIS SERVICE. ring / accept / decline / end travel
// over the socket purely to coordinate the two apps; the audio and video flow
// peer-to-peer over WebRTC, relayed through Cloudflare TURN only when a direct
// path is impossible. This service relays SDP and ICE blind (see
// sockets/callHandler.js) and never inspects them.
//
// ---------------------------------------------------------------------------
// THE BUSY SIGNAL AND ITS ONE REAL LIMITATION
// ---------------------------------------------------------------------------
// `activeCalls` tracks calls THIS SERVICE knows about. That is APP-LEVEL BUSY
// ONLY. It CANNOT detect that the callee is on an ordinary cellular call placed
// outside the app.
//
// The OS does not report system phone-call state to a React Native app without
// native modules (CallKit / ConnectionService), which this project does not yet
// use. When the callee is on an unrelated cellular call the in-app ring still
// goes through and their phone shows both.
//
// Note that busy is a different question from PRESENCE (services/presence.js).
// Busy asks "is this user already on a call?"; presence asks "is this user
// connected at all?". call_ring checks both, in that order.
//
// BUSY BEGINS AT RING, NOT AT ACCEPT. If it only began at accept, two callers
// could ring the same callee simultaneously and both would get through, and a
// caller could start a second outgoing call while their first was still
// ringing. Both parties are marked 'ringing' on call_ring and promoted to
// 'in_call' on call_accept.
//
// SCALING: this Map is per-process. The README already mandates a single dyno
// (Socket.IO without a Redis adapter requires it). At 2+ dynos a callee
// connected to another dyno reads as free, and this must move to Redis — the
// database fallback below only narrows that gap, it does not close it.
// ============================================================================

const RING_TIMEOUT_MS = 30 * 1000;
// A call still open after this long was orphaned by a crash, not still running.
const MAX_CALL_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** userId -> { callId, roomId, roomType, peerId, state, startedAt } */
const activeCalls = new Map();

function occupy(userId, entry) {
  if (userId) activeCalls.set(String(userId), entry);
}

function release(userId) {
  if (userId) activeCalls.delete(String(userId));
}

function getActive(userId) {
  return activeCalls.get(String(userId));
}

/**
 * Is this user already on (or being rung for) a call?
 *
 * Memory is authoritative and free. The CallLog fallback catches the case where
 * the process restarted, or a socket died mid-call so no `call_end` ever
 * arrived but a row is still open.
 */
async function isBusy(userId) {
  if (activeCalls.has(String(userId))) return true;
  try {
    const open = await CallLog.findOne({
      participants: userId,
      status: { $in: ['ring', 'accepted'] },
      endedAt: null,
      // WITHOUT THIS FLOOR a single crash that leaves a row open would mark
      // that user busy permanently, with no way to recover.
      startedAt: { $gt: new Date(Date.now() - MAX_CALL_MS) },
    })
      .select('_id')
      .lean();
    return Boolean(open);
  } catch (e) {
    // Never let a DB hiccup block a legitimate call.
    console.error(`[call] busy check failed user=${userId}: ${e.message}`);
    return false;
  }
}

/**
 * Terminal transition. The `status: { $in: ['ring','accepted'] }` predicate
 * makes this idempotent and lossless against a race with a concurrent accept.
 * @returns {boolean} whether this call actually transitioned.
 */
async function endCall(callId, status, endReason) {
  try {
    const now = new Date();
    const doc = await CallLog.findOneAndUpdate(
      { _id: callId, status: { $in: ['ring', 'accepted'] } },
      [
        {
          $set: {
            status,
            endReason,
            endedAt: now,
            durationSec: {
              $cond: [
                { $ifNull: ['$answeredAt', false] },
                { $divide: [{ $subtract: [now, '$answeredAt'] }, 1000] },
                null,
              ],
            },
          },
        },
      ],
      { new: true }
    );
    return Boolean(doc);
  } catch (e) {
    console.error(`[call] end transition failed callId=${callId}: ${e.message}`);
    return false;
  }
}

/**
 * Close out rows orphaned by a crash or a hard dyno kill. Runs at boot and on
 * an interval — without it those rows keep their participants permanently
 * "busy" via the fallback above.
 */
async function sweepStaleCalls() {
  try {
    const res = await CallLog.updateMany(
      {
        status: { $in: ['ring', 'accepted'] },
        endedAt: null,
        startedAt: { $lt: new Date(Date.now() - MAX_CALL_MS) },
      },
      { $set: { status: 'ended', endReason: 'stale', endedAt: new Date() } }
    );
    if (res.modifiedCount) console.log(`[call] swept ${res.modifiedCount} stale call row(s)`);
  } catch (e) {
    console.error(`[call] stale sweep failed: ${e.message}`);
  }
}

function startSweeper() {
  sweepStaleCalls();
  const t = setInterval(sweepStaleCalls, SWEEP_INTERVAL_MS);
  if (t.unref) t.unref();
  return t;
}

/**
 * Called from the SIGTERM path. Every in-flight call must be closed out, or the
 * rows stay open and the DB fallback marks those users busy until the stale
 * sweeper eventually catches them two hours later.
 */
async function closeAllOnShutdown(io, roomKey) {
  const seen = new Set();
  for (const [userId, entry] of activeCalls) {
    if (seen.has(entry.callId)) {
      release(userId);
      continue;
    }
    seen.add(entry.callId);
    await endCall(entry.callId, 'ended', 'server_restart');
    if (io) {
      io.to(roomKey(entry.roomId)).emit('call_end', {
        callId: entry.callId,
        roomId: entry.roomId,
        roomType: entry.roomType,
        reason: 'server_restart',
      });
    }
  }
  activeCalls.clear();
  if (seen.size) console.log(`[call] closed ${seen.size} in-flight call(s) on shutdown`);
}

module.exports = {
  activeCalls,
  occupy,
  release,
  getActive,
  isBusy,
  endCall,
  sweepStaleCalls,
  startSweeper,
  closeAllOnShutdown,
  RING_TIMEOUT_MS,
  MAX_CALL_MS,
};
