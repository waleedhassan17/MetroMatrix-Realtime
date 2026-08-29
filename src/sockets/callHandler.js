const mongoose = require('mongoose');
const CallLog = require('../models/CallLog');
const { resolveRoom, counterpartOf, selfOf } = require('../utils/access');
const { isOnline } = require('../services/presence');
const { sendPush } = require('../utils/push');
const { CALLS_CHANNEL, MESSAGES_CHANNEL } = require('../utils/pushChannels');
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
  return counterpartOf(access).id;
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

      // ---------------------------------------------------------------------
      // Is the callee reachable AT ALL — by socket, or failing that by push?
      //
      // "No live socket" does NOT mean unreachable. A backgrounded or killed
      // app has no socket and is exactly the case a ring most needs to reach:
      // a phone in someone's pocket. Treating that as `unavailable` meant a
      // closed app could never be rung, which is most of what "calls don't
      // notify me" amounts to.
      //
      // So only a callee with NEITHER a socket NOR a push token is genuinely
      // unavailable. Everyone else gets a real, ringing call: a live CallLog, a
      // ring timer, and a high-priority push carrying the callId so tapping it
      // can answer. The caller sits on "Calling…" until the callee's device
      // acknowledges with call_ringing — which the push-tap path emits too.
      // ---------------------------------------------------------------------
      const calleeTokens = counterpartOf(access).expoPushTokens || [];
      const calleeOnline = isOnline(calleeId);

      if (!calleeOnline && !calleeTokens.length) {
        console.log(`[call] unavailable room=${id} caller=${userId} callee=${calleeId}`);
        await CallLog.create({
          roomId: id,
          roomType: access.roomType,
          from: userId,
          to: calleeId,
          fromRole: access.role,
          participants: [userId, calleeId],
          status: 'unavailable',
          endReason: 'offline',
          endedAt: new Date(),
        });

        // Caller's socket ONLY — same reasoning as call_busy: broadcasting to
        // the room would announce a ring that never happened.
        socket.emit('call_unavailable', {
          roomId: String(id),
          roomType: access.roomType,
          calleeId: String(calleeId),
          at: new Date().toISOString(),
        });
        return ack?.({
          success: false,
          reason: 'unavailable',
          message: 'User unavailable',
        });
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

          // Past tense, and correct here: the ring genuinely happened and
          // nobody answered. Reuses the ring's collapse key so it REPLACES the
          // now-dead "Incoming call" notification rather than sitting beneath
          // it — otherwise the callee finds a ringing call they cannot answer.
          sendPush(calleeTokens, {
            title: 'Missed call',
            body: `${caller.name || 'Someone'} tried to call you`,
            channelId: MESSAGES_CHANNEL,
            collapseKey: `call:${id}`,
            data: {
              type: 'missed_call',
              roomId: String(id),
              roomType: access.roomType,
              callerName: caller.name,
            },
          }).catch(() => {});
        }
      }, RING_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      ringTimers.set(String(callId), timer);

      console.log(
        `[call] ring callId=${callId} room=${id} type=${access.roomType} ` +
          `caller=${userId} callee=${calleeId} socket=${calleeOnline}`
      );

      // Wakes a backgrounded or killed callee. This is the ONLY thing that can
      // ring a phone whose app is not running, so it is not optional garnish.
      sendPush(calleeTokens, {
        title: 'Incoming call',
        body: `${caller.name || 'Someone'} is calling you`,
        channelId: CALLS_CHANNEL,
        // Expires with the ring itself. A call notification that lands after
        // the caller has given up is noise, and worse, tapping it would try to
        // answer a call that is already over.
        ttlSeconds: Math.ceil(RING_TIMEOUT_MS / 1000),
        // One entry per room: a second attempt replaces the first rather than
        // leaving a stack of dead rings in the shade.
        collapseKey: `call:${id}`,
        categoryId: 'incoming_call',
        data: {
          type: 'call',
          // LOAD-BEARING. The app drops any call notification without a callId
          // (useNotificationRouting), because it cannot answer a call it cannot
          // name. Every call push must carry it.
          callId: String(callId),
          roomId: String(id),
          roomType: access.roomType,
          callerName: caller.name,
        },
      }).catch(() => {});

      return ack?.({
        success: true,
        data: {
          callId: String(callId),
          callee: { id: String(calleeId), name: counterpartOf(access).name },
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
      // This used to carry the accepter's phone number so the caller could
      // hand off to the native dialer. Media now flows peer-to-peer over
      // WebRTC, so a phone number is no longer a connection mechanism: it
      // stays on the CallLog for records and never leaves the server.
      // The CALLER reacts to this event by creating the SDP offer.
      socket.to(roomKey(id)).emit('call_accept', {
        callId: String(callId),
        roomId: String(id),
        roomType: access.roomType,
        from: { id: String(userId), role: access.role },
        at: now.toISOString(),
      });
      return ack?.({ success: true, data: { callId: String(callId) } });
    })
  );

  // ==========================================================================
  // Delivery acknowledgement.
  //
  // The callee's device emits this the moment it actually presents an incoming
  // call. It is the ONLY thing that moves the caller from "Calling…" to
  // "Ringing…", and that distinction is the whole point: before this existed
  // the caller's UI said "Ringing…" the instant they pressed call, which was a
  // guess, and the guess was wrong exactly when it mattered — a callee whose
  // app was closed, or whose ring frame was lost.
  //
  // Only the callee (`to` on the CallLog) can send it. Otherwise a caller could
  // emit it at themselves and manufacture the very reassurance this provides.
  // ==========================================================================
  socket.on(
    'call_ringing',
    safeHandler('call_ringing', async ({ callId, roomId, bookingId, roomType }, ack) => {
      const id = roomId || bookingId;
      const access = await authorize(id, roomType);
      if (!access) return ack?.({ success: false, message: 'Not a participant' });
      if (!callId) return ack?.({ success: false, message: 'callId required' });

      const log = await CallLog.findById(callId).select('from to status').lean();
      if (!log || String(log.to) !== String(userId)) {
        return ack?.({ success: false, message: 'Not the callee for this call' });
      }
      if (log.status !== 'ring') {
        return ack?.({ success: false, message: 'Call is no longer ringing' });
      }

      console.log(`[call] ringing ack callId=${callId} room=${id} callee=${userId}`);
      io.to(userKey(log.from)).emit('call_ringing', {
        callId: String(callId),
        roomId: String(id),
        roomType: access.roomType,
        at: new Date().toISOString(),
      });
      return ack?.({ success: true });
    })
  );

  // ==========================================================================
  // WebRTC signalling relay.
  //
  // These three events carry the media negotiation between the two peers. The
  // server is a DUMB PIPE here: it never parses SDP, never stores a candidate,
  // and never inspects the payload beyond checking who is allowed to send it.
  // That is deliberate — the moment the server understands the media it
  // becomes a thing that can break the media.
  //
  // Authorization is doubled on purpose, matching terminate() above:
  //   1. authorize()  — are you in this ROOM?
  //   2. CallLog      — are you a party to THIS CALL?
  // Room membership alone is not enough. A booking's customer and provider are
  // both in the room permanently, so without the second check a participant
  // could inject candidates into a call they are not part of, or hijack a
  // negotiation by racing the real peer.
  // ==========================================================================

  /**
   * @param {string} event    the event to forward under
   * @param {object} payload  { callId, roomId|bookingId, roomType, ...frame }
   * @param {object} frame    the media fields to forward (sdp / candidate)
   */
  async function relaySignal(event, payload, frame, ack) {
    const { callId, roomId, bookingId, roomType } = payload;
    const id = roomId || bookingId;

    const access = await authorize(id, roomType);
    if (!access) return ack?.({ success: false, message: 'Not a participant' });
    if (!callId) return ack?.({ success: false, message: 'callId required' });

    const log = await CallLog.findById(callId).select('participants status').lean();
    if (!log || !log.participants.some((p) => String(p) === String(userId))) {
      return ack?.({ success: false, message: 'Not a party to this call' });
    }
    // Negotiating a call that is already over would leave the peer with a
    // half-open connection nothing will ever tear down.
    if (log.status !== 'ring' && log.status !== 'accepted') {
      return ack?.({ success: false, message: 'Call is no longer active' });
    }

    // socket.to() excludes the sender, so this reaches only the peer.
    socket.to(roomKey(id)).emit(event, {
      callId: String(callId),
      roomId: String(id),
      roomType: access.roomType,
      from: { id: String(userId), role: access.role },
      ...frame,
    });
    return ack?.({ success: true });
  }

  socket.on(
    'webrtc_offer',
    safeHandler('webrtc_offer', async (p, ack) => {
      if (!p?.sdp) return ack?.({ success: false, message: 'sdp required' });
      // Never log the SDP itself — it contains IP addresses and, with some
      // configurations, identity material.
      console.log(`[call] webrtc offer callId=${p.callId} from=${userId}`);
      return relaySignal('webrtc_offer', p, { sdp: p.sdp }, ack);
    })
  );

  socket.on(
    'webrtc_answer',
    safeHandler('webrtc_answer', async (p, ack) => {
      if (!p?.sdp) return ack?.({ success: false, message: 'sdp required' });
      console.log(`[call] webrtc answer callId=${p.callId} from=${userId}`);
      return relaySignal('webrtc_answer', p, { sdp: p.sdp }, ack);
    })
  );

  socket.on(
    'webrtc_ice',
    safeHandler('webrtc_ice', async (p, ack) => {
      if (!p?.candidate) return ack?.({ success: false, message: 'candidate required' });
      // Trickle ICE is bursty by nature, so this is throttled rather than
      // unlimited (see utils/rateLimit.js). Unlike send_message a rejected
      // candidate is not user-visible, so fail quietly: dropping one candidate
      // costs a connectivity path, not the call.
      if (!allow('webrtc_ice', userId)) {
        return ack?.({ success: false, message: 'Too many candidates', throttled: true });
      }
      // Deliberately NOT logged per-candidate: a single call trickles dozens,
      // and each one carries a private IP address.
      return relaySignal('webrtc_ice', p, { candidate: p.candidate }, ack);
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
