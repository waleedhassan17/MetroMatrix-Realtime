const { Server } = require('socket.io');
const { socketAuth } = require('../middleware/auth');
const { resolveRoom, counterpartOf } = require('../utils/access');
const presence = require('../services/presence');
const registerChat = require('./chatHandler');
const registerCall = require('./callHandler');
const registerTracking = require('./trackingHandler');
const { getLastLocation } = require('./trackingHandler');
const { safeHandler } = require('./safeHandler');
const { roomKey, userKey } = require('./keys');
const { setIO, getIO, emitToRoom } = require('./io');

// ============================================================================
// Socket.IO wiring.
//
// AUTHORIZATION MODEL: the handshake proves WHO you are (a token signed by the
// main backend with the shared secret); every room-scoped event separately
// proves you belong to THAT room, by re-resolving membership from the database.
// A socket that is not a participant is refused. There is deliberately no
// "trusted" client-supplied role or membership flag anywhere.
//
// LOGGING DISCIPLINE: room ids and user ids only. Never phone numbers, never
// message text, never tokens.
// ============================================================================

// Access tokens are short-lived but the handshake is only checked once, so a
// long-lived socket would stay authorized indefinitely. Sweep and disconnect
// expired sockets so the client's refresh path reconnects with a fresh token.
const TOKEN_SWEEP_MS = 60 * 1000;

function initSockets(server) {
  const origins = (process.env.SOCKET_CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const io = new Server(server, {
    cors: { origin: origins.includes('*') ? true : origins },
    // Heroku's router closes an idle connection at 55s (H15). The defaults
    // already keep us well inside that — do not raise them.
    pingInterval: 25000,
    pingTimeout: 20000,
  });
  setIO(io);

  io.use(socketAuth);

  io.on('connection', (socket) => {
    const { userId } = socket.data;

    // Personal room — lets the server ring this user on whatever screen they
    // are on, and lets call_busy reach one specific caller.
    socket.join(userKey(userId));

    // Presence is recorded here, but NOT broadcast here: at this instant the
    // socket is in no booking room, so there is nobody to tell. The room join
    // below is the first moment a counterpart exists to notify.
    const cameOnline = presence.register(userId, socket.id);
    console.log(
      `[socket] connect user=${userId} sid=${socket.id}${cameOnline ? ' (now online)' : ''}`
    );

    socket.on(
      'join_booking',
      safeHandler('join_booking', async ({ roomId, bookingId, roomType }, ack) => {
        const id = roomId || bookingId; // bookingId kept for older clients
        const access = await resolveRoom(id, userId, roomType);
        if (!access) {
          console.log(`[socket] join DENIED room=${id} user=${userId}`);
          return ack?.({ success: false, message: 'Not a participant' });
        }
        socket.join(roomKey(id));
        console.log(
          `[socket] join room=${id} type=${access.roomType} user=${userId} role=${access.role}`
        );
        socket.emit('joined_booking', {
          roomId: String(id),
          bookingId: String(id), // legacy key
          roomType: access.roomType,
          role: access.role,
        });
        // Tell the room this user is here. Connecting alone could not announce
        // this — the socket had joined no rooms yet — so this join IS the
        // "came online" moment from the counterpart's point of view.
        socket.to(roomKey(id)).emit('presence_update', presence.getPresence(userId));

        // And tell the joiner about the OTHER party, so a screen opening onto
        // an already-connected counterpart renders the truth immediately
        // instead of assuming online until something contradicts it.
        socket.emit('presence_update', presence.getPresence(counterpartOf(access).id));

        // Replay the last known provider position to whoever just joined, so a
        // customer opening live tracking mid-job gets a marker immediately
        // rather than an empty map until the provider's next sample.
        const lastLocation = getLastLocation(id);
        if (lastLocation) socket.emit('provider_location_update', lastLocation);

        // The client's joinBooking() waits on this ack with a 5s timeout;
        // without it every join appeared to time out.
        return ack?.({ success: true, data: { roomType: access.roomType, role: access.role } });
      })
    );

    socket.on('leave_booking', ({ roomId, bookingId } = {}) => {
      const id = roomId || bookingId;
      if (id) socket.leave(roomKey(id));
    });

    // Point query for the counterpart's presence — what a chat header needs on
    // mount, before any transition has happened to broadcast.
    //
    // Deliberately scoped to a ROOM rather than taking a list of user ids: the
    // room is what resolveRoom already authorizes, so this cannot be used to
    // probe whether an arbitrary user is online. You may ask about exactly one
    // person — the one you are already allowed to talk to.
    socket.on(
      'presence_get',
      safeHandler('presence_get', async ({ roomId, bookingId, roomType }, ack) => {
        const id = roomId || bookingId;
        const access = await resolveRoom(id, userId, roomType);
        if (!access) return ack?.({ success: false, message: 'Not a participant' });
        return ack?.({
          success: true,
          data: {
            roomId: String(id),
            ...presence.getPresence(counterpartOf(access).id),
          },
        });
      })
    );

    registerChat(io, socket);
    registerCall(io, socket);
    registerTracking(io, socket);

    // 'disconnecting', NOT 'disconnect'.
    //
    // Socket.IO clears socket.rooms BEFORE it emits 'disconnect', so by then
    // there is no record of which rooms this socket was in — and those rooms
    // are the only way to know who needs to be told the user went offline.
    // Doing this on 'disconnect' broadcast to an empty list and nobody ever
    // heard about a clean sign-out. 'disconnecting' is the one moment where the
    // membership still exists.
    socket.on('disconnecting', () => {
      const rooms = [...socket.rooms].filter((r) => r !== socket.id && r !== userKey(userId));

      // Only on the true online -> offline transition. A second device still
      // connected, or a reconnect that briefly overlapped this socket, means
      // the user never actually left.
      if (presence.deregister(userId, socket.id)) {
        const update = presence.getPresence(userId);
        for (const room of rooms) io.to(room).emit('presence_update', update);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnect user=${userId} sid=${socket.id} reason=${reason}`);
    });
  });

  // Disconnect sockets whose access token has expired.
  const sweeper = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const socket of io.sockets.sockets.values()) {
      const exp = socket.data?.exp;
      if (exp && exp < now) {
        console.log(`[socket] token expired user=${socket.data.userId} — disconnecting`);
        socket.emit('token_expired');
        socket.disconnect(true);
      }
    }
  }, TOKEN_SWEEP_MS);
  if (sweeper.unref) sweeper.unref();

  return io;
}

module.exports = { initSockets, emitToRoom, getIO };
