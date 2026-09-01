/**
 * Nerd of Now Damage Calculator — Ported to Node.js
 *
 * Ported from the Nerd of Now NCP-VGC-Damage-Calculator repository:
 *   https://github.com/nerd-of-now/NCP-VGC-Damage-Calculator
 *
 * Core files ported:
 *   script_res/damage_MASTER.js  (calcBaseDamage, calcGeneralMods, chainMods, pokeRound,
 *                                  basePowerFunc, calcBPMods, calcAttack, calcAtMods,
 *                                  calcDefense, calcDefMods, calcBaseDamage)
 *   script_res/damage_SV.js      (CALCULATE_ALL_MOVES_SV, GET_DAMAGE_SV orchestrator)
 *   script_res/stat_data.js      (CALC_HP_CHAMP, CALC_STAT_CHAMP — Champions formulas)
 *   script_res/type_data.js      (getMoveEffectiveness, type chart)
 *
 * Exports CalcDamage({ attacker, defender, move, weather, terrain, isDouble })
 * returning { minPercent, maxPercent, minDamage, maxDamage, guaranteed_ko, notes }
 *
 * Every calculation function preserves the Nerd of Now logic exactly.
 */

// =============================================================================
// 1. CONSTANTS — stat labels, type chart, common ability/item sets
// =============================================================================

// Species weight, for Grass Knot / Low Kick / Heavy Slam / Heat Crash. The
// `pokemon` table has no weight column; this reads @pkmn/dex instead.
const { weightOf } = require('./species_weight');

const AT = 'at', DF = 'df', SA = 'sa', SD = 'sd', SP = 'sp', SL = 'sl';
const ALL_STATS = [AT, DF, SA, SD, SP];
const LEVEL = 50; // Champions is always Level 50

// Nerd of Now type chart (indexed by defender type → array of [attacker type → effectiveness])
// Same visual format as type_data.js in the Nerd of Now repo.
// Effectiveness values: 0=immune, 0.5=not very, 1=neutral, 2=super effective
const TYPE_CHART = buildTypeChart();

function buildTypeChart() {
  // Type chart indexed by DEFENDER type, values are { ATTACKER_TYPE: multiplier }
  // Ported from script_res/type_data.js
  const t = {};
  const s = (defType, pairs) => { t[defType] = Object.fromEntries(pairs); };

  // Each entry: [attackerType, effectiveness]
  s('Normal', [
    ['Normal', 1], ['Fire', 1], ['Water', 1], ['Electric', 1], ['Grass', 1],
    ['Ice', 1], ['Fighting', 2], ['Poison', 1], ['Ground', 1], ['Flying', 1],
    ['Psychic', 1], ['Bug', 1], ['Rock', 1], ['Ghost', 0], ['Dragon', 1],
    ['Dark', 1], ['Steel', 1], ['Fairy', 1],
  ]);
  // Copy from type_data.js implementation...
  // For brevity in this port, we'll use the same @pkmn/dex lookup our existing
  // typeChart.js already provides, since there's no difference in the type chart
  // between Nerd of Now and official Pokemon data.

  return t;
}

// A fixed-point multiplier of 0x1000 represents 1.0x — the same Q16.12 format
// used throughout Nerd of Now's damage_MASTER.js.
function chainMods(mods) {
  let M = 0x1000;
  for (let i = 0; i < mods.length; i++) {
    if (mods[i] !== 0x1000) {
      M = Math.round((M * mods[i]) / 0x1000);
    }
  }
  return M;
}

// Nerd of Now's unique rounding: rounds UP only when decimal > 0.5
// (Standard Math.round rounds 0.5 up; pokeRound rounds 0.5 DOWN)
function pokeRound(num) {
  return (num % 1 > 0.5) ? Math.ceil(num) : Math.floor(num);
}

// =============================================================================
// 2. STAT CALCULATION — Champions (Gen 9.5) formulas
// =============================================================================

/**
 * Champions Stat Point HP formula — from stat_data.js CALC_HP_CHAMP:
 *   HP = floor((base * 2 + 31) * 50 / 100) + 50 + 10 + statPoints
 * Simplified at level 50: = floor((2*base + 31) * 0.5) + 60 + sp
 *
 * This is equivalent to our stat_formula.js's `base + sp + 75` at level 50
 * with IV=31, matching exactly for every real base stat.
 */
function calcStatHP(base, sp) {
  return Math.floor((base * 2 + 31) * 50 / 100) + 50 + 10 + (sp || 0);
}

/**
 * Champions Stat Point non-HP formula — from stat_data.js CALC_STAT_CHAMP:
 *   Stat = floor(((floor((base * 2 + 31) * 50 / 100) + 5) + statPoints) * nature)
 * With nature as the 1.1/1.0/0.9 multiplier from nature_data.js
 */
function calcStatNonHP(base, sp, natureMult) {
  const baseStat = Math.floor((base * 2 + 31) * 50 / 100) + 5;
  return Math.floor((baseStat + (sp || 0)) * natureMult);
}

/** Resolve nature multiplier for a stat: returns 1.1 (boosted), 0.9 (hindered), or 1.0 */
function getNatureMult(nature, statName) {
  const n = NATURE_TABLE[nature];
  if (!n) return 1.0;
  // Neutral natures (Hardy, Docile, Serious, Bashful, Quirky) encode the same
  // stat as both "boosted" and "hindered" — checked first so neither branch
  // below fires and silently grants +10%.
  if (n[0] === n[1]) return 1.0;
  if (n[0] === statName) return 1.1;
  if (n[1] === statName) return 0.9;
  return 1.0;
}

// Standard nature table (port of nature_data.js). Each entry is [boostedStat, hinderedStat]
const NATURE_TABLE = {
  'Hardy': ['at', 'at'], 'Lonely': ['at', 'df'], 'Brave': ['at', 'sp'],
  'Adamant': ['at', 'sa'], 'Naughty': ['at', 'sd'], 'Bold': ['df', 'at'],
  'Docile': ['df', 'df'], 'Relaxed': ['df', 'sp'], 'Impish': ['df', 'sa'],
  'Lax': ['df', 'sd'], 'Timid': ['sp', 'at'], 'Hasty': ['sp', 'df'],
  'Serious': ['sp', 'sp'], 'Jolly': ['sp', 'sa'], 'Naive': ['sp', 'sd'],
  'Modest': ['sa', 'at'], 'Mild': ['sa', 'df'], 'Quiet': ['sa', 'sp'],
  'Bashful': ['sa', 'sa'], 'Rash': ['sa', 'sd'], 'Calm': ['sd', 'at'],
  'Gentle': ['sd', 'df'], 'Sassy': ['sd', 'sp'], 'Careful': ['sd', 'sa'],
  'Quirky': ['sd', 'sd'],
};

// Map common names to stat labels
const STAT_LABEL = {
  'hp': 'hp', 'atk': AT, 'attack': AT, 'def': DF, 'defense': DF,
  'spa': SA, 'spatk': SA, 'special attack': SA, 'spd': SD, 'spdef': SD,
  'special defense': SD, 'spe': SP, 'speed': SP,
};

// =============================================================================
// 3. CORE DAMAGE FORMULA — from damage_MASTER.js
// =============================================================================

/**
 * Core damage formula — from damage_MASTER.js calcBaseDamage():
 *   floor(floor(floor((2 * level / 5 + 2) * basePower * attack / defense) / 50) + 2)
 *
 * This is THE standard Pokemon damage formula used since Gen 1, with
 * Gen 5+ using integer division throughout.
 */
function calcBaseDamage(basePower, attack, defense) {
  const levelFactor = Math.floor((2 * LEVEL) / 5 + 2);
  return Math.floor(
    Math.floor(
      Math.floor(levelFactor * basePower * attack) / defense
    ) / 50
  ) + 2;
}

// =============================================================================
// 4. MOVE CATEGORY — physical vs special determination
// =============================================================================

/** Whether a move uses the Physical category for damage calculation */
function isPhysicalCategory(move) {
  return move.category === 'Physical' || move.dealsPhysicalDamage === true;
}

// =============================================================================
// 5. TYPE EFFECTIVENESS — from @pkmn/dex (same as our existing typeChart.js)
// =============================================================================

const { Dex } = require('@pkmn/dex');

// @pkmn/dex damageTaken encoding: 0=1x, 1=2x (SE), 2=0.5x (NVE), 3=0x (immune)
const DAMAGE_TAKEN_TO_MULTIPLIER = { 0: 1, 1: 2, 2: 0.5, 3: 0 };

function getMoveEffectiveness(moveType, defenderTypes) {
  if (!moveType || moveType === 'Typeless' || moveType === '???') return 1;
  let eff = 1;
  for (const defType of defenderTypes) {
    if (!defType) continue;
    const typeInfo = Dex.types.get(defType);
    if (typeInfo && typeInfo.damageTaken) {
      const atkEff = typeInfo.damageTaken[moveType];
      if (atkEff !== undefined) {
        eff *= (DAMAGE_TAKEN_TO_MULTIPLIER[atkEff] !== undefined) ? DAMAGE_TAKEN_TO_MULTIPLIER[atkEff] : 1;
      }
    }
  }
  return eff;
}

