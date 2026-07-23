const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const calc = require('@smogon/calc');
const pool = require('../db/pool');
const damage = require('../routes/damage');
const { calcStat, natureMultiplierFor, snapToBreakpoint, findMinSpForStat, spToEv, SP_STEPS, SP_CAP_PER_STAT, SP_BUDGET_TOTAL } = require('./stat_formula');
const { getThreatMatrix } = require('./threat_matrix');
const { getCommonSpeedTiers, getMostCommonSpread, getObservationCount, getNatureDistribution } = require('./ev_observations');
const { classifyRole } = require('./role_classifier');
const { findOptimalSpread } = require('./spread_optimizer');
const { SCORER_VERSION } = require('./spread_scorer');
const {
  getMetaContext, getSpeedModifiers, trickroomRelevant,
  CONDITION_PREVALENCE_THRESHOLD, ABILITY_PROFILE_FREQUENCY_THRESHOLD,
} = require('./speed_context');

const HIGH_USAGE_THRESHOLD = 10; // percent, for offensive-threshold targets
const MIN_THREAT_WEIGHT = 0.05; // skip negligible attacker+move combos — bounds calc.calculate() calls per request
const STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
const TRICKROOM_PREVALENCE_THRESHOLD = 0.25;
const TRICKROOM_ROLES = new Set(['slow_bulky_offense', 'slow_bulky_support']);

// Fixed point values from the scoring spec — applied exactly, no exceptions.
const TYPE_VALUES = {
  OHKO_prevented: 3.0,
  speed_tier: 2.0,
  trickroom_speed: 2.0, // same base type_value as speed_tier — role multipliers differentiate them
  '2HKO_prevented': 1.0,
  '3HKO_prevented': 0.4,
  OHKO_achieved: 2.5,
  '2HKO_achieved': 1.0,
};

// Role-based score multipliers — applied to the already-computed score, never to
// type_value or base_weight directly (see applyRoleMultipliers).
const ROLE_MULTIPLIERS = {
  fast_offense: {
    speed_tier: 1.5, ohko_prevented: 0.7, '2hko_prevented': 0.5, '3hko_prevented': 0.3,
    ohko_achieved: 1.4, '2hko_achieved': 1.2,
  },
  slow_bulky_offense: {
    speed_tier: 0.3, trickroom_speed: 1.4, ohko_prevented: 1.4, '2hko_prevented': 1.2,
    '3hko_prevented': 0.8, ohko_achieved: 1.3, '2hko_achieved': 1.1,
  },
  slow_bulky_support: {
    speed_tier: 0.2, trickroom_speed: 1.2, ohko_prevented: 1.6, '2hko_prevented': 1.4,
    '3hko_prevented': 1.0, ohko_achieved: 0.3, '2hko_achieved': 0.2,
  },
  fast_support: {
    speed_tier: 1.4, ohko_prevented: 1.2, '2hko_prevented': 0.8, '3hko_prevented': 0.5,
    ohko_achieved: 0.8, '2hko_achieved': 0.6,
  },
};

// Spread ordering + 3rd-spread renaming per role. The underlying build*Spread()
// functions never change — only display order/label depends on role.
const SPREAD_PLAN_BY_ROLE = {
  fast_offense: [['Optimized', 'Optimized'], ['Survival-focused', 'Survival-focused'], ['Offensive-focused', 'Offensive-focused']],
  slow_bulky_offense: [['Survival-focused', 'Survival-focused'], ['Optimized', 'Optimized'], ['Offensive-focused', 'Power-focused']],
  slow_bulky_support: [['Survival-focused', 'Survival-focused'], ['Optimized', 'Optimized'], ['Offensive-focused', 'Coverage-focused']],
  fast_support: [['Optimized', 'Optimized'], ['Survival-focused', 'Survival-focused'], ['Offensive-focused', 'Pressure-focused']],
};

const ROLE_PRIORITY_TEXT = {
  fast_offense: 'Speed > Offense > Survivability',
  slow_bulky_offense: 'Survivability > Offense >> Speed (deprioritized)',
  slow_bulky_support: 'Defense > Survivability >> Speed (deprioritized)',
  fast_support: 'Speed > Support > Survivability',
};

function multiplierKeyFor(threshold) {
  if (threshold.threshold_type === 'trickroom_speed') return 'trickroom_speed';
  if (threshold.type === 'speed') return 'speed_tier';
  return threshold.threshold_type.toLowerCase();
}

