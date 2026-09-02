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
const { getSpeciesRow, getTopDamageAffectingItem, getCommonSpeedTiers } = require('./ev_observations');
const { getRealAbilityFrequency, getGlobalItemFrequency, describeItemEffect } = require('./item_optimizer');
const { getTopAttackerSpreads, buildAttackerBuildLabel, koFromPercent } = require('./spread_scorer');
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

const lower = (s) => String(s || '').toLowerCase();
const isMegaMember = (member) => (member.pokemon || '').includes('-Mega');

// Focus Sash caps damagePercentRange's min/max below 100 so downstream
// "min >= 100 means OHKO" checks stay correct without knowing about the item.
// That is exactly backwards for THIS file: everything survives a first hit
// with Sash, so a Sash holder's real capped figure (e.g. 99.5-99.5%) reads as
// "already fine" to every guard in this module — worstBuildFor's qualifying
// check, the remedy tiers' own-item baseline, and the item-candidate search
// all silently treat the cap as a real survival instead of the near-OHKO it
// actually is. The owner's instruction is that Sash is irrelevant to this
// search entirely, so every damage figure computed here uses the RAW
// (uncapped) percentage — `raw_min_percent`/`raw_max_percent`, which
// damagePercentRange always populates and which equal min/max whenever no
// Sash is involved. Every damagePercentRange call in this file must go
// through this wrapper, never the raw import directly.
function realDamage(...args) {
  const dmg = damagePercentRange(...args);
  if (!dmg) return dmg;
  return { ...dmg, min: dmg.raw_min_percent, max: dmg.raw_max_percent };
}

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
      dmg = realDamage(candidate.row, attackerSide, member.pokemonRow, defenderSide, moveEntry.move, activeWeather);
    } catch (_err) { continue; }
    if (!best || dmg.max > best.dmg.max) best = { spread, attackerSide, dmg };
  }
  if (!best || best.dmg.max < 100) return null;
  return best;
}

// Same worst-real-build convention as worstBuildFor, but for TASK 4/5's real
// meta diff (see computeMemberBaseline below) — every KO tier matters there
// (3HKO -> 2HKO is as real a change as 2HKO -> OHKO), not just the
// possible-OHKO threshold worstBuildFor gates on. Takes the defender's side
// object directly rather than a team `member`, so it can be called against
// both a member's CURRENT spread and a hypothetical proposed one.
function worstAttackerBuildAny(candidate, moveEntry, defenderRow, defenderSide, activeWeather) {
  let best = null;
  for (const spread of candidate.attackerSpreads) {
    const attackerSide = {
      nature: spread.nature || 'Hardy', ability: candidate.ability, item: candidate.item, sp: spread.sp, ivs: { hp: 31 },
    };
    let dmg;
    try {
      dmg = realDamage(candidate.row, attackerSide, defenderRow, defenderSide, moveEntry.move, activeWeather);
    } catch (_err) { continue; }
    if (!best || dmg.max > best.dmg.max) best = { spread, attackerSide, dmg };
  }
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
      dmg = realDamage(member.pokemonRow, ourSide, candidate.row, theirDefSide, mv.move, member.assumed_weather);
    } catch (_err) { continue; }
    if (dmg.min >= 100) return true;
  }
  return false;
}

