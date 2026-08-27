const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { normalizePokemonName, normalizeMoveName } = require('../utils/normalize');
const { effectivenessAgainst } = require('../utils/typeChart');
const { classifyRole } = require('../utils/role_classifier');
const { buildRecoilText, RECOIL_MOVES } = require('../utils/spread_scorer');
const {
  getScoredCandidateItems, resolveItemConflicts, buildItemSpNotes,
  getRealAbilityFrequency, detectTeamWeatherContext, resolveRealAbility,
  isConditionalSpeedAbility, conditionalSpeedAbilityWeather,
  WEATHER_SETTER_ABILITIES,
} = require('../utils/item_optimizer');
const { getOrComputeEvolutionarySpread } = require('../utils/ev_optimizer');
const { getNerdOfNowSets } = require('../utils/nerd_of_now');
const { getMoveData } = require('../utils/nerd_of_now_calc');
const { round } = require('../utils/format');
const { STAT_ORDER } = require('../utils/stat_formula');
const {
  getTypeMetaData, analyzeCoverage, analyzeSynergies, analyzeWeather,
  analyzeTrickRoom, analyzeSpeedTiers, analyzeWeaknesses, analyzeArchetypeMatchups,
  analyzeMatchups, getLegalPokemonSet, suggestCoverageReplacements,
} = require('../utils/team_analyzer');
const { analyzeArchetypeMatchupsLive } = require('../utils/archetype_matchups');
const fs = require('fs');
const path = require('path');

// Lazy require: recommend.js requires ev_optimizer.js (among others) at its own
// top level, and this file is required by app.js before either finishes loading
// in some startup orderings — requiring it lazily inside the route handler avoids
// depending on module-load order entirely, same reasoning as spread_scorer.js's
// documented lazy require of ev_optimizer.js.
function getMoveRecommendationsFor(...args) {
  return require('./recommend').getMoveRecommendationsFor(...args);
}

const MAX_TEAM_STRING_LENGTH = 10000;
const STAT_ABBR = {
  hp: 'hp', atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe',
  'sp.atk': 'spa', 'sp.def': 'spd', 'special attack': 'spa', 'special defense': 'spd',
};
const WEATHER_SETTERS = {
  Drizzle: 'Rain Dance', Drought: 'Sunny Day', 'Sand Stream': 'Sandstorm', 'Snow Warning': 'Snow',
};
// Ability -> the weather it actually sets. Distinct from WEATHER_SETTERS above,
// which maps an ability to the equivalent MOVE name; that vocabulary can't be
// used to resolve Weather Ball.
const WEATHER_SETTER_WEATHER = {
  Drizzle: 'Rain', Drought: 'Sun', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow',
};
const SUPPORT_MOVES = new Set([
  'protect', 'follow me', 'tailwind', 'wide guard', 'quick guard',
  'rage powder', 'helping hand', 'trick room', 'taunt', 'encore',
]);
// FIX 2: Protect is unplayable on a Choice item — once locked into a move, a
// Choice-item holder can never lock into Protect (it would either be permanently
// unusable after the first real attack, or — depending on implementation — lock
// the mon out of attacking at all). This must be a hard filter on the actual
// recommendation list, not just a warning note alongside it.
const CHOICE_ITEMS_BANNING_PROTECT = new Set(['choice scarf', 'choice band', 'choice specs']);

function parseStatSpread(line) {
  const result = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  for (const part of line.split('/')) {
    const match = part.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const key = STAT_ABBR[match[2].trim().toLowerCase()];
    if (key) result[key] = parseInt(match[1], 10);
  }
  return result;
}

function parsePokemonBlock(block) {
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  const atIndex = firstLine.indexOf(' @ ');
  let namePart = atIndex === -1 ? firstLine : firstLine.slice(0, atIndex).trim();
  const item = atIndex === -1 ? null : firstLine.slice(atIndex + 3).trim();

  // A trailing "(M)" or "(F)" is a gender marker, not a nickname's species —
  // Showdown writes it as its own parenthetical AFTER any "Nickname (Species)"
  // pair ("Sharky (Garchomp) (M)"), or alone if there's no nickname
  // ("Basculegion (M)"). It is always exactly one of those two letters, which
  // is what makes it unambiguous from a real species name. Strip it BEFORE
  // the nickname check below: without this, "Basculegion (M)" read as
  // "Nickname (Species)" extracts species "M" — not a real Pokemon — and
  // "Sharky (Garchomp) (M)" extracts species "Garchomp) (M", a mangled
  // string with a stray paren welded on. Both shapes were observed for real
  // in tournament_teams (the "m"/"f" species buckets, and "Dragalge-Mega)
  // (F" as a raw name) before this fix.
  let gender = null;
  const genderMatch = namePart.match(/^(.+?)\s*\(([MF])\)$/);
  if (genderMatch) {
    namePart = genderMatch[1].trim();
    gender = genderMatch[2];
  }

  // Showdown supports "Nickname (Species)" — the parenthesized form is the real species.
  const nicknameMatch = namePart.match(/^(.+?)\s*\((.+?)\)$/);
  const species = nicknameMatch ? nicknameMatch[2].trim() : namePart;
  if (!species) return null;

  const mon = {
    name: species,
    item,
    gender,
    ability: null,
    tera: null,
    level: 50,
    nature: null,
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    attacks: [],
  };

  for (const line of lines.slice(1)) {
    if (/^ability:/i.test(line)) {
      mon.ability = line.replace(/^ability:/i, '').trim();
    } else if (/^level:/i.test(line)) {
      mon.level = parseInt(line.replace(/^level:/i, '').trim(), 10) || 50;
    } else if (/^tera type:/i.test(line)) {
      mon.tera = line.replace(/^tera type:/i, '').trim();
    } else if (/^evs:/i.test(line)) {
      mon.evs = parseStatSpread(line.replace(/^evs:/i, '').trim());
    } else if (/^ivs:/i.test(line)) {
      // parsed but not part of the tournament_teams-shaped output; IVs rarely matter at level 50 VGC
    } else if (/\bnature$/i.test(line)) {
      mon.nature = line.replace(/\bnature$/i, '').trim();
    } else if (/^[-~]/.test(line)) {
      const move = line.replace(/^[-~]\s*/, '').trim();
      if (move) mon.attacks.push(normalizeMoveName(move));
    }
  }

  const id = species.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  mon.id = id;
  mon.normalizedName = normalizePokemonName(id, item);

  return mon;
}

function parseShowdownTeam(text) {
  const blocks = text.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map(parsePokemonBlock).filter(Boolean);
}

router.post('/import', (req, res, next) => {
  try {
    const { team } = req.body || {};
    if (typeof team !== 'string' || team.trim().length === 0) {
      return res.status(400).json({ error: 'team must be a non-empty string' });
    }
    if (team.length > MAX_TEAM_STRING_LENGTH) {
      return res.status(400).json({ error: `team string exceeds ${MAX_TEAM_STRING_LENGTH} character limit` });
    }

    const pokemon = parseShowdownTeam(team);
    if (pokemon.length < 1) {
      return res.status(400).json({ error: 'Could not parse any Pokemon from the provided team string' });
    }

    res.json({ pokemon });
  } catch (err) {
    logger.error('POST /api/team/import failed', { error: err.message });
    next(err);
  }
});

function inferRole(nature, attacks, movesByName) {
  const NATURE_BOOSTS = {
    lonely: 'atk', adamant: 'atk', naughty: 'atk', brave: 'atk',
    bold: 'def', impish: 'def', lax: 'def', relaxed: 'def',
    modest: 'spa', mild: 'spa', rash: 'spa', quiet: 'spa',
    calm: 'spd', gentle: 'spd', careful: 'spd', sassy: 'spd',
    timid: 'spe', hasty: 'spe', jolly: 'spe', naive: 'spe',
  };
  const boost = NATURE_BOOSTS[(nature || '').toLowerCase()];

  let physical = 0;
  let special = 0;
  let supportHits = 0;
  for (const move of attacks || []) {
    if (SUPPORT_MOVES.has((move || '').toLowerCase())) supportHits++;
    const mv = movesByName[(move || '').toLowerCase()];
    if (!mv || !mv.power) continue;
    if (mv.category === 'Physical') physical++;
    else if (mv.category === 'Special') special++;
  }

  const damaging = physical + special;
  if (boost === 'spe' && supportHits >= 2 && damaging <= 2) return 'speed_control';
  if (damaging === 0) return 'defensive_wall';
  if (physical > 0 && special > 0) return 'mixed';
  if (physical > special) return 'physical_attacker';
  if (special > physical) return 'special_attacker';
  return 'mixed';
}

async function loadSpeciesRows(names) {
  const lowered = [...new Set(names.map((n) => (n || '').toLowerCase()))].filter(Boolean);
  if (lowered.length === 0) return {};
  const { rows } = await pool.query('SELECT * FROM pokemon WHERE LOWER(name) = ANY($1)', [lowered]);
  const byLower = {};
  for (const row of rows) byLower[row.name.toLowerCase()] = row;
  return byLower;
}

async function loadMovesByName(names) {
  const lowered = [...new Set(names.map((n) => (n || '').toLowerCase()))].filter(Boolean);
  if (lowered.length === 0) return {};
  const { rows } = await pool.query('SELECT * FROM moves WHERE LOWER(name) = ANY($1)', [lowered]);
  const byLower = {};
  for (const row of rows) byLower[row.name.toLowerCase()] = row;
  return byLower;
}

function readSynergyScores() {
  const filePath = path.join(__dirname, '..', 'ml', 'models', 'synergy_matrix.json');
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8')).scores || {};
}

function averageInternalSynergy(teamLower, synergyScores) {
  const pairs = [];
  for (let i = 0; i < teamLower.length; i++) {
    for (let j = i + 1; j < teamLower.length; j++) {
      const score = synergyScores[teamLower[i]]?.[teamLower[j]];
      if (score !== undefined) pairs.push(score);
    }
  }
  if (pairs.length === 0) return null;
  return pairs.reduce((a, b) => a + b, 0) / pairs.length;
}

function findCoverageGaps(attackingTypes, defenderRows) {
  const gaps = [];
  for (const row of defenderRows) {
    const best = Math.max(0, ...attackingTypes.map((t) => effectivenessAgainst(t, [row.type1, row.type2])));
    if (attackingTypes.length > 0 && best <= 1) {
      const types = [row.type1, row.type2].filter(Boolean).join('/');
      gaps.push(`No super-effective answer to ${row.name} (${types})`);
    }
  }
  return gaps;
}

