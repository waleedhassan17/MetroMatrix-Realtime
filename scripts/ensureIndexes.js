require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/db');

// ============================================================================
// Deliberate, opt-in index creation.
//
// autoIndex is OFF at runtime (see src/config/db.js) so a dyno restart can
// never mutate collections the main backend owns. This script creates only the
// indexes this service actually needs:
//
//   calllogs        — entirely owned by this service
//   hschatmessages  — SHARED with main. The added { booking: 1, _id: -1 } index
//                     backs the `?before=` cursor page; without it a long
//                     thread does an in-memory sort on every history fetch.
//                     Adding an index does not change data, but it is still a
//                     write against a shared collection, so it happens here and
//                     not implicitly on boot.
//
// Run once after deploy:  npm run ensure-indexes
// ============================================================================

(async () => {
  try {
    await connectDB();

    const CallLog = require('../src/models/CallLog');
    const ChatMessage = require('../src/models/ChatMessage');

    for (const Model of [CallLog, ChatMessage]) {
      console.log(`[indexes] building for ${Model.collection.collectionName}...`);
      await Model.createIndexes();
    }

    console.log('[indexes] done');
    console.log('[indexes] current hschatmessages indexes:');
    console.log(await ChatMessage.collection.indexes());

    await mongoose.connection.close();
    process.exit(0);
  } catch (e) {
    console.error('[indexes] failed:', e.message);
    process.exit(1);
  }
})();
