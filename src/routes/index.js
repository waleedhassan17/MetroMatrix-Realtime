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
const { invalidateRoom } = require('../utils/access');
const { forgetRoom, TRACKABLE_STATUSES } = require('../sockets/trackingHandler');
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
  'provider_nearby', // room-targeted: the provider is ~5 minutes away
  'identity_verified', // room-targeted: the customer verified the provider at the door

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

  // A status change makes this room's cached access stale — and the cache
  // holds the booking's STATUS, which the location relay gates on. Without
  // this, a provider who tapped "Start job" could have every position dropped
  // as "not trackable" for up to a minute, and one who finished kept being
  // relayed for up to a minute. Drop the cached access, and once the booking
  // is no longer trackable drop its last known position too: location is
  // never retained past the trip (NFR-08).
  if (roomId && (event === 'booking_status_changed' || event === 'appointment_status_changed')) {
    invalidateRoom(String(roomId));
    const status = payload && payload.status;
    if (event === 'booking_status_changed' && status && !TRACKABLE_STATUSES.includes(status)) {
      forgetRoom(String(roomId));
    }
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
const PUSHABLE_TYPES = new Set([
  'booking_created', // provider: a new job request
  'booking_update', // customer: accepted / declined / on the way / arrived / done;
  //                   provider: the customer confirmed completion
  'booking_cancelled', // provider: the customer cancelled
  'payment_requested', // customer: the provider asked to be paid
  'payment_received', // provider: paid from the wallet; customer: cash confirmed
  'payment_update', // provider: the customer chose to pay in cash
  'booking_nearby', // customer: the provider is about 5 minutes away
  'booking_reminder', // both: an accepted job starts within the hour
  'review_received', // provider: a customer reviewed a finished job
  'identity_verified', // provider: the customer confirmed their identity at the door

  // Healthcare — every appointment notice in the inbox also arrives as a push.
  'appointment_update', // booked / confirmed / cancelled / rescheduled / completed
  'appointment_reminder', // patient: in about an hour
  'prescription_ready', // patient
  'video_call_starting', // patient: in about 5 minutes

  // Shopping
  'order_created', // vendor: a new order for their brand
  'order_update', // customer: confirmed / shipped / out for delivery / delivered / cancelled / refunded
  'return_update', // vendor: a return was requested
  'product_moderation', // vendor: a product was approved / rejected / removed
]);

/** How long a push is worth delivering late. A reminder after the event is noise. */
const PUSH_TTL_SECONDS = {
  video_call_starting: 15 * 60,
  booking_nearby: 15 * 60,
  identity_verified: 15 * 60,
  appointment_reminder: 2 * 60 * 60,
  booking_reminder: 2 * 60 * 60,
};

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
        // One entry per booking / appointment / order — a retry or the next
        // status updates the notification rather than stacking. Keyed on the
        // entity, or all of one user's appointment (or order) pushes would
        // replace each other.
        collapseKey: `${type}:${
          (data && (data.bookingId || data.appointmentId || data.orderId)) || userId
        }`,
        // A day by default. A job request older than that belongs in the app,
        // not in a notification arriving out of nowhere.
        ttlSeconds: PUSH_TTL_SECONDS[type] || 86400,
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

/**
 * Live usage, for the admin dashboard's "right now" tiles (the main API's
 * /api/admin/analytics/realtime reads this). Counts only — no identities.
 */
router.get('/internal/stats', requireInternalKey, (req, res) => {
  const { getIO } = require('../sockets/io');
  const presence = require('../services/presence');
  const { activeCalls } = require('../services/callService');
  const byRole = { user: 0, provider: 0, admin: 0, other: 0 };
  const seen = new Set();
  const io = getIO();
  if (io) {
    for (const socket of io.of('/').sockets.values()) {
      const uid = socket.data && socket.data.userId;
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      const role = socket.data.userType;
      byRole[byRole[role] !== undefined ? role : 'other'] += 1;
    }
  }
  res.json({
    success: true,
    data: {
      onlineAccounts: presence.onlineCount(),
      onlineByRole: byRole,
      activeCalls: new Set([...activeCalls.values()].map((c) => c && c.callId).filter(Boolean)).size,
      uptimeSeconds: Math.round(process.uptime()),
      at: new Date().toISOString(),
    },
  });
});

module.exports = router;
module.exports.EMITTABLE_EVENTS = EMITTABLE_EVENTS;
module.exports.PUSHABLE_TYPES = PUSHABLE_TYPES;
