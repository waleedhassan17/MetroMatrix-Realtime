const Booking = require('../models/Booking');

// Returns { booking, role } if userId is a participant of the booking, else null.
// role is 'user' (customer) or 'provider'.
// NOTE: adjust `customer` / `provider` below if your real booking schema uses
// different field names (e.g. `user`). This is the single most important field
// mapping for the whole call flow.
async function loadBookingWithAccess(bookingId, userId) {
  let booking;
  try {
    booking = await Booking.findById(bookingId).lean();
  } catch {
    return null;
  }
  if (!booking) return null;
  const customerId = String(booking.customer);
  const providerId = String(booking.provider);
  if (String(userId) === customerId) return { booking, role: 'user' };
  if (String(userId) === providerId) return { booking, role: 'provider' };
  return null;
}

module.exports = { loadBookingWithAccess };