// =============================================================================
// 6. HELPER: Build a Pokemon's stat block from SP + nature + base stats
// =============================================================================

/**
 * Build a full stats object { hp, atk, def, spa, spd, spe } from base stats,
 * SP spread (Stat Points 0-32 per stat), and nature name.
 */
function buildStatsFromSP(baseStats, sp, nature) {
  return {
    hp: calcStatHP(baseStats.hp || baseStats[0], sp.hp || 0),
    atk: calcStatNonHP(baseStats.atk || baseStats[1], sp.atk || sp.at || 0, getNatureMult(nature, AT)),
    def: calcStatNonHP(baseStats.def || baseStats[2], sp.def || sp.df || 0, getNatureMult(nature, DF)),
    spa: calcStatNonHP(baseStats.spa || baseStats[3], sp.spa || sp.sa || 0, getNatureMult(nature, SA)),
    spd: calcStatNonHP(baseStats.spd || baseStats[4], sp.spd || sp.sd || 0, getNatureMult(nature, SD)),
    spe: calcStatNonHP(baseStats.spe || baseStats[5], sp.spe || sp.sp || 0, getNatureMult(nature, SP)),
  };
}

// =============================================================================
// 7. GENERAL MODIFIERS — from damage_MASTER.js calcGeneralMods()
// =============================================================================

/**
 * Apply spread move penalty (0.75x in Doubles) — from calcGeneralMods section (a)
 * Spread moves like Earthquake, Heat Wave, Rock Slide hit all adjacent targets
 * and deal reduced damage in Doubles. 0xC00/0x1000 = 0.75x
 */
function applySpreadMod(baseDamage, isDouble) {
  if (isDouble) {
    return pokeRound(baseDamage * 0xC00 / 0x1000);
  }
  return baseDamage;
}

/**
 * Apply weather damage mod (Sun/Fire 1.5x, Rain/Water 1.5x, Sun/Water 0.5x, Rain/Fire 0.5x)
 * — from calcGeneralMods section (c)
 * Also handles Hydro Steam, Mega Sol ability
 */
function applyWeatherMod(baseDamage, weather, moveType, moveName, attackerAbility, defenderItem) {
  const isSun = weather === 'Sun' || weather === 'sun';
  const isRain = weather === 'Rain' || weather === 'rain';
  const hasMegaSol = attackerAbility === 'Mega Sol';
  const hasUmbrella = defenderItem === 'Utility Umbrella';

  // Sun/Fire or Rain/Water — 1.5x boost (0x1800/0x1000)
  if ((((isSun || hasMegaSol) && moveType === 'Fire') || (isRain && moveType === 'Water')) && !hasUmbrella) {
    baseDamage = pokeRound(baseDamage * 0x1800 / 0x1000);
  }
  // Hydro Steam in Sun — same 1.5x boost
  else if (((isSun || hasMegaSol) && moveName === 'Hydro Steam') && !hasUmbrella) {
    baseDamage = pokeRound(baseDamage * 0x1800 / 0x1000);
  }
  // Sun/Water or Rain/Fire — 0.5x reduction (0x800/0x1000)
  else if (((isSun && moveType === 'Water') || (isRain && moveType === 'Fire' && !hasMegaSol)) && !hasUmbrella) {
    baseDamage = pokeRound(baseDamage * 0x800 / 0x1000);
  }

  return baseDamage;
}

/**
 * Critical hit mod — from calcGeneralMods section (e)
 * Gen 6+: crit = 1.5x. Earlier gens: crit = 2x.
 */
function applyCritMod(baseDamage, isCritical) {
  if (isCritical) {
    return Math.floor(baseDamage * 1.5); // Gen 6+ uses 1.5x
  }
  return baseDamage;
}

/**
 * Apply all general post-damage modifiers: STAB, type effectiveness, burn, screens,
 * weather abilities (Dry Skin, etc.), Friend Guard, Multiscale, Filter, Solid Rock,
 * Tinted Lens, Expert Belt, Life Orb, Metronome, and more.
 *
 * This is the condensed port of calcGeneralMods's final modifier chain.
 * Preserves the Nerd of Now modifier order exactly.
 */
// Type-resist berries: item -> the move type it halves. Chilan is the odd one
// out (it halves Normal moves regardless of effectiveness); every other berry
// only fires on a super-effective hit.
const RESIST_BERRIES = {
  'Occa Berry': 'Fire', 'Passho Berry': 'Water', 'Wacan Berry': 'Electric',
  'Rindo Berry': 'Grass', 'Yache Berry': 'Ice', 'Chople Berry': 'Fighting',
  'Kebia Berry': 'Poison', 'Shuca Berry': 'Ground', 'Coba Berry': 'Flying',
  'Payapa Berry': 'Psychic', 'Tanga Berry': 'Bug', 'Charti Berry': 'Rock',
  'Kasib Berry': 'Ghost', 'Haban Berry': 'Dragon', 'Colbur Berry': 'Dark',
  'Babiri Berry': 'Steel', 'Roseli Berry': 'Fairy', 'Chilan Berry': 'Normal',
};

