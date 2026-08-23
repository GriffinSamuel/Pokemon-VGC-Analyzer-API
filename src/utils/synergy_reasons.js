const { effectivenessAgainst } = require('./typeChart');

// Ability -> the weather it sets, in @smogon/calc's Field.weather vocabulary.
// A separate small copy of this fixed vocabulary already exists in team.js
// (display-oriented) and train_synergy.py's FIELD_CONDITIONS (mining-oriented);
// this one is calc-oriented (needs @smogon/calc's exact weather strings).
const WEATHER_SETTERS = {
  Drizzle: 'Rain', Drought: 'Sun', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow',
};

const WEATHER_LABELS = { Rain: 'Rain', Sun: 'Sun', Sand: 'Sandstorm', Snow: 'Snow' };

// FIX 10: Weather Ball is Normal-type/40 BP in the moves table (its static,
// no-weather values), but it's a genuinely dynamic move — type AND power change
// under active weather. Handled as a special case here (like the named
// chargeRemoval moves below) rather than a generic rule, since no other move
// changes its own attacking type this way.
const WEATHER_BALL_TYPES = { Rain: 'Water', Sun: 'Fire', Sand: 'Rock', Snow: 'Ice' };
const WEATHER_BALL_BOOSTED_POWER = 100;

// FIX 9: only these moves hit every adjacent Pokemon (doubles spread moves) — a
// teammate's immunity to one is a real, meaningful synergy ("safe to use even
// with partner in the blast radius"). A single-target move's immunity has no
// such synergy value in doubles (it was never going to hit the ally anyway), so
// typeCoverageReasons() below only fires for moves in this list. Baseline list
// from the task spec; Astral Barrage is deliberately excluded (not listed as a
// confirmed spread move here) rather than guessed.
const SPREAD_MOVES = new Set([
  'earthquake', 'rock slide', 'heat wave', 'surf', 'discharge',
  'hyper voice', 'dazzling gleam', 'muddy water', 'blizzard',
  'razor leaf', 'petal blizzard', 'sludge wave', 'lava plume',
  'icy wind', 'electroweb', 'snarl', 'tearful look',
  'breaking swipe', 'bleakwind storm', 'wildbolt storm',
  'sandsear storm', 'glacial lance', 'springtide storm',
  'eruption', 'water spout',
].map((m) => m.toLowerCase()));

// Fixed, well-known VGC game mechanics — not Pokemon-specific, so this isn't
// "hardcoding pairs": these are static rules about which moves interact with
// which weather, applied programmatically to whatever moves a Pokemon happens
// to run. moves.flags in the DB only tracks {drain, recoil, contact}, so a
// move's charge-turn / accuracy-boost behavior under weather isn't derivable
// from the schema and has to be named explicitly here.
const WEATHER_MOVE_RULES = {
  Rain: { typeBoost: 'Water', accuracyMoves: ['Thunder', 'Hurricane'], chargeRemoval: ['Electro Shot'] },
  Sun: { typeBoost: 'Fire', chargeRemoval: ['Solar Beam', 'Solar Blade'] },
  Sand: { spDefBoostType: 'Rock' },
  Snow: { accuracyMoves: ['Blizzard'] },
};

const SUPPORT_MOVE_EFFECTS = {
  'Follow Me': 'redirects single-target moves away from teammates',
  'Rage Powder': 'redirects single-target moves away from teammates',
  'Fake Out': 'flinches a threat on the first turn, protecting teammates',
  Tailwind: "doubles the team's Speed for 4 turns",
  'Trick Room': 'reverses turn order for 5 turns, letting slower teammates move first',
  Electroweb: "lowers every opposing Pokemon's Speed, supporting slower teammates",
  'Wide Guard': 'blocks spread moves from hitting the whole team for a turn',
  'Quick Guard': 'blocks priority moves from hitting the whole team for a turn',
};

function abilitySynergyReasons(nameA, abilitiesA, nameB, abilitiesB, rules) {
  const reasons = [];
  const setA = new Set(abilitiesA.filter(Boolean).map((a) => a.toLowerCase()));
  const setB = new Set(abilitiesB.filter(Boolean).map((a) => a.toLowerCase()));

  for (const rule of rules) {
    const setter = rule.setter_ability.toLowerCase();
    const booster = rule.booster_ability.toLowerCase();
    // All current ability_synergies.json rules are "Speed doubles under condition X"
    // (mined from "if X is active, this Pokemon's Speed is doubled" ability text).
    if (setA.has(setter) && setB.has(booster)) {
      reasons.push(`${rule.setter_ability} sets ${rule.condition}, activating ${rule.booster_ability} to double ${nameB}'s Speed`);
    } else if (setB.has(setter) && setA.has(booster)) {
      reasons.push(`${rule.setter_ability} sets ${rule.condition}, activating ${rule.booster_ability} to double ${nameA}'s Speed`);
    }
  }
  return reasons;
}

