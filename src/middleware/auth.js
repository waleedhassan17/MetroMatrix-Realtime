const jwt = require('jsonwebtoken');

const ID_CLAIM = process.env.JWT_ID_CLAIM || 'id';
const ROLE_CLAIM = process.env.JWT_ROLE_CLAIM || 'role';

// Verifies a token minted by the MAIN backend using the SHARED JWT_SECRET.
function decodeToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const id = decoded[ID_CLAIM] || decoded.id || decoded._id || decoded.userId;
  const role = decoded[ROLE_CLAIM] || decoded.role;
  if (!id) throw new Error('token has no recognizable user id claim');
  return { id: String(id), role, raw: decoded };
}

// Express middleware for the REST endpoints.
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

// Socket.IO handshake auth — same secret, same payload shape.
function socketAuth(socket, next) {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('No token'));
    const { id, role } = decodeToken(token);
    socket.data.userId = id;
    socket.data.role = role;
    next();
  } catch (e) {
    next(new Error('Invalid or expired token'));
  }
}

module.exports = { protect, socketAuth, decodeToken };
