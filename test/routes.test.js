const test = require('node:test');
const assert = require('node:assert');

process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-key';
const { EMITTABLE_EVENTS, PUSHABLE_TYPES } = require('../src/routes/index');

test('every push type the main API sends is allow-listed', () => {
  const sentByMainApi = [
    'booking_created', 'booking_update', 'booking_cancelled', 'payment_requested', 'payment_received',
    'payment_update', 'booking_nearby', 'booking_reminder', 'review_received', 'identity_verified',
    'appointment_update', 'appointment_reminder', 'prescription_ready', 'video_call_starting',
    'order_created', 'order_update', 'return_update', 'product_moderation',
  ];
  for (const t of sentByMainApi) assert.ok(PUSHABLE_TYPES.has(t), `${t} missing`);
});

test('the nearby room event is emittable; arbitrary events are not', () => {
  assert.ok(EMITTABLE_EVENTS.has('provider_nearby'));
  assert.ok(EMITTABLE_EVENTS.has('identity_verified'));
  assert.ok(EMITTABLE_EVENTS.has('payment_status_changed'));
  assert.equal(EMITTABLE_EVENTS.has('call_ring'), false);
  assert.equal(EMITTABLE_EVENTS.has('new_message'), false);
});
