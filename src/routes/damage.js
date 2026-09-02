const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { buildCacheKey, getCachedDamage, setCachedDamage } = require('../scrapers/serebii');
const { normalizePokemonName } = require('../utils/normalize');
const { getMostCommonSpread } = require('../utils/ev_observations');
const { CalcDamage, buildStatsFromSP, isSpreadMove } = require('../utils/nerd_of_now_calc');
const logger = require('../utils/logger');
const { STAT_ORDER } = require('../utils/stat_formula');

// Helper: convert classic EVs (0-252) to Stat Points (0-32)
function evsToSp(evs) {
  const sp = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  for (const [key, value] of Object.entries(evs || {})) {
    if (value > 0 && sp[key] !== undefined) sp[key] = Math.min(Math.round((value + 4) / 8), 32);
  }
  return sp;
}

// Build final stats for display
function buildDisplayStats(row, sp, nature) {
  return buildStatsFromSP(
    { hp: row.hp, atk: row.atk, def: row.def, spa: row.spa, spd: row.spd, spe: row.spe },
    sp,
    nature || 'Hardy'
  );
}

// Build a plain Pokemon object from DB row and side (with evs or sp), suitable for CalcDamage
function buildPokemon(row, side = {}) {
  const sp = side.sp || evsToSp(side.evs || {});
  return {
    name: row.name,
    nature: side.nature || 'Hardy',
    sp,
    item: side.item || '',
    ability: row.ability || '',
    baseStats: { hp: row.hp, atk: row.atk, def: row.def, spa: row.spa, spd: row.spd, spe: row.spe },
    types: [row.type1, row.type2].filter(Boolean),
  };
}


