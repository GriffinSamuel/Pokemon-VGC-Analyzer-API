const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const logger = require('../utils/logger');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
    const minUsage = req.query.min_usage !== undefined ? parseFloat(req.query.min_usage) : null;

    const conditions = [];
    const params = [];
    if (minUsage !== null && !Number.isNaN(minUsage)) {
      params.push(minUsage);
      conditions.push(`usage_percent >= $${params.length}`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const { rows } = await pool.query(`
      SELECT pokemon_name, usage_percent, usage_count, avg_win_rate, best_placement
      FROM usage_stats
      ${whereClause}
      ORDER BY usage_percent DESC
      LIMIT $${params.length}
    `, params);

    res.json(rows);
  } catch (err) {
    logger.error('GET /api/usage failed', { error: err.message });
    next(err);
  }
});

router.get('/:name', async (req, res, next) => {
  try {
    // Rank requires seeing the whole ordering, so it's computed as a window function
    // over the full table, then filtered down to the one requested row in the same
    // query — the DB does the sort once rather than Node pulling every row over.
    const { rows } = await pool.query(`
      SELECT pokemon_name, usage_percent, usage_count, avg_win_rate, rank
      FROM (
        SELECT pokemon_name, usage_percent, usage_count, avg_win_rate,
               RANK() OVER (ORDER BY usage_percent DESC) as rank
        FROM usage_stats
      ) ranked
      WHERE LOWER(pokemon_name) = LOWER($1)
    `, [req.params.name]);

    if (rows.length === 0) {
      return res.status(404).json({ error: `No usage data for ${req.params.name}` });
    }

    const entry = rows[0];
    res.json({
      pokemon_name: entry.pokemon_name,
      usage_percent: entry.usage_percent,
      usage_count: entry.usage_count,
      win_rate: entry.avg_win_rate,
      rank: parseInt(entry.rank, 10),
    });
  } catch (err) {
    logger.error('GET /api/usage/:name failed', { error: err.message });
    next(err);
  }
});

module.exports = router;
