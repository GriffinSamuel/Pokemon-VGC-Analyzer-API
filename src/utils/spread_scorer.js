const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { calcStat, natureMultiplierFor, SP_CAP_PER_STAT, SP_BUDGET_TOTAL, STAT_ORDER } = require('./stat_formula');
const { getCommonSpreads, getCommonSpeedTiers, getSpeciesRow, getTopDamageAffectingItem } = require('./ev_observations');
const { getSpeedModifiers, trickroomRelevant } = require('./speed_context');
const { itemBreakpointBonus, OFFENSIVE_ROLES, WEATHER_SETTER_ABILITIES, CONDITION_REQUIRING_ABILITIES } = require('./item_optimizer');
const { classifyRole } = require('./role_classifier');
const { CalcDamage, getMoveData } = require('./nerd_of_now_calc');
const { effectivenessAgainst } = require('./typeChart');
const { round } = require('./format');
const { weatherChangesDamage, resolveTypeFor, accuracyNoteFor } = require('./weather_rules');

// Items @smogon/calc already models natively (Choice Scarf's 1.5x Speed, Choice
// Band/Specs'/Life Orb's damage multipliers + Life Orb recoil, Assault Vest's
// 1.5x SpD) are handled simply by passing `item` into damage.buildPokemon() below
// — no mechanics are reimplemented here. What @smogon/calc can't do on its own is
// bias the SEARCH: recognizing that further Speed SP is close to wasted once
// Scarf already guarantees a huge Speed lead, or that SpD investment deserves
// extra weight when AV is already multiplying it. Those two items are the only
// ones needing special-cased logic below; everything else just flows through.
const CHOICE_SCARF_SPEED_MULTIPLIER = 1.5;
const ASSAULT_VEST_SPD_CONTRIBUTION_MULTIPLIER = 1.5;

const MODELS_DIR = path.join(__dirname, '..', 'ml', 'models');
const MIN_THREAT_WEIGHT = 0.05; // same bound findDefensiveThresholds() already uses — keeps per-candidate calc cost bounded
const HIGH_USAGE_THRESHOLD = 10; // percent, matches findOffensiveThresholds()'s existing target filter
const TRICKROOM_ROLES = new Set(['slow_bulky_offense', 'slow_bulky_support']);
const TRICKROOM_PREVALENCE_THRESHOLD = 0.25;
const ZERO_SP = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const KO_TIERS = ['OHKO', '2HKO', '3HKO', '4HKO', 'no_ko'];

// speed_ohko_link (FIX 2): outspeeding a threat that can also OHKO you at 0 SP
// baseline is categorically more valuable than outspeeding one that merely
// inconveniences you — losing the speed tier there means losing the game then
// and there, not just taking chip damage. speed_death_trap_penalty: the mirror
// case — a common threat that OHKOs AND outspeeds AND can't be avoided (no
// Protect/priority) actively makes a spread worse, not just "not better".
const SPEED_OHKO_LINK_MULTIPLIER = 3.0;
const DEATH_TRAP_MIN_WEIGHT = 0.15;
const DEATH_TRAP_PENALTY_MULTIPLIER = 2.0;

// FIX 3: bumped whenever this file's scoring formula changes materially — the
// evolutionary result cache lives in ev_optimizer.js keyed on
// pokemon+nature+item+team/solo (see that file), which has no way to know this
// file's contribution math changed underneath it. Exported so a future cache
// key can fold it in. NOT wired into ev_optimizer.js's cache key from here:
// that would mean editing a second file, which this task's own instructions
// restrict against, and is unnecessary in practice — the verification steps
// explicitly restart the server first, and evolutionaryCache is a plain
// in-memory Map with no persistence, so a restart already fully invalidates
// every previously cached result regardless of this constant. This round's task
// has no single-file restriction, so SCORER_VERSION is now also wired directly
// into ev_optimizer.js's evolutionaryCacheKey() (see that file) — the first time
// this constant has actually been load-bearing rather than a documented no-op.
// Bumped 4->5 this round: attacker items are now threaded into the real damage
// calc itself (FIX 3/4), not just display — a genuine scoring-relevant change,
// not merely a cosmetic one, so stale pre-fix cached scores must not survive.
// Bumped 9->10: defensive threshold attribution and the marginal-value guard
// both changed (see the DEFENSIVE loop). `score` itself is unchanged, but
// `thresholds_met` is what minimizeSpread() accepts or rejects each -1 SP step
// against, so the final minimized spread this file produces genuinely differs.
// Cached pre-fix results must not survive.
// Bumped 10->11: every credited defensive threshold now tests BOTH the stat
// under consideration and hp against the counterfactual, and records the
// co-dependency in `also_load_bearing`. That changes which stat a threshold is
// attributed to, which changes what minimizeSpread() will strip, which changes
// the final spread. Separately, spread_optimizer now refills every spread to
// exactly 66 SP after minimization, so a cached pre-fix result would still be
// served at 64/65 SP and look like the fix had not landed.
// Bumped 11->12: threshold `threat` strings now carry Weather Ball's resolved
// attacking type. The strings live inside cached scorer results, so a stale
// cache entry would keep printing the unlabelled form.
// Bumped 12->13: the damage calculator now implements defensive items — Focus
// Sash, all 18 type-resist berries, Assault Vest, Eviolite, Air Balloon. Before
// this, Utility Umbrella was the ONLY defensive item it understood, so every
// cached spread was optimised against opponents calculated as itemless. Those
// numbers are wrong and must not survive.
const SCORER_VERSION = 13;

// Weather Ball is the only move whose attacking type is not knowable from the
// moves table — it is stored as Normal and resolved at damage time. The
// calculator gets this right internally (see resolveWeatherBallType in
// nerd_of_now_calc.js), but the threat STRING built below is what the Why block
// prints, and it was showing a bare "Torkoal Weather Ball" — the one move in the
// output whose type the reader cannot infer from the name.
//
// An attacker that sets its own weather always attacks under it (Torkoal's
// Drought makes its Weather Ball Fire); otherwise the field weather this
// threshold was calculated under decides. resolveTypeFor() lives in
// weather_rules.js — shared with archetype_matchups.js and team.js rather
// than re-derived a third time in this file (this WAS a third copy, now
// removed).
function displayMoveName(moveName, attackerAbility, fieldWeather) {
  if (moveName !== 'Weather Ball') return moveName;
  const type = resolveTypeFor(moveName, null, attackerAbility, fieldWeather);
  return type ? `Weather Ball (${type})` : 'Weather Ball (Normal — no weather)';
}

// FIX 2: steeper type_value curve. This is a NEW multiplicative layer specific
// to this file's evolutionary scorer — it does not replace or alter
// ev_optimizer.js's existing ROLE_MULTIPLIERS/roleMult[multKey] mechanism
// (that file is out of scope for this task), it multiplies alongside it, same
// as the worked example in the task spec (`contribution = 10.0 * effective_weight
// * role_mult`). A 3HKO is far less valuable than a flat 3x-cheaper-than-OHKO
// split would suggest in real VGC doubles: the opponent likely switches,
// speed/priority/partner-play intervene before 3 hits land, and SP spent
// chasing a 3HKO threshold is usually wasted — so 3HKO/4HKO are pushed toward
// (not all the way to) zero rather than kept proportionate to OHKO/2HKO.
const TYPE_VALUES = {
  ohko_prevented: 10.0,
  '2hko_prevented': 3.0,
  '3hko_prevented': 0.3,
  '4hko_prevented': 0.05,
  ohko_achieved: 8.0,
  '2hko_achieved': 2.0,
  speed_tier: 4.0,
  trickroom_speed: 3.0,
};

// FIX 1: aggression_multiplier — models whether an attacker would realistically
// deploy this exact move against this exact defender, before that threat's
// base_weight (usage x move confidence) counts toward the defensive
// contribution. Scoped to the DEFENSIVE section only (see scoreSpread below for
// why): it's a question about "will they attack me with this," which isn't a
// meaningful question for the OFFENSIVE section (we always deliberately pick
// our own best move) or the SPEED section (outspeeding an attacker matters
// regardless of which of their moves happens to carry the highest threat-matrix
// weight — that entry's move is sometimes a status move like Protect, and
// zeroing a real Speed benchmark because of that would be a modeling error).
const AGGRESSION_SUPER_EFFECTIVE = 2.5;
const AGGRESSION_STAB_NEUTRAL = 1.2;
const AGGRESSION_OFFENSIVE_ROLE = 1.0;
// FIX 1 (round 2): lowered further — 0.40->0.20 / 0.15->0.05. The optimizer was
// still over-investing HP/bulk on offensive-role mons because a neutral hit from
// a support attacker, even at the previous 0.4/0.15 multipliers, accumulated
// enough contribution across many low-weight support-mon threats to compete with
// real attack/speed investment. Halving both values keeps the same rule priority
// and relative ordering (STAB-neutral-support still scores 4x non-STAB-support,
// matching the original 0.4/0.15 ratio) while making neutral support pressure
// close to negligible rather than merely small.
const AGGRESSION_SUPPORT_STAB = 0.2;
const AGGRESSION_SUPPORT_OFF_STAB = 0.05;
const AGGRESSION_NON_DAMAGING = 0.0;

// FIX 2: recoil moves and their damage-to-recoil ratios (applied to attacker)
const RECOIL_MOVES = new Map([
  ['brave bird', 0.33],
  ['flare blitz', 0.33],
  ['double-edge', 0.33],
  ['wild charge', 0.25],
  ['wave crash', 0.33],
  ['head smash', 0.50],
  ['wood hammer', 0.33],
  ['volt tackle', 0.33],
  ['take down', 0.25],
  ['submission', 0.25],
  // Confirmed via moves.flags in the DB (recoil: [1,2]) — missing here despite
  // 167 observed tournament_teams rows (PHASE 4 investigation). Was silently
  // never getting recoil display text or the PHASE 4 tiebreak.
  ['light of ruin', 0.50],
]);

