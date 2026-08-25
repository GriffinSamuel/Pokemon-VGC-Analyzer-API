#!/usr/bin/env node
/**
 * check_set_coherence.js — does the "observed set" we build for a candidate
 * correspond to a set anybody actually played?
 *
 * candidateProfile() in archetype_swaps.js assembles a candidate out of FOUR
 * independently-argmaxed marginal distributions:
 *
 *   spread  <- getMostCommonSpread(name)      (ev_observations)
 *   item    <- getCommonItems(name, 1)[0]     (ev_observations)
 *   ability <- getAbilityFrequency(name)[0]   (tournament_teams)
 *   moves   <- observedMovesFor(name)[0..3]   (tournament_teams, pooled by move)
 *
 * Nothing joins them. The item is the most common item across all rows; the
 * moves are the four most common moves across all rows. A species with two
 * distinct competitive builds will have its item taken from one and its moves
 * taken from the other, producing a set no player ever brought.
 *
 * The visible symptom that started this: Sableye recommended @ Light Clay with
 * no Reflect or Light Screen in its four moves. Light Clay exists only to
 * extend screens.
 *
 * This script does not change anything. It compares the composed set against
 * the JOINT distribution of real sets in tournament_teams and reports how often
 * we are inventing a build.
 *
 * Usage:
 *   node scripts\check_set_coherence.js                 # sweep every species
 *   node scripts\check_set_coherence.js sableye         # one species, verbose
 */

const pool = require('../src/db/pool');

const lower = (s) => String(s || '').toLowerCase().trim();

/** Every real, whole set recorded for this species, grouped by identity. */
async function jointSets(nameLower) {
  const { rows } = await pool.query(
    `SELECT p->>'item'    AS item,
            p->>'ability' AS ability,
            p->>'nature'  AS nature,
            (SELECT array_agg(x ORDER BY x)
               FROM jsonb_array_elements_text(p->'attacks') x) AS attacks,
            COUNT(*)::int AS count
       FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
      WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) = $1
      GROUP BY 1,2,3,4
      ORDER BY count DESC`,
    [nameLower]
  ).catch(() => ({ rows: [] }));
  return rows.map((r) => ({ ...r, attacks: r.attacks || [] }));
}

/** The four marginals, computed exactly the way candidateProfile does. */
async function marginals(nameLower) {
  const itemQ = await pool.query(
    `SELECT item, COUNT(*)::int AS count FROM ev_observations
      WHERE LOWER(normalized_name) = $1 AND item IS NOT NULL
      GROUP BY item ORDER BY count DESC LIMIT 1`,
    [nameLower]
  ).catch(() => ({ rows: [] }));

  const abilityQ = await pool.query(
    `SELECT p->>'ability' AS ability, COUNT(*)::int AS count
       FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
      WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) = $1
        AND p->>'ability' IS NOT NULL
      GROUP BY 1 ORDER BY count DESC LIMIT 1`,
    [nameLower]
  ).catch(() => ({ rows: [] }));

  const moveQ = await pool.query(
    `SELECT a.move_name AS move, COUNT(*)::int AS count
       FROM tournament_teams t,
            jsonb_array_elements(t.pokemon) p,
            jsonb_array_elements_text(p->'attacks') AS a(move_name)
      WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) = $1
      GROUP BY 1 ORDER BY count DESC`,
    [nameLower]
  ).catch(() => ({ rows: [] }));

  return {
    item: itemQ.rows[0]?.item || null,
    ability: abilityQ.rows[0]?.ability || null,
    moves: moveQ.rows.slice(0, 4).map((r) => r.move),
    moveRanks: moveQ.rows,
  };
}

const SCREENS = new Set(['reflect', 'light screen', 'aurora veil']);
const SCREEN_ITEMS = new Set(['light clay']);

/**
 * Does the composed (item, moves) pair appear in ANY single real set?
 * Moves are checked as a subset, not an exact match, so a set that ran all four
 * of our chosen moves plus our chosen item counts as coherent even if our slice
 * ordered them differently.
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

/**
 * The specific, checkable contradiction: we hand it an item whose ONLY purpose
 * is to support a move we did not give it.
 */
function itemMoveContradiction(composed, sets) {
  if (!SCREEN_ITEMS.has(lower(composed.item))) return null;
  const hasScreen = composed.moves.some((m) => SCREENS.has(lower(m)));
  if (hasScreen) return null;

  // How many real Light Clay sets DID run a screen?
  let clayTotal = 0;
  let clayWithScreen = 0;
  for (const s of sets) {
    if (lower(s.item) !== lower(composed.item)) continue;
    clayTotal += s.count;
    if ((s.attacks || []).some((a) => SCREENS.has(lower(a)))) clayWithScreen += s.count;
  }
  return { clayTotal, clayWithScreen };
}

