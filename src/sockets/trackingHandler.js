const { resolveRoom } = require('../utils/access');
const { safeHandler } = require('./safeHandler');
const { emitToRoom } = require('./io');

// ============================================================================
// Provider location sharing (live tracking).
//
// The provider app has been emitting `provider_location` from the map screen
// all along — with a comment claiming "backend enforces the EN_ROUTE/ARRIVED-
// only rule and the 3s throttle server-side". No such listener existed, so
// every position went nowhere and the customer's map never moved. The main
// backend's REST fallback was equally dead: it called an `emitToBooking` whose
// socket server is never initialised on Vercel.
//
// HOME SERVICES ONLY. A room is polymorphic, but a doctor has no location to
// share, so a healthcare room is rejected rather than silently broadcasting.
//
// FIELD NAMES DIFFER BY DIRECTION, ON PURPOSE — the client EMITS `lat`/`lng`
// but LISTENS for `latitude`/`longitude` (hooks/useRoomSocket.ts,
// ProviderLocationUpdate). Translate here; do not pass the payload through.
// ============================================================================

/** Statuses during which a provider is actually travelling to the customer. */
const TRACKABLE_STATUSES = ['EN_ROUTE', 'ARRIVED'];

/** One broadcast per room per this window. The app samples far more often. */
const THROTTLE_MS = 3000;

// Bounded for the same reason access.js bounds its cache: this runs on a
// long-lived dyno and an unbounded Map keyed by room id is a slow leak.
const CACHE_MAX = 5000;

/** roomId -> { at, payload } — last accepted position, for throttle + replay. */
const lastByRoom = new Map();

function rememberLocation(roomId, payload) {
  if (lastByRoom.size >= CACHE_MAX && !lastByRoom.has(roomId)) {
    // Map preserves insertion order — drop the oldest entry.
    lastByRoom.delete(lastByRoom.keys().next().value);
  }
  lastByRoom.delete(roomId);
  lastByRoom.set(roomId, { at: Date.now(), payload });
}

/**
 * Last known position for a room, or null. Used to replay on join so a customer
 * opening tracking mid-job sees a marker immediately instead of an empty map
 * until the provider's next sample.
 */
function getLastLocation(roomId) {
  return lastByRoom.get(String(roomId))?.payload || null;
}

/** Membership can change; drop the retained position with it. */
function forgetRoom(roomId) {
  lastByRoom.delete(String(roomId));
}

function registerTracking(io, socket) {
  const { userId } = socket.data;

  socket.on(
    'provider_location',
    safeHandler('provider_location', async (payload = {}, ack) => {
      const { roomId, bookingId, lat, lng, latitude, longitude, heading } = payload;
      const id = roomId || bookingId;
      if (!id) return ack?.({ success: false, message: 'roomId is required' });

      // Accept either spelling on the way in — the app sends lat/lng, but the
      // REST fallback shape uses latitude/longitude and both reach here.
      const finalLat = typeof lat === 'number' ? lat : latitude;
      const finalLng = typeof lng === 'number' ? lng : longitude;
      if (typeof finalLat !== 'number' || typeof finalLng !== 'number') {
        return ack?.({ success: false, message: 'lat and lng must be numbers' });
      }

      const access = await resolveRoom(id, userId, 'homeservice');
      if (!access) {
        console.log(`[tracking] DENIED room=${id} user=${userId} (not a participant)`);
        return ack?.({ success: false, message: 'Not a participant' });
      }

      // Only the provider may report a position. Without this a customer could
      // spoof the marker on their own booking.
      if (access.role !== 'provider') {
        console.log(`[tracking] DENIED room=${id} user=${userId} role=${access.role}`);
        return ack?.({ success: false, message: 'Only the provider can share location' });
      }

      if (access.roomType !== 'homeservice') {
        return ack?.({ success: false, message: 'Location sharing is home-service only' });
      }

      if (!TRACKABLE_STATUSES.includes(access.status)) {
        // Not an error: the app streams location while the screen is open and
        // the job may not have started yet. Ack success so it does not fall
        // back to REST on every sample.
        return ack?.({ success: true, data: { broadcast: false, reason: 'status' } });
      }

      const previous = lastByRoom.get(String(id));
      if (previous && Date.now() - previous.at < THROTTLE_MS) {
        return ack?.({ success: true, data: { broadcast: false, reason: 'throttled' } });
      }

      const broadcast = {
        bookingId: String(id),
        roomId: String(id),
        latitude: finalLat,
        longitude: finalLng,
        heading: typeof heading === 'number' ? heading : null,
        timestamp: new Date().toISOString(),
      };

      rememberLocation(String(id), broadcast);
      emitToRoom(id, 'provider_location_update', broadcast);

      return ack?.({ success: true, data: { broadcast: true } });
    })
  );
}

module.exports = registerTracking;
module.exports.getLastLocation = getLastLocation;
module.exports.forgetRoom = forgetRoom;
module.exports.TRACKABLE_STATUSES = TRACKABLE_STATUSES;
module.exports.THROTTLE_MS = THROTTLE_MS;