// Does the setter's weather (from `setterAbilities`) boost/enable any of the
// partner's top moves? Checked in both directions by the caller.
function moveWeatherReasons(setterAbilities, partnerName, partnerMoves, partnerTypes) {
  const reasons = [];
  for (const ability of setterAbilities) {
    const weather = WEATHER_SETTERS[ability];
    if (!weather) continue;
    const rule = WEATHER_MOVE_RULES[weather];
    const ballType = WEATHER_BALL_TYPES[weather];
    const label = WEATHER_LABELS[weather];

    for (const mv of partnerMoves) {
      // FIX 10: Weather Ball is dynamically typed/powered under active weather —
      // checked before the generic (static-type) rule below, and independent of
      // whether this weather even has a WEATHER_MOVE_RULES entry.
      if (mv.move === 'Weather Ball' && ballType) {
        // Sun/Rain boost Fire/Water damage by 1.5x, not Special Attack
        const typeBonus = (weather === 'rain' && ballType === 'Water') || (weather === 'sun' && ballType === 'Fire') ? 1.5 : 1;
        const effectiveBP = typeBonus > 1 ? Math.round(WEATHER_BALL_BOOSTED_POWER * typeBonus) : WEATHER_BALL_BOOSTED_POWER;
        const bonusNote = typeBonus > 1 ? ` (${typeBonus}x weather bonus = effective ${effectiveBP} BP)` : '';
        reasons.push(`${label} makes ${partnerName}'s Weather Ball ${ballType}-type at ${WEATHER_BALL_BOOSTED_POWER} BP (from 50 BP Normal)${bonusNote}`);
        continue;
      }
      if (!rule || !mv.type) continue;
      if (rule.typeBoost && mv.type === rule.typeBoost && mv.power) {
        reasons.push(`${label} boosts ${partnerName}'s ${mv.move} (${rule.typeBoost}-type) damage by 50%`);
      }
      if (rule.accuracyMoves?.includes(mv.move)) {
        reasons.push(`${label} gives ${partnerName}'s ${mv.move} guaranteed accuracy`);
      }
      if (rule.chargeRemoval?.includes(mv.move)) {
        reasons.push(`${label} lets ${partnerName} use ${mv.move} without a charge turn`);
      }
    }
    if (rule?.spDefBoostType && partnerTypes.includes(rule.spDefBoostType)) {
      reasons.push(`${label} boosts ${partnerName}'s Special Defense by 50% (${rule.spDefBoostType}-type)`);
    }
  }
  return reasons;
}

// Is the defender immune to any of the attacker's top damaging SPREAD moves?
// FIX 9: restricted to spread moves (SPREAD_MOVES) — a single-target move's
// immunity has no synergy value in doubles, since it was never going to hit the
// ally in the first place. Checked in both directions by the caller.
function typeCoverageReasons(attackerName, attackerMoves, defenderName, defenderTypes) {
  const reasons = [];
  for (const mv of attackerMoves) {
    if (!mv.type || !mv.power) continue;
    if (!SPREAD_MOVES.has(mv.move.toLowerCase())) continue;
    if (effectivenessAgainst(mv.type, defenderTypes) === 0) {
      reasons.push(`${defenderName} is immune to ${mv.type}-type moves, letting ${attackerName} use ${mv.move} freely without risking ${defenderName}`);
    }
  }
  return reasons;
}

