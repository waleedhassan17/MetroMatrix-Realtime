// ============================================================================
// Socket.IO does NOT catch rejected promises returned by an event listener.
// On Node >= 15 an unhandled rejection terminates the process by default, so a
// single bad event — a validation error on one message, a transient Mongo blip
// — takes the whole dyno down and disconnects every other user on it.
//
// Every listener in this service is wrapped. The client always gets an ack (or
// silence, for fire-and-forget events); the process always survives.
// ============================================================================

/**
 * @param {string}   name  event name, for logs
 * @param {Function} fn    async (payload, ack) => void
 */
function safeHandler(name, fn) {
  return async (payload = {}, ack) => {
    try {
      await fn(payload, typeof ack === 'function' ? ack : undefined);
    } catch (e) {
      // Log the event and the message only — payloads may contain chat text.
      console.error(`[socket] handler '${name}' threw: ${e.message}`);
      if (typeof ack === 'function') {
        ack({ success: false, message: 'Server error' });
      }
    }
  };
}

module.exports = { safeHandler };
