// ============================================================================
// Wire DTOs.
//
// toChatMessageDTO is BYTE-IDENTICAL to the main backend's `toChatMessage`
// (src/modules/homeservice/controllers/chatController.js). That is deliberate:
// the mobile app's chatMessageSerializer reads `data.id`, and its live-message
// dedupe is `prev.some(x => x.id === m.id)`. Emitting a raw Mongoose document
// instead would give every message `_id` and an undefined `id`, so the first
// message would append and every subsequent one would be silently dropped as a
// duplicate. Always serialize before emitting or returning.
// ============================================================================

function toChatMessageDTO(m) {
  return {
    id: String(m._id),
    text: m.text,
    sender: m.senderRole, // 'user' | 'provider'
    timestamp: (m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt)).toISOString(),
    status: m.readAt ? 'read' : 'delivered',
    // Additive — the app's serializer ignores unknown keys, so this stays
    // backward compatible while letting newer screens route by room.
    roomId: m.booking ? String(m.booking) : undefined,
    roomType: m.roomType || 'homeservice',
  };
}

/** Participant block. `expoPushTokens` is server-only and must never ship. */
function toParticipantDTO(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name || '',
    image: p.image,
    // The call screen needs this for the native-dialer handoff.
    phoneNumber: p.phoneNumber,
    ...(p.doctorId ? { doctorId: p.doctorId } : {}),
  };
}

module.exports = { toChatMessageDTO, toParticipantDTO };