// --- TASK 1 orchestration ---------------------------------------------------
// `precomputedCandidates` lets computeOhkoRemedies fetch the top-50 pool ONCE
// and share it with both this exchange search and the real-meta-diff baseline
// (computeMemberBaseline) — the same candidates/moves data was previously
// fetched twice per run.
async function computeQualifyingExchanges(team, weatherAnalysis, legalPokemonSet, precomputedCandidates) {
  const activeWeather = weatherAnalysis?.setters?.[0]?.weather || null;
  const candidates = precomputedCandidates || await gatherCandidateData(team, legalPokemonSet);

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
            const noWeather = realDamage(candidate.row, worstBuild.attackerSide, member.pokemonRow,
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
        dmg = realDamage(exchange.candidate.row, worstBuild.attackerSide, member.pokemonRow, side, move, activeWeatherFor(exchange));
      } catch (_err) { lo = mid + 1; continue; }
      if (dmg.max < 100) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    if (found !== null) {
      const cost = hpSp + found;
      if (!best || cost < best.cost) {
        best = { hpSp, defSp: found, cost, nature, item };
      }
    }
  }
  if (!best) return null;

  // The search above finds the MINIMUM-cost (hpSp, defSp) that clears the
  // target, per the brief's own search method — but a real Champions spread
  // always totals exactly 66 SP ("Unspent SP is 0 in a slot — budget is a
  // ceiling, not a target" per CLAUDE.md's invariants means every point is
  // either justified or explicitly marked unspendable, not silently absent).
  // Any leftover SP within this search's own two variables goes to the
  // defending stat first (directly relevant to THIS threat, strictly
  // improves it further) and HP second, both capped at 32 — never removed,
  // since more bulk cannot make an already-passing spread fail.
  let { hpSp, defSp } = best;
  let leftover = (SP_BUDGET_TOTAL - otherSpend) - best.cost;
  const addToDef = Math.min(leftover, SP_CAP_PER_STAT - defSp);
  defSp += addToDef;
  leftover -= addToDef;
  const addToHp = Math.min(leftover, SP_CAP_PER_STAT - hpSp);
  hpSp += addToHp;
  leftover -= addToHp;

  const finalSp = { ...member.sp, hp: hpSp, [defKey]: defSp };
  const finalSide = { nature, item, sp: finalSp, ivs: { hp: 31 } };
  let finalDmg;
  try {
    finalDmg = realDamage(exchange.candidate.row, worstBuild.attackerSide, member.pokemonRow, finalSide, move, activeWeatherFor(exchange));
  } catch (_err) {
    return null; // should not happen — adding SP can only help, never break a working combo
  }
  return { hpSp, defSp, cost: hpSp + defSp, nature, item, dmg: finalDmg };
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
    dmg = realDamage(exchange.candidate.row, exchange.worstBuild.attackerSide, member.pokemonRow, side, exchange.move, activeWeatherFor(exchange));
  } catch (_err) { return null; }
  return { hpSp, defSp, nature, item, dmg };
}

