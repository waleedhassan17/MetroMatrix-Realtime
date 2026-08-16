const asyncHandler = require('express-async-handler');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const Provider = require('../models/Provider');
const { loadBookingWithAccess } = require('../utils/access');

// GET /api/chat/:bookingId?before=<msgId>&limit=30
// Returns participants (WITH phone numbers, for the call screen) + paginated history.
const getChatData = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  const access = await loadBookingWithAccess(bookingId, req.auth.id);
  if (!access) return res.status(403).json({ success: false, message: 'Not a participant of this booking' });
  const b = access.booking;

  const [customer, provider] = await Promise.all([
    User.findById(b.customer).select('fullName phoneNumber profilePhoto').lean(),
    Provider.findById(b.provider).select('fullName phoneNumber profilePhoto').lean(),
  ]);

  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const q = { bookingId };
  if (req.query.before) q._id = { $lt: req.query.before };
  const messages = await ChatMessage.find(q).sort({ _id: -1 }).limit(limit).lean();

  res.json({
    success: true,
    data: {
      participants: {
        user: {
          id: String(b.customer),
          name: customer?.fullName,
          image: customer?.profilePhoto || undefined,
          phoneNumber: customer?.phoneNumber || undefined,
        },
        provider: {
          id: String(b.provider),
          name: provider?.fullName,
          image: provider?.profilePhoto || undefined,
          phoneNumber: provider?.phoneNumber || undefined,
        },
      },
      messages: messages.reverse(), // oldest → newest for display
    },
  });
});

// POST /api/chat/:bookingId/messages  { text }
// REST fallback for sending a message when the socket isn't connected.
const postMessage = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ success: false, message: 'text required' });

  const access = await loadBookingWithAccess(bookingId, req.auth.id);
  if (!access) return res.status(403).json({ success: false, message: 'Not a participant' });

  const msg = await ChatMessage.create({
    bookingId,
    senderId: req.auth.id,
    senderRole: access.role,
    text: text.trim(),
  });
  res.status(201).json({ success: true, data: msg });
});

module.exports = { getChatData, postMessage };