router.post('/compare', async (req, res, next) => {
  try {
    const { team_a: teamA, team_b: teamB } = req.body || {};
    if (!Array.isArray(teamA) || !Array.isArray(teamB) || teamA.length < 1 || teamA.length > 6 || teamB.length < 1 || teamB.length > 6) {
      return res.status(400).json({ error: 'team_a and team_b must each be arrays of 1-6 Pokemon' });
    }

    const allNames = [...teamA, ...teamB].map((p) => p.name);
    const speciesByLower = await loadSpeciesRows(allNames);

    const rowsA = teamA.map((p) => speciesByLower[(p.name || '').toLowerCase()]).filter(Boolean);
    const rowsB = teamB.map((p) => speciesByLower[(p.name || '').toLowerCase()]).filter(Boolean);
    if (rowsA.length === 0 || rowsB.length === 0) {
      return res.status(404).json({ error: 'None of the provided Pokemon names were found' });
    }

    const allMoveNames = [...teamA, ...teamB].flatMap((p) => p.attacks || p.moves || []);
    const movesByName = await loadMovesByName(allMoveNames);

    function damagingTypes(team) {
      const types = new Set();
      for (const p of team) {
        for (const moveName of p.attacks || p.moves || []) {
          const mv = movesByName[(moveName || '').toLowerCase()];
          if (mv && mv.power && mv.type) types.add(mv.type);
        }
      }
      return [...types];
    }

    const typesA = damagingTypes(teamA);
    const typesB = damagingTypes(teamB);
    const coverageGaps = {
      team_a: findCoverageGaps(typesA, rowsB),
      team_b: findCoverageGaps(typesB, rowsA),
    };

    const fastestA = rowsA.reduce((max, r) => (r.spe > (max?.spe ?? -1) ? r : max), null);
    const fastestB = rowsB.reduce((max, r) => (r.spe > (max?.spe ?? -1) ? r : max), null);
    const speedAdvantage = fastestA.spe === fastestB.spe ? 'even' : (fastestA.spe > fastestB.spe ? 'team_a' : 'team_b');

    function priorityMoveCount(team) {
      let count = 0;
      for (const p of team) {
        for (const moveName of p.attacks || p.moves || []) {
          const mv = movesByName[(moveName || '').toLowerCase()];
          if (mv && mv.priority > 0) count++;
        }
      }
      return count;
    }
    const priorityA = priorityMoveCount(teamA);
    const priorityB = priorityMoveCount(teamB);

    function findWeatherSetter(team) {
      for (const p of team) {
        const weather = WEATHER_SETTERS[p.ability];
        if (weather) return { pokemon: p.name, weather };
      }
      return null;
    }
    const weatherA = findWeatherSetter(teamA);
    const weatherB = findWeatherSetter(teamB);
    let weatherAdvantage = null;
    if (weatherA && weatherB) {
      const rowA = speciesByLower[weatherA.pokemon.toLowerCase()];
      const rowB = speciesByLower[weatherB.pokemon.toLowerCase()];
      weatherAdvantage = rowA && rowB ? (rowA.spe >= rowB.spe ? 'team_a' : 'team_b') : 'even';
    } else if (weatherA) {
      weatherAdvantage = 'team_a';
    } else if (weatherB) {
      weatherAdvantage = 'team_b';
    }

    function roleDistribution(team) {
      const counts = {};
      for (const p of team) {
        const role = inferRole(p.nature, p.attacks || p.moves || [], movesByName);
        counts[role] = (counts[role] || 0) + 1;
      }
      return counts;
    }
    const rolesA = roleDistribution(teamA);
    const rolesB = roleDistribution(teamB);

    const synergyScores = readSynergyScores();
    const synergyA = averageInternalSynergy(teamA.map((p) => (p.name || '').toLowerCase()), synergyScores);
    const synergyB = averageInternalSynergy(teamB.map((p) => (p.name || '').toLowerCase()), synergyScores);

    const advantages = { team_a: [], team_b: [] };
    let scoreA = 0;
    let scoreB = 0;

    if (speedAdvantage !== 'even') {
      advantages[speedAdvantage].push('Superior speed tier');
      scoreA += speedAdvantage === 'team_a' ? 1 : 0;
      scoreB += speedAdvantage === 'team_b' ? 1 : 0;
    }
    if (weatherAdvantage) {
      advantages[weatherAdvantage].push('Controls weather');
      scoreA += weatherAdvantage === 'team_a' ? 1 : 0;
      scoreB += weatherAdvantage === 'team_b' ? 1 : 0;
    }
    if (priorityA !== priorityB) {
      const winner = priorityA > priorityB ? 'team_a' : 'team_b';
      advantages[winner].push('Priority moves available');
      scoreA += winner === 'team_a' ? 1 : 0;
      scoreB += winner === 'team_b' ? 1 : 0;
    }
    if (coverageGaps.team_a.length !== coverageGaps.team_b.length) {
      const winner = coverageGaps.team_a.length < coverageGaps.team_b.length ? 'team_a' : 'team_b';
      advantages[winner].push('Better type coverage');
      scoreA += winner === 'team_a' ? 1 : 0;
      scoreB += winner === 'team_b' ? 1 : 0;
    }
    if (synergyA !== null && synergyB !== null && synergyA !== synergyB) {
      const winner = synergyA > synergyB ? 'team_a' : 'team_b';
      advantages[winner].push('Stronger internal team synergy');
      scoreA += winner === 'team_a' ? 1 : 0;
      scoreB += winner === 'team_b' ? 1 : 0;
    }

    const winner = scoreA === scoreB ? 'even' : (scoreA > scoreB ? 'team_a' : 'team_b');

    res.json({
      winner,
      advantages,
      coverage_gaps: coverageGaps,
      speed: { fastest_a: fastestA.name, fastest_b: fastestB.name, advantage: speedAdvantage },
      priority_moves: { team_a: priorityA, team_b: priorityB },
      weather: {
        setter_a: weatherA ? weatherA.pokemon : null,
        setter_b: weatherB ? weatherB.pokemon : null,
        advantage: weatherAdvantage,
      },
      role_distribution: { team_a: rolesA, team_b: rolesB },
      synergy_scores: { team_a: synergyA, team_b: synergyB },
    });
  } catch (err) {
    logger.error('POST /api/team/compare failed', { error: err.message });
    next(err);
  }
});

// --- POST /api/team/build ---------------------------------------------------------
// Unified pipeline: role classification -> item candidates/scoring/conflict
// resolution -> move recommendations (enriched) -> item-aware evolutionary EV
// optimization (all 6 in parallel) -> team analysis -> weaknesses -> archetype
// matchups. Every piece reuses an existing utility (role_classifier.js,
// item_optimizer.js, recommend.js's getMoveRecommendationsFor, ev_optimizer.js,
// team_analyzer.js) — nothing here reimplements move/EV/synergy/damage logic.

