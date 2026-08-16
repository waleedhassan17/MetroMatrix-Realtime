const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const routes = require('./routes');

const app = express();

// Heroku terminates TLS at its router, so the app sees a proxied request.
// Required for correct client IPs — which the rate limiter below keys on.
app.set('trust proxy', 1);

app.use(helmet());

const origins = (process.env.SOCKET_CORS_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({ origin: origins.includes('*') ? true : origins }));

// Chat messages cap at 2000 chars; nothing here needs the 100kb default.
app.use(express.json({ limit: '32kb' }));

// Mirrors the main backend's limiter. The socket layer has its own per-user
// token buckets (src/utils/rateLimit.js) — this only covers the REST surface.
app.use(
  '/api/',
  rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests' },
    // The health check is polled by Heroku and uptime monitors.
    skip: (req) => req.path === '/health',
  })
);

app.get('/', (req, res) => res.json({ service: 'metromatrix-realtime', status: 'up' }));
app.use('/api', routes);

// --- 404 -------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Not found: ${req.method} ${req.path}` });
});

// --- error handler ---------------------------------------------------------
// Without this, an async throw (a CastError from a malformed query param, say)
// falls through to Express's default handler, which in production returns an
// HTML stack trace with absolute file paths instead of the { success: false }
// shape every client here expects.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status =
    err.status || (err.name === 'CastError' || err.name === 'ValidationError' ? 400 : 500);
  // Log the message only — request bodies may contain chat text.
  console.error(`[http] ${status} ${req.method} ${req.path}: ${err.message}`);
  res.status(status).json({
    success: false,
    message: status === 500 ? 'Internal server error' : err.message,
  });
});

module.exports = app;
