// OHKO remedies: for every real losing exchange the MATCHUP ANALYSIS section
// already surfaces as a bare damage number, this module answers the question
// the report has never answered — "what do we do about it, or is there
// nothing to do." See logs/BRIEF_ohko_remedies.md for the full spec this
// implements; the section numbers referenced in comments below are that
// brief's.
//
// Deliberately independent of team_analyzer.js's analyzeMatchups()/ohko_risks
// rather than extending it: that pipeline caps at 20 results, fetches only 4
// moves per candidate, and — a deliberate, already-litigated design choice
// (see team_analyzer.js's own comment on FIX 6) — aggregates "worst case
// across the top-3 real observed attacker spreads" into one bucket that
// conflates a GUARANTEED OHKO (min% >= 100) with a merely POSSIBLE one
// (min% < 100 <= max%). This module keeps that same worst-case-build
// convention (it is the right single representative build for a given
// (attacker, move, member) tuple — the brief's own dedup key has no build
// dimension) but separates guaranteed from possible explicitly, and searches
// a real remedy for every guaranteed one.
const { calcStat, natureMultiplierFor, SP_BUDGET_TOTAL, SP_CAP_PER_STAT } = require('./stat_formula');
const { validateSpread } = require('./spread_optimizer');
const { weatherChangesDamage, resolveTypeFor } = require('./weather_rules');
const { RESIST_BERRIES, MULTI_HIT_MOVES } = require('./nerd_of_now_calc');
const { getSpeciesRow, getCommonItems, getTopDamageAffectingItem, getCommonSpeedTiers } = require('./ev_observations');
const { getRealAbilityFrequency } = require('./item_optimizer');
const { getTopAttackerSpreads, buildAttackerBuildLabel, scoreSpread } = require('./spread_scorer');
const { effectivenessAgainst } = require('./typeChart');
const { round } = require('./format');
const {
  damagePercentRange, effectiveSpeed, getTop50UsageRows, batchFetchTopMoveData,
} = require('./team_analyzer');

// Broader than the 4 moves team_analyzer.js's ohko_risks fetches, and broader
// than the 10 it currently DISPLAYS (the brief: "not the ten currently
// displayed") — but not literally every move a species has ever run (some
// species have 15 in move_recommendations.json, most of them noise). 10 is a
// disclosed, deliberate bound distinct from the display cap it's replacing.
const MOVES_PER_CANDIDATE = 10;

// Nature that boosts each defending stat, in the order tried. Only one is
// ever needed per stat, but a Pokemon's OWN offensive stat might already be
// the one that nature would hinder for one of the two candidates, so both are
// tried and the cheaper fix wins.
const BOOSTING_NATURES = { def: ['Bold', 'Impish'], spd: ['Calm', 'Careful'] };

const RESIST_BERRY_FOR_TYPE = Object.fromEntries(
  Object.entries(RESIST_BERRIES).map(([berry, type]) => [type, berry])
);

const lower = (s) => String(s || '').toLowerCase();
const isMegaMember = (member) => (member.pokemon || '').includes('-Mega');
const isMultiHitMove = (moveName) => !!MULTI_HIT_MOVES[lower(moveName)];

// Real max HP for a hypothetical hp-SP value — used to turn a raw damage
// integer into a percentage.
function maxHpFor(pokemonRow, hpSp) {
  return calcStat(pokemonRow.hp, hpSp, 1.0, true);
}

// Exact (not statistically approximated) roll odds, from the REAL 16 per-roll
// damage values (`damagePercentRange`'s `all_damages` — see its own comment).
// An earlier version of this function re-derived a 16-value table by calling
// applyRandomFactor(max_damage) — but max_damage is already STAB/type-modified
// (the engine applies the random roll BEFORE those, not after; see
// nerd_of_now_calc.js STEP 5/6), so reapplying a random factor on top of it
// produced a different, wrong distribution. Caught by hand-verifying a real
// report line against the Champions damage formula during this feature's
// mandatory spot-check pass (off by 1 of 16 rolls at the exact boundary) —
// see logs/PROGRESS_ohko_remedies.md. `all_damages` is null for multi-hit
// moves (their top-line min/max are an expected value, not a 16-roll range).
function rollOdds(allDamages, maxHp) {
  if (!allDamages || !maxHp) return null;
  const ohkoRolls = allDamages.filter((d) => (d / maxHp) * 100 >= 100).length;
  return { ohko_rolls: ohkoRolls, total_rolls: allDamages.length, survive_rolls: allDamages.length - ohkoRolls };
}

