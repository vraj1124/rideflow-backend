const { query } = require('../config/database');
const https = require('https');

const MAPS_KEY = 'AIzaSyBOCD1meWUtiP5VmaaLE-yJhcy_oeHaTEc';

const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 3958.8;
  const toRad = (deg) => deg * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getDrivingDistance = (origin, destination) => {
  return new Promise((resolve) => {
    const enc = encodeURIComponent;
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${enc(origin)}&destinations=${enc(destination)}&units=imperial&mode=driving&key=${MAPS_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const element = json.rows[0].elements[0];
          if (element.status === 'OK') {
            const meters = element.distance.value;
            const miles = meters / 1609.344;
            const durationSeconds = element.duration.value;
            resolve({ miles: parseFloat(miles.toFixed(2)), durationMinutes: Math.ceil(durationSeconds / 60) });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
};

const FARE_CONFIG = { shared: { multiplier: 1.0 }, private: { multiplier: 2.0 }, ada_paratransit: { multiplier: 1.0 } };

const estimate = async ({ pickupLat, pickupLng, dropoffLat, dropoffLng, pickupAddress, dropoffAddress, rideType, companionCount = 0 }) => {
  const zoneResult = await query(
    'SELECT base_fare, per_mile_rate FROM zones WHERE is_active = true ORDER BY ((center_lat - $1)^2 + (center_lng - $2)^2) ASC LIMIT 1',
    [pickupLat, pickupLng]
  );
  const baseFare = parseFloat(zoneResult.rows[0]?.base_fare || 1.50);
  const perMileRate = parseFloat(zoneResult.rows[0]?.per_mile_rate || 0.90);
  const companionFare = parseFloat(process.env.COMPANION_FARE || 1.00);

  // Use full address if available, otherwise fall back to coordinates
  let distanceMiles, durationMinutes;
  const origin = pickupAddress || `${pickupLat},${pickupLng}`;
  const destination = dropoffAddress || `${dropoffLat},${dropoffLng}`;
  
  const driving = await getDrivingDistance(origin, destination);
  if (driving) {
    distanceMiles = driving.miles;
    durationMinutes = driving.durationMinutes;
  } else {
    distanceMiles = parseFloat(haversineDistance(pickupLat, pickupLng, dropoffLat, dropoffLng).toFixed(2));
    durationMinutes = Math.ceil(distanceMiles / 0.5);
  }

  const typeMultiplier = FARE_CONFIG[rideType]?.multiplier || 1.0;
  const distanceCost = distanceMiles * perMileRate;
  const companions = Math.min(parseInt(companionCount) || 0, 3);
  const companionCost = companions * companionFare;
  const subtotal = (baseFare + distanceCost) * typeMultiplier;
  const total = Math.max(subtotal + companionCost, 3.00);

  return {
    baseFare: parseFloat(baseFare.toFixed(2)),
    distanceFare: parseFloat(distanceCost.toFixed(2)),
    companionFare: parseFloat(companionCost.toFixed(2)),
    subtotal: parseFloat(subtotal.toFixed(2)),
    total: parseFloat(total.toFixed(2)),
    distanceMiles: parseFloat(distanceMiles.toFixed(2)),
    durationMinutes,
    rideType, companionCount: companions, currency: 'USD',
  };
};

module.exports = { estimate, haversineDistance };
