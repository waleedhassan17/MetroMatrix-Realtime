// Socket.IO room-name helpers. These names are internal to the server — the
// client never sees them and they are unrelated to the public event names.
//
// `room:` is deliberately not `booking:` any more: a room is now either a
// home-service booking or a healthcare appointment.
const roomKey = (roomId) => `room:${roomId}`;

// Every socket also joins a personal room on connect, so the server can reach a
// specific user (an incoming ring, a busy signal) without knowing which
// conversation screen they currently have open.
const userKey = (userId) => `user:${userId}`;

module.exports = { roomKey, userKey };