const attackerRoleCache = new Map();
// Cache per attacker name — role_classifier.js's classifyRole() queries
// ev_observations/moveset data, and doesn't vary with the SP spread being
// scored, only with the attacker's species — same reasoning as every other
// per-process memoized lookup in this file (getPokemonRow, getMoveRow, etc.).
async function getCachedAttackerRole(nameLower) {
  if (attackerRoleCache.has(nameLower)) return attackerRoleCache.get(nameLower);
  const promise = classifyRole(nameLower).then((r) => r.role);
  attackerRoleCache.set(nameLower, promise);
  return promise;
}

// Rule priority — first matching rule wins, per spec:
//   1. Super effective (>=2x)                          -> 2.5
//   2. STAB + neutral (1x)                              -> 1.2
//   3. Offensive-role attacker (any remaining case)      -> 1.0
//   4/5. Support-role attacker, non-STAB/STAB, <=1x      -> 0.15 / 0.4
//   6. Non-damaging move                                 -> 0.0
// Rules 1/2 are checked before any role split, since a support Pokemon
// bringing a genuinely super-effective or STAB-neutral move is still a real,
// deliberate threat regardless of its usual role. By the time rule 4/5 is
// reached, effectiveness <= 1 and role is non-offensive are already both
// guaranteed (given the 4-role system's exhaustive offensive/support split),
// so the only remaining question is STAB.
function computeAggressionMultiplier(attackerRole, attackerRow, moveRow, moveType, defenderTypes) {
  if (!moveRow || moveRow.category === 'Status' || !moveRow.power) return AGGRESSION_NON_DAMAGING;

  const effectiveness = effectivenessAgainst(moveType, defenderTypes);
  const isStab = [attackerRow.type1, attackerRow.type2].filter(Boolean).includes(moveType);

  if (effectiveness >= 2) return AGGRESSION_SUPER_EFFECTIVE;
  if (isStab && effectiveness === 1) return AGGRESSION_STAB_NEUTRAL;
  if (OFFENSIVE_ROLES.has(attackerRole)) return AGGRESSION_OFFENSIVE_ROLE;
  return isStab ? AGGRESSION_SUPPORT_STAB : AGGRESSION_SUPPORT_OFF_STAB;
}

// aggression_multiplier depends only on (defender species, attacker, move) —
// never on the SP spread being scored — so, like every other per-process cache
// in this file, it's wasted work to recompute it (including its own async role
// lookup) on every one of the thousands of candidates scoreSpread() sees per
// search. Measured live: leaving this uncached made a 6-Pokemon team-build
// request go from ~14s to ~65-70s (a real, reproducible ~5x regression, not
// noise) — caching it restores the original per-candidate cost.
const aggressionMultiplierCache = new Map();
async function getCachedAggressionMultiplier(defenderNameLower, attackerNameLower, moveNameLower, attackerRow, moveRow, moveType, defenderTypes) {
  const key = `${defenderNameLower}|${attackerNameLower}|${moveNameLower}`;
  if (aggressionMultiplierCache.has(key)) return aggressionMultiplierCache.get(key);
  const attackerRole = await getCachedAttackerRole(attackerNameLower);
  const mult = computeAggressionMultiplier(attackerRole, attackerRow, moveRow, moveType, defenderTypes);
  aggressionMultiplierCache.set(key, mult);
  return mult;
}

// 1-tier / multi-tier improvement factors. The spec only defines the 1-tier and
// one 2-tier example per baseline (OHKO->3HKO: 0.7, 2HKO->4HKO: 0.6) — jumps it
// doesn't enumerate (e.g. OHKO baseline straight to no_ko) use a reasonable,
// disclosed interpolation of that same shrinking-return pattern rather than
// inventing an unrelated number.
const DEFENSIVE_TIER_FACTORS = {
  0: { 1: 1.0, 2: 0.7, 3: 0.65, 4: 0.6 }, // baseline OHKO
  1: { 1: 1.0, 2: 0.6, 3: 0.55 },          // baseline 2HKO
  2: { 1: 1.0, 2: 0.55 },                   // baseline 3HKO
  3: { 1: 1.0 },                             // baseline 4HKO
};
const OFFENSIVE_TIER_FACTORS = {
  // baseline tier index -> credit for reaching OHKO (index 0) / 2HKO (index 1)
  1: { 0: 1.0 },              // baseline 2HKO -> OHKO
  2: { 0: 0.85, 1: 1.0 },     // baseline 3HKO -> OHKO or 2HKO
  3: { 0: 0.7, 1: 0.7 },      // baseline 4HKO -> OHKO or 2HKO
  4: { 0: 0.6, 1: 0.6 },      // baseline no_ko -> OHKO or 2HKO
};

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function tierIndex(tier) {
  return KO_TIERS.indexOf(tier);
}

// Classifies a single guaranteed-tier threshold. Fed `koCheckValue`, which is a
// worst-case damage number whose direction (max for defense, min for offense)
// already encodes "guaranteed regardless of build/roll variance" — see
// weightedDefensiveDamage/weightedOffensiveDamage.
function koFromPercent(percent) {
  if (percent >= 100) return 'OHKO';
  if (percent >= 50) return '2HKO';
  if (percent >= 33) return '3HKO';
  if (percent >= 25) return '4HKO';
  return 'no_ko';
}

// --- Cached lookups ------------------------------------------------------------
// scoreSpread() is called many thousands of times per optimization run (Phase B/C
// of spread_optimizer.js) — none of these lookups vary with the SP spread being
// scored, only with species/move names, so they're memoized at module scope for
// the lifetime of the process rather than re-queried/re-parsed per call (a real
// deviation from this codebase's usual "re-read the JSON file every call"
// convention elsewhere, justified here by call volume being orders of magnitude
// higher than any existing caller).
const pokemonRowCache = new Map();
const moveRowCache = new Map();
const attackerSpreadsCache = new Map();
const speedModifiersCache = new Map();
const speedTiersCache = new Map();
let moveRecommendationsCache = null;
let offensiveTargetsCache = null; // usage_stats target list — same for every candidate in a run

// getSpeedModifiers() (speed_context.js) runs several of its own DB round-trips
// per call (item frequency, ability frequency, synergy/usage lookups) and — like
// the lookups above — doesn't depend on the candidate spread being scored, only
// on the attacker's species. Uncached, this was the dominant per-candidate cost
// (measured ~150ms/candidate with warm caches everywhere else); memoizing it here
// cuts a full scoring pass down to low-single-digit milliseconds once warm.
async function getCachedSpeedModifiers(attackerName) {
  const key = attackerName.toLowerCase();
  if (speedModifiersCache.has(key)) return speedModifiersCache.get(key);
  const promise = getSpeedModifiers(attackerName);
  speedModifiersCache.set(key, promise);
  return promise;
}

// getCommonSpeedTiers() is called directly (not just via getSpeedModifiers above)
// in the SPEED section's per-attacker loop below — same "doesn't depend on the
// candidate spread" reasoning applies, so it gets the same per-process memoization.
async function getCachedSpeedTiers(nameLower) {
  if (speedTiersCache.has(nameLower)) return speedTiersCache.get(nameLower);
  const promise = getCommonSpeedTiers(nameLower);
  speedTiersCache.set(nameLower, promise);
  return promise;
}

// The usage_stats top-20 target list for offensive contribution scoring is
// identical across every candidate scored in a run (it doesn't depend on the
// candidate's SP spread at all) — was previously re-queried from the DB on every
// single scoreSpread() call for offensive roles, a real, measurable contributor
// to the per-candidate cost alongside the two caches above.
async function getCachedOffensiveTargets() {
  if (offensiveTargetsCache) return offensiveTargetsCache;
  offensiveTargetsCache = pool.query(
    'SELECT pokemon_name, usage_percent FROM usage_stats WHERE usage_percent > $1 ORDER BY usage_percent DESC LIMIT 20',
    [HIGH_USAGE_THRESHOLD]
  ).then((r) => r.rows);
  return offensiveTargetsCache;
}

// FIX 1 STEP 6: uses the same hyphen-stripping Mega-form fallback ev_observations.js's
// getSpeciesRow() already applies elsewhere in this codebase (threat_matrix.js,
// recommend.js's topMovesFor, item_optimizer.js). Before this fix, a direct, no-fallback
// lookup here meant every Mega-form attacker silently failed `if (!attackerRow) continue`
// and vanished from every damage calculation in this file — verified live: Raichu-Mega-Y
// (8.21% real usage) and Staraptor-Mega (11.94%, post FIX-1-STEP-2) generated zero
// defensive/offensive/speed threats despite being real, significant threats, once their
// usage_stats/move_recommendations.json entries were otherwise correctly split out (see
// CLAUDE.md). Falling back to the real base form's stats is the best available
// approximation given no Mega base stats exist anywhere in this project's real data —
// deliberately NOT the same as fabricating invented numbers, and a real, disclosed
// reversal of an earlier round's narrower "skip rather than fabricate" choice in
// team_analyzer.js's analyzeMatchups() (updated the same way — see that file).
async function getPokemonRow(nameLower) {
  if (pokemonRowCache.has(nameLower)) return pokemonRowCache.get(nameLower);
  const row = await getSpeciesRow(nameLower);
  pokemonRowCache.set(nameLower, row);
  return row;
}

async function getMoveRow(nameLower) {
  if (moveRowCache.has(nameLower)) return moveRowCache.get(nameLower);
  const { rows } = await pool.query('SELECT * FROM moves WHERE LOWER(name) = LOWER($1)', [nameLower]);
  const row = rows[0] || null;
  moveRowCache.set(nameLower, row);
  return row;
}

