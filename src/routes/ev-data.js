const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { getCommonSpreads, getCommonSpeedTiers } = require('../utils/ev_observations');

router.get('/:pokemon', async (req, res, next) => {
  try {
    const pokemonLower = req.params.pokemon.toLowerCase();
    const [{ total, spreads }, { tiers }] = await Promise.all([
      getCommonSpreads(pokemonLower),
      getCommonSpeedTiers(pokemonLower),
    ]);

    if (total === 0) {
      return res.status(404).json({ error: `No SP observations for ${req.params.pokemon}` });
    }

    res.json({
      pokemon: req.params.pokemon,
      observations: total,
      common_spreads: spreads,
      common_speed_tiers: tiers,
    });
  } catch (err) {
    logger.error('GET /api/ev-data failed', { error: err.message });
    next(err);
  }
});

module.exports = router;
