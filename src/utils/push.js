const User = require('../models/User');
const Provider = require('../models/Provider');

// ============================================================================
// Expo push delivery, hand-rolled against the Expo HTTP API (no SDK dependency).
//
// Two things the previous version got wrong and this one fixes:
//   1. The response body was discarded, so Expo's per-ticket errors — most
//      importantly DeviceNotRegistered — were invisible and dead tokens
//      accumulated on user documents forever. We now read the tickets and prune.
//   2. Every notification was pinned to channelId 'calls'. A chat message
//      arriving on the high-priority ringtone channel is wrong; messages now go
//      to 'messages'.
//
// Expo caps a request at 100 messages, so we chunk.
// ============================================================================

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const CHUNK_SIZE = 100;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Remove tokens Expo has told us are permanently dead.
 * Uses updateOne/$pull — this service never calls .save() on a person document.
 */
async function pruneTokens(deadTokens) {
  if (!deadTokens.length) return;
  const update = { $pull: { expoPushTokens: { $in: deadTokens } } };
  await Promise.all([
    User.updateOne({ expoPushTokens: { $in: deadTokens } }, update),
    Provider.updateOne({ expoPushTokens: { $in: deadTokens } }, update),
  ]).catch((e) => console.error('[push] prune failed:', e.message));
  console.log(`[push] pruned ${deadTokens.length} dead token(s)`);
}

// An unset EXPO_ACCESS_TOKEN is not a soft degradation: with Expo's push
// security enabled, EVERY send is rejected with InvalidCredentials and not one
// notification is delivered. That failed silently as a per-ticket warning
// buried in the logs. Say it once, loudly, at the first send.
let warnedMissingCredentials = false;

function authHeader() {
  const token = process.env.EXPO_ACCESS_TOKEN;
  if (token) return { Authorization: `Bearer ${token}` };
  if (!warnedMissingCredentials) {
    warnedMissingCredentials = true;
    console.error(
      '[push] EXPO_ACCESS_TOKEN is not set — if this Expo project enforces push ' +
        'security every notification will be rejected as InvalidCredentials. ' +
        'Set it with: heroku config:set EXPO_ACCESS_TOKEN=<token>'
    );
  }
  return {};
}

/**
 * Best-effort push. NEVER throws — a failed notification must not fail the
 * message or call that triggered it.
 *
 * @param {string[]} tokens
 * @param {{title:string, body:string, data:object, channelId?:string,
 *          ttlSeconds?:number, collapseKey?:string, categoryId?:string}} payload
 */
async function sendPush(
  tokens,
  { title, body, data, channelId = 'messages', ttlSeconds, collapseKey, categoryId }
) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return;

  for (const group of chunk(list, CHUNK_SIZE)) {
    try {
      const res = await fetch(EXPO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...authHeader(),
        },
        body: JSON.stringify(
          group.map((to) => ({
            to,
            title,
            body,
            data,
            // The CHANNEL carries the ringtone on Android, not this field — a
            // channel's sound is fixed at creation and cannot be overridden per
            // notification. This is what iOS uses, and the Android fallback if
            // the channel is somehow missing.
            sound: 'default',
            channelId,
            priority: 'high',
            // A ring is worthless late: an expired call notification arriving
            // an hour afterwards is just confusing. Messages tolerate a delay.
            ...(ttlSeconds ? { ttl: ttlSeconds } : {}),
            // Collapse replaces the previous notification with the same key
            // instead of stacking. Twenty messages in one thread should be one
            // entry, not twenty.
            ...(collapseKey ? { collapseId: collapseKey } : {}),
            // Notification category — drives the Accept/Decline action buttons.
            ...(categoryId ? { categoryId } : {}),
            // iOS: put a call through a Focus/Do-Not-Disturb.
            ...(channelId.startsWith('calls') ? { interruptionLevel: 'time-sensitive' } : {}),
          }))
        ),
      });

      const json = await res.json().catch(() => null);
      const tickets = json?.data;
      if (!Array.isArray(tickets)) continue;

      const dead = [];
      tickets.forEach((ticket, i) => {
        if (ticket?.status !== 'error') return;
        // Log the CODE only — never the token or the notification body.
        console.warn(`[push] ticket error: ${ticket.details?.error || 'unknown'}`);
        if (ticket.details?.error === 'DeviceNotRegistered') dead.push(group[i]);
      });
      await pruneTokens(dead);
    } catch (e) {
      console.error('[push] send failed:', e.message);
    }
  }
}

module.exports = { sendPush };
