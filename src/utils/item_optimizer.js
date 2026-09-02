const pool = require('../db/pool');
const { Dex } = require('@pkmn/dex');
const { getCommonItems } = require('./ev_observations');
const { calcStat, SP_CAP_PER_STAT } = require('./stat_formula');
const { BULKY_TOTAL_THRESHOLD } = require('./role_classifier');

// Roles that invest heavily in an offensive stat vs. roles built around bulk —
// same 4-role vocabulary role_classifier.js already produces, just grouped for
// item-fit purposes (not a new classification system).
const OFFENSIVE_ROLES = new Set(['fast_offense', 'slow_bulky_offense']);
const BULKY_ROLES = new Set(['slow_bulky_support', 'slow_bulky_offense']);

// Generic, role-appropriate fallback items — only used when a Pokemon's real
// observed candidate list (top 5, see getCommonItems) is entirely exhausted by
// conflict resolution (every candidate already claimed by a higher-loss_of_value
// teammate). Scored low (0.25) so a real observed candidate always wins if one is
// still available; this is a last-resort "everyone needs *an* item" guarantee,
// not a claim that this fallback is commonly run.
//
// This pool used to be a hand-written per-role list (GENERIC_FALLBACK_BY_ROLE,
// below) assembled from general Pokemon-VGC knowledge rather than this
// format's own data. Verified live against the full tournament_teams corpus
// (10,000+ scraped item slots): Assault Vest, Choice Band, Choice Specs, and
// Rocky Helmet — all four hardcoded into that list — have ZERO observed
// appearances, while items genuinely played only once (e.g. Poison Barb)
// DO show up correctly. Zero-across-10,000+-with-single-play-items-visible is
// strong evidence those four are not available in Champions Regulation M-B at
// all (the owner independently confirmed this for Assault Vest), not merely
// unpopular — and the hardcoded list was silently offering them as reasonable
// defaults regardless. A hand-corrected replacement list would carry the
// identical defect (disconnected from what's actually observed, so the next
// unplayable item added to it recurs the same way) — so the fallback pool
// itself is now DERIVED from real global item frequency (see
// getGlobalItemFrequency below), filtered by the same itemRoleFit() already
// used to score real candidates, rather than hardcoded per role.

// FIX 8: damage-boosting items that require meaningful offensive investment
// to be coherent. If the Pokemon's role is bulky support, these items lose
// coherence because that role won't invest in offensive stats.
const DAMAGE_BOOSTING_ITEMS = new Set([
  'choice band', 'choice specs', 'life orb', 'muscle band', 'wise glasses',
  'expert belt', 'charcoal', 'mystic water', 'sharp beak', 'never-melt ice',
  'spell tag', 'dragon fang', 'poison barb', 'hard stone', 'silver powder',
  'twisted spoon', 'magnet', 'black belt', 'black glasses', 'metal coat',
  'silk scarf', 'light ball', 'thick club', 'deep sea tooth',
]);

// FIX 8: coherence_penalty — damage-boosting items lose score when the Pokemon's
// role won't invest in the relevant offensive stat. Bulky supports rarely invest
// in Atk/SpA, so Charcoal on Incineroar (a bulky support) with 0 Atk is incoherent.
function itemCoherencePenalty(itemName, role) {
  const item = (itemName || '').toLowerCase();
  if (!DAMAGE_BOOSTING_ITEMS.has(item)) return 1.0;
  // Bulky supports rarely invest in offense — damage items are incoherent
  if (role === 'slow_bulky_support') return 0.5;
  return 1.0;
}

