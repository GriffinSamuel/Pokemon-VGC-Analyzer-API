const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const logger = require('../utils/logger');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const PLACEMENT_CUTOFFS = { top8: 8, top16: 16, top32: 32 };

router.get('/teams', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
    const page = Math.max(parseInt(req.query.page, 10) || 0, 0);
    const { format, placement, pokemon } = req.query;

    if (placement && placement !== 'top50percent' && !PLACEMENT_CUTOFFS[placement]) {
      return res.status(400).json({
        error: `Invalid placement. Must be one of: ${Object.keys(PLACEMENT_CUTOFFS).join(', ')}, top50percent`,
      });
    }

    const conditions = [];
    const params = [];

    if (format) {
      params.push(`%${format}%`);
      conditions.push(`tournament_name ILIKE $${params.length}`);
    }
    if (placement && PLACEMENT_CUTOFFS[placement]) {
      params.push(PLACEMENT_CUTOFFS[placement]);
      conditions.push(`placement <= $${params.length}`);
    }
    // top50percent is a no-op: the scraper only ever stores each tournament's top
    // half of finishers in the first place, so every stored row already qualifies.
    if (pokemon) {
      params.push(pokemon.toLowerCase());
      conditions.push(`EXISTS (
        SELECT 1 FROM jsonb_array_elements(pokemon) p
        WHERE LOWER(p->>'name') = $${params.length}
      )`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, page * limit);

    const { rows } = await pool.query(`
      SELECT id, tournament_id, tournament_name, tournament_date, player_name,
             placement, wins, losses, pokemon, scraped_at
      FROM tournament_teams
      ${whereClause}
      ORDER BY tournament_date DESC, placement ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json(rows);
  } catch (err) {
    logger.error('GET /api/tournament/teams failed', { error: err.message });
    next(err);
  }
});

module.exports = router;
