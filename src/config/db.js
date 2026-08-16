const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set — copy it from the main backend .env');

  mongoose.set('strictQuery', true);

  // CRITICAL: this service shares a database with the main backend and must
  // never mutate collections main owns. autoIndex would have Mongoose build
  // every index declared in the vendored schemas (users, providers, hsbookings,
  // appointments, doctors) on boot. Index builds are additive, but they are
  // still writes against another service's collections during a dyno restart.
  // Indexes are created deliberately instead: npm run ensure-indexes
  mongoose.set('autoIndex', false);

  await mongoose.connect(uri, {
    // Fail a request fast rather than piling up when Mongo is unreachable.
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
  });

  console.log('[db] connected to shared MongoDB');
}

module.exports = { connectDB };