// --- TASK 1: gather every candidate attacker's real data once -------------
async function gatherCandidateData(team, legalPokemonSet) {
  const usageRows = await getTop50UsageRows();
  const teamNamesLower = new Set(team.map((m) => m.pokemon.toLowerCase()));
  const candidateRows = usageRows
    .filter((r) => !legalPokemonSet || legalPokemonSet.size === 0 || legalPokemonSet.has(r.pokemon_name))
    .filter((r) => !teamNamesLower.has(r.pokemon_name.toLowerCase()));

  const { topMovesByName, movesByLower } = await batchFetchTopMoveData(
    candidateRows.map((r) => r.pokemon_name.toLowerCase()),
    MOVES_PER_CANDIDATE
  );

  const candidates = [];
  for (let rank = 0; rank < candidateRows.length; rank++) {
    const row = candidateRows[rank];
    const nameLower = row.pokemon_name.toLowerCase();
    const candidateRow = await getSpeciesRow(nameLower);
    if (!candidateRow) continue; // genuinely unseedable — see CLAUDE.md Known Issues
    const [attackerSpreads, abilityFreq, item, speedTiers] = await Promise.all([
      getTopAttackerSpreads(nameLower),
      getRealAbilityFrequency(nameLower),
      getTopDamageAffectingItem(nameLower),
      getCommonSpeedTiers(nameLower),
    ]);
    candidates.push({
      name: row.pokemon_name,
      nameLower,
      usagePct: round(parseFloat(row.usage_percent) / 100, 4),
      rank: rank + 1,
      row: candidateRow,
      types: [candidateRow.type1, candidateRow.type2].filter(Boolean),
      attackerSpreads,
      ability: abilityFreq[0]?.ability || candidateRow.ability1,
      item: item?.item || null,
      speed: speedTiers?.tiers?.[0]?.speed_stat ?? calcStat(candidateRow.spe, 0, 1.0, false),
      moves: (topMovesByName[nameLower] || [])
        .map((m) => ({ ...m, row: movesByLower[m.move.toLowerCase()] }))
        .filter((m) => m.row && m.row.category !== 'Status' && m.row.power),
    });
  }
  return candidates;
}

// For one (candidate, move, member) tuple: find the worst real build among
// the candidate's top-3 observed spreads (by max%), the project's existing
// representative-build convention (see file header). Returns null if even the
// worst build never reaches a possible OHKO (max < 100) — not a qualifying
// exchange at all.
function worstBuildFor(candidate, moveEntry, member, activeWeather) {
  const defenderSide = { nature: member.nature, item: member.item, sp: member.sp, ivs: { hp: 31 } };
  let best = null;
  for (const spread of candidate.attackerSpreads) {
    const attackerSide = {
      nature: spread.nature || 'Hardy', ability: candidate.ability, item: candidate.item, sp: spread.sp, ivs: { hp: 31 },
    };
    let dmg;
    try {
      dmg = damagePercentRange(candidate.row, attackerSide, member.pokemonRow, defenderSide, moveEntry.move, activeWeather);
    } catch (_err) { continue; }
    if (!best || dmg.max > best.dmg.max) best = { spread, attackerSide, dmg };
  }
  if (!best || best.dmg.max < 100) return null;
  return best;
}

// Can THIS member OHKO the specific build that's threatening it, back? Reuses
// the same shared damagePercentRange primitive team_analyzer.js's LIST 1
// uses, but against the SPECIFIC threatening spread (LIST 1 only ever checks
// a candidate's single most-common spread — see grill-me Q3 in
// logs/PROGRESS_ohko_remedies.md) since a real Pokemon's one spread is both
// its offense and its defense.
function canRetaliate(member, candidate, worstBuild) {
  const theirDefSide = { nature: worstBuild.spread.nature || 'Hardy', item: candidate.item, sp: worstBuild.spread.sp, ivs: { hp: 31 } };
  for (const mv of member.moves || []) {
    if (!mv.power || mv.category === 'Status') continue;
    if (effectivenessAgainst(mv.type, candidate.types) === 0) continue;
    const ourSide = { nature: member.nature, item: member.item, ability: member.ability, sp: member.sp, ivs: { hp: 31 } };
    let dmg;
    try {
      dmg = damagePercentRange(member.pokemonRow, ourSide, candidate.row, theirDefSide, mv.move, member.assumed_weather);
    } catch (_err) { continue; }
    if (dmg.min >= 100) return true;
  }
  return false;
}

