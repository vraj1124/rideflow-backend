const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { requireDriver } = require('../middleware/auth');
router.get('/me', requireDriver, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone,
       d.license_number, d.vehicle_make, d.vehicle_model, d.vehicle_year,
       d.vehicle_plate, d.vehicle_color, d.is_wheelchair_equipped,
       d.is_online, d.current_lat, d.current_lng, d.rating,
       d.total_trips, d.total_earnings, d.background_check_status
       FROM users u JOIN drivers d ON d.id = u.id WHERE u.id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) throw new AppError('Driver not found', 404);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});
router.post('/online', requireDriver, async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) throw new AppError('Location required', 400);
    await query('UPDATE drivers SET is_online = true, current_lat = $1, current_lng = $2, updated_at = NOW() WHERE id = $3', [lat, lng, req.user.id]);
    res.json({ online: true });
  } catch (err) { next(err); }
});
router.post('/offline', requireDriver, async (req, res, next) => {
  try {
    await query('UPDATE drivers SET is_online = false, updated_at = NOW() WHERE id = $1', [req.user.id]);
    res.json({ online: false });
  } catch (err) { next(err); }
});
router.post('/location', requireDriver, async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    await query('UPDATE drivers SET current_lat = $1, current_lng = $2 WHERE id = $3', [lat, lng, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
router.post('/push-token', requireDriver, async (req, res, next) => {
  try {
    const { pushToken } = req.body;
    await query('UPDATE drivers SET push_token = $1 WHERE id = $2', [pushToken, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
