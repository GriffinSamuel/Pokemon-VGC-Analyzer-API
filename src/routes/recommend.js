const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { createCache } = require('../utils/cache');
const { weaknessesOf, resistancesOf } = require('../utils/typeChart');
const { generateSynergyReasons } = require('../utils/synergy_reasons');
const { optimizeEvs, findDefensiveThresholds, findSpeedThresholds, findOffensiveThresholds, ROLE_MULTIPLIERS, getEvolutionaryStatus } = require('../utils/ev_optimizer');
const { getThreatMatrix } = require('../utils/threat_matrix');
const { getMetaContext } = require('../utils/speed_context');
const { classifyRole } = require('../utils/role_classifier');
const { scoreSpread } = require('../utils/spread_scorer');
const { calcStat, natureMultiplierFor, SP_CAP_PER_STAT, STAT_ORDER } = require('../utils/stat_formula');
const { round } = require('../utils/format');
const { getSpeciesRow, getNatureDistribution, getMostCommonSpread, getCommonSpeedTiers } = require('../utils/ev_observations');

const MODELS_DIR = path.join(__dirname, '..', 'ml', 'models');
const MIN_APPEARANCES = 10;
const MIN_CONFIDENCE = 0.05;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_SIZE = 500;

const moveRecCache = createCache({ ttlMs: CACHE_TTL_MS, maxSize: CACHE_MAX_SIZE });
const evRecCache = createCache({ ttlMs: CACHE_TTL_MS, maxSize: CACHE_MAX_SIZE });
const synergyCache = createCache({ ttlMs: CACHE_TTL_MS, maxSize: CACHE_MAX_SIZE });

