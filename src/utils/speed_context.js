const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { getSpeciesRow, getCommonSpeedTiers, getNatureDistribution } = require('./ev_observations');
const { calcStat, natureMultiplierFor, SP_CAP_PER_STAT } = require('./stat_formula');

const MODELS_DIR = path.join(__dirname, '..', 'ml', 'models');
const SCARF_MULTIPLIER = 1.5;
const ABILITY_BOOST_MULTIPLIER = 2;
const SCARF_FREQUENCY_THRESHOLD = 0.20;
const CONDITION_PREVALENCE_THRESHOLD = 0.20;
const ABILITY_PROFILE_FREQUENCY_THRESHOLD = 0.10;
const TOP_PARTNERS_CONSIDERED = 20;

// Fixed VGC mechanic vocabulary (ability name -> its internal boost key) — same
// category as synergy_reasons.js's WEATHER_SETTERS table, not Pokemon-specific.
const ABILITY_BOOST_MAP = {
  'swift swim': 'swift_swim',
  chlorophyll: 'chlorophyll',
  'sand rush': 'sand_rush',
  'slush rush': 'slush_rush',
  'speed boost': 'speed_boost',
};

// Casual display names for the weather/field condition each boost ability keys off
// of, sourced from ability_synergies.json's own `condition` field (e.g. "Rain Dance")
// — this just maps that fixed vocabulary to shorter display text.
const CONDITION_DISPLAY_LABELS = {
  'rain dance': 'rain',
  'sunny day': 'sun',
  sandstorm: 'sand',
  snow: 'snow',
};

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function readJSON(filename) {
  const filePath = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// --- Tailwind / Trick Room meta prevalence -----------------------------------------

let metaCache = null;

async function buildMetaContext() {
  const totalRes = await pool.query('SELECT COUNT(*) as n FROM tournament_teams');
  const totalTeams = parseInt(totalRes.rows[0].n, 10);
  if (totalTeams === 0) {
    return { tailwind_prevalence: 0, trickroom_prevalence: 0, tailwind_teams: 0, trickroom_teams: 0, total_teams: 0 };
  }

  const [twRes, trRes] = await Promise.all([
    pool.query(`
      SELECT COUNT(*) as n FROM tournament_teams t
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.pokemon) p WHERE p->'attacks' ? 'Tailwind')
    `),
    pool.query(`
      SELECT COUNT(*) as n FROM tournament_teams t
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.pokemon) p WHERE p->'attacks' ? 'Trick Room')
    `),
  ]);

  const tailwindTeams = parseInt(twRes.rows[0].n, 10);
  const trickroomTeams = parseInt(trRes.rows[0].n, 10);

  return {
    tailwind_prevalence: round(tailwindTeams / totalTeams),
    trickroom_prevalence: round(trickroomTeams / totalTeams),
    tailwind_teams: tailwindTeams,
    trickroom_teams: trickroomTeams,
    total_teams: totalTeams,
  };
}

async function getMetaContext({ forceRefresh = false } = {}) {
  if (forceRefresh || !metaCache) {
    metaCache = await buildMetaContext();
  }
  return metaCache;
}

// --- Scarf / ability speed modifiers -----------------------------------------------

// ev_observations has no `ability` column (verified against schema.sql) — it only
// ever stores nature/item/sp, since that's all a pokepaste's "EVs:" line carries.
// Ability frequency can only come from tournament_teams' pokemon JSONB instead — a
// separate, larger sample that isn't row-joined to ev_observations' SP data (the two
// scrapers don't share a per-mon key), so this is an independent measurement, not a
// joint distribution with item/SP.
async function getAbilityFrequency(pokemonLower) {
  const { rows } = await pool.query(
    `SELECT p->>'ability' as ability, COUNT(*) as count
     FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
     WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) = $1 AND p->>'ability' IS NOT NULL
     GROUP BY p->>'ability' ORDER BY count DESC`,
    [pokemonLower]
  );
  const total = rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
  if (total === 0) return [];
  return rows.map((r) => ({
    ability: r.ability,
    count: parseInt(r.count, 10),
    frequency: round(parseInt(r.count, 10) / total, 4),
  }));
}

async function findSetterSpeciesForAbility(boosterAbility, synergyRules) {
  const rule = synergyRules.find((r) => r.booster_ability.toLowerCase() === boosterAbility.toLowerCase());
  if (!rule) return null;
  const { rows } = await pool.query(
    `SELECT name FROM pokemon WHERE LOWER(ability1) = LOWER($1) OR LOWER(ability2) = LOWER($1) OR LOWER(ability_hidden) = LOWER($1)`,
    [rule.setter_ability]
  );
  return {
    setterAbility: rule.setter_ability,
    condition: rule.condition,
    setterSpeciesLower: rows.map((r) => r.name.toLowerCase()),
  };
}

// Choice Scarf / weather-ability boosts multiply the attacker's FINAL Speed stat
// (nature + SP applied), never the raw base stat — Basculegion's base Speed is 78,
// but a real Scarf set commonly runs ~130 final Speed already, and 1.5x of THAT
// (not 1.5x of 78) is what a defender actually has to outrun. Prefers the attacker's
// most common observed final Speed from ev_observations (getCommonSpeedTiers is
// already sorted by observation frequency descending); falls back to max SP (32
// Spe) at their most common observed nature via calcStat() when no observations
// exist at all for this species.
async function getMostCommonFinalSpeed(pokemonLower, speciesRow) {
  const { tiers } = await getCommonSpeedTiers(pokemonLower);
  if (tiers.length > 0 && tiers[0].speed_stat !== null) {
    return tiers[0].speed_stat;
  }
  const natureDist = await getNatureDistribution(pokemonLower);
  const nature = natureDist.natures?.[0]?.nature || natureDist.primaryNature || 'Hardy';
  return calcStat(speciesRow.spe, SP_CAP_PER_STAT, natureMultiplierFor(nature, 'spe'), false);
}

async function getSpeedModifiers(pokemonName) {
  const pokemonLower = pokemonName.toLowerCase();
  const speciesRow = await getSpeciesRow(pokemonLower);
  if (!speciesRow) return null;

  const { rows: itemRows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE item = 'Choice Scarf') as scarf_count, COUNT(*) as total
     FROM ev_observations WHERE LOWER(normalized_name) = $1`,
    [pokemonLower]
  );
  const total = parseInt(itemRows[0].total, 10);
  const scarfFrequency = total > 0 ? parseInt(itemRows[0].scarf_count, 10) / total : 0;
  const scarfCommon = scarfFrequency >= SCARF_FREQUENCY_THRESHOLD;

  const mostCommonFinalSpeed = await getMostCommonFinalSpeed(pokemonLower, speciesRow);
  const effectiveSpeedScarf = Math.floor(mostCommonFinalSpeed * SCARF_MULTIPLIER);

  let abilityBoost = null;
  const abilities = [speciesRow.ability1, speciesRow.ability2, speciesRow.ability_hidden].filter(Boolean);
  for (const ab of abilities) {
    const key = ab.toLowerCase();
    if (ABILITY_BOOST_MAP[key]) {
      abilityBoost = ABILITY_BOOST_MAP[key];
      break;
    }
  }

  let conditionCommon = false;
  let conditionLabel = null;
  let conditionSetterPrevalence = 0;
  if (abilityBoost && abilityBoost !== 'speed_boost') {
    // Speed Boost is self-triggered (no teammate/weather setter needed), so it has no
    // co-occurrence condition to check — it just never sets condition_common.
    const synergy = readJSON('synergy_matrix.json');
    const abilitySynergies = readJSON('ability_synergies.json');
    const partnerScores = synergy?.scores[pokemonLower] || {};
    const topPartners = Object.entries(partnerScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_PARTNERS_CONSIDERED)
      .map(([name]) => name);

    const boosterAbilityName = Object.keys(ABILITY_BOOST_MAP).find((k) => ABILITY_BOOST_MAP[k] === abilityBoost);
    const setterInfo = await findSetterSpeciesForAbility(boosterAbilityName, abilitySynergies?.rules || []);
    if (setterInfo) {
      conditionLabel = CONDITION_DISPLAY_LABELS[setterInfo.condition.toLowerCase()] || setterInfo.condition;
      const setterInTop20 = topPartners.some((p) => setterInfo.setterSpeciesLower.includes(p));
      if (setterInTop20) {
        const { rows: usageRows } = await pool.query(
          `SELECT usage_percent FROM usage_stats WHERE LOWER(pokemon_name) = ANY($1) ORDER BY usage_percent DESC LIMIT 1`,
          [setterInfo.setterSpeciesLower]
        );
        conditionSetterPrevalence = usageRows.length ? parseFloat(usageRows[0].usage_percent) / 100 : 0;
        conditionCommon = conditionSetterPrevalence >= CONDITION_PREVALENCE_THRESHOLD;
      }
    }
  }

  // How often this species is actually built around its boost ability at all (vs.
  // e.g. Adaptability) — a separate, independent measurement from tournament_teams
  // (see getAbilityFrequency), since ev_observations has no ability column to check
  // this against the item/SP data directly.
  const abilityDistribution = await getAbilityFrequency(pokemonLower);
  let abilityBoostFrequency = 0;
  if (abilityBoost) {
    const boosterAbilityName = Object.keys(ABILITY_BOOST_MAP).find((k) => ABILITY_BOOST_MAP[k] === abilityBoost);
    const match = abilityDistribution.find((a) => a.ability.toLowerCase() === boosterAbilityName);
    abilityBoostFrequency = match ? match.frequency : 0;
  }

  const effectiveSpeedBoosted = abilityBoost ? Math.floor(mostCommonFinalSpeed * ABILITY_BOOST_MULTIPLIER) : null;

  return {
    scarf_common: scarfCommon,
    scarf_frequency: round(scarfFrequency),
    ability_boost: abilityBoost,
    ability_boost_frequency: round(abilityBoostFrequency),
    ability_distribution: abilityDistribution,
    condition_common: conditionCommon,
    condition_label: conditionLabel,
    condition_setter_prevalence: round(conditionSetterPrevalence),
    effective_speed_scarf: effectiveSpeedScarf,
    effective_speed_boosted: effectiveSpeedBoosted,
  };
}

// --- Trick Room speed tiers ---------------------------------------------------------
// Under Trick Room, slower Pokemon move first — a Pokemon is "relevant" (i.e. moves
// before a given opponent) when its speed is LOWER, the inverse of normal speed order.
function trickroomRelevant(pokemonSpeed, opponentSpeed) {
  return pokemonSpeed < opponentSpeed;
}

module.exports = {
  getMetaContext,
  getSpeedModifiers,
  getAbilityFrequency,
  trickroomRelevant,
  SCARF_FREQUENCY_THRESHOLD,
  CONDITION_PREVALENCE_THRESHOLD,
  ABILITY_PROFILE_FREQUENCY_THRESHOLD,
};