// Top 3 observed SP spreads for a species, ranked by real observation frequency
// (ev_observations via getCommonSpreads) — mandatory per spec for every damage
// calc involving an opposing Pokemon. Frequencies are renormalized to sum to 1
// across the (up to 3) spreads actually used, so the weighted average below is a
// true weighted average even when a 4th+ spread's share was excluded.
async function getTopAttackerSpreads(nameLower) {
  if (attackerSpreadsCache.has(nameLower)) return attackerSpreadsCache.get(nameLower);
  const promise = (async () => {
    const { spreads } = await getCommonSpreads(nameLower);
    const top3 = spreads.slice(0, 3);
    if (top3.length === 0) {
      return [{ sp: ZERO_SP, nature: null, frequency: 1, raw_frequency: 1 }];
    }
    const totalFreq = top3.reduce((sum, s) => sum + s.frequency, 0);
    return top3.map((s) => ({ sp: s.sp, nature: s.nature, frequency: totalFreq > 0 ? s.frequency / totalFreq : 1 / top3.length, raw_frequency: s.frequency }));
  })();
  attackerSpreadsCache.set(nameLower, promise);
  return promise;
}

// FIX 3/4: an attacker's real top damage-affecting item (Choice Band, Black
// Glasses, Life Orb, etc. — see ev_observations.js's DAMAGE_AFFECTING_ITEMS),
// doesn't depend on the candidate spread being scored, only on the attacker's
// species — same per-process memoization reasoning as every other cached
// lookup in this file.
// Unwraps to the plain item-name string (or null) here at the source — every
// consumer (weightedDefensiveDamage's `attackerSide.item`, @smogon/calc's own
// Pokemon builder, buildAttackerBuildLabel's display string) expects a string,
// not getTopDamageAffectingItem()'s {item, count, frequency, source} object.
const attackerItemCache = new Map();
async function getCachedAttackerItem(nameLower) {
  if (attackerItemCache.has(nameLower)) return attackerItemCache.get(nameLower);
  const promise = getTopDamageAffectingItem(nameLower).then((result) => result?.item || null);
  attackerItemCache.set(nameLower, promise);
  return promise;
}

function readMoveRecommendations() {
  if (moveRecommendationsCache === null) {
    const filePath = path.join(MODELS_DIR, 'move_recommendations.json');
    moveRecommendationsCache = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : { pokemon: {} };
  }
  return moveRecommendationsCache;
}

function topMovesFor(nameLower, n = 3) {
  const rec = readMoveRecommendations();
  return (rec.pokemon[nameLower]?.moves || []).slice(0, n);
}

function computeFinalStats(pokemonRow, sp, nature) {
  const stats = {};
  for (const key of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
    const isHp = key === 'hp';
    const alignment = isHp ? 1.0 : natureMultiplierFor(nature, key);
    stats[key] = calcStat(pokemonRow[key], sp[key] || 0, alignment, isHp);
  }
  return stats;
}

// --- STEP 5: real @smogon/calc damage-calc cache --------------------------------
// Keyed exactly per spec: defensive calcs by the defender's final HP/Def/SpD (the
// only stats that change a defensive result) plus attacker identity; offensive
// calcs by the attacker's final Atk/SpA plus target identity. Deterministic given
// the same inputs, so this is a pure memoization with no TTL — it lives for the
// process lifetime, same as the lookup caches above.
const damageCalcCache = new Map();

function runCalc(attackerRow, attackerSide, defenderRow, defenderSide, moveName, fieldOpts) {
  const moveData = getMoveData(moveName);
  const result = CalcDamage({
    attacker: {
      name: attackerRow.name, nature: attackerSide.nature || 'Hardy', sp: attackerSide.sp || {},
      item: attackerSide.item || '', ability: attackerRow.ability || '',
      baseStats: { hp: attackerRow.hp, atk: attackerRow.atk, def: attackerRow.def, spa: attackerRow.spa, spd: attackerRow.spd, spe: attackerRow.spe },
      types: [attackerRow.type1, attackerRow.type2].filter(Boolean),
    },
    defender: {
      name: defenderRow.name, nature: defenderSide.nature || 'Hardy', sp: defenderSide.sp || {},
      item: defenderSide.item || '', ability: defenderRow.ability || '',
      // Same `atk: defenderRow.def` typo as team_analyzer.js — identical text in
      // both files, so almost certainly one copy-paste. Only Foul Play reads the
      // defender's Attack, which is why it survived this long.
      baseStats: { hp: defenderRow.hp, atk: defenderRow.atk, def: defenderRow.def, spa: defenderRow.spa, spd: defenderRow.spd, spe: defenderRow.spe },
      types: [defenderRow.type1, defenderRow.type2].filter(Boolean),
    },
    move: moveData,
    isDouble: true,
    weather: fieldOpts?.weather || null,
    terrain: fieldOpts?.terrain || null,
  });
  return { minPercent: result.minPercent, maxPercent: result.maxPercent };
}

// --- Worst-case damage across the attacker's top-3 observed spreads -------------
// A "guaranteed OHKO prevented" claim means safe on EVERY roll of EVERY realistic
// build — not just safe from the scariest build's min roll (that build's own MAX
// roll can still land the KO). So the KO tier is decided by the single highest
// damage number reachable at all: Math.max across every top-3 build's max roll.
// If that worst-of-the-worst number still clears 100%, there is a real chance of
// being OHKO'd and the threshold does not count as prevented, even though most
// rolls from most builds would survive. The displayed range still spans the full
// envelope (lowest floor to highest ceiling across all three builds and their own
// roll variance) so the user sees the whole realistic picture, not just the
// number the tier was decided on.
async function weightedDefensiveDamage({ attackerRow, move, attackerSpreads, attackerItem, defenderRow, defenderFinalStats, defenderSp, defenderNature, defenderItem, threatPrimaryNature, fieldOpts }) {
  const mins = [];
  const maxs = [];
  const perSpread = [];

  for (const spread of attackerSpreads) {
    const spreadNature = spread.nature || threatPrimaryNature || 'Hardy';
    // FIX 3/4: attackerItem (real, top damage-affecting observed item — see
    // getCachedAttackerItem) folded into the cache key and the actual calc, same
    // as every other real attacker-side input (spread, nature) already was.
    //
    // Weather tagging (weather_labels task): this cache key never included
    // weather at all — dormant until this session, since no caller had ever
    // invoked this function twice with the same attacker/move/spread/defender-
    // stats under two DIFFERENT weathers before the new defensive alt-weather
    // feature did. Without it, the alt-weather recalc below silently returned
    // the PRIMARY weather's cached result — a Water move's "Rain alternative"
    // read identical to its Sun number, the exact "answers a narrower question
    // than what the caller now needs" defect this whole task exists to fix,
    // just found one layer deeper than expected. weightedOffensiveDamage()
    // (below) already included weather in its own cache key — this brings the
    // defensive function in line with it.
    const cacheKey = [
      'def', attackerRow.name.toLowerCase(), move.toLowerCase(), JSON.stringify(spread.sp), spreadNature, attackerItem || '',
      defenderFinalStats.hp, defenderFinalStats.def, defenderFinalStats.spd, defenderItem || '', fieldOpts?.weather || '',
    ].join('~');

    let calcResult = damageCalcCache.get(cacheKey);
    if (!calcResult) {
      const attackerSide = { nature: spreadNature, item: attackerItem || undefined, sp: spread.sp };
      const defenderSide = { nature: defenderNature, item: defenderItem || undefined, sp: defenderSp };
      try {
        calcResult = runCalc(attackerRow, attackerSide, defenderRow, defenderSide, move, fieldOpts);
      } catch (err) {
        calcResult = null; // @smogon/calc can't build this attacker/move — skip, don't fail the whole search
      }
      damageCalcCache.set(cacheKey, calcResult);
    }
    if (!calcResult) continue;

    mins.push(calcResult.minPercent);
    maxs.push(calcResult.maxPercent);
    perSpread.push({ sp: spread.sp, nature: spreadNature, item: attackerItem || null, frequency: round(spread.frequency), raw_frequency: spread.raw_frequency });
  }

  if (mins.length === 0) return { weightedMin: 0, weightedMax: 0, koCheckValue: 0, perSpread };

  return {
    // FIX 1: use the most common (first) spread's range for display, not
    // the min/max across all 3 spreads. The label already shows the first
    // spread's stats, so the range should match. koCheckValue stays worst-case.
    weightedMin: round(mins[0] ?? Math.min(...mins), 2),
    weightedMax: round(maxs[0] ?? Math.max(...maxs), 2),
    koCheckValue: round(Math.max(...maxs), 2), // KO tier decided by the single highest roll reachable at all
    perSpread,
  };
}

// Same worst-case principle, mirrored: the attacker only gets credit for a KO
// tier it can guarantee against the BULKIEST of the target's top-3 observed
// builds (the one that minimizes incoming damage), not an average target.
async function weightedOffensiveDamage({ attackerRow, attackerSp, attackerNature, attackerItem, move, targetRow, targetSpreads, fieldOpts }) {
  const mins = [];
  const maxs = [];
  const perSpread = [];

  for (const spread of targetSpreads) {
    const targetNature = spread.nature || 'Hardy';
    const weatherKey = fieldOpts?.weather || '';
    const cacheKey = [
      'off', attackerRow.name.toLowerCase(), move.toLowerCase(), targetRow.name.toLowerCase(), JSON.stringify(spread.sp), targetNature,
      attackerSp.atk, attackerSp.spa, attackerNature || '', attackerItem || '', weatherKey,
    ].join('~');

    let calcResult = damageCalcCache.get(cacheKey);
    if (!calcResult) {
      const attackerSide = { nature: attackerNature, item: attackerItem || undefined, sp: attackerSp };
      const targetSide = { nature: targetNature, sp: spread.sp };
      try {
        calcResult = runCalc(attackerRow, attackerSide, targetRow, targetSide, move, fieldOpts);
      } catch (err) {
        calcResult = null;
      }
      damageCalcCache.set(cacheKey, calcResult);
    }
    if (!calcResult) continue;

    mins.push(calcResult.minPercent);
    maxs.push(calcResult.maxPercent);
    perSpread.push({ sp: spread.sp, nature: targetNature, frequency: round(spread.frequency), raw_frequency: spread.raw_frequency });
  }

  if (mins.length === 0) return { weightedMin: 0, weightedMax: 0, koCheckValue: 0, perSpread };

  return {
    // FIX 1: use the most common (first) target spread's range for display,
    // matching the attacker label. koCheckValue stays worst-case (bulkiest build).
    weightedMin: round(mins[0] ?? Math.min(...mins), 2),
    weightedMax: round(maxs[0] ?? Math.max(...maxs), 2),
    koCheckValue: round(Math.min(...mins), 2), // KO tier decided by the bulkiest build's min roll (offense stays min-based — see FIX 1)
    perSpread,
  };
}

