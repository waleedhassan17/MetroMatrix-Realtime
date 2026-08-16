const { roomKey } = require('./keys');

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

module.exports = { setIO, getIO, emitToRoom };
