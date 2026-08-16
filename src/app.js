const express = require('express');
const cors = require('cors');
const routes = require('./routes');

const app = express();

const origins = (process.env.SOCKET_CORS_ORIGINS || '*').split(',').map((s) => s.trim());
app.use(cors({ origin: origins.includes('*') ? true : origins }));
app.use(express.json());

app.get('/', (req, res) => res.json({ service: 'metromatrix-realtime', status: 'up' }));
app.use('/api', routes);

module.exports = app;