// Lazy require avoids a circular-dependency crash: ev_optimizer.js requires
// spread_optimizer.js (Phase 3 integration), which requires this file — a
// top-level `require('./ev_optimizer')` here would run while ev_optimizer.js is
// still mid-initialization (before its own `module.exports` assignment at the
// bottom of that file), returning an incomplete object with ROLE_MULTIPLIERS
// undefined. Requiring inside the function runs at call time, long after both
// modules have finished loading.
function getRoleMultipliers(role) {
  const { ROLE_MULTIPLIERS } = require('./ev_optimizer');
  return ROLE_MULTIPLIERS[role] || {};
}

function defensiveFactor(baselineTier, newTier) {
  const bIdx = tierIndex(baselineTier);
  const nIdx = tierIndex(newTier);
  const delta = nIdx - bIdx;
  if (delta <= 0) return 0;
  return DEFENSIVE_TIER_FACTORS[bIdx]?.[delta] ?? 0;
}

// FIX 3: builds the "Adamant 32 Atk Black Glasses" style label naming an
// attacker's real build — used to name the specific move+build behind every
// threshold entry, not just the bare move name. Uses the attacker's single
// most common real observed spread (attackerSpreads[0], already
// frequency-ranked by getTopAttackerSpreads) rather than trying to identify
// which of the (possibly 3) worst-case spreads specifically produced
// koCheckValue — the scoring math stays worst-case-based across all 3
// (unchanged), this is purely a representative, real display label.
const STAT_LABEL_FOR_CATEGORY = { Physical: 'Atk', Special: 'SpA' };

// FIX 5: maps type-boosting items to the type they boost. Non-matching items
// must not appear in damage descriptions for moves of a different type.
const TYPE_BOOST_ITEMS = {
  'charcoal': 'Fire', 'mystic water': 'Water', 'sharp beak': 'Flying',
  'never-melt ice': 'Ice', 'spell tag': 'Ghost', 'dragon fang': 'Dragon',
  'poison barb': 'Poison', 'hard stone': 'Rock', 'silver powder': 'Bug',
  'twisted spoon': 'Psychic', 'black belt': 'Fighting', 'magnet': 'Electric',
  'black glasses': 'Dark', 'metal coat': 'Steel', 'silk scarf': 'Normal',
  'rose incense': 'Grass', 'sea incense': 'Water', 'wave incense': 'Water',
  'odd incense': 'Psychic', 'rock incense': 'Rock', 'fairy memory': 'Fairy',
};

function itemAffectsMoveType(itemName, moveType) {
  const itemLower = (itemName || '').toLowerCase();
  if (!itemLower || !moveType) return false;
  const boostType = TYPE_BOOST_ITEMS[itemLower];
  if (!boostType) return true; // non-type-boosting items (Life Orb, Choice items, etc.) affect all moves
  return boostType.toLowerCase() === moveType.toLowerCase();
}

// Abilities that affect damage output and must always be shown in descriptions
const DAMAGE_AFFECTING_ABILITIES = new Set([
  'adaptability', 'huge power', 'pure power', 'sheer force', 'guts', 'hustle',
  'flash fire', 'overgrow', 'blaze', 'torrent', 'swarm', 'solar power',
  'sword of ruin', 'tablets of ruin', 'beads of ruin', 'vessel of ruin',
  'protosynthesis', 'quark drive', 'hadron engine', 'supreme overlord',
  'defiant', 'competitive', 'tough claws', 'strong jaw', 'iron fist',
  'punk rock', 'pixilate', 'refrigerate', 'aerilate', 'galvanize',
  'normalize', 'technician', 'sniper', 'super luck', 'skill link',
  'reckless', 'iron barbs', 'neutralizing gas', 'unburden',
]);

function buildAttackerBuildLabel(attackerSpreads, attackerItem, moveCategory, moveType, attackerAbility) {
  const top = attackerSpreads[0];
  if (!top) return '';
  const statKey = moveCategory === 'Physical' ? 'atk' : 'spa';
  const statLabel = STAT_LABEL_FOR_CATEGORY[moveCategory] || 'Atk';
  const spVal = top.sp?.[statKey] || 0;
  // FIX 5: only include item if it actually boosts this move's type
  const effectiveItem = attackerItem && moveType && !itemAffectsMoveType(attackerItem, moveType) ? null : attackerItem;
  // FIX 7: always include ability when it affects damage output
  const effectiveAbility = attackerAbility && DAMAGE_AFFECTING_ABILITIES.has(attackerAbility.toLowerCase()) ? attackerAbility : null;
  const parts = [top.nature, `${spVal} ${statLabel}`, effectiveItem, effectiveAbility].filter(Boolean);
  return parts.join(' ');
}

// FIX 2: builds recoil text for a given move, e.g. "(24.6-29.1% recoil to attacker)"
// Recoil is derived from damage range, then clamped:
//   - At move's max fraction (33.3% Flare Blitz, 25% Wild Charge, 50% Head Smash)
//   - At 100% of attacker's max HP
// Damage dealt is capped at target's remaining HP (100%) before applying recoil ratio,
// so overkill doesn't inflate recoil beyond what's possible.
// When the range straddles the cap (min below max fraction, max at cap) it shows a range;
// when both exceed the cap it shows a single capped value.
function buildRecoilText(moveName, minPercent, maxPercent) {
  const recoilRatio = RECOIL_MOVES.get(moveName.toLowerCase());
  if (!recoilRatio) return '';
  const maxRecoilPct = recoilRatio * 100;
  // Cap damage at target's remaining HP (100%) before applying recoil ratio
  const dmgDealtMin = Math.min(minPercent, 100);
  const dmgDealtMax = Math.min(maxPercent, 100);
  const recoilMin = Math.round(Math.min(dmgDealtMin * recoilRatio, maxRecoilPct) * 100) / 100;
  const recoilMax = Math.round(Math.min(dmgDealtMax * recoilRatio, maxRecoilPct) * 100) / 100;
  if (recoilMin === recoilMax) {
    return ` (${recoilMin}% recoil to attacker${recoilMin >= maxRecoilPct * 0.95 ? ' — capped' : ''})`;
  }
  return ` (${recoilMin}-${recoilMax}% recoil to attacker)`;
}

function offensiveFactor(baselineTier, newTier) {
  const bIdx = tierIndex(baselineTier);
  const nIdx = tierIndex(newTier);
  if (nIdx >= bIdx) return 0; // no improvement
  return OFFENSIVE_TIER_FACTORS[bIdx]?.[nIdx] ?? 0;
}

/**
 * scoreSpread(pokemon, sp, nature, role, threatMatrix, metaContext, options?)
 * `options.detailed` (default false) additionally populates thresholds_met /
 * thresholds_missed for reporting — skipped during the genetic search's inner
 * loop (score-only) and only requested for the final top-5 result, since building
 * the full breakdown for every one of thousands of candidates would be wasted work.
 */
