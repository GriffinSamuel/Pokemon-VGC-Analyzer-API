const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query;
    const query = type
      ? 'SELECT * FROM moves WHERE LOWER(type) = LOWER($1) ORDER BY name'
      : 'SELECT * FROM moves ORDER BY name';
    const { rows } = await pool.query(query, type ? [type] : []);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:name', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM moves WHERE LOWER(name) = LOWER($1)',
      [req.params.name]
    );
    if (!rows.length) return res.status(404).json({ error: 'Move not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;