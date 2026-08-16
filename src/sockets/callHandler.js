const mongoose = require('mongoose');
const CallLog = require('../models/CallLog');
const { resolveRoom } = require('../utils/access');
const { sendPush } = require('../utils/push');
const { allow } = require('../utils/rateLimit');
const { safeHandler } = require('./safeHandler');
const { roomKey, userKey } = require('./keys');
const {
  occupy,
  release,
  getActive,
  isBusy,
  endCall,
  RING_TIMEOUT_MS,
} = require('../services/callService');

// ============================================================================
// Call signalling. See services/callService.js for the busy-state model and
// the documented limitation of app-level busy detection.
//
// Every event re-authorizes against live room membership. A socket that is not
// a participant is silently refused — it never learns the room exists.
// ============================================================================

/** callId -> Timeout */
const ringTimers = new Map();

function clearRing(callId) {
  const t = ringTimers.get(String(callId));
  if (t) {
    clearTimeout(t);
    ringTimers.delete(String(callId));
  }
}

/** The other party's id — always the id THEIR socket authenticates with. */
function peerOf(access) {
  return access.role === 'user'
    ? access.participants.counterpart.id
    : access.participants.user.id;
}

function selfOf(access) {
  return access.role === 'user' ? access.participants.user : access.participants.counterpart;
}