async function report(name, verbose) {
  const key = lower(name);
  const [sets, m] = await Promise.all([jointSets(key), marginals(key)]);
  if (sets.length === 0) return null;

  const composed = { item: m.item, ability: m.ability, moves: m.moves };
  const c = coherence(composed, sets);
  const contradiction = itemMoveContradiction(composed, sets);

  const out = {
    name,
    observed_rows: c.total,
    distinct_real_sets: sets.length,
    composed_item: composed.item,
    composed_moves: composed.moves,
    // The headline number: of every recorded set for this species, how many
    // actually ran the item AND all four moves we composed. 0 means invented.
    real_sets_matching_composition: c.itemAndAllMoves,
    rows_with_composed_item: c.itemTotal,
    contradiction,
  };

  if (verbose) {
    console.log(`\n=== ${name} ===`);
    console.log(`rows: ${c.total}   distinct real sets: ${sets.length}`);
    console.log(`\ncomposed by candidateProfile():`);
    console.log(`  item    ${composed.item}`);
    console.log(`  ability ${composed.ability}`);
    console.log(`  moves   ${composed.moves.join(', ')}`);
    console.log(`\nmove frequency (pooled across ALL sets):`);
    for (const r of m.moveRanks.slice(0, 12)) {
      const mark = composed.moves.map(lower).includes(lower(r.move)) ? ' <- taken' : '';
      console.log(`  ${String(r.count).padStart(5)}  ${r.move}${mark}`);
    }
    console.log(`\nreal sets, most common first:`);
    for (const s of sets.slice(0, 8)) {
      console.log(`  ${String(s.count).padStart(4)}x  @${s.item || '(none)'} / ${s.ability || '(none)'}`);
      console.log(`         ${(s.attacks || []).join(', ')}`);
    }
    console.log(`\nrows running the composed item .............. ${c.itemTotal}`);
    console.log(`rows running composed item + ALL 4 moves ..... ${c.itemAndAllMoves}`);
    if (c.itemAndAllMoves === 0) {
      console.log(`\n  ** the composed set was never played by anybody **`);
    }
    if (contradiction) {
      console.log(`\n  ** item/move contradiction **`);
      console.log(`     ${composed.item} sets: ${contradiction.clayTotal}, of which ${contradiction.clayWithScreen} run a screen`);
      console.log(`     we composed ${composed.item} with no screen in the four moves.`);
    }
  }
  return out;
}

async function sweep() {
  const { rows } = await pool.query(
    `SELECT LOWER(COALESCE(p->>'normalizedName', p->>'name')) AS name, COUNT(*)::int AS count
       FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
      GROUP BY 1 HAVING COUNT(*) >= 5 ORDER BY count DESC`
  );
  console.log(`sweeping ${rows.length} species with >=5 observed rows\n`);

  const invented = [];
  const contradictions = [];
  let checked = 0;

  for (const r of rows) {
    const res = await report(r.name, false);
    if (!res) continue;
    checked += 1;
    if (res.real_sets_matching_composition === 0) invented.push(res);
    if (res.contradiction) contradictions.push(res);
  }

  console.log(`checked ................................. ${checked}`);
  console.log(`composed a set nobody ever played ....... ${invented.length}  (${Math.round((invented.length / checked) * 100)}%)`);
  console.log(`item/move contradictions ................ ${contradictions.length}`);

  if (invented.length) {
    console.log(`\n--- composed sets with zero real-world support (top 25 by usage) ---`);
    for (const v of invented.slice(0, 25)) {
      console.log(`  ${v.name.padEnd(22)} ${String(v.observed_rows).padStart(5)} rows  @${v.composed_item || '(none)'}`);
      console.log(`  ${''.padEnd(22)}       ${v.composed_moves.join(', ')}`);
    }
  }
  if (contradictions.length) {
    console.log(`\n--- item whose only purpose is a move we did not give it ---`);
    for (const v of contradictions) {
      console.log(`  ${v.name.padEnd(22)} @${v.composed_item}  ${v.contradiction.clayWithScreen}/${v.contradiction.clayTotal} real ${v.composed_item} sets run a screen`);
      console.log(`  ${''.padEnd(22)} composed moves: ${v.composed_moves.join(', ')}`);
    }
  }
}

(async () => {
  const arg = process.argv[2];
  try {
    if (arg) {
      const res = await report(arg, true);
      if (!res) console.log(`no observed rows for "${arg}"`);
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
