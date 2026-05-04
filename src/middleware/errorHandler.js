const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err);
  if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
  if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
  if (err.code === '23505') return res.status(409).json({ error: 'Already exists' });
  if (err.code === '23503') return res.status(400).json({ error: 'Referenced record not found' });
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message });
};
class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AppError';
  }
}
module.exports = errorHandler;
module.exports.AppError = AppError;