function toNormalizedLower(name, item) {
  const id = (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (normalizePokemonName(id, item) || name || "").toLowerCase();
}

const MAX_EV_PER_STAT = 252;
const MAX_EV_TOTAL = 508;

function validateEvs(evs, label) {
  if (evs === undefined) return null;
  if (typeof evs !== 'object' || evs === null || Array.isArray(evs)) {
    return `${label}.evs must be an object keyed by stat (hp/atk/def/spa/spd/spe)`;
  }
  let total = 0;
  for (const [key, value] of Object.entries(evs)) {
    if (!STAT_ORDER.includes(key)) {
      return `${label}.evs has unknown stat "${key}" — must be one of ${STAT_ORDER.join(', ')}`;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_EV_PER_STAT) {
      return `${label}.evs.${key} must be an integer between 0 and ${MAX_EV_PER_STAT}`;
    }
    total += value;
  }
  if (total > MAX_EV_TOTAL) {
    return `${label}.evs total (${total}) exceeds the maximum of ${MAX_EV_TOTAL}`;
  }
  return null;
}

// Shared by POST / and POST /realistic — routes damage calcs through CalcDamage.
function runCalculation(attackerRow, defenderRow, attackerSide, defenderSide, moveName, moveRow, field) {
  const attackerPokemon = buildPokemon(attackerRow, attackerSide);
  const defenderPokemon = buildPokemon(defenderRow, defenderSide);

  const result = CalcDamage({
    attacker: attackerPokemon,
    defender: defenderPokemon,
    move: {
      name: moveName,
      type: moveRow?.type || 'Normal',
      category: moveRow?.category || 'Physical',
      bp: moveRow?.power || 0,
      isSpread: isSpreadMove(moveName),
      makesContact: false,
    },
    isDouble: true,
    weather: field?.weather || null,
    terrain: field?.terrain || null,
  });

  return {
    move: moveName,
    guaranteed_ko: result.guaranteed_ko || 'none',
    damage_range: {
      min_percent: Math.round(result.minPercent * 10) / 10,
      max_percent: Math.round(result.maxPercent * 10) / 10,
    },
    attacker_final_stats: result._attackerStats,
    defender_final_stats: result._defenderStats,
    notes: result.notes || '',
  };
}

router.post('/', async (req, res, next) => {
  try {
    const { attacker, defender, move, field } = req.body || {};

    if (!attacker?.name || !defender?.name || !move) {
      return res.status(400).json({ error: 'attacker.name, defender.name, and move are required' });
    }

    const evsError = validateEvs(attacker.evs, 'attacker') || validateEvs(defender.evs, 'defender');
    if (evsError) {
      return res.status(400).json({ error: evsError });
    }

    let resolvedDefender = defender;
    let defenderSpSource = 'user_supplied';
    if (defender.use_observed_sp === true) {
      const observed = await getMostCommonSpread(toNormalizedLower(defender.name, defender.item));
      if (observed) {
        resolvedDefender = { ...defender, sp: observed.sp, nature: defender.nature || observed.nature };
        defenderSpSource = 'observed';
      }
    }

    const cacheKey = buildCacheKey({ ...req.body, defender: resolvedDefender });
    const cached = getCachedDamage(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const [attackerRows, defenderRows, moveRows] = await Promise.all([
      pool.query('SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)', [attacker.name]),
      pool.query('SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)', [defender.name]),
      pool.query('SELECT * FROM moves WHERE LOWER(name) = LOWER($1)', [move]),
    ]);

    if (!attackerRows.rows.length) return res.status(404).json({ error: 'Attacker Pokemon not found' });
    if (!defenderRows.rows.length) return res.status(404).json({ error: 'Defender Pokemon not found' });
    if (!moveRows.rows.length) return res.status(404).json({ error: 'Move not found' });

    const responseBody = {
      ...runCalculation(attackerRows.rows[0], defenderRows.rows[0], attacker, resolvedDefender, move, moveRows.rows[0], field),
      ...(defender.use_observed_sp === true ? { defender_sp_source: defenderSpSource } : {}),
    };

    setCachedDamage(cacheKey, responseBody);
    res.json({ ...responseBody, cached: false });
  } catch (err) { next(err); }
});

router.post('/realistic', async (req, res, next) => {
  try {
    const { attacker, defender, move, field } = req.body || {};

    if (!attacker?.name || !defender?.name || !move) {
      return res.status(400).json({ error: 'attacker.name, defender.name, and move are required' });
    }

    const evsError = validateEvs(attacker.evs, 'attacker') || validateEvs(defender.evs, 'defender');
    if (evsError) {
      return res.status(400).json({ error: evsError });
    }

    const [attackerObserved, defenderObserved] = await Promise.all([
      getMostCommonSpread(toNormalizedLower(attacker.name, attacker.item)),
      getMostCommonSpread(toNormalizedLower(defender.name, defender.item)),
    ]);

    const resolvedAttacker = attackerObserved
      ? { ...attacker, sp: attackerObserved.sp, nature: attacker.nature || attackerObserved.nature }
      : attacker;
    const resolvedDefender = defenderObserved
      ? { ...defender, sp: defenderObserved.sp, nature: defender.nature || defenderObserved.nature }
      : defender;

    const cacheKey = buildCacheKey({ attacker: resolvedAttacker, defender: resolvedDefender, move, field, _endpoint: 'realistic' });
    const cached = getCachedDamage(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const [attackerRows, defenderRows, moveRows] = await Promise.all([
      pool.query('SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)', [attacker.name]),
      pool.query('SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)', [defender.name]),
      pool.query('SELECT * FROM moves WHERE LOWER(name) = LOWER($1)', [move]),
    ]);

    if (!attackerRows.rows.length) return res.status(404).json({ error: 'Attacker Pokemon not found' });
    if (!defenderRows.rows.length) return res.status(404).json({ error: 'Defender Pokemon not found' });
    if (!moveRows.rows.length) return res.status(404).json({ error: 'Move not found' });

    const responseBody = {
      ...runCalculation(attackerRows.rows[0], defenderRows.rows[0], resolvedAttacker, resolvedDefender, move, moveRows.rows[0], field),
      attacker_sp_source: attackerObserved ? 'observed' : 'user_supplied',
      defender_sp_source: defenderObserved ? 'observed' : 'user_supplied',
      attacker_sp_observations: attackerObserved ? attackerObserved.total_observations : 0,
      defender_sp_observations: defenderObserved ? defenderObserved.total_observations : 0,
      attacker_sp_frequency: attackerObserved ? attackerObserved.frequency : null,
      defender_sp_frequency: defenderObserved ? defenderObserved.frequency : null,
    };

    setCachedDamage(cacheKey, responseBody);
    res.json({ ...responseBody, cached: false });
  } catch (err) {
    logger.error('POST /api/damage/realistic failed', { error: err.message });
    next(err);
  }
});

module.exports = router;
module.exports.buildPokemon = buildPokemon;
module.exports.evsToSp = evsToSp;
