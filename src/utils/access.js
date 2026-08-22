const mongoose = require('mongoose');
const Booking = require('../models/vendor/Booking');
const Appointment = require('../models/vendor/Appointment');
const Doctor = require('../models/vendor/Doctor');
const User = require('../models/User');
const Provider = require('../models/Provider');

// ============================================================================
// Room access resolution — the single authority on "who is allowed in this
// room, and who is the other party".
//
// A room is EITHER:
//   homeservice → an HSBooking   (customer: User,  provider: Provider)
//   healthcare  → an Appointment (patientId: User, doctorId:  Doctor)
//
// THE IDENTITY HOP THAT MAKES HEALTHCARE WORK
// -------------------------------------------
// The main backend mints ONE kind of provider token. A doctor signs in with
// userType 'provider' and the token's `id` claim is their **Provider._id**.
// But Appointment.doctorId points at a **Doctor._id**, a different document in
// a different collection, linked back by Doctor.providerId.
//
// So a doctor is matched by:  Doctor.findOne({ providerId: <token id> })
//                             then compare that Doctor._id to appointment.doctorId
//
// And everywhere downstream — push tokens, CallLog.to, the busy-call map — the
// doctor is keyed by their **Provider._id**, because that is the id their
// socket connects with. Keying by Doctor._id anywhere would silently fail to
// match and calls would never route.
//
// Phone numbers for a doctor also come from the Provider document; the Doctor
// schema has no phone field at all.
//
// ROLE IS ALWAYS DERIVED HERE, FROM THE DATABASE — never from the JWT. The
// main backend's own middleware ignores the token's userType claim for the
// same reason (it re-looks-up which collection the id belongs to).
// ============================================================================

const ROOM_TYPES = ['homeservice', 'healthcare'];
const PERSON_FIELDS = 'fullName phoneNumber profilePhoto expoPushTokens';

// Membership rarely changes and this runs on EVERY socket event (chat send,
// typing, each call_* frame), so an unbounded cache would be a leak and no
// cache costs 1-3 DB round-trips per keystroke-adjacent event.
const CACHE_TTL_MS = 60 * 1000;

// Denials expire far sooner than grants, and the asymmetry is the point.
//
// A grant is safe to hold: membership of a booking effectively never changes
// once it exists. A DENIAL is different — it is usually "this booking did not
// exist yet when you asked", and it becomes wrong the instant the booking is
// created. Caching that for a full minute meant a customer who booked a
// service and immediately tapped Call was told "Not a participant" for up to
// 60 seconds, which reads as a broken feature rather than a stale cache.
//
// Five seconds still blunts a probing client (one DB lookup per room per 5s,
// which is what the negative cache is actually for) while keeping the
// book-then-call path feeling instant.
const NEGATIVE_CACHE_TTL_MS = 5 * 1000;

const CACHE_MAX = 5000;
const cache = new Map(); // `${roomId}:${userId}` -> { at, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  const ttl = hit.value ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return undefined;
  }
  // refresh LRU recency
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    // Map preserves insertion order — drop the oldest entry.
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { at: Date.now(), value });
}

/** Drop cached access for a room (call if membership can change mid-session). */
function invalidateRoom(roomId) {
  const prefix = `${roomId}:`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

function shapePerson(doc, fallbackId) {
  return {
    id: String(doc?._id || fallbackId || ''),
    name: doc?.fullName || undefined,
    image: doc?.profilePhoto || undefined,
    phoneNumber: doc?.phoneNumber || undefined,
    expoPushTokens: doc?.expoPushTokens || [],
  };
}

// --- home-service: HSBooking { customer, provider } -------------------------
async function resolveHomeservice(roomId, userId) {
  const booking = await Booking.findById(roomId).lean();
  if (!booking) return null;

  let role = null;
  if (String(booking.customer) === userId) role = 'user';
  else if (String(booking.provider) === userId) role = 'provider';
  if (!role) return null;

  const [user, provider] = await Promise.all([
    User.findById(booking.customer).select(PERSON_FIELDS).lean(),
    Provider.findById(booking.provider).select(PERSON_FIELDS).lean(),
  ]);

  return {
    roomType: 'homeservice',
    roomId: String(roomId),
    room: booking,
    role,
    status: booking.status,
    participants: {
      user: shapePerson(user, booking.customer),
      counterpart: shapePerson(provider, booking.provider),
    },
  };
}

// --- healthcare: Appointment { patientId, doctorId } ------------------------
async function resolveHealthcare(roomId, userId) {
  const appt = await Appointment.findById(roomId).lean();
  if (!appt) return null;

  let role = null;
  if (String(appt.patientId) === userId) {
    role = 'user';
  } else {
    // The caller's token carries a Provider._id — hop to their Doctor row.
    const asDoctor = await Doctor.findOne({ providerId: userId }).select('_id').lean();
    if (asDoctor && String(asDoctor._id) === String(appt.doctorId)) role = 'provider';
  }
  if (!role) return null;

  // Counterpart identity flows Doctor -> Provider so the id we hand out is the
  // one the doctor's socket authenticates with.
  const doctorRow = await Doctor.findById(appt.doctorId).select('providerId').lean();
  const [user, provider] = await Promise.all([
    User.findById(appt.patientId).select(PERSON_FIELDS).lean(),
    doctorRow ? Provider.findById(doctorRow.providerId).select(PERSON_FIELDS).lean() : null,
  ]);

  return {
    roomType: 'healthcare',
    roomId: String(roomId),
    room: appt,
    role,
    status: appt.status,
    participants: {
      user: shapePerson(user, appt.patientId),
      // id === Provider._id (NOT Doctor._id) — see the header note.
      counterpart: {
        ...shapePerson(provider, doctorRow?.providerId),
        doctorId: String(appt.doctorId),
      },
    },
  };
}

const RESOLVERS = {
  homeservice: resolveHomeservice,
  healthcare: resolveHealthcare,
};

/**
 * Resolve a room and the caller's role in it.
 *
 * @param {string} roomId   HSBooking _id or Appointment _id
 * @param {string} userId   the `id` claim from the main backend's JWT
 * @param {string} [roomType] 'homeservice' | 'healthcare'. Defaults to
 *   'homeservice' for backward compatibility with clients that predate the
 *   healthcare module. If the hinted type misses, the other is tried — one
 *   extra query only on the miss path — so an out-of-date client still works.
 * @returns {Promise<object|null>} null when the room does not exist or the
 *   caller is not a participant. Callers MUST treat null as "deny".
 */
async function resolveRoom(roomId, userId, roomType) {
  if (!roomId || !userId) return null;
  if (!mongoose.isValidObjectId(roomId)) return null;

  const uid = String(userId);
  const key = `${roomId}:${uid}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const hinted = ROOM_TYPES.includes(roomType) ? roomType : 'homeservice';
  const order = [hinted, ...ROOM_TYPES.filter((t) => t !== hinted)];

  let result = null;
  for (const type of order) {
    try {
      result = await RESOLVERS[type](roomId, uid);
    } catch (err) {
      // A malformed id or a transient DB error must read as "no access", never
      // as an unhandled rejection inside a socket handler.
      console.error(`[access] ${type} resolve failed room=${roomId}: ${err.message}`);
      result = null;
    }
    if (result) break;
  }

  // Negative results are cached too — otherwise a probing client could force an
  // unbounded stream of DB lookups — but on a much shorter TTL, so a room that
  // has just come into existence stops being denied almost immediately.
  cacheSet(key, result);
  return result;
}

module.exports = { resolveRoom, invalidateRoom, ROOM_TYPES };
