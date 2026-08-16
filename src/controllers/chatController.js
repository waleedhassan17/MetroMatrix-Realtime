const asyncHandler = require('express-async-handler');
const ChatMessage = require('../models/ChatMessage');
const { resolveRoom } = require('../utils/access');
const { deliverMessage } = require('../services/chatService');
const { toChatMessageDTO, toParticipantDTO } = require('../utils/serialize');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

// ============================================================================
// The response here is a strict SUPERSET of the main backend's
// GET /api/chat/:bookingId, so repointing the app's base URL at this service is
// a transparent swap: `bookingId`, `participants.user`, `participants.provider`
// and the message DTO are all byte-compatible. Added on top: `roomId`,
// `roomType`, `role`, `phoneNumber` on participants (for the native dialer),
// and real cursor pagination.
// ============================================================================

// GET /api/chat/:roomId?roomType=homeservice|healthcare&before=<msgId>&limit=30
const getChatData = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const access = await resolveRoom(roomId, req.auth.id, req.query.roomType);
  if (!access) {
    return res.status(403).json({ success: false, message: 'Not a participant of this room' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

  // Scoped by room id ONLY — never also by roomType. Messages written by the
  // main backend predate the roomType field, so filtering on it would silently
  // hide all pre-existing history. See src/models/ChatMessage.js.
  const q = { booking: roomId };
  if (req.query.before) {
    if (!/^[0-9a-fA-F]{24}$/.test(req.query.before)) {
      return res.status(400).json({ success: false, message: 'before must be a message id' });
    }
    q._id = { $lt: req.query.before };
  }

  // One extra row tells us whether another page exists without a count query.
  const page = await ChatMessage.find(q).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = page.length > limit;
  const rows = (hasMore ? page.slice(0, limit) : page).reverse(); // oldest → newest

  const user = toParticipantDTO(access.participants.user);
  const counterpart = toParticipantDTO(access.participants.counterpart);

  res.json({
    success: true,
    data: {
      // Legacy key — the app's chatDataSerializer reads `payload.bookingId`.
      bookingId: String(roomId),
      roomId: String(roomId),
      roomType: access.roomType,
      role: access.role,
      status: access.status,
      participants: {
        user,
        // `provider` is the name the app expects; `counterpart` is the
        // vertical-neutral name (it is the doctor for healthcare rooms).
        provider: counterpart,
        counterpart,
      },
      messages: rows.map(toChatMessageDTO),
      hasMore,
      nextCursor: hasMore && rows.length ? String(rows[0].id || rows[0]._id) : null,
    },
  });
});

// POST /api/chat/:roomId/messages   { text } or { message }
// REST fallback for when the socket is down. Goes through the same
// chatService.deliverMessage as the socket path, so it also broadcasts and
// pushes — previously it did neither.
const postMessage = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  // The app posts { message }; newer clients post { text }. Accept both.
  const body = (req.body?.text || req.body?.message || '').trim();
  if (!body) return res.status(400).json({ success: false, message: 'text required' });
  if (body.length > 2000) {
    return res.status(400).json({ success: false, message: 'Message too long' });
  }

  const access = await resolveRoom(roomId, req.auth.id, req.body?.roomType || req.query.roomType);
  if (!access) return res.status(403).json({ success: false, message: 'Not a participant' });

  const { dto } = await deliverMessage({
    access,
    senderId: req.auth.id,
    text: body,
    clientMsgId: req.body?.clientMsgId,
  });

  res.status(201).json({ success: true, data: dto });
});

module.exports = { getChatData, postMessage };
