const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ChatMessage = require('../models/ChatMessage');
const Booking = require('../models/vendor/Booking');
const Appointment = require('../models/vendor/Appointment');
const Doctor = require('../models/vendor/Doctor');
const User = require('../models/User');
const Provider = require('../models/Provider');
const { getPresence } = require('../services/presence');

// ============================================================================
// GET /api/conversations — the caller's chat threads, both verticals, either
// role.
//
// WHY THIS LIVES HERE AND NOT ON THE MAIN BACKEND
// -----------------------------------------------
// This service already owns chat: it holds the messages, the read state, and
// the room-authorization rules. Building the same list on Vercel would mean a
// second place that knows how a room maps to a booking, and a second place to
// get the Doctor -> Provider identity hop wrong.
//
// WHAT COUNTS AS A CONVERSATION
// -----------------------------
// Every room the caller can currently reach — not only rooms that already have
// messages. An inbox that hides a job until somebody has spoken is useless to
// the person who wants to speak first, which on the provider side is the whole
// point. Terminal bookings with no history are dropped, because those are
// finished work nobody is going to message about; a terminal booking that DOES
// have history is kept, so the record stays readable.
//
// ROLE COMES FROM THE DATABASE, never from the JWT — same rule as
// utils/access.js, and for the same reason.
// ============================================================================

const MAX_ROOMS = 200;

// Mirrors statusMap's TERMINAL_STATUSES for home services, plus healthcare's
// own vocabulary. Kept as a plain Set so one lookup covers both verticals.
const FINISHED = new Set(['COMPLETED', 'REJECTED', 'CANCELLED', 'completed', 'cancelled']);

/**
 * Newest message and unread count for many rooms in ONE round trip.
 *
 * The obvious implementation — a findOne per room — is a query per conversation
 * and turns an inbox of 40 jobs into 40 sequential lookups. This is a single
 * aggregation keyed on the same { booking, _id } index the chat cursor uses.
 */
