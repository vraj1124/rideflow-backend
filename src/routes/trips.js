const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const fareService = require('../services/fareService');

// Charlotte County Florida precise boundaries
const CHARLOTTE_BOUNDS = { north: 27.04, south: 26.75, east: -81.85, west: -82.45 };
const inCharlotteCounty = (lat, lng) => {
  const la = parseFloat(lat), lo = parseFloat(lng);
  return la >= CHARLOTTE_BOUNDS.south && la <= CHARLOTTE_BOUNDS.north && lo >= CHARLOTTE_BOUNDS.west && lo <= CHARLOTTE_BOUNDS.east;
};
const { authenticateToken, requireDriver } = require('../middleware/auth');
router.post('/estimate', async (req, res, next) => {
  try {
    const { pickupLat, pickupLng, dropoffLat, dropoffLng, rideType, companionCount } = req.body;
    if (!inCharlotteCounty(pickupLat, pickupLng)) return res.status(400).json({ error: 'Pickup is outside Charlotte County service area' });
    if (!inCharlotteCounty(dropoffLat, dropoffLng)) return res.status(400).json({ error: 'Dropoff is outside Charlotte County service area' });
    const estimate = await fareService.estimate({ pickupLat, pickupLng, dropoffLat, dropoffLng, rideType, companionCount });
    res.json({ estimate });
  } catch (err) { next(err); }
});
router.post('/request', async (req, res, next) => {
  try {
    const { pickupAddress, pickupLat, pickupLng, dropoffAddress, dropoffLat, dropoffLng, rideType, companionCount, needsWheelchair, needsServiceAnimal, notes } = req.body;
    if (!inCharlotteCounty(pickupLat, pickupLng)) return res.status(400).json({ error: 'Pickup is outside Charlotte County service area' });
    if (!inCharlotteCounty(dropoffLat, dropoffLng)) return res.status(400).json({ error: 'Dropoff is outside Charlotte County service area' });
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

// Get available trips (for drivers)
router.get('/available', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM trips WHERE status = 'matching' ORDER BY requested_at ASC LIMIT 10`
    );
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

// Accept a trip (driver)
router.post('/:id/accept', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE trips SET status = 'accepted', driver_id = $1, driver_assigned_at = NOW() WHERE id = $2 AND status = 'matching' RETURNING *`,
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
      `UPDATE trips SET status = 'in_progress', trip_started_at = NOW() WHERE id = $1 AND driver_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    res.json({ trip: result.rows[0] });
  } catch (err) { next(err); }
});

// Complete a trip (driver)
router.post('/:id/complete', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE trips SET status = 'completed', trip_completed_at = NOW() WHERE id = $1 AND driver_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    res.json({ trip: result.rows[0] });
  } catch (err) { next(err); }
});

// Get driver location for a trip (for riders)
router.get('/:id/driver-location', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT d.current_lat, d.current_lng, u.first_name, u.last_name
      FROM trips t
      JOIN drivers d ON d.id = t.driver_id
      JOIN users u ON u.id = d.id
      WHERE t.id = $1 AND t.rider_id = $2
    `, [req.params.id, req.user.id]);
    if (!result.rows.length) return res.json({ location: null });
    res.json({ location: result.rows[0] });
  } catch (err) { next(err); }
});

// Get trip with rider and driver names
router.get('/:id/details', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT t.*,
        ru.first_name as rider_first_name, ru.last_name as rider_last_name,
        du.first_name as driver_first_name, du.last_name as driver_last_name,
        d.current_lat as driver_lat, d.current_lng as driver_lng,
        d.vehicle_make, d.vehicle_model, d.vehicle_plate
      FROM trips t
      JOIN users ru ON ru.id = t.rider_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      LEFT JOIN users du ON du.id = t.driver_id
      WHERE t.id = $1
    `, [req.params.id]);
    if (!result.rows.length) throw new AppError('Trip not found', 404);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});