// TASK C: exposed so routes/team.js can reconcile item choice against what
// the spread search ACTUALLY invested — itemRoleFit/itemCoherencePenalty
// above only know the Pokemon's ROLE LABEL at item-selection time (before the
// spread exists), so a role that nominally allows offensive investment
// (slow_bulky_offense, fast_offense) can still legitimately end up investing
// 0 in the corresponding stat once the real threat-driven minimization runs.
// A damage-boosting item is incoherent with that outcome regardless of role.
function isDamageBoostingItem(itemName) {
  return DAMAGE_BOOSTING_ITEMS.has((itemName || '').toLowerCase());
}
// Real, observed, global item frequency across EVERY scraped source (both
// tournament_teams and ev_observations) — not scoped to one species. This is
// the pool any "every item is an option for every Pokemon" search should
// draw from: species-scoped lookups (getCommonItems) answer a narrower
// question ("what has THIS species been seen holding") that this function
// deliberately does not ask.
//
// Raw scraped item strings are not normalised at the source (e.g.
// 'gardevoirite' vs 'Gardevoirite', 'focussash', 'lumberry', and outright
// non-items like 'No Items' / 'Nothing' / ''). Rather than hand-write a
// normalization/exclusion table — which would silently drift the moment a
// new raw variant or junk value showed up in a future scrape — every raw
// string is resolved through @pkmn/dex's own item lookup (which already
// folds case/spacing via its `toID` normalization, the same tool this
// codebase's recurring-defect notes call out for NOT being used in the
// Pokemon-name case). A string the dex does not recognize as a real item is
// dropped as junk; verified live against the full corpus (131 distinct raw
// strings) this drops exactly 4: 'No Item', 'No Items', 'Nothing' (the
// legitimate no-item markers) and 'Staraptornite' (a scraper artifact —
// Staraptor has no real Mega Evolution), leaving 121 real canonical items,
// each counted once per raw variant folded into it.
//
// Queried once and memoized for the process lifetime (mirrors this file's
// other small reference tables).
let globalItemFrequencyCache = null;
async function getGlobalItemFrequency() {
  if (globalItemFrequencyCache) return globalItemFrequencyCache;
  const [{ rows: fromTeams }, { rows: fromObservations }] = await Promise.all([
    pool.query(
      `SELECT p->>'item' as item, COUNT(*) as count
       FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
       WHERE p->>'item' IS NOT NULL AND p->>'item' != ''
       GROUP BY p->>'item'`
    ),
    pool.query(
      `SELECT item, COUNT(*) as count FROM ev_observations
       WHERE item IS NOT NULL AND item != ''
       GROUP BY item`
    ),
  ]);
  const counts = new Map(); // canonical dex name -> count
  for (const row of [...fromTeams, ...fromObservations]) {
    const dexItem = Dex.items.get(row.item);
    if (!dexItem || !dexItem.exists) continue; // junk / no-item marker, not a real item
    const prior = counts.get(dexItem.name) || 0;
    counts.set(dexItem.name, prior + parseInt(row.count, 10));
  }
  globalItemFrequencyCache = Array.from(counts.entries())
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count);
  return globalItemFrequencyCache;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isPhysicalLeaning(pokemonRow) {
  return pokemonRow.atk >= pokemonRow.spa;
}