async function summarizeRooms(roomIds, viewerId) {
  if (!roomIds.length) return new Map();

  // AGGREGATION DOES NOT CAST. Unlike find(), the pipeline compares raw BSON, so
  // a string viewer id never equals an ObjectId `sender` — every message would
  // count as "from someone else and unread", including the viewer's own.
  const viewerOid = new mongoose.Types.ObjectId(String(viewerId));

  const rows = await ChatMessage.aggregate([
    { $match: { booking: { $in: roomIds } } },
    // Newest first, so $first below is the latest message in each room.
    { $sort: { _id: -1 } },
    {
      $group: {
        _id: '$booking',
        lastText: { $first: '$text' },
        lastAt: { $first: '$createdAt' },
        lastSenderRole: { $first: '$senderRole' },
        lastSender: { $first: '$sender' },
        unread: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$sender', viewerOid] },
                  { $not: [{ $in: [viewerOid, { $ifNull: ['$readBy', []] }] }] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  return new Map(rows.map((r) => [String(r._id), r]));
}

function shape(person, fallbackId) {
  return {
    id: String(person?._id || fallbackId || ''),
    name: person?.fullName || '',
    image: person?.profilePhoto || undefined,
  };
}

const getConversations = asyncHandler(async (req, res) => {
  const viewerId = req.auth.id;

  // --- which rooms is this person in? ---------------------------------------
  // A caller may legitimately be BOTH a customer and a provider (staff testing,
  // or a provider who books other services), so both sides are queried rather
  // than branching on a claimed role.
  const asDoctor = await Doctor.findOne({ providerId: viewerId }).select('_id').lean();

  const [bookings, appointments] = await Promise.all([
    Booking.find({ $or: [{ customer: viewerId }, { provider: viewerId }] })
      .select('customer provider status createdAt serviceCategory serviceSubCategory')
      .sort({ createdAt: -1 })
      .limit(MAX_ROOMS)
      .lean(),
    Appointment.find({
      $or: [{ patientId: viewerId }, ...(asDoctor ? [{ doctorId: asDoctor._id }] : [])],
    })
      .select('patientId doctorId status createdAt type')
      .sort({ createdAt: -1 })
      .limit(MAX_ROOMS)
      .lean(),
  ]);

  const roomIds = [...bookings.map((b) => b._id), ...appointments.map((a) => a._id)];
  const summaries = await summarizeRooms(roomIds, viewerId);

  // --- resolve the counterparts, batched ------------------------------------
  // One query per collection rather than per conversation.
  const userIds = new Set();
  const providerIds = new Set();
  const doctorIds = new Set();

  for (const b of bookings) {
    if (String(b.customer) === String(viewerId)) providerIds.add(String(b.provider));
    else userIds.add(String(b.customer));
  }
  for (const a of appointments) {
    if (String(a.patientId) === String(viewerId)) doctorIds.add(String(a.doctorId));
    else userIds.add(String(a.patientId));
  }

  // A doctor's counterpart id must be their PROVIDER id, because that is the id
  // their socket authenticates with — presence and calling both key on it.
  const doctorRows = doctorIds.size
    ? await Doctor.find({ _id: { $in: [...doctorIds] } }).select('providerId').lean()
    : [];
  const doctorToProvider = new Map(doctorRows.map((d) => [String(d._id), String(d.providerId)]));
  for (const providerId of doctorToProvider.values()) providerIds.add(providerId);

  const [users, providers] = await Promise.all([
    userIds.size
      ? User.find({ _id: { $in: [...userIds] } }).select('fullName profilePhoto').lean()
      : [],
    providerIds.size
      ? Provider.find({ _id: { $in: [...providerIds] } }).select('fullName profilePhoto').lean()
      : [],
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const providerById = new Map(providers.map((p) => [String(p._id), p]));

  // --- assemble -------------------------------------------------------------
  const conversations = [];

  const add = (roomId, roomType, role, counterpart, status, subtitle, createdAt) => {
    const summary = summaries.get(String(roomId));
    if (!summary && FINISHED.has(status)) return; // finished, never discussed
    conversations.push({
      roomId: String(roomId),
      roomType,
      role,
      status,
      subtitle,
      counterpart: (() => {
        const { status: presenceStatus, lastSeen } = getPresence(counterpart.id);
        return { ...counterpart, presence: presenceStatus, lastSeen };
      })(),
      lastMessage: summary
        ? {
            text: summary.lastText,
            at: summary.lastAt,
            // 'you' reads better in a list than the raw role, and the viewer's
            // own role is not always 'user'.
            fromSelf: String(summary.lastSender) === String(viewerId),
          }
        : null,
      unread: summary ? summary.unread : 0,
      // Sort key: last activity, falling back to when the room came into being
      // so a brand-new job with no messages still lands at the top.
      activityAt: summary ? summary.lastAt : createdAt,
    });
  };

  for (const b of bookings) {
    const iAmCustomer = String(b.customer) === String(viewerId);
    const counterpart = iAmCustomer
      ? shape(providerById.get(String(b.provider)), b.provider)
      : shape(userById.get(String(b.customer)), b.customer);
    add(
      b._id,
      'homeservice',
      iAmCustomer ? 'user' : 'provider',
      counterpart,
      b.status,
      b.serviceSubCategory || b.serviceCategory || '',
      b.createdAt
    );
  }

  for (const a of appointments) {
    const iAmPatient = String(a.patientId) === String(viewerId);
    const counterpart = iAmPatient
      ? shape(
          providerById.get(doctorToProvider.get(String(a.doctorId))),
          doctorToProvider.get(String(a.doctorId))
        )
      : shape(userById.get(String(a.patientId)), a.patientId);
    add(
      a._id,
      'healthcare',
      iAmPatient ? 'user' : 'provider',
      counterpart,
      a.status,
      a.type === 'video' ? 'Video consultation' : 'Clinic appointment',
      a.createdAt
    );
  }

  conversations.sort((x, y) => new Date(y.activityAt) - new Date(x.activityAt));

  console.log(`[conversations] user=${viewerId} rooms=${conversations.length}`);
  res.json({
    success: true,
    data: {
      conversations,
      totalUnread: conversations.reduce((n, c) => n + c.unread, 0),
    },
  });
});

module.exports = { getConversations };
