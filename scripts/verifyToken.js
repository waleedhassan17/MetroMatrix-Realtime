require('dotenv').config();
const { decodeToken } = require('../src/middleware/auth');

// ============================================================================
// Verifies that a REAL access token minted by the main backend decodes with the
// secret configured here — i.e. that the shared-JWT half of the consistency
// contract actually holds.
//
//   node scripts/verifyToken.js "<paste an access token>"
//
// Prints the claim NAMES and the resolved id/role. Never prints the secret, and
// never prints claim values other than the id (which is not sensitive on its
// own and is the thing you need to confirm).
// ============================================================================

const token = process.argv[2];
if (!token) {
  console.error('usage: node scripts/verifyToken.js "<token>"');
  process.exit(1);
}

try {
  const { id, role, raw } = decodeToken(token);
  console.log('signature      : VALID (shared JWT_SECRET matches the main backend)');
  console.log('claims present :', Object.keys(raw).join(', '));
  console.log('resolved id    :', id);
  console.log('resolved role  :', role ?? '(none)');
  if (raw.exp) {
    const expiresAt = new Date(raw.exp * 1000);
    const mins = Math.round((expiresAt - Date.now()) / 60000);
    console.log('expires        :', expiresAt.toISOString(), `(${mins} min from now)`);
  }
  if (!raw.id && !raw._id && !raw.userId) {
    console.warn('\nWARNING: no id/_id/userId claim — set JWT_ID_CLAIM to the right name.');
  }
  if (role !== 'user' && role !== 'provider') {
    console.warn(`\nWARNING: role resolved to "${role}", expected 'user' or 'provider'.`);
    console.warn('Push-token registration routes on this value. Check JWT_ROLE_CLAIM.');
  }
  process.exit(0);
} catch (e) {
  console.error('signature      : INVALID —', e.message);
  console.error('\nThe JWT_SECRET here does not match the one the main backend signed with,');
  console.error('or the token has expired.');
  process.exit(1);
}
