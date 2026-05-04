const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
router.post('/intent', async (req, res, next) => {
  try {
    const { tripId } = req.body;
    if (!tripId) return res.status(400).json({ error: 'tripId required' });
    const tripResult = await query('SELECT * FROM trips WHERE id = $1 AND rider_id = $2', [tripId, req.user.id]);
    if (!tripResult.rows.length) return res.status(404).json({ error: 'Trip not found' });
    const trip = tripResult.rows[0];
    const amountCents = Math.round((trip.estimated_fare || 3.00) * 100);
    res.json({ clientSecret: 'pi_placeholder', amount: amountCents, currency: 'usd', note: 'Configure STRIPE_SECRET_KEY to enable real payments' });
  } catch (err) { next(err); }
});
router.get('/history', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.*, t.pickup_address, t.dropoff_address FROM payments p
       JOIN trips t ON t.id = p.trip_id WHERE p.rider_id = $1 ORDER BY p.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});
module.exports = router;
