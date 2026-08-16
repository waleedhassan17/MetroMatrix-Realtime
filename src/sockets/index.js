const { Server } = require('socket.io');
const { socketAuth } = require('../middleware/auth');
const { loadBookingWithAccess } = require('../utils/access');
const registerChat = require('./chatHandler');
const registerCall = require('./callHandler');

function initSockets(server) {
  const origins = (process.env.SOCKET_CORS_ORIGINS || '*').split(',').map((s) => s.trim());
  const io = new Server(server, {
    cors: { origin: origins.includes('*') ? true : origins },
  });

  // Every connection is authenticated with the SHARED JWT secret before it is
  // allowed to do anything.
  io.use(socketAuth);

  io.on('connection', (socket) => {
    const { userId, role } = socket.data;
    console.log(`[socket] connect user=${userId} role=${role}`);

    socket.on('join_booking', async ({ bookingId }) => {
      const access = await loadBookingWithAccess(bookingId, userId);
      if (!access) return; // not a participant → refuse to join the room
      socket.join(`booking:${bookingId}`);
      socket.data[`member:${bookingId}`] = true;
      socket.emit('joined_booking', { bookingId });
    });

    socket.on('leave_booking', ({ bookingId }) => {
      socket.leave(`booking:${bookingId}`);
      delete socket.data[`member:${bookingId}`];
    });

    registerChat(io, socket);
    registerCall(io, socket);

    socket.on('disconnect', () => console.log(`[socket] disconnect user=${userId}`));
  });

  return io;
}

module.exports = { initSockets };
