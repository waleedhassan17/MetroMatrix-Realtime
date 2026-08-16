const CallLog = require('../models/CallLog');
const User = require('../models/User');
const Provider = require('../models/Provider');
const { sendPush } = require('../utils/push');
const { loadBookingWithAccess } = require('../utils/access');

// Signalling only: ring / accept / decline / end travel over the socket; the
// actual voice call is the phone's native dialer on the client side. Every
// event is (a) authorized against booking membership and (b) written to the
// CallLog for accountability.
module.exports = function registerCall(io, socket) {
  const { userId, role } = socket.data;

  async function verify(bookingId) {
    const access = await loadBookingWithAccess(bookingId, userId);
    if (access && !socket.data[`member:${bookingId}`]) {
      socket.join(`booking:${bookingId}`);
      socket.data[`member:${bookingId}`] = true;
    }
    return access;
  }

  socket.on('call_ring', async ({ bookingId }) => {
    const access = await verify(bookingId);
    if (!access) return;
    const b = access.booking;

    socket.to(`booking:${bookingId}`).emit('call_ring', { bookingId, from: userId });

    const callerIsUser = role === 'user';
    const calleeId = callerIsUser ? b.provider : b.customer;
    const CalleeModel = callerIsUser ? Provider : User;
    const CallerModel = callerIsUser ? User : Provider;
    const [callee, caller] = await Promise.all([
      CalleeModel.findById(calleeId).select('expoPushTokens fullName').lean(),
      CallerModel.findById(userId).select('fullName phoneNumber').lean(),
    ]);

    await CallLog.create({ bookingId, from: userId, to: calleeId, fromRole: role, status: 'ring' });

    await sendPush(callee && callee.expoPushTokens, {
      title: 'Incoming call',
      body: `${(caller && caller.fullName) || 'Someone'} is calling you`,
      data: {
        type: 'call',
        bookingId,
        callerName: caller && caller.fullName,
        callerPhone: caller && caller.phoneNumber,
      },
    });
  });

  socket.on('call_accept', async ({ bookingId }) => {
    const access = await verify(bookingId);
    if (!access) return;
    socket.to(`booking:${bookingId}`).emit('call_accept', { bookingId, from: userId });
    await CallLog.findOneAndUpdate({ bookingId, status: 'ring' }, { status: 'accepted' }, { sort: { createdAt: -1 } });
  });

  socket.on('call_decline', async ({ bookingId }) => {
    const access = await verify(bookingId);
    if (!access) return;
    socket.to(`booking:${bookingId}`).emit('call_decline', { bookingId, from: userId });
    await CallLog.findOneAndUpdate(
      { bookingId, status: 'ring' },
      { status: 'declined', endedAt: new Date() },
      { sort: { createdAt: -1 } }
    );
  });

  socket.on('call_end', async ({ bookingId }) => {
    const access = await verify(bookingId);
    if (!access) return;
    socket.to(`booking:${bookingId}`).emit('call_end', { bookingId, from: userId });
    await CallLog.findOneAndUpdate(
      { bookingId, status: { $in: ['ring', 'accepted'] } },
      { status: 'ended', endedAt: new Date() },
      { sort: { createdAt: -1 } }
    );
  });
};
