const { resolveRoom } = require('../utils/access');
const { deliverMessage, markRead } = require('../services/chatService');
const { allow } = require('../utils/rateLimit');
const { safeHandler } = require('./safeHandler');
const { roomKey } = require('./keys');

// ============================================================================
// Chat over the socket. Every event — including `typing`, which previously had
// no check at all and would blind-relay into any room id a client guessed — is
// authorized against live room membership.
//
// senderRole ALWAYS comes from access.role (derived from booking/appointment
// membership in the DB), never from the JWT. The token's userType cannot
// distinguish a doctor from a home-service provider, and a client-supplied role
// must never decide how a message is stored.
//
// Actual writing/fan-out/push lives in services/chatService.js so this and the
// REST fallback cannot drift apart.
// ============================================================================

module.exports = function registerChat(io, socket) {
  const { userId } = socket.data;

  async function authorize(roomId, roomType) {
    const access = await resolveRoom(roomId, userId, roomType);
    if (!access) return null;
    if (!socket.rooms.has(roomKey(roomId))) socket.join(roomKey(roomId));
    return access;
  }

  socket.on(
    'send_message',
    safeHandler('send_message', async ({ roomId, bookingId, roomType, text, message, clientMsgId }, ack) => {
      const id = roomId || bookingId; // bookingId accepted for older clients
      const body = (text || message || '').trim();

      if (!id || !body) return ack?.({ success: false, message: 'roomId and text required' });
      if (body.length > 2000) return ack?.({ success: false, message: 'Message too long' });
      if (!allow('send_message', userId)) {
        return ack?.({ success: false, message: 'Slow down', throttled: true });
      }

      const access = await authorize(id, roomType);
      if (!access) return ack?.({ success: false, message: 'Not a participant' });

      const { dto } = await deliverMessage({ access, senderId: userId, text: body, clientMsgId });
      // Ack shape matches the app's SocketAck ({ success, data }) — see
      // hooks/useBookingSocket.ts, which reads `ack.success && ack.data`.
      return ack?.({ success: true, data: dto });
    })
  );

  socket.on(
    'typing',
    safeHandler('typing', async ({ roomId, bookingId, roomType, isTyping }) => {
      const id = roomId || bookingId;
      if (!id) return;
      if (!allow('typing', userId)) return;

      const access = await authorize(id, roomType);
      if (!access) return; // silently ignore non-participants

      socket.to(roomKey(id)).emit('typing', {
        roomId: String(id),
        // The app gates on `p.bookingId === bookingId`; omitting this key made
        // typing indicators impossible to render.
        bookingId: String(id),
        userId: String(userId),
        isTyping: Boolean(isTyping),
      });
    })
  );

  socket.on(
    'mark_read',
    safeHandler('mark_read', async ({ roomId, bookingId, roomType }, ack) => {
      const id = roomId || bookingId;
      if (!id) return ack?.({ success: false, message: 'roomId required' });

      const access = await authorize(id, roomType);
      if (!access) return ack?.({ success: false, message: 'Not a participant' });

      await markRead({ access, userId });

      const payload = { roomId: String(id), bookingId: String(id), by: String(userId) };
      // Emit both names: the main backend and the app use `messages_read`; an
      // earlier build of this service used `read`.
      socket.to(roomKey(id)).emit('messages_read', payload);
      socket.to(roomKey(id)).emit('read', payload);
      return ack?.({ success: true });
    })
  );
};