// --- Real tournament-frequency ability selection ----------------------------------
// Abilities are picked from real tournament_teams data, not the pokemon table's
// ability1/ability2/ability_hidden slot order (that order is @pkmn/dex's in-game
// slot ordering, e.g. Garchomp's ability1 is "Sand Veil" even though real play is
// 98%+ Rough Skin — verified live, see CLAUDE.md). Conditional abilities that need
// an unmet team weather are filtered out (score 0) before picking the highest real
// frequency remaining. No hardcoded per-species "defining ability" override table:
// verified live that every named example (Rough Skin/Drizzle/Hospitality/Defiant/
// Stamina) is ALREADY the real >98% majority pick for its species, so a frequency-
// only approach reproduces every one of them without hardcoding a single Pokemon
// name — consistent with this project's standing "never hardcode Pokemon
// names/roles" rule (see CLAUDE.md's Pelipper role-classification decision).
const WEATHER_SETTER_ABILITIES = {
  drizzle: 'Rain', drought: 'Sun', 'sand stream': 'Sand', 'snow warning': 'Snow',
  'orichalcum pulse': 'Sun',
};
const WEATHER_SETTER_MOVES = {
  'rain dance': 'Rain', 'sunny day': 'Sun', sandstorm: 'Sand', snowscape: 'Snow',
};
// Abilities that only pay off under a specific active weather — same fixed-
// vocabulary category as WEATHER_MOVE_RULES in synergy_reasons.js. "Dry Skin" is
// listed as partial in the task spec (it also has a non-weather healing/Fire-
// weakness component) but is treated the same as the others here since its
// standout use case (doubled healing) is Rain-conditional.
const CONDITION_REQUIRING_ABILITIES = {
  'sand veil': 'Sand', 'sand rush': 'Sand', 'sand force': 'Sand',
  chlorophyll: 'Sun', 'solar power': 'Sun',
  'swift swim': 'Rain', 'rain dish': 'Rain', 'dry skin': 'Rain',
  'snow cloak': 'Snow', 'slush rush': 'Snow',
};
// The subset of CONDITION_REQUIRING_ABILITIES that also double Speed — these are
// the ones FIX 4 (Scarf mutual exclusivity) cares about specifically.
const CONDITIONAL_SPEED_ABILITIES = new Set(['swift swim', 'chlorophyll', 'sand rush', 'slush rush']);

async function getRealAbilityFrequency(pokemonLower) {
  const { rows } = await pool.query(
    `SELECT LOWER(p->>'ability') as ability_lower,
            (array_agg(p->>'ability' ORDER BY id))[1] as ability_display,
            COUNT(*) as count
     FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
     WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) = $1 AND p->>'ability' IS NOT NULL
     GROUP BY LOWER(p->>'ability') ORDER BY count DESC`,
    [pokemonLower]
  );
  const total = rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
  return rows.map((r) => ({
    ability: r.ability_display,
    count: parseInt(r.count, 10),
    frequency: total > 0 ? round(parseInt(r.count, 10) / total, 4) : 0,
  }));
}

// Which weather (if any) is already active on the team, from already-resolved
// teammate abilities + each teammate's real top moves — reused by both ability
// condition-filtering (this file) and Weather Ball's dynamic typing (see
// synergy_reasons.js/team_analyzer.js, which both take this same Set shape).
function detectTeamWeatherContext(resolvedAbilities, teamTopMoveNames) {
  const active = new Set();
  for (const ability of resolvedAbilities) {
    const weather = WEATHER_SETTER_ABILITIES[(ability || '').toLowerCase()];
    if (weather) active.add(weather);
  }
  for (const moveNames of teamTopMoveNames) {
    for (const mv of moveNames) {
      const weather = WEATHER_SETTER_MOVES[(mv || '').toLowerCase()];
      if (weather) active.add(weather);
    }
  }
  return active;
}

// STEP 3.1/3.2/3.3: highest real-frequency ability whose condition (if any) is
// met by the team's active weather; a conditional ability with an unmet
// condition is skipped (score 0) rather than picked, falling through to the next
// real ability — this alone reproduces "prefer non-conditional ability when the
// condition isn't met" (e.g. Basculegion -> Adaptability over Swift Swim,
// verified live: Adaptability is 93.87% of real Basculegion appearances vs.
// Swift Swim's 6.13%, so it's already the top real pick regardless of team
// weather) without any extra special-casing.
function resolveRealAbility(frequencyList, teamWeatherSet) {
  for (const entry of frequencyList) {
    const abilityLower = entry.ability.toLowerCase();
    const requiredCondition = CONDITION_REQUIRING_ABILITIES[abilityLower];
    if (requiredCondition && !teamWeatherSet.has(requiredCondition)) continue;
    return entry;
  }
  return frequencyList[0] || null; // nothing cleared the filter — real top pick is still better than nothing
}

function isConditionalSpeedAbility(abilityName) {
  return CONDITIONAL_SPEED_ABILITIES.has((abilityName || '').toLowerCase());
}

