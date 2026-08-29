// Benefit-vs-cost evaluation for a damage-boosting item, replacing the
// SP-allocation proxy check the owner rejected (commit 77d52b0, reverted by
// this session — see CLAUDE.md/DEFERRED history). That check read "0 SP
// invested in the corresponding offensive stat" as proof the item's bonus
// bought nothing. It doesn't: Life Orb is a flat 1.3x multiplier on damage
// dealt from the Pokemon's BASE stat, so a high-base-stat attacker with zero
// investment can still be pushed over a real KO threshold by the multiplier
// alone — the old rule forbade that outcome by construction, on a proxy
// signal, without ever checking whether the item did anything.
//
// This module answers the real question instead: does the item's own
// measured benefit (usage-weighted offensive KOs its own optimized spread
// reaches that the best alternative item's own optimized spread does not)
// exceed its own measured cost (Life Orb: usage-weighted survival thresholds
// its recoil would flip; Choice Band/Specs: observed-confidence-weighted
// value of the 3 moves the lock-in makes unavailable)? SP allocation never
// appears in the decision — only in the underlying spreads being compared.
//
// Reuses spread_scorer.js's own GA output (thresholds_met, already
// usage-weighted via targetUsage/threat.weight) rather than building a
// parallel damage model — see scoreSpread()'s OFFENSIVE/DEFENSIVE sections.

const { koFromPercent } = require('./spread_scorer');
const { round } = require('./format');

const KO_TIER_ORDER = ['OHKO', '2HKO', '3HKO', '4HKO', 'no_ko'];
function tierIndex(tier) {
  const i = KO_TIER_ORDER.indexOf(tier);
  return i === -1 ? KO_TIER_ORDER.length : i; // unknown/missing tier treated as worst-case "no_ko"
}

// Life Orb: floor(maxHP / 10) recoil per attacking hit — see
// item_optimizer.js's findLifeOrbBreakpoints() for the same 10%-of-max-HP
// basis. Expressed here as a flat percentage-point addition to incoming
// damage taken (the same worst-case-percent units thresholds_met's
// weighted_damage_max already uses), which is the same "does this chip cost
// a tier" logic the recoil-MOVE tiebreak (commit ae0d3e0, archetype_swaps.js)
// applies to RECOIL_MOVES — Life Orb's self-damage is the same mechanic,
// routed through the same style of tier check rather than a separate model.
const LIFE_ORB_RECOIL_PCT = 10;

// `target`/`attacker_name` are explicit fields on thresholds_met entries
// (spread_scorer.js) — preferred over parsing them back out of the display
// `threat` string. The string-parse fallback exists only for entries from
// before those fields existed (e.g. a cached evolutionary search result).
function targetNameFromThreat(threatText) {
  const idx = String(threatText || '').lastIndexOf(' vs. ');
  return idx === -1 ? null : threatText.slice(idx + 5);
}

function targetNameOf(entry) {
  return entry.target || targetNameFromThreat(entry.threat);
}

// Every OFFENSIVE threshold in `thresholdsA` whose KO tier against that same
// target is strictly better than what `thresholdsB` reaches (or that B
// doesn't reach at all) — i.e. gains A gets and B does not. This is what the
// owner's recoil-move rule calls "the score is the same with and without it"
// generalized to items: a KO tier B already reaches too is not a genuine
// difference, regardless of raw damage percentage.
function offensiveGainsExclusiveTo(thresholdsA, thresholdsB) {
  const bByTarget = new Map();
  for (const t of thresholdsB || []) {
    if (t.category !== 'offensive') continue;
    const target = targetNameOf(t);
    if (target) bByTarget.set(target, t);
  }
  const gains = [];
  for (const t of thresholdsA || []) {
    if (t.category !== 'offensive') continue;
    const target = targetNameOf(t);
    if (!target) continue;
    const bTier = bByTarget.get(target)?.this_spread_ko || 'no_ko';
    if (tierIndex(t.this_spread_ko) < tierIndex(bTier)) {
      gains.push({ ...t, target, alt_tier: bTier });
    }
  }
  return gains;
}

function sumContribution(entries) {
  return entries.reduce((s, e) => s + (e.contribution || 0), 0);
}

