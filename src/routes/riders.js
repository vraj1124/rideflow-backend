const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://tgnpkwjrpbhlsfwwgasg.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRnbnBrd2pycGJobHNmd3dnYXNnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzY2NTY0MywiZXhwIjoyMDkzMjQxNjQzfQ.oyNwLcrI2PkjtcHCB6PJueUab8TK9uGK4hfbr0taP_8'
);
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = express.Router();
const { query } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
router.get('/me', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone,
       r.ada_eligible, r.needs_wheelchair, r.needs_service_animal,
       r.emergency_contact_name, r.emergency_contact_phone, r.total_trips
       FROM users u JOIN riders r ON r.id = u.id WHERE u.id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) throw new AppError('Rider not found', 404);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});
router.patch('/me', async (req, res, next) => {
  try {
    const allowed = ['emergency_contact_name', 'emergency_contact_phone', 'needs_wheelchair', 'needs_service_animal'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k)).reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await query(`UPDATE riders SET ${setClauses} WHERE id = $1`, [req.user.id, ...Object.values(updates)]);
    res.json({ message: 'Profile updated' });
  } catch (err) { next(err); }
});
router.post('/upload-document', upload.single('document'), async (req, res, next) => {
  try {
    if (!req.file) {
      // Handle JSON submission without file (mark as submitted)
      await query('UPDATE riders SET proof_document_name = $1 WHERE id = $2', ['document_submitted', req.user.id]);
      return res.json({ ok: true, message: 'Document submitted' });
    }

    const fileName = `${req.user.id}_${Date.now()}.${req.file.mimetype.split('/')[1] || 'jpg'}`;
    
    const { data, error } = await supabase.storage
      .from('documents')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });

    if (error) throw error;

    // Get signed URL valid for 7 days for admin viewing
    const { data: urlData } = await supabase.storage
      .from('documents')
      .createSignedUrl(fileName, 60 * 60 * 24 * 7);

    await query(
      'UPDATE riders SET proof_document_name = $1, proof_document_url = $2 WHERE id = $3',
      [fileName, urlData.signedUrl, req.user.id]
    );

    res.json({ ok: true, message: 'Document uploaded successfully' });
  } catch (err) { next(err); }
});

router.post('/push-token', async (req, res, next) => {
  try {
    const { pushToken } = req.body;
    await query('UPDATE riders SET push_token = $1 WHERE id = $2', [pushToken, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});


// Get trusted circle
router.get('/trusted-circle', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM trusted_circle WHERE rider_id = $1 ORDER BY created_at ASC', [req.user.id]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// Add trusted contact
router.post('/trusted-circle', async (req, res, next) => {
  try {
    const { name, phone, email, relationship } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const count = await query('SELECT COUNT(*) FROM trusted_circle WHERE rider_id = $1', [req.user.id]);
    if (parseInt(count.rows[0].count) >= 3) return res.status(400).json({ error: 'Maximum 3 trusted contacts allowed' });
    const result = await query(
      'INSERT INTO trusted_circle (rider_id, name, phone, email, relationship) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, name, phone, email, relationship]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// Delete trusted contact
router.delete('/trusted-circle/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM trusted_circle WHERE id = $1 AND rider_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