function conditionalSpeedAbilityWeather(abilityName) {
  return CONDITION_REQUIRING_ABILITIES[(abilityName || '').toLowerCase()] || null;
}

// --- STEP 2: item_role_fit -------------------------------------------------------
// Fixed VGC item-mechanic vocabulary — not Pokemon-specific (same category as
// synergy_reasons.js's WEATHER_MOVE_RULES/SUPPORT_MOVE_EFFECTS tables). Applied
// programmatically to whichever item/role/base-stats combination shows up, never
// hardcoded per species.
function itemRoleFit(itemName, role, pokemonRow, options = {}) {
  const item = (itemName || '').toLowerCase();
  const physical = isPhysicalLeaning(pokemonRow);
  const bulkyTotal = pokemonRow.hp + pokemonRow.def + pokemonRow.spd;

  if (item === 'life orb') {
    if (OFFENSIVE_ROLES.has(role)) return 1.0;
    if (role === 'slow_bulky_support') return 0.2;
    return 0.5;
  }
  if (item === 'choice scarf') {
    // FIX 4: a Pokemon whose real resolved ability is an active conditional
    // speed-boost (Swift Swim/Chlorophyll/Sand Rush/Slush Rush, with the
    // matching weather actually up on this team) is a weather-abuser build —
    // Scarf's 1.5x Speed is redundant with (and narrower than) an ability that
    // already doubles Speed under that weather, so it's excluded outright
    // rather than merely deprioritized.
    if (options.isWeatherAbuser) return 0;
    if (role === 'fast_offense') {
      if (pokemonRow.spe < 80) return 1.2;
      if (pokemonRow.spe >= 100) return 0.6;
      return 0.8; // 80-99 base Speed: between the two named cases, not explicitly specified
    }
    return 0.5;
  }
  if (item === 'choice band') return physical ? 1.0 : 0.5;
  if (item === 'choice specs') return !physical ? 1.0 : 0.5;
  if (item === 'leftovers' || item === 'sitrus berry') {
    if (BULKY_ROLES.has(role)) return 1.0;
    if (role === 'fast_offense') return 0.4;
    return 0.5;
  }
  if (item === 'assault vest') {
    return BULKY_ROLES.has(role) && pokemonRow.spd >= pokemonRow.def ? 1.0 : 0.5;
  }
  if (item === 'rocky helmet') {
    return BULKY_ROLES.has(role) && pokemonRow.def >= pokemonRow.spd ? 0.9 : 0.5;
  }
  if (item === 'focus sash') {
    return role === 'fast_offense' && bulkyTotal < BULKY_TOTAL_THRESHOLD ? 0.9 : 0.5;
  }
  return 0.5; // any item not matching a known role rule
}

// --- STEP 1 + 2: candidate items scored for one Pokemon -------------------------
// `options.isWeatherAbuser` (see FIX 4 above) forces Choice Scarf's score to 0 for
// this Pokemon — everything else about candidate sourcing/scoring is unchanged.
async function getScoredCandidateItems(pokemonRow, role, options = {}) {
  const pokemonLower = pokemonRow.name.toLowerCase();
  const candidates = await getCommonItems(pokemonLower, 5);
  return candidates
    .map((c) => {
      const roleFit = itemRoleFit(c.item, role, pokemonRow, options);
      const coherence = itemCoherencePenalty(c.item, role);
      const megaPenalty = megaStoneSynergyPenalty(c.item, pokemonRow, options.teamWeatherContext);

      // FIX 12: Chlorophyll + Sun synergy bonus — when Pokemon has a conditional
      // speed ability that's active (Chlorophyll + Sun), offensive items (Life Orb,
      // etc.) get a big bonus because doubled Speed makes every hit more impactful.
      // This bonus must be large enough to win item conflict resolution against
      // teammates who also want Life Orb.
      let synergyBonus = 1.0;
      const isWeatherAbuser = options.isWeatherAbuser;
      const itemLower = (c.item || '').toLowerCase();
      if (isWeatherAbuser && OFFENSIVE_ROLES.has(role)) {
        // Pokemon with active speed-doubled ability benefits most from offensive items
        if (itemLower === 'life orb') synergyBonus = 2.5;
        else if (itemLower === 'focus sash') synergyBonus = 1.2;
        else if (itemLower === 'choicespecs' || itemLower === 'choice band') synergyBonus = 1.5;
      }

      return { ...c, role_fit: roleFit, score: round(c.frequency * roleFit * coherence * megaPenalty * synergyBonus, 4) };
    })
    .sort((a, b) => b.score - a.score);
}