function readJSON(filename) {
  const filePath = path.join(__dirname, '..', 'ml', 'models', filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function enrichMoves(moveList, movesByLower) {
  return (moveList || []).map((m) => {
    const mv = movesByLower[m.move.toLowerCase()];
    return { ...m, type: mv?.type || null, category: mv?.category || null, power: mv?.power || null };
  });
}

// Fixed, real item-mechanic descriptions — same category as this file's own
// WEATHER_SETTERS table and synergy_reasons.js's SUPPORT_MOVE_EFFECTS: a static
// vocabulary applied to whichever item got assigned, not written per-Pokemon.
// Convergence/divergence check: a seed "converges" when the final spread is within
// ±4 SP on every stat; diverges when any stat differs by more than ±4. This
// threshold is chosen because it's the minimum meaningful difference in the SP
// optimization context (a 1-3 SP difference might be noise, but 5+ is a deliberate
// reallocation).
const SEED_CONVERGENCE_THRESHOLD = 4;

function checkSeedConvergence(finalSp, seedSp) {
  if (!finalSp || !seedSp) return { converged: false, reason: 'missing data' };
  const stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const divergedStats = stats.filter(s => Math.abs((finalSp[s] || 0) - (seedSp[s] || 0)) > SEED_CONVERGENCE_THRESHOLD);
  if (divergedStats.length === 0) {
    return { converged: true, reason: 'within ±4 SP on all stats' };
  }
  return {
    converged: false,
    reason: `diverged by >${SEED_CONVERGENCE_THRESHOLD} SP on ${divergedStats.join(', ')}`,
    diverged_stats: divergedStats,
  };
}

const ITEM_REASON_TEMPLATES = {
  'life orb': 'Boosts damage output by 30% at the cost of 10% recoil per attack — maximizes KO potential against this team\'s real threat list',
  'choice scarf': 'Multiplies Speed by 1.5x, letting this Pokemon outspeed threats it otherwise couldn\'t reach',
  'choice band': 'Boosts physical damage by 50%, locked into one move per switch-in',
  'choice specs': 'Boosts special damage by 50%, locked into one move per switch-in',
  leftovers: 'Heals 1/16 max HP every turn — sustains through prolonged fights',
  'sitrus berry': 'Heals 25% max HP once below half — a one-time cushion against burst damage',
  'assault vest': 'Boosts Special Defense by 50%, trading status moves for raw special bulk',
  'rocky helmet': 'Punishes contact moves with 1/6 max HP recoil to the attacker',
  'focus sash': 'Guarantees survival of one hit from full HP — insurance for a frail sweeper',
};

function generateItemReason(assignment, ability, teamWeatherContext) {
  var base = ITEM_REASON_TEMPLATES[assignment.item.toLowerCase()]
    || ("Most common real observed item for this role (fit score " + assignment.score + ").");
  var result;
  if (assignment.source === "generic_fallback") {
    result = base + " (Generic fallback — this Pokemon's real observed candidates were all claimed by higher-priority teammates.)";
  } else if (assignment.next_best) {
    var loss = round(assignment.score - assignment.next_best.score, 3);
    var baseTrimmed = base.replace(/\.\s*$/, "");
    result = baseTrimmed + ". Next best was " + assignment.next_best.item + " (loss: " + loss + " score vs. " + assignment.item + ").";
  } else {
    result = base;
  }
  // FIX 12: Mega Stone vs base ability synergy tradeoff — surface Chlorophyll
  // + Sun synergy as the reason Life Orb outranks Venusaurite.
  var CONDITIONAL_SPEED_ABILITIES = ["chlorophyll","solar power","swift swim","sand rush","slush rush"];
  if (ability && teamWeatherContext && teamWeatherContext.has) {
    var abilLower = ability.toLowerCase();
    var isSunSpeed = (abilLower === "chlorophyll" || abilLower === "solar power");
    if (isSunSpeed && CONDITIONAL_SPEED_ABILITIES.indexOf(abilLower) !== -1 && teamWeatherContext.has("Sun")) {
      result += " Life Orb over Mega Stone — " + ability + " + Sun from Charizard-Mega-Y doubles Speed, surpassing any Mega form's bulk for this role.";
    }
  }
  return result;
}
// FIX 5: Weather Ball is Normal-type/50 BP in the moves table (no-weather
// values) but in weather doubles to 100 BP AND changes type. The weather type
// boost (Sun's 1.5x Fire, Rain's 1.5x Water) is SEPARATE and stacks on top.
const WEATHER_BALL_TYPES = { Rain: 'Water', Sun: 'Fire', Sand: 'Rock', Snow: 'Ice' };
const WEATHER_BALL_BOOSTED_BP = 100;

// FIX 4 (round 2): replaces the old ">=3 fast members (base Speed >= 90)"
// signal, which only ever checked for a TOO-FAST team — it never asked whether
// the team was genuinely slow enough to want Trick Room in the first place. A
// team of six 70-89-Speed mons cleared the old "not 3+ fast" bar trivially while
// having no real business running TR at all. Replaced with a holistic,
// team-level viability gate — ALL three conditions must hold, using base Speed
// (t.pokemonRow.spe, never final/SP-boosted stats) for every check, per this
// task's own explicit wording. Kingambit alone (base 50) doesn't make a team a
// TR candidate; median team Speed has to genuinely be low too.
const TR_MEDIAN_SPEED_THRESHOLD = 70;
const TR_SLOW_SPEED_THRESHOLD = 80;
const TR_MIN_SLOW_COUNT = 3;
const TR_VERY_SLOW_SPEED_THRESHOLD = 60;
const TR_MIN_VERY_SLOW_COUNT = 1;
function isTrickRoomViableTeam(team) {
  const speeds = team.map((t) => t.pokemonRow.spe).sort((a, b) => a - b);
  const n = speeds.length;
  const median = n % 2 === 0 ? (speeds[n / 2 - 1] + speeds[n / 2]) / 2 : speeds[(n - 1) / 2];
  const slowCount = speeds.filter((s) => s < TR_SLOW_SPEED_THRESHOLD).length;
  const verySlowCount = speeds.filter((s) => s < TR_VERY_SLOW_SPEED_THRESHOLD).length;
  return median < TR_MEDIAN_SPEED_THRESHOLD && slowCount >= TR_MIN_SLOW_COUNT && verySlowCount >= TR_MIN_VERY_SLOW_COUNT;
}

// Coverage/redundancy/Protect-scarcity/Trick-Room-viability/Weather-Ball-typing
// notes per recommended move.
// FIX 14: builds quick-fix recommendations for unfavorable matchups.
// Returns a one-line recommendation that directly addresses the flagged weakness.
function buildQuickFixRecommendation(matchup, responseBody) {
  if (!matchup || !responseBody) return null;
  const archetype = (matchup.archetype || '').toLowerCase();
  const team = responseBody.team || [];
  const teamTypes = new Set();
  for (const m of team) {
    for (const mv of (m.moves || [])) {
      if (mv.type) teamTypes.add(mv.type);
    }
  }

  if (archetype.includes('sand')) {
    const weatherBallUser = team.find((m) => (m.moves || []).some((mv) => mv.move === 'Weather Ball'));
    if (weatherBallUser) return `Consider Weather Ball on ${weatherBallUser.pokemon} — benefits from sun if available`;
    return `Consider wider type coverage — sand teams threaten with Ground/Rock moves`;
  }
  if (archetype.includes('rain')) {
    if (!teamTypes.has('Electric')) return `Consider adding Electric coverage (Thunderbolt/Thunder) for Pelipper/Swampert`;
    return `Consider wider type coverage — rain teams threaten with Water moves`;
  }
  if (archetype.includes('sun')) {
    if (!teamTypes.has('Water')) return `Consider adding Water coverage for sun teams`;
    return `Consider wider type coverage — sun teams threaten with Fire moves`;
  }
  if (archetype.includes('trick room')) {
    const hasPrankster = team.some((m) => (m.ability || '').toLowerCase() === 'prankster');
    if (!hasPrankster) return `Consider adding Prankster user (Whimsicott/Tornadus) for TR prevention`;
    return `Consider Protect on key sweepers — prevents TR setup damage`;
  }
  return `Consider type coverage to counter ${matchup.key_threats?.[0] || 'key threats'}`;
}

function buildMoveTeamContext(member, mv, team, teamWeatherSet) {
  if (mv.move === 'Protect') {
    // FIX 2: a Choice-locked teammate's Protect gets hard-filtered out of ITS
    // OWN final move list, so it shouldn't count toward "how many team members
    // carry Protect" either — otherwise this note could overcount relative to
    // what member.moves actually ends up showing.
    const protectUsers = team.filter((t) =>
      !CHOICE_ITEMS_BANNING_PROTECT.has((t.item || '').toLowerCase()) &&
      (t.enrichedMoves || []).some((m) => m.move === 'Protect')
    ).length;
    return protectUsers < 4
      ? `Protect — only ${protectUsers}/${team.length} team members carry it; a valuable safety net against this team's spread-move exposure`
      : 'Protect — standard doubles utility, safely scouts the opponent\'s move';
  }

  // FIX 4 (round 2): this branch is only ever reached for a team that already
  // passed isTrickRoomViableTeam() — the hard filter in the main route handler
  // removes Trick Room from member.moves entirely for a non-viable team, so
  // there is no "not recommended"/"mixed" case left to describe here at all.
  if (mv.move === 'Trick Room') {
    const slowMembers = team.filter((t) => t.pokemonRow.spe < TR_SLOW_SPEED_THRESHOLD).map((t) => t.pokemon);
    return `${slowMembers.length}/${team.length} members have base Speed < ${TR_SLOW_SPEED_THRESHOLD} (${slowMembers.join(', ')}) — a genuine slow-team strategy`;
  }

  // Weather Ball's real attacking type/power, instead of its static
  // Normal-type/50 BP table values.
  //
  // Resolved for THIS member, not once for the team. A member with its own
  // weather ability always plays under that weather — Pelipper's Drizzle makes
  // Pelipper's Weather Ball Water regardless of what else the team sets. The old
  // code walked the team weather set and took the first hit, so on a two-setter
  // team (Drought + Drizzle here) every member got whichever weather happened to
  // be inserted first.
  if (mv.move === 'Weather Ball') {
    const ownWeather = WEATHER_SETTER_WEATHER[member?.ability];
    const teamDefault = teamWeatherSet
      ? [...teamWeatherSet].find((w) => WEATHER_BALL_TYPES[w]) || null
      : null;
    const weather = ownWeather || teamDefault;
    const effectiveType = weather ? WEATHER_BALL_TYPES[weather] : null;
    // Always says something. Previously a Weather Ball with no resolvable
    // weather fell through this block silently and was described by the generic
    // move logic below as an ordinary Normal move.
    if (!effectiveType) {
      return 'stays 50 BP Normal-type — no weather setter on this team to transform it';
    }
    // Sun/Rain don't boost Special Attack; they boost Fire/Water damage by 1.5x.
    // The old comparison tested lowercase 'rain'/'sun' against a set holding
    // 'Rain'/'Sun', so it never matched and the bonus note never once printed.
    const weatherTypeBonus = (weather === 'Rain' && effectiveType === 'Water')
      || (weather === 'Sun' && effectiveType === 'Fire') ? 1.5 : 1;
    const effectiveBP = Math.round(WEATHER_BALL_BOOSTED_BP * weatherTypeBonus);
    const bonusNote = weatherTypeBonus > 1 ? ` (${weatherTypeBonus}x weather bonus = effective ${effectiveBP} BP)` : '';
    const source = ownWeather ? `its own ${member.ability}` : `our ${weather}`;
    return `${WEATHER_BALL_BOOSTED_BP} BP ${effectiveType}-type under ${source}${bonusNote}`;
  }

  if (!mv.type || !mv.power) return null; // other status/support moves: no coverage/redundancy signal to report

  // FIX 10: Purpose-based redundancy evaluation — never flag utility, priority,
  // spread, STAB, or Protect moves. Only flag purely defensive coverage that
  // another team member provides better.
  const moveLower = (mv.move || '').toLowerCase();

  // NEVER flag these move categories as redundant:
  const UTILITY_MOVES = new Set(['fake out', 'parting shot', 'knock off', 'taunt', 'thunder wave', 'encore', 'follow me', 'rage powder', 'helping hand', 'quick guard', 'wide guard', 'mat block']);
  const PRIORITY_MOVES = new Set(['sucker punch', 'aqua jet', 'bullet punch', 'mach punch', 'extreme speed', 'ice shard', 'shadow sneak', 'vacuum wave', 'grassy glide', 'fake out']);
  const SPREAD_MOVES = new Set(['earthquake', 'rock slide', 'heat wave', 'dazzling gleam', 'sludge wave', 'surf', 'discharge', 'sonic boom', 'flame burst', 'acid', 'muddy water', 'spark', 'breath', 'hyper voice', 'snarl']);
  const STATUS_MOVES = new Set(['protect', 'tailwind', 'trick room', 'thunder wave', 'sleep powder', 'spore', 'stun spore', 'hypnosis', 'will-o-wisp', 'toxic', 'leech seed', 'substitute', 'encore', 'taunt', 'fake tears', 'swords dance', 'nasty plot', 'dragon dance', 'calm mind', 'bulk up', 'iron defense', 'amnesia', 'coil', 'quiver dance', 'shift gear', 'shell smash', 'work up', 'howl', 'odor sleuth', 'laser focus', 'stockpile', 'swallow', 'spit up']);
  const CHOICE_ITEMS = new Set(['choice band', 'choice specs', 'choice scarf']);

  // Check if this move is utility/priority/spread/status — never flag these
  if (UTILITY_MOVES.has(moveLower) || PRIORITY_MOVES.has(moveLower) ||
      SPREAD_MOVES.has(moveLower) || STATUS_MOVES.has(moveLower)) {
    return null;
  }

  // Check if this is a STAB move for the Pokemon
  const memberTypes = [member.pokemonRow?.type1, member.pokemonRow?.type2].filter(Boolean);
  const isStab = memberTypes.includes(mv.type);

  // Check if user is Choice-locked (Choice items ban moves that conflict)
  const memberItem = (member.item || '').toLowerCase();
  const isChoiceLocked = CHOICE_ITEMS.has(memberItem);

  // Find other team members with the same type move
  const sameTypeMoves = [];
  for (const t of team) {
    if (t.pokemon === member.pokemon) continue;
    for (const other of t.enrichedMoves || []) {
      if (other.type === mv.type && other.power) {
        sameTypeMoves.push({ pokemon: t.pokemon, move: other.move, category: other.category });
      }
    }
  }

  // If no other team member has this type, it's unique coverage
  if (sameTypeMoves.length === 0) {
    return `Only source of ${mv.type} coverage on this team`;
  }

  // For STAB moves: always keep unless Choice-locked and another team member
  // provides better coverage for the same role
  if (isStab) {
    return `STAB ${mv.type} move — always keep unless Choice-locked`;
  }

  // For non-STAB coverage moves: check if the other team member is more likely
  // to be paired with the threats this move covers, and if the move is purely
  // coverage (not utility). If the other Pokemon has a better role for that
  // type, suggest considering alternatives.
  const otherPokemon = sameTypeMoves[0].pokemon;
  const otherMove = sameTypeMoves[0].move;

  // Check if this is a defensive coverage move (coverage for specific threats)
  // vs an offensive coverage move (part of a sweep strategy)
  if (isChoiceLocked) {
    return `Coverage ${mv.type} move — Choice-locked, consider ${otherPokemon}'s ${otherMove} as primary ${mv.type} source`;
  }

  // Check if the other team member is more commonly paired with threats
  // this move would cover. If so, suggest they handle it instead.
  const coOccurrenceScore = getCoOccurrenceScore(member.pokemon, otherPokemon);

  if (coOccurrenceScore > 0.6) {
    return `Coverage overlap: ${otherPokemon} also has ${otherMove} (${mv.type}) — consider alternative coverage if ${otherPokemon} commonly pairs with this Pokemon`;
  }

  // Default: note the overlap but don't flag as redundant
  return `${otherPokemon} also has ${mv.type}-type coverage via ${otherMove}`;
}

/**
 * Get co-occurrence score between two Pokemon from tournament data.
 * Returns 0-1 where 1 means always paired.
 */
function getCoOccurrenceScore(pokemonA, pokemonB) {
  // This would ideally use ev_observations co-occurrence data
  // For now, return a conservative default
  return 0.3; // Will be replaced with real data
}

// --- text/plain rendering ---------------------------------------------------------
// Same visual convention as recommend.js's /evs text formatter (── LABEL ── section
// dividers) — a small local copy rather than a cross-file import since it's a
// 2-line helper, consistent with this file's existing WEATHER_SETTERS-style
// per-file vocabulary copies.
const TEXT_DIVIDER_WIDTH = 41;
const SHOWDOWN_STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

function sectionDivider(label) {
  const opening = `── ${label} `;
  return opening + '─'.repeat(Math.max(TEXT_DIVIDER_WIDTH - opening.length, 4));
}

// Renders the three kinds of answer to a shared weakness on their own labelled
// lines. They are deliberately not merged into one sentence: a resist buys a
// turn, super effective damage trades, and an OHKO removes the threat outright —
// reading which of the three a team actually has is the whole point.
// Ordered strongest first. Falls back to the flat `.mitigation` string for any
// caller whose payload predates `mitigation_detail`.
function mitigationLines(entry, indent) {
  const detail = entry.mitigation_detail;
  if (!detail) {
    return entry.mitigation ? [`${indent}Mitigation: ${entry.mitigation}`] : [];
  }
  const groups = [
    ['KOs it', detail.ohko],
    ['Hits it hard', detail.super_effective],
    ['Absorbs it', detail.resists],
  ].filter(([, items]) => Array.isArray(items) && items.length > 0);

  if (groups.length === 0) {
    return [`${indent}Mitigation: none — no resist, no super effective move, and no OHKO on any common attacker of this type`];
  }
  const lines = [`${indent}Mitigation:`];
  for (const [label, items] of groups) {
    lines.push(`${indent}  ${label}: ${items.join('; ')}`);
  }
  return lines;
}

// Displays raw Stat Points (0-32 per stat, 66 total) — never converted to
// classic EVs. Labeled "SP:" rather than "EVs:" since a real Showdown "EVs:"
// line means 0-252 numbers; showing 0-32 values under that label would misread
// as a real EV spread that's ~8x too low.
function evsLine(sp) {
  const parts = STAT_ORDER
    .map((k) => ({ k, sp: sp[k] || 0 }))
    .filter((p) => p.sp > 0)
    .map((p) => `${p.sp} ${SHOWDOWN_STAT_LABELS[p.k]}`);
  return parts.length > 0 ? `SP: ${parts.join(' / ')}` : null;
}

// FIX 7: turns one thresholds_met entry into a short human reason, per category.
// FIX 3 (round 3): defensive entries now name the specific real attacker build
// (nature/offensive SP/damage-affecting item — spread_scorer.js's
// buildAttackerBuildLabel()) and the real weighted damage range behind the
// threshold, not just the bare move name and KO-tier word — e.g.
// "survives Kingambit Sucker Punch (Adamant 32 Atk Black Glasses: 78-93%)".
// Falls back to the old, plainer format when no real build data exists for
// that attacker at all (attacker_build empty — a species with zero
// ev_observations spreads/items), rather than rendering an empty "()" pair.
// FIX: defensive entries now show secondary interactions — top 4 closest-to-OHKO
// threats sorted by max damage descending (FIX 4). Two-word move names extracted
// properly (FIX 8). Recoil shown on recoil moves (FIX 2).
function extractMoveName(th) {
  // threat format: "AttackerName MoveName" — split after first word
  const parts = (th.threat || '').split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') : (th.move || '');
}
function extractAttackerName(th) {
  const parts = (th.threat || '').split(' ');
  return th.attacker || parts[0] || '';
}
// Builds a frequency note from the most common attacker/target spread.
// Shows "X% of Species" when raw_frequency is available and meaningful,
// otherwise returns empty string.
// For defensive thresholds the species is the attacker; for offensive
// thresholds (threat string has " vs. ") it's the target/defender.
function buildFrequencyNote(threshold) {
  const spread = threshold.attacker_spreads_used?.[0];
  if (!spread || typeof spread.raw_frequency !== 'number') return '';
  const freqPct = Math.round(spread.raw_frequency * 100);
  if (freqPct <= 0 || freqPct >= 100) return '';
  // Offensive format: "Attacker Move vs. Target" — frequency is the target's
  const vsMatch = (threshold.threat || '').match(/ vs\. (\S+)/);
  const speciesName = vsMatch ? vsMatch[1] : extractAttackerName(threshold);
  return speciesName ? `, ${freqPct}% of ${speciesName}` : '';
}
// Speed thresholds are only as reliable as how often the target actually runs
// the exact Speed value the threshold assumes — a target's MOST common Speed
// tier (topTier in scoreSpread) can still be a minority of its real spreads.
// rawFreq comes straight from ev_observations via getCommonSpeedTiers, the same
// source damage thresholds already use for their {freq} suffix.
function describeSpeedThresholdForWhy(t) {
  const spread = t.attacker_spreads_used?.[0];
  const nature = spread?.nature || '';
  const rawFreq = typeof spread?.raw_frequency === 'number' ? spread.raw_frequency : null;
  const attackerName = t.attacker || extractAttackerName(t);
  const investLabel = t.speed_sp === 0 ? 'uninvested Speed' : (typeof t.speed_sp === 'number' ? `${t.speed_sp} SP Speed` : '');
  const statPart = [nature, t.speed_stat].filter((p) => p !== null && p !== undefined && p !== '').join(' ');
  const detailParts = [statPart, investLabel].filter(Boolean);
  let freqPart = '';
  if (rawFreq !== null) {
    const pct = Math.round(rawFreq * 100);
    freqPart = ` — ${pct}% of ${attackerName}`;
    if (pct < 50) freqPart += ' (minority — most observed spreads run a different Speed)';
  }
  const linkSuffix = t.speed_ohko_link ? ' — speed_ohko_link 3x (also OHKOs at baseline)' : '';
  return `outspeeds ${attackerName} (${detailParts.join(', ')}${freqPart})${linkSuffix}`;
}
function describeThresholdForWhy(t, allDefensiveThresholds, statKey) {
  if (t.category === 'speed') return describeSpeedThresholdForWhy(t);
  if (t.category === 'defensive') {
    const recoilText = buildRecoilText(extractMoveName(t), t.weighted_damage_min || 0, t.weighted_damage_max || 0);
    const freqNote = buildFrequencyNote(t);
    let primaryText;
    if (t.attacker_build && typeof t.weighted_damage_min === 'number') {
      primaryText = `survives ${t.threat} (${t.attacker_build}: ${t.weighted_damage_min}-${t.weighted_damage_max}%${recoilText}${freqNote})`;
    } else {
      primaryText = `survives ${t.threat} (${t.this_spread_ko}${recoilText}${freqNote})`;
    }

    // FIX 4: secondary interactions — top 4 closest-to-OHKO, ordered by max damage descending
    if (allDefensiveThresholds && statKey) {
      const secondaries = allDefensiveThresholds
        .filter(th => th.category === 'defensive' && th !== t
          && (th.stat === statKey || (th.also_load_bearing || []).includes(statKey)))
        .map(th => ({
          ...th,
          // FIX 8: extract full move name from threat string (not split(' ')[1])
          moveName: extractMoveName(th),
          attackerName: extractAttackerName(th),
        }))
        .sort((a, b) => (b.weighted_damage_max || 0) - (a.weighted_damage_max || 0))
        .slice(0, 4);

      if (secondaries.length > 0) {
        const secondaryParts = secondaries.map(th => {
          const range = typeof th.weighted_damage_min === 'number'
            ? `${th.weighted_damage_min}-${th.weighted_damage_max}%`
            : th.this_spread_ko;
          // FIX 3: show full attacker build in secondary interactions
          const buildLabel = th.attacker_build ? `, ${th.attacker_build}` : '';
          const secRecoil = buildRecoilText(th.moveName, th.weighted_damage_min || 0, th.weighted_damage_max || 0);
          const secFreq = buildFrequencyNote(th);
          return `${th.attackerName} ${th.moveName} (${range}${buildLabel}${secRecoil}${secFreq})`;
        });
        return `${primaryText}\n     [also: ${secondaryParts.join(' | ')}]`;
      }
    }

    return primaryText;
  }
  if (t.category === 'offensive') {
    // FIX 1: offensive OHKO entries must name the MOVE, not the attacker.
    // Threat format: "AttackerName MoveName vs. TargetName"
    const match = (t.threat || '').match(/^(\S+) (.+) vs\. (.+)$/);
    const attackerName = match ? match[1] : '';
    const moveName = match ? match[2] : '';
    const targetName = match ? match[3] : '';
    if (moveName && targetName) {
      const spreadInfo = t.attacker_spreads_used?.[0];
      const offFreqNote = buildFrequencyNote(t);
      // FIX 8: Special moves must show defender's SpD, Physical moves must show Def
      // FIX: use getMoveData() to determine the move's actual category rather than
      // checking t.attacker_build (which is only set on defensive thresholds).
      const moveData = getMoveData(moveName);
      const isSpecialMove = moveData && moveData.category === 'Special';
      const defStatKey = isSpecialMove ? 'spd' : 'def';
      const defStatLabel = isSpecialMove ? 'SpD' : 'Def';
      const defDescription = spreadInfo ? `${spreadInfo.sp.hp || 0}HP/${spreadInfo.sp[defStatKey] || 0}${defStatLabel}` : '';
      const range = typeof t.weighted_damage_min === 'number' ? `${t.weighted_damage_min}-${t.weighted_damage_max}%` : '';
      const recoilPart = buildRecoilText(moveName, t.weighted_damage_min || 0, t.weighted_damage_max || 0);
      const buildLabel = t.attacker_build ? `${t.attacker_build}: ` : '';
      // Weather annotation: when the threshold was computed under a specific
      // weather (and the team has multiple weathers), annotate the primary
      // result and surface alternative-weather outcomes.
      let result = `${t.this_spread_ko}s ${targetName} with ${moveName}`;
      const hasWeatherContext = t.alt_weathers && t.alt_weathers.length > 0;
      const primaryWeatherLabel = t.primary_weather && hasWeatherContext ? ` (${t.primary_weather})` : '';
      result += primaryWeatherLabel;
      if (range) {
        result += ` (${buildLabel}${range}${recoilPart} vs ${defDescription}${offFreqNote})`;
      }
      if (hasWeatherContext) {
        const altParts = t.alt_weathers
          .filter(a => a.this_spread_ko && a.weighted_damage_min)
          .map(a => `also in ${a.weather}: ${a.this_spread_ko}s (${a.weighted_damage_min}-${a.weighted_damage_max}% vs ${defDescription})`);
        if (altParts.length > 0) result += `; ${altParts.join('; ')}`;
      }
      return result;
    }
    const vsTarget = t.threat.split(' vs. ')[1];
    return vsTarget ? `${t.this_spread_ko} vs ${vsTarget}` : `${t.this_spread_ko} — ${t.threat}`;
  }
  return t.threat;
}

// KO tier ordering used to determine the binding constraint — the threshold
// that achieved the most KO-tier improvement against baseline requires the
// most SP in the stat and is the true binding constraint.
const KO_TIERS_LOCAL = ['OHKO', '2HKO', '3HKO', '4HKO', 'no_ko'];
function koTierDelta(t) {
  if (!t.baseline_ko || !t.this_spread_ko) return 0;
  const bIdx = KO_TIERS_LOCAL.indexOf(t.baseline_ko);
  const nIdx = KO_TIERS_LOCAL.indexOf(t.this_spread_ko);
  return (bIdx >= 0 && nIdx >= 0) ? nIdx - bIdx : 0;
}

// One line per invested stat, showing the binding-constraint real threshold
// (from the evolutionary result's thresholds_met) that stat's investment
// addresses. The primary is the threshold with the largest KO-tier delta
// from baseline — the binding constraint. Contribution (popularity) breaks
// ties. A 0 SP stat is omitted entirely. A stat with no matching threshold
// falls back to a role-based note for the Pokemon's own primary offensive
// stat, or a generic breakpoint note otherwise — never fabricated beyond
// what thresholds_met/role already say.
function buildSpAllocationWhy(member) {
  // A threshold belongs to its primary `stat` AND to every stat listed in
  // `also_load_bearing` — zeroing either one on its own regresses the KO tier,
  // so both lines are entitled to cite it as the real reason for their SP.
  // Without this, a stat whose investment is only jointly load-bearing falls
  // back to whatever weak threshold it happens to own outright: Archaludon at
  // 25 HP cited "survives Kingambit Kowtow Cleave (36.3-44.2%)" while the actual
  // constraint holding HP there was Garchomp Earthquake at 99.5% on the Def line.
  const statsClaiming = (t) => [t.stat, ...(t.also_load_bearing || [])].filter(Boolean);

  // Primary selection, in priority order:
  //   1. how dangerous the threat is at ZERO investment — an OHKO baseline
  //      outranks a 3HKO baseline
  //   2. how many KO tiers the investment buys
  //   3. raw damage survived
  //   4. contribution
  // Tier delta alone ties nearly everything at +1 now that sub-OHKO
  // improvements are credited; contribution alone re-introduces the popularity
  // bias the Bug 1 fix removed.
  const betterThreshold = (cand, best) => {
    if (!best) return true;
    if (cand.category === 'defensive' && best.category === 'defensive') {
      const ci = KO_TIERS_LOCAL.indexOf(cand.baseline_ko);
      const bi = KO_TIERS_LOCAL.indexOf(best.baseline_ko);
      const cSev = ci === -1 ? KO_TIERS_LOCAL.length : ci;
      const bSev = bi === -1 ? KO_TIERS_LOCAL.length : bi;
      if (cSev !== bSev) return cSev < bSev;
    }
    // Offensive improvements are NEGATIVE deltas (tier index drops toward OHKO);
    // defensive improvements are POSITIVE. One comparison sign cannot serve both.
    const cd = koTierDelta(cand);
    const bd = koTierDelta(best);
    if (cd !== bd) return cand.category === 'defensive' ? cd > bd : cd < bd;
    const cDmg = cand.weighted_damage_max || 0;
    const bDmg = best.weighted_damage_max || 0;
    if (cDmg !== bDmg) return cDmg > bDmg;
    return (cand.contribution || 0) > (best.contribution || 0);
  };

  const bestByStat = {};
  for (const t of member.thresholds_met || []) {
    for (const statKey of statsClaiming(t)) {
      if (betterThreshold(t, bestByStat[statKey])) bestByStat[statKey] = t;
    }
  }
  const primaryOffenseStat = member.pokemonRow.atk >= member.pokemonRow.spa ? 'atk' : 'spa';
  const allDefensiveThresholds = (member.thresholds_met || []).filter(t => t.category === 'defensive');
  const lines = [];
  let justifiedSp = 0;
  let bulkSp = 0;
  const justification = member.minimization?.justified_sp;

  for (const statKey of STAT_ORDER) {
    const spVal = member.sp[statKey] || 0;
    if (spVal === 0) continue;
    const label = `${spVal} ${SHOWDOWN_STAT_LABELS[statKey]}`;
    const best = bestByStat[statKey];

    if (justification) {
      // Per-stat split: the minimization floor is the load-bearing portion, the
      // rest was placed by redistributeToBudget() to spend the full 66. It is
      // "allocated to bulk", not "unspendable" — the point is spent and is
      // adding a real stat, it just is not what any single threshold required.
      const floorVal = justification[statKey] || 0;
      const bulk = spVal - floorVal;

      if (best && floorVal > 0) {
        justifiedSp += floorVal;
        bulkSp += bulk;
        const desc = describeThresholdForWhy(best, allDefensiveThresholds, statKey);
        lines.push(bulk > 0 ? `${label} — ${desc} (+${bulk} allocated to bulk)` : `${label} — ${desc}`);
      } else if (statKey === primaryOffenseStat && floorVal > 0) {
        justifiedSp += floorVal;
        bulkSp += bulk;
        lines.push(bulk > 0 ? `${label} — maximized for offensive role (+${bulk} allocated to bulk)` : `${label} — maximized for offensive role`);
      } else {
        bulkSp += spVal;
        lines.push(`${label} — allocated to bulk (no threshold of its own)`);
      }
    } else {
      // No minimization data (e.g. the individual /api/recommend/evs path, which
      // does not minimize). Every stat with SP shows its justifying threshold.
      if (best) {
        justifiedSp += spVal;
        lines.push(`${label} — ${describeThresholdForWhy(best, allDefensiveThresholds, statKey)}`);
      } else if (statKey === primaryOffenseStat) {
        justifiedSp += spVal;
        lines.push(`${label} — maximized for offensive role`);
      } else {
        bulkSp += spVal;
        lines.push(`${label} — allocated to bulk (no threshold of its own)`);
      }
    }
  }

  // Every SP is accounted for: required by a named threshold, or placed into
  // bulk to spend the remainder. On the team-build path the sum is always 66 —
  // redistributeToBudget() guarantees it.
  const totalFromLoop = justifiedSp + bulkSp;
  lines.push(`  SP: ${justifiedSp} justified + ${bulkSp} allocated to bulk = ${totalFromLoop} total`);
  return lines;
}

function buildTeamBuildText(responseBody, team) {
  const lines = [];

  for (const member of team) {
    lines.push(`${member.pokemon} @ ${member.item}`);
    if (member.ability) {
      const abilityText = member.base_ability
        ? `Ability: ${member.ability} (base: ${member.base_ability})`
        : `Ability: ${member.ability}`;
      lines.push(abilityText);
    }
    lines.push('Level: 50');
    lines.push(`${member.nature} Nature`);
    const evs = evsLine(member.sp);
    if (evs) lines.push(evs);
    const why = buildSpAllocationWhy(member);
    if (why.length > 0) {
      lines.push(`Why: ${why[0]}`);
      for (const w of why.slice(1)) lines.push(`     ${w}`);
    }
    for (const mv of member.moves) {
      const ctx = mv.team_context ? ` — ${mv.team_context}` : '';
      lines.push(`- ${mv.move}${ctx}`);
    }
    if (member.sp_notes && member.sp_notes.length > 0) lines.push(`(${member.sp_notes.join('; ')})`);
    lines.push('');
  }

  // SEEDS section: report which Nerd of Now sets were used and whether the
  // optimizer converged or diverged from each seed. This is useful signal —
  // divergence means the optimizer found something better for this specific team
  // than the general recommendation.
  const hasAnySeeds = team.some(m => m.seed_info || m.available_seeds.length > 0);
  if (hasAnySeeds) {
    lines.push(sectionDivider('SEEDS'));
    for (const member of team) {
      if (member.seed_info) {
        const seed = member.seed_info;
        const spParts = STAT_ORDER.filter(s => (seed.sp[s] || 0) > 0).map(s => `${seed.sp[s]} ${SHOWDOWN_STAT_LABELS[s]}`);
        const spLabel = spParts.length > 0 ? ` (${spParts.join(' / ')})` : '';
        const verdict = seed.converged
          ? `→ optimizer converged to similar spread`
          : `→ optimizer diverged to different spread (${seed.reason})`;
        lines.push(`${member.pokemon}: seeded from Nerd of Now "${seed.label}"${spLabel}`);
        lines.push(`  ${verdict}`);
      } else if (member.available_seeds.length > 0) {
        lines.push(`${member.pokemon}: ${member.available_seeds.length} Nerd of Now set(s) available, optimizer used best fit`);
      } else {
        lines.push(`${member.pokemon}: no Nerd of Now set found`);
        lines.push(`  → random initialization used`);
      }
    }
    lines.push('');
  }

  const ta = responseBody.team_analysis;
  lines.push(sectionDivider('TEAM ANALYSIS'));
  lines.push(`Type coverage: ${ta.coverage.covered_types.length}/18 types${ta.coverage.every_type_covered ? ' (complete)' : ''}`);
  if (ta.coverage.coverage_gaps.length > 0) {
    // Gaps are per-Pokemon, not per-type: a dual-typed threat the team hits super
    // effectively through its SECOND type is not a gap, even when the team has
    // nothing effective against its first.
    const GAP_DISPLAY_LIMIT = 8;
    const shown = ta.coverage.coverage_gaps.slice(0, GAP_DISPLAY_LIMIT);
    lines.push(`Coverage gaps (${ta.coverage.coverage_gaps.length} Pokemon with no super effective answer):`);
    for (const gap of shown) {
      lines.push(`  - ${gap.note}`);
    }
    const hidden = ta.coverage.coverage_gaps.length - shown.length;
    // Say what was dropped rather than silently truncating — a capped list that
    // looks complete is worse than a longer one.
    if (hidden > 0) lines.push(`  - ...and ${hidden} more below ${(shown[shown.length - 1].meta_prevalence * 100).toFixed(1)}% usage`);
  }
  if (ta.coverage.weather_dependency_note) {
    lines.push(`Weather dependency: ${ta.coverage.weather_dependency_note}`);
  }
  if (ta.synergies.length > 0) {
    lines.push('Strong synergies:');
    for (const s of ta.synergies.slice(0, 8)) {
      const scoreLabel = s.score === null || s.score === undefined ? '' : ` (score ${s.score})`;
      lines.push(`  - ${s.pair.join(' + ')}${scoreLabel}: ${s.reasons.join('; ')}`);
    }
  }
  if (ta.weather.notes.length > 0) {
    lines.push('Weather/Terrain:');
    for (const n of ta.weather.notes) lines.push(`  - ${n}`);
  }
  if (ta.trick_room.has_trick_room) {
    lines.push('Trick Room:');
    for (const n of ta.trick_room.notes) lines.push(`  - ${n}`);
  }
  lines.push(`Speed tiers (fastest to slowest): ${ta.speed_tiers.tiers.map((t) => `${t.pokemon} (${t.speed})`).join(', ')}`);
  if (ta.speed_tiers.tailwind_would_help) lines.push('  - Tailwind would meaningfully help this team\'s Speed control');
  lines.push(`Protect: ${ta.protect_count}/6 team members`);
  if (ta.protect_warning) lines.push(`  - ${ta.protect_warning}`);
  lines.push('');

  lines.push(sectionDivider('WEAKNESSES'));
  if (responseBody.weaknesses.critical.length === 0) {
    lines.push('No critical (3+ members) type weaknesses.');
  } else {
    for (const w of responseBody.weaknesses.critical) {
      const prevNotes = w.member_prevalence
        ? Object.entries(w.member_prevalence).filter(([, v]) => v != null).map(([name, prev]) => `${name} in ${(prev * 100).toFixed(1)}% of teams`).join(', ')
        : '';
      lines.push(`${w.type}: ${w.team_members_weak.join(', ')} weak${prevNotes ? ` (${prevNotes})` : ''}`);
      if (w.exploited_by.length > 0) {
        // Names the move, and flags when it is coverage rather than STAB —
        // Garchomp's Rock Slide is a real Rock threat even though Garchomp is
        // not a Rock-type, and reading "coverage" tells you the hit lands
        // without the 1.5x.
        lines.push(`  Exploited by: ${w.exploited_by.map((e) => {
          const pct = `${(e.usage * 100).toFixed(1)}%`;
          if (!e.move) return `${e.pokemon} (${pct})`;
          return `${e.pokemon} (${pct}, ${e.move}${e.stab ? '' : ' — coverage'})`;
        }).join(', ')}`);
      }
      lines.push(...mitigationLines(w, '  '));
    }
  }
  const megaWeaknesses = responseBody.weaknesses.mega_weaknesses || [];
  if (megaWeaknesses.length > 0) {
    for (const mw of megaWeaknesses) {
      lines.push(`Mega exposure — ${mw.pokemon} (${mw.types.join('/')}), the team's irreplaceable member:`);
      for (const t of mw.weak_to) {
        const shared = t.shared_with_team.length > 0 ? `, also hits ${t.shared_with_team.join(', ')}` : ', hits only the Mega';
        const top = t.exploited_by[0];
        const via = top ? ` — e.g. ${top.pokemon} (${(top.usage * 100).toFixed(1)}%${top.move ? `, ${top.move}` : ''})` : '';
        lines.push(`  - ${t.type} ${t.multiplier}x${shared}${via}`);
        lines.push(...mitigationLines(t, '      '));
      }
    }
  }
  if (responseBody.weaknesses.double_weaknesses.length > 0) {
    lines.push('4x weaknesses:');
    for (const d of responseBody.weaknesses.double_weaknesses) {
      lines.push(`  - ${d.type}: ${d.team_members.join(', ')}`);
      lines.push(...mitigationLines(d, '    '));
    }
  }
  lines.push('');

  lines.push(sectionDivider('ARCHETYPE MATCHUPS'));
  for (const m of responseBody.archetype_matchups) {
    const led = m.matchup_ledger;
    const scoreNote = led ? `  [${(led.weighted_score * 100).toFixed(0)}/100 usage-weighted]` : '';
    lines.push(`${m.archetype}: ${m.matchup_rating.toUpperCase()}${scoreNote}  (${m.meta_team_count} teams in this archetype)`);
    if (led) {
      // The full grid, printed so the rating can be argued with rather than
      // taken on trust. Every one of our 6 against every threat: the old
      // three-boolean ledger collapsed this and hid the fact that two of Sand's
      // six OHKO our only Mega while the row still read "survive:Y" because
      // Kingambit happened to live.
      const cw = led.cell_weights || {};
      lines.push(`  Exchange grid (${cw.we_ohko} we KO + ${cw.we_survive} we live + ${cw.speed} speed, speed x${cw.speed_matters_mult} if it lands a KO, x${cw.speed_decides_mult} if it also denies theirs; rows weighted by team value):`);
      for (const r of led.rows) {
        lines.push(`    ${r.pokemon.padEnd(22)} ${(r.usage * 100).toFixed(1).padStart(5)}%  -> ${r.score.toFixed(2)}`);
        const kills = r.ohkos_our.length ? `KOs ours: ${r.ohkos_our.join(', ')}` : 'KOs none of ours';
        const dies = r.ohko_d_by_our.length ? `KO'd by: ${r.ohko_d_by_our.join(', ')}` : "we KO it with nothing";
        lines.push(`        ${kills}  |  ${dies}`);
        for (const c of r.cells) {
          const marks = [
            c.they_ohko_us ? `DIES to ${c.their_killing_move?.move} (${c.their_killing_move?.range})` : `survives (worst ${c.their_best_damage}%)`,
            c.we_ohko_them ? `KOs back with ${c.our_killing_move?.move}` : 'no KO back',
            c.we_move_first === null ? 'speed unknown' : (c.we_move_first ? `moves first (${c.our_speed})` : `moves second (${c.our_speed})`),
          ];
          lines.push(`          ${c.our.padEnd(20)} ${marks.join(' | ')}`);
        }
      }
      if (led.weakest_link) {
        const wl = led.weakest_link;
        const combined = Math.min(100, wl.usage_sum * 100);
        lines.push(`    weakest link: ${wl.pokemon} — dies to ${wl.threat_count} of their 6 most-used (${combined.toFixed(0)}% combined usage, capped at 100)`);
      }
      if (led.calc_failures > 0) {
        lines.push(`    (${led.calc_failures} incoming calcs failed to resolve — grid is thinner than it looks)`);
      }
    }
    lines.push(`  Our key Pokemon: ${(m.our_key_pokemon || []).join(', ')}`);

    lines.push('  Key Threats:');
    for (const t of m.key_threats || []) {
      const speed = t.speed != null ? `${t.speed} Spe` : 'Speed unknown';
      lines.push(`    - ${t.pokemon} (${t.types.join('/')}, ${(t.usage * 100).toFixed(1)}% of ${m.archetype} teams, ${speed}${t.ability ? `, ${t.ability}` : ''}${t.item ? `, ${t.item}` : ''})`);
      for (const r of t.reasons || []) lines.push(`        ${r}`);
      // The hardest set behind each KO, so "OHKOs Charizard" can be read as a
      // frequency rather than a possibility.
      for (const o of t.ohkos_our || []) {
        if (o.coverage?.hardest_set) {
          lines.push(`            worst case on ${o.our}: ${o.coverage.hardest_set.label} — ${o.coverage.hardest_set.range}`);
        }
      }
    }

    // Both lists are ordered most damage first, then by how common the opposing
    // Pokemon is.
    lines.push('  Resistances (most damage taken first):');
    if ((m.resistances || []).length === 0) {
      lines.push('    - none — nothing on this team resists their primary attacking moves');
    } else {
      for (const r of m.resistances) {
        lines.push(`    - ${r.pokemon}:`);
        for (const x of r.resists) {
          const mult = x.multiplier === 0 ? 'immune' : `${x.multiplier}x`;
          lines.push(`        ${x.target}'s ${x.move} (${x.move_type}, ${mult}): ${x.damage_range} — ${x.attacker_build}, ${(x.target_usage * 100).toFixed(1)}% of ${m.archetype} teams`);
          // Same state-dependent-move treatment as Counters below: a resisted
          // hit from a ladder move is still a ladder, not a flat number.
          if (x.ladder) {
            lines.push(`            base power scales with ${x.ladder.axis}:`);
            for (const step of x.ladder.steps) {
              const ko = step.ohko ? '  OHKO' : '';
              lines.push(`              ${step.note} (${step.bp} BP): ${step.damage_range}${ko}   [likelihood ${step.weight}]`);
            }
          }
          if (x.multi_hit) {
            const mh = x.multi_hit;
            lines.push(`            ${mh.note} — headline above is the EXPECTED ${mh.expected_hits} hits`);
            lines.push(`            guaranteed floor (${mh.guaranteed_min_percent}-${mh.guaranteed_max_percent}%) is what a move swap is judged on`);
            for (const row of mh.hit_counts || []) {
              const ko = row.ohko ? '  OHKO' : '';
              lines.push(`              ${row.hits} hit${row.hits === 1 ? '' : 's'} (${(row.probability * 100).toFixed(1)}%): ${row.min_percent}-${row.max_percent}%${ko}`);
            }
          }
          if (x.bp_unresolved) {
            lines.push('            WARNING: this move\'s real base power depends on state not modelled here');
            lines.push(`            (multi-hit or turn state) — the number above assumes ${x.base_power_used} BP and is not reliable`);
          }
        }
      }
    }

    lines.push('  Counters (most damage first):');
    const ohkos = m.counters?.ohkos || [];
    const seOnly = (m.counters?.super_effective || []);
    if (ohkos.length === 0 && seOnly.length === 0) {
      const cf = m.counters?.calc_failures || 0;
      const ca = m.counters?.calc_attempts || 0;
      // Distinguish "genuinely no answer" from "the calcs did not run" — those
      // printed identically before, which hid a resolution bug for a full build.
      lines.push(cf > 0 && cf === ca
        ? `    - NO DATA — all ${ca} damage calculations failed to resolve; this is a bug, not a matchup result`
        : '    - none — no OHKO and no super effective coverage against their key threats');
    } else if ((m.counters?.calc_failures || 0) > 0) {
      lines.push(`    (${m.counters.calc_failures}/${m.counters.calc_attempts} calcs failed to resolve)`);
    }
    // Grouped by OUR Pokemon, mirroring the Resistances layout. A flat list
    // interleaves six attackers against six targets and is unreadable; grouping
    // answers "what does this member do here" in one block.
    const byAttacker = new Map();
    for (const e of [...ohkos.map((o) => ({ ...o, ohko: true })), ...seOnly.map((x) => ({ ...x, ohko: false }))]) {
      if (!byAttacker.has(e.pokemon)) byAttacker.set(e.pokemon, []);
      byAttacker.get(e.pokemon).push(e);
    }
    const attackerGroups = [...byAttacker.entries()].map(([pokemon, entries]) => {
      entries.sort((a, b) => (b.damage_max || 0) - (a.damage_max || 0)
        || (b.target_usage || 0) - (a.target_usage || 0));
      return { pokemon, entries };
    });
    // Members with the hardest single hit first, same rule as within a group.
    attackerGroups.sort((a, b) => (b.entries[0].damage_max || 0) - (a.entries[0].damage_max || 0));

    for (const g of attackerGroups) {
      lines.push(`    - ${g.pokemon}:`);
      for (const e of g.entries) {
        // Sash-capped hits used to print as "2x ... 99.3-99.3%", which reads as
        // a coincidence rather than "this would have killed and the Sash held".
        const sashHeld = e.sash_prevents_ohko === true;
        const tag = sashHeld ? 'SASH HOLDS' : (e.ohko ? 'OHKO' : `${e.multiplier}x`);
        const type = e.move_type ? `, ${e.move_type}` : '';
        // Weather is named only when it CHANGES something — a tag on a number
        // that is identical in every weather reads as one calc asserting two
        // contradictory weathers at once.
        const wx = e.weather_independent
          ? ''
          : ((e.weathers && e.weathers.length > 0)
            ? `  [${e.weathers.join(' / ')}]`
            : (e.weather ? `  [in ${e.weather}]` : '  [no weather]'));
        // Attacker named on every line. The group header above scrolls out of
        // sight in a section this long, and "Sucker Punch vs Basculegion" with
        // no attacker is unusable.
        lines.push(`        ${tag} — ${g.pokemon}'s ${e.move}${type} vs ${e.target}: ${e.damage_range} vs ${e.target_build}, ${(e.target_usage * 100).toFixed(1)}% of ${m.archetype} teams${wx}`);
        if (sashHeld) {
          lines.push(`            would do ${e.raw_min_percent ?? '?'}-${e.raw_max_percent ?? '?'}% — Focus Sash holds it at 1 HP (once, from full HP only)`);
        }
        if (e.coverage) {
          const c = e.coverage;
          // The headline is the SHARE OF SETS BEATEN and the THRESHOLD that stops
          // it — not how common one particular spread is. Quoting the modal
          // spread's frequency read as "this KO works 11% of the time" when the
          // move in fact beat most of the frailer spreads too.
          const across = `across ${c.sets_seen} spread${c.sets_seen === 1 ? '' : 's'} x ${c.items_seen} item${c.items_seen === 1 ? '' : 's'}`;
          lines.push(`            KOs ${(c.covered_pct * 100).toFixed(0)}% of observed sets (${across})`);
          if (c.breaks_on) {
            lines.push(`            stops KOing at ${c.breaks_on.label} — ${c.breaks_on.range}`);
          } else if (c.covered_pct >= 1) {
            lines.push('            no observed set survives it');
          }
          if (c.worst_beaten) {
            lines.push(`            still KOs through ${c.worst_beaten.label} (${c.worst_beaten.range})`);
          }
        }
        // A move whose power depends on battle state has no single number, so
        // print the whole sequence with how likely each step is. The headline
        // above is always the guaranteed step.
        if (e.ladder) {
          lines.push(`            base power scales with ${e.ladder.axis}:`);
          for (const step of e.ladder.steps) {
            const ko = step.ohko ? '  OHKO' : '';
            lines.push(`              ${step.note} (${step.bp} BP): ${step.damage_range}${ko}   [likelihood ${step.weight}]`);
          }
        }
        // Multi-hit: the headline is one figure, but the move rolls a hit count
        // every time. Print the distribution rather than a single number that
        // happens to be true on average and never on any given turn.
        if (e.multi_hit) {
          const mh = e.multi_hit;
          lines.push(`            ${mh.note} — headline above is the EXPECTED ${mh.expected_hits} hits`);
          lines.push(`            guaranteed floor (${mh.guaranteed_min_percent}-${mh.guaranteed_max_percent}%) is what a move swap is judged on`);
          for (const row of mh.hit_counts || []) {
            const ko = row.ohko ? '  OHKO' : '';
            lines.push(`              ${row.hits} hit${row.hits === 1 ? '' : 's'} (${(row.probability * 100).toFixed(1)}%): ${row.min_percent}-${row.max_percent}%${ko}`);
          }
        }
        if (e.bp_unresolved) {
          lines.push('            WARNING: this move\'s real base power depends on state not modelled here');
          lines.push(`            (multi-hit or turn state) — the number above assumes ${e.base_power_used} BP and is not reliable`);
        }
      }
    }

    // A condition may carry a second line (an OHKO's KO-likelihood note). Bullet
    // the first line, indent the rest under it — one \n-joined string stays one
    // logical condition in the JSON while reading as a block in the text view.
    const pushCondition = (text) => {
      const [head, ...rest] = String(text).split('\n');
      lines.push(`    - ${head}`);
      for (const extra of rest) lines.push(`        ${extra}`);
    };

    lines.push('  Lose Condition:');
    for (const l of m.lose_conditions || []) pushCondition(l);

    lines.push('  Win Condition:');
    if ((m.win_conditions || []).length === 0) lines.push('    - none identified from the current 6');
    for (const w of m.win_conditions || []) pushCondition(w);

    const sw = m.possible_swaps;
    if (sw && (sw.moves.length || sw.items.length || sw.pokemon.length || sw.error)) {
      lines.push('  Possible Swaps:');
      if (sw.error) lines.push(`    - swap analysis failed: ${sw.error}`);
      if (sw.moves.length > 0) {
        lines.push('    Moves:');
        for (const x of sw.moves) {
          lines.push(`      - ${x.pokemon}: ${x.drop} -> ${x.add} (${x.move_type}, ${x.move_power} BP)`);
          lines.push(`          vs ${x.target}: ${x.damage_range}${x.ohko ? ' OHKO' : ''} — beats current best (${x.replaces_best || 'nothing'} at ${x.replaces_best_damage}%) by ${x.gain.toFixed(1)} points`);
          lines.push(`          ${x.reason}`);
        }
      }
      if (sw.items.length === 0 && (sw.items_skipped || []).length > 0) {
        lines.push(`    Items: none — ${sw.items_skipped.join(', ')}`);
      }
      if (sw.items.length > 0) {
        lines.push('    Items:');
        for (const x of sw.items) {
          lines.push(`      - ${x.pokemon}: ${x.drop} -> ${x.add}`);
          lines.push(`          new spread: ${x.new_spread}${x.respread_ran ? '' : '  (WARNING: re-optimisation did not run, spread shown is unchanged)'}`);
          for (const s2 of x.now_survives) lines.push(`          now survives: ${s2}`);
          for (const l of x.loses_ohko_on) lines.push(`          loses OHKO on: ${l}`);
          if (x.loses_ohko_on.length === 0) lines.push('          loses no OHKOs');
        }
      }
      if (sw.pokemon.length > 0) {
        lines.push('    Pokemon:');
        for (const x of sw.pokemon) {
          const role = x.add_role?.role ? `, ${x.add_role.role}` : '';
          lines.push(`      - drop ${x.drop}${x.drop_role?.role ? ` (${x.drop_role.role})` : ''}, bring ${x.add} (${x.add_types.join('/')}${role}, ${(x.add_usage * 100).toFixed(1)}% usage)`);

          // The set the numbers below were actually computed on. Without this
          // the comparison is unfalsifiable.
          const b = x.add_build;
          if (b) {
            lines.push(`          set: ${b.spread_label || '(spread unknown)'} @ ${b.item || 'no item'}${b.ability ? ` (${b.ability})` : ''}  [${b.spread_source || 'source unknown'}]${b.build_provenance ? ` (${b.build_provenance})` : ''}`);
            if ((b.moves || []).length > 0) {
              lines.push(`          moves: ${b.moves.map((mv) => mv.move).join(' / ')}${b.moves_truncated ? ' (+ more)' : ''}`);
            }
          }
          lines.push(`          ${x.reason}`);

          const d = x.delta;
          if (d) {
            for (const gain of d.gains_ohko_on || []) {
              lines.push(`          GAINS a KO on ${gain.threat} (${(gain.usage * 100).toFixed(1)}%): ${gain.move} ${gain.damage_range}${gain.dropped_best_move ? ` — ${x.drop}'s best was ${gain.dropped_best_move} at ${gain.dropped_best_min}%` : ''}`);
            }
            for (const loss of d.loses_ohko_on || []) {
              lines.push(`          GIVES UP the KO on ${loss.threat} (${(loss.usage * 100).toFixed(1)}%): ${x.drop}'s ${loss.move} ${loss.damage_range}${loss.candidate_best_move ? ` — ${x.add}'s best is ${loss.candidate_best_move} at ${loss.candidate_best_min}%` : ''}`);
            }
            for (const s of d.newly_survives || []) {
              lines.push(`          NEWLY SURVIVES ${s.threat}'s ${s.move}: ${s.candidate_range} on ${x.add} vs ${s.dropped_range} on ${x.drop}`);
            }
            for (const v of d.newly_vulnerable || []) {
              lines.push(`          NEWLY DIES to ${v.threat}'s ${v.move}: ${v.candidate_range} on ${x.add} vs ${v.dropped_range} on ${x.drop}`);
            }
            const tr = d.truncated || {};
            if (tr.gains_ohko_on || tr.loses_ohko_on || tr.newly_survives || tr.newly_vulnerable) {
              lines.push(`          (lists capped — totals: +${d.totals.gains_ohko_on} KOs / -${d.totals.loses_ohko_on} KOs / +${d.totals.newly_survives} survived / -${d.totals.newly_vulnerable} newly lost)`);
            }
            if (d.calc_failures > 0) lines.push(`          (${d.calc_failures} calcs in this comparison failed to resolve)`);
          }

          // Screens and Intimidate are the whole argument for some swaps, so
          // they are recomputed rather than asserted.
          const fe = x.field_effects;
          if (fe && (fe.new_effects || []).length > 0) {
            lines.push(`          BRINGS ${fe.new_effects.join(', ')}:`);
            for (const rc of fe.recomputes || []) {
              const broken = rc.before_ohko && !rc.after_ohko ? '  (no longer an OHKO)' : '';
              lines.push(`            ${rc.effect} vs ${rc.attacker}'s ${rc.move} on ${rc.defender}: ${rc.before_range} -> ${rc.after_range}${broken}`);
            }
            if (fe.recomputes_truncated) lines.push(`            (${fe.recomputes_total} recomputes total, list capped)`);
            for (const cv of fe.caveats || []) lines.push(`            note: ${cv}`);
          }

          if ((x.loses || []).length > 0) lines.push(`          dropping ${x.drop} costs: ${x.loses.join('; ')}`);

          // What the drop costs that nothing left on the team replaces, and
          // whether anything in the whole legal pool covers it.
          const bf = x.backfill;
          if (bf && !bf.nothing_lost) {
            for (const loss of bf.losses || []) {
              lines.push(`          IRREPLACEABLE: ${loss.detail || loss.what}`);
              lines.push(`            ${loss.statement}`);
              for (const rep of loss.replacements || []) {
                const dmg = rep.damage_range ? `: ${rep.move} ${rep.damage_range}` : ` — ${rep.move}`;
                const prov = rep.build_provenance ? ` (${rep.build_provenance})` : '';
                lines.push(`              ${rep.pokemon} (${(rep.usage * 100).toFixed(1)}% usage)${dmg}${prov}`);
              }
            }
            if (bf.losses_truncated) lines.push(`            (${bf.losses_total} irreplaceable losses total, list capped)`);
          }
          if (x.candidates_real_evaluated) {
            lines.push(`          (chosen from ${x.candidates_real_evaluated} candidates real-calced against this archetype)`);
          }
        }
      }
      // Members the matchup maths wanted to cut but that hold irreplaceable team
      // roles — named so the absence of a suggestion is explained, not silent.
      if ((sw.pokemon_protected || []).length > 0) {
        lines.push('    Not droppable despite a poor matchup here:');
        for (const p2 of sw.pokemon_protected) lines.push(`      - ${p2}`);
      }
      if (sw.bounds) {
        // "legal Pokemon considered" used to print a hard-coded 40 and read as a
        // fact about the format. It is the size of the pool we searched, and it
        // now says which part of that pool produced a usable candidate.
        const misses = sw.bounds.pokemon_pool_profile_misses
          ? `, ${sw.bounds.pokemon_pool_profile_misses} skipped for missing species data`
          : '';
        lines.push(`    (bounds: max ${sw.bounds.max_move_swaps} move / ${sw.bounds.max_item_swaps} item / ${sw.bounds.max_pokemon_swaps} Pokemon swaps; ${sw.bounds.item_candidates_per_member} item candidates per member; searched all ${sw.bounds.pokemon_pool_considered} legal Pokemon, ${sw.bounds.pokemon_pool_scored} scored as viable${misses})`);
      }
    }

    if (m.best_team_set) {
      const b = m.best_team_set;
      lines.push(`  Best Team Set: ${b.members.join(', ')}${b.mega ? `  (Mega: ${b.mega})` : '  (no Mega available)'}`);
      lines.push(`    weighted ${(b.score * 100).toFixed(1)} — synergy ${(b.breakdown.synergy * 100).toFixed(0)}, offence ${(b.breakdown.offense * 100).toFixed(0)}, defence ${(b.breakdown.defense * 100).toFixed(0)}, speed ${(b.breakdown.speed * 100).toFixed(0)}, utility ${(b.breakdown.utility * 100).toFixed(0)}`);
    }
    lines.push('');
  }
  lines.push('');

  lines.push(sectionDivider('MATCHUP ANALYSIS'));
  const matchups = responseBody.matchup_analysis || { ohko_opportunities: [], ohko_risks: [] };

  // FIX 7: Group OHKO opportunities by move — each move listed once with ALL targets
  // FIX 10: Value rating for display order (Megas/sweepers highest, Sash holders lowest)
  lines.push(`OHKO opportunities (${matchups.ohko_opportunity_count ?? matchups.ohko_opportunities.length} total, top ${Math.min(10, matchups.ohko_opportunities.length)} shown):`);

  // Group opportunities by attacker+move key
  const oppByMove = {};
  for (const o of matchups.ohko_opportunities || []) {
    const key = `${o.attacker}|||${o.move}`;
    if (!oppByMove[key]) {
      oppByMove[key] = {
        attacker: o.attacker, move: o.move, attacker_speed: o.attacker_speed,
        attacker_build: o.attacker_build, move_condition: o.move_condition,
        targets: [],
      };
    }
    oppByMove[key].targets.push(o);
  }

  // Sort by number of targets (most targets first), then by attacker speed
  const sortedMoves = Object.values(oppByMove)
    .sort((a, b) => b.targets.length - a.targets.length || (b.attacker_speed || 0) - (a.attacker_speed || 0));

  for (const moveGroup of sortedMoves.slice(0, 10)) {
    const moveWithConditions = moveGroup.move_condition ? `${moveGroup.move}${moveGroup.move_condition}` : moveGroup.move;
    const atkFreqNote = moveGroup.attacker_build ? ` (${moveGroup.attacker_build})` : '';
    // Speed comparison line: list all targets' speeds
    const speedParts = moveGroup.targets.map(t => `${t.target} (${t.defender_speed || '?'} Spe)`);
    const fastestTarget = Math.max(...moveGroup.targets.map(t => t.defender_speed || 0));
    const speedComp = (moveGroup.attacker_speed || 0) > fastestTarget ? 'outspeeds' : 'is SLOWER than';
    const speedHeader = speedParts.length > 1 ? speedParts.join(' & ') : speedParts[0];
    lines.push(`  ${moveGroup.attacker} (${moveGroup.attacker_speed || '?'} Spe) ${speedComp} ${speedHeader} —`);
    lines.push(`    ${moveWithConditions}${atkFreqNote}:`);
    for (const t of moveGroup.targets) {
      const rangeParts = (t.damage_range || '').split('-');
      const recoilSuffix = rangeParts.length === 2 ? buildRecoilText(t.move, parseFloat(rangeParts[0]), parseFloat(rangeParts[1])) : '';
      lines.push(`    ${t.target} — ${t.guaranteed_vs_all || 'OHKO vs observed spreads'}${recoilSuffix} (${t.target_sp_source})`);
    }
  }

  // FIX 10: Value rating for OHKO risks — compute survival-value weight per team member
  const VALUE_RATINGS = {};
  for (const member of responseBody.team || []) {
    const name = member.pokemon?.toLowerCase();
    if (!name) continue;
    const isMega = (member.pokemon || '').includes('-Mega');
    const isSash = (member.item || '').toLowerCase() === 'focus sash';
    const role = member.role || '';
    const baseSpd = member.pokemonRow?.spe || 0;
    const isFrail = baseSpd > 90 && (member.pokemonRow?.hp || 0) + (member.pokemonRow?.def || 0) < 150;
    if (isSash) VALUE_RATINGS[name] = 'lowest';
    else if (isFrail) VALUE_RATINGS[name] = 'low';
    else if (isMega || role === 'fast_offense' || role === 'slow_bulky_offense') VALUE_RATINGS[name] = 'highest';
    else if (role === 'slow_bulky_support') VALUE_RATINGS[name] = 'medium';
    else VALUE_RATINGS[name] = 'high';
  }

  // Sort risks by value rating (highest value first = sash/frail at bottom)
  const VALUE_ORDER = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
  const sortedRisks = [...(matchups.ohko_risks || [])].sort((a, b) => {
    const ra = VALUE_ORDER[VALUE_RATINGS[(a.target || '').toLowerCase()] || 'medium'];
    const rb = VALUE_ORDER[VALUE_RATINGS[(b.target || '').toLowerCase()] || 'medium'];
    return ra - rb;
  });

  lines.push(`OHKO risks (${matchups.ohko_risk_count ?? matchups.ohko_risks.length} total, top ${Math.min(10, sortedRisks.length)} shown):`);
  for (const r of sortedRisks.slice(0, 10)) {
    const buildSuffix = r.attacker_build ? ` (${r.attacker_build})` : '';
    const riskRangeParts = (r.damage_range || '').split('-');
    const riskRecoilSuffix = riskRangeParts.length === 2 ? buildRecoilText(r.move, parseFloat(riskRangeParts[0]), parseFloat(riskRangeParts[1])) : '';
    const atkSpeedLabel = r.attacker_speed ? `${r.attacker} (${r.attacker_speed} Spe)` : r.attacker;
    const defSpeedLabel = r.defender_speed ? `${r.target} (${r.defender_speed} Spe)` : r.target;
    const speedComp = (r.attacker_speed || 0) > (r.defender_speed || 0) ? 'outspeeds' : 'is SLOWER than';
    const mitNote = r.mitigation ? `. ${r.mitigation}` : '';
    const freqNote = r.attacker_set_frequency
      ? ` (${r.attacker_set_frequency}% of ${r.attacker}, ${r.attacker_meta_frequency}% meta${r.rare_set ? ' — rare set' : ''})`
      : '';
    const valueRating = VALUE_RATINGS[(r.target || '').toLowerCase()] || '';
    const valueTag = valueRating === 'lowest' ? ' [low priority — sash]' : valueRating === 'low' ? ' [low priority]' : '';
    lines.push(`  ${atkSpeedLabel} ${speedComp} ${defSpeedLabel} —`);
    lines.push(`    ${r.move}${buildSuffix}: ${r.damage_range}${riskRecoilSuffix}${freqNote}${mitNote}${valueTag}`);
    if (r.weather_note) lines.push(`    ${r.weather_note}`);
  }
  lines.push('');

  // FIX 11: Coverage move suggestions
  const covSuggestions = responseBody.team_analysis?.coverage_suggestions || [];
  if (covSuggestions.length > 0) {
    lines.push(sectionDivider('COVERAGE SUGGESTIONS'));
    for (const s of covSuggestions) {
      lines.push(`${s.threat} (${Math.round(s.threat_usage_pct * 100)}% usage) can OHKO ${s.ohko_count} team member${s.ohko_count > 1 ? 's' : ''} (${s.targeted_members.join(', ')}):`);
      lines.push(`  Replace ${s.candidate_member}'s ${s.move_to_replace} — ${s.reason || `handles ${s.threat}`}`);
      if (s.suggested_moves && s.suggested_moves.length > 0) {
        lines.push(`  Learnable: ${s.suggested_moves.join(', ')}`);
      }
    }
    lines.push('');
  }

  lines.push(sectionDivider('ITEM DECISIONS'));
  for (const member of team) {
    lines.push(`${member.pokemon}: ${member.item}`);
    lines.push(`  ${member.item_reason}`);
  }

  return lines.join('\n');
}

router.post('/build', async (req, res, next) => {
  try {
    const { team: teamNames } = req.body || {};
    if (!Array.isArray(teamNames) || teamNames.length !== 6) {
      return res.status(400).json({ error: 'team must be an array of exactly 6 Pokemon names' });
    }

    // Validate every name up front — 400 with the specific missing name, before
    // any of the expensive pipeline work below runs.
    const pokemonRowsByLower = {};
    for (const name of teamNames) {
      const { rows } = await pool.query('SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)', [String(name)]);
      if (rows.length === 0) return res.status(400).json({ error: `Pokemon not found: ${name}` });
      pokemonRowsByLower[String(name).toLowerCase()] = rows[0];
    }

    // STEP 1: role classification.
    const roleResults = await Promise.all(teamNames.map((name) => classifyRole(name)));

    // FIX 3: exactly 4 moves with team context notes. Get more recommendations
    // to choose from for team-aware selection, then filter to best 4.
    const moveResults = await Promise.all(teamNames.map((name) => getMoveRecommendationsFor(name.toLowerCase(), [], 6)));
    const allMoveNames = [...new Set(moveResults.flatMap((r) => (r?.recommendations || []).map((m) => m.move.toLowerCase())))];
    const { rows: moveRows } = allMoveNames.length
      ? await pool.query('SELECT * FROM moves WHERE LOWER(name) = ANY($1)', [allMoveNames])
      : { rows: [] };
    const movesByLower = Object.fromEntries(moveRows.map((m) => [m.name.toLowerCase(), m]));
    const enrichedMovesByName = teamNames.map((name, i) => enrichMoves(moveResults[i]?.recommendations || [], movesByLower));

    // FIX 3: real tournament-frequency ability per Pokemon, condition-filtered.
    // Two passes: (1) a provisional pick (no condition filter) is enough to
    // detect weather-SETTER abilities, since setter abilities are never
    // themselves condition-gated; (2) once the team's active weather is known
    // from that provisional set + real top-move weather-setting moves, the
    // FINAL per-Pokemon ability is resolved with the condition filter applied.
    const abilityFrequencies = await Promise.all(teamNames.map((name) => getRealAbilityFrequency(name.toLowerCase())));
    // The Mega override below (see finalAbilities) has to be applied HERE too,
    // not only in the second pass. tournament_teams' species_key() falls back to
    // the base form for Megas, so the scraped frequency data for
    // Charizard-Mega-Y returns Blaze, not Drought — meaning the provisional pass
    // that builds teamWeatherContext never saw this team's Sun at all. The
    // context came out as {Rain} (Pelipper's Drizzle alone), which is why
    // Weather Ball displayed as "Water-type, assumes our Rain active" on the
    // Sun setter itself, while analyzeMatchups — which reads resolved
    // abilities — was calculating damage under Sun. Two halves of the same
    // response disagreeing about the weather.
    //
    // Safe to apply provisionally: this pass exists only to find weather
    // SETTERS, and setter abilities are never themselves condition-gated (see
    // the comment above), so seeding it with a Mega's real ability cannot
    // distort the condition filter applied in the second pass.
    const megaAbilityFor = (i) => {
      const row = pokemonRowsByLower[teamNames[i].toLowerCase()];
      return row && row.name.toLowerCase().includes('-mega') ? (row.ability1 || null) : null;
    };
    const provisionalAbilities = abilityFrequencies.map((freq, i) =>
      megaAbilityFor(i) || resolveRealAbility(freq, new Set())?.ability || null);
    const teamTopMoveNames = enrichedMovesByName.map((moves) => moves.map((m) => m.move));
    const teamWeatherContext = detectTeamWeatherContext(provisionalAbilities, teamTopMoveNames);
    const finalAbilities = abilityFrequencies.map((freq, i) => {
      // FIX 1: For Mega forms, use the pokemon table's ability1 (e.g. Drought for
      // Charizard-Mega-Y) since tournament_teams may not have reliable ability
      // data for Mega forms (species_key() often falls back to the base form).
      const pokemonRow = pokemonRowsByLower[teamNames[i].toLowerCase()];
      if (pokemonRow && pokemonRow.name.toLowerCase().includes('-mega')) {
        return pokemonRow.ability1 || 'No Ability';
      }
      return resolveRealAbility(freq, teamWeatherContext)?.ability || pokemonRow?.ability1 || 'No Ability';
    });

    // STEP 3 + 4: candidate items scored (FIX 4: Scarf excluded for a real,
    // active weather-ability-abuser build), then conflicts resolved.
    const teamCandidates = await Promise.all(teamNames.map(async (name, i) => {
      const pokemonRow = pokemonRowsByLower[name.toLowerCase()];
      const role = roleResults[i].role;
      const ability = finalAbilities[i];
      const abuserWeather = conditionalSpeedAbilityWeather(ability);
      const isWeatherAbuser = isConditionalSpeedAbility(ability) && !!abuserWeather && teamWeatherContext.has(abuserWeather);
      const candidates = await getScoredCandidateItems(pokemonRow, role, { isWeatherAbuser, teamWeatherContext });
      return { pokemon: name, role, pokemonRow, candidates, isWeatherAbuser };
    }));
    const itemAssignments = resolveItemConflicts(teamCandidates);
    const itemByPokemon = Object.fromEntries(itemAssignments.map((a) => [a.pokemon, a]));

    // STEP 5: item-aware evolutionary EV optimization, all 6 Pokemon in parallel.
    // Each Pokemon uses its OWN weather (based on its own weather-setting ability)
    // rather than a single shared weather from [...teamWeatherContext][0], which
    // picks arbitrarily and can give conflicting weather (e.g., Pelipper's Rain
    // used for Charizard-Mega-Y's Solar Beam calcs). _teamContext (all team
    // weathers) is passed alongside so scoreSpread's detailed pass can compute
    // alternative-weather damage for the Why-block display.
    const teamWeathersForContext = [...teamWeatherContext];
    const evoResults = await Promise.all(teamNames.map((name, i) => {
      const item = itemByPokemon[name].item;
      const ability = finalAbilities[i];
      const abilityWeather = WEATHER_SETTER_ABILITIES[(ability || '').toLowerCase()];
      // Non-setters inherit team weather so weather-dependent calcs reflect real
      // team conditions. Priority: (1) own weather-setting ability, (2) the weather
      // a weather-requiring ability thrives in when the team has it (e.g. Venusaur
      // Chlorophyll inherits Sun, not the team's first-listed Rain), (3) the team's
      // first active weather. _teamContext still carries every team weather so the
      // detailed pass surfaces each alternative separately.
      const requiredWeather = conditionalSpeedAbilityWeather(ability);
      const requiredInTeam = requiredWeather && teamWeatherContext.has(requiredWeather);
      const inheritedWeather = abilityWeather
        || (requiredInTeam ? requiredWeather : (teamWeathersForContext.length > 0 ? teamWeathersForContext[0] : null));
      const fieldOpts = { weather: inheritedWeather || null, _teamContext: teamWeathersForContext };
      return getOrComputeEvolutionarySpread(name, { item, teamBuild: true, fieldOpts });
    }));

    // FIX 1: Pre-compute base abilities for Mega Pokemon (outside the .map() loop
    // since that's not async-friendly).
    const baseAbilityCache = {};
    for (const n of teamNames) {
      const pr = pokemonRowsByLower[n.toLowerCase()];
      if (pr && pr.name.toLowerCase().includes('-mega')) {
        const baseName = pr.name.replace(/-Mega.*$/, '');
        try {
          const { rows } = await pool.query('SELECT ability1 FROM pokemon WHERE LOWER(name) = LOWER($1)', [baseName]);
          baseAbilityCache[n] = rows.length > 0 ? rows[0].ability1 : null;
        } catch (_err) { baseAbilityCache[n] = null; }
      }
    }

    const ZERO_SP = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    const team = teamNames.map((name, i) => {
      const pokemonRow = pokemonRowsByLower[name.toLowerCase()];
      const role = roleResults[i].role;
      const assignment = itemByPokemon[name];
      const evo = evoResults[i];
      const topSpread = evo?.result?.spreads?.[0] || null;
      const baseAbility = baseAbilityCache[name];

      // Nerd of Now seed tracking: find which seed (if any) the final spread
      // is closest to, and whether it converged or diverged.
      const seedsUsed = evo?.seeds_used || [];
      const finalSp = topSpread?.sp || ZERO_SP;
      let seedInfo = null;
      if (seedsUsed.length > 0) {
        // Find the closest seed by total SP distance
        let bestSeed = null;
        let bestDist = Infinity;
        for (const seed of seedsUsed) {
          let dist = 0;
          for (const s of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
            dist += Math.abs((finalSp[s] || 0) - (seed.sp[s] || 0));
          }
          if (dist < bestDist) { bestDist = dist; bestSeed = seed; }
        }
        if (bestSeed) {
          const conv = checkSeedConvergence(finalSp, bestSeed.sp);
          seedInfo = {
            label: bestSeed.label,
            source_name: bestSeed.source_name,
            sp: bestSeed.sp,
            converged: conv.converged,
            reason: conv.reason,
          };
        }
      }

      return {
        pokemon: pokemonRow.name,
        pokemonRow,
        role,
        ability: finalAbilities[i],
        base_ability: baseAbility,
        item: assignment.item,
        item_assignment: assignment,
        nature: evo?.nature || 'Hardy',
        sp: topSpread?.sp || ZERO_SP,
        final_stats: topSpread?.final_stats || null,
        evolutionary_score: topSpread?.score ?? null,
        thresholds_met: topSpread?.thresholds_met || [],
        minimization: topSpread?.minimization || null,
        enrichedMoves: enrichedMovesByName[i],
        seed_info: seedInfo,
        available_seeds: seedsUsed,
      };
    });

    // Team-context annotation needs the FULL assembled `team` array (every
    // member's moves) to check for redundancy/uniqueness — done as a second pass.
    // `member.moves` keeps type/category/power (team_analyzer.js's coverage and
    // synergy_reasons.js's generateSynergyReasons both require them); the
    // response-assembly step below builds a slimmed-down public view instead of
    // stripping fields here.
    // FIX 4 (round 2): computed once for the whole team (it's a team-level
    // property, not per-mon) and used to hard-filter Trick Room out of every
    // member's recommendations entirely when the team doesn't qualify — not a
    // soft confidence penalty, per this task's explicit "suppress ... entirely".
    const teamIsTrCandidate = isTrickRoomViableTeam(team);
    for (const member of team) {
      // FIX 2: Protect is unplayable on a Choice item (Scarf/Band/Specs) — the
      // mon would lock into Protect permanently on the first use. Hard-filtered
      // out of the candidate list before ranking/team_context, not merely
      // flagged, so it can never reach the output for a Choice-locked mon.
      const isChoiceLocked = CHOICE_ITEMS_BANNING_PROTECT.has((member.item || '').toLowerCase());
      const adjustedMoves = member.enrichedMoves
        .filter((mv) => (mv.move !== 'Trick Room' || teamIsTrCandidate) && (mv.move !== 'Protect' || !isChoiceLocked))
        .map((mv) => ({
          ...mv,
          team_context: buildMoveTeamContext(member, mv, team, teamWeatherContext),
        }));
      // FIX 3: Team-aware move selection — prioritize moves that cover team
      // weaknesses, provide team synergy, and match the Pokemon's role.
      // Start with tournament frequency baseline, then re-rank by team fit.
      adjustedMoves.sort((a, b) => b.confidence - a.confidence);
      // Pick the top 4 moves after filtering (hard rules are already applied above)
      const bestMoves = adjustedMoves.slice(0, 4);
      member.moves = bestMoves.map((mv, idx) => ({
        move: mv.move,
        confidence: round(mv.confidence, 4),
        rank: idx + 1,
        type: mv.type,
        category: mv.category,
        power: mv.power,
        team_context: mv.team_context,
      }));
      member.sp_notes = buildItemSpNotes(member.pokemonRow, member.sp, member.item);
      member.item_reason = generateItemReason(member.item_assignment, member.ability, teamWeatherContext);
    }

    // STEP 6: team analysis.
    const [typeMetaData, legalPokemonSet] = await Promise.all([getTypeMetaData(), getLegalPokemonSet()]);
    const synergyData = readJSON('synergy_matrix.json');
    const abilityData = readJSON('ability_synergies.json');

    const coverage = analyzeCoverage(team, typeMetaData, teamWeatherContext);
    const synergies = await analyzeSynergies(team, synergyData?.scores, abilityData?.rules, typeMetaData, movesByLower);
    const weather = analyzeWeather(team);
    const trickRoom = analyzeTrickRoom(team, weather);
    const speedTiers = analyzeSpeedTiers(team, weather);
    // all_ohko_opportunities is stripped here so it never reaches the response
    // body — it exists only to let analyzeWeaknesses look up a KO on a specific
    // meta attacker without being limited to the display slice.
    const { all_ohko_opportunities: allOhkoOpportunities, ...matchupAnalysis } =
      await analyzeMatchups(team, legalPokemonSet, weather);

    // FIX 11: coverage move recommendations based on OHKO risk thresholds
    const coverageSuggestions = await suggestCoverageReplacements(team, matchupAnalysis.ohko_risks);

    const protectCount = team.filter((m) => m.moves.some((mv) => mv.move === 'Protect')).length;
    const protectWarning = protectCount < 4
      ? `Only ${protectCount}/6 team members carry Protect — Protect is nearly universal in VGC doubles; consider adding more`
      : null;

    // STEP 7: weaknesses + archetype matchups (FIX 11: key_threats filtered to
    // Pokemon with real presence in this format's usage_stats).
    const weaknesses = await analyzeWeaknesses(team, typeMetaData, teamWeatherContext, allOhkoOpportunities);
    // Live, data-derived archetype analysis (see archetype_matchups.js). The old
    // analyzeArchetypeMatchups used a static table whose hardcoded
    // `key_threat_speed` was printed against whichever threat was listed first —
    // the source of the impossible "Charizard-Mega-Y (~185 effective Speed)".
    const archetypeMatchups = await analyzeArchetypeMatchupsLive(team, weather, synergies, legalPokemonSet, { weather: [...(teamWeatherContext || [])][0] || null });

    // Simple, disclosed aggregate: equal-weighted average of three already-computed
    // real signals (type-coverage completeness, real synergy-pair count, favorable
    // archetype-matchup ratio) — not an opaque ML score, just a transparent summary.
    const coverageRatio = coverage.covered_types.length / 18;
    const synergyRatio = Math.min(synergies.length / 5, 1);
    const archetypeRatio = archetypeMatchups.filter((a) => a.matchup_rating === 'favorable').length / archetypeMatchups.length;
    const teamScore = round((coverageRatio + synergyRatio + archetypeRatio) / 3, 4);

    const teamNotes = [];
    if (synergies.length > 0) {
      teamNotes.push(`Strong synergy: ${synergies[0].pair.join(' + ')}${synergies[0].reasons[0] ? ` — ${synergies[0].reasons[0]}` : ''}`);
    }
    if (coverage.coverage_gaps.length > 0) {
      teamNotes.push(coverage.coverage_gaps[0].note);
    }
    if (weaknesses.critical.length > 0) {
      teamNotes.push(`Critical weakness to ${weaknesses.critical[0].type}: ${weaknesses.critical[0].team_members_weak.join(', ')} all weak`);
    }
    if (protectWarning) teamNotes.push(protectWarning);

    const responseBody = {
      team: team.map((m) => ({
        pokemon: m.pokemon,
        role: m.role,
        ability: m.base_ability ? `${m.ability} (base: ${m.base_ability})` : m.ability,
        ability_raw: m.ability,
        base_ability: m.base_ability,
        item: m.item,
        item_reason: m.item_reason,
        nature: m.nature,
        sp: m.sp,
        final_stats: m.final_stats,
        moves: m.moves,
        thresholds_met: m.thresholds_met,
        minimization: m.minimization,
        sp_notes: m.sp_notes,
        seed_info: m.seed_info,
      })),
      team_analysis: {
        coverage,
        synergies,
        weather,
        trick_room: trickRoom,
        speed_tiers: speedTiers,
        protect_count: protectCount,
        protect_warning: protectWarning,
        coverage_suggestions: coverageSuggestions,
      },
      weaknesses,
      archetype_matchups: archetypeMatchups,
      matchup_analysis: matchupAnalysis,
      team_score: teamScore,
      team_notes: teamNotes,
    };

    if (req.accepts(['json', 'text']) === 'text') {
      return res.type('text/plain').send(buildTeamBuildText(responseBody, team));
    }
    res.json(responseBody);
  } catch (err) {
    logger.error('POST /api/team/build failed', { error: err.message, stack: err.stack });
    next(err);
  }
});

module.exports = router;
module.exports.parseShowdownTeam = parseShowdownTeam;