// Multiplies each threshold's already-computed score by its role multiplier — never
// touches type_value or base_weight, and never recomputes the score from scratch.
function applyRoleMultipliers(thresholds, role) {
  const multipliers = ROLE_MULTIPLIERS[role] || {};
  return thresholds.map((t) => {
    const multiplier = multipliers[multiplierKeyFor(t)] ?? 1.0;
    return { ...t, score: round(t.score * multiplier, 4), role_multiplier: multiplier };
  });
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function guaranteedTier(result) {
  const ko = result.kochance();
  return ko.chance === 1 && ko.n <= 3 ? ko.n : null; // null = not guaranteed within 3 hits
}

// spToEv() is the ONLY place classic-EV numbers exist — @smogon/calc has no native
// Stat Point support, so every SP object needs conversion right before it's handed
// to damage.buildPokemon(). Nowhere else in this module deals in EV terms.
function spObjectToEv(sp) {
  return {
    hp: spToEv(sp?.hp || 0), atk: spToEv(sp?.atk || 0), def: spToEv(sp?.def || 0),
    spa: spToEv(sp?.spa || 0), spd: spToEv(sp?.spd || 0), spe: spToEv(sp?.spe || 0),
  };
}

// The threat matrix only records nature/usage/confidence — real tournament builds'
// items aren't tracked per-attacker anywhere in this DB. We assume a
// maximally-invested attacker (max SP in the relevant offensive stat, boosting
// nature, Life Orb) as a deliberate worst-case-for-the-defender baseline.
function assumedAttackerSide(moveCategory) {
  if (moveCategory === 'Physical') {
    return { nature: 'Adamant', item: 'Life Orb', sp: { hp: 0, atk: SP_CAP_PER_STAT, def: 0, spa: 0, spd: 0, spe: 1 } };
  }
  if (moveCategory === 'Special') {
    return { nature: 'Modest', item: 'Life Orb', sp: { hp: 0, atk: 0, def: 0, spa: SP_CAP_PER_STAT, spd: 0, spe: 1 } };
  }
  return null;
}

function inferOffensiveStat(defenderRow, ownTopMoves, movesByLower) {
  let physical = 0;
  let special = 0;
  for (const m of ownTopMoves || []) {
    const mv = movesByLower[m.move.toLowerCase()];
    if (!mv || !mv.power) continue;
    if (mv.category === 'Physical') physical++;
    else if (mv.category === 'Special') special++;
  }
  if (physical === special) return defenderRow.atk >= defenderRow.spa ? 'atk' : 'spa';
  return physical > special ? 'atk' : 'spa';
}

function describeNatureDistribution(threat) {
  const natures = threat.nature_distribution || [];
  if (natures.length === 0) return 'No nature data available';
  return natures.map((n) => `${Math.round(n.frequency * 100)}% ${n.nature}`).join(' / ');
}

// Binary search over SP_STEPS (0-32) for the lowest SP in `statKey` that flips the
// baseline (0 SP) guaranteed-KO tier to a strictly safer one.
function findSurvivalThreshold({ attackerRow, attackerSide, defenderRow, defenderSideSp, statKey, calcMove, calcField }) {
  function tierAtSp(sp) {
    const spObj = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(defenderSideSp.sp || {}) };
    spObj[statKey] = sp;
    const defenderPokemon = damage.buildPokemon(defenderRow, {
      nature: defenderSideSp.nature, item: defenderSideSp.item, ivs: defenderSideSp.ivs, evs: spObjectToEv(spObj),
    });
    const attackerPokemon = damage.buildPokemon(attackerRow, {
      nature: attackerSide.nature, item: attackerSide.item, evs: spObjectToEv(attackerSide.sp),
    });
    const result = calc.calculate(damage.gen, attackerPokemon, defenderPokemon, calcMove, calcField);
    return guaranteedTier(result);
  }

  const baselineTier = tierAtSp(0);
  if (baselineTier === null || baselineTier > 2) return null; // only OHKO/2HKO baselines are in the defined type-value table

  let lo = 0;
  let hi = SP_STEPS.length - 1;
  let bestIdx = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const tier = tierAtSp(SP_STEPS[mid]);
    const improved = tier === null || tier > baselineTier;
    if (improved) {
      bestIdx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (bestIdx === null) return null; // doesn't flip even at 32 SP investment

  const sp = SP_STEPS[bestIdx];
  const newTier = tierAtSp(sp);
  const thresholdType = baselineTier === 1
    ? (newTier === null ? 'OHKO_prevented' : '2HKO_prevented')
    : '3HKO_prevented';

  return { sp, statKey, baselineTier, newTier, thresholdType };
}

async function findDefensiveThresholds(defenderRow, threatMatrix, overrides) {
  const relevant = threatMatrix.filter(
    (t) => t.attacker.toLowerCase() !== defenderRow.name.toLowerCase() && t.weight > MIN_THREAT_WEIGHT
  );
  if (relevant.length === 0) return [];

  const moveNames = [...new Set(relevant.map((t) => t.move.toLowerCase()))];
  const attackerNames = [...new Set(relevant.map((t) => t.attacker.toLowerCase()))];

  const [{ rows: moveRows }, { rows: attackerRows }] = await Promise.all([
    pool.query('SELECT * FROM moves WHERE LOWER(name) = ANY($1)', [moveNames]),
    pool.query('SELECT * FROM pokemon WHERE LOWER(name) = ANY($1)', [attackerNames]),
  ]);
  const movesByLower = Object.fromEntries(moveRows.map((m) => [m.name.toLowerCase(), m]));
  const attackersByLower = Object.fromEntries(attackerRows.map((r) => [r.name.toLowerCase(), r]));

  const calcField = new calc.Field(Object.assign({}, { gameType: 'Doubles' }, overrides && overrides.fieldOpts ? overrides.fieldOpts : {}));
  const defenderSideSp = {
    nature: overrides.nature,
    item: overrides.item,
    ivs: { hp: 31 }, // Champions always uses 31 IV equivalent
  };

  const thresholds = [];
  for (const threat of relevant) {
    const moveRow = movesByLower[threat.move.toLowerCase()];
    if (!moveRow || moveRow.category === 'Status' || !moveRow.power) continue;

    const attackerRow = attackersByLower[threat.attacker.toLowerCase()];
    if (!attackerRow) continue;

    const attackerSide = assumedAttackerSide(moveRow.category);
    if (!attackerSide) continue;

    const statKey = moveRow.category === 'Physical' ? 'def' : 'spd';
    const calcMove = new calc.Move(damage.gen, threat.move);

    // FIX 4/6: Marginal value check — compute whether defender already survives
    // this attack at 0 SP. If it does, the threshold provides zero marginal value.
    let survivalWithoutInvestment = false;
    try {
      const zeroSpObj = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
      const zeroDefender = damage.buildPokemon(defenderRow, {
        nature: defenderSideSp.nature, item: defenderSideSp.item, ivs: defenderSideSp.ivs,
        evs: spObjectToEv(zeroSpObj),
      });
      const zeroAttacker = damage.buildPokemon(attackerRow, { nature: attackerSide.nature, evs: attackerSide.evs, ivs: attackerSide.ivs });
      const zeroResult = calc.calculate(damage.gen, zeroAttacker, zeroDefender, calcMove, calcField);
      survivalWithoutInvestment = (guaranteedTier(zeroResult) === null);
    } catch (_err) { /* if calc fails, assume not survivable (conservative) */ }

    let found;
    try {
      found = findSurvivalThreshold({ attackerRow, attackerSide, defenderRow, defenderSideSp, statKey, calcMove, calcField });
    } catch (err) {
      continue; // @smogon/calc can't build this attacker/move combo — skip rather than fail the whole request
    }
    if (!found) continue;

    const typeValue = TYPE_VALUES[found.thresholdType];
    const natureReliability = threat.nature_reliability ?? 0.5;

    thresholds.push({
      type: 'defensive',
      threshold_type: found.thresholdType,
      attacker: threat.attacker,
      move: threat.move,
      attacker_item: attackerSide.item,
      attacker_nature: attackerSide.nature,
      stat: found.statKey,
      sp_investment: found.sp,
      type_value: typeValue,
      base_weight: threat.weight,
      nature_reliability: natureReliability,
      score: round(typeValue * threat.weight * natureReliability, 4),
      nature_note: describeNatureDistribution(threat),
      survival_without_investment: survivalWithoutInvestment,
    });
  }

  thresholds.sort((a, b) => b.score - a.score);
  return thresholds;
}

async function findSpeedThresholds(defenderRow, threatMatrix, overrides, role) {
  const relevant = [...threatMatrix]
    .filter((t) => t.attacker.toLowerCase() !== defenderRow.name.toLowerCase())
    .sort((a, b) => b.weight - a.weight);

  const seen = new Set();
  const topAttackers = [];
  for (const t of relevant) {
    const key = t.attacker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topAttackers.push(t);
    if (topAttackers.length >= 10) break;
  }

  const alignment = natureMultiplierFor(overrides.nature, 'spe');
  const baselineSpeed = calcStat(defenderRow.spe, 0, alignment, false);
  const thresholds = [];

  // Speed modifiers fetched once per attacker, reused for both the base-tier
  // scarf-context note below and the dedicated scarf/ability-boost profiles further
  // down — avoids two separate lookups for the same attacker.
  const modifiersByAttacker = {};
  for (const threat of topAttackers) {
    modifiersByAttacker[threat.attacker.toLowerCase()] = await getSpeedModifiers(threat.attacker);
  }

  for (const threat of topAttackers) {
    const { tiers } = await getCommonSpeedTiers(threat.attacker.toLowerCase());
    if (tiers.length === 0) continue; // no real ev_observations for this attacker — no fabricated benchmark

    const modifiers = modifiersByAttacker[threat.attacker.toLowerCase()];
    const showAbilityBoost = !!(modifiers?.ability_boost && modifiers.condition_common
      && modifiers.ability_boost_frequency >= ABILITY_PROFILE_FREQUENCY_THRESHOLD);
    const abilityLabel = showAbilityBoost
      ? modifiers.ability_boost.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : null;

    for (const tier of tiers.slice(0, 3)) {
      if (tier.speed_stat === null) continue;
      const found = findMinSpForStat(tier.speed_stat + 1, defenderRow.spe, alignment, false);
      if (!found) continue; // can't outspeed even at 32 SP investment

      const typeValue = TYPE_VALUES.speed_tier;
      const natureReliability = threat.nature_reliability ?? 0.5;
      const isTie = baselineSpeed === tier.speed_stat;
      const tierLabel = tier.label || `${tier.spe_sp} Spe ${tier.nature}`;

      thresholds.push({
        type: 'speed',
        threshold_type: 'speed_tier',
        benchmark: isTie
          ? `Speed tie with ${threat.attacker} (${tierLabel}) — invest to win consistently`
          : `Outruns ${tierLabel} ${threat.attacker}`,
        attacker: threat.attacker,
        opponent_speed: tier.speed_stat,
        stat: 'spe',
        sp_investment: found.sp,
        final_speed: found.stat,
        opponent_frequency: tier.frequency,
        is_speed_tie: isTie,
        // This base tier only tells the full story for the fraction of this species
        // NOT running Scarf/its boosting ability — surfaced here (not a score change,
        // display only) so the text/JSON output can note it; the Scarf/ability-boost
        // profile itself is a separate entry generated below. Both percentages are
        // independently-sourced measurements (ev_observations item field vs.
        // tournament_teams ability field) from different, non-row-linked samples —
        // never combined into a single fabricated joint distribution.
        scarf_frequency: modifiers?.scarf_common ? modifiers.scarf_frequency : null,
        ability_boost_frequency: showAbilityBoost ? modifiers.ability_boost_frequency : null,
        ability_label: abilityLabel,
        condition_label: showAbilityBoost ? modifiers.condition_label : null,
        type_value: typeValue,
        base_weight: threat.weight,
        nature_reliability: natureReliability,
        score: round(typeValue * threat.weight * natureReliability, 4),
      });
    }
  }

  // SCARF + ABILITY-BOOST profiles — mutually exclusive build archetypes (a Scarf
  // holder isn't also relying on a Speed-boosting ability), so each is generated and
  // labeled independently rather than combined into one flag. Both reachable (met)
  // and unreachable (always-skipped, tagged so optimizeEvs() surfaces them in every
  // spread regardless of that spread's own threshold pool) cases are recorded.
  for (const threat of topAttackers) {
    const modifiers = modifiersByAttacker[threat.attacker.toLowerCase()];
    if (!modifiers) continue;
    const natureReliability = threat.nature_reliability ?? 0.5;

    if (modifiers.scarf_common) {
      const scarfSpeed = modifiers.effective_speed_scarf;
      const scarfPct = Math.round(modifiers.scarf_frequency * 100);
      const found = findMinSpForStat(scarfSpeed + 1, defenderRow.spe, alignment, false);
      if (found) {
        thresholds.push({
          type: 'speed',
          threshold_type: 'speed_tier',
          is_scarf: true,
          benchmark: `Outruns Scarfed ${threat.attacker}`,
          attacker: threat.attacker,
          opponent_speed: scarfSpeed,
          stat: 'spe',
          sp_investment: found.sp,
          final_speed: found.stat,
          opponent_frequency: modifiers.scarf_frequency,
          scarf_frequency: modifiers.scarf_frequency,
          type_value: TYPE_VALUES.speed_tier,
          base_weight: threat.weight,
          nature_reliability: natureReliability,
          score: round(TYPE_VALUES.speed_tier * threat.weight * natureReliability, 4),
        });
      } else {
        // Unreachable within the 66 SP budget regardless of priority — always
        // visible in thresholds_skipped (see optimizeEvs), never competes for budget.
        // `attacker`/`stat`/`sp_investment` are populated (even though this entry
        // never enters greedyAssign) so raw-threshold consumers like recommend.js's
        // attachSpeedNatures() — which runs across the full unfiltered list before
        // any "met" filtering — don't crash on missing fields.
        thresholds.push({
          type: 'speed',
          threshold_type: 'speed_tier',
          attacker: threat.attacker,
          stat: 'spe',
          // Infinity, not null: recommend.js's `met = spreadSp[t.stat] >= t.sp_investment`
          // check would coerce a null RHS to 0 and wrongly read as "already met".
          sp_investment: Infinity,
          opponent_speed: scarfSpeed,
          score: round(TYPE_VALUES.speed_tier * threat.weight * natureReliability, 4),
          _alwaysSkipped: true,
          _skipReason: `scarfed ${threat.attacker} ${scarfSpeed} Speed — unreachable within ${SP_BUDGET_TOTAL} SP budget (${scarfPct}% run scarf)`,
        });
      }
    }

    // Only surfaced when BOTH the weather/condition is commonly active in the meta
    // (condition_common) AND this species commonly runs the boosting ability at all
    // (ability_boost_frequency >= 10% — e.g. Swift Swim vs. Adaptability Basculegion).
    if (modifiers.ability_boost && modifiers.condition_common && modifiers.ability_boost_frequency >= ABILITY_PROFILE_FREQUENCY_THRESHOLD) {
      const abilityLabel = modifiers.ability_boost.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const boostedSpeed = modifiers.effective_speed_boosted;
      const abilityPct = Math.round(modifiers.ability_boost_frequency * 100);
      const found = findMinSpForStat(boostedSpeed + 1, defenderRow.spe, alignment, false);
      if (found) {
        thresholds.push({
          type: 'speed',
          threshold_type: 'speed_tier',
          is_conditional: true,
          condition_label: modifiers.condition_label,
          ability_label: abilityLabel,
          ability_boost_frequency: modifiers.ability_boost_frequency,
          benchmark: `Outruns ${threat.attacker} under ${abilityLabel}`,
          attacker: threat.attacker,
          opponent_speed: boostedSpeed,
          stat: 'spe',
          sp_investment: found.sp,
          final_speed: found.stat,
          opponent_frequency: null,
          type_value: TYPE_VALUES.speed_tier,
          base_weight: threat.weight,
          nature_reliability: natureReliability,
          score: round(TYPE_VALUES.speed_tier * threat.weight * natureReliability, 4),
        });
      } else {
        thresholds.push({
          type: 'speed',
          threshold_type: 'speed_tier',
          attacker: threat.attacker,
          stat: 'spe',
          sp_investment: Infinity,
          opponent_speed: boostedSpeed,
          score: round(TYPE_VALUES.speed_tier * threat.weight * natureReliability, 4),
          _alwaysSkipped: true,
          _skipReason: `${abilityLabel} ${threat.attacker} ${boostedSpeed} Speed in ${modifiers.condition_label} (${abilityPct}% of ${threat.attacker}) — unreachable within ${SP_BUDGET_TOTAL} SP budget`,
        });
      }
    }
  }

  // MIRROR MATCHUPS — the same species can itself be a real speed threat when it's
  // also a common tournament Pokemon; weighted at half the usual rate since you only
  // face the mirror in the (roughly) half of games where both sides run it.
  const selfEntry = threatMatrix.find((t) => t.attacker.toLowerCase() === defenderRow.name.toLowerCase());
  if (selfEntry) {
    const { tiers: mirrorTiers } = await getCommonSpeedTiers(defenderRow.name.toLowerCase());
    const mirrorNatureReliability = selfEntry.nature_reliability ?? 0.5;
    for (const tier of mirrorTiers.slice(0, 3)) {
      if (tier.speed_stat === null) continue;
      const found = findMinSpForStat(tier.speed_stat + 1, defenderRow.spe, alignment, false);
      if (!found) continue; // consistent with normal tiers: unreachable mirror tiers are silently omitted, not flagged

      const mirrorWeight = round(selfEntry.attacker_usage * tier.frequency * 0.5, 4);
      thresholds.push({
        type: 'speed',
        threshold_type: 'speed_tier',
        is_mirror: true,
        benchmark: `Outruns Mirror ${tier.nature} ${defenderRow.name}`,
        attacker: defenderRow.name,
        opponent_speed: tier.speed_stat,
        stat: 'spe',
        sp_investment: found.sp,
        final_speed: found.stat,
        opponent_frequency: tier.frequency,
        type_value: TYPE_VALUES.speed_tier,
        base_weight: mirrorWeight,
        nature_reliability: mirrorNatureReliability,
        score: round(TYPE_VALUES.speed_tier * mirrorWeight * mirrorNatureReliability, 4),
      });
    }
  }

  // TRICK ROOM speed tiers — only for slow bulky roles, and only when TR is common
  // enough in the meta to matter. A Pokemon is TR-relevant against a threat when its
  // OWN (0 SP) speed is already below that threat's — there's no "investing more SP"
  // that helps here (more Speed only makes Trick Room worse), so these are always
  // recorded at sp_investment 0 (a free, already-true fact, never competing for budget).
  if (role && TRICKROOM_ROLES.has(role)) {
    const metaContext = await getMetaContext();
    if (metaContext.trickroom_prevalence > TRICKROOM_PREVALENCE_THRESHOLD) {
      for (const threat of topAttackers) {
        const { tiers } = await getCommonSpeedTiers(threat.attacker.toLowerCase());
        const natureReliability = threat.nature_reliability ?? 0.5;
        for (const tier of tiers.slice(0, 2)) {
          if (tier.speed_stat === null) continue;
          if (!trickroomRelevant(baselineSpeed, tier.speed_stat)) continue; // already too fast even at 0 SP

          thresholds.push({
            type: 'speed',
            threshold_type: 'trickroom_speed',
            benchmark: `TR: ${defenderRow.name} ${baselineSpeed} < ${tier.nature} ${threat.attacker} ${tier.speed_stat} — moves first in TR`,
            attacker: threat.attacker,
            opponent_speed: tier.speed_stat,
            stat: 'spe',
            sp_investment: 0,
            final_speed: baselineSpeed,
            opponent_frequency: tier.frequency,
            trickroom_prevalence: metaContext.trickroom_prevalence,
            type_value: TYPE_VALUES.trickroom_speed,
            base_weight: threat.weight,
            nature_reliability: natureReliability,
            score: round(TYPE_VALUES.trickroom_speed * threat.weight * natureReliability, 4),
          });
        }
      }
    }
  }

  thresholds.sort((a, b) => b.score - a.score);
  return thresholds;
}

async function findOffensiveThresholds(defenderRow, ownTopMoves, ownMovesByLower, overrides) {
  const damagingMoves = (ownTopMoves || [])
    .map((m) => ({ ...m, row: ownMovesByLower[m.move.toLowerCase()] }))
    .filter((m) => m.row && m.row.power && m.row.category !== 'Status');
  if (damagingMoves.length === 0) return [];

  const { rows: targets } = await pool.query(
    'SELECT pokemon_name, usage_percent FROM usage_stats WHERE usage_percent > $1 ORDER BY usage_percent DESC LIMIT 20',
    [HIGH_USAGE_THRESHOLD]
  );
  if (targets.length === 0) return [];

  const targetNames = targets.map((t) => t.pokemon_name.toLowerCase());
  const { rows: targetRows } = await pool.query('SELECT * FROM pokemon WHERE LOWER(name) = ANY($1)', [targetNames]);
  const targetsByLower = Object.fromEntries(targetRows.map((r) => [r.name.toLowerCase(), r]));

  const calcField = new calc.Field(Object.assign({}, { gameType: 'Doubles' }, overrides && overrides.fieldOpts ? overrides.fieldOpts : {}));
  const attackerNature = overrides.nature || null;
  const thresholds = [];

  for (const target of targets) {
    const targetLower = target.pokemon_name.toLowerCase();
    const targetRow = targetsByLower[targetLower]; // Mega-form gap: some targets have no `pokemon` row — skip those
    if (!targetRow) continue;

    const observed = await getMostCommonSpread(targetLower);
    const hasObservations = observed !== null;
    const targetSp = observed ? observed.sp : { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    const targetNature = observed ? observed.nature : null;
    const targetEvs = spObjectToEv(targetSp);

    let best = null;
    for (const move of damagingMoves) {
      const statKey = move.row.category === 'Physical' ? 'atk' : 'spa';
      const calcMove = new calc.Move(damage.gen, move.move);

      function tierAtSp(sp) {
        const attackerSpObj = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
        attackerSpObj[statKey] = sp;
        const attackerPokemon = damage.buildPokemon(defenderRow, { nature: attackerNature, item: overrides.item, evs: spObjectToEv(attackerSpObj) });
        const targetPokemon = damage.buildPokemon(targetRow, { nature: targetNature, evs: targetEvs });
        const result = calc.calculate(damage.gen, attackerPokemon, targetPokemon, calcMove, calcField);
        return guaranteedTier(result);
      }

      let baselineTier;
      try { baselineTier = tierAtSp(0); } catch (err) { continue; }
      if (baselineTier === 1) continue; // already a guaranteed OHKO at 0 investment — nothing to optimize

      const wantTier = baselineTier === 2 ? 1 : 2; // 2HKO -> OHKO, or (3HKO/none) -> 2HKO
      let lo = 0;
      let hi = SP_STEPS.length - 1;
      let bestIdx = null;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        let tier;
        try { tier = tierAtSp(SP_STEPS[mid]); } catch (err) { tier = null; }
        const reached = tier !== null && tier <= wantTier;
        if (reached) { bestIdx = mid; hi = mid - 1; } else { lo = mid + 1; }
      }
      if (bestIdx === null) continue;

      const candidate = {
        move: move.move,
        moveConfidence: move.confidence,
        statKey,
        sp: SP_STEPS[bestIdx],
        thresholdType: wantTier === 1 ? 'OHKO_achieved' : '2HKO_achieved',
      };
      if (!best || candidate.sp < best.sp) best = candidate;
    }
    if (!best) continue;

    const typeValue = TYPE_VALUES[best.thresholdType];
    const baseWeight = round((parseFloat(target.usage_percent) / 100) * best.moveConfidence * (hasObservations ? 1.0 : 0.5), 4);

    thresholds.push({
      type: 'offensive',
      threshold_type: best.thresholdType,
      target: target.pokemon_name,
      move: best.move,
      stat: best.statKey,
      sp_investment: best.sp,
      target_usage: round(parseFloat(target.usage_percent) / 100, 4),
      move_confidence: best.moveConfidence,
      has_target_observations: hasObservations,
      type_value: typeValue,
      base_weight: baseWeight,
      nature_reliability: 1.0, // our own chosen nature isn't observation-uncertain
      score: round(typeValue * baseWeight, 4),
    });
  }

  thresholds.sort((a, b) => b.score - a.score);
  return thresholds;
}

function describeThresholdLabel(t) {
  if (t.type === 'defensive') return `${t.attacker} ${t.move}`;
  if (t.type === 'speed') return t.benchmark;
  return `${t.threshold_type === 'OHKO_achieved' ? 'OHKO' : '2HKO'} on ${t.target} with ${t.move}`;
}

function toMetEntry(t) {
  const base = { threshold_type: t.threshold_type, type_value: t.type_value, base_weight: t.base_weight, nature_reliability: t.nature_reliability, score: t.score };
  if (t.type === 'defensive') return { survives: describeThresholdLabel(t), nature_note: t.nature_note, ...base };
  if (t.type === 'speed') return { benchmark: t.benchmark, required_spe_sp: t.sp_investment, final_speed: t.final_speed, opponent_frequency: t.opponent_frequency, ...base };
  return { achieves: describeThresholdLabel(t), target_usage: t.target_usage, move_confidence: t.move_confidence, ...base };
}

function toSkippedEntry(t, reason) {
  const key = t.type === 'defensive' ? 'would_survive' : t.type === 'speed' ? 'would_outrun' : 'would_achieve';
  return { [key]: describeThresholdLabel(t), threshold_type: t.threshold_type, score: t.score, reason };
}

// Scarf/ability-boost speed profiles that are unreachable within the 66 SP budget
// regardless of priority — these never had a `benchmark`/`attacker` populated (see
// findSpeedThresholds), so describeThresholdLabel() can't build a description for
// them the way toSkippedEntry() does; the _skipReason string IS the full description.
// always_skipped marks these for recommend.js's text formatter to render as
// `✗ {reason}` directly instead of the generic "-- TIER (score, budget exhausted)".
function toAlwaysSkippedEntry(t) {
  return { threshold_type: t.threshold_type, score: t.score, reason: t._skipReason, always_skipped: true };
}

// Applies a threshold's required SP to `sp` if there's budget for the delta above
// whatever's already invested in that stat (a stronger, already-applied threshold on
// the same stat can make a weaker one free). Mutates `sp`, does not mutate `remaining`.
function applyThreshold(t, sp, remaining) {
  const statKey = t.stat;
  const needed = t.sp_investment;
  if (sp[statKey] >= needed) return { applied: true, spent: 0, alreadyMet: true };
  const additional = needed - sp[statKey];
  if (additional > remaining) return { applied: false, spent: 0, alreadyMet: false };
  sp[statKey] = needed;
  return { applied: true, spent: additional, alreadyMet: false };
}

function noteForStat(statKey, spValue, defenderRow, overrides, reasonSuffix) {
  const isHp = statKey === 'hp';
  const alignment = isHp ? 1.0 : natureMultiplierFor(overrides.nature, statKey);
  const stat = calcStat(defenderRow[statKey], spValue, alignment, isHp);
  return `${spValue} ${STAT_LABELS[statKey]} SP — hits breakpoint at ${stat} ${STAT_LABELS[statKey]}${reasonSuffix ? ` (minimum to ${statKey === 'spe' ? 'outrun' : 'survive'} ${reasonSuffix})` : ''}`;
}

function greedyAssign(thresholdPool, sp, remaining, defenderRow, overrides, notes, met, skipped, speedBenchmarks) {
  const sorted = [...thresholdPool].sort((a, b) => b.score - a.score);
  for (const rawT of sorted) {
    // REGRESSION C: skip thresholds where the Pokemon already survives at 0 SP
    if (rawT.survival_without_investment) {
      skipped.push(toSkippedEntry(rawT, 'already survives at 0 SP — no investment needed'));
      continue;
    }
    // REGRESSION D: Focus Sash holders get heavily down-weighted (0.1x) for
    // OHKO prevention — sash absorbs one hit, so investing SP to prevent that
    // same OHKO is wasteful. 2HKO/3HKO prevention still matters (sash doesn't
    // absorb follow-up hits). Per interview Q5: heavily down-weighted, not excluded.
    const isSashOhko = rawT.threshold_type === 'ohko_prevented' && (overrides.item || '').toLowerCase() === 'focus sash';
    const t = isSashOhko ? { ...rawT, score: rawT.score * 0.1 } : rawT;
    const { applied, spent, alreadyMet } = applyThreshold(t, sp, remaining);
    if (applied) {
      remaining -= spent;
      met.push(toMetEntry(t));
      if (t.type === 'speed') speedBenchmarks.push(toMetEntry(t));
      if (!alreadyMet && spent > 0) {
        notes.push(noteForStat(t.stat, sp[t.stat], defenderRow, overrides, describeThresholdLabel(t)));
      }
    } else {
      skipped.push(toSkippedEntry(t, 'SP budget exhausted'));
    }
  }
  return remaining;
}

// HP benefits every defensive threshold at once rather than the one being
// explicitly optimized — a documented heuristic, not something re-derived from the
// threat matrix. Spends up to 30% of what's left.
function allocateHpRemainder(sp, remaining, defenderRow, overrides, notes) {
  if (remaining <= 0) return remaining;
  const hpBudget = Math.floor(remaining * 0.3);
  if (hpBudget <= 0) return remaining;
  const aligned = snapToBreakpoint(sp.hp + hpBudget, defenderRow.hp, 1.0, true);
  const spent = aligned.sp - sp.hp;
  if (spent <= 0) return remaining;
  sp.hp = aligned.sp;
  notes.push(`${aligned.sp} HP SP — hits breakpoint at ${aligned.stat} HP`);
  return remaining - spent;
}

function allocateStatRemainder(statKey, sp, remaining, defenderRow, overrides, notes, label) {
  const capRemaining = Math.max(SP_CAP_PER_STAT - sp[statKey], 0);
  const budget = Math.min(remaining, capRemaining);
  if (budget <= 0) return remaining;
  const alignment = natureMultiplierFor(overrides.nature, statKey);
  const aligned = snapToBreakpoint(sp[statKey] + budget, defenderRow[statKey], alignment, false);
  const spent = aligned.sp - sp[statKey];
  if (spent <= 0) return remaining;
  sp[statKey] = aligned.sp;
  notes.push(`${aligned.sp} ${STAT_LABELS[statKey]} SP — hits breakpoint at ${aligned.stat} ${STAT_LABELS[statKey]}${label ? ` (${label})` : ''}`);
  return remaining - spent;
}

function finalizeSpread(label, sp, notes, met, skipped, speedBenchmarks, remaining) {
  if (remaining > 0) notes.push(`${remaining} SP left unspent — no further breakpoint benefit available within budget`);
  const totalSp = Object.values(sp).reduce((a, b) => a + b, 0);
  return {
    label,
    sp,
    total_sp: totalSp,
    thresholds_met: met,
    thresholds_skipped: skipped,
    speed_benchmarks: speedBenchmarks,
    sp_notes: notes,
  };
}

// Spread 1: greedily invest from the highest-scoring threshold downward across
// ALL threshold types (defensive + speed + offensive), breakpoint-snapped, then
// spend remaining budget on HP, the primary offensive stat, then Speed.
function buildOptimizedSpread(defenderRow, allThresholds, offensiveStat, overrides) {
  const sp = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const notes = [];
  const met = [];
  const skipped = [];
  const speedBenchmarks = [];
  let remaining = SP_BUDGET_TOTAL;

  remaining = greedyAssign(allThresholds, sp, remaining, defenderRow, overrides, notes, met, skipped, speedBenchmarks);
  remaining = allocateHpRemainder(sp, remaining, defenderRow, overrides, notes);
  remaining = allocateStatRemainder(offensiveStat, sp, remaining, defenderRow, overrides, notes, 'remaining budget');
  remaining = allocateStatRemainder('spe', sp, remaining, defenderRow, overrides, notes, 'remaining budget');

  return finalizeSpread('Optimized', sp, notes, met, skipped, speedBenchmarks, remaining);
}

// Spread 2: defensive + speed thresholds only (no offensive-vs-target thresholds
// considered), remainder to the primary offensive stat.
function buildSurvivalSpread(defenderRow, allThresholds, offensiveStat, overrides) {
  const sp = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const notes = [];
  const met = [];
  const skipped = [];
  const speedBenchmarks = [];
  let remaining = SP_BUDGET_TOTAL;

  const pool_ = allThresholds.filter((t) => t.type === 'defensive' || t.type === 'speed');
  remaining = greedyAssign(pool_, sp, remaining, defenderRow, overrides, notes, met, skipped, speedBenchmarks);
  remaining = allocateHpRemainder(sp, remaining, defenderRow, overrides, notes);
  remaining = allocateStatRemainder(offensiveStat, sp, remaining, defenderRow, overrides, notes, 'remaining budget');

  return finalizeSpread('Survival-focused', sp, notes, met, skipped, speedBenchmarks, remaining);
}

// Spread 3: maximize the primary offensive stat first, then invest the minimum
// SP for only the single highest-scoring defensive threshold, then Speed. No HP.
function buildOffensiveSpread(defenderRow, allThresholds, offensiveStat, overrides) {
  const sp = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const notes = [];
  const met = [];
  const skipped = [];
  let remaining = SP_BUDGET_TOTAL;

  const alignment = natureMultiplierFor(overrides.nature, offensiveStat);
  const maxAligned = snapToBreakpoint(Math.min(remaining, SP_CAP_PER_STAT), defenderRow[offensiveStat], alignment, false);
  sp[offensiveStat] = maxAligned.sp;
  remaining -= maxAligned.sp;
  notes.push(`${maxAligned.sp} ${STAT_LABELS[offensiveStat]} SP — hits breakpoint at ${maxAligned.stat} ${STAT_LABELS[offensiveStat]} (maximized first for Offensive-focused)`);

  const topDefensive = [...allThresholds].filter((t) => t.type === 'defensive').sort((a, b) => b.score - a.score)[0];
  if (topDefensive) {
    const { applied, spent } = applyThreshold(topDefensive, sp, remaining);
    if (applied) {
      remaining -= spent;
      met.push(toMetEntry(topDefensive));
      if (spent > 0) notes.push(noteForStat(topDefensive.stat, sp[topDefensive.stat], defenderRow, overrides, describeThresholdLabel(topDefensive)));
    } else {
      skipped.push(toSkippedEntry(topDefensive, 'SP budget exhausted after maximizing the offensive stat'));
    }
  }

  remaining = allocateStatRemainder('spe', sp, remaining, defenderRow, overrides, notes, 'remaining budget');

  return finalizeSpread('Offensive-focused', sp, notes, met, skipped, [], remaining);
}

// --- Evolutionary (real-damage-calc) spread search, layered on top of the greedy
// threshold system above ---------------------------------------------------------
// The genetic search in spread_optimizer.js/spread_scorer.js is expensive (tens of
// seconds to a few minutes even with heavy caching — it runs hundreds to
// thousands of real @smogon/calc evaluations). It is never awaited inline on a
// request: a cache miss kicks it off in the background and the caller gets the
// (already-fast, already-correct) greedy spreads immediately; a cache hit swaps
// the greedy SP allocation for the evolutionary one. This is why the greedy
// algorithm above is kept, not replaced — it's the permanent fallback path, not
// a temporary bridge.
const EVOLUTIONARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const evolutionaryCache = new Map(); // `${pokemonLower}|${natureLower}|${itemLower}` -> { computedAt, result }
const evolutionaryInFlight = new Map(); // same key -> in-progress Promise, de-dupes concurrent triggers

// `item` is optional (defaults to a stable 'default' segment) so every existing
// caller that only ever dealt in pokemon+nature — GET /api/recommend/evs and its
// /validate sibling — keeps resolving to the exact same key it always has;
// POST /api/team/build is the first caller that actually varies it, since a
// Pokemon's optimal spread genuinely differs by assigned item (Choice Scarf vs.
// Leftovers change what Speed/SpD investment is even worth scoring highly — see
// spread_scorer.js).
// `teamBuild` (FIX 3) is included in the key so a team-build request's deeper
// (300/60/±8) search and an individual request's normal (200/40/±5) search for
// the same pokemon+nature+item never collide in the shared evolutionaryCache —
// otherwise whichever ran first would silently serve its own search depth to
// the other caller instead of the depth it actually asked for.
// SCORER_VERSION (spread_scorer.js) is folded in here so a scoring-formula change
// (aggression_multiplier/TYPE_VALUES/etc.) automatically invalidates every stale
// cached result instead of silently serving pre-change scores — no manual cache
// clear or server restart required. A prior task explicitly asked for this same
// wiring but was scoped to a single file that didn't include ev_optimizer.js;
// this task has no such restriction, so it's now real and load-bearing.
function evolutionaryCacheKey(pokemonLower, nature, item, teamBuild = false) {
  return `${pokemonLower}|${(nature || 'default').toLowerCase()}|${(item || 'default').toLowerCase()}|${teamBuild ? 'team' : 'solo'}|v${SCORER_VERSION}`;
}

function getEvolutionaryStatus(pokemonLower, nature, item, teamBuild = false) {
  const key = evolutionaryCacheKey(pokemonLower, nature, item, teamBuild);
  const cached = evolutionaryCache.get(key);
  if (cached && Date.now() - cached.computedAt < EVOLUTIONARY_CACHE_TTL_MS) {
    return { status: 'optimal', key, result: cached.result };
  }
  return { status: 'computing', key, result: null };
}

// Fire-and-forget: errors are swallowed (logged) rather than thrown, since this
// runs detached from any request/response cycle — the greedy fallback stays
// authoritative for this pokemon+nature until a future request retries and
// succeeds. Never runs two computations for the same key concurrently.
function triggerEvolutionaryComputation(key, pokemon, nature, role, threatMatrix, metaContext, observationCount, item, teamBuild = false, fieldOpts) {
  if (evolutionaryInFlight.has(key)) return;
  const promise = findOptimalSpread(pokemon, nature, role, threatMatrix, metaContext, observationCount, item, teamBuild, null, fieldOpts)
    .then((result) => {
      evolutionaryCache.set(key, { computedAt: Date.now(), result });
    })
    .catch(() => {
      // swallowed — greedy fallback remains authoritative; a later request re-triggers
    })
    .finally(() => {
      evolutionaryInFlight.delete(key);
    });
  evolutionaryInFlight.set(key, promise);
}

function categoryContributionSum(evoSpread, category) {
  return (evoSpread.thresholds_met || [])
    .filter((t) => t.category === category)
    .reduce((sum, t) => sum + t.contribution, 0);
}

// Picks the highest-scoring candidate by `scoreFn` that isn't already in `used`,
// falling back to reuse only if every candidate has already been claimed (never
// happens with 5 candidates and 3 slots, but kept for safety).
function pickDistinctBy(candidates, used, scoreFn) {
  const sorted = [...candidates].sort((a, b) => scoreFn(b) - scoreFn(a));
  return sorted.find((c) => !used.has(c)) || sorted[0];
}

// Maps the evolutionary top 5 to the same 3 named roles the greedy spreads use:
// "Optimized" = best overall score (rank 1, real damage-calc based); "Survival-
// focused" = highest defensive-category contribution; "Offensive-focused" =
// highest offensive+speed-category contribution. All three distinct where possible.
function mapEvolutionaryToDisplaySpreads(evolutionarySpreads) {
  const withComposition = evolutionarySpreads.map((s) => ({
    ...s,
    _defensiveScore: categoryContributionSum(s, 'defensive'),
    _offensiveSpeedScore: categoryContributionSum(s, 'offensive') + categoryContributionSum(s, 'speed'),
  }));

  const used = new Set();
  const optimized = [...withComposition].sort((a, b) => b.score - a.score)[0];
  used.add(optimized);
  const survival = pickDistinctBy(withComposition, used, (s) => s._defensiveScore);
  used.add(survival);
  const offensive = pickDistinctBy(withComposition, used, (s) => s._offensiveSpeedScore);
  used.add(offensive);

  return { Optimized: optimized, 'Survival-focused': survival, 'Offensive-focused': offensive };
}

// Swaps a greedy-built raw spread's SP allocation for the evolutionary one.
// thresholds_skipped is trimmed to just the allocation-independent _alwaysSkipped
// entries (Scarf/ability-boost budget-unreachable — see design decisions) since
// the greedy "budget exhausted" skip entries were decided under a DIFFERENT SP
// allocation and would be stale/misleading if left attached to this one; sp_notes
// is likewise replaced with a single line pointing at the real evaluation instead
// of the greedy breakpoint-by-breakpoint justifications, which no longer apply.
function applyEvolutionaryOverride(rawSpread, evoSpread, alwaysSkipped) {
  return {
    ...rawSpread,
    sp: evoSpread.sp,
    total_sp: evoSpread.total_sp,
    thresholds_skipped: [...alwaysSkipped],
    sp_notes: [
      `Evolutionary search (real @smogon/calc evaluation): score ${evoSpread.score} — ${(evoSpread.thresholds_met || []).length} real thresholds met, ${(evoSpread.thresholds_missed || []).length} missed`,
    ],
    evolutionary_score: evoSpread.score,
    evolutionary_thresholds_met: evoSpread.thresholds_met,
    evolutionary_thresholds_missed: evoSpread.thresholds_missed,
  };
}

async function optimizeEvs(pokemonName, overrides = {}) {
  const { rows } = await pool.query('SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)', [pokemonName]);
  if (rows.length === 0) return null;
  const defenderRow = rows[0];

  // Role classification happens first — everything downstream (threshold scoring,
  // spread order/labels) depends on it.
  const roleResult = await classifyRole(pokemonName);
  const role = roleResult.role;

  const moveRecPath = path.join(__dirname, '..', 'ml', 'models', 'move_recommendations.json');
  let ownTopMoves = [];
  if (fs.existsSync(moveRecPath)) {
    const moveRec = JSON.parse(fs.readFileSync(moveRecPath, 'utf8'));
    ownTopMoves = moveRec.pokemon[pokemonName.toLowerCase()]?.moves?.slice(0, 4) || [];
  }
  const ownMoveNames = ownTopMoves.map((m) => m.move.toLowerCase());
  const { rows: ownMoveRows } = ownMoveNames.length
    ? await pool.query('SELECT * FROM moves WHERE LOWER(name) = ANY($1)', [ownMoveNames])
    : { rows: [] };
  const ownMovesByLower = Object.fromEntries(ownMoveRows.map((m) => [m.name.toLowerCase(), m]));
  const offensiveStat = inferOffensiveStat(defenderRow, ownTopMoves, ownMovesByLower);
  const offensiveRole = offensiveStat === 'atk' ? 'physical_attacker' : 'special_attacker';

  const [threatMatrix, metaContext] = await Promise.all([getThreatMatrix(), getMetaContext()]);

  const [defensiveThresholds, speedThresholds, offensiveThresholds, observationCount] = await Promise.all([
    findDefensiveThresholds(defenderRow, threatMatrix, overrides),
    findSpeedThresholds(defenderRow, threatMatrix, overrides, role),
    findOffensiveThresholds(defenderRow, ownTopMoves, ownMovesByLower, overrides),
    getObservationCount(pokemonName.toLowerCase()),
  ]);

  let allThresholds = [...defensiveThresholds, ...speedThresholds, ...offensiveThresholds];
  // Role multipliers scale the existing score only — see applyRoleMultipliers.
  allThresholds = applyRoleMultipliers(allThresholds, role);

  // Scarf/ability-boost speed profiles that are mathematically unreachable within
  // the 66 SP budget never compete for budget in any spread's greedyAssign() —
  // pulled out here and appended to EVERY spread's thresholds_skipped uniformly,
  // rather than depending on whichever spread-building function happens to call
  // greedyAssign() at all (buildOffensiveSpread doesn't, which is why these were
  // silently vanishing from that one spread before this fix).
  const alwaysSkipped = allThresholds.filter((t) => t._alwaysSkipped).map(toAlwaysSkippedEntry);
  allThresholds = allThresholds.filter((t) => !t._alwaysSkipped);

  // A concrete nature is required to run/cache the evolutionary search even when
  // the caller didn't supply one — same 3-tier fallback chain the rest of the
  // recommendation engine already uses (ev_observations primary nature -> mixed ->
  // neutral "Hardy"), not a new assumption invented for this feature.
  const evoNature = overrides.nature || (await getNatureDistribution(pokemonName.toLowerCase())).primaryNature || 'Hardy';
  const evoItem = overrides.item || null;
  const evoStatus = getEvolutionaryStatus(pokemonName.toLowerCase(), evoNature, evoItem);
  triggerEvolutionaryComputation(evoStatus.key, defenderRow, evoNature, role, threatMatrix, metaContext, observationCount, evoItem, false, overrides.fieldOpts);

  const baseResult = {
    pokemon: defenderRow.name,
    offensive_role: offensiveRole,
    role,
    role_confidence: roleResult.confidence,
    role_signals: roleResult.signals,
    meta_context: metaContext,
    sp_observations: observationCount,
    sp_budget: SP_BUDGET_TOTAL,
    spread_status: evoStatus.status, // 'optimal' | 'computing' — mirrored onto the X-Spread-Status response header
  };

  if (allThresholds.length === 0) {
    return { ...baseResult, spreads: [], thresholds_found: 0 };
  }

  const rawSpreadsByKey = {
    Optimized: buildOptimizedSpread(defenderRow, allThresholds, offensiveStat, overrides),
    'Survival-focused': buildSurvivalSpread(defenderRow, allThresholds, offensiveStat, overrides),
    'Offensive-focused': buildOffensiveSpread(defenderRow, allThresholds, offensiveStat, overrides),
  };
  for (const key of Object.keys(rawSpreadsByKey)) {
    rawSpreadsByKey[key].thresholds_skipped.push(...alwaysSkipped);
  }

  // Cache hit: swap each of the 3 displayed spreads' SP allocation for the
  // evolutionary search's real-damage-calc-optimal one (see
  // mapEvolutionaryToDisplaySpreads/applyEvolutionaryOverride above). Cache miss:
  // the greedy spreads built above stand as the immediate-response fallback while
  // triggerEvolutionaryComputation() runs in the background for next time.
  if (evoStatus.status === 'optimal' && evoStatus.result?.spreads?.length) {
    const mapped = mapEvolutionaryToDisplaySpreads(evoStatus.result.spreads);
    for (const key of Object.keys(rawSpreadsByKey)) {
      if (mapped[key]) rawSpreadsByKey[key] = applyEvolutionaryOverride(rawSpreadsByKey[key], mapped[key], alwaysSkipped);
    }
  }

  const plan = SPREAD_PLAN_BY_ROLE[role] || SPREAD_PLAN_BY_ROLE.fast_offense;
  const rolePriority = ROLE_PRIORITY_TEXT[role] || ROLE_PRIORITY_TEXT.fast_offense;
  const spreads = plan.map(([originalKey, displayLabel]) => ({
    ...rawSpreadsByKey[originalKey],
    label: displayLabel,
    spread_label: displayLabel,
    role_priority: rolePriority,
  }));

  return { ...baseResult, spreads, thresholds_found: allThresholds.length };
}

// --- Synchronous-wait variant for POST /api/team/build ---------------------------
// optimizeEvs() above deliberately never awaits the evolutionary search inline —
// a cache miss returns the (fast, unchanged) greedy fallback immediately and the
// search runs in the background for next time. Team building explicitly needs the
// real, item-aware evolutionary result for every one of 6 Pokemon in the same
// request (the task's own "run all 6 in parallel via Promise.all to stay under
// 30s" instruction only makes sense if each one is actually being awaited), so
// this variant awaits findOptimalSpread() directly on a cache miss instead of
// firing it in the background — while still reading from and writing to the exact
// same evolutionaryCache/evolutionaryInFlight every other caller uses, so a normal
// GET /api/recommend/evs request for the same pokemon+nature+item still benefits
// from (or contributes to) the same cached result.
// Runs findOptimalSpread() in a separate worker thread instead of in-process —
// see evolutionary_worker.js for why: the search is ~19s of genuinely synchronous
// CPU work, and getOrComputeEvolutionarySpread's whole reason for existing is
// POST /api/team/build awaiting 6 of these via Promise.all(); Promise.all() alone
// only interleaves at await points, so 6 in-process calls serialize to ~6x cost
// (measured: ~115s). A worker per Pokemon gives real OS-thread parallelism, which
// is what actually gets 6 searches under the endpoint's ~30s budget.
function runEvolutionarySearchInWorker(pokemonRow, nature, role, threatMatrix, metaContext, observationCount, item, teamBuild = false, seeds = null, fieldOpts) {
  return new Promise((resolve, reject) => {
    const workerData = { pokemonRow, nature, role, threatMatrix, metaContext, observationCount, item, teamBuild, fieldOpts };
    if (seeds) workerData.seeds = seeds;
    const worker = new Worker(path.join(__dirname, 'evolutionary_worker.js'), { workerData });
    worker.once('message', (msg) => {
      worker.terminate();
      if (msg.ok) resolve(msg.result);
      else {
        const e = new Error(msg.error);
        if (msg.stack) e.stack = msg.stack;
        reject(e);
      }
    });
    worker.once('error', (err) => {
      worker.terminate();
      reject(err);
    });
  });
}

async function getOrComputeEvolutionarySpread(pokemonName, overrides = {}) {
  const { rows } = await pool.query('SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)', [pokemonName]);
  if (rows.length === 0) return null;
  const defenderRow = rows[0];

  const roleResult = await classifyRole(pokemonName);
  const role = roleResult.role;

  const [threatMatrix, metaContext, observationCount] = await Promise.all([
    getThreatMatrix(),
    getMetaContext(),
    getObservationCount(pokemonName.toLowerCase()),
  ]);

  const nature = overrides.nature || (await getNatureDistribution(pokemonName.toLowerCase())).primaryNature || 'Hardy';
  const item = overrides.item || null;
  const fieldOpts = overrides.fieldOpts || null;
  // FIX 3: team builds request a deeper search (300/60/±8 vs. 200/40/±5) — kept
  // out of the shared cache key's `solo` bucket so a team-build request never
  // silently gets served an individual-request-depth cached result (or vice
  // versa) for the same pokemon+nature+item.
  const teamBuild = !!overrides.teamBuild;
  const key = evolutionaryCacheKey(pokemonName.toLowerCase(), nature, item, teamBuild);

  const cached = evolutionaryCache.get(key);
  if (cached && Date.now() - cached.computedAt < EVOLUTIONARY_CACHE_TTL_MS) {
    return { pokemon: defenderRow.name, pokemonRow: defenderRow, role, roleResult, nature, item, result: cached.result, seeds_used: cached.result?.seeds_used || [], from_cache: true };
  }

  // Another request (e.g. a concurrent plain GET /api/recommend/evs) may already
  // have this exact key's search in flight via the background trigger path —
  // await that one instead of starting a redundant second search.
  if (evolutionaryInFlight.has(key)) {
    await evolutionaryInFlight.get(key).catch(() => {});
    const nowCached = evolutionaryCache.get(key);
    if (nowCached) return { pokemon: defenderRow.name, pokemonRow: defenderRow, role, roleResult, nature, item, result: nowCached.result, seeds_used: nowCached.result?.seeds_used || [], from_cache: true };
  }

  const promise = runEvolutionarySearchInWorker(defenderRow, nature, role, threatMatrix, metaContext, observationCount, item, teamBuild, overrides.seeds || null, fieldOpts);
  evolutionaryInFlight.set(key, promise);
  let result;
  try {
    result = await promise;
    evolutionaryCache.set(key, { computedAt: Date.now(), result });
  } finally {
    evolutionaryInFlight.delete(key);
  }
  return { pokemon: defenderRow.name, pokemonRow: defenderRow, role, roleResult, nature, item, result, seeds_used: result?.seeds_used || [], from_cache: false };
}

module.exports = {
  optimizeEvs,
  getOrComputeEvolutionarySpread,
  findDefensiveThresholds,
  findSpeedThresholds,
  findOffensiveThresholds,
  findSurvivalThreshold,
  applyRoleMultipliers,
  getEvolutionaryStatus,
  SP_BUDGET_TOTAL,
  MIN_THREAT_WEIGHT,
  ROLE_PRIORITY_TEXT,
  ROLE_MULTIPLIERS,
};