// FIX 4 (Location 2): Trick Room is excluded from support-move synergy reasons
// when this team has 3+ fast (base Speed >= 90) members — a positive "supports
// X" synergy framing is actively misleading for a team where TR would put its
// own fast members last. suppressTrickRoom is computed once per team by the
// caller (team_analyzer.js's analyzeSynergies), same fast-member threshold as
// the move-recommendation team_context check (team.js's buildMoveTeamContext).
// suppressMoves: moves for which the CALLER already has a specific, named reason
// for this exact pair (e.g. team_analyzer's buildWideGuardSynergies naming the
// real spread move and attacker). Emitting the generic "blocks spread moves...,
// supporting X" line alongside the specific one is strictly worse than the
// specific one alone, so the caller suppresses it rather than printing both.
function supportReasons(supporterName, supporterMoves, partnerName, suppressTrickRoom = false, suppressMoves = null) {
  const reasons = [];
  for (const mv of supporterMoves) {
    if (mv.move === 'Trick Room' && suppressTrickRoom) continue;
    if (suppressMoves && suppressMoves.has(mv.move)) continue;
    const effect = SUPPORT_MOVE_EFFECTS[mv.move];
    if (effect) reasons.push(`${supporterName}'s ${mv.move} ${effect}, supporting ${partnerName}`);
  }
  return reasons;
}

/**
 * Generate up to 3 mechanical synergy reasons for a Pokemon pair, ordered by
 * specificity: ability synergy > move+weather interaction > type coverage >
 * redirection/support > generic co-occurrence fallback.
 *
 * pokemonMoves/partnerMoves: [{move, confidence, type, category, power}, ...] —
 * each Pokemon's top recommended moves enriched with moves-table data.
 */
// Ability -> moves that synergize with it. These abilities fundamentally change
// a Pokemon's damage output or strategy in ways that make certain moves optimal.
// When a Pokemon has one of these abilities, we proactively recommend the
// synergistic move if it's in their available movepool.
const ABILITY_MOVE_SYNERGIES = {
  // Unburden: doubles Speed when item is consumed → Acrobatics (110 BP without item)
  'Unburden': { move: 'Acrobatics', reason: 'Unburden doubles Speed when item is consumed, making Acrobatics 110 BP — a powerful STAB move' },
  // Guts: 1.5x Attack when statused → Facade (140 BP when statused)
  'Guts': { move: 'Facade', reason: 'Guts boosts Attack by 1.5x when statused, and Facade becomes 140 BP — combined 2.1x damage multiplier' },
  // Toxic Boost: 1.5x Attack when poisoned → Facade (140 BP when statused)
  'Toxic Boost': { move: 'Facade', reason: 'Toxic Boost grants 1.5x Attack when poisoned, and Facade becomes 140 BP — combined 2.1x damage multiplier' },
  // Flare Boost: 1.5x SpA when burned → Hex (130 BP vs statused)
  'Flare Boost': { move: 'Hex', reason: 'Flare Boost grants 1.5x SpA when burned, and Hex becomes 130 BP vs statused targets — powerful special attacker' },
  // Marvel Scale: 1.5x Def when statused → works with tank moves
  'Marvel Scale': { move: 'Rest', reason: 'Marvel Scale boosts Defense when statused — Rest enables sustained bulk' },
  // Solar Power: 1.5x SpA in Sun → Solar Beam (no charge in Sun). Kept because
  // the ability itself changes this move's damage — the two genuinely compound.
  'Solar Power': { move: 'Solar Beam', reason: 'Solar Power boosts SpA by 1.5x in Sun, and Solar Beam charges instantly in Sun — free 120 BP STAB' },
  //
  // REMOVED: Chlorophyll -> Solar Beam, Swift Swim -> Hydro Pump,
  // Sand Rush -> Earthquake, Slush Rush -> Blizzard.
  //
  // These four are weather-speed abilities, and none of them interacts with the
  // move it was paired with. Chlorophyll doubles Speed in Sun; Solar Beam skips
  // its charge turn in Sun. Both are consequences of Sun — neither causes the
  // other, and the ability has no effect whatsoever on the move. Claiming
  // "Chlorophyll synergizes with Solar Beam" states a relationship that does not
  // exist. Sand Rush -> Earthquake was worse still: Sand does not boost Ground
  // moves at all, so the pairing had no mechanical basis in either direction.
  //
  // The real, correct statements are already produced elsewhere and do not need
  // a second inaccurate copy here: abilitySynergyReasons() emits "Drought sets
  // Sun, activating Chlorophyll to double X's Speed" (the ability's actual
  // effect), and moveWeatherReasons() emits "Sun lets X use Solar Beam without a
  // charge turn" via WEATHER_MOVE_RULES.chargeRemoval (the move's actual
  // effect). Together those two lines say everything true about the pairing,
  // once each.
  // Iron Fist: 1.2x power on punching moves → Drain Punch, Mach Punch
  'Iron Fist': { move: 'Drain Punch', reason: 'Iron Fist boosts punching moves by 1.2x — Drain Punch gets STAB + healing + 1.2x power' },
  // Strong Jaw: 1.5x power on biting moves → Crunch, Psychic Fangs
  'Strong Jaw': { move: 'Crunch', reason: 'Strong Jaw boosts biting moves by 1.5x — Crunch gets STAB + 1.5x power' },
  // Technician: 1.5x power on moves ≤60 BP → Bullet Punch, Mach Punch
  'Technician': { move: 'Bullet Punch', reason: 'Technician boosts moves ≤60 BP by 1.5x — Bullet Punch gets STAB + priority + 1.5x power' },
  // Punk Rock: 1.3x on sound moves → Boomburst, Hyper Voice
  'Punk Rock': { move: 'Boomburst', reason: 'Punk Rock boosts sound moves by 1.3x — Boomburst gets 1.3x power (and reduces damage from sound moves)' },
  // Sheer Force: 1.3x on moves with secondary effects (removes effect) → many moves
  'Sheer Force': { move: 'Flamethrower', reason: 'Sheer Force boosts moves with secondary effects by 1.3x (removes effect) — common coverage move' },
  // Hustle: 1.5x Attack, 0.8x accuracy → high-power physical moves benefit most
  'Hustle': { move: 'Brave Bird', reason: 'Hustle boosts Attack by 1.5x at cost of accuracy — high-power moves like Brave Bird benefit most from the raw power boost' },
  // Sniper: 1.5x on critical hits → high-crit moves (Cross Poison, Night Slash)
  'Sniper': { move: 'Night Slash', reason: 'Sniper boosts critical hit damage to 1.5x — moves with high crit ratios benefit most' },
  // Super Luck: higher crit rate → high-crit moves
  'Super Luck': { move: 'Cross Poison', reason: 'Super Luck increases crit rate — moves with high crit ratios crit more often' },
  // Skill Link: always hits 5 times → multi-hit moves (Icicle Spear, Rock Blast)
  'Skill Link': { move: 'Icicle Spear', reason: 'Skill Link makes multi-hit moves always hit 5 times — Icicle Spear becomes a reliable 125 BP STAB move' },
  // Adaptability: 2x STAB (instead of 1.5x) → any STAB move benefits
  'Adaptability': { move: null, reason: 'Adaptability boosts STAB from 1.5x to 2x — always prefer STAB moves' },
  // Huge Power / Pure Power: 2x Attack → physical STAB moves benefit
  'Huge Power': { move: null, reason: 'Huge Power doubles Attack — physical STAB moves become devastating' },
  'Pure Power': { move: null, reason: 'Pure Power doubles Attack — physical STAB moves become devastating' },
  // Levitate: Ground immunity → no move synergy, but note in team context
  // Intimidate: lowers opponent Attack → supports team bulk
  // Reflect Body / Lightning Rod / Storm Drain: type absorption → support moves
};

