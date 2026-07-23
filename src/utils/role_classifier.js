const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { getSpeciesRow } = require('./ev_observations');

const MODELS_DIR = path.join(__dirname, '..', 'ml', 'models');

const FAST_SPEED_THRESHOLD = 95;
const OFFENSIVE_STAT_THRESHOLD = 110;
const BULKY_TOTAL_THRESHOLD = 270;

// Fixed VGC support-move vocabulary — well-known game mechanics, not Pokemon-specific,
// same category as synergy_reasons.js's WEATHER_MOVE_RULES/SUPPORT_MOVE_EFFECTS tables.
const SUPPORT_MOVES = new Set([
  'tailwind', 'trick room', 'rage powder', 'follow me', 'life dew',
  'helping hand', 'protect', 'wide guard', 'quick guard', 'fake out',
  'encore', 'taunt', 'snarl', 'icy wind', 'electroweb', 'charm',
  'baby-doll eyes', 'thunder wave', 'will-o-wisp', 'spore',
  'sleep powder', 'sunny day', 'rain dance', 'haze', 'heal pulse',
  'light screen', 'reflect', 'aurora veil', 'safeguard',
]);

const roleCache = new Map();

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function readMoveRecommendations() {
  const filePath = path.join(MODELS_DIR, 'move_recommendations.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// support_ratio divides by the Pokemon's actual trained top-move count (capped at 10),
// not a fixed 10 — a species with e.g. 7 recorded moves would otherwise have its
// support signal diluted by 3 phantom "non-support" slots that don't really exist.
function getMoveSignals(pokemonLower, moveRec) {
  const entry = moveRec?.pokemon[pokemonLower];
  const topMoves = (entry?.moves || []).slice(0, 10).map((m) => m.move);
  if (topMoves.length === 0) return { supportRatio: 0, offensiveRatio: 1 };

  const supportCount = topMoves.filter((m) => SUPPORT_MOVES.has(m.toLowerCase())).length;
  const supportRatio = supportCount / topMoves.length;
  return { supportRatio, offensiveRatio: 1 - supportRatio };
}

async function getSpAverages(pokemonLower) {
  const { rows } = await pool.query(
    `SELECT AVG((sp->>'spe')::int) as avg_spe, AVG((sp->>'atk')::int) as avg_atk, AVG((sp->>'spa')::int) as avg_spa,
            AVG((sp->>'hp')::int) as avg_hp, AVG((sp->>'def')::int) as avg_def, AVG((sp->>'spd')::int) as avg_spd,
            COUNT(*) as n
     FROM ev_observations WHERE LOWER(normalized_name) = $1`,
    [pokemonLower]
  );
  const row = rows[0];
  const n = parseInt(row.n, 10);
  if (n === 0) return null;
  return {
    n,
    avgSpe: parseFloat(row.avg_spe) || 0,
    avgAtk: parseFloat(row.avg_atk) || 0,
    avgSpa: parseFloat(row.avg_spa) || 0,
    avgHp: parseFloat(row.avg_hp) || 0,
    avgDef: parseFloat(row.avg_def) || 0,
    avgSpd: parseFloat(row.avg_spd) || 0,
  };
}

// Fallback tie-break only — a transparent recombination of the exact same signals the
// rule checks above use, not a new/hidden scoring system, and not Pokemon-specific.
function fitScore(role, s) {
  switch (role) {
    case 'fast_offense':
      return (s.fast ? 1 : 0) + s.offensiveRatio + Math.max(s.attackFocused, s.speedFocused);
    case 'slow_bulky_offense':
      return (s.fast ? 0 : 1) + s.offensiveRatio + (s.bulky ? 1 : 0);
    case 'slow_bulky_support':
      return s.supportRatio + (s.fast ? 0 : 1) + s.defenseFocused;
    case 'fast_support':
      return (s.fast ? 1 : 0) + s.supportRatio * 2;
    default:
      return 0;
  }
}

// How strongly the signals clear the assigned rule's own thresholds — scaled into
// [0.6, 1.0] for a clean rule match (see classifyRole) so confidence still reflects
// real margin rather than being a flat constant whenever a rule fires.
function computeMatchConfidence(role, s) {
  let margins;
  switch (role) {
    case 'fast_offense':
      margins = [
        clamp01((s.offensiveRatio - 0.6) / 0.4),
        clamp01((Math.max(s.attackFocused, s.speedFocused) - 0.4) / 0.6),
      ];
      break;
    case 'slow_bulky_offense':
      margins = [clamp01((s.offensiveRatio - 0.6) / 0.4), s.bulky ? 1 : 0];
      break;
    case 'slow_bulky_support':
      margins = [clamp01((s.supportRatio - 0.4) / 0.6), s.fast ? clamp01((s.defenseFocused - 0.4) / 0.6) : 1];
      break;
    case 'fast_support':
      margins = [clamp01((s.supportRatio - 0.3) / 0.7)];
      break;
    default:
      margins = [0];
  }
  const avg = margins.reduce((a, b) => a + b, 0) / margins.length;
  return round(0.6 + 0.4 * avg);
}

async function classifyRole(pokemonName) {
  const pokemonLower = pokemonName.toLowerCase();
  if (roleCache.has(pokemonLower)) return roleCache.get(pokemonLower);

  const speciesRow = await getSpeciesRow(pokemonLower);
  if (!speciesRow) return null;

  const fast = speciesRow.spe >= FAST_SPEED_THRESHOLD;
  const offensive = speciesRow.atk >= OFFENSIVE_STAT_THRESHOLD || speciesRow.spa >= OFFENSIVE_STAT_THRESHOLD;
  const bulkyTotal = speciesRow.hp + speciesRow.def + speciesRow.spd;
  const bulky = bulkyTotal >= BULKY_TOTAL_THRESHOLD;

  const moveRec = readMoveRecommendations();
  const { supportRatio, offensiveRatio } = getMoveSignals(pokemonLower, moveRec);
  const spAvg = await getSpAverages(pokemonLower);

  let speedFocused;
  let attackFocused;
  let defenseFocused;
  if (spAvg) {
    speedFocused = spAvg.avgSpe / 32;
    attackFocused = (spAvg.avgAtk + spAvg.avgSpa) / 32;
    defenseFocused = (spAvg.avgHp + spAvg.avgDef + spAvg.avgSpd) / 66;
  } else {
    // No real ev_observations for this species — derive from the base-stat booleans
    // instead of leaving these undefined (Signal 1 only, nothing fabricated).
    speedFocused = fast ? 1 : 0;
    attackFocused = offensive ? 1 : 0;
    defenseFocused = bulky ? 1 : 0;
  }

  const fitInputs = { fast, offensiveRatio, attackFocused, speedFocused, bulky, supportRatio, defenseFocused };

  let role = null;
  if (fast && offensiveRatio >= 0.6 && (attackFocused >= 0.4 || speedFocused >= 0.4)) {
    role = 'fast_offense';
  } else if (!fast && offensiveRatio >= 0.6 && bulky) {
    role = 'slow_bulky_offense';
  } else if (supportRatio >= 0.4 && (!fast || defenseFocused >= 0.4)) {
    role = 'slow_bulky_support';
  } else if (fast && supportRatio >= 0.3) {
    role = 'fast_support';
  }

  let confidence;
  if (role) {
    confidence = computeMatchConfidence(role, fitInputs);
  } else {
    const fits = ['fast_offense', 'slow_bulky_offense', 'slow_bulky_support', 'fast_support']
      .map((r) => ({ r, score: fitScore(r, fitInputs) }))
      .sort((a, b) => b.score - a.score);
    role = fits[0].r;
    const spread = fits[0].score - (fits[1]?.score ?? 0);
    confidence = round(0.3 + clamp01(spread / 2) * 0.3);
  }

  const result = {
    role,
    signals: {
      fast,
      offensive,
      bulky,
      support_ratio: round(supportRatio),
      speed_focused: round(speedFocused),
      attack_focused: round(attackFocused),
      defense_focused: round(defenseFocused),
    },
    confidence,
  };

  roleCache.set(pokemonLower, result);
  return result;
}

module.exports = { classifyRole, FAST_SPEED_THRESHOLD, OFFENSIVE_STAT_THRESHOLD, BULKY_TOTAL_THRESHOLD };