async function scoreSpread(pokemon, sp, nature, role, threatMatrix, metaContext, options = {}) {
  const detailed = !!options.detailed;
  const item = options.item || null;
  const itemLower = (item || '').toLowerCase();
  const fieldOpts = options.fieldOpts || null;
  const teamWeathers = (fieldOpts && fieldOpts._teamContext) || [];
  const primaryWeather = fieldOpts?.weather || null;
  const roleMult = getRoleMultipliers(role);
  const finalStats = computeFinalStats(pokemon, sp, nature);
  const baselineStats = computeFinalStats(pokemon, ZERO_SP, nature);
  const defenderTypes = [pokemon.type1, pokemon.type2].filter(Boolean);

  // Per-threshold stat attribution now lives inside the DEFENSIVE loop below
  // (see `zeroedKoFor`), because it has to test the move's real defending stat
  // as well as HP, and which stat that is varies per threat. The old
  // hoisted-once hpZeroedSp/hpZeroedStats pair only ever tested HP, which is
  // exactly what made HP win attribution for every threshold.

  let score = 0;
  const met = [];
  const missed = [];

  const relevantThreats = threatMatrix.filter(
    (t) => t.attacker.toLowerCase() !== pokemon.name.toLowerCase() && t.weight > MIN_THREAT_WEIGHT
  );

  // --- DEFENSIVE ---
  // Tracks, per attacker, whether ANY of their top moves OHKOs this Pokemon at
  // 0 SP baseline — reused by the SPEED section below (speed_ohko_link /
  // speed_death_trap_penalty) so that check is never computed twice for the
  // same attacker within one scoreSpread() call.
  const attackersThatOhkoAtBaseline = new Set();
  for (const threat of relevantThreats) {
    const moveRow = await getMoveRow(threat.move.toLowerCase());
    if (!moveRow || moveRow.category === 'Status' || !moveRow.power) continue;
    const attackerRow = await getPokemonRow(threat.attacker.toLowerCase());
    if (!attackerRow) continue;

    const attackerSpreads = await getTopAttackerSpreads(threat.attacker.toLowerCase());
    // FIX 7: skip threats where the most common attacker spread makes up <5%
    // of the total meta game (attacker_usage × spread.frequency < 5%).
    const setMetaPct = (threat.attacker_usage || 0) * (attackerSpreads[0]?.frequency || 0) * 100;
    if (setMetaPct < 5 && attackerSpreads.length > 0) continue;

    const attackerItem = await getCachedAttackerItem(threat.attacker.toLowerCase());
    // FIX 7: resolve attacker's real ability for damage descriptions
    const attackerAbilities = [attackerRow.ability1, attackerRow.ability2, attackerRow.ability_hidden].filter(Boolean);
    const attackerAbility = attackerAbilities[0] || null;

    const [current, baseline] = await Promise.all([
      weightedDefensiveDamage({
        attackerRow, move: threat.move, attackerSpreads, attackerItem, defenderRow: pokemon,
        defenderFinalStats: finalStats, defenderSp: sp, defenderNature: nature, defenderItem: item, threatPrimaryNature: threat.primary_nature, fieldOpts,
      }),
      weightedDefensiveDamage({
        attackerRow, move: threat.move, attackerSpreads, attackerItem, defenderRow: pokemon,
        defenderFinalStats: baselineStats, defenderSp: ZERO_SP, defenderNature: nature, defenderItem: item, threatPrimaryNature: threat.primary_nature, fieldOpts,
      }),
    ]);

    const koResult = koFromPercent(current.koCheckValue);
    const baselineKo = koFromPercent(baseline.koCheckValue);
    if (baselineKo === 'OHKO') attackersThatOhkoAtBaseline.add(threat.attacker.toLowerCase());
    const factor = defensiveFactor(baselineKo, koResult);
    const statKey = moveRow.category === 'Physical' ? 'def' : 'spd';

    // FIX 1: aggression_multiplier — is this attacker's specific move a
    // realistic threat against this specific defender, given the attacker's
    // own role and this move's STAB/effectiveness against us? Cached (see
    // getCachedAggressionMultiplier) since it's identical across every
    // candidate SP spread scored for this defender.
    const aggressionMultiplier = await getCachedAggressionMultiplier(
      pokemon.name.toLowerCase(), threat.attacker.toLowerCase(), threat.move.toLowerCase(),
      attackerRow, moveRow, moveRow.type, defenderTypes
    );
    const effectiveWeight = round(threat.weight * aggressionMultiplier, 6);

    if (factor > 0) {
      // FIX 2: a baseline of 4HKO (or worse) previously fell into the same
      // '3hko_prevented' bucket as a genuine 3HKO baseline (the old ternary had
      // no 4th branch) — split out so 4HKO-prevented gets its own, far smaller
      // type_value instead of being silently over-credited at 3HKO's rate.
      const multKey = baselineKo === 'OHKO' ? 'ohko_prevented'
        : baselineKo === '2HKO' ? '2hko_prevented'
        : baselineKo === '3HKO' ? '3hko_prevented'
        : '4hko_prevented';
      // FIX 5: Focus Sash holders already survive one OHKO — zero out OHKO_prevented
      // contribution so the optimizer doesn't waste SP on surviving hits the sash covers.
      // 2HKO/3HKO prevention still matters (sash doesn't prevent follow-up hits).
      // Per interview Q5: heavily down-weighted (0.1x), not excluded entirely.
      const isFocusSash = itemLower === 'focus sash';
      const sashPenalty = (isFocusSash && multKey === 'ohko_prevented') ? 0.1 : 1;
      // Assault Vest already multiplies the real SpD stat 1.5x inside the damage
      // calc above (buildPokemon() gets `item`) — this is an ADDITIONAL search-time
      // weighting on top of that real effect, so the GA actively favors SpD
      // thresholds once AV is the assigned item, not just passively benefits from
      // the stat boost already baked into the KO-tier math.
      const itemMult = (itemLower === 'assault vest' && statKey === 'spd') ? ASSAULT_VEST_SPD_CONTRIBUTION_MULTIPLIER : 1.0;
      const contribution = round(effectiveWeight * TYPE_VALUES[multKey] * (roleMult[multKey] ?? 1.0) * factor * itemMult * sashPenalty, 6);
      score += contribution;
      if (detailed) {
        // KO tier for this threat with ONE stat forced to 0 and every other stat
        // left at its candidate value. Used both to attribute the threshold to a
        // stat and, immediately after, as the marginal-value guard's
        // counterfactual — so the two always agree and no extra damage calc is
        // needed for the guard.
        const zeroedKoFor = async (statToZero) => {
          const zeroedSp = { ...ZERO_SP, ...sp, [statToZero]: 0 };
          const zeroedStats = {};
          for (const s of STAT_ORDER) {
            const alignment = s === 'hp' ? 1.0 : natureMultiplierFor(nature, s);
            zeroedStats[s] = calcStat(pokemon[s], zeroedSp[s], alignment, s === 'hp');
          }
          const zeroedResult = await weightedDefensiveDamage({
            attackerRow, move: threat.move, attackerSpreads, attackerItem, defenderRow: pokemon,
            defenderFinalStats: zeroedStats, defenderSp: zeroedSp, defenderNature: nature,
            defenderItem: item, threatPrimaryNature: threat.primary_nature, fieldOpts,
          });
          return koFromPercent(zeroedResult.koCheckValue);
        };

        // ATTRIBUTION. The move's real defending stat — Def for a physical hit,
        // SpD for a special one — is the PRIMARY candidate. HP is credited only
        // when the real defending stat is NOT load-bearing for this threshold
        // but HP is.
        //
        // The previous rule promoted 'hp' whenever zeroing HP moved the KO tier,
        // without ever asking whether Def/SpD moved it too. HP is the denominator
        // of every damage percentage, so zeroing it moves a tier nearly always —
        // and essentially every defensive threshold got relabelled 'hp'. Def and
        // SpD were then left with no threshold tagged to them, minimizeSpread saw
        // nothing protecting that investment, and stripped it. Measured live on
        // the standing six-Pokemon team: 100% of surviving thresholds were tagged
        // 'hp', while 100% of the thresholds the guard below discarded genuinely
        // belonged to Def (20 of them) or SpD (31) — not one to HP.
        const statKoWithout = (sp[statKey] || 0) > 0 ? await zeroedKoFor(statKey) : koResult;
        const hpKoWithout = (sp.hp || 0) > 0 ? await zeroedKoFor('hp') : koResult;
        const statIsLoadBearing = statKoWithout !== koResult;
        const hpIsLoadBearing = hpKoWithout !== koResult;

        let attributedStat = statKey;
        let koWithoutAttributed = statKoWithout;
        if (!statIsLoadBearing && hpIsLoadBearing) {
          attributedStat = 'hp';
          koWithoutAttributed = hpKoWithout;
        }

        // CO-DEPENDENCY. A survival is frequently held up by the defending stat
        // AND by HP at the same time — remove either one on its own and the KO
        // tier regresses. One `stat` tag cannot express that, and the Why block
        // reads off the tag, so the un-tagged stat ends up citing whatever weak
        // threshold it happens to own instead of the real reason it is invested.
        //
        // Observed: Archaludon at 25 HP / 19 Def cited "survives Kingambit Kowtow
        // Cleave (36.3-44.2%)" on its HP line — a 3HKO — while the actual
        // constraint holding HP at 25 was Garchomp Earthquake at 99.5% on the Def
        // line, which crosses 100% and becomes an OHKO the moment HP drops.
        //
        // Recording every load-bearing stat lets buildSpAllocationWhy() surface
        // the same threshold under both, so each line names the real constraint.
        const alsoLoadBearing = [];
        if (statIsLoadBearing && hpIsLoadBearing) {
          alsoLoadBearing.push(attributedStat === 'hp' ? statKey : 'hp');
        }

        // MARGINAL-VALUE GUARD. The attributed stat's investment must produce a
        // real KO-TIER IMPROVEMENT relative to that stat sitting at 0. This is a
        // tier comparison, not "would we be OHKO'd without it": a 2HKO→3HKO or
        // 3HKO→no_ko gain is genuine marginal value, defensiveFactor() above
        // already credits it, and `score += contribution` has already banked it.
        //
        // The previous test was `verifyResult.koCheckValue < 100` — it required
        // an OHKO at zero investment. Because the counterfactual zeroes only one
        // stat while the true-zero baseline zeroes all six, that test could only
        // ever pass when baseline_ko was already 'OHKO'. Every sub-OHKO
        // improvement scored points and was then dropped from `met`, so the
        // scorer and the Why block optimised different objectives — and
        // minimizeSpread, which trusts `met` alone, stripped the SP back out.
        //
        // KNOWN GAP (unchanged): a threshold load-bearing only ACROSS stats —
        // neither Def nor HP alone flips the tier, but removing both does — is
        // still dropped here. `also_load_bearing` covers the case where each is
        // independently load-bearing, not the case where only the pair is.
        if (tierIndex(koResult) <= tierIndex(koWithoutAttributed)) continue;

        // Weather tagging (Task: every weather-dependent number must name its
        // weather). Only for moves where weatherChangesDamage() says the
        // NUMBER could actually differ under a live alternate weather — never
        // run an alt-weather recalc for a move weather can't touch. Mirrors
        // the OFFENSIVE branch below (primary_weather/alt_weathers), which
        // this branch previously left entirely unset — that omission is the
        // root cause of e.g. a Water-move HP threshold printing an unlabelled
        // number computed under our own Sun while the same move under a live
        // Rain elsewhere on the board is 3x worse.
        const resolvedMoveType = resolveTypeFor(threat.move, moveRow.type, attackerAbility, primaryWeather);
        let thresholdPrimaryWeather = null;
        let thresholdAltWeathers = null;
        if (weatherChangesDamage(threat.move, resolvedMoveType, moveRow.category, defenderTypes, primaryWeather, { attackerItem, defenderItem: item })) {
          thresholdPrimaryWeather = primaryWeather;
          // Map, not Set: tracks WHERE each alt weather comes from so the
          // renderer can say "our Rain" vs "their Sun" rather than a bare
          // weather name — a team weather we also set is a live alternative to
          // OUR OWN primary weather; the attacker's own setting ability is a
          // live alternative regardless of what we set, and is genuinely
          // theirs, not ours.
          const altCandidates = new Map();
          if (teamWeathers.length > 1) {
            for (const w of teamWeathers) if (w !== primaryWeather) altCandidates.set(w, 'team');
          }
          const attackerWeatherAbility = WEATHER_SETTER_ABILITIES[(attackerAbility || '').toLowerCase()];
          if (attackerWeatherAbility && attackerWeatherAbility !== primaryWeather) altCandidates.set(attackerWeatherAbility, 'opponent');
          for (const [altWeather, altSource] of altCandidates) {
            const altResolvedType = resolveTypeFor(threat.move, moveRow.type, attackerAbility, altWeather);
            if (!weatherChangesDamage(threat.move, altResolvedType, moveRow.category, defenderTypes, altWeather, { attackerItem, defenderItem: item })) continue;
            const altResult = await weightedDefensiveDamage({
              attackerRow, move: threat.move, attackerSpreads, attackerItem, defenderRow: pokemon,
              defenderFinalStats: finalStats, defenderSp: sp, defenderNature: nature, defenderItem: item,
              threatPrimaryNature: threat.primary_nature, fieldOpts: { ...fieldOpts, weather: altWeather },
            });
            if (altResult.weightedMin > 0 || altResult.weightedMax > 0) {
              thresholdAltWeathers = thresholdAltWeathers || [];
              thresholdAltWeathers.push({
                weather: altWeather,
                source: altSource,
                weighted_damage_min: altResult.weightedMin,
                weighted_damage_max: altResult.weightedMax,
                this_spread_ko: koFromPercent(altResult.koCheckValue),
              });
            }
          }
        }

        met.push({
          category: 'defensive',
          stat: attributedStat,
          also_load_bearing: alsoLoadBearing,
          attacker_name: threat.attacker,
          threat: `${threat.attacker} ${displayMoveName(threat.move, attackerAbility, primaryWeather)}`,
          attacker_build: buildAttackerBuildLabel(attackerSpreads, attackerItem, moveRow.category, moveRow.type, attackerAbility),
          baseline_ko: baselineKo,
          this_spread_ko: koResult,
          attacker_spreads_used: current.perSpread,
          weighted_damage_min: current.weightedMin,
          weighted_damage_max: current.weightedMax,
          aggression_multiplier: aggressionMultiplier,
          primary_weather: thresholdPrimaryWeather,
          alt_weathers: thresholdAltWeathers,
          accuracy_note: accuracyNoteFor(threat.move, primaryWeather),
          contribution,
        });
      }
    } else if (detailed) {
      const spNeeded = {};
      if (koResult === baselineKo && koResult !== 'no_ko' && koResult !== '4HKO') spNeeded[statKey] = 'more SP needed — see thresholds_met on a higher-investment spread';
      missed.push({
        threat: `${threat.attacker} ${displayMoveName(threat.move, attackerAbility, primaryWeather)}`,
        attacker_build: buildAttackerBuildLabel(attackerSpreads, attackerItem, moveRow.category, moveRow.type, attackerAbility),
        baseline_ko: baselineKo,
        this_spread_ko: koResult,
        sp_needed_to_improve: spNeeded,
        note: koResult === baselineKo ? `Would need more ${statKey.toUpperCase()} SP to improve past ${koResult}` : 'No improvement over baseline at this investment',
      });
    }
  }

  // --- OFFENSIVE (fast_offense / slow_bulky_offense only) ---
  if (role === 'fast_offense' || role === 'slow_bulky_offense') {
    const ownMoves = topMovesFor(pokemon.name.toLowerCase(), 3);
    const targets = await getCachedOffensiveTargets();

    for (const target of targets) {
      const targetLower = target.pokemon_name.toLowerCase();
      if (targetLower === pokemon.name.toLowerCase()) continue;
      const targetRow = await getPokemonRow(targetLower);
      if (!targetRow) continue;
      const targetSpreads = await getTopAttackerSpreads(targetLower);
      const targetUsage = round(parseFloat(target.usage_percent) / 100, 4);

      let bestCurrent = null;
      let bestBaseline = null;
      let bestMove = null;
      let bestStatKey = null;
      let bestAttackerSpFull = null;
      let bestMoveType = null;
      let bestMoveCategory = null;
      for (const moveEntry of ownMoves) {
        const moveRow = await getMoveRow(moveEntry.move.toLowerCase());
        if (!moveRow || moveRow.category === 'Status' || !moveRow.power) continue;
        const statKey = moveRow.category === 'Physical' ? 'atk' : 'spa';
        const attackerSpZero = { ...ZERO_SP, [statKey]: 0 };
        const attackerSpFull = { ...ZERO_SP, [statKey]: sp[statKey] || 0 };

        const [current, baseline] = await Promise.all([
          weightedOffensiveDamage({ attackerRow: pokemon, attackerSp: attackerSpFull, attackerNature: nature, attackerItem: item, move: moveEntry.move, targetRow, targetSpreads, fieldOpts }),
          weightedOffensiveDamage({ attackerRow: pokemon, attackerSp: attackerSpZero, attackerNature: nature, attackerItem: item, move: moveEntry.move, targetRow, targetSpreads, fieldOpts }),
        ]);
        // koCheckValue (worst case: against the bulkiest target build) is the
        // right criterion for "best move" too — the move most likely to guarantee
        // a KO regardless of which target build actually shows up, not just the
        // move with the best average or best-case number.
        if (!bestCurrent || current.koCheckValue > bestCurrent.koCheckValue) {
          bestCurrent = current;
          bestBaseline = baseline;
          bestMove = moveEntry.move;
          bestStatKey = statKey;
          bestAttackerSpFull = attackerSpFull;
          bestMoveType = moveRow.type;
          bestMoveCategory = moveRow.category;
        }
      }
      if (!bestCurrent) continue;
      const targetTypes = [targetRow.type1, targetRow.type2].filter(Boolean);

      const koResult = koFromPercent(bestCurrent.koCheckValue);
      const baselineKo = koFromPercent(bestBaseline.koCheckValue);
      const factor = offensiveFactor(baselineKo, koResult);
      if (factor > 0) {
        const multKey = koResult === 'OHKO' ? 'ohko_achieved' : '2hko_achieved';
        // No aggression_multiplier here — OFFENSIVE scores our OWN attack
        // choice, not an opponent's likelihood of using a move against us, so
        // there's no "would they realistically do this" question to model.
        const contribution = round(targetUsage * TYPE_VALUES[multKey] * (roleMult[multKey] ?? 1.0) * factor, 6);
        score += contribution;
        if (detailed) {
          const metEntry = {
            category: 'offensive',
            stat: bestStatKey,
            target: target.pokemon_name,
            target_usage_percent: target.usage_percent,
            threat: `${pokemon.name} ${bestMove} vs. ${target.pokemon_name}`,
            baseline_ko: baselineKo,
            this_spread_ko: koResult,
            attacker_spreads_used: bestCurrent.perSpread,
            weighted_damage_min: bestCurrent.weightedMin,
            weighted_damage_max: bestCurrent.weightedMax,
            contribution,
          };
          // Alternative weather display: if there are other team weathers that
          // differ from the primary (e.g., Pelipper's Rain + Charizard's Sun),
          // compute what this threshold would look like under each alternative
          // — but ONLY when weatherChangesDamage() says the move/target pairing
          // could actually produce a different number under that weather.
          // Previously this ran unconditionally whenever the team had >1
          // weather, regardless of whether bestMove was weather-sensitive at
          // all — wasted recalcs and a same-number "also in Rain: OHKOs" line
          // on moves weather can't touch. Only computed in the detailed pass
          // (once per final candidate, not during GA search).
          // Tag the threshold with the primary weather so the Why block can
          // annotate it and also show alternative-weather outcomes.
          const primaryResolvedType = resolveTypeFor(bestMove, bestMoveType, null, primaryWeather);
          const bestMoveWeatherSensitive = weatherChangesDamage(bestMove, primaryResolvedType, bestMoveCategory, targetTypes, primaryWeather, { attackerItem: item });
          metEntry.primary_weather = bestMoveWeatherSensitive ? primaryWeather : null;
          metEntry.accuracy_note = accuracyNoteFor(bestMove, primaryWeather);
          if (bestMoveWeatherSensitive && primaryWeather && teamWeathers.length > 1) {
            const altWeathers = teamWeathers.filter(w => w !== primaryWeather);
            if (altWeathers.length > 0) {
              const altResults = [];
              for (const altWeather of altWeathers) {
                const altResolvedType = resolveTypeFor(bestMove, bestMoveType, null, altWeather);
                if (!weatherChangesDamage(bestMove, altResolvedType, bestMoveCategory, targetTypes, altWeather, { attackerItem: item })) continue;
                const altFieldOpts = { ...fieldOpts, weather: altWeather };
                const altCurrent = await weightedOffensiveDamage({
                  attackerRow: pokemon, attackerSp: bestAttackerSpFull, attackerNature: nature, attackerItem: item,
                  move: bestMove, targetRow, targetSpreads, fieldOpts: altFieldOpts,
                });
                if (altCurrent.koCheckValue > 0) {
                  altResults.push({
                    weather: altWeather,
                    weighted_damage_min: altCurrent.weightedMin,
                    weighted_damage_max: altCurrent.weightedMax,
                    this_spread_ko: koFromPercent(altCurrent.koCheckValue),
                  });
                }
              }
              if (altResults.length > 0) metEntry.alt_weathers = altResults;
            }
          }
          // Opponent weather: if the TARGET Pokemon has a weather-setting
          // ability (e.g., Tyranitar's Sand Stream, Torkoal's Drought) or a
          // weather-requiring ability that ties it to a weather archetype
          // (e.g., Excadrill's Sand Rush, Venusaur's Chlorophyll), show what
          // this threshold looks like under that weather too. Each candidate
          // weather gets its own weatherChangesDamage() check below rather than
          // reusing bestMoveWeatherSensitive (computed only for primaryWeather)
          // — a move can be weather-sensitive under one weather and not another
          // (e.g. Sand's Rock-defender SpD boost only fires when the target IS
          // Rock, independent of what primaryWeather happens to be).
          const targetWeatherAbilities = [targetRow.ability1, targetRow.ability2, targetRow.ability_hidden]
            .filter(Boolean)
            .map(a => WEATHER_SETTER_ABILITIES[a.toLowerCase()] || CONDITION_REQUIRING_ABILITIES[a.toLowerCase()])
            .filter(Boolean)
            .filter(w => w !== primaryWeather);
          const uniqueTargetWeathers = [...new Set(targetWeatherAbilities)];
          if (uniqueTargetWeathers.length > 0) {
            // Avoid duplicating weathers already in alt_weathers
            const existingAltWeathers = new Set((metEntry.alt_weathers || []).map(a => a.weather));
            for (const tgtWeather of uniqueTargetWeathers) {
              if (existingAltWeathers.has(tgtWeather)) continue;
              const tgtResolvedType = resolveTypeFor(bestMove, bestMoveType, null, tgtWeather);
              if (!weatherChangesDamage(bestMove, tgtResolvedType, bestMoveCategory, targetTypes, tgtWeather, { attackerItem: item })) continue;
              const tgtFieldOpts = { ...fieldOpts, weather: tgtWeather };
              const tgtCurrent = await weightedOffensiveDamage({
                attackerRow: pokemon, attackerSp: bestAttackerSpFull, attackerNature: nature, attackerItem: item,
                move: bestMove, targetRow, targetSpreads, fieldOpts: tgtFieldOpts,
              });
              if (tgtCurrent.koCheckValue > 0) {
                const tgtKo = koFromPercent(tgtCurrent.koCheckValue);
                metEntry.alt_weathers = metEntry.alt_weathers || [];
                metEntry.alt_weathers.push({
                  weather: tgtWeather,
                  weighted_damage_min: tgtCurrent.weightedMin,
                  weighted_damage_max: tgtCurrent.weightedMax,
                  this_spread_ko: tgtKo,
                  source: 'opponent',
                });
              }
            }
          }
          met.push(metEntry);
        }
      }
    }
  }

  // --- SPEED (incl. Trick Room, Scarf, ability-boost benchmarks) ---
  const seenAttackers = new Set();
  // FIX 2: sourced from the FULL threatMatrix, not relevantThreats — the speed
  // section deliberately does NOT exclude this Pokemon's own species. A real
  // mirror matchup (e.g. a 62%-of-Garchomps max-Speed Jolly Garchomp) is a
  // genuine, common speed-critical scenario; excluding it here (as the
  // DEFENSIVE/OFFENSIVE sections correctly still do, where "a move vs itself"
  // is meaningless symmetric noise) meant the mirror case was never scored at
  // all — verified live: neither a Garchomp-mirror nor several other benchmarks
  // appeared in thresholds_met before this fix.
  const speedThreats = threatMatrix.filter((t) => t.weight > MIN_THREAT_WEIGHT).sort((a, b) => b.weight - a.weight);
  // @smogon/calc already applies Choice Scarf's 1.5x Speed inside the damage calcs
  // above (buildPokemon() got `item`), but the SPEED section's outspeed comparisons
  // work off calcStat()'s raw stat, not a @smogon/calc Pokemon object — so the
  // multiplier is applied here too, for comparison purposes only (final_stats
  // returned below stays the raw, un-boosted stat, matching what every other
  // Pokemon's final_stats already means). This is also what naturally teaches the
  // GA to stop investing in Speed once Scarf already clears a benchmark at 0 SP:
  // the margin is already saturated, so further Speed SP earns no additional score.
  const thisSpeed = itemLower === 'choice scarf'
    ? Math.floor(finalStats.spe * CHOICE_SCARF_SPEED_MULTIPLIER)
    : finalStats.spe;

  // speed_death_trap_penalty's "no way to avoid the hit" check — this
  // Pokemon's own top moves, once per scoreSpread() call (role/moveset don't
  // vary by candidate spread).
  const ownTopMovesForEscapeCheck = topMovesFor(pokemon.name.toLowerCase(), 4);
  let hasEscapeOption = ownTopMovesForEscapeCheck.some((m) => m.move === 'Protect');
  if (!hasEscapeOption) {
    for (const m of ownTopMovesForEscapeCheck) {
      const moveRow = await getMoveRow(m.move.toLowerCase());
      if (moveRow && moveRow.priority > 0) { hasEscapeOption = true; break; }
    }
  }

  for (const threat of speedThreats) {
    const key = threat.attacker.toLowerCase();
    if (seenAttackers.has(key)) continue;
    seenAttackers.add(key);

    // speed_ohko_link / speed_death_trap_penalty: does this attacker OHKO at 0
    // SP baseline? Already computed for every non-self attacker in the
    // DEFENSIVE loop above (attackersThatOhkoAtBaseline) — only the self/mirror
    // case (excluded from relevantThreats) needs a fresh, one-off check here,
    // using this same threat entry's move (the attacker's own highest-weight
    // move, from the sort above).
    let baselineOhkoes = attackersThatOhkoAtBaseline.has(key);
    if (key === pokemon.name.toLowerCase() && !baselineOhkoes) {
      const selfMoveRow = await getMoveRow(threat.move.toLowerCase());
      if (selfMoveRow && selfMoveRow.power && selfMoveRow.category !== 'Status') {
        const selfAttackerSpreads = await getTopAttackerSpreads(key);
        const selfBaseline = await weightedDefensiveDamage({
          attackerRow: pokemon, move: threat.move, attackerSpreads: selfAttackerSpreads, defenderRow: pokemon,
          defenderFinalStats: baselineStats, defenderSp: ZERO_SP, defenderNature: nature, defenderItem: item, threatPrimaryNature: threat.primary_nature, fieldOpts,
        });
        baselineOhkoes = koFromPercent(selfBaseline.koCheckValue) === 'OHKO';
      }
    }

    const { tiers } = await getCachedSpeedTiers(key);
    if (tiers.length > 0 && tiers[0].speed_stat !== null) {
      const topTier = tiers[0];
      const outspeeds = thisSpeed > topTier.speed_stat;
      if (outspeeds) {
        const margin = clamp((thisSpeed - topTier.speed_stat) / 50, 0, 1);
        const ohkoLinkMult = baselineOhkoes ? SPEED_OHKO_LINK_MULTIPLIER : 1.0;
        const contribution = round(threat.weight * TYPE_VALUES.speed_tier * (roleMult.speed_tier ?? 1.0) * margin * ohkoLinkMult, 6);
        score += contribution;
        if (detailed && contribution > 0) {
          met.push({
            category: 'speed',
            stat: 'spe',
            threat: `Outspeed ${threat.attacker} (${topTier.nature || ''} ${topTier.speed_stat})${baselineOhkoes ? ' — speed_ohko_link 3x (also OHKOs at baseline)' : ''}`.trim(),
            baseline_ko: null, this_spread_ko: null,
            attacker: threat.attacker,
            speed_sp: topTier.spe_sp,
            speed_stat: topTier.speed_stat,
            speed_ohko_link: baselineOhkoes,
            attacker_spreads_used: [{ sp: null, nature: topTier.nature, frequency: topTier.frequency, raw_frequency: topTier.frequency }],
            weighted_damage_min: null, weighted_damage_max: null,
            contribution,
          });
        }
      } else if (thisSpeed === topTier.speed_stat && threat.weight >= MIN_THREAT_WEIGHT) {
        // FIX 6: Speed tie penalty — when this Pokemon ties exactly with a common
        // threat, penalize the spread to push the optimizer to invest 1 more SP
        // to break the tie rather than sit at a 50/50 coin flip.
        // Same-species mirrors (Garchomp vs Garchomp at 25.9% usage) get -3.0
        // since they're extremely common and ties are well-known competitive
        // problems. Other threats that can OHKO get -1.5.
        const isMirror = key === pokemon.name.toLowerCase();
        const tiePenalty = isMirror ? -3.0 : (baselineOhkoes ? -1.5 : 0.0);
        const tieContribution = round(tiePenalty * threat.weight, 6);
        score += tieContribution;
        if (detailed) {
          met.push({
            category: 'speed_tie',
            stat: 'spe',
            threat: isMirror
              ? `32 Spe — beats ${threat.attacker} mirror (base ${pokemon.spe} + 32 SP = ${thisSpeed}, tie broken by +1 SP over 31 SP)`
              : `Speed tie with ${threat.attacker} (${topTier.nature || ''} ${topTier.speed_stat}) — tie broken by +1 SP to avoid 50/50${baselineOhkoes ? ' (OHKO threat)' : ''}`,
            baseline_ko: null, this_spread_ko: null,
            attacker_spreads_used: [{ sp: null, nature: topTier.nature, frequency: topTier.frequency }],
            weighted_damage_min: null, weighted_damage_max: null,
            contribution: tieContribution,
          });
        }
      } else if (baselineOhkoes && threat.weight >= DEATH_TRAP_MIN_WEIGHT && !hasEscapeOption) {
        // speed_death_trap_penalty: a common threat OHKOs (at baseline) AND
        // outspeeds this candidate spread AND this Pokemon has no Protect/
        // priority to sidestep it — actively penalize, don't just withhold credit.
        // Left at its existing (pre-FIX-2) scale, deliberately: the task's own
        // FIX 2 spec doesn't ask for this penalty to be scaled by the new
        // TYPE_VALUES, and compounding TYPE_VALUES.ohko_prevented (10x) with
        // DEATH_TRAP_PENALTY_MULTIPLIER (2x) into a 20x factor is a large,
        // unverified change to make without it being explicitly requested.
        const penalty = round(threat.weight * DEATH_TRAP_PENALTY_MULTIPLIER * (roleMult.ohko_prevented ?? 1.0), 6);
        score -= penalty;
        if (detailed) {
          missed.push({
            // The attacker-ability lookup lives in the DEFENSIVE loop and is
            // block-scoped to it, so it is NOT in scope here — referencing it
            // would throw at runtime the first time this penalty fires. Falls
            // back to the field weather instead.
            threat: `${threat.attacker} ${displayMoveName(threat.move, null, primaryWeather)}`,
            baseline_ko: 'OHKO', this_spread_ko: 'OHKO (still outsped)',
            sp_needed_to_improve: {},
            note: `speed_death_trap_penalty: ${threat.attacker} OHKOs at baseline and outspeeds this spread (${topTier.speed_stat} > ${thisSpeed}), with no Protect/priority to avoid it (-${penalty})`,
          });
        }
      }

      // Trick Room: slower is better, only for slow-bulky roles when TR is common.
      if (TRICKROOM_ROLES.has(role) && metaContext?.trickroom_prevalence > TRICKROOM_PREVALENCE_THRESHOLD) {
        if (thisSpeed < topTier.speed_stat) {
          const margin = clamp((topTier.speed_stat - thisSpeed) / 50, 0, 1);
          score += round(threat.weight * TYPE_VALUES.trickroom_speed * (roleMult.trickroom_speed ?? 1.0) * margin, 6);
        }
      }
    }

    // Scarf / ability-boost benchmarks (see speed_context.js).
    const modifiers = await getCachedSpeedModifiers(threat.attacker);
    if (modifiers?.scarf_common) {
      if (thisSpeed > modifiers.effective_speed_scarf) {
        const margin = clamp((thisSpeed - modifiers.effective_speed_scarf) / 50, 0, 1);
        const ohkoLinkMult = baselineOhkoes ? SPEED_OHKO_LINK_MULTIPLIER : 1.0;
        score += round(threat.weight * TYPE_VALUES.speed_tier * (roleMult.speed_tier ?? 1.0) * margin * ohkoLinkMult, 6);
      }
    }
    if (modifiers?.ability_boost && modifiers.condition_common) {
      if (thisSpeed > modifiers.effective_speed_boosted) {
        const margin = clamp((thisSpeed - modifiers.effective_speed_boosted) / 50, 0, 1);
        const ohkoLinkMult = baselineOhkoes ? SPEED_OHKO_LINK_MULTIPLIER : 1.0;
        score += round(threat.weight * TYPE_VALUES.speed_tier * (roleMult.speed_tier ?? 1.0) * margin * ohkoLinkMult, 6);
      }
    }
  }

  // Small additive nudge toward item-specific HP breakpoints (Life Orb recoil,
  // Leftovers healing) — see item_optimizer.js. Never touches the real threshold
  // scoring above; purely a tie-breaking-scale bonus (0.3/0.4) among otherwise
  // similar-scoring HP investments.
  if (item) score += itemBreakpointBonus(pokemon, sp, item);

  return {
    score: round(score, 6),
    final_stats: finalStats,
    thresholds_met: detailed ? met.sort((a, b) => b.contribution - a.contribution) : undefined,
    thresholds_missed: detailed ? missed : undefined,
  };
}

