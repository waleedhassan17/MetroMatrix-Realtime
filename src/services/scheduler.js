// ============================================================================
// The clock for the whole platform.
//
// The main API runs on Vercel — serverless, no process stays up — and Vercel
// Cron on the Hobby plan fires at most daily. Reminders ("your appointment is
// in an hour", "your job starts within the hour") and request expiry need a
// tick every few minutes, and this dyno never sleeps. So every TICK_MS it asks
// the main API to run its scheduled work (POST /api/internal/scheduler/tick).
//
// All the logic stays in the main API, and every task there claims each send
// atomically — so a second dyno, a late tick or the GitHub Actions watchdog
// overlapping this can never double-send. Enabled with SCHEDULER_ENABLED=true.
// ============================================================================

const { callMainApi, configured } = require('../utils/mainApi');

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS) || 5 * 60 * 1000;
const JITTER_MS = 30 * 1000;

let timer = null;
let running = false;
let stopped = true;

async function tickOnce() {
  if (running) return; // never overlap
  running = true;
  try {
    const r = await callMainApi('/api/internal/scheduler/tick', {}, { timeoutMs: 28000 });
    if (r.ok) console.log(`[scheduler] tick ok ${JSON.stringify((r.data && r.data.tasks) || {})}`);
  } finally {
    running = false;
  }
}

function scheduleNext() {
  if (stopped) return;
  timer = setTimeout(async () => {
    await tickOnce();
    scheduleNext();
  }, TICK_MS + Math.floor(Math.random() * JITTER_MS));
  if (timer.unref) timer.unref();
}

function startScheduler() {
  if (process.env.SCHEDULER_ENABLED !== 'true') return false;
  if (!configured()) {
    console.warn('[scheduler] SCHEDULER_ENABLED but MAIN_API_URL / INTERNAL_API_KEY missing — not started');
    return false;
  }
  stopped = false;
  scheduleNext();
  console.log(`[scheduler] started — every ${Math.round(TICK_MS / 1000)}s (+ jitter)`);
  return true;
}

function stopScheduler() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { startScheduler, stopScheduler, tickOnce, TICK_MS };
