const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const chat = require('../controllers/chatController');
const push = require('../controllers/pushController');

const router = express.Router();

// Heroku/uptime probe. Reports DB connectivity so a dyno that booted but lost
// Mongo is visibly unhealthy instead of quietly failing every request.
router.get('/health', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    ok: dbUp,
    service: 'metromatrix-realtime',
    db: dbUp ? 'connected' : 'disconnected',
    uptime: Math.round(process.uptime()),
  });
});

// :roomId is polymorphic — an HSBooking _id or an Appointment _id. Pass
// ?roomType=healthcare for appointments; it defaults to homeservice.
router.get('/chat/:roomId', protect, chat.getChatData);
router.post('/chat/:roomId/messages', protect, chat.postMessage);

router.post('/users/me/push-token', protect, push.savePushToken);
router.delete('/users/me/push-token', protect, push.deletePushToken);

module.exports = router;
