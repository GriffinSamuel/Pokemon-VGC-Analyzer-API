const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { normalizePokemonName } = require('../utils/normalize');
const { effectivenessAgainst } = require('../utils/typeChart');
const { classifyRole } = require('../utils/role_classifier');
const { buildRecoilText, RECOIL_MOVES } = require('../utils/spread_scorer');
const {
  getScoredCandidateItems, resolveItemConflicts, buildItemSpNotes,
  getRealAbilityFrequency, detectTeamWeatherContext, resolveRealAbility,
  isConditionalSpeedAbility, conditionalSpeedAbilityWeather,
} = require('../utils/item_optimizer');
const { getOrComputeEvolutionarySpread } = require('../utils/ev_optimizer');
const { getNerdOfNowSets } = require('../utils/nerd_of_now');
const {
  getTypeMetaData, analyzeCoverage, analyzeSynergies, analyzeWeather,
  analyzeTrickRoom, analyzeSpeedTiers, analyzeWeaknesses, analyzeArchetypeMatchups,
  analyzeMatchups, getLegalPokemonSet, suggestCoverageReplacements,
} = require('../utils/team_analyzer');
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

  // Showdown supports "Nickname (Species)" — the parenthesized form is the real species.
  const nicknameMatch = namePart.match(/^(.+?)\s*\((.+?)\)$/);
  const species = nicknameMatch ? nicknameMatch[2].trim() : namePart;
  if (!species) return null;

  const mon = {
    name: species,
    item,
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
      if (move) mon.attacks.push(move);
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

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

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

  // FIX 10: Weather Ball's real attacking type/power under this team's active
  // weather, instead of evaluating it as static Normal-type/40 BP.
  if (mv.move === 'Weather Ball' && teamWeatherSet && teamWeatherSet.size > 0) {
    for (const weather of teamWeatherSet) {
      const effectiveType = WEATHER_BALL_TYPES[weather];
      if (!effectiveType) continue;
      // Sun/Rain/Sand/Snow don't boost Special Attack — they boost specific types' damage
      const weatherTypeBonus = (weather === 'rain' && effectiveType === 'Water')
        || (weather === 'sun' && effectiveType === 'Fire') ? 1.5 : 1;
      const effectiveBP = weatherTypeBonus > 1 ? Math.round(WEATHER_BALL_BOOSTED_BP * weatherTypeBonus) : WEATHER_BALL_BOOSTED_BP;
      const bonusNote = weatherTypeBonus > 1 ? ` (${weatherTypeBonus}x weather bonus = effective ${effectiveBP} BP)` : '';
      return `${WEATHER_BALL_BOOSTED_BP} BP ${effectiveType}-type, assumes our ${weather} active${bonusNote}`;
    }
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
const SP_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

function sectionDivider(label) {
  const opening = `── ${label} `;
  return opening + '─'.repeat(Math.max(TEXT_DIVIDER_WIDTH - opening.length, 4));
}

// Displays raw Stat Points (0-32 per stat, 66 total) — never converted to
// classic EVs. Labeled "SP:" rather than "EVs:" since a real Showdown "EVs:"
// line means 0-252 numbers; showing 0-32 values under that label would misread
// as a real EV spread that's ~8x too low.
function evsLine(sp) {
  const parts = SP_ORDER
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
function describeThresholdForWhy(t, allDefensiveThresholds, statKey) {
  if (t.category === 'speed') return t.threat.replace(/^Outspeed /, 'outspeeds ');
  if (t.category === 'defensive') {
    const recoilText = buildRecoilText(extractMoveName(t), t.weighted_damage_min || 0, t.weighted_damage_max || 0);
    let primaryText;
    if (t.attacker_build && typeof t.weighted_damage_min === 'number') {
      primaryText = `survives ${t.threat} (${t.attacker_build}: ${t.weighted_damage_min}-${t.weighted_damage_max}%${recoilText})`;
    } else {
      primaryText = `survives ${t.threat} (${t.this_spread_ko}${recoilText})`;
    }

    // FIX 4: secondary interactions — top 4 closest-to-OHKO, ordered by max damage descending
    if (allDefensiveThresholds && statKey) {
      const secondaries = allDefensiveThresholds
        .filter(th => th.stat === statKey && th.category === 'defensive' && th !== t)
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
          return `${th.attackerName} ${th.moveName} (${range}${buildLabel}${secRecoil})`;
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
      const spreadFreq = spreadInfo?.frequency ? `${Math.round(spreadInfo.frequency * 100)}%` : '';
      // FIX 8: Special moves must show defender's SpD, Physical moves must show Def
      // attacker_build format: "Nature SpVal Atk/SpA Item" — check the offensive stat label
      const isSpecialAttacker = t.attacker_build && (t.attacker_build.includes('SpA'));
      const defStatKey = isSpecialAttacker ? 'spd' : 'def';
      const defStatLabel = isSpecialAttacker ? 'SpD' : 'Def';
      const defDescription = spreadInfo ? `${spreadInfo.sp.hp || 0}HP/${spreadInfo.sp[defStatKey] || 0}${defStatLabel}` : '';
      const range = typeof t.weighted_damage_min === 'number' ? `${t.weighted_damage_min}-${t.weighted_damage_max}%` : '';
      const recoilPart = buildRecoilText(moveName, t.weighted_damage_min || 0, t.weighted_damage_max || 0);
      const freqPart = spreadFreq ? `, most common spread, ${spreadFreq} of ${targetName}` : '';
      const buildLabel = t.attacker_build ? `${t.attacker_build}: ` : '';
      return `${t.this_spread_ko}s ${targetName} with ${moveName}${range ? ` (${buildLabel}${range}${recoilPart} vs ${defDescription}${freqPart})` : ''}`;
    }
    const vsTarget = t.threat.split(' vs. ')[1];
    return vsTarget ? `${t.this_spread_ko} vs ${vsTarget}` : `${t.this_spread_ko} — ${t.threat}`;
  }
  return t.threat;
}

// One line per invested stat, showing the highest-contribution real threshold
// (from the evolutionary result's thresholds_met, stat-tagged in
// spread_scorer.js) that stat's investment addresses. A 0 SP stat is omitted
// entirely. A stat with no matching threshold falls back to a role-based note
// for the Pokemon's own primary offensive stat, or a generic breakpoint note
// otherwise — never fabricated beyond what thresholds_met/role already say.
function buildSpAllocationWhy(member) {
  const bestByStat = {};
  for (const t of member.thresholds_met || []) {
    if (!t.stat) continue;
    if (!bestByStat[t.stat] || t.contribution > bestByStat[t.stat].contribution) bestByStat[t.stat] = t;
  }
  const primaryOffenseStat = member.pokemonRow.atk >= member.pokemonRow.spa ? 'atk' : 'spa';
  const allDefensiveThresholds = (member.thresholds_met || []).filter(t => t.category === 'defensive');
  const lines = [];
  let justifiedSp = 0;
  let unspendableSp = 0;

  for (const statKey of SP_ORDER) {
    const spVal = member.sp[statKey] || 0;
    if (spVal === 0) continue;
    const label = `${spVal} ${SHOWDOWN_STAT_LABELS[statKey]}`;
    const best = bestByStat[statKey];

    // PROBLEM 2 FIX: justification text is NEVER overwritten by redistribution.
    // Every stat with SP shows its justifying threshold + [also:.] secondaries.
    if (best) {
      justifiedSp += spVal;
      lines.push(`${label} — ${describeThresholdForWhy(best, allDefensiveThresholds, statKey)}`);
    } else if (statKey === primaryOffenseStat) {
      justifiedSp += spVal;
      lines.push(`${label} — maximized for offensive role`);
    } else {
      // PROBLEM 4: SP in stats with no threshold IS unspendable, even if the
      // optimizer physically placed it there via dump-stat allocation.
      unspendableSp += spVal;
      lines.push(`${label} — unspendable SP: ${spVal} (no threshold cleared)`);
    }
  }

  // Every SP must be accounted for: justified by threshold + unspendable (no
  // threshold or budget remainder). Sum must equal exactly 66.
  const SP_BUDGET = 66;
  const unspendableTotal = SP_BUDGET - justifiedSp;
  lines.push(`  SP: ${justifiedSp} justified + ${unspendableTotal} unspendable = ${SP_BUDGET} total`);
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
    if (member.minimization) {
      const mini = member.minimization;
      if (mini.reductions && Object.keys(mini.reductions).length > 0) {
        const redStrs = Object.entries(mini.reductions).map(([s, r]) => `${r.saved} ${SHOWDOWN_STAT_LABELS[s]} (${r.from}→${r.to})`);
        lines.push(`  SP minimized: removed ${redStrs.join(', ')}`);
      }

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
        const spParts = SP_ORDER.filter(s => (seed.sp[s] || 0) > 0).map(s => `${seed.sp[s]} ${SHOWDOWN_STAT_LABELS[s]}`);
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
    lines.push('Coverage gaps:');
    for (const gap of ta.coverage.coverage_gaps) {
      lines.push(`  - ${gap.note} (meta prevalence ${(gap.meta_prevalence * 100).toFixed(1)}%)`);
    }
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
      lines.push(`${w.type}: ${w.team_members_weak.join(', ')} weak (meta prevalence ${(w.meta_prevalence * 100).toFixed(1)}%)`);
      if (w.exploited_by.length > 0) {
        lines.push(`  Exploited by: ${w.exploited_by.map((e) => `${e.pokemon} (${(e.usage * 100).toFixed(1)}%)`).join(', ')}`);
      }
      if (w.mitigation) lines.push(`  Mitigation: ${w.mitigation}`);
    }
  }
  if (responseBody.weaknesses.double_weaknesses.length > 0) {
    lines.push('4x weaknesses:');
    for (const d of responseBody.weaknesses.double_weaknesses) {
      lines.push(`  - ${d.type}: ${d.team_members.join(', ')}${d.mitigation ? ` (${d.mitigation})` : ''}`);
    }
  }
  lines.push('');

  lines.push(sectionDivider('ARCHETYPE MATCHUPS'));
  for (const m of responseBody.archetype_matchups) {
    lines.push(`${m.archetype}: ${m.matchup_rating.toUpperCase()}`);
    lines.push(`  Key threats: ${m.key_threats.join(', ')}`);
    lines.push(`  ${m.key_threat_note}`);
    lines.push(`  Win condition: ${m.win_condition}`);
    lines.push(`  Lose condition: ${m.lose_condition}`);
    // FIX 14: Quick recommendations for unfavorable matchups
    if (m.matchup_rating === 'unfavorable' || m.matchup_rating === 'hard' || m.matchup_rating === 'difficult') {
      const quickFix = buildQuickFixRecommendation(m, responseBody);
      if (quickFix) lines.push(`  Quick fix: ${quickFix}`);
    }
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
    const provisionalAbilities = abilityFrequencies.map((freq) => resolveRealAbility(freq, new Set())?.ability || null);
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

    // STEP 5: item-aware evolutionary EV optimization, all 6 Pokemon in parallel
    // (see ev_optimizer.js's getOrComputeEvolutionarySpread — awaits the real
    // search on a cache miss instead of the plain /evs endpoint's fire-and-forget
    // pattern, and shares that same 24hr cache). Ability is NOT threaded into
    // this search — spread_scorer.js/spread_optimizer.js are out of scope for
    // this task's fixes and already don't accept an ability parameter.
    const fieldOpts = teamWeatherContext.size > 0 ? { weather: [...teamWeatherContext][0] } : null;
    const evoResults = await Promise.all(teamNames.map((name) => {
      const item = itemByPokemon[name].item;
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
    const matchupAnalysis = await analyzeMatchups(team, legalPokemonSet, weather);

    // FIX 11: coverage move recommendations based on OHKO risk thresholds
    const coverageSuggestions = await suggestCoverageReplacements(team, matchupAnalysis.ohko_risks);

    const protectCount = team.filter((m) => m.moves.some((mv) => mv.move === 'Protect')).length;
    const protectWarning = protectCount < 4
      ? `Only ${protectCount}/6 team members carry Protect — Protect is nearly universal in VGC doubles; consider adding more`
      : null;

    // STEP 7: weaknesses + archetype matchups (FIX 11: key_threats filtered to
    // Pokemon with real presence in this format's usage_stats).
    const weaknesses = analyzeWeaknesses(team, typeMetaData);
    const archetypeMatchups = analyzeArchetypeMatchups(team, weather, legalPokemonSet);

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
