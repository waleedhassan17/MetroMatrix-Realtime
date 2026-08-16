const { Server } = require('socket.io');
const { socketAuth } = require('../middleware/auth');
const { resolveRoom } = require('../utils/access');
const registerChat = require('./chatHandler');
const registerCall = require('./callHandler');
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
    console.log(`[socket] connect user=${userId} sid=${socket.id}`);

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
        // The client's joinBooking() waits on this ack with a 5s timeout;
        // without it every join appeared to time out.
        return ack?.({ success: true, data: { roomType: access.roomType, role: access.role } });
      })
    );

    socket.on('leave_booking', ({ roomId, bookingId } = {}) => {
      const id = roomId || bookingId;
      if (id) socket.leave(roomKey(id));
    });

    registerChat(io, socket);
    registerCall(io, socket);

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
