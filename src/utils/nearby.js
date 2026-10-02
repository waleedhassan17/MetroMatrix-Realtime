// ============================================================================
// "About 5 minutes away" — the pure part, so it can be tested without sockets.
// Thresholds match the main API's services/nearbyService.js.
// ============================================================================

const NEARBY_DISTANCE_M = 1500;
const NEARBY_ETA_MIN = 5;
const CITY_SPEED_KMH = 25;
const LAHORE_PLACEHOLDER = [74.3587, 31.5204];

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

function etaMinutes(distanceMeters, speedKmh = CITY_SPEED_KMH) {
  return Math.max(1, Math.round((distanceMeters / 1000 / speedKmh) * 60));
}

function shouldNotifyNearby(distanceMeters) {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return false;
  return distanceMeters <= NEARBY_DISTANCE_M || etaMinutes(distanceMeters) <= NEARBY_ETA_MIN;
}

/**
 * The customer's address as { latitude, longitude }, or null when it was never
 * pinned — the booking placeholder [0, 0] and the old Lahore-centre default
 * are not places, and alerting against them would be a lie.
 */
function destinationOf(booking) {
  const c = booking && booking.address && booking.address.coordinates && booking.address.coordinates.coordinates;
  if (!Array.isArray(c) || c.length !== 2) return null;
  const [lng, lat] = c.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (lng === LAHORE_PLACEHOLDER[0] && lat === LAHORE_PLACEHOLDER[1]) return null;
  return { latitude: lat, longitude: lng };
}

module.exports = { haversineMeters, etaMinutes, shouldNotifyNearby, destinationOf, NEARBY_DISTANCE_M, NEARBY_ETA_MIN };