module.exports = function registerCall(io, socket) {
  const { userId } = socket.data;

  async function authorize(roomId, roomType) {
    const access = await resolveRoom(roomId, userId, roomType);
    if (!access) return null;
    if (!socket.rooms.has(roomKey(roomId))) socket.join(roomKey(roomId));
    return access;
  }

  /** Terminal transitions all behave identically apart from the status. */
  async function terminate(event, status, endReason, payload, ack) {
    const { callId, roomId, bookingId, roomType } = payload;
    const id = roomId || bookingId;

    const access = await authorize(id, roomType);
    if (!access) return ack?.({ success: false, message: 'Not a participant' });
    if (!callId) return ack?.({ success: false, message: 'callId required' });

    // Re-authorize the CALL itself, not just the room: without this any
    // participant could end a call they are not part of by guessing an id.
    const log = await CallLog.findById(callId).select('participants roomId').lean();
    if (!log || !log.participants.some((p) => String(p) === String(userId))) {
      return ack?.({ success: false, message: 'Not a party to this call' });
    }

    clearRing(callId);
    const peerId = peerOf(access);
    release(userId);
    release(peerId);

    await endCall(callId, status, endReason);

    console.log(`[call] ${status} callId=${callId} room=${id} by=${userId}`);
    socket.to(roomKey(id)).emit(event, {
      callId: String(callId),
      roomId: String(id),
      roomType: access.roomType,
      from: { id: String(userId), role: access.role },
      reason: endReason,
      at: new Date().toISOString(),
    });
    return ack?.({ success: true });
  }

  socket.on(
    'call_ring',
    safeHandler('call_ring', async ({ roomId, bookingId, roomType }, ack) => {
      const id = roomId || bookingId; // bookingId accepted for older clients
      if (!allow('call_ring', userId)) {
        return ack?.({ success: false, message: 'Too many call attempts', reason: 'rate_limited' });
      }

      const access = await authorize(id, roomType);
      if (!access) return ack?.({ success: false, message: 'Not a participant', reason: 'forbidden' });

      const calleeId = peerOf(access);
      const caller = selfOf(access);

      if (String(calleeId) === String(userId)) {
        return ack?.({ success: false, message: 'Cannot call yourself', reason: 'self' });
      }

      if (await isBusy(calleeId)) {
        console.log(`[call] busy room=${id} caller=${userId} callee=${calleeId}`);
        await CallLog.create({
          roomId: id,
          roomType: access.roomType,
          from: userId,
          to: calleeId,
          fromRole: access.role,
          participants: [userId, calleeId],
          status: 'busy',
          endReason: 'busy',
          endedAt: new Date(),
        });
        // Caller's socket ONLY. Broadcasting to the room would tell the busy
        // callee about a ring they never received.
        socket.emit('call_busy', {
          roomId: String(id),
          roomType: access.roomType,
          calleeId: String(calleeId),
          at: new Date().toISOString(),
        });
        return ack?.({ success: false, reason: 'busy', message: 'On another call' });
      }

      // Mint the id before the write so it can go out on the wire immediately.
      const callId = new mongoose.Types.ObjectId();
      await CallLog.create({
        _id: callId,
        roomId: id,
        roomType: access.roomType,
        from: userId,
        to: calleeId,
        fromRole: access.role,
        participants: [userId, calleeId],
        status: 'ring',
      });

      // Both parties are occupied from the moment the phone starts ringing.
      const entry = {
        callId: String(callId),
        roomId: String(id),
        roomType: access.roomType,
        state: 'ringing',
        startedAt: Date.now(),
      };
      occupy(userId, { ...entry, peerId: String(calleeId) });
      occupy(calleeId, { ...entry, peerId: String(userId) });

      const ringPayload = {
        callId: String(callId),
        roomId: String(id),
        roomType: access.roomType,
        from: {
          id: String(userId),
          role: access.role,
          name: caller.name,
          phoneNumber: caller.phoneNumber,
        },
        at: new Date().toISOString(),
      };
      // Targeted at the callee's personal room so it reaches them on whatever
      // screen they are on, not only one they happen to have joined.
      io.to(userKey(calleeId)).emit('call_ring', ringPayload);
      socket.to(roomKey(id)).emit('call_ring', ringPayload);

      const timer = setTimeout(async () => {
        ringTimers.delete(String(callId));
        const transitioned = await endCall(callId, 'missed', 'timeout');
        release(userId);
        release(calleeId);
        // Only announce a miss if we actually won the race against an accept.
        if (transitioned) {
          console.log(`[call] missed callId=${callId} room=${id}`);
          const missed = {
            callId: String(callId),
            roomId: String(id),
            roomType: access.roomType,
            at: new Date().toISOString(),
          };
          io.to(userKey(calleeId)).emit('call_missed', missed);
          io.to(userKey(userId)).emit('call_missed', missed);
          io.to(roomKey(id)).emit('call_end', { ...missed, reason: 'timeout' });
        }
      }, RING_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      ringTimers.set(String(callId), timer);

      console.log(
        `[call] ring callId=${callId} room=${id} type=${access.roomType} caller=${userId} callee=${calleeId}`
      );

      // Best-effort — wakes the callee when the app is backgrounded or killed.
      const calleeTokens =
        access.role === 'user'
          ? access.participants.counterpart.expoPushTokens
          : access.participants.user.expoPushTokens;
      sendPush(calleeTokens, {
        title: 'Incoming call',
        body: `${caller.name || 'Someone'} is calling you`,
        channelId: 'calls',
        data: {
          type: 'call',
          callId: String(callId),
          roomId: String(id),
          roomType: access.roomType,
          callerName: caller.name,
          callerPhone: caller.phoneNumber,
        },
      }).catch(() => {});

      return ack?.({
        success: true,
        data: {
          callId: String(callId),
          callee: {
            id: String(calleeId),
            name: access.role === 'user'
              ? access.participants.counterpart.name
              : access.participants.user.name,
            phoneNumber: access.role === 'user'
              ? access.participants.counterpart.phoneNumber
              : access.participants.user.phoneNumber,
          },
        },
      });
    })
  );

  socket.on(
    'call_accept',
    safeHandler('call_accept', async ({ callId, roomId, bookingId, roomType }, ack) => {
      const id = roomId || bookingId;
      const access = await authorize(id, roomType);
      if (!access) return ack?.({ success: false, message: 'Not a participant' });
      if (!callId) return ack?.({ success: false, message: 'callId required' });

      clearRing(callId);

      const now = new Date();
      const doc = await CallLog.findOneAndUpdate(
        { _id: callId, status: 'ring', to: userId },
        { $set: { status: 'accepted', answeredAt: now } },
        { new: true }
      );
      if (!doc) {
        // Already declined, ended, or timed out — do not resurrect it.
        return ack?.({ success: false, message: 'Call is no longer ringing' });
      }

      const peerId = peerOf(access);
      const self = selfOf(access);
      const entry = {
        callId: String(callId),
        roomId: String(id),
        roomType: access.roomType,
        state: 'in_call',
        startedAt: Date.now(),
      };
      occupy(userId, { ...entry, peerId: String(peerId) });
      occupy(peerId, { ...entry, peerId: String(userId) });

      console.log(`[call] accept callId=${callId} room=${id} by=${userId}`);
      // The accepter's number travels with the accept so the caller can hand
      // off to the native dialer without a second round-trip.
      socket.to(roomKey(id)).emit('call_accept', {
        callId: String(callId),
        roomId: String(id),
        roomType: access.roomType,
        from: { id: String(userId), role: access.role },
        peer: { phoneNumber: self.phoneNumber },
        at: now.toISOString(),
      });
      return ack?.({ success: true, data: { callId: String(callId) } });
    })
  );

  socket.on(
    'call_decline',
    safeHandler('call_decline', (p, ack) => terminate('call_decline', 'declined', 'hangup', p, ack))
  );
  socket.on(
    'call_end',
    safeHandler('call_end', (p, ack) => terminate('call_end', 'ended', 'hangup', p, ack))
  );

  // A dropped socket must not leave either party wedged as busy, must not leave
  // a CallLog row open, and must not leave the peer's UI stuck on "Ringing…".
  socket.on(
    'disconnect',
    safeHandler('disconnect', async () => {
      const active = getActive(userId);
      if (!active) return;

      clearRing(active.callId);
      release(userId);
      release(active.peerId);
      await endCall(active.callId, 'ended', 'peer_disconnect');

      const payload = {
        callId: active.callId,
        roomId: active.roomId,
        roomType: active.roomType,
        from: { id: String(userId) },
        reason: 'peer_disconnect',
        at: new Date().toISOString(),
      };
      io.to(roomKey(active.roomId)).emit('call_end', payload);
      io.to(userKey(active.peerId)).emit('call_end', payload);
      console.log(`[call] cleanup on disconnect callId=${active.callId} user=${userId}`);
    })
  );
};