// --- TASK 1 orchestration ---------------------------------------------------
async function computeQualifyingExchanges(team, weatherAnalysis, legalPokemonSet) {
  const activeWeather = weatherAnalysis?.setters?.[0]?.weather || null;
  const candidates = await gatherCandidateData(team, legalPokemonSet);

  const byMember = new Map(team.map((m) => [m.pokemon, { guaranteed: [], possible: [] }]));

  for (const candidate of candidates) {
    for (const moveEntry of candidate.moves) {
      const effType = resolveTypeFor(moveEntry.move, moveEntry.row.type, candidate.ability, activeWeather);
      for (const member of team) {
        const memberTypes = [member.pokemonRow.type1, member.pokemonRow.type2].filter(Boolean);
        if (effectivenessAgainst(effType, memberTypes) === 0) continue;

        const worstBuild = worstBuildFor(candidate, moveEntry, member, activeWeather);
        if (!worstBuild) continue; // never even a possible OHKO — not a qualifying exchange

        const memberSpeed = effectiveSpeed(member, weatherAnalysis);
        const attackerSpeedNum = candidate.speed;

        let weatherNote = null;
        if (weatherChangesDamage(moveEntry.move, effType, moveEntry.row.category, memberTypes, activeWeather,
          { attackerItem: worstBuild.attackerSide.item, defenderItem: member.item })) {
          try {
            const noWeather = damagePercentRange(candidate.row, worstBuild.attackerSide, member.pokemonRow,
              { nature: member.nature, item: member.item, sp: member.sp, ivs: { hp: 31 } }, moveEntry.move, null);
            weatherNote = `Our ${activeWeather} changes this — without it: ${noWeather.min}-${noWeather.max}%`;
          } catch (_err) { /* skip — primary number still stands */ }
        }

        const setFrequency = worstBuild.spread.raw_frequency || null;
        const metaFrequency = setFrequency ? round(setFrequency * candidate.usagePct, 4) : null;

        const exchange = {
          attacker: candidate.name,
          attacker_usage_pct: candidate.usagePct,
          attacker_speed: attackerSpeedNum,
          move: moveEntry.move,
          move_category: moveEntry.row.category,
          move_type: effType,
          def_key: moveEntry.row.category === 'Physical' ? 'def' : 'spd',
          attacker_build: buildAttackerBuildLabel([{ ...worstBuild.spread, frequency: 1.0 }], candidate.item, moveEntry.row.category, moveEntry.row.type, candidate.ability),
          attacker_set_frequency: setFrequency ? round(setFrequency * 100, 1) : null,
          attacker_meta_frequency: metaFrequency ? round(metaFrequency * 100, 1) : null,
          rare_set: metaFrequency !== null && metaFrequency < 0.05,
          damage_range: `${worstBuild.dmg.min}-${worstBuild.dmg.max}%`,
          min: worstBuild.dmg.min,
          max: worstBuild.dmg.max,
          max_damage: worstBuild.dmg.max_damage,
          all_damages: worstBuild.dmg.all_damages,
          weather_note: weatherNote,
          member_speed: memberSpeed,
          candidate,
          worstBuild,
          member,
          // The weather worstBuild's own damage calc used — the remedy search
          // must stay under the exact same condition as the number it targets.
          _weather: activeWeather,
        };

        if (worstBuild.dmg.min >= 100) {
          const categoryA = attackerSpeedNum > memberSpeed;
          const categoryB = !canRetaliate(member, candidate, worstBuild);
          if (!categoryA && !categoryB) continue; // we outspeed AND can kill first — not a losing exchange
          exchange.category_a = categoryA;
          exchange.category_b = categoryB;
          byMember.get(member.pokemon).guaranteed.push(exchange);
        } else {
          const maxHp = maxHpFor(member.pokemonRow, member.sp.hp || 0);
          exchange.odds = rollOdds(worstBuild.dmg.all_damages, maxHp);
          byMember.get(member.pokemon).possible.push(exchange);
        }
      }
    }
  }

  let guaranteedTotal = 0;
  let possibleTotal = 0;
  for (const { guaranteed, possible } of byMember.values()) {
    guaranteedTotal += guaranteed.length;
    possibleTotal += possible.length;
  }
  return { byMember, guaranteedTotal, possibleTotal };
}

// --- TASK 2: search for a remedy --------------------------------------------
// Direct scan/binary-search over the 33 real integer SP values in DAMAGE
// space, NOT stat-value space — see grill-me Q1 in
// logs/PROGRESS_ohko_remedies.md for why findMinSpForStat/findBreakpoints
// don't apply here: HP has no floor()/breakpoints at all, and scanning the
// literal integer SP values (rather than a derived target stat) is already
// breakpoint-optimal by construction. Monotonic non-increasing in both
// dimensions for a FIXED item (HP strictly grows the % denominator; Def/SpD's
// floor() only ever reduces raw damage), so the nested search is sound.
function twoVarSpSearch(member, exchange, nature, item, otherSpend) {
  const { def_key: defKey, worstBuild, move } = exchange;
  let best = null;
  for (let hpSp = 0; hpSp <= SP_CAP_PER_STAT; hpSp++) {
    const budget = SP_BUDGET_TOTAL - otherSpend - hpSp;
    if (budget < 0) break;
    const maxDefSp = Math.min(SP_CAP_PER_STAT, budget);
    let lo = 0;
    let hi = maxDefSp;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const sp = { ...member.sp, hp: hpSp, [defKey]: mid };
      const side = { nature, item, sp, ivs: { hp: 31 } };
      let dmg;
      try {
        dmg = damagePercentRange(exchange.candidate.row, worstBuild.attackerSide, member.pokemonRow, side, move, activeWeatherFor(exchange));
      } catch (_err) { lo = mid + 1; continue; }
      if (dmg.max < 100) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    if (found !== null) {
      const cost = hpSp + found;
      if (!best || cost < best.cost) {
        // Recompute once at the exact winning (hpSp, found) point — the
        // binary search's own last dmg may be from a different mid it
        // rejected on the way to `found`, and the brief's own worked example
        // shows the new damage figure on every FIX line, not just the
        // pass/fail verdict.
        const winningSp = { ...member.sp, hp: hpSp, [defKey]: found };
        const winningSide = { nature, item, sp: winningSp, ivs: { hp: 31 } };
        let winningDmg;
        try {
          winningDmg = damagePercentRange(exchange.candidate.row, worstBuild.attackerSide, member.pokemonRow, winningSide, move, activeWeatherFor(exchange));
        } catch (_err) { continue; }
        best = { hpSp, defSp: found, cost, nature, item, dmg: winningDmg };
      }
    }
  }
  return best;
}

