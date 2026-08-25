#!/usr/bin/env node
/**
 * check_showdown_parser.js — regression test for parsePokemonBlock()'s
 * gender-marker fix (HANDOFF_data_integrity_step3.md item 3a/b).
 *
 * Before the fix, a trailing "(M)"/"(F)" gender marker was indistinguishable
 * from Showdown's "Nickname (Species)" syntax — both are "some text, then a
 * parenthesized group, at the end of the line" — so the parser always took
 * the parenthesized text AS the species. "Basculegion (M)" parsed as species
 * "M"; "Sharky (Garchomp) (M)" parsed as species "Garchomp) (M", a mangled
 * string with a stray paren welded on. 334 real tournament_teams rows ended
 * up stored under literal species "M" or "F" as a result.
 *
 * Also covers the move-name ID-vs-display fix (normalizeMoveName): one
 * Limitless tournament's decklist arrived with `attacks` as dex move IDs.
 *
 * Usage:
 *   node scripts\check_showdown_parser.js
 */

const { parseShowdownTeam } = require('../src/routes/team');
const { normalizeMoveName } = require('../src/utils/normalize');

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(45)} ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`);
  if (ok) pass++; else fail++;
}

console.log('--- gender marker vs nickname (item 3a) ---\n');

{
  const [mon] = parseShowdownTeam('Basculegion (M) @ Mystic Water\n- Wave Crash');
  check('"Basculegion (M)" -> species', mon.name, 'Basculegion');
  check('"Basculegion (M)" -> gender', mon.gender, 'M');
  check('"Basculegion (M)" -> item', mon.item, 'Mystic Water');
}

{
  const [mon] = parseShowdownTeam('Sharky (Garchomp) (M) @ Life Orb\n- Earthquake');
  check('"Sharky (Garchomp) (M)" -> species', mon.name, 'Garchomp');
  check('"Sharky (Garchomp) (M)" -> gender', mon.gender, 'M');
  check('"Sharky (Garchomp) (M)" -> item', mon.item, 'Life Orb');
}

{
  const [mon] = parseShowdownTeam('Indeedee-F @ Psychic Seed\n- Follow Me');
  check('"Indeedee-F" -> species (unaffected)', mon.name, 'Indeedee-F');
  check('"Indeedee-F" -> gender (no marker present)', mon.gender, null);
  check('"Indeedee-F" -> item', mon.item, 'Psychic Seed');
}

{
  const [mon] = parseShowdownTeam('Basculegion @ Choice Band\n- Flip Turn');
  check('"Basculegion" -> species (unaffected)', mon.name, 'Basculegion');
  check('"Basculegion" -> gender (none)', mon.gender, null);
  check('"Basculegion" -> item', mon.item, 'Choice Band');
}

console.log('\n--- move name ID-vs-display (item 3b) ---\n');

check('"trickroom" -> display form', normalizeMoveName('trickroom'), 'Trick Room');
check('"kingsshield" -> display form', normalizeMoveName('kingsshield'), "King's Shield");
check('"Rock Slide" -> unchanged (already correct)', normalizeMoveName('Rock Slide'), 'Rock Slide');
check('"Solat Beam" -> unchanged (typo, not ours to guess)', normalizeMoveName('Solat Beam'), 'Solat Beam');

{
  const [mon] = parseShowdownTeam('Aegislash @ Weakness Policy\n- kingsshield\n- Iron Head');
  check('parsed team normalises attacks too', mon.attacks, ["King's Shield", 'Iron Head']);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