// Ranks every real globally-observed item (see getGlobalItemFrequency) by
// real frequency x itemRoleFit() for this Pokemon's role, and returns the
// best-fit item not already claimed by a teammate. 0.25x scale on the score
// keeps a fallback pick always below any real per-species candidate score
// (see getScoredCandidateItems), same intent the old hardcoded list's flat
// 0.25 score had — this is still a last-resort pick, not a claim it's common
// for this specific Pokemon.
function pickGenericFallback(role, pokemonRow, usedItemsLower, options = {}, globalItemFrequency = []) {
  const total = globalItemFrequency.reduce((sum, i) => sum + i.count, 0);
  let best = null;
  for (const entry of globalItemFrequency) {
    const itemLower = entry.item.toLowerCase();
    if (usedItemsLower.has(itemLower)) continue;
    if (options.isWeatherAbuser && itemLower === 'choice scarf') continue;
    const roleFit = itemRoleFit(entry.item, role, pokemonRow, options);
    const frequency = total > 0 ? entry.count / total : 0;
    const score = round(frequency * roleFit * 0.25, 4);
    if (!best || score > best.score) {
      best = { item: entry.item, count: entry.count, frequency: round(frequency, 4), source: 'generic_fallback', role_fit: roleFit, score };
    }
  }
  if (best) return best;
  // Absolute last resort: every real observed item was already claimed by a
  // teammate. Sitrus Berry is real and heavily played (1000+ observed
  // appearances across the corpus), and a safe universal default regardless
  // of role — this branch is expected to be effectively unreachable in
  // practice (it would require every one of 100+ real observed items to
  // already be claimed by the other 5 team members).
  return { item: 'Sitrus Berry', count: 0, frequency: 0, source: 'generic_fallback', role_fit: 0.5, score: 0.1 };
}

// --- STEP 3: conflict resolution --------------------------------------------------
// teamCandidates: [{ pokemon, role, pokemonRow, candidates: [scored, sorted desc] }]
// Greedy, per the spec: for every item wanted by 2+ Pokemon, whoever loses the most
// value by switching away from it (item_score_primary - item_score_next_best) keeps
// it; everyone else advances to their own next-best distinct candidate. Repeats
// until no conflicts remain (bounded iteration count as a safety net against
// pathological cycles — never observed in practice with 6 Pokemon x 5 candidates,
// but the team size/candidate count aren't hard-capped elsewhere in this module).
function resolveItemConflicts(teamCandidates, globalItemFrequency = []) {
  const pickIndex = new Map(); // pokemon -> index into their own candidates array
  for (const tc of teamCandidates) pickIndex.set(tc.pokemon, 0);

  function currentPick(tc) {
    return tc.candidates[pickIndex.get(tc.pokemon)] || null;
  }
  function lossOfValue(tc) {
    const idx = pickIndex.get(tc.pokemon);
    const primary = tc.candidates[idx]?.score ?? 0;
    const next = tc.candidates[idx + 1]?.score ?? 0;
    return primary - next;
  }

  const MAX_ITERATIONS = 50;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const byItem = new Map();
    for (const tc of teamCandidates) {
      const pick = currentPick(tc);
      if (!pick) continue;
      const key = pick.item.toLowerCase();
      if (!byItem.has(key)) byItem.set(key, []);
      byItem.get(key).push(tc);
    }

    let hadConflict = false;
    for (const conflicted of byItem.values()) {
      if (conflicted.length <= 1) continue;
      hadConflict = true;
      conflicted.sort((a, b) => lossOfValue(b) - lossOfValue(a));
      // conflicted[0] (highest loss_of_value — needs it most) keeps the item;
      // everyone else advances to their next candidate.
      for (let i = 1; i < conflicted.length; i++) {
        pickIndex.set(conflicted[i].pokemon, pickIndex.get(conflicted[i].pokemon) + 1);
      }
    }
    if (!hadConflict) break;
  }

  const usedItemsLower = new Set();
  const assignments = [];
  for (const tc of teamCandidates) {
    let pick = currentPick(tc);
    const idx = pickIndex.get(tc.pokemon);
    let nextBest = tc.candidates[idx + 1] || null;
    if (!pick || usedItemsLower.has(pick.item.toLowerCase())) {
      pick = pickGenericFallback(tc.role, tc.pokemonRow, usedItemsLower, { isWeatherAbuser: tc.isWeatherAbuser }, globalItemFrequency);
      nextBest = null;
    }
    usedItemsLower.add(pick.item.toLowerCase());
    assignments.push({
      pokemon: tc.pokemon,
      item: pick.item,
      score: pick.score,
      source: pick.source,
      next_best: nextBest ? { item: nextBest.item, score: nextBest.score } : null,
    });
  }
  return assignments;
}