// The worst-build damage calc was computed under whatever weather that
// exchange used (the team's active weather, or null) — recover it from the
// original calc rather than re-deriving, so the remedy search stays under the
// exact same conditions as the number it's trying to fix.
function activeWeatherFor(exchange) {
  return exchange._weather || null;
}

// Best achievable outcome under a fixed nature/item at max reachable
// investment — used both to report "theoretical best" for UNREACHABLE and to
// track the best PARTIAL fallback across every tier tried.
function bestEffort(member, exchange, nature, item, otherSpend) {
  const { def_key: defKey } = exchange;
  // hpSp=32 is only affordable when otherSpend leaves room for it — a fast
  // offensive member with SP already committed elsewhere may have far less
  // than 32+32 left for hp+defKey combined. Clamp hpSp to what's actually
  // affordable FIRST, then give whatever remains to defKey, so hpSp+defSp
  // never exceeds the real budget (a bug here previously proposed spreads
  // totaling more than 66 SP, caught by validateSpread downstream).
  const totalAvailable = Math.max(0, SP_BUDGET_TOTAL - otherSpend);
  const hpSp = Math.min(SP_CAP_PER_STAT, totalAvailable);
  const defSp = Math.min(SP_CAP_PER_STAT, totalAvailable - hpSp);
  const sp = { ...member.sp, hp: hpSp, [defKey]: defSp };
  const side = { nature, item, sp, ivs: { hp: 31 } };
  let dmg;
  try {
    dmg = damagePercentRange(exchange.candidate.row, exchange.worstBuild.attackerSide, member.pokemonRow, side, exchange.move, activeWeatherFor(exchange));
  } catch (_err) { return null; }
  return { hpSp, defSp, nature, item, dmg };
}

