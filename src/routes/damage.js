const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const calc = require('@smogon/calc');
const { buildCacheKey, getCachedDamage, setCachedDamage } = require('../scrapers/serebii');
const { normalizePokemonName } = require('../utils/normalize');
const { spToEv } = require('../utils/stat_formula');
const { getMostCommonSpread } = require('../utils/ev_observations');
const logger = require('../utils/logger');

const gen = calc.Generations.get(9);
const LEVEL = 50;

// ev_observations is keyed by normalized_name (Mega-aware) — mirrors team.js's own
// id derivation so a plain display name ("Swampert" + Swampertite) resolves the
// same way it would if it had come through the Showdown parser.
function toNormalizedLower(name, item) {
  const id = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (normalizePokemonName(id, item) || name || '').toLowerCase();
}

function spToEvObject(sp) {
  return {
    hp: spToEv(sp?.hp || 0), atk: spToEv(sp?.atk || 0), def: spToEv(sp?.def || 0),
    spa: spToEv(sp?.spa || 0), spd: spToEv(sp?.spd || 0), spe: spToEv(sp?.spe || 0),
  };
}

function buildPokemon(row, side = {}) {
  return new calc.Pokemon(gen, row.name, {
    level: LEVEL,
    nature: side.nature,
    item: side.item,
    ability: side.ability,
    evs: side.evs,
    ivs: side.ivs,
    overrides: {
      baseStats: {
        hp: row.hp, atk: row.atk, def: row.def,
        spa: row.spa, spd: row.spd, spe: row.spe,
      },
      types: [row.type1, row.type2].filter(Boolean),
    },
  });
}

const EV_STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const MAX_EV_PER_STAT = 252;
const MAX_EV_TOTAL = 508;

function validateEvs(evs, label) {
  if (evs === undefined) return null;
  if (typeof evs !== 'object' || evs === null || Array.isArray(evs)) {
    return `${label}.evs must be an object keyed by stat (hp/atk/def/spa/spd/spe)`;
  }
  let total = 0;
  for (const [key, value] of Object.entries(evs)) {
    if (!EV_STAT_KEYS.includes(key)) {
      return `${label}.evs has unknown stat "${key}" — must be one of ${EV_STAT_KEYS.join(', ')}`;
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

// gameType: 'Doubles' makes @smogon/calc apply the 0.75x spread-move reduction
// internally for moves that hit all adjacent targets (e.g. Earthquake) -
// weather/terrain are only set if the caller provided them. Shared by POST / and
// POST /realistic so the actual damage-calc call site exists exactly once.
function runCalculation(attackerRow, defenderRow, attackerSide, defenderSide, move, field) {
  const attackerPokemon = buildPokemon(attackerRow, attackerSide);
  const defenderPokemon = buildPokemon(defenderRow, defenderSide);
  const calcMove = new calc.Move(gen, move);

  const fieldOptions = { gameType: 'Doubles' };
  if (field?.weather) fieldOptions.weather = field.weather;
  if (field?.terrain) fieldOptions.terrain = field.terrain;
  const calcField = new calc.Field(fieldOptions);

  const result = calc.calculate(gen, attackerPokemon, defenderPokemon, calcMove, calcField);
  const ko = result.kochance();
  const guaranteed_ko = (ko.chance === 1 && ko.n <= 3) ? `${ko.n}HKO` : 'none';
  const [minDamage, maxDamage] = result.range();
  const maxHP = defenderPokemon.maxHP();

  return {
    move,
    guaranteed_ko,
    damage_range: {
      min_percent: Math.round((minDamage / maxHP) * 1000) / 10,
      max_percent: Math.round((maxDamage / maxHP) * 1000) / 10,
    },
    attacker_final_stats: attackerPokemon.stats,
    defender_final_stats: defenderPokemon.stats,
    notes: result.fullDesc(),
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
        resolvedDefender = { ...defender, evs: spToEvObject(observed.sp), nature: defender.nature || observed.nature };
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
      ...runCalculation(attackerRows.rows[0], defenderRows.rows[0], attacker, resolvedDefender, move, field),
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
      ? { ...attacker, evs: spToEvObject(attackerObserved.sp), nature: attacker.nature || attackerObserved.nature }
      : attacker;
    const resolvedDefender = defenderObserved
      ? { ...defender, evs: spToEvObject(defenderObserved.sp), nature: defender.nature || defenderObserved.nature }
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
      ...runCalculation(attackerRows.rows[0], defenderRows.rows[0], resolvedAttacker, resolvedDefender, move, field),
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
module.exports.gen = gen;
module.exports.LEVEL = LEVEL;
module.exports.buildPokemon = buildPokemon;
