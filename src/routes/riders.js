const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
router.get('/me', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone,
       r.ada_eligible, r.needs_wheelchair, r.needs_service_animal,
       r.emergency_contact_name, r.emergency_contact_phone, r.total_trips
       FROM users u JOIN riders r ON r.id = u.id WHERE u.id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) throw new AppError('Rider not found', 404);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});
router.patch('/me', async (req, res, next) => {
  try {
    const allowed = ['emergency_contact_name', 'emergency_contact_phone', 'needs_wheelchair', 'needs_service_animal'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k)).reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await query(`UPDATE riders SET ${setClauses} WHERE id = $1`, [req.user.id, ...Object.values(updates)]);
    res.json({ message: 'Profile updated' });
  } catch (err) { next(err); }
});
module.exports = router;
