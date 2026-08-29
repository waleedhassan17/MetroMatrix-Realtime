require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const app = require('./src/app');
const { connectDB } = require('./src/config/db');
const { initSockets } = require('./src/sockets');
const { roomKey } = require('./src/sockets/keys');
const { getIO } = require('./src/sockets/io');
const { assertJwtConfig } = require('./src/middleware/auth');
const { assertInternalKeyConfig } = require('./src/middleware/internalAuth');
const { assertTurnConfig } = require('./src/controllers/turnController');
const { verifySharedSchema } = require('./src/utils/verifySchema');
const { startSweeper, closeAllOnShutdown } = require('./src/services/callService');
const presence = require('./src/services/presence');

const PORT = process.env.PORT || 5000;

// A crash here takes every connected socket down with it, so make failures loud
// rather than silent. Socket listeners are individually wrapped (see
// src/sockets/safeHandler.js); these are the last line of defence.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  process.exit(1);
});

(async () => {
  try {
    // Fail at boot on a missing secret rather than as a confusing 401 later.
    assertJwtConfig();
    // Same reasoning for the server-to-server key: without it every room event
    // the main backend publishes would 401, silently, in production.
    assertInternalKeyConfig();
    // And for TURN: unset means calls cannot fetch ICE servers, but chat and
    // signalling keep working — so warn, don't die.
    assertTurnConfig();
    await connectDB();

    // Confirms the shared collections exist and still carry the field names
    // this service depends on. This is the real guard against drift with the
    // main backend — more reliable than hoping a vendored copy is current.
    await verifySharedSchema();

    // Close out call rows orphaned by a previous crash, then keep sweeping.
    // Without this those rows keep their participants permanently "busy".
    startSweeper();

    const server = http.createServer(app);
    initSockets(server);

    server.listen(PORT, () => console.log(`[metromatrix-realtime] up on :${PORT}`));

    // Heroku cycles dynos daily, sends SIGTERM, and hard-kills at 30s.
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[shutdown] ${signal} received`);

      // Hard stop inside Heroku's 30s budget, in case a step wedges.
      const hardStop = setTimeout(() => {
        console.error('[shutdown] timed out — forcing exit');
        process.exit(1);
      }, 25000);
      if (hardStop.unref) hardStop.unref();

      const io = getIO();
      try {
        // Tell clients to reconnect deliberately instead of stampeding.
        io?.emit('server_shutdown', { reconnectInMs: 1000 });
        // Every in-flight call must be closed out, or its row stays open and
        // the busy fallback marks those users unreachable until the stale
        // sweeper catches them two hours later.
        await closeAllOnShutdown(io, roomKey);
        // Everyone is about to lose their socket. Stamp them last-seen-now so
        // the timestamps stay truthful for the seconds before this process dies.
        presence.clearAllOnShutdown();
      } catch (e) {
        console.error('[shutdown] call closeout failed:', e.message);
      }

      server.close(() => console.log('[shutdown] http server closed'));
      try {
        io?.close();
        await mongoose.connection.close(false);
        console.log('[shutdown] mongo closed');
      } catch (e) {
        console.error('[shutdown] close failed:', e.message);
      }
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (e) {
    console.error('[startup] failed', e);
    process.exit(1);
  }
})();
