const ChatMessage = require('../models/ChatMessage');
const { sendPush } = require('../utils/push');
const { toChatMessageDTO } = require('../utils/serialize');
const { emitToRoom } = require('../sockets/io');

// ============================================================================
// The SINGLE message-delivery path, shared by the socket handler and the REST
// fallback controller.
//
// Previously the two diverged: the REST POST wrote the row and returned, with
// no `new_message` broadcast and no push. A message sent while the socket was
// down was therefore invisible to a connected peer until they reloaded, and
// generated no notification. Both callers now go through here so "sent over
// socket" and "sent over REST" are observationally identical.
// ============================================================================

/**
 * @param {object}  access  the resolved RoomAccess from utils/access.js
 * @param {string}  senderId
 * @param {string}  text    already-trimmed body
 * @param {string} [clientMsgId] client-generated idempotency key
 */
async function deliverMessage({ access, senderId, text, clientMsgId }) {
  // Idempotency: a client that retries a send (socket ack timed out, then the
  // REST fallback fired) would otherwise store the message twice. Backed by the
  // sparse unique index on { booking, clientMsgId }.
  if (clientMsgId) {
    const existing = await ChatMessage.findOne({
      booking: access.roomId,
      clientMsgId,
    }).lean();
    if (existing) return { dto: toChatMessageDTO(existing), duplicate: true };
  }

  const msg = await ChatMessage.create({
    booking: access.roomId,
    sender: senderId,
    senderRole: access.role, // DB-derived, never client-supplied
    roomType: access.roomType,
    text,
    clientMsgId,
    readBy: [senderId],
  });

  const dto = toChatMessageDTO(msg);

  // Fan out to the room, sender's other devices included; screens dedupe on id.
  emitToRoom(access.roomId, 'new_message', dto);

  // Never log message text.
  console.log(
    `[chat] message room=${access.roomId} type=${access.roomType} from=${senderId} len=${text.length}`
  );

  const recipient =
    access.role === 'user' ? access.participants.counterpart : access.participants.user;
  const sender =
    access.role === 'user' ? access.participants.user : access.participants.counterpart;

  // Best-effort — a push failure must never fail the message.
  sendPush(recipient.expoPushTokens, {
    title: sender.name || 'New message',
    body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    channelId: 'messages',
    data: { type: 'message', roomId: String(access.roomId), roomType: access.roomType },
  }).catch(() => {});

  return { dto, duplicate: false };
}

/** Mark everything the OTHER party sent in this room as read by me. */
async function markRead({ access, userId }) {
  await ChatMessage.updateMany(
    { booking: access.roomId, sender: { $ne: userId }, readAt: null },
    { $addToSet: { readBy: userId }, $set: { readAt: new Date() } }
  );
}

module.exports = { deliverMessage, markRead };