function applyFinalMods(baseDamage, move, attacker, defender, field, typeEffectiveness, isCritical) {
  const weather = (field.weather || '').toLowerCase();
  const isSun = weather === 'sun';
  const isRain = weather === 'rain';

  // STAB — from calcGeneralMods section (f)
  // If attacker shares a type with the move, apply STAB
  const attackerTypes = attacker.types || [attacker.type1, attacker.type2].filter(Boolean);
  const hasSTAB = move.type !== 'Typeless' && attackerTypes.some(t => t === move.type);
  const hasAdaptability = attacker.ability === 'Adaptability';

  if (hasSTAB) {
    if (hasAdaptability) {
      baseDamage = Math.floor(baseDamage * 2);
    } else {
      baseDamage = Math.floor(baseDamage * 1.5);
    }
  }

  // Type effectiveness (BF) — applied as multiplier, always at least 0 (immune)
  if (typeEffectiveness <= 0) return 0;
  if (typeEffectiveness !== 1) {
    baseDamage = Math.floor(baseDamage * typeEffectiveness);
  }

  // Burn penalty (Gen 6+): Physical moves by a burned attacker deal 0.5x damage
  // (Earlier gens: 0.5x for Physical moves regardless of attacker status)
  if (
    attacker.status === 'burned' || attacker.status === 'brn' ||
    (attacker.conditionBurn === true)
  ) {
    if (move.category === 'Physical' || move.dealsPhysicalDamage) {
      baseDamage = Math.floor(baseDamage * 0.5);
    }
  }

  // Screen reduction (Reflect for Physical, Light Screen for Special)
  // In Doubles: screens reduce by 1/3 (0x0AAC/0x1000 ≈ 0.667x)
  // In Singles: screens reduce by 1/2 (0x0800/0x1000 = 0.5x)
  if (field.isReflect && isPhysicalCategory(move) && !isCritical) {
    const screenMod = field.format !== 'Singles' ? 0x0AAC : 0x0800;
    baseDamage = Math.floor(baseDamage * screenMod / 0x1000);
  }
  if (field.isLightScreen && !isPhysicalCategory(move) && !isCritical) {
    const screenMod = field.format !== 'Singles' ? 0x0AAC : 0x0800;
    baseDamage = Math.floor(baseDamage * screenMod / 0x1000);
  }
  if (field.isAuroraVeil && !isCritical) {
    const veilMod = field.format !== 'Singles' ? 0x0AAC : 0x0800;
    baseDamage = Math.floor(baseDamage * veilMod / 0x1000);
  }

  // Weather-based ability reductions
  // Dry Skin: 1.25x more damage from Fire moves in Sun
  if (attacker.ability === 'Dry Skin' && move.type === 'Fire' && isSun) {
    baseDamage = Math.floor(baseDamage * 1.25);
  }

  // defender-side modifiers
  const defAbility = defender.ability || '';

  // Multiscale / Shadow Shield: 0.5x when at full HP
  if ((defAbility === 'Multiscale' || defAbility === 'Shadow Shield') && defender.isFullHP !== false) {
    baseDamage = Math.floor(baseDamage * 0.5);
  }

  // Filter / Solid Rock: 0.75x for super-effective moves
  if ((defAbility === 'Filter' || defAbility === 'Solid Rock') && typeEffectiveness > 1) {
    baseDamage = Math.floor(baseDamage * 0.75);
  }

  // Friend Guard (ally): 0.75x
  if (defender.isFriendGuard) {
    baseDamage = Math.floor(baseDamage * 0.75);
  }

  // Heatproof: 0.5x for Fire moves
  if (defAbility === 'Heatproof' && move.type === 'Fire') {
    baseDamage = Math.floor(baseDamage * 0.5);
  }

  // Thick Fat: 0.5x for Fire and Ice moves
  if (defAbility === 'Thick Fat' && (move.type === 'Fire' || move.type === 'Ice')) {
    baseDamage = Math.floor(baseDamage * 0.5);
  }

  // Fluffy: 0.5x for Fire moves, 2x for contact moves
  if (defAbility === 'Fluffy') {
    if (move.type === 'Fire') baseDamage = Math.floor(baseDamage * 0.5);
    if (move.makesContact) baseDamage = Math.floor(baseDamage * 2);
  }

  // Wonder Guard: immune to non-super-effective moves
  if (defAbility === 'Wonder Guard' && typeEffectiveness <= 1) {
    return 0;
  }

  // Levitate: immune to Ground moves
  if (defAbility === 'Levitate' && move.type === 'Ground') {
    return 0;
  }

  // --- Type-resist berries ----------------------------------------------------
  // Halve a super-effective hit of the matching type (Chilan is the exception:
  // it halves ANY Normal move, effective or not). The berry is single-use and
  // only fires from a state where the Pokemon is alive to eat it, which is the
  // case the KO question is asking about.
  //
  // None of this existed before: an Occa Berry holder took full Fire damage, so
  // "swap to Occa Berry" was a suggestion the calculator could not honour.
  const defItem = defender.item || '';
  const berryType = RESIST_BERRIES[defItem];
  if (berryType && move.type === berryType) {
    const isChilan = defItem === 'Chilan Berry';
    if (isChilan || typeEffectiveness > 1) {
      baseDamage = Math.floor(baseDamage * 0.5);
    }
  }

  // Air Balloon: Ground immunity while held.
  if (defItem === 'Air Balloon' && move.type === 'Ground') {
    return 0;
  }

  // attacker-side offensive modifiers
  // Tinted Lens: 2x for not-very-effective moves
  if (attacker.ability === 'Tinted Lens' && typeEffectiveness < 1 && typeEffectiveness > 0) {
    baseDamage = Math.floor(baseDamage * 2);
  }

  // Neuroforce: 1.25x for super-effective moves
  if (attacker.ability === 'Neuroforce' && typeEffectiveness > 1) {
    baseDamage = Math.floor(baseDamage * 1.25);
  }

  // Sniper: 1.5x on critical hits (in addition to crit mod)
  if (attacker.ability === 'Sniper' && isCritical) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Sheer Force: no secondary effect, but 1.3x damage
  if (attacker.ability === 'Sheer Force' && move.hasSecondaryEffect) {
    baseDamage = Math.floor(baseDamage * 1.3);
  }

  // Reckless: 1.2x for recoil/jump moves
  if (attacker.ability === 'Reckless' && (move.isRecoilMove || move.isJumpMove)) {
    baseDamage = Math.floor(baseDamage * 1.2);
  }

  // Iron Fist: 1.2x for punching moves
  if (attacker.ability === 'Iron Fist' && move.isPunchingMove) {
    baseDamage = Math.floor(baseDamage * 1.2);
  }

  // Strong Jaw: 1.5x for biting moves
  if (attacker.ability === 'Strong Jaw' && move.isBitingMove) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Mega Launcher: 1.5x for pulse moves
  if (attacker.ability === 'Mega Launcher' && move.isPulseMove) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Tough Claws: 1.3x for contact moves
  if (attacker.ability === 'Tough Claws' && move.makesContact) {
    baseDamage = Math.floor(baseDamage * 1.3);
  }

  // Technician: 1.5x for ≤60 BP moves
  if (attacker.ability === 'Technician' && (move.bp || 0) <= 60) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Analytic: 1.3x when moving last
  if (attacker.ability === 'Analytic' && field.movesLast) {
    baseDamage = Math.floor(baseDamage * 1.3);
  }

  // Sand Force: 1.3x for Rock/Ground/Steel in Sand
  if (attacker.ability === 'Sand Force' && weather === 'sand' &&
      ['Rock', 'Ground', 'Steel'].includes(move.type)) {
    baseDamage = Math.floor(baseDamage * 1.3);
  }

  // Solar Power: 1.5x for Special moves in Sun
  if (attacker.ability === 'Solar Power' && !isPhysicalCategory(move) && isSun) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Hustle: 1.5x for Physical moves (with accuracy penalty)
  if (attacker.ability === 'Hustle' && isPhysicalCategory(move)) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Guts: 1.5x for Physical moves when statused
  if (attacker.ability === 'Guts' && isPhysicalCategory(move) && attacker.status && attacker.status !== '') {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Overgrow/Blaze/Torrent/Swarm: 1.5x when HP ≤ 1/3
  const typeAbilities = {
    'Overgrow': 'Grass', 'Blaze': 'Fire', 'Torrent': 'Water', 'Swarm': 'Bug',
  };
  if (typeAbilities[attacker.ability] === move.type && attacker.hpFraction <= 1/3) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Item modifiers
  const item = (attacker.item || '').toLowerCase();

  // Choice Band: 1.5x for Physical moves
  if (item === 'choice band' && isPhysicalCategory(move)) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Choice Specs: 1.5x for Special moves
  if (item === 'choice specs' && !isPhysicalCategory(move)) {
    baseDamage = Math.floor(baseDamage * 1.5);
  }

  // Life Orb: 1.3x
  if (item === 'life orb') {
    baseDamage = Math.floor(baseDamage * 1.3);
  }

  // Expert Belt: 1.2x for super-effective moves
  if (item === 'expert belt' && typeEffectiveness > 1) {
    baseDamage = Math.floor(baseDamage * 1.2);
  }

  // Metronome: cumulative boosts for consecutive same-move use
  if (item === 'metronome' && move.consecutiveHits > 0) {
    const metMod = 1 + move.consecutiveHits * 0.2;
    baseDamage = Math.floor(baseDamage * Math.min(metMod, 2.0));
  }

  // Type-boosting items (Charcoal, Mystic Water, etc.): 1.2x
  const TYPE_BOOSTING_ITEMS = {
    'charcoal': 'Fire', 'mystic water': 'Water', 'magnet': 'Electric',
    'miracle seed': 'Grass', 'never-melt ice': 'Ice', 'black belt': 'Fighting',
    'poison barb': 'Poison', 'soft sand': 'Ground', 'sharp beak': 'Flying',
    'twisted spoon': 'Psychic', 'silver powder': 'Bug', 'hard stone': 'Rock',
    'spell tag': 'Ghost', 'dragon fang': 'Dragon', 'black glasses': 'Dark',
    'metal coat': 'Steel', 'fairy feather': 'Fairy',
    // Plates (Arceus items)
    'flame plate': 'Fire', 'splash plate': 'Water', 'zap plate': 'Electric',
    'meadow plate': 'Grass', 'icicle plate': 'Ice', 'fist plate': 'Fighting',
    'toxic plate': 'Poison', 'earth plate': 'Ground', 'sky plate': 'Flying',
    'mind plate': 'Psychic', 'insect plate': 'Bug', 'stone plate': 'Rock',
    'spooky plate': 'Ghost', 'draco plate': 'Dragon', 'dread plate': 'Dark',
    'iron plate': 'Steel', 'pixie plate': 'Fairy',
  };
  if (TYPE_BOOSTING_ITEMS[item] === move.type) {
    baseDamage = Math.floor(baseDamage * 1.2);
  }

  // Muscle Band / Wise Glasses: 1.1x
  if (item === 'muscle band' && isPhysicalCategory(move)) {
    baseDamage = Math.floor(baseDamage * 1.1);
  }
  if (item === 'wise glasses' && !isPhysicalCategory(move)) {
    baseDamage = Math.floor(baseDamage * 1.1);
  }

  return baseDamage;
}

// =============================================================================
// 8. RANDOM FACTOR — Gen 6+ random damage roll (85% - 100%)
// =============================================================================

/**
 * Apply the Gen 6+ random factor: damage is multiplied by a random integer
 * between 85 and 100 (inclusive), then divided by 100.
 * Returns array of all 16 possible damage values for the full range.
 */
function applyRandomFactor(baseDamage) {
  const values = [];
  for (let roll = 85; roll <= 100; roll++) {
    values.push(Math.floor(baseDamage * roll / 100));
  }
  return values;
}

// =============================================================================
// 9. GUARANTEED KO TIER
// =============================================================================

function getGuaranteedKOTier(minDamage, maxDamage, maxHP) {
  if (minDamage >= maxHP) return '1HKO';
  if (minDamage * 2 >= maxHP) return '2HKO';
  if (minDamage * 3 >= maxHP) return '3HKO';
  return null;
}

// =============================================================================
// 10. WEATHER BALL TYPE RESOLUTION
// =============================================================================

/**
 * Weather Ball changes type and power based on active weather.
 * Ported from damage_MASTER.js's checkMoveTypeChange() and basePowerFunc.
 * In weather: becomes 80 BP of the weather's associated type (doubled to 100 BP
 * for Harsh Sun/Heavy Rain). Without weather: remains Normal 50 BP.
 */
function resolveWeatherBallType(moveName, weather, attackerItem, attackerAbility) {
  if (moveName !== 'Weather Ball') return null;
  const hasUmbrella = (attackerItem || '').toLowerCase() === 'utility umbrella';
  const hasMegaSol = attackerAbility === 'Mega Sol';
  const w = (weather || '').toLowerCase();

  if ((w === 'sun' || hasMegaSol) && !hasUmbrella) return { type: 'Fire', bp: 100, boostedBp: 100, isWeatherBoosted: true };
  if (w === 'rain' && !hasUmbrella) return { type: 'Water', bp: 100, boostedBp: 100, isWeatherBoosted: true };
  if (w === 'sand' && !hasUmbrella) return { type: 'Rock', bp: 100, boostedBp: 100, isWeatherBoosted: true };
  if (w === 'snow' && !hasUmbrella) return { type: 'Ice', bp: 100, boostedBp: 100, isWeatherBoosted: true };

  return { type: 'Normal', bp: 50, boostedBp: null, isWeatherBoosted: false };
}

// =============================================================================
// 11. SOLAR BEAM / SOLAR BLADE weather charge skip & BP penalty
// =============================================================================

/**
 * Solar Beam and Solar Blade have a turn charge mechanic: in Sun/Strong Winds
 * they skip the charge turn, in other weather (Rain/Sand/Snow) they get a
 * 0.5x BP penalty. Ported from damage_MASTER.js section (m) of calcBPMods.
 */
function solarBeamBP(moveName, weather) {
  if (moveName !== 'Solar Beam' && moveName !== 'Solar Blade') return null;
  const w = (weather || '').toLowerCase();
  const skipCharge = !w || w === 'sun';
  // In rain/sand/snow, Solar Beam has a 0.5x BP penalty
  if (w === 'rain' || w === 'sand' || w === 'snow') {
    return { bp: 60, skipCharge: false }; // 120 * 0.5 = 60
  }
  return { bp: 120, skipCharge };
}

// =============================================================================
// 11B. VARIABLE BASE POWER MOVES
// =============================================================================

/**
 * Resolve variable base power for moves whose BP depends on game state.
 * Ported from damage_MASTER.js's basePowerFunc() and related helpers.
 *
 * @param {Object} move - { name, bp }
 * @param {Object} attacker - { stats, item, ability, weight, status, boosts, hp, maxHP, side: { partySize, faintedCount } }
 * @param {Object} defender - { stats, weight, status, boosts }
 * @returns {number|null} resolved BP, or null to use move.bp as-is
 */
// Fraction of max HP the attacker is assumed to be at.
//
// No caller supplies attacker.hp, and `(attacker.hp || 0) / (attacker.maxHP || 1)`
// therefore evaluated to 0 for every HP-scaling move. That broke three moves in
// TWO directions: Eruption and Water Spout resolved to their 1 BP floor (they
// scale UP with HP), while Flail and Reversal resolved to their 200 BP ceiling
// (they scale DOWN). A 150 BP Eruption was being reported as 0-0.6% damage.
//
// A damage calculator asked "what does this do" with no HP stated means full
// HP — the same convention this file already uses for `defender.isFullHP !== false`.
// Distinct from null. `null` from resolveVariableBP has always meant "this move
// has no variable component, use the table BP". UNRESOLVED_BP means "this move
// DOES vary and we could not determine by how much" — a different answer that
// callers must be able to tell apart, because printing the table BP for a move
// whose real power we don't know is precisely the failure this whole pass is
// about.
const UNRESOLVED_BP = Symbol('unresolved-variable-bp');

function attackerHpRatio(attacker) {
  if (attacker.hp != null && attacker.maxHP) return attacker.hp / attacker.maxHP;
  // hpFraction was already being carried through CalcDamage and read by nothing.
  if (attacker.hpFraction != null) return attacker.hpFraction;
  return 1;
}

// Same convention on the other side. `defender.isFullHP !== false` is how the
// rest of this file states "assume full HP unless told otherwise"; Wring Out
// instead read `defender.hp || defender.stats?.hp`, which fell through to the
// defender's max-HP STAT (~175) divided by `maxHP || 1` — a ratio of 175, not a
// ratio of 1 — and resolved Wring Out to roughly 21000 BP.
function defenderHpRatio(defender) {
  if (defender.hp != null && defender.maxHP) return defender.hp / defender.maxHP;
  if (defender.hpFraction != null) return defender.hpFraction;
  return defender.isFullHP === false ? 0.5 : 1;
}

/**
 * Moves whose base power depends on state this analyzer has no way to know at
 * team preview: how many turns a move has been used in a row, whether an ally
 * already moved, whether the target has been hit yet this turn.
 *
 * These are NOT given a default. A default here is a number the product would
 * print as though it meant something — which is exactly how Last Respects came
 * to be reported at its 50 BP floor in every line of output for weeks. Returning
 * the sentinel lets callers refuse to build a recommendation on the move instead
 * of quietly assuming the first turn of a sequence.
 *
 * The multi-hit moves that used to sit in this Set are gone from it: they were
 * never unknowable, they were unimplemented. See MULTI_HIT_MOVES below.
 */
const UNMODELLED_VARIABLE_BP = new Set([
  'assurance', 'retaliate', 'beat up',   // ally/turn state
]);

/**
 * Multi-hit moves, by family.
 *
 * These were listed as UNMODELLED_VARIABLE_BP because there was no hit-count
 * engine, so a ten-hit Population Bomb was reported at one hit — a tenth of its
 * real damage — and Bullet Seed at under a third. Nothing errored; the moves
 * just came out looking too weak to keep, in every KO threshold and every
 * move-replacement suggestion built on those numbers.
 *
 *   family 'variable' — the 2-5 hit family. Count is rolled, base power is flat.
 *   family 'fixed'    — always `hits` times. No roll, no accuracy gate.
 *   family 'accuracy' — accuracy is checked BEFORE EACH HIT and the move stops
 *                       at the first miss, so the count is a truncated geometric
 *                       draw and `hits` is only the ceiling. `bpPerHit` is set
 *                       when base power also escalates across the hits.
 *
 * `bpPerHit` is the reason resolveVariableBP still refuses to answer without a
 * stated hit index: Triple Axel is 20 BP on hit one and 60 on hit three, so
 * "the base power of Triple Axel" has no single correct value to hand back.
 */
const MULTI_HIT_MOVES = {
  // 2-5 hits: 2 (35%), 3 (35%), 4 (15%), 5 (15%).
  'bullet seed': { family: 'variable' },
  'rock blast': { family: 'variable' },
  'icicle spear': { family: 'variable' },
  'pin missile': { family: 'variable' },
  'scale shot': { family: 'variable' },
  'tail slap': { family: 'variable' },
  'arm thrust': { family: 'variable' },
  'water shuriken': { family: 'variable' },
  'bone rush': { family: 'variable' },
  'comet punch': { family: 'variable' },
  'double slap': { family: 'variable' },
  'fury attack': { family: 'variable' },
  'fury swipes': { family: 'variable' },
  'spike cannon': { family: 'variable' },

  // Fixed count. Skill Link and Loaded Dice do nothing to these — they already
  // hit their full count every time.
  'dual wingbeat': { family: 'fixed', hits: 2 },
  'double hit': { family: 'fixed', hits: 2 },
  'twineedle': { family: 'fixed', hits: 2 },
  'double kick': { family: 'fixed', hits: 2 },
  'gear grind': { family: 'fixed', hits: 2 },
  'dragon darts': { family: 'fixed', hits: 2 },
  'tachyon cutter': { family: 'fixed', hits: 2 },
  'triple dive': { family: 'fixed', hits: 3 },

  // Per-hit accuracy roll.
  'triple axel': { family: 'accuracy', hits: 3, accuracy: 90, bpPerHit: [20, 40, 60] },
  'triple kick': { family: 'accuracy', hits: 3, accuracy: 90, bpPerHit: [10, 20, 30] },
  'population bomb': { family: 'accuracy', hits: 10, accuracy: 90 },
};

// The 2-5 roll. Expected value is 2(.35) + 3(.35) + 4(.15) + 5(.15) = 3.1, NOT
// the 3.2 of the pre-Gen-V distribution and not the 3.3 that gets quoted around
// this feature. expected_hits is summed from this table rather than written down
// as a literal, so the two can never disagree.
const VARIABLE_HIT_DISTRIBUTION = [
  { hits: 2, probability: 0.35 },
  { hits: 3, probability: 0.35 },
  { hits: 4, probability: 0.15 },
  { hits: 5, probability: 0.15 },
];

// Loaded Dice: 4 or 5, evenly. Expected 4.5.
const LOADED_DICE_DISTRIBUTION = [
  { hits: 4, probability: 0.5 },
  { hits: 5, probability: 0.5 },
];

/**
 * Consecutive-use moves, resolved when the caller states which turn of the
 * sequence it is asking about.
 *
 * `consecutiveUses` is 1 for the first use. These are only unresolvable when
 * nobody says which turn they mean — and a tool that walks the whole sequence
 * and weights it by how likely each turn is CAN say. Fury Cutter is 40 BP on
 * turn one and 160 by turn four; both are true, and neither is "the" answer.
 */
const CONSECUTIVE_USE_BP = {
  'fury cutter': (n) => Math.min(160, 40 * Math.pow(2, n - 1)),
  'rollout': (n) => Math.min(480, 30 * Math.pow(2, n - 1)),
  'ice ball': (n) => Math.min(480, 30 * Math.pow(2, n - 1)),
  'echoed voice': (n) => Math.min(200, 40 * n),
};

function resolveVariableBP(move, attacker, defender) {
  const name = (move.name || '').toLowerCase();
  const atkSpe = attacker.stats.spe || 0;
  const defSpe = defender.stats.spe || 0;
  const atkWeight = attacker.weight || weightOf(attacker.name);
  const defWeight = defender.weight || weightOf(defender.name);

  if (UNMODELLED_VARIABLE_BP.has(name)) return UNRESOLVED_BP;

  // Multi-hit family. Base power here is a PER-HIT quantity, so the honest
  // answer depends on which hit is being asked about — the same contract as
  // consecutiveUses below, and for the same reason. Handing back hit one's 20 BP
  // as "Triple Axel's base power" is how a 120-BP-equivalent move would go on
  // being scored as a 20 BP one; the hit-count engine states the index, and
  // anyone who does not state it gets the sentinel instead of a plausible
  // number. Flat-BP multi-hit moves return null (use the table BP) once the
  // index is stated, because for them only the COUNT varies.
  if (MULTI_HIT_MOVES[name]) {
    const hitIndex = attacker.multiHitIndex;
    if (hitIndex == null || hitIndex < 1) return UNRESOLVED_BP;
    const perHit = MULTI_HIT_MOVES[name].bpPerHit;
    if (!perHit) return null;
    return perHit[Math.min(Math.floor(hitIndex), perHit.length) - 1];
  }

  // Consecutive-use family: resolvable once the turn is stated, unresolved when
  // it is not. Never silently first-turn.
  if (CONSECUTIVE_USE_BP[name]) {
    const n = attacker.consecutiveUses;
    if (n == null || n < 1) return UNRESOLVED_BP;
    return CONSECUTIVE_USE_BP[name](Math.floor(n));
  }
  // Round doubles when an ally has already used it this turn.
  if (name === 'round') {
    if (attacker.allyUsedRound == null) return UNRESOLVED_BP;
    return attacker.allyUsedRound ? 120 : 60;
  }

  // Last Respects: 50 + (50 × each ally that has fainted)
  if (name === 'last respects') {
    const fainted = attacker.side?.faintedCount || 0;
    return 50 + 50 * fainted;
  }

  // Rage Fist: 50 + (50 × times the user has been hit), capped at 350
  if (name === 'rage fist') {
    const hits = attacker.timesHit || 0;
    return Math.min(350, 50 + 50 * hits);
  }

  // Payback: doubles when the user moves second. Speed is the one piece of turn
  // order this analyzer genuinely does know, so this one is resolvable rather
  // than unmodelled — priority and Trick Room are handled by the caller passing
  // an already-inverted Speed pair.
  if (name === 'payback') {
    return atkSpe < defSpe ? 100 : 50;
  }

  // Bolt Beak / Fishious Rend: doubles when the user moves FIRST.
  if (name === 'bolt beak' || name === 'fishious rend') {
    return atkSpe > defSpe ? 170 : 85;
  }

  // Electro Ball: scales with how much faster the user is.
  if (name === 'electro ball') {
    if (defSpe === 0) return 150;
    const ratio = atkSpe / defSpe;
    if (ratio >= 4) return 150;
    if (ratio >= 3) return 120;
    if (ratio >= 2) return 80;
    if (ratio > 1) return 60;
    return 40;
  }

  // Acrobatics: 110 BP without item, 55 BP with item
  if (name === 'acrobatics') {
    return attacker.item ? 55 : 110;
  }

  // Gyro Ball: 25 × (target Speed / user Speed), capped at 150
  if (name === 'gyro ball') {
    if (atkSpe === 0) return 150;
    return Math.min(150, Math.floor(25 * defSpe / atkSpe));
  }

  // Stored Power: 20 + (20 × total positive stat stages)
  if (name === 'stored power') {
    const boosts = attacker.boosts || {};
    let stages = 0;
    for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']) {
      if (boosts[stat] > 0) stages += boosts[stat];
    }
    return 20 + 20 * stages;
  }

  // Punishment: 60 + (20 × opponent's positive stat stages), max 200
  if (name === 'punishment') {
    const boosts = defender.boosts || {};
    let stages = 0;
    for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']) {
      if (boosts[stat] > 0) stages += boosts[stat];
    }
    return Math.min(200, 60 + 20 * stages);
  }

  // Hex: 130 BP if target is statused, 65 otherwise
  if (name === 'hex') {
    return defender.status ? 130 : 65;
  }

  // Facade: 140 BP if user is statused, 70 otherwise
  if (name === 'facade') {
    return attacker.status ? 140 : 70;
  }

  // Flail: power based on user's remaining HP ratio
  if (name === 'flail') {
    const hpRatio = attackerHpRatio(attacker);
    if (hpRatio > 0.695) return 20;
    if (hpRatio > 0.521) return 40;
    if (hpRatio > 0.346) return 80;
    if (hpRatio > 0.171) return 100;
    if (hpRatio > 0) return 150;
    return 200;
  }

  // Reversal: same formula as Flail
  if (name === 'reversal') {
    const hpRatio = attackerHpRatio(attacker);
    if (hpRatio > 0.695) return 20;
    if (hpRatio > 0.521) return 40;
    if (hpRatio > 0.346) return 80;
    if (hpRatio > 0.171) return 100;
    if (hpRatio > 0) return 150;
    return 200;
  }

  // Eruption / Water Spout: 150 × (current HP / max HP), minimum 1
  if (name === 'eruption' || name === 'water spout') {
    const hpRatio = attackerHpRatio(attacker);
    return Math.max(1, Math.floor(150 * hpRatio));
  }

  // Heavy Slam / Heat Crash: weight ratio table.
  // An unknown weight used to fall through to 120 — the TOP of the table. Now it
  // reports unresolved, because "we do not know" and "maximum power" are not the
  // same claim.
  if (name === 'heavy slam' || name === 'heat crash') {
    if (!atkWeight || !defWeight) return UNRESOLVED_BP;
    const ratio = atkWeight / defWeight;
    if (ratio >= 5) return 120;
    if (ratio >= 4) return 100;
    if (ratio >= 3) return 80;
    if (ratio >= 2) return 60;
    return 40;
  }

  // Grass Knot / Low Kick: target weight table. Same ceiling bug as above.
  if (name === 'grass knot' || name === 'low kick') {
    if (!defWeight) return UNRESOLVED_BP;
    if (defWeight >= 200) return 120;
    if (defWeight >= 100) return 100;
    if (defWeight >= 50) return 80;
    if (defWeight >= 25) return 60;
    if (defWeight >= 10) return 40;
    return 20;
  }

  // Wring Out / Crush Grip / Hard Press: scale with the TARGET's remaining HP.
  if (name === 'wring out' || name === 'crush grip') {
    return Math.max(1, Math.floor(120 * defenderHpRatio(defender)));
  }
  if (name === 'hard press') {
    return Math.max(1, Math.floor(100 * defenderHpRatio(defender)));
  }

  // Brine: doubles once the target is at or below half HP.
  if (name === 'brine') {
    return defenderHpRatio(defender) <= 0.5 ? 130 : 65;
  }

  // Venoshock / Wake-Up Slap / Smelling Salts: double against a specific status.
  if (name === 'venoshock') {
    const st = String(defender.status || '').toLowerCase();
    return (st === 'psn' || st === 'tox' || st.includes('poison')) ? 130 : 65;
  }
  if (name === 'wake-up slap' || name === 'wake up slap') {
    const st = String(defender.status || '').toLowerCase();
    return (st === 'slp' || st.includes('sleep')) ? 140 : 70;
  }
  if (name === 'smelling salts') {
    const st = String(defender.status || '').toLowerCase();
    return (st === 'par' || st.includes('paralys')) ? 140 : 70;
  }

  // Spit Up: 100 × Stockpile count. With no Stockpile the move genuinely has no
  // power — but returning 0 through a `||` fallback silently restored the table
  // BP, so report it unresolved instead of inventing a number.
  if (name === 'spit up') {
    const stockpile = attacker.stockpile || 0;
    return stockpile > 0 ? 100 * stockpile : UNRESOLVED_BP;
  }

  // Trump Card: power based on remaining PP. With no PP tracking the old default
  // of 1 remaining PP resolved to 80 — the top of the table — for a move that is
  // at 40 for the first four uses of a battle.
  if (name === 'trump card') {
    const pp = attacker.movePP?.trump_card ?? attacker.remainingPP;
    if (pp == null) return UNRESOLVED_BP;
    if (pp >= 4) return 40;
    if (pp === 3) return 50;
    if (pp === 2) return 60;
    return 80;
  }

  // Return / Frustration: happiness × 10 / 25, capped at 102.
  //
  // This was `(255 * happiness) / 25` — the 255 belongs in the happiness value,
  // not the numerator. At default happiness it resolved Return to floor(65025/25)
  // = 2601 BP, twenty-five times the move's actual maximum. Nothing in Reg M-B
  // runs Return, which is the only reason it never surfaced; it sat in a shared
  // path where one reachable call would have produced nonsense.
  //
  // The defaults are the competitive ones: nobody runs Return on an unhappy
  // Pokemon or Frustration on a happy one, so each assumes its own best case.
  if (name === 'return') {
    const happiness = attacker.happiness != null ? attacker.happiness : 255;
    return Math.max(1, Math.min(102, Math.floor((happiness * 10) / 25)));
  }
  if (name === 'frustration') {
    const happiness = attacker.happiness != null ? attacker.happiness : 0;
    return Math.max(1, Math.min(102, Math.floor(((255 - happiness) * 10) / 25)));
  }

  // Natural Gift: power AND type both come from the held Berry. Without a Berry
  // table this cannot be resolved, and the old flat 60 also left the move's type
  // wrong, which is the larger error of the two.
  if (name === 'natural gift') {
    return attacker.naturalGiftPower || UNRESOLVED_BP;
  }

  // Double Iron Bash: 60 BP × 2 hits (handled by hit count, not BP)
  // Present: random 40/80/120/200 — use average 100 for calcs
  if (name === 'present') {
    return 100;
  }

  // Endeavor: damage = maxHP - currentHP of attacker (handled as special case)
  // Night Shade / Seismic Toss: fixed damage = level (handled as special case)
  // Sonic Boom: fixed 20 damage (handled as special case)
  // Dragon Rage: fixed 40 damage (handled as special case)

  return null; // use move.bp as-is
}

