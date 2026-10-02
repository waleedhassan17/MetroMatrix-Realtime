// ============================================================================
// Calls INTO the main API, server to server.
//
// Two things only this service can notice: a provider's live position coming
// within ~5 minutes of the customer (positions are never stored anywhere, so
// the main API cannot see them), and the passage of time (Vercel has no
// long-lived process to run timers). For both it asks the main API to act —
// the main API owns notifications, pushes and their exactly-once claims.
//
// Same shared key as the API's calls into us (x-internal-key), a hard timeout,
// and failures logged, never thrown.
// ============================================================================

const TIMEOUT_MS = 8000;

function configured() {
  return Boolean(process.env.MAIN_API_URL && process.env.INTERNAL_API_KEY);
}

async function callMainApi(path, body = {}, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!configured()) return { ok: false, reason: 'MAIN_API_URL / INTERNAL_API_KEY not set' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${process.env.MAIN_API_URL.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) console.error(`[main-api] ${path} → HTTP ${res.status}`);
    return { ok: res.ok, status: res.status, data: json && json.data };
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message;
    console.error(`[main-api] ${path} failed: ${reason}`);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callMainApi, configured };
