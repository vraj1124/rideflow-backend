const express = require('express');
const https = require('https');
const router = express.Router();
const { query } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { requireAdmin } = require('../middleware/auth');
router.use(requireAdmin);
router.get('/dashboard', async (req, res, next) => {
  try {
    const [activeTrips, onlineDrivers, todayRevenue, avgWait] = await Promise.all([
      query(`SELECT COUNT(*) FROM trips WHERE status IN ('matching','driver_assigned','driver_en_route','arrived','in_progress')`),
      query(`SELECT COUNT(*) FROM drivers WHERE is_online = true`),
      query(`SELECT COALESCE(SUM(final_fare), 0) AS revenue, COUNT(*) AS trip_count FROM trips WHERE status = 'completed' AND trip_completed_at >= CURRENT_DATE`),
      query(`SELECT AVG(EXTRACT(EPOCH FROM (driver_assigned_at - requested_at))/60) AS avg_wait FROM trips WHERE driver_assigned_at IS NOT NULL AND requested_at >= CURRENT_DATE`),
    ]);
    res.json({
      activeTrips: parseInt(activeTrips.rows[0].count),
      onlineDrivers: parseInt(onlineDrivers.rows[0].count),
      todayRevenue: parseFloat(todayRevenue.rows[0].revenue),
      todayTripCount: parseInt(todayRevenue.rows[0].trip_count),
      avgWaitMinutes: parseFloat(avgWait.rows[0].avg_wait || 0).toFixed(1),
    });
  } catch (err) { next(err); }
});
router.get('/drivers', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
       d.vehicle_make, d.vehicle_model, d.vehicle_plate,
       d.is_online, d.is_wheelchair_equipped, d.rating,
       d.total_trips, d.total_earnings, d.background_check_status
       FROM drivers d JOIN users u ON u.id = d.id ORDER BY d.is_online DESC, u.last_name`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});
router.get('/riders', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.created_at,
        r.category, r.approval_status, r.approved_at
      FROM users u
      JOIN riders r ON r.id = u.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { next(err); }
});
router.patch('/drivers/:id/approve', async (req, res, next) => {
  try {
    await query(`UPDATE drivers SET background_check_status = 'approved' WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Driver approved' });
  } catch (err) { next(err); }
});
router.post('/riders/:id/approve', async (req, res, next) => {
  try {
    await query(`UPDATE riders SET approval_status = 'approved', approved_at = NOW() WHERE id = $1`, [req.params.id]);
    
    // Send push notification to rider
    try {
      const userResult = await query('SELECT u.first_name, r.push_token FROM users u LEFT JOIN riders r ON r.id = u.id WHERE u.id = $1', [req.params.id]);
      const rider = userResult.rows[0];
      if (rider?.push_token) {
        const message = JSON.stringify({
          to: rider.push_token,
          sound: 'default',
          title: '✅ Account Approved!',
          body: `Great news, ${rider.first_name}! Your RideFlow account has been approved. You can now book rides!`,
          priority: 'high'
        });
        const req2 = https.request({ hostname: 'exp.host', path: '/--/api/v2/push/send', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(message) } });
        req2.write(message);
        req2.end();
      }
    } catch (e) { console.error('Push error:', e.message); }
    
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/riders/:id/reject', async (req, res, next) => {
  try {
    await query(`UPDATE riders SET approval_status = 'rejected' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;

router.get('/trips', async (req, res, next) => {
  try {
    const result = await query(`SELECT * FROM trips ORDER BY requested_at DESC LIMIT 100`);
    res.json(result.rows);
  } catch (err) { next(err); }
});
