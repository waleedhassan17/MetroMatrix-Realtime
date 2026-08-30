const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Provider = require('../models/Provider');

// Expo tokens look like ExponentPushToken[xxxxxxxx] (or the older FCM-style
// ExpoPushToken[...]). Rejecting anything else keeps junk out of the array that
// would then fail on every send.
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

// POST /api/users/me/push-token   { token }
//
// This is the ONE place this service writes to a person document, and it does
// so with updateOne/$addToSet — never .save(), which would run the main
// backend's password-hashing hooks if those schemas were ever vendored in.
//
// Collection choice comes from the JWT's userType claim, which is the only
// place it is trusted: there is no room context here to derive a role from.
// Doctors sign in as 'provider', so their token lands on the Provider document
// — which is correct, because that is the id their socket connects with and
// therefore the document the call handler reads tokens from.
const savePushToken = asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, message: 'token required' });
  if (!EXPO_TOKEN_RE.test(token)) {
    return res.status(400).json({ success: false, message: 'Not a valid Expo push token' });
  }

  const isProvider = req.auth.role === 'provider';
  const Model = isProvider ? Provider : User;

  const result = await Model.updateOne(
    { _id: req.auth.id },
    { $addToSet: { expoPushTokens: token } }
  );

  // A silent no-match used to return success, hiding a misrouted registration.
  if (result.matchedCount === 0) {
    return res.status(404).json({
      success: false,
      message: `No ${isProvider ? 'provider' : 'user'} found for this token`,
    });
  }

  console.log(`[push] registered token for ${isProvider ? 'provider' : 'user'}=${req.auth.id}`);
  res.json({ success: true });
});

// DELETE /api/users/me/push-token   { token }
// Called on logout so a shared device stops receiving the previous account's
// calls. Without this, tokens only ever accumulate.
const deletePushToken = asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, message: 'token required' });

  // REMOVED FROM BOTH COLLECTIONS, not just the caller's own role.
  //
  // A push token is DEVICE-scoped, not account-scoped. savePushToken $addToSets
  // it onto whichever collection the JWT role selects, so one phone that has
  // been used by a customer and by a provider ends up with the same token on a
  // User document AND a Provider document. Scoping the delete to the current
  // role left the other copy behind — and that device then kept ringing for an
  // account nobody was signed into any more, with the answer rejected as a
  // non-participant because the current session's JWT is a different person.
  //
  // A token can only ever mean "this device", so signing out should retire it
  // everywhere. Anyone still signed in on another device re-registers on their
  // next launch.
  await Promise.all([
    User.updateOne({ expoPushTokens: token }, { $pull: { expoPushTokens: token } }),
    Provider.updateOne({ expoPushTokens: token }, { $pull: { expoPushTokens: token } }),
  ]);

  console.log(`[push] unregistered token for ${req.auth.role || 'user'}=${req.auth.id}`);
  res.json({ success: true });
});

module.exports = { savePushToken, deletePushToken };
