const mongoose = require('mongoose');

// ============================================================================
// Boot-time drift detector.
//
// This service and the main backend stay consistent by sharing a database, not
// by calling each other. Nothing enforces that the field names this service
// reads still match what main writes — a rename on either side would surface as
// "chat is silently empty" or "calls ring the wrong person", both of which are
// miserable to debug in production.
//
// So at boot we sample one real document from each shared collection and check
// the field names we actually depend on. This catches drift far more reliably
// than trusting that a vendored copy of a schema file is still current.
//
// WARNS, never fails. An empty collection on a fresh database is legitimate,
// and refusing to boot over it would be worse than the drift it guards against.
// ============================================================================

const EXPECTATIONS = [
  {
    collection: 'users',
    fields: ['fullName', 'phoneNumber'],
    why: 'chat participant identity + native-dialer handoff',
  },
  {
    collection: 'providers',
    fields: ['fullName', 'phoneNumber'],
    why: 'counterpart identity for home-service and doctors',
  },
  {
    collection: 'hsbookings',
    fields: ['customer', 'provider'],
    why: 'home-service room membership',
  },
  {
    collection: 'appointments',
    fields: ['patientId', 'doctorId'],
    why: 'healthcare room membership',
  },
  {
    collection: 'doctors',
    fields: ['providerId'],
    why: 'the Doctor -> Provider identity hop that routes doctor calls',
  },
  {
    collection: 'hschatmessages',
    fields: ['booking', 'sender', 'senderRole', 'text'],
    why: 'shared chat history written by BOTH backends',
    // An empty chat collection is normal on a new deployment.
    allowEmpty: true,
  },
];

async function verifySharedSchema() {
  const db = mongoose.connection.db;
  const problems = [];

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  for (const { collection, fields, why, allowEmpty } of EXPECTATIONS) {
    if (!existing.has(collection)) {
      problems.push(`collection '${collection}' does not exist (needed for ${why})`);
      continue;
    }

    const sample = await db.collection(collection).findOne({}, { projection: fields.reduce((a, f) => ({ ...a, [f]: 1 }), {}) });
    if (!sample) {
      if (!allowEmpty) problems.push(`collection '${collection}' is empty — cannot verify ${fields.join(', ')}`);
      continue;
    }

    const missing = fields.filter((f) => sample[f] === undefined);
    if (missing.length) {
      problems.push(
        `collection '${collection}' is missing field(s) [${missing.join(', ')}] — needed for ${why}`
      );
    }
  }

  if (problems.length) {
    console.warn('='.repeat(72));
    console.warn('[schema] SHARED SCHEMA DRIFT DETECTED — chat/call may misbehave:');
    problems.forEach((p) => console.warn(`[schema]   - ${p}`));
    console.warn('[schema] Re-sync src/models/vendor/* from the main backend.');
    console.warn('='.repeat(72));
  } else {
    console.log('[schema] shared collections verified against the main backend');
  }

  return problems;
}

module.exports = { verifySharedSchema, EXPECTATIONS };
