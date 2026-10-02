const test = require('node:test');
const assert = require('node:assert');
const { haversineMeters, etaMinutes, shouldNotifyNearby, destinationOf } = require('../src/utils/nearby');

test('nearby threshold: ≤1.5 km, or ≤5 min at city speed', () => {
  assert.equal(shouldNotifyNearby(800), true);
  assert.equal(shouldNotifyNearby(2000), true);
  assert.equal(shouldNotifyNearby(2400), false);
  assert.equal(shouldNotifyNearby(NaN), false);
  assert.equal(shouldNotifyNearby(-1), false);
});

test('eta at 25 km/h, never below a minute', () => {
  assert.equal(etaMinutes(2083), 5);
  assert.equal(etaMinutes(10), 1);
});

test('haversine Lahore → Islamabad ≈ 270 km', () => {
  const d = haversineMeters({ latitude: 31.5204, longitude: 74.3587 }, { latitude: 33.6844, longitude: 73.0479 });
  assert.ok(d > 265000 && d < 275000, `got ${d}`);
});

test('destinationOf refuses placeholders — no alert against an unpinned address', () => {
  const at = (c) => ({ address: { coordinates: { type: 'Point', coordinates: c } } });
  assert.deepEqual(destinationOf(at([74.41, 31.47])), { latitude: 31.47, longitude: 74.41 });
  assert.equal(destinationOf(at([0, 0])), null);
  assert.equal(destinationOf(at([74.3587, 31.5204])), null);
  assert.equal(destinationOf(at([])), null);
  assert.equal(destinationOf({}), null);
});
