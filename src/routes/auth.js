const express = require('express');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const router = express.Router();
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, getClient } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts' } });
const generateTokens = (userId, role) => {
  const accessToken = jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const refreshToken = uuidv4();
  return { accessToken, refreshToken };
};
router.post('/register', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('phone').isMobilePhone(),
  body('password').isLength({ min: 8 }),
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('role').isIn(['rider', 'driver']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { email, phone, password, firstName, lastName, role } = req.body;
    const existing = await query('SELECT id FROM users WHERE email = $1 OR phone = $2', [email, phone]);
    if (existing.rows.length) throw new AppError('Email or phone already registered', 409);
    const passwordHash = await bcrypt.hash(password, 12);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        'INSERT INTO users (email, phone, password_hash, first_name, last_name, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [email, phone, passwordHash, firstName, lastName, role]
      );
      const userId = userResult.rows[0].id;
      if (role === 'rider') {
        const category = req.body.category || 'general';
        const approvalStatus = category === 'general' ? 'approved' : 'pending';
        await client.query(
          'INSERT INTO riders (id, category, approval_status) VALUES ($1, $2, $3)',
          [userId, category, approvalStatus]
        );
      }
      else if (role === 'driver') {
        const { licenseNumber, licenseExpiry, vehiclePlate, vehicleMake, vehicleModel, vehicleYear } = req.body;
        await client.query('INSERT INTO drivers (id, license_number, license_expiry, vehicle_plate, vehicle_make, vehicle_model, vehicle_year) VALUES ($1,$2,$3,$4,$5,$6,$7)', [userId, licenseNumber, licenseExpiry, vehiclePlate, vehicleMake, vehicleModel, vehicleYear]);
      }
      await client.query('COMMIT');
      const { accessToken, refreshToken } = generateTokens(userId, role);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)', [userId, refreshToken, expiresAt]);
      res.status(201).json({ message: 'Account created', user: { id: userId, email, role, firstName, lastName }, accessToken, refreshToken });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  } catch (err) { next(err); }
});
router.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { email, password } = req.body;
    const result = await query('SELECT id, email, password_hash, role, is_active, first_name, last_name FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) throw new AppError('Invalid email or password', 401);
    if (!user.is_active) throw new AppError('Account deactivated', 403);
    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)', [user.id, refreshToken, expiresAt]);
    let extraData = {};
    if (user.role === 'rider') {
      const riderResult = await query('SELECT category, approval_status FROM riders WHERE id = $1', [user.id]);
      if (riderResult.rows.length > 0) {
        extraData = { category: riderResult.rows[0].category, approvalStatus: riderResult.rows[0].approval_status };
      }
    }
    res.json({ user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name, ...extraData }, accessToken, refreshToken });
  } catch (err) { next(err); }
});
router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    res.json({ message: 'Logged out' });
  } catch (err) { next(err); }
});
// Forgot password - send reset code
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    
    const result = await query('SELECT id, first_name FROM users WHERE email = $1', [email]);
    if (!result.rows.length) return res.status(404).json({ error: 'No account found with this email' });
    
    const user = result.rows[0];
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    
    // Store reset code
    await query(
      `INSERT INTO password_resets (user_id, code, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET code = $2, expires_at = $3`,
      [user.id, resetCode, expiresAt]
    );
    
    // Send email
    await sgMail.send({
      to: email,
      from: 'noreply@rideflow.com',
      subject: 'RideFlow Password Reset Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #3b82f6;">RideFlow Password Reset</h2>
          <p>Hi ${user.first_name},</p>
          <p>Your password reset code is:</p>
          <div style="background: #f0f4ff; border-radius: 10px; padding: 20px; text-align: center; margin: 20px 0;">
            <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #3b82f6;">${resetCode}</span>
          </div>
          <p style="color: #666;">This code expires in 15 minutes.</p>
          <p style="color: #666;">If you didn't request this, please ignore this email.</p>
          <p>— RideFlow Team</p>
        </div>
      `
    });
    
    res.json({ ok: true, message: 'Reset code sent to your email' });
  } catch (err) { next(err); }
});

// Reset password with code
router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    
    const userResult = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'Account not found' });
    
    const userId = userResult.rows[0].id;
    const resetResult = await query(
      'SELECT code, expires_at FROM password_resets WHERE user_id = $1',
      [userId]
    );
    
    if (!resetResult.rows.length) return res.status(400).json({ error: 'No reset code found. Please request a new one.' });
    
    const reset = resetResult.rows[0];
    if (reset.code !== code) return res.status(400).json({ error: 'Invalid reset code' });
    if (new Date() > new Date(reset.expires_at)) return res.status(400).json({ error: 'Reset code expired. Please request a new one.' });
    
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    await query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
    
    res.json({ ok: true, message: 'Password reset successfully' });
  } catch (err) { next(err); }
});

router.get('/me', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query('SELECT id, email, role, first_name, last_name FROM users WHERE id = $1', [decoded.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    let extraData = {};
    if (user.role === 'rider') {
      const riderResult = await query('SELECT category, approval_status FROM riders WHERE id = $1', [user.id]);
      if (riderResult.rows.length > 0) {
        extraData = { category: riderResult.rows[0].category, approvalStatus: riderResult.rows[0].approval_status };
      }
    }
    res.json({ id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name, ...extraData });
  } catch (err) { next(err); }
});

module.exports = router;