// Determines the priority order for testing stat decreases during downward
// minimization. HP is always first (universal relevance). Then the defense stat
// matching the primary incoming threat type (Def for physical, SpD for special —
// proxied by the Pokemon's own offensive orientation). Then the matching offense
// stat. Remaining stats follow. Speed is always last.
function getStatDecreasePriority(role, pokemonRow) {
  const isPhysical = (pokemonRow.atk || 0) >= (pokemonRow.spa || 0);
  const isMixed = OFFENSIVE_ROLES.has(role) && Math.abs((pokemonRow.atk || 0) - (pokemonRow.spa || 0)) < 20;
  const priority = ['hp'];
  if (isMixed) {
    priority.push('def', 'spd');
  } else if (isPhysical) {
    priority.push('def', 'spd');
  } else {
    priority.push('spd', 'def');
  }
  if (isMixed) {
    priority.push('atk', 'spa');
  } else if (isPhysical) {
    priority.push('atk', 'spa');
  } else {
    priority.push('spa', 'atk');
  }
  priority.push('spe');
  return priority;
}

// Identity for a thresholds_met entry that's stable across SP changes (the
// attacker/move/target never move, only our own SP does) — used to match a
// threshold across a before/after scoreSpread() call during minimization.
function thresholdIdentity(t) {
  return `${t.category}|${t.stat}|${t.threat}`;
}