// --- Item-specific EV/SP interactions ---------------------------------------------

// Life Orb recoil = floor(finalHP / 10) per boosted attack. For each recoil
// "bracket" (every 10 points of final HP), the SP value one below where the
// bracket rolls over is the efficient stopping point — investing further HP SP
// past it starts costing 1 more recoil per attack for no bulk benefit within the
// current bracket. Flags that boundary SP value directly (see the design decision
// in CLAUDE.md for why this reads the spec's `floor((HP+1)/10) == floor(HP/10)`
// condition as "the last SP before it stops holding", not every SP satisfying it —
// the literal condition holds for ~9 of every 10 SP values, which would flood
// sp_notes with near-meaningless entries instead of the small, actionable set of
// genuine "invest up to exactly here" points).
function findLifeOrbBreakpoints(baseHp) {
  const breakpoints = [];
  for (let sp = 0; sp < SP_CAP_PER_STAT; sp++) {
    const hpNow = calcStat(baseHp, sp, 1.0, true);
    const hpNext = calcStat(baseHp, sp + 1, 1.0, true);
    if (Math.floor(hpNext / 10) > Math.floor(hpNow / 10)) breakpoints.push(sp);
  }
  return breakpoints;
}

// Leftovers heals floor(finalHP / 16) per turn — a genuine, literal "invest to
// here for +1 extra HP of healing" breakpoint, exactly as specified.
function findLeftoversBreakpoints(baseHp) {
  const breakpoints = [];
  for (let sp = 0; sp < SP_CAP_PER_STAT; sp++) {
    const hpNow = calcStat(baseHp, sp, 1.0, true);
    const hpNext = calcStat(baseHp, sp + 1, 1.0, true);
    if (Math.floor(hpNext / 16) > Math.floor(hpNow / 16)) breakpoints.push(sp + 1);
  }
  return breakpoints;
}

// Small, additive nudge toward landing exactly on an item breakpoint when the GA
// is otherwise choosing between similar-scoring HP SP values — see
// spread_scorer.js's scoreSpread(), which calls this once per candidate. Never
// touches the real threshold scoring (TYPE_VALUES/ROLE_MULTIPLIERS), purely additive.
function itemBreakpointBonus(pokemonRow, sp, item) {
  const itemLower = (item || '').toLowerCase();
  if (itemLower === 'life orb') {
    return findLifeOrbBreakpoints(pokemonRow.hp).includes(sp.hp) ? 0.3 : 0;
  }
  if (itemLower === 'leftovers') {
    return findLeftoversBreakpoints(pokemonRow.hp).includes(sp.hp) ? 0.4 : 0;
  }
  return 0;
}

