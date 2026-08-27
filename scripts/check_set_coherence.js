#!/usr/bin/env node
/**
 * check_set_coherence.js — does the composed build we hand out for a
 * candidate correspond to a set anybody actually played?
 *
 * PHASE 3 rewrite: this now calls the REAL candidateProfile() (exported from
 * archetype_swaps.js) instead of re-implementing a parallel copy of its old
 * four-independent-argmax logic — so this script can never silently drift
 * from what the report actually does, and it exercises composition the same
 * way the report does: per archetype, through the staged ladder (item ->
 * moves/ability -> nature/spread, over a pool that widens from
 * teammate-matched rows to archetype rows to all rows — see archetype_swaps.js's
 * "COMPOSITION LADDER" section for the full design).
 *
 * For each of the 6 real archetypes a species has at least one observed row
 * in, this composes a build via candidateProfile(name, {archetype}) — exactly
 * how buildPokemonSwaps() calls it in production — and validates the result
 * against the BUCKET that build's own provenance says it was drawn from
 * (the archetype's rows if provenance.level === 2, all rows if level === 3;
 * level 1 needs a real team under analysis and isn't reachable from this
 * standalone script, same as before).
 *
 * A species is reported as "composed a set nobody ever played" if ANY of its
 * per-archetype compositions has zero real-world support — the strictest
 * reading, since a single bad archetype composition is still a real threat
 * profile the report could show a user.
 *
 * Usage:
 *   node scripts\check_set_coherence.js                 # sweep every species
 *   node scripts\check_set_coherence.js sableye          # one species, verbose
 */

const pool = require('../src/db/pool');
const { candidateProfile, observedOccurrences } = require('../src/utils/archetype_swaps');
const { ALL_ARCHETYPES } = require('../src/utils/archetype_tags');

const lower = (s) => String(s || '').toLowerCase().trim();