// True iff decreasing SP from `before` to `after` didn't regress any threshold
// that was previously satisfied. This is a DISCRETE-OUTCOME comparison, not a
// raw-score comparison: KO-tier thresholds (defensive/offensive) must not move
// backward a tier, and presence-only thresholds (speed/speed_tie — outspeeding
// a benchmark, breaking a speed tie) must not disappear. Raw score alone is
// the wrong equivalence check here — speed/Trick Room contributions are scaled
// by a continuous margin ((speed - benchmark) / 50, clamped to 1), so a spread
// can still clear every threshold it cleared before while its margin (and thus
// raw score) strictly decreases. Comparing scores would reject that decrement
// even though nothing about the spread's real performance changed, leaving
// Speed (and any other margin-only stat) systematically under-minimized.
function noThresholdRegressed(before, after) {
  const afterByKey = new Map(after.met.map((t) => [thresholdIdentity(t), t]));
  for (const b of before.met) {
    const a = afterByKey.get(thresholdIdentity(b));
    if (b.category === 'defensive' || b.category === 'offensive') {
      if (!a) return false;
      const bi = tierIndex(b.this_spread_ko);
      const ai = tierIndex(a.this_spread_ko);
      if (b.category === 'defensive' && ai < bi) return false; // moved toward OHKO
      if (b.category === 'offensive' && ai > bi) return false; // moved away from OHKO
    } else if (!a) {
      return false; // speed/speed_tie: presence-only, must not disappear
    }
  }
  // A death-trap penalty (missed.note startsWith 'speed_death_trap_penalty')
  // appearing where it wasn't before is also a real regression — the spread
  // stopped outspeeding (or lost its escape option against) an OHKO threat.
  const beforeTraps = new Set(
    before.missed.filter((m) => m.note?.startsWith('speed_death_trap_penalty')).map((m) => m.threat)
  );
  for (const m of after.missed) {
    if (m.note?.startsWith('speed_death_trap_penalty') && !beforeTraps.has(m.threat)) return false;
  }
  return true;
}