// Post-hoc sp_notes annotation for a finalized spread — called once per Pokemon
// after EV optimization, not part of the search itself (see route handler).
function buildItemSpNotes(pokemonRow, sp, item) {
  const notes = [];
  const itemLower = (item || '').toLowerCase();
  if (itemLower === 'life orb' && findLifeOrbBreakpoints(pokemonRow.hp).includes(sp.hp)) {
    notes.push(`${sp.hp} HP SP — Life Orb recoil breakpoint: saves 1 HP per attack`);
  } else if (itemLower === 'leftovers' && findLeftoversBreakpoints(pokemonRow.hp).includes(sp.hp)) {
    notes.push(`${sp.hp} HP SP — Leftovers breakpoint: heals 1 extra HP per turn`);
  } else if (itemLower === 'sitrus berry') {
    const finalHp = calcStat(pokemonRow.hp, sp.hp || 0, 1.0, true);
    const healAmount = Math.floor(finalHp * 0.25);
    const triggerHp = Math.floor(finalHp * 0.5);
    notes.push(`Sitrus Berry heals ${healAmount} HP (25% of ${finalHp} max HP) when below ${triggerHp} HP`);
  } else if (itemLower === 'choice scarf') {
    notes.push('Choice Scarf: 1.5x Speed already applied — Speed SP redirected to other stats');
  } else if (itemLower === 'assault vest') {
    notes.push('Assault Vest: 1.5x Special Defense already applied — SpD thresholds weighted higher in search');
  }
  return notes;
}

// FIX 12: Mega Stone vs base ability synergy tradeoff — evaluates whether a Mega
// Stone should be deprioritized because the base form's conditional ability
// (Chlorophyll, Swift Swim, etc.) has active team synergy.
// For Venusaur on sun team: Chlorophyll doubles Speed to ~200 under Drought from
// Charizard-Mega-Y, which is far more valuable than Mega Venusaur's Thick Fat bulk.
function megaStoneSynergyPenalty(itemName, pokemonRow, teamWeatherContext) {
  const item = (itemName || '').toLowerCase();
  // Only apply to Mega Stones (items ending in "ite")
  if (!item.endsWith('ite')) return 1.0;
  if (!pokemonRow?.ability1) return 1.0;

  const baseAbility = pokemonRow.ability1.toLowerCase();
  const CONDITIONAL_WEATHER = {
    chlorophyll: 'Sun', 'solar power': 'Sun',
    'swift swim': 'Rain',
    'sand rush': 'Sand', 'sand force': 'Sand', 'sand veil': 'Sand',
    'slush rush': 'Snow',
  };
  const weather = CONDITIONAL_WEATHER[baseAbility];
  if (!weather) return 1.0;
  if (!teamWeatherContext || !teamWeatherContext.has(weather)) return 1.0;

  // Base ability synergy is active — Mega Stone loses the synergy benefit.
  // 0.4x penalty: the speed doubling from Chlorophyll is extremely valuable
  // in doubles (Venusaur base 80 Speed → 200 effective Speed under Sun).
  return 0.4;
}

module.exports = {
  itemRoleFit,
  getScoredCandidateItems,
  resolveItemConflicts,
  findLifeOrbBreakpoints,
  findLeftoversBreakpoints,
  itemBreakpointBonus,
  buildItemSpNotes,
  getRealAbilityFrequency,
  detectTeamWeatherContext,
  resolveRealAbility,
  isConditionalSpeedAbility,
  conditionalSpeedAbilityWeather,
  megaStoneSynergyPenalty,
  WEATHER_SETTER_ABILITIES,
  WEATHER_SETTER_MOVES,
  CONDITION_REQUIRING_ABILITIES,
  OFFENSIVE_ROLES,
  BULKY_ROLES,
  isDamageBoostingItem,
  getGlobalItemFrequency,
  DAMAGE_BOOSTING_ITEMS,
};