/** Real whole sets within a bucket of occurrences, grouped by (item, moves). */
function jointSets(occurrences) {
  const map = new Map();
  for (const o of occurrences) {
    const attacks = [...(o.moves || [])].sort();
    const key = JSON.stringify([o.item, attacks]);
    if (!map.has(key)) map.set(key, { item: o.item, ability: o.ability, attacks, count: 0 });
    map.get(key).count += 1;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Does the composed (item, moves) pair appear in ANY single real set within
 * the bucket? Moves are checked as a subset, not an exact match.
 */
function coherence(composed, sets) {
  const wantItem = lower(composed.item);
  const wantMoves = composed.moves.map(lower);

  let itemAndAllMoves = 0;
  let itemAndAnyMove = 0;
  let itemTotal = 0;
  let total = 0;

  for (const s of sets) {
    total += s.count;
    if (lower(s.item) !== wantItem) continue;
    itemTotal += s.count;
    const have = new Set((s.attacks || []).map(lower));
    const hits = wantMoves.filter((m) => have.has(m)).length;
    if (hits === wantMoves.length) itemAndAllMoves += s.count;
    if (hits > 0) itemAndAnyMove += s.count;
  }
  return { total, itemTotal, itemAndAllMoves, itemAndAnyMove };
}

const SCREENS = new Set(['reflect', 'light screen', 'aurora veil']);
const SCREEN_ITEMS = new Set(['light clay']);

function itemMoveContradiction(composed, sets) {
  if (!SCREEN_ITEMS.has(lower(composed.item))) return null;
  const hasScreen = composed.moves.some((m) => SCREENS.has(lower(m)));
  if (hasScreen) return null;

  let clayTotal = 0;
  let clayWithScreen = 0;
  for (const s of sets) {
    if (lower(s.item) !== lower(composed.item)) continue;
    clayTotal += s.count;
    if ((s.attacks || []).some((a) => SCREENS.has(lower(a)))) clayWithScreen += s.count;
  }
  return { clayTotal, clayWithScreen };
}

/** One archetype's composition for `name`, validated against its own bucket. */
async function reportForArchetype(name, archetype, occurrences, verbose) {
  const profile = await candidateProfile(name, { archetype });
  if (!profile) return null;

  const bucket = profile.provenance?.level === 2
    ? occurrences.filter((o) => o.archetypes.has(archetype))
    : occurrences; // level 3 (all observed) — level 1 needs a real team, unreachable here
  const sets = jointSets(bucket);
  const composed = { item: profile.item, moves: profile.moves.map((m) => m.move) };
  const c = coherence(composed, sets);
  const contradiction = itemMoveContradiction(composed, sets);

  const out = {
    name, archetype,
    bucket_rows: c.total,
    distinct_real_sets: sets.length,
    composed_item: composed.item,
    composed_moves: composed.moves,
    real_sets_matching_composition: c.itemAndAllMoves,
    rows_with_composed_item: c.itemTotal,
    contradiction,
    provenance: profile.provenance,
  };

  if (verbose) {
    console.log(`\n--- ${name} | archetype=${archetype} ---`);
    console.log(`bucket rows: ${c.total} (${profile.provenance?.label})   distinct real sets in bucket: ${sets.length}`);
    console.log(`composed: @${composed.item || '(none)'} / ${composed.moves.join(', ')}`);
    console.log(`rows running composed item .............. ${c.itemTotal}`);
    console.log(`rows running composed item + ALL moves .... ${c.itemAndAllMoves}`);
    if (c.itemAndAllMoves === 0) console.log(`  ** composed set was never played by anybody in this bucket **`);
    if (contradiction) {
      console.log(`  ** item/move contradiction ** ${composed.item} sets: ${contradiction.clayTotal}, of which ${contradiction.clayWithScreen} run a screen`);
    }
  }
  return out;
}

async function report(name, verbose) {
  const key = lower(name);
  const occurrences = await observedOccurrences(key);
  if (occurrences.length === 0) return null;

  const archetypesPresent = ALL_ARCHETYPES.filter((a) => occurrences.some((o) => o.archetypes.has(a)));
  // Always also test the "no observed archetype tag" case so a species that
  // never appears on a tagged team is still exercised exactly like
  // buildPokemonSwaps would (falling straight to Level 3).
  const toTest = archetypesPresent.length > 0 ? archetypesPresent : [null];

  const perArchetype = [];
  for (const archetype of toTest) {
    const res = await reportForArchetype(name, archetype, occurrences, verbose);
    if (res) perArchetype.push(res);
  }
  if (perArchetype.length === 0) return null;

  const invented = perArchetype.filter((r) => r.real_sets_matching_composition === 0);
  const contradictions = perArchetype.filter((r) => r.contradiction);

  return {
    name,
    observed_rows: occurrences.length,
    per_archetype: perArchetype,
    invented_in_any_archetype: invented.length > 0,
    invented_archetypes: invented.map((r) => r.archetype),
    contradiction_archetypes: contradictions.map((r) => r.archetype),
  };
}

async function sweep() {
  const { rows } = await pool.query(
    `SELECT LOWER(COALESCE(p->>'normalizedName', p->>'name')) AS name, COUNT(*)::int AS count
       FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
      GROUP BY 1 HAVING COUNT(*) >= 5 ORDER BY count DESC`
  );
  console.log(`sweeping ${rows.length} species with >=5 observed rows (each tested per real archetype it appears in)\n`);

  const invented = [];
  const contradictions = [];
  let checked = 0;

  for (const r of rows) {
    const res = await report(r.name, false);
    if (!res) continue;
    checked += 1;
    if (res.invented_in_any_archetype) invented.push(res);
    if (res.contradiction_archetypes.length > 0) contradictions.push(res);
  }

  console.log(`checked ................................. ${checked}`);
  console.log(`composed a set nobody ever played ....... ${invented.length}  (${Math.round((invented.length / checked) * 100)}%)`);
  console.log(`item/move contradictions ................ ${contradictions.length}`);

  if (invented.length) {
    console.log(`\n--- species with >=1 archetype composing a set with zero real-world support ---`);
    for (const v of invented.slice(0, 40)) {
      for (const archetype of v.invented_archetypes) {
        const detail = v.per_archetype.find((p) => p.archetype === archetype);
        console.log(`  ${v.name.padEnd(22)} [${archetype}]  ${String(detail.bucket_rows).padStart(4)} bucket rows  @${detail.composed_item || '(none)'}`);
        console.log(`  ${''.padEnd(22)}       ${detail.composed_moves.join(', ')}  (${detail.provenance?.label})`);
      }
    }
    if (invented.length > 40) console.log(`  ... and ${invented.length - 40} more species not shown`);
  }
  if (contradictions.length) {
    console.log(`\n--- item whose only purpose is a move we did not give it ---`);
    for (const v of contradictions) {
      for (const archetype of v.contradiction_archetypes) {
        const detail = v.per_archetype.find((p) => p.archetype === archetype);
        console.log(`  ${v.name.padEnd(22)} [${archetype}] @${detail.composed_item}  ${detail.contradiction.clayWithScreen}/${detail.contradiction.clayTotal} real sets in bucket run a screen`);
      }
    }
  }
}

(async () => {
  const arg = process.argv[2];
  try {
    if (arg) {
      const res = await report(arg, true);
      if (!res) console.log(`no observed rows for "${arg}"`);
      else {
        console.log(`\n=== ${arg} summary ===`);
        console.log(`observed rows: ${res.observed_rows}`);
        console.log(`archetypes tested: ${res.per_archetype.map((p) => p.archetype).join(', ')}`);
        console.log(`invented in any archetype: ${res.invented_in_any_archetype} (${res.invented_archetypes.join(', ') || 'none'})`);
      }
    } else {
      await sweep();
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
