const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pokemon ORDER BY num');
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:name', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)',
      [req.params.name]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pokemon not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.get('/:name/moves', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.* FROM moves m
       JOIN pokemon_moves pm ON pm.move_id = m.id
       JOIN pokemon p ON p.id = pm.pokemon_id
       WHERE LOWER(p.name) = LOWER($1)`,
      [req.params.name]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;