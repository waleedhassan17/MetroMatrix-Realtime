const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set — copy it from the main backend .env');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log('[db] connected to shared MongoDB');
}

module.exports = { connectDB };