// Does Life Orb's recoil chip cost a real survival threshold this spread
// would otherwise hold? Uses the DEFENSIVE thresholds_met already computed
// for the incumbent (Life Orb) spread — weighted_damage_max is the worst-case
// percent of max HP taken from that threat; adding the recoil chip on top
// and re-classifying the tier tells us whether recoil alone flips a
// genuinely-held survival tier to a worse one. contribution (already
// usage/weight-scaled by scoreSpread) is reused directly as the cost unit —
// same scale the benefit side uses, so the two are comparable.
function lifeOrbRecoilCost(thresholdsMet) {
  const flipped = [];
  let cost = 0;
  for (const t of thresholdsMet || []) {
    if (t.category !== 'defensive') continue;
    const recoiledTier = koFromPercent((t.weighted_damage_max || 0) + LIFE_ORB_RECOIL_PCT);
    if (tierIndex(recoiledTier) < tierIndex(t.this_spread_ko)) {
      cost += t.contribution || 0;
      flipped.push({ threat: t.threat, attacker_name: t.attacker_name, from_tier: t.this_spread_ko, to_tier: recoiledTier, contribution: t.contribution });
    }
  }
  return { cost: round(cost, 6), flipped };
}

// Choice Band/Specs lock the holder into whichever move is used first — real
// opportunity cost is the value of the OTHER moves this Pokemon's real
// observed set would otherwise carry. Move `confidence` (real observed play
// rate among winning teams, from getMoveRecommendationsFor) is the value
// proxy: a move played 90% of the time (Protect, commonly) costs far more to
// lose than one played 10% of the time (a niche coverage option) — this is
// what makes the cost per-move and non-constant, per the owner's framing
// ("small penalty... opportunity cost", not a flat number. CHOICE_LOCK_UNIT
// scales real confidence (0-1) down to the same rough magnitude as a single
// scoreSpread offensive contribution (TYPE_VALUES.ohko_achieved=8.0 x a
// realistic target_usage of ~0.05-0.2 puts a single real KO gain around
// 0.4-1.6) — so losing a move you'd always play (confidence=1) costs about
// as much as one modest real KO gain, not an entire team's worth of value.
const CHOICE_LOCK_UNIT = 0.4;

function choiceLockCost(moveRecommendations, topN = 4) {
  const top = (moveRecommendations || []).slice(0, topN);
  if (top.length === 0) return { cost: 0, detail: [], locked_move: null };
  const lockedMove = top[0].move; // Choice items lock into whichever move is used first — the most-played real move is the best real estimate of that
  const foregone = top.slice(1);
  const detail = foregone.map((m) => ({ move: m.move, confidence: m.confidence, contribution: round(m.confidence * CHOICE_LOCK_UNIT, 6) }));
  const cost = round(detail.reduce((s, d) => s + d.contribution, 0), 6);
  return { cost, detail, locked_move: lockedMove };
}

// Full benefit-vs-cost evaluation for one member's incumbent item vs. one
// alternative — both thresholds_met arrays must come from each item's OWN
// independently-optimized spread (a genuine counterfactual), not the
// incumbent's spread re-scored under the alternative item.
function evaluateItemValue({ itemName, incumbentThresholds, altThresholds, moveRecommendations }) {
  const itemLower = (itemName || '').toLowerCase();
  const incumbentGains = offensiveGainsExclusiveTo(incumbentThresholds, altThresholds);
  const altGains = offensiveGainsExclusiveTo(altThresholds, incumbentThresholds);
  const benefit = round(sumContribution(incumbentGains) - sumContribution(altGains), 6);

  let cost = 0;
  let costDetail = null;
  if (itemLower === 'life orb') {
    const r = lifeOrbRecoilCost(incumbentThresholds);
    cost = r.cost;
    costDetail = { type: 'life_orb_recoil', flipped: r.flipped };
  } else if (itemLower === 'choice band' || itemLower === 'choice specs') {
    const r = choiceLockCost(moveRecommendations);
    cost = r.cost;
    costDetail = { type: 'choice_lock', locked_move: r.locked_move, foregone: r.detail };
  }
  // Any other damage-boosting item (type-boosting plates/Charcoal/etc.,
  // Muscle Band, Wise Glasses, Expert Belt, Light Ball, Thick Club, Deep Sea
  // Tooth): no recoil, no move lock-in — no concrete per-item cost model
  // applies, so cost stays 0 and the decision reduces to "did it gain a real
  // KO anything didn't already have," per requirement #3 ("costs are per-item
  // and concrete; do not apply a flat categorical penalty").

  return {
    benefit,
    cost,
    net: round(benefit - cost, 6),
    incumbent_gains: incumbentGains,
    alt_gains: altGains,
    cost_detail: costDetail,
  };
}

module.exports = {
  evaluateItemValue,
  offensiveGainsExclusiveTo,
  lifeOrbRecoilCost,
  choiceLockCost,
  targetNameFromThreat,
  tierIndex,
  LIFE_ORB_RECOIL_PCT,
  CHOICE_LOCK_UNIT,
};
