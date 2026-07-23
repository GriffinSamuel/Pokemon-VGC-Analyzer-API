const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { getNatureDistribution, getSpeciesRow } = require('./ev_observations');
const { calcStat, natureMultiplierFor } = require('./stat_formula');

const MODELS_DIR = path.join(__dirname, '..', 'ml', 'models');
const TOP_ATTACKERS = 50;
const TOP_MOVES_PER_ATTACKER = 10;
// Matches stats.js's usage_stats recompute cadence — the threat matrix is only as
// fresh as the usage data it's built from, so there's no point refreshing it faster.
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

let cache = { data: null, computedAt: 0 };

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function readMoveRecommendations() {
  const filePath = path.join(MODELS_DIR, 'move_recommendations.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Max SP in the relevant offensive stat matches ev_optimizer.js's existing documented
// worst-case-attacker assumption (assumedAttackerSide) — kept consistent here since
// per-attacker SP investment isn't tracked at the threat-matrix level, only nature.
const ASSUMED_OFFENSIVE_SP = 32;

async function buildThreatMatrix() {
  const { rows: usageRows } = await pool.query(
    'SELECT pokemon_name, usage_percent FROM usage_stats ORDER BY usage_percent DESC LIMIT $1',
    [TOP_ATTACKERS]
  );

  const moveRec = readMoveRecommendations();
  if (!moveRec) return [];

  const rawThreats = [];
  for (const u of usageRows) {
    const speciesLower = u.pokemon_name.toLowerCase();
    const entry = moveRec.pokemon[speciesLower];
    if (!entry) continue;

    const attackerUsage = parseFloat(u.usage_percent) / 100;
    for (const m of entry.moves.slice(0, TOP_MOVES_PER_ATTACKER)) {
      rawThreats.push({
        attacker: u.pokemon_name,
        move: m.move,
        attacker_usage: attackerUsage,
        move_confidence: m.confidence,
        weight: round(attackerUsage * m.confidence, 4),
      });
    }
  }
  if (rawThreats.length === 0) return [];

  const moveNames = [...new Set(rawThreats.map((t) => t.move.toLowerCase()))];
  const { rows: moveRows } = await pool.query('SELECT * FROM moves WHERE LOWER(name) = ANY($1)', [moveNames]);
  const movesByLower = Object.fromEntries(moveRows.map((m) => [m.name.toLowerCase(), m]));

  // Nature distribution + species row per attacker, fetched once and reused across
  // all of that attacker's threat entries (ev_observations -> tournament_teams ->
  // neutral fallback chain lives in ev_observations.js's getNatureDistribution).
  const attackerNames = [...new Set(rawThreats.map((t) => t.attacker.toLowerCase()))];
  const natureByAttacker = {};
  const speciesByAttacker = {};
  await Promise.all(attackerNames.map(async (name) => {
    natureByAttacker[name] = await getNatureDistribution(name);
    speciesByAttacker[name] = await getSpeciesRow(name);
  }));

  return rawThreats.map((t) => {
    const moveRow = movesByLower[t.move.toLowerCase()];
    const attackerLower = t.attacker.toLowerCase();
    const natureDist = natureByAttacker[attackerLower];
    const speciesRow = speciesByAttacker[attackerLower];

    const enriched = {
      ...t,
      move_type: moveRow?.type || null,
      move_power: moveRow?.power || null,
      primary_nature: natureDist.primaryNature || null,
      nature_distribution: natureDist.natures,
      nature_reliability: natureDist.reliability,
      computed_attack_stat: null,
    };

    const statKey = moveRow?.category === 'Physical' ? 'atk' : moveRow?.category === 'Special' ? 'spa' : null;
    if (speciesRow && statKey) {
      if (natureDist.classification === 'mixed' && natureDist.natures.length > 1) {
        // Weighted average across the observed natures, weighted by their own frequency.
        let weightedStat = 0;
        let freqSum = 0;
        for (const n of natureDist.natures) {
          weightedStat += calcStat(speciesRow[statKey], ASSUMED_OFFENSIVE_SP, natureMultiplierFor(n.nature, statKey), false) * n.frequency;
          freqSum += n.frequency;
        }
        enriched.computed_attack_stat = freqSum > 0 ? Math.round(weightedStat / freqSum) : null;
      } else {
        const nature = natureDist.primaryNature || 'Hardy';
        enriched.computed_attack_stat = calcStat(speciesRow[statKey], ASSUMED_OFFENSIVE_SP, natureMultiplierFor(nature, statKey), false);
      }
    }

    return enriched;
  });
}

async function getThreatMatrix({ forceRefresh = false } = {}) {
  const stale = Date.now() - cache.computedAt > REFRESH_INTERVAL_MS;
  if (forceRefresh || !cache.data || stale) {
    cache = { data: await buildThreatMatrix(), computedAt: Date.now() };
  }
  return cache.data;
}

module.exports = { getThreatMatrix, buildThreatMatrix, TOP_ATTACKERS, TOP_MOVES_PER_ATTACKER };
