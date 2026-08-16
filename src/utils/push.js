// Expo push. Node 18+ has global fetch, so no extra dependency is needed.
async function sendPush(tokens, { title, body, data }) {
  const list = (tokens || []).filter(Boolean);
  if (!list.length) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(process.env.EXPO_ACCESS_TOKEN
          ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(
        list.map((to) => ({ to, title, body, data, priority: 'high', channelId: 'calls', sound: 'default' }))
      ),
    });
  } catch (e) {
    console.error('[push] send failed:', e.message);
  }
}
module.exports = { sendPush };
