const router = require('express').Router();
const { protect } = require('../middleware/auth');
const chat = require('../controllers/chatController');
const push = require('../controllers/pushController');

// Health check (Heroku / uptime pings).
router.get('/health', (req, res) => res.json({ ok: true, service: 'metromatrix-realtime' }));

// Chat REST (history + fallback send).
router.get('/chat/:bookingId', protect, chat.getChatData);
router.post('/chat/:bookingId/messages', protect, chat.postMessage);

// Push token registration.
router.post('/users/me/push-token', protect, push.savePushToken);

module.exports = router;