// TASK 5: rather than returning whichever tier happens to be tried first (an
// SP-only fix always came first in tier order, but the search almost always
// fell through to an item change anyway — because a real guaranteed OHKO
// usually cannot be solved within the SP already free for hp/defKey alone),
// this evaluates SP/nature-only and item-only fixes INDEPENDENTLY, only falls
// back to a combined item+SP search if NEITHER works alone, and returns every
// option that succeeded so the caller can pick the one that costs the least
// (see computeOhkoRemedies's usage-weighted selection) rather than whichever
// was found first.
async function searchRemedy(member, exchange, team) {
  const { def_key: defKey } = exchange;
  const otherSpend = SP_BUDGET_TOTAL - (member.sp.hp || 0) - (member.sp[defKey] || 0);
  let bestPartial = null;
  const trackPartial = (cand) => {
    if (!cand || !cand.dmg) return;
    if (cand.dmg.min < 100 && (!bestPartial || cand.dmg.max < bestPartial.dmg.max)) bestPartial = cand;
  };

  // OPTION A — SP/nature change, item held FIXED at its current value.
  // Current nature tried first, then each boosting nature; first success wins
  // (a nature change is a strictly bigger commitment than a pure SP move, so
  // there is no reason to keep searching nature candidates once the current
  // one already works).
  let spOption = twoVarSpSearch(member, exchange, member.nature, member.item, otherSpend);
  if (spOption) spOption = { tier: 'sp', ...spOption, defKey };
  else trackPartial(bestEffort(member, exchange, member.nature, member.item, otherSpend));
  if (!spOption) {
    const natureCandidates = (BOOSTING_NATURES[defKey] || []).filter((n) => lower(n) !== lower(member.nature));
    for (const nature of natureCandidates) {
      const fix = twoVarSpSearch(member, exchange, nature, member.item, otherSpend);
      if (fix) { spOption = { tier: 'nature', ...fix, defKey }; break; }
      trackPartial(bestEffort(member, exchange, nature, member.item, otherSpend));
    }
  }

  // OPTION B — item change alone, SP/nature held FIXED at their current
  // values. Skipped for Mega members (the Mega Stone is mandatory — see
  // archetype_swaps.js's isMegaBuild precedent for the same exclusion).
  // Candidates are EVERY real item observed anywhere in tournament play
  // (getGlobalItemFrequency — tournament_teams AND ev_observations,
  // dex-normalized, junk dropped), never scoped to this member's own species
  // and never a hardcoded list (see CLAUDE.md's Assault Vest incident). Tried
  // in descending real-usage order so common items are reached first — an
  // ORDER, not a filter: the loop still runs to exhaustion looking for the
  // first non-conflicted success rather than stopping at some fixed
  // candidate count.
  //
  // Focus Sash is excluded outright. It is not a fix for the SP/matchup
  // problem this search exists to find — literally any Pokemon at full HP
  // survives literally any single hit while holding it, so offering it here
  // would "solve" every exchange the same trivial way regardless of the real
  // matchup (owner's instruction: it is "essentially irrelevant" to this
  // search). It remains a normal candidate for the real team-building item
  // optimizer (item_optimizer.js) — this exclusion is scoped to this file.
  //
  // An item already held by a teammate (ITEM CLAUSE conflict) is NEVER
  // allowed to produce a FIXED verdict on its own — taking it from that
  // teammate leaves THEM unfixed, a knock-on cost this per-member search does
  // not solve. It is tracked separately (conflictedFix) and surfaced as a
  // footnote under whatever the real verdict ends up being.
  const itemNotes = [];
  let conflictedFix = null;
  let itemOption = null;
  if (!isMegaMember(member)) {
    const globalFrequency = await getGlobalItemFrequency();
    const itemCandidates = globalFrequency
      .map((entry) => entry.item)
      .filter((item) => lower(item) !== 'focus sash' && lower(item) !== lower(member.item));

    for (const item of itemCandidates) {
      const conflictOwner = heldBy(member, item, team);
      const sideAlone = { nature: member.nature, item, sp: member.sp, ivs: { hp: 31 } };
      let dmgAlone;
      try {
        dmgAlone = realDamage(exchange.candidate.row, exchange.worstBuild.attackerSide, member.pokemonRow, sideAlone, exchange.move, activeWeatherFor(exchange));
      } catch (_err) { dmgAlone = null; }
      if (dmgAlone) trackPartial({ hpSp: member.sp.hp || 0, defSp: member.sp[defKey] || 0, nature: member.nature, item, dmg: dmgAlone });
      if (dmgAlone && dmgAlone.max < 100) {
        if (conflictOwner) {
          conflictedFix = conflictedFix || { item, teammate: conflictOwner, dmg: dmgAlone };
        } else if (!itemOption) {
          itemOption = { tier: 'item', hpSp: member.sp.hp || 0, defSp: member.sp[defKey] || 0, cost: 0, nature: member.nature, item, defKey, dmg: dmgAlone };
          break;
        }
      }
    }
  }

  // OPTION C — item + SP together. Only searched when NEITHER option above
  // worked alone — per the brief, this is a fallback, not a third equal
  // choice: if either SP alone or an item alone already fixes it, there is no
  // reason to additionally spend SP AND give up an item slot together.
  let combinedOption = null;
  if (!spOption && !itemOption && !isMegaMember(member)) {
    const globalFrequency = await getGlobalItemFrequency();
    const itemCandidates = globalFrequency
      .map((entry) => entry.item)
      .filter((item) => lower(item) !== 'focus sash' && lower(item) !== lower(member.item));
    for (const item of itemCandidates) {
      const conflictOwner = heldBy(member, item, team);
      const fix = twoVarSpSearch(member, exchange, member.nature, item, otherSpend);
      if (fix) {
        if (conflictOwner) {
          conflictedFix = conflictedFix || { item, teammate: conflictOwner, dmg: null, fix };
        } else {
          combinedOption = { tier: 'item+sp', ...fix, defKey };
          break;
        }
      }
      trackPartial(bestEffort(member, exchange, member.nature, item, otherSpend));
    }
  }

  const options = [spOption, itemOption, combinedOption].filter(Boolean);
  if (options.length > 0) return { options, defKey, itemNotes };

  // Nothing succeeded, in any category — fall back to the existing
  // PARTIAL/UNREACHABLE classification: a conflicted item that WOULD fully
  // fix it beats a mere partial (spread alone can't, but a real item that
  // exists, just held elsewhere, can); otherwise PARTIAL ("survives some
  // rolls") when anything found at least got min% below 100; otherwise
  // nothing helped at all.
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

// --- TASK 3/4: real-meta-diff consequences ----------------------------------
// Replaces a previous version that diffed `thresholds_met` — the Why block's
// filtered ATTRIBUTION TABLE (one credited threshold per stat, the subset that
// passed scoreSpread's marginal-value guard) — and presented reshuffles in
// THAT table as if they were battle outcomes. A berry answering fifteen real
// matchups only ever showed the one or two that happened to sit in the table,
// and a nature change that reassigns which threshold "explains" a stat printed
// as a false regression even when the real survival never moved. See
// logs/BRIEF_remedy_diff.md.
//
// Direct replacement: for every real attacker in the top-50 meta pool and
// every one of its real observed top moves, compute the actual KO TIER against
// the member's CURRENT spread and the PROPOSED spread, using this file's own
// worst-real-build convention. Only a tier that actually crossed a boundary is
// reported — a damage number moving without crossing one doesn't change how
// the game plays.

// koRank: higher = "dies more easily" (OHKO highest, no_ko lowest) — a tier
// moving UP this scale is a cost (survives less), moving DOWN is a gain.
function koRank(tier) {
  return { no_ko: 0, '4HKO': 1, '3HKO': 2, '2HKO': 3, OHKO: 4, '1HKO': 4 }[tier] ?? -1;
}

// koFromPercent's raw tier names are internal identifiers (snake_case
// 'no_ko') — never surface those verbatim in report text.
function tierLabelForDisplay(tier) {
  return tier === 'no_ko' ? 'no KO' : tier;
}

// One-time, per-member scan across the full candidate pool at the member's
// CURRENT (already-invested) spread — the "before" side of every diff this
// member will ever need. Computed once regardless of how many independent
// remedy proposals follow for that member.
async function computeMemberBaseline(member, candidates, activeWeather) {
  const memberTypes = [member.pokemonRow.type1, member.pokemonRow.type2].filter(Boolean);
  const beforeState = { nature: member.nature, item: member.item, sp: member.sp, ivs: { hp: 31 } };
  const rows = [];
  for (const candidate of candidates) {
    for (const moveEntry of candidate.moves) {
      const effType = resolveTypeFor(moveEntry.move, moveEntry.row.type, candidate.ability, activeWeather);
      if (effectivenessAgainst(effType, memberTypes) === 0) continue; // immune — no tier can ever move
      const worst = worstAttackerBuildAny(candidate, moveEntry, member.pokemonRow, beforeState, activeWeather);
      if (!worst) continue;
      rows.push({ candidate, moveEntry, effType, worst, beforeTier: koFromPercent(worst.dmg.max) });
    }
  }
  return { memberTypes, rows };
}

function afterStateFor(member, fix) {
  return {
    nature: fix.nature || member.nature,
    item: fix.item || member.item,
    sp: { ...member.sp, hp: fix.hpSp, [fix.defKey]: fix.defSp },
    ivs: { hp: 31 },
  };
}

// TASK 2: plain-language "what am I giving up" line for an outgoing item —
// items with no stat effect (Wide Lens, Focus Sash) would otherwise lose their
// entire benefit invisibly. Reuses the one shared item-effect table
// (item_optimizer.js's describeItemEffect) rather than a second hardcoded copy.
function describeOutgoingItem(oldItem) {
  const desc = describeItemEffect(oldItem);
  return desc ? `loses ${oldItem} — ${desc}` : `loses ${oldItem}`;
}

// Many sibling exchanges propose the byte-identical fix (the same item swap
// with no SP change fixes every attacker of that type observed in the meta) —
// cache the diff by the exact after-state so it's computed once, not once per
// exchange that happens to share it.
function diffCacheKey(member, afterState) {
  return `${member.pokemon}|${afterState.nature}|${afterState.item}|${JSON.stringify(afterState.sp)}`;
}

function computeRealConsequences(member, fix, baseline, activeWeather, diffCache) {
  if (!fix || fix.tier === 'unreachable_by_spread' || fix.tier === 'unreachable_at_all') return null;

  const newSp = { ...member.sp, hp: fix.hpSp, [fix.defKey]: fix.defSp };
  const check = validateSpread(newSp);
  if (!check.valid) return { error: `proposed spread failed validation: ${check.errors.join('; ')}` };

  const afterState = afterStateFor(member, fix);
  const cacheKey = diffCacheKey(member, afterState);
  if (diffCache.has(cacheKey)) return diffCache.get(cacheKey);

  const costs = [];
  const gains = [];
  for (const { candidate, moveEntry, effType, worst, beforeTier } of baseline.rows) {
    let afterDmg;
    try {
      afterDmg = realDamage(candidate.row, worst.attackerSide, member.pokemonRow, afterState, moveEntry.move, activeWeather);
    } catch (_err) { continue; }
    const afterTier = koFromPercent(afterDmg.max);
    if (afterTier === beforeTier) continue; // no boundary crossed — not reportable (brief item 4)

    const weatherSensitive = weatherChangesDamage(moveEntry.move, effType, moveEntry.row.category, baseline.memberTypes, activeWeather,
      { attackerItem: worst.attackerSide.item, defenderItem: afterState.item });
    const weatherTag = weatherSensitive ? ` — assumes our ${activeWeather}` : '';
    const usageStr = `${round(candidate.usagePct * 100, 1)}% of teams`;
    const entry = {
      attacker: candidate.name,
      usagePct: candidate.usagePct,
      line: `${candidate.name} ${moveEntry.move} ${tierLabelForDisplay(beforeTier)} -> ${tierLabelForDisplay(afterTier)} (${usageStr})${weatherTag}`,
    };
    if (koRank(afterTier) > koRank(beforeTier)) costs.push(entry); // moved toward death
    else gains.push(entry); // moved away from death
  }
  costs.sort((a, b) => b.usagePct - a.usagePct);
  gains.sort((a, b) => b.usagePct - a.usagePct);

  const itemChanged = lower(afterState.item) !== lower(member.item);
  const result = {
    new_sp: newSp, new_nature: afterState.nature, new_item: afterState.item,
    outgoing_item_note: itemChanged ? describeOutgoingItem(member.item) : null,
    costs, gains,
  };
  diffCache.set(cacheKey, result);
  return result;
}

// TASK 5's DEFAULT CRITERION for choosing among multiple successful remedy
// options (SP/nature alone, item alone, or the item+SP fallback): the option
// that costs the least USAGE-WEIGHTED value elsewhere — a lost tier against a
// heavily-used real Pokemon costs far more than the identical loss against a
// barely-played one. `costs` entries already carry the real candidate's own
// top-50 usage fraction directly, no separate lookup needed.
function usageWeightedLoss(consequences) {
  if (!consequences || !consequences.costs || consequences.costs.length === 0) return 0;
  return round(consequences.costs.reduce((sum, c) => sum + c.usagePct, 0), 4);
}

// --- Top-level orchestration -------------------------------------------------
// Runs TASK 1 across the whole team, then TASK 2 + TASK 3 for every
// GUARANTEED exchange (category A or B). Possible-OHKO exchanges are reported
// with roll odds but never get a remedy search — the brief scopes the search
// to guaranteed exchanges only ("For every qualifying exchange from TASK 1,
// search for a change... that removes the OHKO" — "qualifying" is TASK 1's
// A/B definition, which excludes merely-possible OHKOs).
async function computeOhkoRemedies(team, weatherAnalysis, legalPokemonSet) {
  const activeWeather = weatherAnalysis?.setters?.[0]?.weather || null;
  // Fetched ONCE and shared with computeQualifyingExchanges (TASK 1's search)
  // and computeMemberBaseline (the real-meta-diff below) — previously each
  // fetched its own copy of the same top-50 pool + real top moves.
  const candidates = await gatherCandidateData(team, legalPokemonSet);
  const { byMember, guaranteedTotal, possibleTotal } = await computeQualifyingExchanges(team, weatherAnalysis, legalPokemonSet, candidates);

  const counts = { qualifying: guaranteedTotal, possible: possibleTotal, fixed: 0, partial: 0, unreachable_spread: 0, unreachable_all: 0 };
  const byMemberResult = new Map();
  // Keyed by exact after-state signature (see diffCacheKey) — many sibling
  // exchanges for the same member propose the byte-identical fix.
  const diffCache = new Map();

  for (const member of team) {
    const { guaranteed, possible } = byMember.get(member.pokemon);
    const baseline = await computeMemberBaseline(member, candidates, activeWeather);
    const entries = [];
    for (const exchange of guaranteed) {
      const fix = await searchRemedy(member, exchange, team);
      const weatherForFix = activeWeatherFor(exchange);
      if (fix.options) {
        // TASK 5: 1+ independent options succeeded (SP/nature alone, item
        // alone, or the item+SP fallback). Score every one's real consequences
        // and recommend the least usage-weighted-costly — but keep the rest
        // as disclosed alternatives, per "print every option that succeeds,
        // labelled, with its own consequences."
        counts.fixed++;
        const scored = [];
        for (const opt of fix.options) {
          const cons = computeRealConsequences(member, opt, baseline, weatherForFix, diffCache);
          const lossWeight = usageWeightedLoss(cons);
          scored.push({ fix: opt, consequences: cons, lossWeight });
        }
        scored.sort((a, b) => a.lossWeight - b.lossWeight);
        const [winner, ...alternatives] = scored;
        entries.push({ exchange, fix: winner.fix, consequences: winner.consequences, alternatives });
        continue;
      }
      let consequences = null;
      if (fix.tier === 'partial') {
        counts.partial++;
        // Task 3 applies to PARTIAL too ("For every FIXED or PARTIAL
        // proposal...") — normalize the nested partial.* fields to the flat
        // shape computeRealConsequences expects.
        const p = fix.partial;
        consequences = computeRealConsequences(member, { hpSp: p.hpSp, defSp: p.defSp, nature: p.nature, item: p.item, defKey: fix.defKey, tier: 'partial' }, baseline, weatherForFix, diffCache);
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

// Always emits both a COSTS and a GAINS line (brief item 6) — a proposal with
// no cost is still worth confirming has none, not silently omitted.
function renderConsequences(consequences) {
  if (!consequences) return [];
  if (consequences.error) return [`    CONSEQUENCES: ${consequences.error}`];
  const costParts = [];
  if (consequences.outgoing_item_note) costParts.push(consequences.outgoing_item_note);
  costParts.push(...consequences.costs.map((c) => c.line));
  const gainParts = consequences.gains.map((g) => g.line);
  return [
    `    COSTS: ${costParts.length > 0 ? costParts.join(' | ') : 'none'}`,
    `    GAINS: ${gainParts.length > 0 ? gainParts.join(' | ') : 'none'}`,
  ];
}

// Groups by member (mandatory per the brief), then by attacker within a
// member (see grill-me Q4: keeps the section proportional to members ×
// distinct threatening attackers rather than members × attackers × moves).
function renderOhkoRemedies(result) {
  const lines = [];
  const { counts } = result;
  lines.push(`Qualifying losing exchanges: ${counts.qualifying} (${counts.fixed} FIXED, ${counts.partial} PARTIAL, ${counts.unreachable_spread} UNREACHABLE BY SPREAD, ${counts.unreachable_all} UNREACHABLE AT ALL).`);
  lines.push('  Where multiple fixes were found for the same exchange, the FIX shown is the one losing the least usage-weighted value elsewhere on the team; other options that also worked are listed below it as ALSO POSSIBLE.');
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
      for (const { exchange, fix, consequences, alternatives } of attackerEntries) {
        const freqNote = exchange.attacker_set_frequency
          ? ` (${exchange.attacker_set_frequency}% of ${exchange.attacker}, ${exchange.attacker_meta_frequency}% meta${exchange.rare_set ? ' — rare set' : ''})`
          : '';
        lines.push(`    ${exchange.move} (${exchange.attacker_build}): ${exchange.damage_range}${freqNote}`);
        if (exchange.weather_note) lines.push(`    ${exchange.weather_note}`);
        lines.push(...renderFixLine(fix, exchange, exchange.member));
        lines.push(...renderConsequences(consequences));
        // TASK 5: every OTHER option that also independently fixed this
        // exchange, disclosed (not silently dropped) even though it lost to
        // the recommendation above on usage-weighted cost.
        for (const alt of alternatives || []) {
          lines.push(`    ALSO POSSIBLE — ${renderFixLine(alt.fix, exchange, exchange.member)[0].trim()}`);
          lines.push(...renderConsequences(alt.consequences).map((l) => `  ${l}`));
        }
      }
    }
    lines.push('');
  }

  return lines;
}

module.exports = {
  computeQualifyingExchanges,
  searchRemedy,
  computeRealConsequences,
  computeOhkoRemedies,
  renderOhkoRemedies,
  rollOdds,
  maxHpFor,
};
