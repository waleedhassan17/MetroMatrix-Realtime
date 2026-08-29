#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
// Two-socket live check for presence and the calling/ringing split.
//
// Proves the server-side halves of BUG-03 and BUG-04 without needing two
// physical phones — the device matrix still has to be run, but this catches a
// broken deploy in seconds rather than after a 20-minute build.
//
//   JWT_SECRET=…  MONGODB_URI=…  \
//   node scripts/verifyPresenceAndCalls.js <roomId> <userAId> <userBId> [url]
//
// <roomId>  a REAL HSBooking or Appointment _id
// <userA>   one participant's id (the id their JWT carries)
// <userB>   the other participant's id
// [url]     defaults to the live Heroku service
//
// Tokens are signed locally with the shared JWT_SECRET, exactly as the main
// backend signs them at login. Nothing is written to the database beyond the
// CallLog rows the calls themselves create.
// ============================================================================

require('dotenv').config();
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const [, , ROOM_ID, USER_A, USER_B, URL_ARG] = process.argv;
const URL = URL_ARG || 'https://metromatrix-realtime-1d7dadda1082.herokuapp.com';

if (!ROOM_ID || !USER_A || !USER_B) {
  console.error('usage: verifyPresenceAndCalls.js <roomId> <userAId> <userBId> [url]');
  process.exit(2);
}
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is required — it must match the main backend.');
  process.exit(2);
}

const sign = (id) =>
  jwt.sign({ id, userType: 'user' }, process.env.JWT_SECRET, { expiresIn: '10m' });

const connect = (id) =>
  new Promise((resolve, reject) => {
    const s = io(URL, { auth: { token: sign(id) }, transports: ['websocket'] });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(new Error(`${id}: ${e.message}`)));
  });

const emit = (s, event, payload) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ success: false, message: 'ack timeout' }), 8000);
    s.emit(event, payload, (ack) => {
      clearTimeout(t);
      resolve(ack || { success: true });
    });
  });

/** Resolve on the next occurrence of `event`, or null after ms. */
const waitFor = (s, event, ms = 5000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      s.off(event, onEvent);
      resolve(null);
    }, ms);
    const onEvent = (p) => {
      clearTimeout(t);
      s.off(event, onEvent);
      resolve(p || {});
    };
    s.on(event, onEvent);
  });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

(async () => {
  console.log(`\nRealtime check against ${URL}\n`);

  const a = await connect(USER_A);
  const b = await connect(USER_B);

  // --- 1. both parties can join a real room -------------------------------
  console.log('1. room membership');
  const joinA = await emit(a, 'join_booking', { roomId: ROOM_ID, bookingId: ROOM_ID });
  const joinB = await emit(b, 'join_booking', { roomId: ROOM_ID, bookingId: ROOM_ID });
  check('A joins', joinA.success, joinA.message);
  check('B joins', joinB.success, joinB.message);

  // --- 2. a fake room is refused cleanly ----------------------------------
  console.log('\n2. authorization');
  const fake = await emit(a, 'join_booking', { roomId: '0'.repeat(24) });
  check('nonexistent room refused', !fake.success, fake.message);

  // --- 3. presence: B is visible to A as online ---------------------------
  console.log('\n3. presence');
  const pres = await emit(a, 'presence_get', { roomId: ROOM_ID });
  check('presence_get authorized', pres.success, pres.message);
  check(
    'B reads as online while connected',
    pres.data && pres.data.status === 'online',
    pres.data && pres.data.status
  );

  // --- 4. presence: a clean disconnect is seen immediately ----------------
  const offline = waitFor(a, 'presence_update', 5000);
  b.disconnect();
  const update = await offline;
  check(
    'A is told B went offline',
    !!update && update.status === 'offline',
    update ? update.status : 'no presence_update received'
  );

  // --- 5. an offline callee must NOT ring ---------------------------------
  console.log('\n4. calling an offline callee');
  const unavailableEvent = waitFor(a, 'call_unavailable', 5000);
  const ringAck = await emit(a, 'call_ring', { roomId: ROOM_ID, bookingId: ROOM_ID });
  check(
    "ack says 'unavailable', not success",
    !ringAck.success && ringAck.reason === 'unavailable',
    `success=${ringAck.success} reason=${ringAck.reason}`
  );
  check('call_unavailable delivered to caller', !!(await unavailableEvent));

  // --- 6. an online callee DOES ring, and only then --------------------------
  console.log('\n5. calling an online callee');
  const b2 = await connect(USER_B);
  await emit(b2, 'join_booking', { roomId: ROOM_ID, bookingId: ROOM_ID });

  const incoming = waitFor(b2, 'call_ring', 6000);
  const ringing = waitFor(a, 'call_ringing', 8000);
  const ack2 = await emit(a, 'call_ring', { roomId: ROOM_ID, bookingId: ROOM_ID });
  check('ring accepted', ack2.success, ack2.message || ack2.reason);

  const inc = await incoming;
  check('callee receives call_ring', !!inc);

  // The caller must NOT be in "ringing" until the callee acknowledges. Nothing
  // has acked yet, so this must still be pending.
  const prematureRinging = await Promise.race([
    ringing.then(() => 'arrived'),
    new Promise((r) => setTimeout(() => r('pending'), 1200)),
  ]);
  check(
    'no call_ringing before the callee acknowledges',
    prematureRinging === 'pending',
    prematureRinging
  );

  if (inc && inc.callId) {
    await emit(b2, 'call_ringing', { callId: inc.callId, roomId: ROOM_ID });
    check('call_ringing reaches the caller after the ack', !!(await ringing));
    await emit(a, 'call_end', { callId: inc.callId, roomId: ROOM_ID, bookingId: ROOM_ID });
  }

  a.disconnect();
  b2.disconnect();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nharness error:', e.message, '\n');
  process.exit(1);
});
