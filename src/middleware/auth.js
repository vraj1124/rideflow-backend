const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query('SELECT id, email, role, is_active FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows.length || !result.rows[0].is_active) return res.status(401).json({ error: 'User not found or deactivated' });
    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(403).json({ error: 'Invalid token' });
  }
};
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
};
const requireDriver = requireRole('driver', 'admin');
const requireAdmin = requireRole('admin');
const requireRider = requireRole('rider', 'admin');
module.exports = { authenticateToken, requireRole, requireDriver, requireAdmin, requireRider };
