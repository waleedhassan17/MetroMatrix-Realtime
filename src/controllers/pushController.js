const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Provider = require('../models/Provider');

// POST /api/users/me/push-token  { token }
// Stored in the SHARED database so this service can push to the right device
// when a call/message arrives. Uses updateOne ($addToSet) — this does NOT
// trigger any pre('save') hook, so it's safe against the password-rehash bug.
const savePushToken = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'token required' });
  const Model = req.auth.role === 'provider' ? Provider : User;
  await Model.updateOne({ _id: req.auth.id }, { $addToSet: { expoPushTokens: token } });
  res.json({ success: true });
});

module.exports = { savePushToken };