async function searchRemedy(member, exchange, team) {
  const { def_key: defKey } = exchange;
  const otherSpend = SP_BUDGET_TOTAL - (member.sp.hp || 0) - (member.sp[defKey] || 0);
  let bestPartial = null;
  const trackPartial = (cand) => {
    if (!cand || !cand.dmg) return;
    if (cand.dmg.min < 100 && (!bestPartial || cand.dmg.max < bestPartial.dmg.max)) bestPartial = cand;
  };

  // TIER 1 — SP only, current nature + item.
  let fix = twoVarSpSearch(member, exchange, member.nature, member.item, otherSpend);
  if (fix) return { tier: 'sp', ...fix, defKey };
  trackPartial(bestEffort(member, exchange, member.nature, member.item, otherSpend));

  // TIER 2 — nature change, current item.
  const natureCandidates = (BOOSTING_NATURES[defKey] || []).filter((n) => lower(n) !== lower(member.nature));
  for (const nature of natureCandidates) {
    fix = twoVarSpSearch(member, exchange, nature, member.item, otherSpend);
    if (fix) return { tier: 'nature', ...fix, defKey };
    trackPartial(bestEffort(member, exchange, nature, member.item, otherSpend));
  }

  // TIER 3 — item change. Skipped for Mega members (the Mega Stone is
  // mandatory — see archetype_swaps.js's isMegaBuild precedent for the same
  // exclusion). Candidates come ONLY from real observed data
  // (getCommonItems) — never a hardcoded list (see CLAUDE.md's Assault Vest
  // incident this brief explicitly warns against repeating).
  //
  // An item already held by a teammate (ITEM CLAUSE conflict) is NEVER
  // allowed to produce a FIXED verdict on its own — taking it from that
  // teammate leaves THEM unfixed, a knock-on cost this per-member search does
  // not solve. It is tracked separately (conflictedFix) and surfaced as a
  // footnote under whatever the real verdict ends up being — matching the
  // brief's own worked example ("UNREACHABLE BY SPREAD ... Focus Sash
  // survives one hit but is held by Whimsicott").
  const itemNotes = [];
  let conflictedFix = null;
  if (!isMegaMember(member)) {
    const observed = await getCommonItems(member.pokemon.toLowerCase(), 20);
    const observedMap = new Map(observed.map((i) => [lower(i.item), i]));
    const itemCandidates = [];
    if (!isMultiHitMove(exchange.move) && observedMap.has('focus sash') && lower(member.item) !== 'focus sash') {
      itemCandidates.push('Focus Sash');
    }
    const berry = RESIST_BERRY_FOR_TYPE[exchange.move_type];
    if (berry && observedMap.has(lower(berry)) && lower(member.item) !== lower(berry)) {
      itemCandidates.push(berry);
    }
    // Disclose observed-but-not-applicable / not-observed-at-all, per the
    // brief's item rules: absence from the observed pool is a finding, not
    // silently skipped.
    if (!observedMap.has('focus sash')) itemNotes.push('Focus Sash not in observed item pool for this species');
    if (berry && !observedMap.has(lower(berry))) itemNotes.push(`${berry} not in observed item pool for this species`);

    for (const item of itemCandidates) {
      const conflictOwner = heldBy(member, item, team);

      // Item alone (0 extra SP) first — cheapest possible fix.
      const sideAlone = { nature: member.nature, item, sp: member.sp, ivs: { hp: 31 } };
      let dmgAlone;
      try {
        dmgAlone = damagePercentRange(exchange.candidate.row, exchange.worstBuild.attackerSide, member.pokemonRow, sideAlone, exchange.move, activeWeatherFor(exchange));
      } catch (_err) { dmgAlone = null; }
      if (dmgAlone && dmgAlone.max < 100) {
        const result = { tier: 'item', hpSp: member.sp.hp || 0, defSp: member.sp[defKey] || 0, cost: 0, nature: member.nature, item, defKey, dmg: dmgAlone };
        if (conflictOwner) { conflictedFix = conflictedFix || { item, teammate: conflictOwner, dmg: dmgAlone }; }
        else return result;
      }
      if (dmgAlone) trackPartial({ hpSp: member.sp.hp || 0, defSp: member.sp[defKey] || 0, nature: member.nature, item, dmg: dmgAlone });

      // Item + SP, current nature.
      fix = twoVarSpSearch(member, exchange, member.nature, item, otherSpend);
      if (fix) {
        if (conflictOwner) { conflictedFix = conflictedFix || { item, teammate: conflictOwner, dmg: null, fix }; }
        else return { tier: 'item+sp', ...fix, defKey };
      }
      trackPartial(bestEffort(member, exchange, member.nature, item, otherSpend));
    }
  }

  // Final classification, in priority order (FIXED already returned above):
  // a conflicted item that WOULD fully fix it beats a mere partial (matches
  // the brief's own worked example — spread alone can't, but an item that
  // exists, just held elsewhere, can); otherwise fall back to PARTIAL
  // ("survives some rolls") when anything found at least got min% below 100;
  // otherwise nothing helped at all.
  if (conflictedFix) {
    itemNotes.push(`${conflictedFix.item} would fix this but is held by ${conflictedFix.teammate} — item clause conflict`);
    return { tier: 'unreachable_by_spread', partial: bestPartial, defKey, itemNotes };
  }
  if (bestPartial) return { tier: 'partial', partial: bestPartial, defKey, itemNotes };
  return { tier: 'unreachable_at_all', defKey, itemNotes };
}

// Named for the "already held by a teammate" item-clause disclosure — never
// silently exclude the best answer, name who it would have to come from.
function heldBy(member, item, team) {
  const teammate = (team || []).find((t) => t.pokemon !== member.pokemon && lower(t.item) === lower(item));
  return teammate ? teammate.pokemon : null;
}

