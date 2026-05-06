const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const fareService = require('../services/fareService');
const { authenticateToken, requireDriver } = require('../middleware/auth');
router.post('/estimate', async (req, res, next) => {
  try {
    const { pickupLat, pickupLng, dropoffLat, dropoffLng, rideType, companionCount } = req.body;
    const estimate = await fareService.estimate({ pickupLat, pickupLng, dropoffLat, dropoffLng, rideType, companionCount });
    res.json({ estimate });
  } catch (err) { next(err); }
});
router.post('/request', async (req, res, next) => {
  try {
    const { pickupAddress, pickupLat, pickupLng, dropoffAddress, dropoffLat, dropoffLng, rideType, companionCount, needsWheelchair, needsServiceAnimal, notes } = req.body;
    const estimate = await fareService.estimate({ pickupLat, pickupLng, dropoffLat, dropoffLng, rideType: rideType || 'shared', companionCount: companionCount || 0 });
    const tripResult = await query(
      `INSERT INTO trips (rider_id, status, ride_type, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, needs_wheelchair, needs_service_animal, companion_count, estimated_fare, distance_miles, notes)
       VALUES ($1,'matching',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.id, rideType || 'shared', pickupAddress, pickupLat, pickupLng, dropoffAddress, dropoffLat, dropoffLng, needsWheelchair || false, needsServiceAnimal || false, companionCount || 0, estimate.total, estimate.distanceMiles, notes]
    );
    res.status(201).json({ trip: tripResult.rows[0], estimate });
  } catch (err) { next(err); }
});
router.get('/history/me', async (req, res, next) => {
  try {
    const field = req.user.role === 'driver' ? 'driver_id' : 'rider_id';
    const result = await query(`SELECT * FROM trips WHERE ${field} = $1 ORDER BY requested_at DESC LIMIT 20`, [req.user.id]);
    res.json(result.rows);
  } catch (err) { next(err); }
});
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (!result.rows.length) throw new AppError('Trip not found', 404);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});
router.post('/:id/cancel', async (req, res, next) => {
  try {
    await query(`UPDATE trips SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Trip cancelled' });
  } catch (err) { next(err); }
});
module.exports = router;

// Get available trips (for drivers)
router.get('/available', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM trips WHERE status = 'matching' ORDER BY requested_at ASC LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// Accept a trip (driver)
router.post('/:id/accept', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE trips SET status = 'accepted', driver_id = $1, accepted_at = NOW() WHERE id = $2 AND status = 'matching' RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!result.rows.length) throw new AppError('Trip not available', 400);
    res.json({ trip: result.rows[0] });
  } catch (err) { next(err); }
});

// Start a trip (driver)
router.post('/:id/start', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE trips SET status = 'in_progress', started_at = NOW() WHERE id = $1 AND driver_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    res.json({ trip: result.rows[0] });
  } catch (err) { next(err); }
});

// Complete a trip (driver)
router.post('/:id/complete', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE trips SET status = 'completed', completed_at = NOW() WHERE id = $1 AND driver_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    res.json({ trip: result.rows[0] });
  } catch (err) { next(err); }
});
