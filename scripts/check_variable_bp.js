#!/usr/bin/env node
/**
 * check_variable_bp.js — regression test for variable base power resolution.
 *
 * WHY IT IS SHAPED LIKE THIS: it needs no database, no node_modules and no
 * running server. It slices the UNRESOLVED_BP -> resolveVariableBP block out of
 * the SHIPPED source text and evaluates it with a stub weight lookup. So it runs
 * anywhere, in under a second, and it tests the real file rather than a copy of
 * it that can drift.
 *
 * WHAT IT GUARDS: every one of these moves computes its power from game state.
 * Fourteen of them were silently resolving to a fixed default because the state
 * never reached the calculator — Last Respects pinned at its 50 BP floor, Grass
 * Knot and Heavy Slam pinned at their 120 BP ceiling, Return at 2601 BP and
 * Wring Out at roughly 21000 BP. None of it raised an error; the numbers just
 * came out wrong, and looked entirely reasonable doing it.
 *
 *   node scripts/check_variable_bp.js
 */

const fs = require('fs');
const path = require('path');
const CALC = path.join(__dirname, '..', 'src', 'utils', 'nerd_of_now_calc.js');
const SRC = fs.readFileSync(CALC, 'utf8');

const start = SRC.indexOf('const UNRESOLVED_BP = Symbol(');
if (start === -1) throw new Error('UNRESOLVED_BP not found');
const fnStart = SRC.indexOf('function resolveVariableBP(', start);
if (fnStart === -1) throw new Error('resolveVariableBP not found');
let depth = 0, end = -1;
for (let j = SRC.indexOf('{', fnStart); j < SRC.length; j++) {
  if (SRC[j] === '{') depth++;
  else if (SRC[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
const block = SRC.slice(start, end);

// Stub weights: only the two species the weight tests name.
const WEIGHTS = { heavymon: 200, lightmon: 5, midmon: 60 };
const stubWeightOf = (n) => WEIGHTS[String(n || '').toLowerCase()] ?? null;

const { resolveVariableBP, UNRESOLVED_BP } =
  new Function('weightOf', `${block}; return { resolveVariableBP, UNRESOLVED_BP };`)(stubWeightOf);

const A = (o = {}) => ({ name: 'atkmon', stats: { spe: 100 }, ...o });
const D = (o = {}) => ({ name: 'defmon', stats: { spe: 100, hp: 175 }, ...o });

let pass = 0, fail = 0;
const UNRES = '<UNRESOLVED>';
const show = (v) => (v === UNRESOLVED_BP ? UNRES : String(v));
const check = (label, move, atk, def, expected) => {
  const actual = resolveVariableBP({ name: move }, atk, def);
  const ok = show(actual) === show(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${show(actual)}`);
  if (!ok) console.log(`      expected ${show(expected)}`);
};

console.log('--- the bug that started this: Last Respects ---');
check('Last Respects, 0 allies down', 'last respects', A({ side: { faintedCount: 0 } }), D(), 50);
check('Last Respects, 1 ally down', 'last respects', A({ side: { faintedCount: 1 } }), D(), 100);
check('Last Respects, 2 allies down', 'last respects', A({ side: { faintedCount: 2 } }), D(), 150);
check('Last Respects, 3 allies down', 'last respects', A({ side: { faintedCount: 3 } }), D(), 200);
check('Last Respects, no side object at all', 'last respects', A(), D(), 50);

console.log('\n--- the absurd ones ---');
check('Return at default happiness (was 2601)', 'return', A(), D(), 102);
check('Return at 0 happiness', 'return', A({ happiness: 0 }), D(), 1);
check('Frustration at default (0 happiness)', 'frustration', A(), D(), 102);
check('Frustration at 255 happiness', 'frustration', A({ happiness: 255 }), D(), 1);
check('Wring Out vs full HP (was ~21000)', 'wring out', A(), D(), 120);
check('Wring Out vs half HP', 'wring out', A(), D({ hpFraction: 0.5 }), 60);
check('Hard Press vs full HP', 'hard press', A(), D(), 100);

console.log('\n--- weight tables: unknown must NOT be the ceiling ---');
check('Grass Knot, unknown weight', 'grass knot', A(), D({ name: 'nosuchmon' }), UNRESOLVED_BP);
check('Grass Knot vs 200kg', 'grass knot', A(), D({ name: 'heavymon' }), 120);
check('Grass Knot vs 60kg', 'grass knot', A(), D({ name: 'midmon' }), 80);
check('Grass Knot vs 5kg', 'grass knot', A(), D({ name: 'lightmon' }), 20);
check('Low Kick vs 5kg (was not handled at all)', 'low kick', A(), D({ name: 'lightmon' }), 20);
check('Heavy Slam, unknown weights', 'heavy slam', A({ name: 'nosuchmon' }), D({ name: 'nosuchmon' }), UNRESOLVED_BP);
check('Heavy Slam 200kg vs 5kg (40x ratio)', 'heavy slam', A({ name: 'heavymon' }), D({ name: 'lightmon' }), 120);
check('Heavy Slam 60kg vs 200kg (0.3x ratio)', 'heavy slam', A({ name: 'midmon' }), D({ name: 'heavymon' }), 40);

console.log('\n--- HP scaling, both directions ---');
check('Eruption at full HP', 'eruption', A(), D(), 150);
check('Eruption at half HP', 'eruption', A({ hpFraction: 0.5 }), D(), 75);
check('Flail at full HP', 'flail', A(), D(), 20);
check('Flail at 10% HP', 'flail', A({ hpFraction: 0.1 }), D(), 150);

console.log('\n--- speed-derived, newly resolvable ---');
check('Payback when slower', 'payback', A({ stats: { spe: 50 } }), D({ stats: { spe: 100 } }), 100);
check('Payback when faster', 'payback', A({ stats: { spe: 150 } }), D({ stats: { spe: 100 } }), 50);
check('Bolt Beak when faster', 'bolt beak', A({ stats: { spe: 150 } }), D({ stats: { spe: 100 } }), 170);
check('Fishious Rend when slower', 'fishious rend', A({ stats: { spe: 50 } }), D({ stats: { spe: 100 } }), 85);
check('Electro Ball at 4x speed', 'electro ball', A({ stats: { spe: 400 } }), D({ stats: { spe: 100 } }), 150);
check('Electro Ball at 2.5x speed', 'electro ball', A({ stats: { spe: 250 } }), D({ stats: { spe: 100 } }), 80);
check('Electro Ball at equal speed', 'electro ball', A({ stats: { spe: 100 } }), D({ stats: { spe: 100 } }), 40);
check('Gyro Ball, slow user vs fast target', 'gyro ball', A({ stats: { spe: 100 } }), D({ stats: { spe: 200 } }), 50);

console.log('\n--- status-conditional ---');
check('Venoshock vs poisoned', 'venoshock', A(), D({ status: 'psn' }), 130);
check('Venoshock vs healthy', 'venoshock', A(), D(), 65);
check('Brine vs full HP', 'brine', A(), D(), 65);
check('Brine vs half HP', 'brine', A(), D({ hpFraction: 0.5 }), 130);
check('Facade while statused', 'facade', A({ status: 'brn' }), D(), 140);
check('Hex vs statused', 'hex', A(), D({ status: 'par' }), 130);

console.log('\n--- must report unresolved, not a plausible number ---');
check('Fury Cutter (consecutive use)', 'fury cutter', A(), D(), UNRESOLVED_BP);
check('Population Bomb (multi-hit, no engine)', 'population bomb', A(), D(), UNRESOLVED_BP);
check('Triple Axel (multi-hit)', 'triple axel', A(), D(), UNRESOLVED_BP);
check('Assurance (turn state)', 'assurance', A(), D(), UNRESOLVED_BP);
check('Trump Card with no PP tracking', 'trump card', A(), D(), UNRESOLVED_BP);
check('Natural Gift with no Berry table', 'natural gift', A(), D(), UNRESOLVED_BP);
check('Spit Up with no Stockpile', 'spit up', A(), D(), UNRESOLVED_BP);
check('Spit Up at 3 Stockpile', 'spit up', A({ stockpile: 3 }), D(), 300);

console.log('\n--- unchanged behaviour ---');
check('Acrobatics holding an item', 'acrobatics', A({ item: 'Sitrus Berry' }), D(), 55);
check('Acrobatics with no item', 'acrobatics', A(), D(), 110);
check('Rage Fist untouched', 'rage fist', A(), D(), 50);
check('Rage Fist after 6 hits (capped)', 'rage fist', A({ timesHit: 6 }), D(), 350);
check('a move with no variable component', 'flamethrower', A(), D(), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