// --- TASK 3: consequences ---------------------------------------------------
// Reuses the member's ALREADY-COMPUTED baseline thresholds_met (the real
// pipeline's own scoreSpread(..., {detailed:true}) result, stored on the team
// member object at build time) rather than recomputing it — guarantees exact
// consistency with the rest of the report and saves a redundant full-matrix
// pass per exchange.
async function computeConsequences(member, fix, threatMatrix, metaContext, teamWeathersForContext) {
  if (!fix || fix.tier === 'unreachable_by_spread' || fix.tier === 'unreachable_at_all') return null;

  const newSp = { ...member.sp, hp: fix.hpSp, [fix.defKey]: fix.defSp };
  const check = validateSpread(newSp);
  if (!check.valid) return { error: `proposed spread failed validation: ${check.errors.join('; ')}` };

  const newNature = fix.nature || member.nature;
  const newItem = fix.item || member.item;
  const fieldOpts = { weather: member.assumed_weather || null, _teamContext: teamWeathersForContext || [] };

  const after = await scoreSpread(member.pokemonRow, newSp, newNature, member.role, threatMatrix, metaContext,
    { detailed: true, item: newItem, fieldOpts });

  const baselineThresholds = member.thresholds_met || [];
  const afterThresholds = after.thresholds_met || [];
  // `threat` is already the pre-composed "Attacker Move" string (see
  // spread_scorer.js's thresholds_met shape) — a stable identity for the same
  // real-world threat across two scoreSpread() calls, same convention
  // spread_scorer.js's own minimizeSpread() uses to track a threshold across
  // a before/after pair.
  const keyOf = (t) => `${t.category}|${t.stat}|${t.threat || t.target || ''}`;
  const baselineByKey = new Map(baselineThresholds.map((t) => [keyOf(t), t]));
  const afterByKey = new Map(afterThresholds.map((t) => [keyOf(t), t]));

  const lost = [];
  const gained = [];
  for (const [key, before] of baselineByKey) {
    const now = afterByKey.get(key);
    // `before.this_spread_ko` is the CURRENT (real, already-invested) spread's
    // tier — the correct "before" value for a before/after diff.
    // `before.baseline_ko` is a DIFFERENT thing entirely (the tier at 0 SP
    // invested at all) and must never be shown here — an earlier version of
    // this function pushed the raw `before` entry for every regression and
    // rendered baseline_ko -> this_spread_ko, which described the SP=0
    // baseline vs. the CURRENT spread, not the current spread vs. the
    // PROPOSED one. Caught live: a real report line read "Sneasler Close
    // Combat: 2HKO -> 3HKO" under COSTS for a PARTIAL fix that only ADDED
    // defense — a cost line describing an improvement. Fixed by attaching the
    // real after-value (`_after_ko`) onto the pushed entry and having the
    // renderer use `this_spread_ko -> _after_ko` instead.
    if (!now) { lost.push({ ...before, _after_ko: null }); continue; }
    // koRank: higher = "dies more easily" (OHKO highest, no_ko lowest). A
    // DEFENSIVE regression is the tier moving UP (survives less); an
    // OFFENSIVE regression is the tier moving DOWN (kills less).
    if (before.category === 'defensive' && before.this_spread_ko !== now.this_spread_ko && koRank(now.this_spread_ko) > koRank(before.this_spread_ko)) {
      lost.push({ ...before, _after_ko: now.this_spread_ko }); // a survival got worse (or a KO tier regressed toward OHKO)
    }
    if (before.category === 'offensive' && before.this_spread_ko !== now.this_spread_ko && koRank(now.this_spread_ko) < koRank(before.this_spread_ko)) {
      lost.push({ ...before, _after_ko: now.this_spread_ko }); // an offensive KO got worse (OHKO -> 2HKO etc.)
    }
  }
  for (const [key, now] of afterByKey) {
    if (!baselineByKey.has(key)) gained.push(now);
  }

  return {
    new_sp: newSp, new_nature: newNature, new_item: newItem,
    new_total: STAT_ORDER_SUM(newSp),
    lost, gained,
    no_change: lost.length === 0 && gained.length === 0,
  };
}

// koRank: higher = "dies more easily" for defensive tiers / "kills more
// easily" for offensive tiers — see the regression checks above.
function koRank(tier) {
  return { no_ko: 0, '4HKO': 1, '3HKO': 2, '2HKO': 3, OHKO: 4, '1HKO': 4 }[tier] ?? -1;
}
function STAT_ORDER_SUM(sp) {
  return ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].reduce((s, k) => s + (sp[k] || 0), 0);
}

// --- Top-level orchestration -------------------------------------------------
// Runs TASK 1 across the whole team, then TASK 2 + TASK 3 for every
// GUARANTEED exchange (category A or B). Possible-OHKO exchanges are reported
// with roll odds but never get a remedy search — the brief scopes the search
// to guaranteed exchanges only ("For every qualifying exchange from TASK 1,
// search for a change... that removes the OHKO" — "qualifying" is TASK 1's
// A/B definition, which excludes merely-possible OHKOs).
async function computeOhkoRemedies(team, weatherAnalysis, legalPokemonSet, threatMatrix, metaContext, teamWeathersForContext) {
  const { byMember, guaranteedTotal, possibleTotal } = await computeQualifyingExchanges(team, weatherAnalysis, legalPokemonSet);

  const counts = { qualifying: guaranteedTotal, possible: possibleTotal, fixed: 0, partial: 0, unreachable_spread: 0, unreachable_all: 0 };
  const byMemberResult = new Map();

  for (const member of team) {
    const { guaranteed, possible } = byMember.get(member.pokemon);
    const entries = [];
    for (const exchange of guaranteed) {
      const fix = await searchRemedy(member, exchange, team);
      let consequences = null;
      if (fix.tier === 'sp' || fix.tier === 'nature' || fix.tier === 'item' || fix.tier === 'item+sp') {
        counts.fixed++;
        consequences = await computeConsequences(member, fix, threatMatrix, metaContext, teamWeathersForContext);
      } else if (fix.tier === 'partial') {
        counts.partial++;
        // Task 3 applies to PARTIAL too ("For every FIXED or PARTIAL
        // proposal...") — normalize the nested partial.* fields to the flat
        // shape computeConsequences expects.
        const p = fix.partial;
        consequences = await computeConsequences(member, { hpSp: p.hpSp, defSp: p.defSp, nature: p.nature, item: p.item, defKey: fix.defKey, tier: 'partial' }, threatMatrix, metaContext, teamWeathersForContext);
      } else if (fix.tier === 'unreachable_by_spread') {
        counts.unreachable_spread++;
      } else {
        counts.unreachable_all++;
      }
      entries.push({ exchange, fix, consequences });
    }
    // A member with 2+ FIXED proposals is drawing on the same finite 66 SP —
    // see grill-me Q5 in logs/PROGRESS_ohko_remedies.md: each proposal below
    // is independent (computed from the CURRENT baseline spread), not a set
    // that can all be applied simultaneously.
    const fixedCount = entries.filter((e) => e.fix.tier === 'sp' || e.fix.tier === 'nature' || e.fix.tier === 'item' || e.fix.tier === 'item+sp').length;
    byMemberResult.set(member.pokemon, { entries, possible, competingFixes: fixedCount > 1 });
  }

  return { counts, byMember: byMemberResult };
}

