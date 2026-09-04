const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const { requireInternalKey } = require('../middleware/internalAuth');
const chat = require('../controllers/chatController');
const conversations = require('../controllers/conversationsController');
const push = require('../controllers/pushController');
const turn = require('../controllers/turnController');
const call = require('../controllers/callController');
const { emitToRoom, emitToUser } = require('../sockets/io');
const { sendPush } = require('../utils/push');
const { MESSAGES_CHANNEL } = require('../utils/pushChannels');

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
  'booking_created', // user-targeted: tells a provider a new job is waiting
  'provider_location_update',
  'payment_requested', // room-targeted: provider asked the customer to pay
  'payment_received', // room-targeted: the customer actually paid

  // Healthcare
  'appointment_status_changed',
  'payment_status_changed',
  // Healthcare video call — publish points exist; the UI lands later.
  'video_call_started',
  'video_call_ended',
]);

router.post('/internal/emit', requireInternalKey, (req, res) => {
  // Two targets: a room (everyone watching one booking/appointment) or a person
  // (all of one user's devices, wherever they are in the app). The second is
  // for events about something the recipient is not yet inside — a provider
  // cannot be in a booking's room before they have been told it exists.
  const { roomId, userId, event, payload } = req.body || {};

  if (!event || (!roomId && !userId)) {
    return res
      .status(400)
      .json({ success: false, message: 'event and one of roomId / userId are required' });
  }
  if (!EMITTABLE_EVENTS.has(event)) {
    console.warn(
      `[internal] refused unlisted event '${event}' target=${roomId ? `room=${roomId}` : `user=${userId}`}`
    );
    return res
      .status(400)
      .json({ success: false, message: `Event '${event}' is not emittable` });
  }

  // No-ops before the socket server is up, which is correct: a publish that
  // arrives during boot is dropped rather than queued, and the client's
  // refetch-on-focus covers it.
  if (roomId) {
    emitToRoom(roomId, event, payload || {});
    console.log(`[internal] emit ${event} room=${roomId}`);
  } else {
    emitToUser(userId, event, payload || {});
    console.log(`[internal] emit ${event} user=${userId}`);
  }

  return res.status(204).end();
});

/**
 * Push to one user's devices, on behalf of the API server.
 *
 * `/internal/emit` only reaches a socket that is already connected, so a
 * provider with the app closed — the normal case for a new job arriving —
 * learns nothing until they next open it. Expo tokens live on the user
 * document in the shared database and `sendPush` lives here, so the API server
 * asks this service to send rather than duplicating the Expo client.
 *
 * Allowlisted by `type` for the same reason `/internal/emit` allowlists
 * events: the key must not become a way to push arbitrary text to any user.
 */
const PUSHABLE_TYPES = new Set(['booking_created']);

router.post('/internal/push', requireInternalKey, async (req, res) => {
  const { userId, role, type, title, body, data } = req.body || {};

  if (!userId || !type || !title) {
    return res
      .status(400)
      .json({ success: false, message: 'userId, type and title are required' });
  }
  if (!PUSHABLE_TYPES.has(type)) {
    console.warn(`[internal] refused unlisted push type '${type}' user=${userId}`);
    return res.status(400).json({ success: false, message: `Push type '${type}' is not allowed` });
  }

  // Best-effort by contract, like every other notification path: the caller
  // has already committed the booking, so a push failure must not read as one.
  try {
    // Tokens are role-scoped across two collections — savePushToken writes to
    // Provider for providers and User for customers, so reading the wrong one
    // silently finds nothing.
    const Model =
      role === 'provider' ? require('../models/Provider') : require('../models/User');
    const recipient = await Model.findById(userId).select('expoPushTokens').lean();
    if (recipient && recipient.expoPushTokens && recipient.expoPushTokens.length) {
      await sendPush(recipient.expoPushTokens, {
        title,
        body: body || '',
        channelId: MESSAGES_CHANNEL,
        // One entry per booking — a retry updates rather than stacks.
        collapseKey: `${type}:${(data && data.bookingId) || userId}`,
        // A day. A job request older than that belongs in the app, not in a
        // notification arriving out of nowhere.
        ttlSeconds: 86400,
        data: { type, ...(data || {}) },
      });
      console.log(`[internal] push ${type} user=${userId}`);
    } else {
      console.log(`[internal] push ${type} user=${userId} skipped — no tokens`);
    }
  } catch (e) {
    console.error(`[internal] push ${type} user=${userId} failed: ${e.message}`);
  }

  return res.status(204).end();
});

module.exports = router;
module.exports.EMITTABLE_EVENTS = EMITTABLE_EVENTS;
