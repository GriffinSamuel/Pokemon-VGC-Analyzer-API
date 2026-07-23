const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res, next) => {
  try {
    const { pokemon } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const query = pokemon
      ? 'SELECT * FROM balance_patches WHERE LOWER(pokemon_name) = LOWER($1) ORDER BY detected_at DESC LIMIT $2'
      : 'SELECT * FROM balance_patches ORDER BY detected_at DESC LIMIT $1';
    const params = pokemon ? [pokemon, limit] : [limit];

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