// --- Rendering ---------------------------------------------------------------
function tierLabel(tier) {
  return { sp: 'FIX (SP reallocation)', nature: 'FIX (nature change)', item: 'FIX (item change)', 'item+sp': 'FIX (item + SP)' }[tier] || 'FIX';
}

function spreadDesc(hpSp, defSp, defKey, nature) {
  const defLabel = defKey === 'def' ? 'Def' : 'SpD';
  return `${hpSp} HP / ${defSp} ${defLabel}, ${nature}`;
}

function renderFixLine(fix, exchange, member) {
  if (fix.tier === 'unreachable_by_spread' || fix.tier === 'unreachable_at_all') {
    const p = fix.partial;
    const label = fix.tier === 'unreachable_by_spread' ? 'UNREACHABLE BY SPREAD' : 'UNREACHABLE AT ALL';
    const lines = [];
    if (p) {
      const desc = spreadDesc(p.hpSp, p.defSp, fix.defKey, p.nature);
      const itemNote = p.item && lower(p.item) !== lower(member.item) ? `, ${member.item} -> ${p.item}` : '';
      lines.push(`    ${label} — max investment (${desc}${itemNote}) still takes ${p.dmg.min}-${p.dmg.max}%.`);
    } else {
      lines.push(`    ${label} — no SP/nature/item change found that reduces the damage at all.`);
    }
    if (fix.itemNotes && fix.itemNotes.length > 0) {
      for (const note of fix.itemNotes) lines.push(`                            ${note}.`);
    }
    return lines;
  }

  if (fix.tier === 'partial') {
    const p = fix.partial;
    const desc = spreadDesc(p.hpSp, p.defSp, fix.defKey, p.nature);
    const itemNote = p.item && lower(p.item) !== lower(member.item) ? `, ${member.item} -> ${p.item}` : '';
    const maxHp = maxHpFor(member.pokemonRow, p.hpSp);
    const odds = rollOdds(p.dmg.all_damages, maxHp);
    const oddsNote = odds ? ` — survives some rolls (${odds.survive_rolls}/${odds.total_rolls})` : '';
    const lines = [`    PARTIAL: ${desc}${itemNote} — new damage ${p.dmg.min}-${p.dmg.max}%${oddsNote}. Never call this "fixed": it still dies on some rolls.`];
    if (fix.itemNotes && fix.itemNotes.length > 0) {
      for (const note of fix.itemNotes) lines.push(`                            ${note}.`);
    }
    return lines;
  }

  const desc = spreadDesc(fix.hpSp, fix.defSp, fix.defKey, fix.nature);
  const wasDesc = `${member.sp.hp || 0} HP / ${member.sp[fix.defKey] || 0} ${fix.defKey === 'def' ? 'Def' : 'SpD'}`;
  const itemChange = fix.item && lower(fix.item) !== lower(member.item) ? `, ${member.item} -> ${fix.item}` : '';
  const newDmgNote = fix.dmg ? ` — new damage ${fix.dmg.min}-${fix.dmg.max}% — no longer an OHKO` : '';
  return [`    ${tierLabel(fix.tier)}: ${desc} (was ${wasDesc})${itemChange}${newDmgNote}`];
}

