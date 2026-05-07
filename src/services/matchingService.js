const { query } = require('../config/database');
const { haversineDistance } = require('./fareService');

const MATCH_RADIUS_MILES = parseFloat(process.env.DRIVER_MATCH_RADIUS_MILES || 10);

// Find nearest available driver, excluding already-offered drivers
const findNearestDriver = async (tripId, pickupLat, pickupLng) => {
  const result = await query(`
    SELECT d.id, d.current_lat, d.current_lng, u.first_name, u.last_name
    FROM drivers d
    JOIN users u ON u.id = d.id
    WHERE d.is_online = true
      AND d.current_lat IS NOT NULL
      AND d.id NOT IN (
        SELECT driver_id FROM trip_offers 
        WHERE trip_id = $1 AND status IN ('pending', 'declined', 'expired', 'accepted')
      )
      AND d.id NOT IN (
        SELECT driver_id FROM trips 
        WHERE status IN ('accepted', 'in_progress') AND driver_id IS NOT NULL
      )
  `, [tripId]);

  if (!result.rows.length) return null;

  // Sort by distance
  const drivers = result.rows.map(d => ({
    ...d,
    distanceMiles: haversineDistance(pickupLat, pickupLng, parseFloat(d.current_lat), parseFloat(d.current_lng))
  })).sort((a, b) => a.distanceMiles - b.distanceMiles);

  return drivers[0] || null;
};

// Create an offer for a driver
const createOffer = async (tripId, driverId) => {
  const result = await query(`
    INSERT INTO trip_offers (trip_id, driver_id, offered_at, expires_at, status)
    VALUES ($1, $2, NOW(), NOW() + INTERVAL '2 minutes', 'pending')
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [tripId, driverId]);
  return result.rows[0];
};

// Check and expire old offers, then find next driver
const processExpiredOffers = async () => {
  // Expire old pending offers
  await query(`
    UPDATE trip_offers 
    SET status = 'expired' 
    WHERE status = 'pending' AND expires_at < NOW()
  `);

  // Find trips that need a new driver offer
  const tripsResult = await query(`
    SELECT t.id, t.pickup_lat, t.pickup_lng
    FROM trips t
    WHERE t.status = 'matching'
      AND NOT EXISTS (
        SELECT 1 FROM trip_offers o 
        WHERE o.trip_id = t.id AND o.status = 'pending'
      )
    ORDER BY t.requested_at ASC
    LIMIT 10
  `);

  for (const trip of tripsResult.rows) {
    const driver = await findNearestDriver(trip.id, trip.pickup_lat, trip.pickup_lng);
    if (driver) {
      await createOffer(trip.id, driver.id);
      console.log(`Offered trip ${trip.id} to driver ${driver.id} (${driver.distanceMiles?.toFixed(1)} mi away)`);
    }
  }
};

module.exports = { findNearestDriver, createOffer, processExpiredOffers };
