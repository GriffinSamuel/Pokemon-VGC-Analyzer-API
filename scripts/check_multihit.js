#!/usr/bin/env node
/**
 * check_multihit.js — regression test for the multi-hit engine.
 *
 * WHY IT IS SHAPED LIKE THIS: same contract as check_variable_bp.js. No
 * database, no node_modules, no running server. It reads the SHIPPED source text
 * of nerd_of_now_calc.js and evaluates it with a stub `require`, so it exercises
 * the real CalcDamage rather than a copy that can drift. The two module-level
 * requires are the only things stubbed:
 *
 *   ./species_weight  -> weightOf() returns null (no move under test uses weight)
 *   @pkmn/dex         -> a Dex whose types.get() returns null, which makes
 *                        getMoveEffectiveness return a flat 1x for everything.
 *
 * Neutral effectiveness is deliberate: it takes the type chart out of the
 * arithmetic so every number below is a hit-count fact, not a type-chart fact.
 * STAB is suppressed the same way, by giving the attacker a type no move under
 * test shares.
 *
 * WHAT IT GUARDS: CalcDamage returned ONE hit for every multi-hit move. A
 * ten-hit Population Bomb was reported at a tenth of its damage and Bullet Seed
 * at under a third, so every KO threshold and every move-replacement suggestion
 * built on those numbers was wrong in the same direction — the move always
 * looked too weak to keep. Nothing errored. The numbers were simply low.
 *
 *   node scripts/check_multihit.js
 */

const fs = require('fs');
const path = require('path');

const CALC = path.join(__dirname, '..', 'src', 'utils', 'nerd_of_now_calc.js');
const SRC = fs.readFileSync(CALC, 'utf8');

// Dex.types.get() returning null means getMoveEffectiveness never finds a
// damageTaken table and falls through at 1x. Dex.moves.get() is only reached by
// getMoveData, which nothing here calls.
const STUB_DEX = {
  types: { get: () => null },
  moves: { get: () => ({ exists: false }) },
};

const stubRequire = (id) => {
  if (id === './species_weight') return { weightOf: () => null };
  if (id === '@pkmn/dex') return { Dex: STUB_DEX };
  throw new Error(`check_multihit: unexpected require(${id}) — update the stubs`);
};

const mod = { exports: {} };
new Function('module', 'exports', 'require', '__filename', '__dirname', SRC)(
  mod, mod.exports, stubRequire, CALC, path.dirname(CALC)
);
const { CalcDamage, resolveMultiHit } = mod.exports;
if (typeof CalcDamage !== 'function') throw new Error('CalcDamage not exported');
if (typeof resolveMultiHit !== 'function') throw new Error('resolveMultiHit not exported');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

// Fairy attacker: no move under test is Fairy, so STAB never fires and every
// damage number below is the unmodified formula.
//
// The nature is Docile, NOT Hardy, and that matters. NATURE_TABLE encodes the
// five neutral natures as a stat paired with itself ('Hardy': ['at','at']) and
// getNatureMult tests the boosted slot first, so Hardy returns 1.1 for Attack —
// a neutral nature silently boosting a stat. That is a pre-existing quirk of
// this calculator and not this file's business to assert on; Docile pairs 'df'
// with itself and leaves Attack at a clean 1.0, which is what the hardcoded
// damage numbers below are computed from.
const ATK = (o = {}) => ({
  name: 'atkmon',
  baseStats: { hp: 100, atk: 120, def: 80, spa: 80, spd: 80, spe: 100 },
  types: ['Fairy'],
  nature: 'Docile',
  sp: { atk: 32 },   // -> Atk 172
  ...o,
});

// Def 120, HP 175.
const DEF = (o = {}) => ({
  name: 'defmon',
  baseStats: { hp: 100, atk: 80, def: 100, spa: 80, spd: 100, spe: 80 },
  types: ['Normal'],
  nature: 'Hardy',
  sp: {},
  ...o,
});

// Deliberately frail: HP 76, Def 21. One Bullet Seed hit already exceeds its HP,
// which is what makes the Focus Sash pair below mean something.
const FRAIL = (o = {}) => ({
  name: 'frailmon',
  baseStats: { hp: 1, atk: 80, def: 1, spa: 80, spd: 1, spe: 80 },
  types: ['Normal'],
  nature: 'Hardy',
  sp: {},
  ...o,
});