function renderConsequences(consequences) {
  if (!consequences) return [];
  if (consequences.error) return [`    CONSEQUENCES: ${consequences.error}`];
  const lines = [];
  if (consequences.no_change) {
    lines.push('    COSTS: none — no threshold lost or gained by this change');
    return lines;
  }
  if (consequences.lost.length > 0) {
    const parts = consequences.lost.map((t) => {
      if (t.category === 'speed' || t.category === 'speed_tie') return `no longer ${t.threat}`;
      // this_spread_ko is the CURRENT spread's real tier; _after_ko is what
      // the proposed spread gets. A DISAPPEARED entry (_after_ko === null)
      // is NOT necessarily a death — scoreSpread's thresholds_met lists one
      // BINDING threshold per stat (see spread_scorer.js), so a threshold
      // can vanish from the list because a different threat became the
      // cited reason for that same stat's investment, not because the old
      // one stopped being survived. Worded to avoid the false claim.
      if (t._after_ko === null) return `${t.threat}: no longer the cited reason for its SP (was ${t.this_spread_ko || '?'} — may still be survived via a different attribution)`;
      return `${t.threat}: ${t.this_spread_ko || '?'} -> ${t._after_ko}`;
    });
    lines.push(`    COSTS: ${parts.join(' | ')}`);
  }
  if (consequences.gained.length > 0) {
    const parts = consequences.gained.map((t) => {
      if (t.category === 'speed' || t.category === 'speed_tie') return t.threat;
      return `${t.threat}: now ${t.this_spread_ko}`;
    });
    lines.push(`    GAINS: ${parts.join(' | ')}`);
  }
  return lines;
}

function renderOddsLine(exchange) {
  if (!exchange.odds) return '(roll odds unavailable)';
  const { ohko_rolls: k, total_rolls: n } = exchange.odds;
  return `possible OHKO — ${k}/${n} rolls kill, ${n - k}/${n} survive`;
}

// Groups by member (mandatory per the brief), then by attacker within a
// member (see grill-me Q4: keeps the section proportional to members ×
// distinct threatening attackers rather than members × attackers × moves).
function renderOhkoRemedies(result) {
  const lines = [];
  const { counts } = result;
  lines.push(`Qualifying losing exchanges: ${counts.qualifying} (${counts.fixed} FIXED, ${counts.partial} PARTIAL, ${counts.unreachable_spread} UNREACHABLE BY SPREAD, ${counts.unreachable_all} UNREACHABLE AT ALL). Possible (non-guaranteed) OHKOs: ${counts.possible}.`);
  lines.push('');

  for (const [pokemon, { entries, possible, competingFixes }] of result.byMember) {
    if (entries.length === 0 && possible.length === 0) continue;
    lines.push(`-- ${pokemon} --`);
    if (competingFixes) {
      lines.push('  (multiple FIXED proposals below are each independent, starting from the current spread — they compete for the same 66 SP and cannot simply be stacked.)');
    }

    // Group guaranteed entries by attacker.
    const byAttacker = new Map();
    for (const entry of entries) {
      const key = entry.exchange.attacker;
      if (!byAttacker.has(key)) byAttacker.set(key, []);
      byAttacker.get(key).push(entry);
    }
    const attackerOrder = [...byAttacker.entries()].sort((a, b) => b[1][0].exchange.attacker_usage_pct - a[1][0].exchange.attacker_usage_pct);

    for (const [attacker, attackerEntries] of attackerOrder) {
      const first = attackerEntries[0].exchange;
      const speedComp = first.attacker_speed > first.member_speed ? 'outspeeds' : 'is SLOWER than';
      const reasons = [];
      if (attackerEntries.some((e) => e.exchange.category_a)) reasons.push('outspeeds and OHKOs');
      if (attackerEntries.some((e) => e.exchange.category_b)) reasons.push('cannot be OHKO\'d back');
      lines.push(`  ${attacker} (${first.attacker_speed} Spe) ${speedComp} ${pokemon} (${first.member_speed} Spe) [${reasons.join(', ')}] —`);
      for (const { exchange, fix, consequences } of attackerEntries) {
        const freqNote = exchange.attacker_set_frequency
          ? ` (${exchange.attacker_set_frequency}% of ${exchange.attacker}, ${exchange.attacker_meta_frequency}% meta${exchange.rare_set ? ' — rare set' : ''})`
          : '';
        lines.push(`    ${exchange.move} (${exchange.attacker_build}): ${exchange.damage_range}${freqNote}`);
        if (exchange.weather_note) lines.push(`    ${exchange.weather_note}`);
        lines.push(...renderFixLine(fix, exchange, exchange.member));
        lines.push(...renderConsequences(consequences));
      }
    }

    if (possible.length > 0) {
      lines.push(`  Possible (non-guaranteed) OHKOs against ${pokemon}: ${possible.length} — not searched for a remedy (not a guaranteed loss).`);
      for (const exchange of possible.slice(0, 10)) {
        lines.push(`    ${exchange.attacker} ${exchange.move} (${exchange.attacker_build}): ${exchange.damage_range} — ${renderOddsLine(exchange)}`);
      }
      if (possible.length > 10) lines.push(`    ... ${possible.length - 10} more not shown (see count above).`);
    }
    lines.push('');
  }

  return lines;
}

module.exports = {
  computeQualifyingExchanges,
  searchRemedy,
  computeConsequences,
  computeOhkoRemedies,
  renderOhkoRemedies,
  rollOdds,
  maxHpFor,
  RESIST_BERRY_FOR_TYPE,
};