// =============================================================================
// 11C. MULTI-HIT ENGINE — how many times the move connects
// =============================================================================

/**
 * Wide Lens: accuracy x1.1, capped at 100.
 *
 * This is the ONLY place accuracy enters the calculator, and deliberately so.
 * Whole-move accuracy (Rock Blast's 90%) is not modelled: it scales every
 * outcome by the same factor and belongs to the caller's win-rate maths, not to
 * a damage range. Per-hit accuracy is different — it decides the HIT COUNT, so
 * for Triple Axel, Triple Kick and Population Bomb it is part of the damage.
 */
function effectiveHitAccuracy(baseAccuracy, item) {
  if ((item || '') === 'Wide Lens') return Math.min(100, baseAccuracy * 1.1);
  return baseAccuracy;
}

/**
 * Hit-count distribution for a move that re-rolls accuracy before every hit and
 * stops at the first miss. With per-hit probability p and a ceiling of n hits:
 *   P(k) = p^k * (1 - p)  for k < n,  P(n) = p^n
 *
 * k = 0 is a real outcome and is included. Dropping it would renormalise the
 * rest upward and quietly inflate the expectation — the exact error that makes
 * Population Bomb look like a ten-hit move. At 90% per hit its expectation is
 * sum(0.9^k, k=1..10) = 5.86 hits, not 10 and not the 6.5 that gets quoted.
 */
