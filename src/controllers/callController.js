const asyncHandler = require('express-async-handler');
const CallLog = require('../models/CallLog');
const { resolveRoom, counterpartOf } = require('../utils/access');
const { release, endCall } = require('../services/callService');
const { getIO } = require('../sockets/io');
const { roomKey, userKey } = require('../sockets/keys');

// ============================================================================
// Declining a call over REST, for a device with no socket.
//
// WHY THIS IS NOT JUST A SOCKET EVENT
// -----------------------------------
// The lock-screen call notification offers Decline. Pressing it must NOT open
// the app — that is the whole point of a decline. But a backgrounded or killed
// process has no Socket.IO connection to emit `call_decline` over, and opening
// one just to hang up would defeat the purpose and race the process being
// suspended again.
//
// So the notification's background handler posts here instead. Everything else
// — authorization, the CallLog transition, releasing both parties from the busy
// map, telling the caller — is identical to the socket path in
// sockets/callHandler.js; only the transport differs.
// ============================================================================

// @desc    Decline a ringing call without opening the app
// @route   POST /api/calls/:callId/decline
// @access  Private (a participant of the call)
const declineCall = asyncHandler(async (req, res) => {
  const { callId } = req.params;
  const { roomId, roomType } = req.body || {};
  const userId = req.auth.id;

  if (!roomId) {
    res.status(400);
    throw new Error('roomId required');
  }

  // Same two-layer check the socket path uses: are you in this ROOM, and are
  // you a party to THIS CALL. Room membership alone is not enough — both
  // participants stay in the room permanently, so without the second check a
  // participant could hang up a call they are not part of by guessing an id.
  const access = await resolveRoom(roomId, userId, roomType);
  if (!access) {
    res.status(403);
    throw new Error('Not a participant');
  }

  const log = await CallLog.findById(callId).select('participants roomId status').lean();
  if (!log || !log.participants.some((p) => String(p) === String(userId))) {
    res.status(403);
    throw new Error('Not a party to this call');
  }

  // Idempotent: a decline arriving after the ring already timed out is a
  // no-op, not an error. The user pressed a button on a stale notification.
  const transitioned = await endCall(callId, 'declined', 'hangup');

  const peerId = counterpartOf(access).id;
  release(userId);
  release(peerId);

  if (transitioned) {
    const io = getIO();
    const payload = {
      callId: String(callId),
      roomId: String(roomId),
      roomType: access.roomType,
      from: { id: String(userId), role: access.role },
      reason: 'hangup',
      at: new Date().toISOString(),
    };
    if (io) {
      // Both the room and the caller's personal room, so the caller's screen
      // updates whichever they happen to be joined to.
      io.to(roomKey(roomId)).emit('call_decline', payload);
      io.to(userKey(peerId)).emit('call_decline', payload);
    }
    console.log(`[call] declined over REST callId=${callId} room=${roomId} by=${userId}`);
  }

  res.json({ success: true, data: { callId: String(callId), alreadyEnded: !transitioned } });
});

module.exports = { declineCall };
