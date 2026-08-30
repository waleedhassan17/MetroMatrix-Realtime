const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const { requireInternalKey } = require('../middleware/internalAuth');
const chat = require('../controllers/chatController');
const conversations = require('../controllers/conversationsController');
const push = require('../controllers/pushController');
const turn = require('../controllers/turnController');
const call = require('../controllers/callController');
const { emitToRoom } = require('../sockets/io');

const router = express.Router();

// Heroku/uptime probe. Reports DB connectivity so a dyno that booted but lost
// Mongo is visibly unhealthy instead of quietly failing every request.
router.get('/health', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    ok: dbUp,
    service: 'metromatrix-realtime',
    db: dbUp ? 'connected' : 'disconnected',
    uptime: Math.round(process.uptime()),
  });
});

// :roomId is polymorphic — an HSBooking _id or an Appointment _id. Pass
// ?roomType=healthcare for appointments; it defaults to homeservice.
router.get('/chat/:roomId', protect, chat.getChatData);
router.post('/chat/:roomId/messages', protect, chat.postMessage);

// The inbox: every room the caller can reach, both verticals, either role.
router.get('/conversations', protect, conversations.getConversations);

router.post('/users/me/push-token', protect, push.savePushToken);
router.delete('/users/me/push-token', protect, push.deletePushToken);

// Short-lived ICE servers for a WebRTC call. Same user-JWT gate as chat —
// minting a TURN credential costs relay bandwidth, so it is never anonymous.
router.get('/turn/credentials', protect, turn.getTurnCredentials);

// Decline a ringing call WITHOUT opening the app. The lock-screen notification's
// Decline button has no socket to emit over in a backgrounded or killed
// process, so it posts here instead. Same authorization and same state
// transition as the socket path — only the transport differs.
router.post('/calls/:callId/decline', protect, call.declineCall);

// ============================================================================
// INTERNAL: room-event bridge for the main backend.
//
// This service owns the only live socket — the main backend runs on Vercel and
// cannot hold one. Its own src/sockets/ layer was never initialised, so every
// booking_status_changed / payment / appointment event it "emitted" was a no-op
// swallowed by an empty catch. This is the path it publishes through instead.
//
// Deliberately roomType-agnostic: rooms are already polymorphic (an HSBooking
// _id or an Appointment _id), so home services and healthcare share this
// endpoint unchanged, and the upcoming video-call work needs no new transport —
// only new entries in EMITTABLE_EVENTS.
//
// Not user-authenticated: the caller is a server. See middleware/internalAuth.
// ============================================================================

/**
 * Allowlist. Without it, anyone holding the key could inject arbitrary events
 * into any room — including a forged `call_ring` or `new_message` that would
 * bypass every membership check the socket handlers enforce.
 */
const EMITTABLE_EVENTS = new Set([
  // Home services
  'booking_status_changed',
  'provider_location_update',
  'payment_requested',
  // Healthcare
  'appointment_status_changed',
  'payment_status_changed',
  // Healthcare video call — publish points exist; the UI lands later.
  'video_call_started',
  'video_call_ended',
]);

router.post('/internal/emit', requireInternalKey, (req, res) => {
  const { roomId, event, payload } = req.body || {};

  if (!roomId || !event) {
    return res
      .status(400)
      .json({ success: false, message: 'roomId and event are required' });
  }
  if (!EMITTABLE_EVENTS.has(event)) {
    console.warn(`[internal] refused unlisted event '${event}' room=${roomId}`);
    return res
      .status(400)
      .json({ success: false, message: `Event '${event}' is not emittable` });
  }

  // No-ops before the socket server is up, which is correct: a publish that
  // arrives during boot is dropped rather than queued, and the client's
  // refetch-on-focus covers it.
  emitToRoom(roomId, event, payload || {});
  console.log(`[internal] emit ${event} room=${roomId}`);

  return res.status(204).end();
});

module.exports = router;
module.exports.EMITTABLE_EVENTS = EMITTABLE_EVENTS;