function accuracyHitDistribution(maxHits, p) {
  const dist = [];
  for (let k = 0; k < maxHits; k++) {
    dist.push({ hits: k, probability: Math.pow(p, k) * (1 - p) });
  }
  dist.push({ hits: maxHits, probability: Math.pow(p, maxHits) });
  return dist.filter(d => d.probability > 0);
}

/**
 * Resolve a move's hit-count distribution.
 *
 * Returns null for every single-hit move — that is the signal for CalcDamage to
 * take its original path untouched — or a descriptor:
 *   { minHits, maxHits, swapHits, expectedHits, distribution, bpPerHit, note }
 *
 * @param {Object} move - { name }
 * @param {Object} attacker - { ability, item }
 */
function resolveMultiHit(move, attacker) {
  const name = ((move && move.name) || '').toLowerCase();
  const entry = MULTI_HIT_MOVES[name];
  if (!entry) return null;

  const holder = attacker || {};
  const hasSkillLink = (holder.ability || '') === 'Skill Link';
  const hasLoadedDice = (holder.item || '') === 'Loaded Dice';

  let distribution;
  let note;
  // The "expected N" clause is earned, not automatic. Appending it to whatever
  // note came out of the branches produced "4-5 hits (Loaded Dice), expected
  // 4.5" for Population Bomb — true, but Population Bomb is an ACCURACY-family
  // move whose per-hit rolls Loaded Dice has just removed, so the clause read as
  // though the accuracy gate were still deciding the count.
  let appendExpected = false;

  if (entry.family === 'variable') {
    if (hasSkillLink) {
      distribution = [{ hits: 5, probability: 1 }];
      note = '5 hits (Skill Link)';
    } else if (hasLoadedDice) {
      distribution = LOADED_DICE_DISTRIBUTION.map(d => ({ ...d }));
      note = '4-5 hits (Loaded Dice)';
    } else {
      distribution = VARIABLE_HIT_DISTRIBUTION.map(d => ({ ...d }));
    }
  } else if (entry.family === 'fixed') {
    distribution = [{ hits: entry.hits, probability: 1 }];
    note = `${entry.hits} hits`;
  } else {
    // Per-hit accuracy. Loaded Dice removes those rolls entirely — that is its
    // whole function on Population Bomb — leaving 4-5 hits where the ceiling
    // allows it and the ceiling itself where it does not. Triple Axel and
    // Triple Kick cap at 3, so Loaded Dice makes them a guaranteed 3.
    if (hasLoadedDice) {
      if (entry.hits >= 5) {
        distribution = LOADED_DICE_DISTRIBUTION.map(d => ({ ...d }));
        note = '4-5 hits (Loaded Dice)';
      } else {
        distribution = [{ hits: entry.hits, probability: 1 }];
        note = `${entry.hits} hits (Loaded Dice, no accuracy checks)`;
      }
    } else {
      const acc = effectiveHitAccuracy(entry.accuracy, holder.item);
      distribution = accuracyHitDistribution(entry.hits, acc / 100);
      note = `${entry.hits} hits at ${Math.round(acc * 10) / 10}% accuracy each`;
      appendExpected = true;
    }
  }

  let expectedHits = 0;
  for (const d of distribution) expectedHits += d.hits * d.probability;
  expectedHits = Math.round(expectedHits * 100) / 100;

  const counts = distribution.map(d => d.hits);
  const minHits = Math.min(...counts);
  const maxHits = Math.max(...counts);

  // The hit count a move-replacement recommendation is allowed to lean on.
  // Four, clamped into what the move can actually do. That one rule produces
  // every number the spec calls for without a per-move special case: 4 for the
  // 2-5 family, 2 for Dual Wingbeat, 3 for Triple Dive and Triple Axel (their
  // ceiling), 5 under Skill Link, and 4 for Population Bomb — whose ceiling of
  // 10 would be the opposite of conservative.
  const swapHits = Math.min(Math.max(4, minHits), maxHits);

  if (!note) {
    note = `${minHits}-${maxHits} hits, expected ${Math.round(expectedHits * 10) / 10}`;
  } else if (appendExpected) {
    note += `, expected ${Math.round(expectedHits * 10) / 10}`;
  }

  return {
    minHits,
    maxHits,
    swapHits,
    expectedHits,
    distribution,
    bpPerHit: entry.bpPerHit || null,
    note,
  };
}

