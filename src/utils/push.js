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

/**
 * Best-effort push. NEVER throws — a failed notification must not fail the
 * message or call that triggered it.
 *
 * @param {string[]} tokens
 * @param {{title:string, body:string, data:object, channelId?:string}} payload
 */
async function sendPush(tokens, { title, body, data, channelId = 'messages' }) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return;

  for (const group of chunk(list, CHUNK_SIZE)) {
    try {
      const res = await fetch(EXPO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(process.env.EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(
          group.map((to) => ({
            to,
            title,
            body,
            data,
            sound: 'default',
            // 'calls' is the ringtone-style channel; 'messages' is quieter.
            channelId,
            priority: 'high',
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