function readModelJSON(filename) {
  const filePath = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function extractTeammates(query) {
  return Object.keys(query)
    .filter((key) => /^teammate\d*$/i.test(key))
    .map((key) => String(query[key]).toLowerCase())
    .filter(Boolean);
}

// Prefer the Showdown `id` field over `name`: `name` is a display string that can
// carry gender symbols the species table doesn't use (e.g. "Basculegion ♀" vs the
// table's "Basculegion-F"), while `id` ("basculegion-f") already matches it. Mirrors
// data.py's species_key() on the Python training side.
function speciesKey(mon) {
  return (mon.id || mon.name || '').toLowerCase();
}

// Live contextual prevalence: only run when the caller supplies teammates, since
// the precomputed move_recommendations.json (built at training time) can't know
// about a specific team composition ahead of time.
async function computeContextualMoveStats(pokemonLower, teammates) {
  const { rows } = await pool.query('SELECT pokemon FROM tournament_teams WHERE wins > losses');
  let appearances = 0;
  const moveCounts = {};

  for (const row of rows) {
    const mons = row.pokemon || [];
    const keys = mons.map(speciesKey);
    if (!keys.includes(pokemonLower)) continue;
    if (teammates.length && !teammates.every((t) => keys.includes(t))) continue;

    appearances++;
    const mon = mons.find((m) => speciesKey(m) === pokemonLower);
    // De-duplicate: a real Pokemon can't have the same move twice — a repeat in the
    // scraped decklist is a data glitch, not a signal (seen in the wild once already).
    for (const move of new Set(mon.attacks || [])) {
      moveCounts[move] = (moveCounts[move] || 0) + 1;
    }
  }

  return { appearances, moveCounts };
}

// Same fallback title-casing pattern as normalize.js's normalizePokemonName() —
// used when a partner (e.g. a Mega form like "swampert-mega") has no row in the
// `pokemon` table to source proper display casing from.
function titleCase(key) {
  return key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

// Shared core of GET /api/recommend/moves/:pokemon — reusable in-process (no HTTP
// round-trip) by POST /api/team/build's pipeline, same model data and contextual-
// teammate logic, just parameterized on how many moves to return. Returns null
// for both "model not trained" and "not enough tournament appearances" (the
// route below re-checks which one to preserve its existing distinct 404 messages).
async function getMoveRecommendationsFor(pokemonLower, teammates = [], topN = 4) {
  const recData = readModelJSON('move_recommendations.json');
  if (!recData) return null;

  const entry = recData.pokemon[pokemonLower];
  if (!entry || entry.total_appearances < MIN_APPEARANCES) return null;

  let recommendations;
  let trainingSamples;

  if (teammates.length > 0) {
    const { appearances, moveCounts } = await computeContextualMoveStats(pokemonLower, teammates);
    if (appearances > 0) {
      recommendations = Object.entries(moveCounts)
        .map(([move, count]) => ({ move, confidence: count / appearances }))
        .filter((m) => m.confidence >= MIN_CONFIDENCE)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, topN);
      trainingSamples = appearances;
    }
  }

  if (!recommendations || recommendations.length === 0) {
    recommendations = entry.moves.slice(0, topN).map((m) => ({ move: m.move, confidence: m.confidence }));
    trainingSamples = entry.total_appearances;
  }

  return {
    recommendations: recommendations.map((m, i) => ({ move: m.move, confidence: round(m.confidence), rank: i + 1 })),
    training_samples: trainingSamples,
    model_trained_at: recData.trained_at,
  };
}

router.get('/moves/:pokemon', async (req, res, next) => {
  try {
    const pokemonLower = req.params.pokemon.toLowerCase();
    const teammates = extractTeammates(req.query);

    const cacheKey = JSON.stringify({ pokemon: pokemonLower, teammates: [...teammates].sort() });
    const cached = moveRecCache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const result = await getMoveRecommendationsFor(pokemonLower, teammates, 4);
    if (!result) {
      const recData = readModelJSON('move_recommendations.json');
      if (!recData) return res.status(404).json({ error: 'Move recommendation model has not been trained yet' });
      return res.status(404).json({
        error: `Not enough tournament data for ${req.params.pokemon} (fewer than ${MIN_APPEARANCES} appearances)`,
      });
    }

    const body = { pokemon: req.params.pokemon, ...result };
    moveRecCache.set(cacheKey, body);
    res.json({ ...body, cached: false });
  } catch (err) {
    logger.error('GET /api/recommend/moves failed', { error: err.message });
    next(err);
  }
});

// --- /evs/:pokemon response formatting -------------------------------------------
// ev_optimizer.js's optimizeEvs() is the single source of truth for the actual SP
// values/scores/notes in each spread — none of that is recomputed here. To recover
// per-threshold descriptive detail (attacker/target/move/required-stat) that
// optimizeEvs() already collapses into plain strings before returning, this calls
// the same exported finder functions a second time (findDefensiveThresholds etc.)
// purely for their richer raw objects, then classifies each one as "met" by this
// spread using the exact same subsumption rule applyThreshold() uses internally
// (finalSp[stat] >= sp_investment) — not a re-derivation of which thresholds win,
// just a presentation-layer lookup against an already-decided, unchanged result.

function offenseStatFor(defenseStat) {
  return defenseStat === 'def' ? 'atk' : 'spa';
}

function computeFinalStats(speciesRow, sp, nature) {
  const stats = {};
  for (const key of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
    const isHp = key === 'hp';
    const alignment = isHp ? 1.0 : natureMultiplierFor(nature, key);
    stats[key] = calcStat(speciesRow[key], sp[key] || 0, alignment, isHp);
  }
  return stats;
}

async function resolveDisplayNature(pokemonLower, natureOverride) {
  if (natureOverride) return natureOverride;
  const dist = await getNatureDistribution(pokemonLower);
  return dist.primaryNature || 'Hardy';
}

// Mirrors the small data-loading step optimizeEvs() does internally to call
// findOffensiveThresholds() — not a reimplementation of any scoring/threshold logic,
// just re-loading the same inputs that exported function requires as parameters.
async function loadOwnTopMoves(pokemonLower) {
  const moveRecPath = path.join(MODELS_DIR, 'move_recommendations.json');
  let ownTopMoves = [];
  if (fs.existsSync(moveRecPath)) {
    const moveRec = JSON.parse(fs.readFileSync(moveRecPath, 'utf8'));
    ownTopMoves = moveRec.pokemon[pokemonLower]?.moves?.slice(0, 4) || [];
  }
  const ownMoveNames = ownTopMoves.map((m) => m.move.toLowerCase());
  const { rows: ownMoveRows } = ownMoveNames.length
    ? await pool.query('SELECT * FROM moves WHERE LOWER(name) = ANY($1)', [ownMoveNames])
    : { rows: [] };
  const ownMovesByLower = Object.fromEntries(ownMoveRows.map((m) => [m.name.toLowerCase(), m]));
  return { ownTopMoves, ownMovesByLower };
}

function formatDefensiveThreshold(t) {
  // FIX 4/6: Marginal value check — a defensive threshold only justifies SP
  // investment if WITHOUT that investment the Pokemon would be KO'd, and WITH
  // that investment it survives. If survival_without_investment is already TRUE,
  // this threshold provides zero marginal value and must not appear in the Why block.
  if (t.survival_without_investment === true) return null;

  const offenseStat = offenseStatFor(t.stat);
  return {
    survives: `${t.attacker} ${t.move}`,
    attacker: t.attacker,
    move: t.move,
    attacker_nature: t.nature_note,
    attacker_sp: { [offenseStat]: SP_CAP_PER_STAT },
    attacker_sp_source: t.nature_reliability >= 0.7 ? 'observed' : 'assumed_zero',
    required_hp_sp: 0, // HP is a spread-wide allocation, not tied to any individual threshold — see sp_notes
    [`required_${t.stat}_sp`]: t.sp_investment,
    score: round(t.score, 3),
  };
}

function formatSpeedThreshold(t) {
  return {
    benchmark: t.benchmark,
    required_spe_sp: t.sp_investment,
    final_speed: t.final_speed,
    opponent_frequency: t.opponent_frequency === null || t.opponent_frequency === undefined ? null : round(t.opponent_frequency, 4),
    score: round(t.score, 3),
    ...(t.is_scarf ? { is_scarf: true, scarf_frequency: round(t.scarf_frequency, 4) } : {}),
    ...(t.is_conditional ? { is_conditional: true, condition_label: t.condition_label, ability_label: t.ability_label, ability_boost_frequency: round(t.ability_boost_frequency, 4) } : {}),
    ...(t.is_mirror ? { is_mirror: true } : {}),
    ...(t.scarf_frequency != null && !t.is_scarf ? { scarf_frequency: round(t.scarf_frequency, 4) } : {}),
    ...(t.ability_boost_frequency != null && !t.is_conditional ? { ability_boost_frequency: round(t.ability_boost_frequency, 4), ability_label: t.ability_label, condition_label: t.condition_label } : {}),
  };
}

async function formatOffensiveThreshold(t) {
  const observed = t.has_target_observations ? await getMostCommonSpread(t.target.toLowerCase()) : null;
  const targetSp = observed ? observed.sp : { hp: 0, def: 0, spd: 0 };
  return {
    target: t.target,
    move: t.move,
    target_sp: { hp: targetSp.hp, def: targetSp.def, spd: targetSp.spd },
    target_sp_source: t.has_target_observations ? 'observed' : 'assumed_zero',
    target_nature: observed ? observed.nature : null,
    [`required_${t.stat}_sp`]: t.sp_investment,
    score: round(t.score, 3),
  };
}

function sortByScoreDesc(list) {
  return [...list].sort((a, b) => b.score - a.score);
}

async function formatSpread(rawSpread, speciesRow, displayNature, sharedThresholds) {
  const { defensiveThresholds, speedThresholds, offensiveThresholds } = sharedThresholds;
  const finalSp = rawSpread.sp;
  const met = (t) => (finalSp[t.stat] || 0) >= t.sp_investment;

  const ohkoAchievedRaw = offensiveThresholds.filter((t) => t.threshold_type === 'OHKO_achieved' && met(t));
  const twoHkoAchievedRaw = offensiveThresholds.filter((t) => t.threshold_type === '2HKO_achieved' && met(t));
  const [ohkoAchieved, twoHkoAchieved] = await Promise.all([
    Promise.all(ohkoAchievedRaw.map(formatOffensiveThreshold)),
    Promise.all(twoHkoAchievedRaw.map(formatOffensiveThreshold)),
  ]);

  return {
    label: rawSpread.label,
    spread_label: rawSpread.spread_label,
    role_priority: rawSpread.role_priority,
    nature: displayNature,
    sp: rawSpread.sp,
    total_sp: rawSpread.total_sp,
    final_stats: computeFinalStats(speciesRow, finalSp, displayNature),
    speed_benchmarks: sortByScoreDesc(speedThresholds.filter(met).map(formatSpeedThreshold)),
    ohko_achieved: sortByScoreDesc(ohkoAchieved),
    '2hko_achieved': sortByScoreDesc(twoHkoAchieved),
    ohko_prevented: sortByScoreDesc(
      defensiveThresholds.filter((t) => t.threshold_type === 'OHKO_prevented' && met(t)).map(formatDefensiveThreshold).filter(Boolean)
    ),
    '2hko_prevented': sortByScoreDesc(
      defensiveThresholds.filter((t) => t.threshold_type === '2HKO_prevented' && met(t)).map(formatDefensiveThreshold).filter(Boolean)
    ),
    '3hko_prevented': sortByScoreDesc(
      defensiveThresholds.filter((t) => t.threshold_type === '3HKO_prevented' && met(t)).map(formatDefensiveThreshold).filter(Boolean)
    ),
    thresholds_skipped: rawSpread.thresholds_skipped.map((s) => ({
      description: s.would_survive || s.would_outrun || s.would_achieve || null,
      threshold_type: s.threshold_type,
      score: round(s.score, 3),
      reason: s.reason,
      ...(s.always_skipped ? { always_skipped: true } : {}),
    })),
    sp_notes: rawSpread.sp_notes,
    // Present only once the evolutionary (real @smogon/calc) search has completed
    // for this spread's SP allocation — see ev_optimizer.js's applyEvolutionaryOverride.
    // Absent entirely while X-Spread-Status is "computing" (greedy fallback).
    ...(rawSpread.evolutionary_score !== undefined ? {
      evolutionary_score: rawSpread.evolutionary_score,
      evolutionary_thresholds_met: rawSpread.evolutionary_thresholds_met,
      evolutionary_thresholds_missed: rawSpread.evolutionary_thresholds_missed,
    } : {}),
  };
}

// --- /evs/:pokemon text/plain rendering -------------------------------------------
// Pure presentation on top of the already-computed, already-JSON-formatted spreads
// (via formatSpread above) — the JSON response shape is never touched. The one
// exception is the SPEED section: the JSON speed_benchmarks entries only carry a
// pre-composed `benchmark` string (no separate attacker/nature/opponent_speed
// fields, since the JSON format never needed them split out), so that section reads
// from the raw speed threshold objects instead, augmented here with each
// opponent's nature via a fresh getCommonSpeedTiers() lookup (an already-exported,
// unmodified utility — not new scoring logic).

const TEXT_STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
const TEXT_DIVIDER_WIDTH = 41;

function defenseStatFor(offenseStat) {
  return offenseStat === 'atk' ? 'def' : 'spd';
}

function bareTierWord(thresholdType) {
  return thresholdType.replace(/_prevented$|_achieved$/, '');
}

function fmtScore(score) {
  return Number(score).toFixed(3);
}

function bigDivider() {
  return '═'.repeat(TEXT_DIVIDER_WIDTH);
}

function sectionDivider(label) {
  const opening = `── ${label} `;
  return opening + '─'.repeat(Math.max(TEXT_DIVIDER_WIDTH - opening.length, 4));
}

function formatStatsLine(finalStats, sp) {
  const line1 = ['hp', 'atk', 'def'].map((k) => `${TEXT_STAT_LABELS[k]} ${finalStats[k]} (${sp[k]})`).join('  ');
  const line2 = ['spa', 'spd', 'spe'].map((k) => `${TEXT_STAT_LABELS[k]} ${finalStats[k]} (${sp[k]})`).join('  ');
  return `${line1}\n${line2}`;
}

// Caches per-attacker within a single request — several speed thresholds (different
// tiers) commonly share the same attacker, so this avoids redundant DB round-trips.
async function attachSpeedNatures(speedThresholds) {
  const tiersByAttacker = {};
  return Promise.all(speedThresholds.map(async (t) => {
    const key = t.attacker.toLowerCase();
    if (!tiersByAttacker[key]) tiersByAttacker[key] = (await getCommonSpeedTiers(key)).tiers;
    const match = tiersByAttacker[key].find((tier) => tier.speed_stat === t.opponent_speed);
    return { ...t, attacker_nature: match ? match.nature : null };
  }));
}

function roleTitleCase(role) {
  return role.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The plain speed-tier list is only worth showing when this role's speed_tier
// multiplier actually values it (>0.5) — both slow-bulky roles score 0.2-0.3 there,
// which is exactly "collapse it" in practice. Scarf/conditional/Trick Room
// subsections are informational about real threats and always show regardless.
function formatSpeedSectionText(speedThresholdsWithNature, spreadSp, pokemonName, role, metaContext) {
  const met = (t) => (spreadSp[t.stat] || 0) >= t.sp_investment;
  const active = speedThresholdsWithNature.filter(met);

  const trEntries = active.filter((t) => t.threshold_type === 'trickroom_speed');
  const scarfEntries = active.filter((t) => t.is_scarf);
  const conditionalEntries = active.filter((t) => t.is_conditional);
  const normalEntries = active.filter((t) => !t.is_scarf && !t.is_conditional && t.threshold_type !== 'trickroom_speed');

  const lines = [];
  const speedMultiplier = (ROLE_MULTIPLIERS[role] || {}).speed_tier ?? 1.0;

  const nonZero = [...normalEntries.filter((t) => t.sp_investment > 0)].sort((a, b) => b.score - a.score);
  const zero = normalEntries.filter((t) => t.sp_investment === 0);

  // Base (unscarfed, non-boosted) tiers only tell the full story for the fraction
  // of this species not running Scarf/its boost ability — append an honest note
  // rather than silently presenting the base tier as the whole picture. The two
  // percentages come from independent samples (ev_observations item field vs.
  // tournament_teams ability field) so they're surfaced separately, not combined.
  function buildContextNote(t) {
    const parts = [];
    if (t.scarf_frequency != null) parts.push(`${Math.round(t.scarf_frequency * 100)}% run scarf`);
    if (t.ability_boost_frequency != null) parts.push(`${Math.round(t.ability_boost_frequency * 100)}% run ${t.ability_label}`);
    return parts.length > 0 ? ` — note: ${parts.join(', ')}, see skipped` : '';
  }

  function attackerLabel(t, nature) {
    return t.is_mirror ? `Mirror ${nature}${t.attacker}` : `${nature}${t.attacker}`;
  }

  // The "already true for free" +0 SP summary is shown for every role — it costs
  // nothing to know and isn't a priority call. Only the per-tier "invest X SP to
  // outrun Y" lines are collapsed away for roles that don't value Speed investment
  // (both slow-bulky roles score 0.2-0.3 on speed_tier, i.e. "collapse it").
  if (zero.length > 0) {
    const seen = new Set();
    const parts = [];
    for (const t of zero) {
      const nature = t.attacker_nature ? `${t.attacker_nature} ` : '';
      const label = `0 Spe ${attackerLabel(t, nature)} ${t.opponent_speed}`;
      if (seen.has(label)) continue;
      seen.add(label);
      parts.push(label);
    }
    lines.push(`+0 Spe SP: already outspeeds ${parts.join(', ')}`);
  }

  if (speedMultiplier > 0.5) {
    for (const t of nonZero) {
      const pct = Math.round((t.opponent_frequency || 0) * 100);
      const nature = t.attacker_nature ? `${t.attacker_nature} ` : '';
      lines.push(`${t.sp_investment} Spe SP: ${pokemonName} ${t.final_speed} > ${attackerLabel(t, nature)} ${t.opponent_speed} (${pct}%${buildContextNote(t)})`);
    }
  }

  if (trEntries.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Under Trick Room (${Math.round(metaContext.trickroom_prevalence * 100)}% of teams):`);
    for (const t of [...trEntries].sort((a, b) => b.score - a.score)) {
      lines.push(`  ${t.benchmark}`);
    }
  }

  if (scarfEntries.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Scarfed threats:');
    for (const t of [...scarfEntries].sort((a, b) => b.score - a.score)) {
      const pct = Math.round((t.scarf_frequency || 0) * 100);
      lines.push(`  ${t.sp_investment} Spe SP: ${pokemonName} ${t.final_speed} > Scarfed ${t.attacker} ${t.opponent_speed} (${pct}% run scarf)`);
    }
  }

  if (conditionalEntries.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Conditional (weather/ability):');
    for (const t of [...conditionalEntries].sort((a, b) => b.score - a.score)) {
      const abilityPct = Math.round((t.ability_boost_frequency || 0) * 100);
      lines.push(`  requires ${t.condition_label} active (${t.ability_label}, ${abilityPct}% of ${t.attacker}) — ${t.sp_investment} Spe SP: ${pokemonName} ${t.final_speed} > ${t.attacker} ${t.opponent_speed}`);
    }
  }

  return lines;
}

// Batch usage-rank lookup for defensive threat attackers — same RANK() OVER window
// function pattern GET /api/usage/:name already uses, not a new query shape.
async function getUsageRanks(namesLower) {
  if (namesLower.length === 0) return {};
  const { rows } = await pool.query(
    `SELECT pokemon_name, usage_percent, rank FROM (
       SELECT pokemon_name, usage_percent, RANK() OVER (ORDER BY usage_percent DESC) as rank
       FROM usage_stats
     ) ranked WHERE LOWER(pokemon_name) = ANY($1)`,
    [namesLower]
  );
  const byLower = {};
  for (const row of rows) {
    byLower[row.pokemon_name.toLowerCase()] = { rank: parseInt(row.rank, 10), usage_percent: parseFloat(row.usage_percent) };
  }
  return byLower;
}

// --- Evolutionary-result text rendering ------------------------------------------
// scoreSpread()'s `thresholds_met`/`thresholds_missed` (spread_scorer.js) use a
// completely different shape than the greedy system's threshold pools: a single
// pre-composed `threat` string (e.g. "Kingambit Sucker Punch", or for offensive
// entries "Garchomp Earthquake vs. Incineroar" — already containing the literal
// " vs. " separator), a `category` tag (`defensive`/`offensive`/`speed`) instead of
// a `threshold_type` like "OHKO_prevented", and `baseline_ko`/`this_spread_ko`
// instead of a precomputed sp_investment. These helpers read that shape directly
// rather than forcing it through the greedy formatters, which is what left
// DEFENSE/OFFENSE empty when an evolutionary spread's SP allocation didn't happen
// to match any greedy-system threshold's exact sp_investment breakpoint.

// Ranks baseline_ko severity so "OHKO prevented" entries lead 2HKO/3HKO/4HKO ones,
// matching the greedy formatter's tier ordering (OHKO -> 2HKO -> 3HKO).
function tierRankFromBaseline(baselineKo) {
  const order = { OHKO: 0, '2HKO': 1, '3HKO': 2, '4HKO': 3 };
  return order[baselineKo] ?? 4;
}

// Full (unfiltered) usage-rank table, sorted longest-name-first so a prefix match
// against a combined "Attacker Move" threat string prefers the more specific name
// (e.g. "Basculegion-F" over a hypothetical shorter false-positive prefix).
async function getAllUsageRanksSorted() {
  const { rows } = await pool.query(
    `SELECT pokemon_name, usage_percent, RANK() OVER (ORDER BY usage_percent DESC) as rank FROM usage_stats`
  );
  return rows
    .map((r) => ({
      nameLower: r.pokemon_name.toLowerCase(),
      rank: parseInt(r.rank, 10),
      usage_percent: parseFloat(r.usage_percent),
    }))
    .sort((a, b) => b.nameLower.length - a.nameLower.length);
}

// scoreSpread() never stores the attacker name as its own field on a defensive
// entry — only the combined "Attacker Move" string — so the attacker is recovered
// here by finding which known usage_stats name the threat text starts with.
function matchUsageRank(threatText, ranksSorted) {
  const lower = threatText.toLowerCase();
  return ranksSorted.find((r) => lower.startsWith(`${r.nameLower} `)) || null;
}

// Neither defensive nor offensive evolutionary entries carry the move's category
// (Physical/Special) directly — inferred from whichever of Atk/SpA the relevant
// side's SP is actually invested in, same signal `inferOffensiveStat` elsewhere in
// this codebase uses, just read from already-available SP data instead of moves.
function isSpecialSp(sp) {
  return (sp?.spa || 0) > (sp?.atk || 0);
}

function formatDefenseSectionTextEvolutionary(formattedSpread, pokemonName, usageRanksSorted) {
  const entries = (formattedSpread.evolutionary_thresholds_met || [])
    .filter((t) => t.category === 'defensive')
    .sort((a, b) => {
      const tierDiff = tierRankFromBaseline(a.baseline_ko) - tierRankFromBaseline(b.baseline_ko);
      return tierDiff !== 0 ? tierDiff : b.contribution - a.contribution;
    });

  return entries.map((t) => {
    const top = t.attacker_spreads_used[0] || {};
    const natureLabel = top.nature ? `${Math.round((top.frequency || 0) * 100)}% ${top.nature}` : '';
    const special = isSpecialSp(top.sp);
    const atkStatLabel = special ? 'SpA' : 'Atk';
    const atkStatVal = special ? (top.sp?.spa || 0) : (top.sp?.atk || 0);
    const defStatLabel = special ? 'SpD' : 'Def';
    const defStatVal = special ? formattedSpread.sp.spd : formattedSpread.sp.def;
    const usage = matchUsageRank(t.threat, usageRanksSorted);
    const usageNote = usage ? ` [#${usage.rank} usage, ${Math.round(usage.usage_percent)}% of teams]` : '';

    return [natureLabel, `${atkStatVal} ${atkStatLabel}`, t.threat].filter(Boolean).join(' ')
      + ` vs. ${formattedSpread.sp.hp} HP / ${defStatVal} ${defStatLabel} ${pokemonName}: `
      + `${t.weighted_damage_min}-${t.weighted_damage_max}% -- ${t.baseline_ko} prevented (${fmtScore(t.contribution)})${usageNote}`;
  });
}

function formatOffenseSectionTextEvolutionary(formattedSpread) {
  const entries = (formattedSpread.evolutionary_thresholds_met || [])
    .filter((t) => t.category === 'offensive')
    .sort((a, b) => {
      const tierDiff = (a.this_spread_ko === 'OHKO' ? 0 : 1) - (b.this_spread_ko === 'OHKO' ? 0 : 1);
      return tierDiff !== 0 ? tierDiff : b.contribution - a.contribution;
    });

  const special = isSpecialSp(formattedSpread.sp);
  const ownStatLabel = special ? 'SpA' : 'Atk';
  const ownStatVal = special ? formattedSpread.sp.spa : formattedSpread.sp.atk;
  const targetDefStatLabel = special ? 'SpD' : 'Def';

  return entries.map((t) => {
    // Built in spread_scorer.js as "${pokemon} ${move} vs. ${target}" — the literal
    // " vs. " is a safe, guaranteed split point since it's the format that produced it.
    const [attackerPart, targetName] = t.threat.split(' vs. ');
    // Field is named attacker_spreads_used for both directions in spread_scorer.js,
    // but for offensive entries it actually holds the TARGET's observed spreads.
    const target = t.attacker_spreads_used[0] || {};
    const targetDefStatVal = special ? (target.sp?.spd || 0) : (target.sp?.def || 0);

    return `${ownStatVal} ${ownStatLabel} ${attackerPart} vs. ${target.sp?.hp || 0} HP / ${targetDefStatVal} ${targetDefStatLabel} ${targetName}: `
      + `${t.weighted_damage_min}-${t.weighted_damage_max}% -- ${t.this_spread_ko} (${fmtScore(t.contribution)})`;
  });
}

function formatSkippedSectionTextEvolutionary(formattedSpread) {
  const missed = [...(formattedSpread.evolutionary_thresholds_missed || [])]
    .sort((a, b) => tierRankFromBaseline(a.baseline_ko) - tierRankFromBaseline(b.baseline_ko));
  return missed.map((t) => `✗ ${t.threat} -- ${t.baseline_ko} not improved (${t.note})`);
}

async function formatDefenseSectionText(formattedSpread, pokemonName) {
  const entries = [
    ...formattedSpread.ohko_prevented.map((e) => ({ ...e, _tier: 'OHKO' })),
    ...formattedSpread['2hko_prevented'].map((e) => ({ ...e, _tier: '2HKO' })),
    ...formattedSpread['3hko_prevented'].map((e) => ({ ...e, _tier: '3HKO' })),
  ].sort((a, b) => b.score - a.score);

  const usageRanks = await getUsageRanks([...new Set(entries.map((e) => e.attacker.toLowerCase()))]);

  return entries.map((e) => {
    const topNature = (e.attacker_nature || '').split(' / ')[0];
    const offenseStatKey = Object.keys(e.attacker_sp)[0];
    const defStatKey = 'required_def_sp' in e ? 'def' : 'spd';
    const usage = usageRanks[e.attacker.toLowerCase()];
    const usageNote = usage ? ` [#${usage.rank} usage, ${Math.round(usage.usage_percent)}% of teams]` : '';
    return `${topNature} ${e.attacker_sp[offenseStatKey]} ${TEXT_STAT_LABELS[offenseStatKey]} ${e.attacker} ${e.move} vs. ${formattedSpread.sp.hp} HP / ${formattedSpread.sp[defStatKey]} ${TEXT_STAT_LABELS[defStatKey]} ${pokemonName} -- ${e._tier} prevented (${fmtScore(e.score)})${usageNote}`;
  });
}

function formatOffenseSectionText(formattedSpread, pokemonName) {
  const entries = [
    ...formattedSpread.ohko_achieved.map((e) => ({ ...e, _tier: 'OHKO' })),
    ...formattedSpread['2hko_achieved'].map((e) => ({ ...e, _tier: '2HKO' })),
  ].sort((a, b) => b.score - a.score);

  return entries.map((e) => {
    const offenseStatKey = 'required_atk_sp' in e ? 'atk' : 'spa';
    const defStatKey = defenseStatFor(offenseStatKey);
    return `${formattedSpread.sp[offenseStatKey]} ${TEXT_STAT_LABELS[offenseStatKey]} ${pokemonName} ${e.move} vs. ${e.target_sp.hp} HP / ${e.target_sp[defStatKey]} ${TEXT_STAT_LABELS[defStatKey]} ${e.target} -- ${e._tier} (${fmtScore(e.score)})`;
  });
}

// Scarf/ability-boost profiles that are mathematically unreachable within the 66 SP
// budget (see ev_optimizer.js's toAlwaysSkippedEntry) carry their own full
// descriptive `reason` text rather than the generic "budget exhausted" framing —
// they're not competing for and losing a budget slot, they never had a shot at all.
function formatSkippedSectionText(formattedSpread) {
  return [...formattedSpread.thresholds_skipped]
    .sort((a, b) => b.score - a.score)
    .map((s) => (s.always_skipped
      ? `✗ ${s.reason}`
      : `✗ ${s.description} -- ${bareTierWord(s.threshold_type)} (${fmtScore(s.score)}, budget exhausted)`));
}

// Which of DEFENSE/OFFENSE/SPEED leads the report, per role — SKIPPED and SP NOTES
// always trail every role's list. Matches each role's own priority ordering
// elsewhere in this file (ROLE_PRIORITY_TEXT in ev_optimizer.js): the section a
// role cares about most is the one worth reading first.
const SECTION_RENDER_ORDER_BY_ROLE = {
  slow_bulky_support: ['DEFENSE', 'SPEED', 'OFFENSE'],
  slow_bulky_offense: ['DEFENSE', 'OFFENSE', 'SPEED'],
  fast_offense: ['SPEED', 'OFFENSE', 'DEFENSE'],
  fast_support: ['SPEED', 'DEFENSE', 'OFFENSE'],
};

async function buildSpreadTextBlock(formattedSpread, speedThresholdsWithNature, pokemonName, spBudget, spObservations, role, metaContext, usageRanksSorted) {
  // An evolutionary-optimized spread (X-Spread-Status: optimal) carries its own
  // real-@smogon/calc thresholds_met/missed (see ev_optimizer.js's
  // applyEvolutionaryOverride) — read DEFENSE/OFFENSE/SKIPPED from that when
  // present, since the greedy threshold pools' exact sp_investment breakpoints
  // often don't line up with an evolutionary allocation at all (that mismatch is
  // exactly what left these sections empty before this fix). Falls back to the
  // unchanged greedy formatters otherwise.
  const isEvolutionary = Array.isArray(formattedSpread.evolutionary_thresholds_met);

  const defenseLines = isEvolutionary
    ? formatDefenseSectionTextEvolutionary(formattedSpread, pokemonName, usageRanksSorted)
    : await formatDefenseSectionText(formattedSpread, pokemonName);
  const offenseLines = isEvolutionary
    ? formatOffenseSectionTextEvolutionary(formattedSpread)
    : formatOffenseSectionText(formattedSpread, pokemonName);
  const skippedLines = isEvolutionary
    ? formatSkippedSectionTextEvolutionary(formattedSpread)
    : formatSkippedSectionText(formattedSpread);

  const twPct = Math.round(metaContext.tailwind_prevalence * 100);
  const trPct = Math.round(metaContext.trickroom_prevalence * 100);

  const sectionLines = {
    DEFENSE: defenseLines,
    OFFENSE: offenseLines,
    SPEED: formatSpeedSectionText(speedThresholdsWithNature, formattedSpread.sp, pokemonName, role, metaContext),
  };
  const order = SECTION_RENDER_ORDER_BY_ROLE[role] || SECTION_RENDER_ORDER_BY_ROLE.fast_offense;

  // formatSpread() always sets this now — the ev_observations lookup is a
  // defensive fallback only, for a formattedSpread built some other way.
  const nature = formattedSpread.nature || (await getNatureDistribution(pokemonName.toLowerCase())).primaryNature || 'Hardy';

  const parts = [
    bigDivider(),
    `${pokemonName.toUpperCase()} — ${formattedSpread.label}  [${roleTitleCase(role)}]`,
    `${spBudget} SP | ${spObservations} observations | Nature: ${nature}`,
    `Priority: ${formattedSpread.role_priority}`,
    `Meta: TR on ${trPct}% of teams | Tailwind on ${twPct}% of teams`,
    bigDivider(),
    formatStatsLine(formattedSpread.final_stats, formattedSpread.sp),
    '',
  ];
  for (const key of order) {
    parts.push(sectionDivider(key), ...sectionLines[key], '');
  }
  parts.push(
    sectionDivider('SKIPPED'),
    ...skippedLines,
    '',
    sectionDivider('SP NOTES'),
    ...formattedSpread.sp_notes.map((n) => `- ${n}`),
  );
  return parts.join('\n');
}

async function buildFullTextResponse(pokemonName, spBudget, spObservations, formattedSpreads, speedThresholdsWithNature, role, metaContext) {
  const usageRanksSorted = await getAllUsageRanksSorted();
  const blocks = await Promise.all(
    formattedSpreads.map((fs) => buildSpreadTextBlock(fs, speedThresholdsWithNature, pokemonName, spBudget, spObservations, role, metaContext, usageRanksSorted))
  );
  return blocks.join('\n\n');
}

router.get('/evs/:pokemon', async (req, res, next) => {
  try {
    const pokemonLower = req.params.pokemon.toLowerCase();
    const nature = req.query.nature || null;
    const item = req.query.item || null;
    const wantsText = req.accepts(['json', 'text']) === 'text';

    // Champions has no IV mechanic (always 31, fixed) — no ?iv_hp= override exists here.
    const cacheKey = JSON.stringify({ p: pokemonLower, n: (nature || '').toLowerCase(), i: (item || '').toLowerCase(), f: wantsText ? 'text' : 'json' });
    const cached = evRecCache.get(cacheKey);
    // A cached "computing" response must NOT be served on later requests — the
    // whole point of that status is "poll again, the background evolutionary
    // search may have finished" (see ev_optimizer.js's triggerEvolutionaryComputation),
    // and this cache has a 1hr TTL. Serving it verbatim would silently freeze
    // every request at "computing" for up to an hour even after the real
    // evolutionary result was ready and cached seconds later. Only a cached
    // "optimal" response (a genuinely stable, final result) is safe to replay.
    if (cached && cached.spreadStatus === 'optimal') {
      res.set('X-Spread-Status', 'optimal');
      if (wantsText) return res.type('text/plain').send(cached.body);
      return res.json({ ...cached.body, cached: true });
    }

    const result = await optimizeEvs(req.params.pokemon, { nature, item });
    if (!result) return res.status(404).json({ error: `Pokemon not found: ${req.params.pokemon}` });
    if (result.spreads.length === 0) {
      return res.status(404).json({
        error: `No survivable SP thresholds found for ${req.params.pokemon} — the threat matrix has no data for it yet`,
      });
    }

    const speciesRow = await getSpeciesRow(pokemonLower);
    const [displayNature, threatMatrix, ownMoves] = await Promise.all([
      resolveDisplayNature(pokemonLower, nature),
      getThreatMatrix(),
      loadOwnTopMoves(pokemonLower),
    ]);

    const [defensiveThresholds, speedThresholds, offensiveThresholds] = await Promise.all([
      findDefensiveThresholds(speciesRow, threatMatrix, { nature, item }),
      findSpeedThresholds(speciesRow, threatMatrix, { nature, item }, result.role),
      findOffensiveThresholds(speciesRow, ownMoves.ownTopMoves, ownMoves.ownMovesByLower, { nature, item }),
    ]);
    const sharedThresholds = { defensiveThresholds, speedThresholds, offensiveThresholds };

    const spreads = await Promise.all(
      result.spreads.map((spread) => formatSpread(spread, speciesRow, displayNature, sharedThresholds))
    );

    res.set('X-Spread-Status', result.spread_status || 'computing');

    if (wantsText) {
      const speedThresholdsWithNature = await attachSpeedNatures(speedThresholds);
      const text = await buildFullTextResponse(
        result.pokemon, result.sp_budget, result.sp_observations, spreads, speedThresholdsWithNature, result.role, result.meta_context
      );
      // Only "optimal" is safe to cache for a full hour — see the read-side check above.
      if (result.spread_status === 'optimal') evRecCache.set(cacheKey, { body: text, spreadStatus: result.spread_status });
      return res.type('text/plain').send(text);
    }

    const body = {
      pokemon: result.pokemon,
      offensive_role: result.offensive_role,
      role: result.role,
      role_confidence: result.role_confidence,
      role_signals: result.role_signals,
      meta_context: result.meta_context,
      sp_budget: result.sp_budget,
      sp_observations: result.sp_observations,
      spread_status: result.spread_status,
      spreads,
    };

    if (result.spread_status === 'optimal') evRecCache.set(cacheKey, { body, spreadStatus: result.spread_status });
    res.json({ ...body, cached: false });
  } catch (err) {
    logger.error('GET /api/recommend/evs failed', { error: err.message });
    next(err);
  }
});

// --- /evs/:pokemon/validate --------------------------------------------------
// Scores an arbitrary caller-supplied spread with the exact same real-damage-calc
// scoreSpread() the evolutionary search itself uses (see spread_scorer.js) — no
// separate/approximate scoring path, so a score returned here is directly
// comparable to an evolutionary result's score for the same pokemon+nature.

function parseSpParam(spParam) {
  if (!spParam) return null;
  const parts = String(spParam).split('-').map(Number);
  if (parts.length !== 6 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 32)) return null;
  const sp = {};
  STAT_ORDER.forEach((key, i) => { sp[key] = parts[i]; });
  return sp;
}

router.get('/evs/:pokemon/validate', async (req, res, next) => {
  try {
    const pokemonLower = req.params.pokemon.toLowerCase();
    const nature = req.query.nature || 'Hardy';
    const sp = parseSpParam(req.query.sp);
    if (!sp) {
      return res.status(400).json({
        error: 'sp must be 6 hyphen-separated integers 0-32 in hp-atk-def-spa-spd-spe order, e.g. ?sp=32-0-14-0-20-0',
      });
    }
    const totalSp = Object.values(sp).reduce((a, b) => a + b, 0);
    if (totalSp > SP_CAP_PER_STAT * 6 || totalSp > 66) {
      return res.status(400).json({ error: `sp totals ${totalSp}, which exceeds the 66 SP budget` });
    }

    const speciesRow = await getSpeciesRow(pokemonLower);
    if (!speciesRow) return res.status(404).json({ error: `Pokemon not found: ${req.params.pokemon}` });

    const roleResult = await classifyRole(req.params.pokemon);
    const [threatMatrix, metaContext] = await Promise.all([getThreatMatrix(), getMetaContext()]);

    const scored = await scoreSpread(speciesRow, sp, nature, roleResult.role, threatMatrix, metaContext, { detailed: true });

    const evoStatus = getEvolutionaryStatus(pokemonLower, nature);
    let vsEvolutionaryRank1;
    if (evoStatus.status === 'optimal' && evoStatus.result?.spreads?.length) {
      const rank1Score = evoStatus.result.spreads[0].score;
      const diff = round(scored.score - rank1Score, 4);
      vsEvolutionaryRank1 = diff >= 0
        ? 'optimal (matches or beats evolutionary #1)'
        : `${diff} (evolutionary found better)`;
    } else {
      vsEvolutionaryRank1 = 'not yet available — GET /api/recommend/evs/:pokemon first to trigger the evolutionary search for this pokemon+nature';
    }

    res.json({
      pokemon: speciesRow.name,
      spread: sp,
      nature,
      role: roleResult.role,
      score: scored.score,
      final_stats: scored.final_stats,
      thresholds_met: scored.thresholds_met,
      thresholds_missed: scored.thresholds_missed,
      vs_evolutionary_rank1: vsEvolutionaryRank1,
    });
  } catch (err) {
    logger.error('GET /api/recommend/evs/:pokemon/validate failed', { error: err.message });
    next(err);
  }
});

function topMovesFor(moveRecData, nameLower) {
  if (!moveRecData) return [];
  // move_recommendations.json is keyed by the same base id/name train_moves.py has
  // always used — unlike synergy_matrix.json, it was never updated to prefer
  // normalizedName, so a Mega form like "swampert-mega" has no entry of its own
  // (all its appearances are folded into plain "swampert"). Fall back to
  // progressively shorter hyphenated prefixes so Mega/regional-form partners still
  // get real move data for the move+weather and type-coverage checks below — this
  // recovers move-based reasons, but NOT ability-based ones, since the `pokemon`
  // table genuinely has no Mega-form ability data to fall back to.
  let key = nameLower;
  while (key) {
    const entry = moveRecData.pokemon[key];
    if (entry) return entry.moves.slice(0, 4);
    const idx = key.lastIndexOf('-');
    if (idx === -1) break;
    key = key.slice(0, idx);
  }
  return [];
}

function blankSpeciesRow(displayName) {
  return { name: displayName, type1: null, type2: null, ability1: null, ability2: null, ability_hidden: null };
}

router.get('/synergy/:pokemon', async (req, res, next) => {
  try {
    const pokemonLower = req.params.pokemon.toLowerCase();
    const cached = synergyCache.get(pokemonLower);
    if (cached) return res.json({ ...cached, cached: true });

    const synergyData = readModelJSON('synergy_matrix.json');
    const abilityData = readModelJSON('ability_synergies.json');
    const moveRecData = readModelJSON('move_recommendations.json');
    if (!synergyData) return res.status(404).json({ error: 'Synergy model has not been trained yet' });

    const partnerScores = synergyData.scores[pokemonLower];
    if (!partnerScores || Object.keys(partnerScores).length === 0) {
      return res.status(404).json({ error: `No synergy data for ${req.params.pokemon}` });
    }

    const { rows } = await pool.query('SELECT name, type1, type2, ability1, ability2, ability_hidden FROM pokemon');
    const rowsByLower = {};
    for (const row of rows) rowsByLower[row.name.toLowerCase()] = row;

    const entries = Object.entries(partnerScores).map(([partner, score]) => ({ partner, score }));
    const strong = [...entries].sort((a, b) => b.score - a.score).slice(0, 5);
    const weak = [...entries].sort((a, b) => a.score - b.score).slice(0, 3);

    // Batch-fetch move type/category/power for self + every partner's top moves
    // (needed by generateSynergyReasons for the move+weather and type-coverage checks).
    const selfMoves = topMovesFor(moveRecData, pokemonLower);
    const partnerMovesByKey = {};
    for (const { partner } of [...strong, ...weak]) partnerMovesByKey[partner] = topMovesFor(moveRecData, partner);

    const allMoveNames = [...new Set(
      [...selfMoves, ...Object.values(partnerMovesByKey).flat()].map((m) => m.move.toLowerCase())
    )];
    const { rows: moveRows } = allMoveNames.length
      ? await pool.query('SELECT * FROM moves WHERE LOWER(name) = ANY($1)', [allMoveNames])
      : { rows: [] };
    const movesByLower = Object.fromEntries(moveRows.map((m) => [m.name.toLowerCase(), m]));

    function enrichMoves(moveList) {
      return moveList.map((m) => {
        const mv = movesByLower[m.move.toLowerCase()];
        return { move: m.move, confidence: m.confidence, type: mv?.type, category: mv?.category, power: mv?.power };
      });
    }

    const pokemonRow = rowsByLower[pokemonLower] || blankSpeciesRow(req.params.pokemon);
    const enrichedSelfMoves = enrichMoves(selfMoves);

    function annotate(list) {
      return list.map(({ partner, score }) => {
        const partnerRow = rowsByLower[partner] || blankSpeciesRow(titleCase(partner));
        const reasons = generateSynergyReasons({
          pokemonName: pokemonRow.name,
          pokemonRow,
          pokemonMoves: enrichedSelfMoves,
          partnerName: partnerRow.name,
          partnerRow,
          partnerMoves: enrichMoves(partnerMovesByKey[partner] || []),
          abilityRules: abilityData?.rules || [],
          score,
        });
        return { partner: partnerRow.name, score, reasons };
      });
    }

    const body = {
      pokemon: req.params.pokemon,
      strong_partners: annotate(strong),
      weak_partners: annotate(weak),
    };

    synergyCache.set(pokemonLower, body);
    res.json({ ...body, cached: false });
  } catch (err) {
    logger.error('GET /api/recommend/synergy failed', { error: err.message });
    next(err);
  }
});

router.post('/team', async (req, res, next) => {
  try {
    const { team } = req.body || {};
    if (!Array.isArray(team) || team.length < 1 || team.length > 5) {
      return res.status(400).json({ error: 'team must be an array of 1-5 Pokemon names' });
    }

    const synergyData = readModelJSON('synergy_matrix.json');
    if (!synergyData) return res.status(404).json({ error: 'Synergy model has not been trained yet' });

    const teamLower = team.map((n) => String(n).toLowerCase());
    const { rows } = await pool.query('SELECT name, type1, type2 FROM pokemon');
    const rowsByLower = {};
    for (const row of rows) rowsByLower[row.name.toLowerCase()] = row;

    const teamWeaknessCounts = {};
    for (const name of teamLower) {
      const row = rowsByLower[name];
      if (!row) continue;
      for (const t of Object.keys(weaknessesOf([row.type1, row.type2]))) {
        teamWeaknessCounts[t] = (teamWeaknessCounts[t] || 0) + 1;
      }
    }
    const sharedWeaknesses = Object.entries(teamWeaknessCounts)
      .filter(([, count]) => count >= 2)
      .map(([t]) => t);

    const candidates = [];
    for (const [name, partnerScores] of Object.entries(synergyData.scores)) {
      if (teamLower.includes(name)) continue;
      const row = rowsByLower[name];
      if (!row) continue;

      const relevantScores = teamLower.map((t) => partnerScores[t]).filter((s) => s !== undefined);
      if (relevantScores.length === 0) continue;

      const avgSynergy = relevantScores.reduce((a, b) => a + b, 0) / relevantScores.length;
      const resistances = resistancesOf([row.type1, row.type2]);
      const coveredTypes = sharedWeaknesses.filter((t) => resistances[t] !== undefined);
      const score = avgSynergy * 0.7 + coveredTypes.length * 0.3;

      const reasonParts = [];
      if (avgSynergy >= 1.5) reasonParts.push(`strong tournament synergy with current team (${round(avgSynergy, 2)}x)`);
      if (coveredTypes.length > 0) reasonParts.push(`covers shared weakness to ${coveredTypes.join('/')}`);
      if (reasonParts.length === 0) reasonParts.push(`observed teammate synergy ${round(avgSynergy, 2)}x`);

      candidates.push({
        pokemon: row.name,
        synergy_score: round(avgSynergy, 2),
        _score: score,
        reasoning: reasonParts.join('; '),
      });
    }

    candidates.sort((a, b) => b._score - a._score);
    const suggestions = candidates.slice(0, 5).map(({ _score, ...rest }) => rest);

    res.json({ team, suggestions });
  } catch (err) {
    logger.error('POST /api/recommend/team failed', { error: err.message });
    next(err);
  }
});

module.exports = router;
// Dual-export pattern already used by team.js's parseShowdownTeam — the router
// itself is unaffected, this just lets other modules require the underlying
// function without an internal HTTP round-trip.
module.exports.getMoveRecommendationsFor = getMoveRecommendationsFor;