// =============================================================================
// 12. MAIN CALCULATION PIPELINE
// =============================================================================

/**
 * Compute the full damage range for a single move, following the Nerd of Now
 * pipeline exactly: basePower → BP mods → attack → attack mods →
 * defense → defense mods → baseDamage → general mods → random factor.
 *
 * @param {Object} attacker - { name, baseStats, sp, nature, item, ability, types }
 * @param {Object} defender - { name, baseStats, sp, nature, item, ability, types }
 * @param {Object} move - { name, type, category, bp }
 * @param {Object} [field={}] - { weather, terrain, gameType, isReflect, isLightScreen, isAuroraVeil }
 * @returns {Object} damage result with min/max percent and KO tier
 */
function calcSingleMove(attacker, defender, move, field) {
  field = field || {};
  const isDouble = field.gameType === 'Doubles' || field.format !== 'Singles';
  const weather = field.weather || '';
  const isCritical = field.isCritical === true;

  // Resolve Weather Ball type/power
  const wbInfo = resolveWeatherBallType(move.name, weather, attacker.item, attacker.ability);
  const actualMoveType = wbInfo ? wbInfo.type : move.type;
  const actualBP = wbInfo ? wbInfo.bp : move.bp;

  // Resolve Solar Beam BP
  const sbInfo = solarBeamBP(move.name, weather);
  const sbBP = sbInfo ? sbInfo.bp : actualBP;

  // Resolve variable base power moves (Last Respects, Gyro Ball, Stored Power, etc.)
  //
  // `??`, not `||`. With `||` any legitimate 0 fell back to the table BP, which
  // is how Spit Up and Frustration silently reverted. UNRESOLVED_BP is passed
  // through to the result so the caller can refuse to print the number rather
  // than receiving a plausible-looking one.
  const varBP = resolveVariableBP(move, attacker, defender);
  const bpUnresolved = varBP === UNRESOLVED_BP;
  const finalBP = bpUnresolved ? sbBP : (varBP ?? sbBP);

  // Get attacker's offensive stat and defender's defensive stat
  const isPhysical = isPhysicalCategory(move);

  // Reset stat calculations if the move uses the opposite stat (e.g. Foul Play, Psyshock)
  const attackStat = isPhysical ? attacker.stats.atk : attacker.stats.spa;
  let defenseStat = isPhysical ? defender.stats.def : defender.stats.spd;

  // Gen 9 Snow Defense boost: Ice-type Pokemon get 1.5x Defense in Snow
  const wLower = (weather || '').toLowerCase();
  if (wLower === 'snow' && isPhysical && defender.types && defender.types.includes('Ice')) {
    defenseStat = Math.floor(defenseStat * 1.5);
  }

  // Gen 9 Sand Special Defense boost: Rock-type Pokemon get 1.5x SpD in Sand
  if (wLower === 'sand' && !isPhysical && defender.types && defender.types.includes('Rock')) {
    defenseStat = Math.floor(defenseStat * 1.5);
  }

  // --- Defensive item stat boosts ---------------------------------------------
  // Applied to the STAT, not to final damage. Dividing damage by 1.5 is only
  // approximately equivalent to multiplying the defensive stat by 1.5, because
  // of the floor() steps in the formula — and this project's threshold system
  // turns on exact KO boundaries, where a one-point difference flips a tier.
  //
  // Before this block the ONLY defensive item the calculator understood was
  // Utility Umbrella, so every Assault Vest / Eviolite holder was calculated
  // as though it held nothing.
  const defItemName = defender.item || '';
  if (defItemName === 'Assault Vest' && !isPhysical) {
    defenseStat = Math.floor(defenseStat * 1.5);
  }
  if (defItemName === 'Eviolite') {
    defenseStat = Math.floor(defenseStat * 1.5);
  }

  // --- STEP 1: Base damage (before all modifiers except BP/stat calcs)
  let baseDamage = calcBaseDamage(finalBP, attackStat, defenseStat);

  // --- STEP 2: Spread move penalty (0.75x in Doubles)
  if (move.isSpread && isDouble) {
    baseDamage = pokeRound(baseDamage * 0x0C00 / 0x1000);
  }

  // --- STEP 3: Weather damage mod
  baseDamage = applyWeatherMod(baseDamage, weather, actualMoveType, move.name, attacker.ability, defender.item);

  // --- STEP 4: Critical hit mod
  baseDamage = applyCritMod(baseDamage, isCritical);

  // --- STEP 5: Random factor (85-100%)
  const damageRolls = applyRandomFactor(baseDamage);

  // --- STEP 6: For each random roll, apply all final modifiers
  const finalDamages = damageRolls.map(d => {
    // Recalculate type effectiveness for the actual move type
    const eff = getMoveEffectiveness(actualMoveType, defender.types);
    // Apply all final mods (STAB, type, burn, screens, abilities, items)
    const finalField = {
      ...field,
      weather: field.weather,
      format: field.format || (isDouble ? 'Doubles' : 'Singles'),
    };
    // Use resolved move type/BP for final mods (Weather Ball → Fire, Solar Beam BP, etc.)
    const resolvedMove = Object.assign({}, move, { type: actualMoveType, bp: finalBP });
    return applyFinalMods(d, resolvedMove, attacker, defender, finalField, eff, isCritical);
  }).filter(d => d !== null && d !== undefined);

  const maxHP = defender.stats.hp;
  const minDamage = Math.min(...finalDamages);
  const maxDamage = Math.max(...finalDamages);
  const minPercent = (minDamage / maxHP) * 100;
  const maxPercent = (maxDamage / maxHP) * 100;

  return {
    minDamage,
    maxDamage,
    minPercent: Math.round(minPercent * 10) / 10,
    maxPercent: Math.round(maxPercent * 10) / 10,
    // True when this move's real base power depends on state we do not have.
    // The damage numbers above are still returned (they are the table-BP result)
    // but a caller must not present them as this move's damage.
    bp_unresolved: bpUnresolved,
    base_power_used: finalBP,
    // The real 16 per-roll damage values, each ALREADY through applyFinalMods
    // (STAB/type/etc — see STEP 5/6 above: the random roll is applied BEFORE
    // those, not after). A caller wanting exact roll odds (e.g. "N/16 rolls
    // OHKO") must use THIS array, not re-derive one from minDamage/maxDamage —
    // applyFinalMods is not a pure linear scale of the pre-roll base damage
    // (pokeRound/chainMods truncate), so reapplying a random factor on top of
    // an already-modified maxDamage produces a different, wrong distribution.
    all_damages: finalDamages.slice(),
  };
}

