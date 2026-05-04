const { query } = require('../config/database');
const { haversineDistance } = require('./fareService');
const MATCH_TIMEOUT_MS = 30000;
const MATCH_RADIUS_MILES = parseFloat(process.env.DRIVER_MATCH_RADIUS_MILES || 5);
const findNearbyDrivers = async (pickupLat, pickupLng, rideType) => {
  const needsWheelchair = rideType === 'ada_paratransit';
  const result = await query(
    `SELECT d.id, d.current_lat, d.current_lng, d.rating, d.vehicle_make,
     d.vehicle_model, d.vehicle_color, d.vehicle_plate, d.is_wheelchair_equipped,
     u.first_name, u.last_name FROM drivers d JOIN users u ON u.id = d.id
     WHERE d.is_online = true AND d.background_check_status = 'approved'
     AND ($1 = false OR d.is_wheelchair_equipped = true) AND d.current_lat IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.driver_id = d.id
     AND t.status IN ('driver_assigned', 'driver_en_route', 'arrived', 'in_progress'))`,
    [needsWheelchair]
  );
  return result.rows
    .map(driver => ({ ...driver, distanceMiles: haversineDistance(pickupLat, pickupLng, parseFloat(driver.current_lat), parseFloat(driver.current_lng)) }))
    .filter(d => d.distanceMiles <= MATCH_RADIUS_MILES)
    .sort((a, b) => (a.distanceMiles - (a.rating - 3) * 0.2) - (b.distanceMiles - (b.rating - 3) * 0.2));
};
const matchTrip = async (trip, io) => {
  const startTime = Date.now();
  const attempt = async () => {
    const tripCheck = await query('SELECT status FROM trips WHERE id = $1', [trip.id]);
    if (!tripCheck.rows.length || tripCheck.rows[0].status !== 'matching') return;
    const drivers = await findNearbyDrivers(trip.pickup_lat, trip.pickup_lng, trip.ride_type);
    if (drivers.length > 0) {
      io.to(`driver:${drivers[0].id}`).emit('trip:incoming', { tripId: trip.id, pickup: { address: trip.pickup_address, lat: trip.pickup_lat, lng: trip.pickup_lng }, dropoff: { address: trip.dropoff_address, lat: trip.dropoff_lat, lng: trip.dropoff_lng }, rideType: trip.ride_type, estimatedFare: trip.estimated_fare });
      setTimeout(async () => {
        const current = await query('SELECT status FROM trips WHERE id = $1', [trip.id]);
        if (current.rows[0]?.status === 'matching') {
          if (Date.now() - startTime < MATCH_TIMEOUT_MS) attempt();
          else await noDriversFound(trip.id, trip.rider_id, io);
        }
      }, 15000);
    } else {
      if (Date.now() - startTime < MATCH_TIMEOUT_MS) setTimeout(attempt, 5000);
      else await noDriversFound(trip.id, trip.rider_id, io);
    }
  };
  await attempt();
};
const noDriversFound = async (tripId, riderId, io) => {
  await query(`UPDATE trips SET status = 'no_drivers', cancelled_at = NOW(), cancel_reason = 'No drivers available' WHERE id = $1`, [tripId]);
  io.to(`rider:${riderId}`).emit('trip:no_drivers', { tripId, message: 'No drivers available right now.' });
};
module.exports = { matchTrip, findNearbyDrivers };
