const test = require('node:test');
const assert = require('node:assert');

test('a tick POSTs the scheduler endpoint with the internal key, and never overlaps', async () => {
  process.env.MAIN_API_URL = 'https://api.example.test/';
  process.env.INTERNAL_API_KEY = 'k-1';
  const calls = [];
  let release;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    await new Promise((r) => (release = r));
    return { ok: true, status: 200, json: async () => ({ data: { tasks: { appointmentReminders: 0 } } }) };
  };
  const { tickOnce } = require('../src/services/scheduler');
  const first = tickOnce();
  const second = tickOnce(); // while the first is in flight
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/api/internal/scheduler/tick');
  assert.equal(calls[0].opts.headers['x-internal-key'], 'k-1');
  assert.equal(calls[0].opts.method, 'POST');
});

test('without configuration the scheduler does not start', () => {
  delete process.env.SCHEDULER_ENABLED;
  const { startScheduler } = require('../src/services/scheduler');
  assert.equal(startScheduler(), false);
});