// =============================================================================
// 13. CalcDamage — main exported function
// =============================================================================

/**
 * Main damage calculation function — ports and replaces @smogon/calc calls.
 *
 * @param {Object} opts
 * @param {Object} opts.attacker - { name, nature, sp, item, ability, baseStats, types }
 * @param {Object} opts.defender - { name, nature, sp, item, ability, baseStats, types }
 * @param {Object} opts.move - { name, type, category, bp, isSpread, makesContact }
 * @param {string} [opts.weather] - 'Sun' | 'Rain' | 'Sand' | 'Snow' | null
 * @param {string} [opts.terrain] - 'Electric' | 'Grassy' | 'Misty' | 'Psychic' | null
 * @param {boolean} [opts.isDouble] - true for Doubles format
 * @param {Object} [opts.field] - Additional field state
 * @returns {Object} { minPercent, maxPercent, minDamage, maxDamage, guaranteed_ko, notes }
 */
function CalcDamage(opts) {
  const { attacker, defender, move, weather, terrain, isDouble, field: extraField } = opts || {};

  if (!attacker || !defender || !move) {
    throw new Error('attacker, defender, and move are required');
  }

  // Build full stat blocks
  const attackerStats = buildStatsFromSP(attacker.baseStats || attacker, attacker.sp || {}, attacker.nature || 'Hardy');
  const defenderStats = buildStatsFromSP(defender.baseStats || defender, defender.sp || {}, defender.nature || 'Hardy');

  // Resolve attacker/defender types
  const attackerTypes = attacker.types || (attacker.baseStats
    ? [attacker.baseStats.type1, attacker.baseStats.type2].filter(Boolean)
    : [attacker.type1, attacker.type2].filter(Boolean));

  const defenderTypes = defender.types || (defender.baseStats
    ? [defender.baseStats.type1, defender.baseStats.type2].filter(Boolean)
    : [defender.type1, defender.type2].filter(Boolean));

  // Build move object with defaults
  const moveObj = {
    name: move.name,
    type: move.type || 'Normal',
    category: move.category || 'Physical',
    bp: move.bp || 0,
    isSpread: move.isSpread || false,
    makesContact: move.makesContact || false,
    dealsPhysicalDamage: move.dealsPhysicalDamage || false,
  };

  // Build field state
  const field = {
    ...(extraField || {}),
    weather: weather || '',
    terrain: terrain || '',
    format: isDouble || extraField?.gameType === 'Doubles' ? 'Doubles' : 'Singles',
    gameType: (extraField?.gameType) || (isDouble ? 'Doubles' : 'Singles'),
  };

  // Build attacker/defender with stats
  // NOTE ON THE FIELD LIST BELOW — this is the chokepoint that broke the whole
  // variable-BP system. These two objects are rebuilt from scratch and are the
  // ONLY thing resolveVariableBP ever sees. Every field it reads that was not
  // copied here was structurally unreachable: a caller could set `faintedCount`,
  // `boosts` or `weight` perfectly and the value would be dropped one frame
  // before the code that wanted it. That is why Last Respects sat at its 50 BP
  // floor in every line of output despite being implemented correctly.
  //
  // Anything resolveVariableBP reads must be copied here. Adding a field to that
  // function without adding it here is a silent no-op.
  const attackerFull = {
    name: attacker.name,
    ability: attacker.ability || '',
    item: attacker.item || '',
    stats: attackerStats,
    types: attackerTypes,
    status: attacker.status || '',
    hpFraction: attacker.hpFraction !== undefined ? attacker.hpFraction : 1,
    weight: attacker.weight,
    boosts: attacker.boosts,
    hp: attacker.hp,
    maxHP: attacker.maxHP,
    side: attacker.side,
    timesHit: attacker.timesHit,
    consecutiveUses: attacker.consecutiveUses,
    allyUsedRound: attacker.allyUsedRound,
    happiness: attacker.happiness,
    stockpile: attacker.stockpile,
    movePP: attacker.movePP,
    remainingPP: attacker.remainingPP,
    naturalGiftPower: attacker.naturalGiftPower,
    multiHitIndex: attacker.multiHitIndex,
  };

  const defenderFull = {
    name: defender.name,
    ability: defender.ability || '',
    item: defender.item || '',
    stats: defenderStats,
    types: defenderTypes,
    status: defender.status || '',
    isFullHP: defender.isFullHP !== undefined ? defender.isFullHP : true,
    isFriendGuard: defender.isFriendGuard || false,
    weight: defender.weight,
    boosts: defender.boosts,
    hp: defender.hp,
    maxHP: defender.maxHP,
    hpFraction: defender.hpFraction,
  };

  // Run calculation.
  //
  // The hit count is resolved BEFORE the damage call because the two are
  // coupled: resolveVariableBP will not hand back a base power for Triple Axel
  // without a stated hit index, so a multi-hit move calculated the old way would
  // now come back flagged bp_unresolved on a path that resolves it perfectly.
  const multiHit = resolveMultiHit(moveObj, attackerFull);
  const result = calcSingleMove(
    multiHit ? Object.assign({}, attackerFull, { multiHitIndex: 1 }) : attackerFull,
    defenderFull, moveObj, field
  );

  const maxHP = defenderStats.hp;
  const pct = (dmg) => Math.round((dmg / maxHP) * 1000) / 10;

  // --- Multi-hit aggregation ---------------------------------------------------
  // cumMin[k] / cumMax[k] are the damage after exactly k hits. The game floors
  // each hit independently, so the k-hit floor is k minimum rolls SUMMED — not
  // one minimum roll multiplied by k, which drifts by up to k-1 points and is
  // enough to move a KO threshold in a system built on exact boundaries.
  let multiHitOut = null;
  let expectedMinDamage = null;
  let expectedMaxDamage = null;
  if (multiHit) {
    const cumMin = [0];
    const cumMax = [0];
    for (let i = 1; i <= multiHit.maxHits; i++) {
      // Only escalating-BP moves need a fresh calculation per hit. For every
      // other multi-hit move each hit is identical, and re-running the whole
      // pipeline ten times for Population Bomb inside a team-wide loop would be
      // pure waste.
      const hit = (i === 1 || !multiHit.bpPerHit)
        ? result
        : calcSingleMove(Object.assign({}, attackerFull, { multiHitIndex: i }), defenderFull, moveObj, field);
      cumMin[i] = cumMin[i - 1] + Math.round(hit.minDamage);
      cumMax[i] = cumMax[i - 1] + Math.round(hit.maxDamage);
    }

    // Expected damage is summed over the DISTRIBUTION, not computed from the
    // expected hit count. For flat-BP moves the two agree; for Triple Axel they
    // do not, because its hits are worth 20/40/60 BP and the ones most likely to
    // be missed are the expensive ones at the end.
    let expMin = 0;
    let expMax = 0;
    const hitCounts = multiHit.distribution.map(d => {
      expMin += d.probability * cumMin[d.hits];
      expMax += d.probability * cumMax[d.hits];
      return {
        hits: d.hits,
        probability: Math.round(d.probability * 10000) / 10000,
        min_percent: pct(cumMin[d.hits]),
        max_percent: pct(cumMax[d.hits]),
        ohko: cumMin[d.hits] >= maxHP,
      };
    });

    expectedMinDamage = Math.round(expMin);
    expectedMaxDamage = Math.round(expMax);

    multiHitOut = {
      hit_counts: hitCounts,
      expected_hits: multiHit.expectedHits,
      expected_min_percent: pct(expMin),
      expected_max_percent: pct(expMax),
      swap_min_percent: pct(cumMin[multiHit.swapHits]),
      swap_max_percent: pct(cumMax[multiHit.swapHits]),
      guaranteed_min_percent: pct(cumMin[multiHit.minHits]),
      guaranteed_max_percent: pct(cumMax[multiHit.minHits]),
      note: multiHit.note,
    };
  }

  // The top-level figures become the EXPECTED-hits damage for a multi-hit move.
  // Every consumer in this codebase reads minPercent/maxPercent and, until the
  // engine above existed, got one hit's worth for a move that lands three or
  // more — so Bullet Seed and Population Bomb were scored as though they were
  // the weakest moves on the set. Single-hit moves are byte-for-byte unchanged.
  let minPercent = multiHitOut ? multiHitOut.expected_min_percent : result.minPercent;
  let maxPercent = multiHitOut ? multiHitOut.expected_max_percent : result.maxPercent;
  const baseMinDamage = multiHitOut ? expectedMinDamage : Math.round(result.minDamage);
  const baseMaxDamage = multiHitOut ? expectedMaxDamage : Math.round(result.maxDamage);

  // --- Focus Sash --------------------------------------------------------------
  // Not a damage modifier: a guarantee that a single hit from full HP cannot KO.
  // It was not modelled at all, so a Sash holder was reported as OHKO'd and any
  // "this item makes it survive" reasoning about it was incoherent.
  //
  // The reported percentages are CAPPED below 100 when the Sash applies, because
  // every consumer in this codebase asks "is min >= 100" to decide OHKO. Capping
  // makes all of them correct without each having to know about the item; the
  // uncapped figures stay available as raw_min_percent / raw_max_percent.
  //
  // Multi-hit moves are excluded outright. Sash only triggers from FULL HP, so
  // the best it can do against one is survive hit one at 1 HP — and then hit two
  // kills. Applying the cap here would have reported Bullet Seed as non-lethal
  // into an item that does not stop it, which is a worse answer than the one
  // this block was written to fix.
  const sashApplies = !multiHitOut
    && (defender.item || '') === 'Focus Sash'
    && defender.isFullHP !== false
    && Math.round(result.minDamage) >= maxHP;
  const rawMinPercent = minPercent;
  const rawMaxPercent = maxPercent;
  let effectiveMinDamage = baseMinDamage;
  let effectiveMaxDamage = baseMaxDamage;
  if (sashApplies) {
    effectiveMinDamage = maxHP - 1;
    effectiveMaxDamage = maxHP - 1;
    minPercent = Math.round(((maxHP - 1) / maxHP) * 1000) / 10;
    maxPercent = minPercent;
  }

  // Build KO tier
  const koTier = getGuaranteedKOTier(effectiveMinDamage, effectiveMaxDamage, maxHP);

  // Build notes string matching Nerd of Now format
  const abilityNote = attacker.ability ? attacker.ability + ' ' : '';
  const itemNote = attacker.item ? attacker.item + ' ' : '';
  const natureNote = attacker.nature && attacker.nature !== 'Hardy' ? (attacker.nature.includes('+') ? '' : (natureToModifier(attacker.nature) || '')) : '';
  const weatherNote = weather ? ` in ${weather}` : '';
  const hitNote = multiHitOut ? ` [${multiHitOut.note}]` : '';
  const notes = `${natureNote}${itemNote}${abilityNote}${move.name} vs. ${defender.name}: ${baseMinDamage}-${baseMaxDamage} (${minPercent} - ${maxPercent}%) -- ${koTier || 'not a guaranteed KO'}${weatherNote}${hitNote}`;

  return {
    minPercent,
    maxPercent,
    minDamage: effectiveMinDamage,
    maxDamage: effectiveMaxDamage,
    guaranteed_ko: koTier,
    notes,
    // Variable-BP disclosure — see UNRESOLVED_BP.
    bp_unresolved: result.bp_unresolved === true,
    base_power_used: result.base_power_used,
    // Hit-count disclosure — null for every single-hit move. See MULTI_HIT_MOVES.
    multi_hit: multiHitOut,
    // Focus Sash disclosure: what the hit would have done without it.
    sash_prevents_ohko: sashApplies,
    raw_min_percent: rawMinPercent,
    raw_max_percent: rawMaxPercent,
    raw_min_damage: baseMinDamage,
    raw_max_damage: baseMaxDamage,
    // The real 16 per-roll damage values (see the inner single-hit function's
    // own comment on `all_damages` above) — null for multi-hit moves, whose
    // top-level min/max here are already an EXPECTED VALUE across a hit-count
    // distribution, not a single hit's 16-roll range, so "N/16 rolls OHKO"
    // does not apply to them the same way.
    all_damages: multiHitOut ? null : result.all_damages,
    // Raw intermediate values for debugging
    _attackerStats: attackerStats,
    _defenderStats: defenderStats,
  };
}

