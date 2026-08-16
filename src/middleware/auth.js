const jwt = require('jsonwebtoken');

// ============================================================================
// Verifies tokens minted by the MAIN MetroMatrix backend using the SHARED
// JWT_SECRET. This service never issues tokens of its own.
//
// The main backend signs (src/utils/generateToken.js):
//     jwt.sign({ id, userType, email, ... }, process.env.JWT_SECRET, ...)
// so the defaults below are `id` and `userType` — NOT `role`. The previous
// default of 'role' silently produced `undefined`, which made the call handler
// treat every caller as a provider and push the ring to the wrong party.
//
// NOTE ON ROLE: `userType` is only good enough to pick a COLLECTION
// (user vs provider) for the push-token route, which has no room context.
// Anything room-scoped must take its role from src/utils/access.js, which
// derives it from actual booking/appointment membership. Doctors sign in as
// userType 'provider', so the claim alone can never distinguish a doctor from
// a home-service provider anyway.
// ============================================================================

const ID_CLAIM = process.env.JWT_ID_CLAIM || 'id';
const ROLE_CLAIM = process.env.JWT_ROLE_CLAIM || 'userType';

/**
 * Fail fast at boot rather than surfacing a missing secret as a generic 401 on
 * the first user request.
 */
function assertJwtConfig() {
  if (!process.env.JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is not set. It must be byte-identical to the main backend\'s ' +
        'JWT_SECRET or no token will verify.'
    );
  }
}

function decodeToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const id = decoded[ID_CLAIM] || decoded.id || decoded._id || decoded.userId;
  const role = decoded[ROLE_CLAIM] || decoded.userType || decoded.role;
  if (!id) throw new Error('token has no recognizable user id claim');
  return { id: String(id), role, raw: decoded };
}

/** Express middleware for the REST endpoints. */
function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token' });
    req.auth = decodeToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

/**
 * Socket.IO handshake auth — same secret, same payload shape.
 * An expired token is rejected here, which is what forces the client to
 * reconnect through refreshSocketAuth() after a token refresh.
 */
function socketAuth(socket, next) {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('No token'));
    const { id, role, raw } = decodeToken(token);
    socket.data.userId = id;
    // Kept for the push-token path only. Room-scoped role comes from access.js.
    socket.data.userType = role;
    // The handshake is verified once; without recording expiry, a socket opened
    // hours ago stays authorized forever. Swept in sockets/index.js.
    socket.data.exp = raw.exp;
    next();
  } catch (e) {
    next(new Error('Invalid or expired token'));
  }
}

module.exports = { protect, socketAuth, decodeToken, assertJwtConfig };