const MOVE = (name, bp, type) => ({
  name, bp, type: type || 'Grass', category: 'Physical',
});

const calc = (move, atk, def) => CalcDamage({
  attacker: atk || ATK(),
  defender: def || DEF(),
  move,
  isDouble: false,
});

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

let pass = 0, fail = 0;
const show = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
const check = (label, actual, expected) => {
  const ok = show(actual) === show(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(54)} ${show(actual)}`);
  if (!ok) console.log(`      expected ${show(expected)}`);
};
const counts = (mh) => mh.hit_counts.map(h => [h.hits, h.probability]);

// -----------------------------------------------------------------------------
// Single-hit behaviour must be byte-for-byte unchanged
// -----------------------------------------------------------------------------
console.log('--- single-hit moves untouched ---');
const ref25 = calc(MOVE('Reference Move', 25));
check('single-hit multi_hit is null', ref25.multi_hit, null);
check('single-hit min damage (25 BP, 172 Atk, 120 Def)', ref25.minDamage, 14);
check('single-hit max damage', ref25.maxDamage, 17);
check('single-hit minPercent', ref25.minPercent, 8);
check('single-hit maxPercent', ref25.maxPercent, 9.7);
check('single-hit raw equals effective', [ref25.raw_min_percent, ref25.raw_max_percent], [8, 9.7]);
check('resolveMultiHit(null) for an ordinary move', resolveMultiHit({ name: 'Flamethrower' }, {}), null);
check('a variable-BP move still reports unresolved', calc(MOVE('Fury Cutter', 40)).bp_unresolved, true);

// -----------------------------------------------------------------------------
// 2-5 hit family
// -----------------------------------------------------------------------------
console.log('\n--- 2-5 hit family: the distribution ---');
const seed = calc(MOVE('Bullet Seed', 25));
const seedMH = seed.multi_hit;
check('Bullet Seed is now resolvable (was UNRESOLVED_BP)', seed.bp_unresolved, false);
check('Bullet Seed base power used', seed.base_power_used, 25);
check('hit counts and probabilities', counts(seedMH), [[2, 0.35], [3, 0.35], [4, 0.15], [5, 0.15]]);
check('probabilities sum to 1', seedMH.hit_counts.reduce((s, h) => s + h.probability, 0), 1);
check('expected hits (35/35/15/15 = 3.1, NOT 3.3)', seedMH.expected_hits, 3.1);
check('note', seedMH.note, '2-5 hits, expected 3.1');

console.log('\n--- 2-5 hit family: the damage ---');
// Per hit is the single-hit reference: 14-17. k hits is k of those summed.
check('2 hits percent', [seedMH.hit_counts[0].min_percent, seedMH.hit_counts[0].max_percent], [16, 19.4]);
check('3 hits percent', [seedMH.hit_counts[1].min_percent, seedMH.hit_counts[1].max_percent], [24, 29.1]);
check('4 hits percent', [seedMH.hit_counts[2].min_percent, seedMH.hit_counts[2].max_percent], [32, 38.9]);
check('5 hits percent', [seedMH.hit_counts[3].min_percent, seedMH.hit_counts[3].max_percent], [40, 48.6]);
check('guaranteed_* is the 2-hit floor', [seedMH.guaranteed_min_percent, seedMH.guaranteed_max_percent], [16, 19.4]);
check('swap_* is the 4-hit figure', [seedMH.swap_min_percent, seedMH.swap_max_percent], [32, 38.9]);
check('expected_* (3.1 hits)', [seedMH.expected_min_percent, seedMH.expected_max_percent], [24.8, 30.1]);
check('top-level percents ARE the expected-hits damage', [seed.minPercent, seed.maxPercent], [24.8, 30.1]);
check('top-level damage is the expected-hits damage', [seed.minDamage, seed.maxDamage], [43, 53]);
check('one hit understated this by 3.1x', ref25.minPercent * 3.1 > 24 && ref25.minPercent * 3.1 < 25, true);
check('no hit count is flagged OHKO here', seedMH.hit_counts.every(h => h.ohko === false), true);

console.log('\n--- every 2-5 move is wired up ---');
for (const name of ['Rock Blast', 'Icicle Spear', 'Pin Missile', 'Scale Shot', 'Tail Slap',
  'Arm Thrust', 'Water Shuriken', 'Bone Rush', 'Comet Punch', 'Double Slap',
  'Fury Attack', 'Fury Swipes', 'Spike Cannon']) {
  const r = calc(MOVE(name, 25));
  check(`${name} rolls 2-5`, r.multi_hit && r.multi_hit.expected_hits, 3.1);
}

// -----------------------------------------------------------------------------
// Skill Link and Loaded Dice
// -----------------------------------------------------------------------------
console.log('\n--- Skill Link ---');
const skillLink = calc(MOVE('Bullet Seed', 25), ATK({ ability: 'Skill Link' })).multi_hit;
check('Skill Link forces exactly 5', counts(skillLink), [[5, 1]]);
check('Skill Link expected hits', skillLink.expected_hits, 5);
check('Skill Link note', skillLink.note, '5 hits (Skill Link)');
check('Skill Link floor is 5 hits, not 2', [skillLink.guaranteed_min_percent, skillLink.guaranteed_max_percent], [40, 48.6]);
check('Skill Link swap clamps up to 5', [skillLink.swap_min_percent, skillLink.swap_max_percent], [40, 48.6]);

console.log('\n--- Loaded Dice ---');
const dice = calc(MOVE('Bullet Seed', 25), ATK({ item: 'Loaded Dice' })).multi_hit;
check('Loaded Dice rolls 4 or 5, evenly', counts(dice), [[4, 0.5], [5, 0.5]]);
check('Loaded Dice expected hits', dice.expected_hits, 4.5);
check('Loaded Dice note', dice.note, '4-5 hits (Loaded Dice)');
check('Loaded Dice floor is 4 hits', [dice.guaranteed_min_percent, dice.guaranteed_max_percent], [32, 38.9]);
check('Loaded Dice swap is 4 hits', [dice.swap_min_percent, dice.swap_max_percent], [32, 38.9]);

// -----------------------------------------------------------------------------
// Fixed hit counts
// -----------------------------------------------------------------------------
console.log('\n--- fixed hit counts ---');
for (const [name, hits] of [['Dual Wingbeat', 2], ['Double Hit', 2], ['Twineedle', 2],
  ['Double Kick', 2], ['Gear Grind', 2], ['Dragon Darts', 2],
  ['Tachyon Cutter', 2], ['Triple Dive', 3]]) {
  const mh = calc(MOVE(name, 25)).multi_hit;
  check(`${name} always hits ${hits}`, counts(mh), [[hits, 1]]);
}
const wingbeat = calc(MOVE('Dual Wingbeat', 25)).multi_hit;
check('fixed note', wingbeat.note, '2 hits');
check('fixed: swap == guaranteed == expected', [
  wingbeat.swap_min_percent, wingbeat.guaranteed_min_percent, wingbeat.expected_min_percent,
], [16, 16, 16]);
check('Skill Link does nothing to a fixed-count move',
  counts(calc(MOVE('Dual Wingbeat', 25), ATK({ ability: 'Skill Link' })).multi_hit), [[2, 1]]);
check('Loaded Dice does nothing to a fixed-count move',
  counts(calc(MOVE('Dual Wingbeat', 25), ATK({ item: 'Loaded Dice' })).multi_hit), [[2, 1]]);

// -----------------------------------------------------------------------------
// Triple Axel — increasing base power AND a per-hit accuracy gate
// -----------------------------------------------------------------------------
console.log('\n--- Triple Axel: 20/40/60 BP, 90% per hit ---');
const axel = calc(MOVE('Triple Axel', 20, 'Ice'));
const axelMH = axel.multi_hit;
check('Triple Axel is resolvable now', axel.bp_unresolved, false);
check('hit one uses 20 BP', axel.base_power_used, 20);
check('zero hits is a real outcome', counts(axelMH),
  [[0, 0.1], [1, 0.09], [2, 0.081], [3, 0.729]]);
check('expected hits = 0.9 + 0.81 + 0.729', axelMH.expected_hits, 2.44);
check('note', axelMH.note, '3 hits at 90% accuracy each, expected 2.4');

// 20 BP -> 11-14, 40 BP -> 22-27, 60 BP -> 33-39 against this defender.
const ref20 = calc(MOVE('Reference Move', 20));
const ref40 = calc(MOVE('Reference Move', 40));
const ref60 = calc(MOVE('Reference Move', 60));
check('reference per-hit damage 20/40/60 BP',
  [ref20.minDamage, ref40.minDamage, ref60.minDamage], [11, 22, 33]);
const hp = axel._defenderStats.hp;
const asPct = (d) => Math.round((d / hp) * 1000) / 10;
check('1 hit = the 20 BP hit', axelMH.hit_counts[1].min_percent, asPct(ref20.minDamage));
check('2 hits = 20 BP + 40 BP', axelMH.hit_counts[2].min_percent, asPct(ref20.minDamage + ref40.minDamage));
check('3 hits = 20 + 40 + 60 BP', axelMH.hit_counts[3].min_percent,
  asPct(ref20.minDamage + ref40.minDamage + ref60.minDamage));
const inc = [1, 2, 3].map(k => axelMH.hit_counts[k].min_percent - axelMH.hit_counts[k - 1].min_percent);
check('each hit is STRICTLY harder than the last', inc[0] < inc[1] && inc[1] < inc[2], true);
check('not three equal hits (the flat-BP mistake)', inc[0] === inc[1], false);
check('0-hit outcome does 0 damage', [axelMH.hit_counts[0].min_percent, axelMH.hit_counts[0].max_percent], [0, 0]);
check('guaranteed_* floor is 0 — the move can miss outright',
  [axelMH.guaranteed_min_percent, axelMH.guaranteed_max_percent], [0, 0]);
check('swap_* clamps down to the 3-hit ceiling', axelMH.swap_min_percent, axelMH.hit_counts[3].min_percent);
// Weighted over the distribution, NOT 2.44 x one hit: the hits most likely to be
// missed are the 40 and 60 BP ones at the end.
check('expected_* is probability-weighted', [axelMH.expected_min_percent, axelMH.expected_max_percent], [29.6, 35.9]);
check('expected damage is BELOW a flat 2.44 x first hit x 3', axelMH.expected_min_percent < asPct(66), true);
check('top-level percents follow expected', [axel.minPercent, axel.maxPercent], [29.6, 35.9]);

console.log('\n--- Triple Kick: 10/20/30 BP, same structure ---');
const kick = calc(MOVE('Triple Kick', 10, 'Fighting')).multi_hit;
check('Triple Kick expected hits', kick.expected_hits, 2.44);
check('Triple Kick hit one uses 10 BP', calc(MOVE('Triple Kick', 10, 'Fighting')).base_power_used, 10);
const kinc = [1, 2, 3].map(k => kick.hit_counts[k].min_percent - kick.hit_counts[k - 1].min_percent);
check('Triple Kick hits also escalate', kinc[0] < kinc[1] && kinc[1] < kinc[2], true);

// -----------------------------------------------------------------------------
// Population Bomb — the accuracy-limited expectation
// -----------------------------------------------------------------------------
console.log('\n--- Population Bomb: 10 hits at 90% each ---');
const bomb = calc(MOVE('Population Bomb', 20, 'Normal'));
const bombMH = bomb.multi_hit;
check('Population Bomb is resolvable now', bomb.bp_unresolved, false);
check('eleven outcomes: 0 through 10', bombMH.hit_counts.map(h => h.hits), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
check('P(10 hits) = 0.9^10', bombMH.hit_counts[10].probability, 0.3487);
check('P(0 hits) = 0.1', bombMH.hit_counts[0].probability, 0.1);
check('expected hits = sum(0.9^k, k=1..10), NOT 10 and NOT 6.5', bombMH.expected_hits, 5.86);
check('note', bombMH.note, '10 hits at 90% accuracy each, expected 5.9');
check('10-hit outcome damage', [bombMH.hit_counts[10].min_percent, bombMH.hit_counts[10].max_percent], [62.9, 80]);
check('expected_* sits near six hits, not ten', [bombMH.expected_min_percent, bombMH.expected_max_percent], [36.8, 46.9]);
check('guaranteed_* floor is 0', bombMH.guaranteed_min_percent, 0);
check('swap_* is a conservative 4 hits, not the 10-hit ceiling',
  [bombMH.swap_min_percent, bombMH.swap_max_percent], [25.1, 32]);
check('one hit understated this by ~5.9x', bomb.minPercent / ref20.minPercent > 5.5, true);

const bombDice = calc(MOVE('Population Bomb', 20, 'Normal'), ATK({ item: 'Loaded Dice' })).multi_hit;
check('Loaded Dice: 4-5 hits, no accuracy checks', counts(bombDice), [[4, 0.5], [5, 0.5]]);
check('Loaded Dice expected hits', bombDice.expected_hits, 4.5);
check('Loaded Dice note', bombDice.note, '4-5 hits (Loaded Dice)');
check('Loaded Dice removes the 0-hit outcome', bombDice.guaranteed_min_percent > 0, true);

// -----------------------------------------------------------------------------
// Wide Lens
// -----------------------------------------------------------------------------
console.log('\n--- Wide Lens: accuracy x1.1, capped at 100 ---');
const lensBomb = calc(MOVE('Population Bomb', 20, 'Normal'), ATK({ item: 'Wide Lens' })).multi_hit;
check('90 -> 99% per hit', lensBomb.note, '10 hits at 99% accuracy each, expected 9.5');
check('expected hits = sum(0.99^k, k=1..10)', lensBomb.expected_hits, 9.47);
check('Wide Lens moves the expectation a long way', lensBomb.expected_hits > bombMH.expected_hits + 3, true);
const lensAxel = calc(MOVE('Triple Axel', 20, 'Ice'), ATK({ item: 'Wide Lens' })).multi_hit;
check('Triple Axel under Wide Lens', lensAxel.expected_hits, 2.94);
check('Wide Lens does nothing to a 2-5 roll (no per-hit check)',
  calc(MOVE('Bullet Seed', 25), ATK({ item: 'Wide Lens' })).multi_hit.expected_hits, 3.1);
check('Wide Lens does nothing to a fixed-count move',
  calc(MOVE('Dual Wingbeat', 25), ATK({ item: 'Wide Lens' })).multi_hit.expected_hits, 2);

// -----------------------------------------------------------------------------
// Focus Sash
// -----------------------------------------------------------------------------
console.log('\n--- Focus Sash ---');
// One 25 BP hit does 78-92 into a 76 HP Sash holder: the single-hit path caps.
const sashSingle = calc(MOVE('Reference Move', 25), ATK(), FRAIL({ item: 'Focus Sash' }));
check('single hit: Sash still prevents the OHKO', sashSingle.sash_prevents_ohko, true);
check('single hit: percent capped below 100', sashSingle.minPercent, 98.7);
check('single hit: raw figure still disclosed', sashSingle.raw_min_percent > 100, true);

// Same hit, but Bullet Seed lands it two to five times. Sash only fires from FULL
// HP, so at best it survives hit one at 1 HP and hit two kills.
const sashMulti = calc(MOVE('Bullet Seed', 25), ATK(), FRAIL({ item: 'Focus Sash' }));
check('multi-hit: Sash does NOT prevent the KO', sashMulti.sash_prevents_ohko, false);
check('multi-hit: percent is NOT capped below 100', sashMulti.minPercent > 100, true);
check('multi-hit: every hit count is an OHKO here',
  sashMulti.multi_hit.hit_counts.every(h => h.ohko === true), true);
check('multi-hit: KO tier is 1HKO through the Sash', sashMulti.guaranteed_ko, '1HKO');
check('control: no Sash, same defender, same numbers',
  calc(MOVE('Bullet Seed', 25), ATK(), FRAIL()).minPercent, sashMulti.minPercent);

// -----------------------------------------------------------------------------
// Output shape
// -----------------------------------------------------------------------------
console.log('\n--- output shape ---');
check('multi_hit keys', Object.keys(seedMH).sort(), [
  'expected_hits', 'expected_max_percent', 'expected_min_percent',
  'guaranteed_max_percent', 'guaranteed_min_percent', 'hit_counts', 'note',
  'swap_max_percent', 'swap_min_percent',
].sort());
check('hit_counts entry keys', Object.keys(seedMH.hit_counts[0]).sort(),
  ['hits', 'max_percent', 'min_percent', 'ohko', 'probability'].sort());
check('pre-existing fields all survive', [
  'minPercent', 'maxPercent', 'minDamage', 'maxDamage', 'guaranteed_ko', 'notes',
  'bp_unresolved', 'base_power_used', 'sash_prevents_ohko', 'raw_min_percent',
  'raw_max_percent', 'raw_min_damage', 'raw_max_damage',
].every(k => k in seed), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