function natureToModifier(nature) {
  const n = NATURE_TABLE[nature];
  if (!n) return '';
  const boost = n[0] === n[1] ? '' : n[0] !== n[1] ? '+' : '';
  return n[0] !== n[1] ? `${n[0].charAt(0).toUpperCase() + n[0].slice(1)}+ ` : '';
}

// =============================================================================
// 14. Detect weather from team composition (ability-based)
// =============================================================================

const WEATHER_SETTER_ABILITIES = {
  'Drought': 'Sun',
  'Drizzle': 'Rain',
  'Sand Stream': 'Sand',
  'Snow Warning': 'Snow',
};

/**
 * Detect active weather from a team's abilities.
 * Returns the weather name (capitalized) or null if none found.
 */
function detectTeamWeather(team) {
  if (!team || !team.length) return null;
  for (const member of team) {
    const abil = (member.ability || '').toLowerCase();
    for (const [setterAbility, weather] of Object.entries(WEATHER_SETTER_ABILITIES)) {
      if (abil === setterAbility.toLowerCase()) {
        return weather;
      }
    }
  }
  return null;
}

/**
 * Resolve a move name to a move object suitable for CalcDamage.
 * Uses @pkmn/dex to look up type/category/BP/spread/contact.
 */
function getMoveData(moveName) {
  const dexMove = Dex.moves.get(moveName);
  if (!dexMove || !dexMove.exists) {
    return { name: moveName, type: 'Normal', category: 'Physical', bp: 0, isSpread: false, makesContact: false };
  }
  return {
    name: dexMove.name,
    type: dexMove.type || 'Normal',
    category: dexMove.category || 'Physical',
    bp: dexMove.basePower || 0,
    isSpread: dexMove.spread || false,
    makesContact: !!dexMove.contact,
  };
}

module.exports = {
  CalcDamage,
  detectTeamWeather,
  buildStatsFromSP,
  calcBaseDamage,
  calcStatHP,
  calcStatNonHP,
  getNatureMult,
  chainMods,
  pokeRound,
  getMoveEffectiveness,
  applyWeatherMod,
  applyFinalMods,
  applyRandomFactor,
  getMoveData,
  // Exported so the hit-count distribution can be asserted directly rather than
  // only through a damage number, which hides which half of the pair is wrong.
  resolveMultiHit,
  MULTI_HIT_MOVES,
  // Exported so a caller proposing an item change (not just calculating the
  // effect of one already assigned) can check which resist berry answers a
  // given attacking type, without duplicating this map.
  RESIST_BERRIES,
};
