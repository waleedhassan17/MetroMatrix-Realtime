const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const Provider = require('../models/Provider');
const { sendPush } = require('../utils/push');
const { loadBookingWithAccess } = require('../utils/access');

module.exports = function registerChat(io, socket) {
  const { userId, role } = socket.data;

  async function ensureMember(bookingId) {
    if (socket.data[`member:${bookingId}`]) return true;
    const access = await loadBookingWithAccess(bookingId, userId);
    if (!access) return false;
    socket.join(`booking:${bookingId}`);
    socket.data[`member:${bookingId}`] = true;
    return true;
  }

  socket.on('send_message', async ({ bookingId, text }, ack) => {
    if (!(await ensureMember(bookingId))) return ack && ack({ ok: false, error: 'not a participant' });
    if (!text || !text.trim()) return ack && ack({ ok: false, error: 'empty' });

    const msg = await ChatMessage.create({ bookingId, senderId: userId, senderRole: role, text: text.trim() });
    io.to(`booking:${bookingId}`).emit('new_message', msg);
    if (ack) ack({ ok: true, message: msg });

    // Notify the other party (in case their app is backgrounded).
    try {
      const access = await loadBookingWithAccess(bookingId, userId);
      const b = access.booking;
      const recipientIsProvider = role === 'user';
      const RecipientModel = recipientIsProvider ? Provider : User;
      const recipientId = recipientIsProvider ? b.provider : b.customer;
      const SenderModel = role === 'user' ? User : Provider;
      const [recipient, sender] = await Promise.all([
        RecipientModel.findById(recipientId).select('expoPushTokens').lean(),
        SenderModel.findById(userId).select('fullName').lean(),
      ]);
      await sendPush(recipient && recipient.expoPushTokens, {
        title: (sender && sender.fullName) || 'New message',
        body: text.trim().slice(0, 120),
        data: { type: 'message', bookingId },
      });
    } catch (e) { /* push is best-effort; never fail the message on it */ }
  });

  socket.on('typing', ({ bookingId, isTyping }) => {
    socket.to(`booking:${bookingId}`).emit('typing', { userId, isTyping: !!isTyping });
  });

  socket.on('mark_read', async ({ bookingId }) => {
    if (!(await ensureMember(bookingId))) return;
    await ChatMessage.updateMany(
      { bookingId, senderId: { $ne: userId }, readBy: { $ne: userId } },
      { $addToSet: { readBy: userId } }
    );
    socket.to(`booking:${bookingId}`).emit('read', { by: userId, bookingId });
  });
};
