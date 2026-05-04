const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
router.get('/', async (req, res, next) => {
  try {
    const result = await query('SELECT id, name, description, center_lat, center_lng, radius_miles, base_fare, per_mile_rate, is_active FROM zones WHERE is_active = true ORDER BY name');
    res.json(result.rows);
  } catch (err) { next(err); }
});
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM zones WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Zone not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});
module.exports = router;
