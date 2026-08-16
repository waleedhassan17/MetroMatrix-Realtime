require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const { connectDB } = require('./src/config/db');
const { initSockets } = require('./src/sockets');

const PORT = process.env.PORT || 5000;

(async () => {
  try {
    await connectDB();
    const server = http.createServer(app);
    initSockets(server);
    server.listen(PORT, () => console.log(`[metromatrix-realtime] up on :${PORT}`));
  } catch (e) {
    console.error('[startup] failed', e);
    process.exit(1);
  }
})();
