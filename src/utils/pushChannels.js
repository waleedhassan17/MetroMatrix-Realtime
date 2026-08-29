// ============================================================================
// Android notification channel ids.
//
// THESE MUST MATCH THE APP EXACTLY (services/push/pushNotifications.ts). A
// channelId the device does not have does not fall back gracefully — Android
// routes it to the manifest's default channel, which for this app is
// `messages` (app.json). So a typo here does not break loudly; it makes every
// incoming call arrive as a quiet chat notification.
//
// WHY `calls_v2` AND NOT `calls`
// ------------------------------
// An Android notification channel is IMMUTABLE once created. Its sound,
// importance and vibration are fixed at creation and the app cannot change them
// afterwards — the user can, from system settings, but the app cannot. Every
// install that has already run the previous build has `calls` frozen at
// sound: 'default', which is a one-second blip, not a ringtone.
//
// The only way to ship a real looping ringtone to those installs is a NEW
// channel id. Bumping this constant and the app's constant in the SAME release
// is mandatory: ship one without the other and every call push lands on the
// default `messages` channel and rings quietly, which is worse than before.
//
// If the ringtone ever changes again, bump to calls_v3. Do not try to mutate.
// ============================================================================

const CALLS_CHANNEL = 'calls_v2';
const MESSAGES_CHANNEL = 'messages';

module.exports = { CALLS_CHANNEL, MESSAGES_CHANNEL };