/**
 * Generate ability-move synergy reasons when a Pokemon's ability
 * synergizes with specific moves in the team's movepool.
 */
function abilityMoveSynergies(pokemonName, ability, pokemonMoves, partnerName, partnerMoves) {
  if (!ability) return [];
  const reasons = [];
  const abilityKey = ability.trim();
  const synergy = ABILITY_MOVE_SYNERGIES[abilityKey];
  if (!synergy || !synergy.move) return [];

  // Check if the partner has the synergistic move (suggesting it on the partner)
  const moveLower = synergy.move.toLowerCase();
  const partnerHasMove = (partnerMoves || []).some(m => (m.move || '').toLowerCase() === moveLower);

  if (partnerHasMove) {
    reasons.push(`${pokemonName}'s ${abilityKey} synergizes with ${partnerName}'s ${synergy.move} — ${synergy.reason}`);
  }

  // Also check if this Pokemon has the synergistic move in their available pool
  // (suggesting they SHOULD have it if they don't)
  const thisHasMove = (pokemonMoves || []).some(m => (m.move || '').toLowerCase() === moveLower);
  if (!thisHasMove && partnerHasMove) {
    reasons.push(`Consider adding ${synergy.move} to ${pokemonName} — ${synergy.reason}`);
  }

  return reasons;
}

