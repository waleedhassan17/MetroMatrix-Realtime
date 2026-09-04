const { roomKey, userKey } = require('./keys');

// ============================================================================
// Holds the Socket.IO server instance.
//
// This lives in its own module ON PURPOSE. chatService needs to broadcast, and
// sockets/index.js needs chatHandler, which needs chatService — requiring the
// emitter from sockets/index.js would close that cycle and, because Node
// returns a partially-populated module during a circular require, `emitToRoom`
// would be `undefined` at call time. Keeping the reference here breaks the
// cycle without lazy requires scattered through the handlers.
// ============================================================================

let ioRef = null;

function setIO(io) {
  ioRef = io;
}

function getIO() {
  return ioRef;
}

/** Fan out to a room. No-ops before the socket server is up. */
function emitToRoom(roomId, event, payload) {
  if (!ioRef || !roomId) return;
  ioRef.to(roomKey(roomId)).emit(event, payload);
}

/**
 * Fan out to one PERSON, across every device they have connected.
 *
 * Every socket joins `user:<id>` on connect (see sockets/index.js), which is
 * what makes this reachable without knowing which screen they are on. Needed
 * for events about something the recipient is not yet inside — a provider
 * being told a new booking exists cannot be in that booking's room yet.
 *
 * No-ops before the socket server is up, same as emitToRoom.
 */
function emitToUser(userId, event, payload) {
  if (!ioRef || !userId) return;
  ioRef.to(userKey(userId)).emit(event, payload);
}

/**
 * Does this user have a socket JOINED TO THIS ROOM right now?
 *
 * Narrower than presence on purpose. Presence answers "are they connected at
 * all", which is not the question a chat notification needs — a user connected
 * but sitting on the bookings list still wants to be told a message arrived.
 * This answers "are they looking at this conversation", which is the only case
 * where a notification is pure noise on top of a message they just watched
 * appear.
 *
 * Conservative on failure: returns false, so an error means we notify rather
 * than silently swallow it. A duplicate notification is a nuisance; a missing
 * one is a missed message.
 */
async function isUserInRoom(roomId, userId) {
  if (!ioRef || !roomId || !userId) return false;
  try {
    const sockets = await ioRef.in(roomKey(roomId)).fetchSockets();
    return sockets.some((s) => String(s.data?.userId) === String(userId));
  } catch (e) {
    console.error(`[io] room membership check failed room=${roomId}: ${e.message}`);
    return false;
  }
}

module.exports = { setIO, getIO, emitToRoom, emitToUser, isUserInRoom };
