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
const { findNearestDriver, createOffer, processExpiredOffers } = require('../services/matchingService');

// Send SMS/email to trusted circle
const notifyTrustedCircle = async (riderId, message) => {
  try {
    const contacts = await query('SELECT * FROM trusted_circle WHERE rider_id = $1', [riderId]);
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    
    for (const contact of contacts.rows) {
      if (contact.email) {
        await sgMail.send({
          to: contact.email,
          from: 'vraj@cprmedicaltransport.com',
          subject: 'RideFlow — Ride Update',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #3b82f6;">RideFlow Update</h2>
              <p>Hi ${contact.name},</p>
              <p style="font-size: 16px; background: #f0f4ff; padding: 16px; border-radius: 10px;">${message}</p>
              <p style="color: #666; font-size: 12px;">You are receiving this because you are a trusted contact on RideFlow.</p>
            </div>
          `
        });
      }
    }
  } catch (e) { console.error('Trusted circle notification error:', e.message); }
};
router.post('/estimate', async (req, res, next) => {
  try {
    const { pickupLat, pickupLng, dropoffLat, dropoffLng, rideType, companionCount } = req.body;
    if (!inCharlotteCounty(pickupLat, pickupLng)) return res.status(400).json({ error: 'Pickup is outside Charlotte County service area' });
    if (!inCharlotteCounty(dropoffLat, dropoffLng)) return res.status(400).json({ error: 'Dropoff is outside Charlotte County service area' });
    // Check rider approval status
    if (req.user.role === 'rider') {
      const riderCheck = await query('SELECT approval_status FROM riders WHERE id = $1', [req.user.id]);
      if (riderCheck.rows[0]?.approval_status === 'pending') {
        return res.status(403).json({ error: 'Your account is pending admin approval. Please wait for approval before booking rides.' });
      }
      if (riderCheck.rows[0]?.approval_status === 'rejected') {
        return res.status(403).json({ error: 'Your account has been rejected. Please contact support at (941) 555-1234.' });
      }
    }
    const estimate = await fareService.estimate({ pickupLat, pickupLng, dropoffLat, dropoffLng, pickupAddress: req.body.pickupAddress, dropoffAddress: req.body.dropoffAddress, rideType, companionCount });
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
    // Trigger matching asynchronously
    setImmediate(async () => {
      try {
        const trip = tripResult.rows[0];
        const driver = await findNearestDriver(trip.id, trip.pickup_lat, trip.pickup_lng);
        if (driver) await createOffer(trip.id, driver.id);
      } catch(e) { console.error('Matching error:', e); }
    });
  } catch (err) { next(err); }
});
router.get('/history/me', async (req, res, next) => {
  try {
    const field = req.user.role === 'driver' ? 'driver_id' : 'rider_id';
    const result = await query(`SELECT * FROM trips WHERE ${field} = $1 ORDER BY requested_at DESC LIMIT 100`, [req.user.id]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// Get driver earnings summary
router.get('/earnings/me', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        COUNT(*) as total_trips,
        COALESCE(SUM(estimated_fare::float), 0) as total_earnings,
        COALESCE(SUM(CASE WHEN requested_at > NOW() - INTERVAL '7 days' THEN estimated_fare::float ELSE 0 END), 0) as week_earnings,
        COALESCE(SUM(CASE WHEN requested_at > NOW() - INTERVAL '30 days' THEN estimated_fare::float ELSE 0 END), 0) as month_earnings
      FROM trips 
      WHERE driver_id = $1 AND status = 'completed'
    `, [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// Get available trips (for drivers) - only shows trips offered to this driver
router.get('/available', authenticateToken, async (req, res, next) => {
  try {
    // Set driver online when they check for rides
    await query('UPDATE drivers SET is_online = true WHERE id = $1', [req.user.id]);
    
    // Process expired offers and create new ones
    await processExpiredOffers();
    
    // Refresh expiry time for existing pending offers (reset to 30 seconds from now)
    await query(
      `UPDATE trip_offers SET expires_at = NOW() + INTERVAL '30 seconds' 
       WHERE driver_id = $1 AND status = 'pending' AND expires_at > NOW()`,
      [req.user.id]
    );

    // Also directly find and offer trips to this driver if none pending
    const pendingCheck = await query(
      `SELECT COUNT(*) FROM trip_offers WHERE driver_id = $1 AND status = 'pending' AND expires_at > NOW()`,
      [req.user.id]
    );
    
    if (parseInt(pendingCheck.rows[0].count) === 0) {
      // Find a matching trip and offer directly to this driver
      const matchingTrips = await query(`
        SELECT t.id, t.pickup_lat, t.pickup_lng FROM trips t
        WHERE t.status = 'matching'
          AND t.requested_at > NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM trip_offers o WHERE o.trip_id = t.id AND o.driver_id = $1
          )
        ORDER BY t.requested_at DESC LIMIT 1
      `, [req.user.id]);
      
      if (matchingTrips.rows.length > 0) {
        const trip = matchingTrips.rows[0];
        await createOffer(trip.id, req.user.id);
      }
    }

    // Return trips offered to this driver that haven't expired
    const result = await query(`
      SELECT t.*, o.expires_at as offer_expires_at, o.id as offer_id
      FROM trips t
      JOIN trip_offers o ON o.trip_id = t.id
      WHERE o.driver_id = $1 
        AND o.status = 'pending'
        AND o.expires_at > NOW()
        AND t.status = 'matching'
      ORDER BY o.offered_at ASC
    `, [req.user.id]);
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
    // Accept the offer
    await query(
      `UPDATE trip_offers SET status = 'accepted' WHERE trip_id = $1 AND driver_id = $2 AND status = 'pending'`,
      [req.params.id, req.user.id]
    );
    // Decline all other pending offers for this trip
    await query(
      `UPDATE trip_offers SET status = 'declined' WHERE trip_id = $1 AND driver_id != $2 AND status = 'pending'`,
      [req.params.id, req.user.id]
    );
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
    if (!result.rows.length) throw new AppError('Trip not found', 404);
    const completedTrip = result.rows[0];
    res.json({ trip: completedTrip });

    // Notify trusted circle - ride completed
    setImmediate(async () => {
      try {
        const riderInfo = await query('SELECT first_name, last_name FROM users WHERE id = $1', [completedTrip.rider_id]);
        const riderName = riderInfo.rows[0] ? riderInfo.rows[0].first_name + ' ' + riderInfo.rows[0].last_name : 'Your loved one';
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        await notifyTrustedCircle(completedTrip.rider_id,
          '✅ ' + riderName + ' has been safely dropped off!<br><br>📍 Arrived at: ' + completedTrip.dropoff_address + '<br>⏰ Time: ' + time
        );
      } catch(e) { console.error('Trusted circle notify error:', e.message); }
    });
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