// pokemonAbility/partnerAbility: the ability this build ACTUALLY RUNS, as
// resolved upstream and printed in the "Ability:" line of the build output.
//
// Without them this function fell back to the species' entire legal ability pool
// (ability1 + ability2 + hidden) and treated every one of them as active at
// once. Whimsicott can legally run Chlorophyll, so a Drought partner produced
// "Drought sets Sun, activating Chlorophyll to double Whimsicott's Speed" even
// though the build runs Prankster and gets no Speed from Sun at all. The synergy
// section was describing a team that was never built.
//
// The pool is still the fallback for callers that don't supply a resolved
// ability (older tests, direct unit calls) — same behaviour as before for them.
function generateSynergyReasons({ pokemonName, pokemonRow, pokemonMoves, pokemonAbility, partnerName, partnerRow, partnerMoves, partnerAbility, abilityRules, score, suppressTrickRoom, suppressSupportMoves }) {
  const pokemonAbilities = pokemonAbility
    ? [pokemonAbility]
    : [pokemonRow.ability1, pokemonRow.ability2, pokemonRow.ability_hidden].filter(Boolean);
  const partnerAbilities = partnerAbility
    ? [partnerAbility]
    : [partnerRow.ability1, partnerRow.ability2, partnerRow.ability_hidden].filter(Boolean);
  const pokemonTypes = [pokemonRow.type1, pokemonRow.type2].filter(Boolean);
  const partnerTypes = [partnerRow.type1, partnerRow.type2].filter(Boolean);

  // FIX 9: "covers [pokemon]'s weakness" (pure-typing resistance, independent of
  // moveset) is removed entirely as a synergy reason — not meaningful in doubles,
  // per the task's own instruction. typeCoverageReasons (move-immunity) is kept,
  // now restricted to spread moves only (see above).
  const reasons = [
    ...abilitySynergyReasons(pokemonName, pokemonAbilities, partnerName, partnerAbilities, abilityRules || []),
    ...moveWeatherReasons(pokemonAbilities, partnerName, partnerMoves, partnerTypes),
    ...moveWeatherReasons(partnerAbilities, pokemonName, pokemonMoves, pokemonTypes),
    ...typeCoverageReasons(pokemonName, pokemonMoves, partnerName, partnerTypes),
    ...typeCoverageReasons(partnerName, partnerMoves, pokemonName, pokemonTypes),
    ...supportReasons(pokemonName, pokemonMoves, partnerName, suppressTrickRoom, suppressSupportMoves),
    ...supportReasons(partnerName, partnerMoves, pokemonName, suppressTrickRoom, suppressSupportMoves),
    ...pokemonAbilities.flatMap(ab => abilityMoveSynergies(pokemonName, ab, pokemonMoves, partnerName, partnerMoves)),
    ...partnerAbilities.flatMap(ab => abilityMoveSynergies(partnerName, ab, partnerMoves, pokemonName, pokemonMoves)),
  ];

  // Deduplicate synergy reasons in three passes, weakest to strongest:
  //   1. exact match via Set
  //   2. substring containment (one reason wholly inside another)
  //   3. shared explanation tail — everything from the first em dash onward.
  //
  // Pass 3 is the one that matters. Reasons are built as "<context> — <mechanic>"
  // and two different contexts can carry an identical mechanic, e.g.
  //   "Venusaur's Chlorophyll synergizes with Charizard's Solar Beam — <M>"
  //   "Consider adding Solar Beam to Venusaur — <M>"
  // Neither contains the other, so passes 1 and 2 both let them through and the
  // user reads the same sentence twice in one line. Keeping the first occurrence
  // keeps the more specific statement, since generic "Consider adding..."
  // suggestions are appended after the concrete ones.
  const dedupedExact = [...new Set(reasons)];
  const dedupedSubstring = dedupedExact.filter((r, i) =>
    !dedupedExact.some((other, j) => j !== i && other.includes(r) && other.length > r.length)
  );
  const seenTails = new Set();
  const deduped = dedupedSubstring.filter((r) => {
    const dash = r.indexOf(' — ');
    if (dash === -1) return true;
    const tail = r.slice(dash + 3).trim();
    if (seenTails.has(tail)) return false;
    seenTails.add(tail);
    return true;
  });

  // No score-only fallback. Co-occurrence is a statistical observation that two
  // Pokemon appear on the same teams — it is not a mechanical reason they work
  // together, and presenting it under "Strong synergies" implies a causal
  // relationship the data does not support (it cannot distinguish genuine
  // synergy from two independently strong Pokemon both being popular). A pair
  // with no mechanical reason now returns an empty list, and the caller drops it
  // from the synergy list entirely rather than padding it with a score.
  return deduped.slice(0, 3);
}

module.exports = { generateSynergyReasons };