// SP minimization: greedily decreases each stat by 1 SP, keeping the decrease
// if no threshold's discrete outcome regresses (see noThresholdRegressed).
// Every point is verified via scoreSpread() before removal — there is no bulk-
// strip step, so defensive SP that is load-bearing for a threshold attributed
// to a different stat (e.g., Def enabling an HP-tagged survival threshold) is
// never silently removed.
// Priority: HP → relevant defense → relevant offense → remaining → speed.
// Repeats until no stat can be decreased further. Reports unspendable SP as the
// remainder (66 − allocated). Hard 32 per-stat cap and total 66 SP cap enforced.
// Returns { minimized_sp, reductions, unspendable, final_stats, thresholds_met }
async function minimizeSpread(pokemon, sp, nature, role, threatMatrix, metaContext, item, fieldOpts) {
  const opts = { detailed: true, item, ...(fieldOpts ? { fieldOpts } : {}) };
  const baseline = await scoreSpread(pokemon, sp, nature, role, threatMatrix, metaContext, opts);
  const baselineThresholds = baseline.thresholds_met || [];

  const minimizedSp = { ...sp };
  const reductions = {};

  // Downward minimization — try decreasing each stat by 1 SP.
  // Keep the decrease iff no previously-satisfied threshold regresses.
  // Priority: HP → relevant defense → relevant offense → remaining → speed.
  // Repeat until no decreases are possible.
  const pokemonRow = { atk: pokemon.atk, spa: pokemon.spa };
  const decreasePriority = getStatDecreasePriority(role, pokemonRow);
  let currentState = { met: baseline.thresholds_met || [], missed: baseline.thresholds_missed || [] };
  let improved = true;
  while (improved) {
    improved = false;
    for (const stat of decreasePriority) {
      if ((minimizedSp[stat] || 0) <= 0) continue;
      const testSp = { ...minimizedSp, [stat]: minimizedSp[stat] - 1 };
      try {
        const testResult = await scoreSpread(pokemon, testSp, nature, role, threatMatrix, metaContext, opts);
        const testState = { met: testResult.thresholds_met || [], missed: testResult.thresholds_missed || [] };
        if (noThresholdRegressed(currentState, testState)) {
          minimizedSp[stat] = minimizedSp[stat] - 1;
          currentState = testState;
          if (!reductions[stat]) reductions[stat] = { from: sp[stat] || 0, to: minimizedSp[stat], saved: 0 };
          reductions[stat].to = minimizedSp[stat];
          reductions[stat].saved += 1;
          improved = true;
        }
      } catch (_) { /* skip failed calc */ }
    }
  }

  // Hard 32 per-stat cap enforcement
  for (const stat of STAT_ORDER) {
    if (minimizedSp[stat] > SP_CAP_PER_STAT) minimizedSp[stat] = SP_CAP_PER_STAT;
  }

  // Enforce total 66 SP cap — assert on violation
  const totalUsed = STAT_ORDER.reduce((sum, s) => sum + (minimizedSp[s] || 0), 0);
  if (totalUsed > SP_BUDGET_TOTAL) {
    throw new Error(`SP cap violation: total ${totalUsed} exceeds budget ${SP_BUDGET_TOTAL} for ${pokemon.name || pokemon}`);
  }

  // Unspendable = SP that no threshold requires = budget remainder
  const unspendable = SP_BUDGET_TOTAL - totalUsed;

  const finalStats = computeFinalStats(pokemon, minimizedSp, nature);

  // Re-score with the final minimized spread so thresholds_met match the
  // displayed spread exactly — no pre-minimization numbers leak through.
  let finalThresholds = baselineThresholds;
  try {
    const finalResult = await scoreSpread(pokemon, minimizedSp, nature, role, threatMatrix, metaContext, opts);
    finalThresholds = finalResult.thresholds_met || [];
  } catch (_) { /* fall through — keep baselineThresholds if re-score fails */ }

  return {
    minimized_sp: minimizedSp,
    reductions,
    unspendable,
    final_stats: finalStats,
    baseline_score: baseline.score,
    thresholds_met: finalThresholds,
  };
}

module.exports = {
  scoreSpread,
  computeFinalStats,
  koFromPercent,
  getTopAttackerSpreads,
  getPokemonRow,
  getMoveRow,
  buildRecoilText,
  RECOIL_MOVES,
  topMovesFor,
  damageCalcCache,
  MIN_THREAT_WEIGHT,
  TYPE_VALUES,
  SCORER_VERSION,
  minimizeSpread,
  computeAggressionMultiplier,
  buildAttackerBuildLabel,
};
