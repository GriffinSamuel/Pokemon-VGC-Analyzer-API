#!/usr/bin/env node
/**
 * check_missing_move_legality.js — for every dex move id referenced in some
 * species' learnset but absent from the `moves` table (rebuild_pokemon_moves.js's
 * 107-item drop list, minus Light of Ruin which item 1 resolved separately),
 * classify it before anyone decides whether to backfill it.
 *
 * THE DISCRIMINATOR IS OBSERVATION, NOT isNonstandard. Light of Ruin is
 * isNonstandard="Past" and is legal and played (167 observed rows) in
 * Champions Reg M-B — isNonstandard means "not obtainable in a fresh
 * current-gen save," a different claim from "illegal in this format." An
 * earlier pass here classified by isNonstandard and got the right answer for
 * the wrong reason (every OTHER move here also happens to read 0 observed
 * rows), which would have silently misclassified the next Light-of-Ruin-
 * shaped case.
 *
 *   real gap:   observed_rows > 0  -> played in this format, therefore legal
 *               regardless of the dex flag, therefore worth backfilling
 *               (one at a time, verified in real output — see
 *               add_missing_move.js)
 *   stays out:  observed_rows = 0  -> no evidence anyone can or does use it
 *
 * isNonstandard is reported alongside each entry as context, not as the
 * verdict.
 *
 * Read-only. Inserts nothing.
 *
 * Usage:
 *   node scripts\check_missing_move_legality.js
 */

const { Dex, toID } = require('@pkmn/dex');
const pool = require('../src/db/pool');
const { baseSpeciesFallback } = require('../src/utils/species_base_form');

/**
 * Read-only re-derivation of rebuild_pokemon_moves.js's drop list — same
 * walk (species -> learnset -> toID lookup against `moves`), but no writes.
 * This script inserts nothing anywhere; classification only.
 */
async function findDroppedMoveIds() {
  const movesResult = await pool.query('SELECT name FROM moves');
  const knownToIds = new Set(movesResult.rows.map((r) => toID(r.name)));

  const dropped = new Map();
  for (const species of Dex.species.all()) {
    if (!species.exists || species.isNonstandard) continue;
    let learnset = await Dex.learnsets.get(species.name);
    if (!learnset?.learnset) {
      const { base } = baseSpeciesFallback(species.name);
      if (base) learnset = await Dex.learnsets.get(base);
    }
    if (!learnset?.learnset) continue;
    for (const moveId of Object.keys(learnset.learnset)) {
      if (!knownToIds.has(moveId)) dropped.set(moveId, (dropped.get(moveId) || 0) + 1);
    }
  }
  return dropped;
}

(async () => {
  try {
    const dropped = await findDroppedMoveIds();
    const dexIds = [...dropped.keys()];

    // Observed move names in tournament_teams, normalised to toID for
    // comparison against the dex ids above (attacks may be display names,
    // toID-style strings, or typos — toID collapses the first two).
    const observedResult = await pool.query(`
      SELECT a.move_name AS move, COUNT(*)::int AS n
        FROM tournament_teams t,
             jsonb_array_elements(t.pokemon) p,
             jsonb_array_elements_text(p->'attacks') AS a(move_name)
       GROUP BY 1
    `);
    const observedByToId = new Map();
    for (const row of observedResult.rows) {
      const id = toID(row.move);
      observedByToId.set(id, (observedByToId.get(id) || 0) + row.n);
    }

    const observedBucket = []; // observed_rows > 0 -> real gap
    const unobservedBucket = []; // observed_rows = 0 -> stays out

    for (const dexId of dexIds) {
      const move = Dex.moves.get(dexId);
      const observedCount = observedByToId.get(dexId) || 0;
      const entry = {
        dexId,
        name: move.exists ? move.name : '(unresolvable)',
        isNonstandard: move.exists ? (move.isNonstandard || null) : 'N/A',
        learnsetDrops: dropped.get(dexId),
        observedInTournamentData: observedCount,
      };
      if (observedCount > 0) observedBucket.push(entry);
      else unobservedBucket.push(entry);
    }

    const fmt = (list) => list
      .sort((a, b) => b.observedInTournamentData - a.observedInTournamentData || b.learnsetDrops - a.learnsetDrops)
      .map((e) => `  ${e.name.padEnd(20)} dexId=${e.dexId.padEnd(16)} observed_rows=${String(e.observedInTournamentData).padStart(4)}  learnset_drops=${String(e.learnsetDrops).padStart(4)}  isNonstandard(context)=${e.isNonstandard}`)
      .join('\n');

    console.log(`Total dex move ids with no moves row: ${dexIds.length}\n`);

    console.log(`--- observed in tournament play (${observedBucket.length}) — real gaps, legal regardless of isNonstandard ---`);
    console.log(observedBucket.length ? fmt(observedBucket) : '  (none)');

    console.log(`\n--- no observations (${unobservedBucket.length}) — no evidence anyone can or does use it, stays out ---`);
    console.log(unobservedBucket.length ? fmt(unobservedBucket) : '  (none)');

    console.log('\n--- Return / Frustration specifically ---');
    for (const id of ['return', 'frustration']) {
      const move = Dex.moves.get(id);
      console.log(`  ${move.name}: isNonstandard=${move.isNonstandard || 'null (standard)'}  observed_in_tournament_data=${observedByToId.get(id) || 0}`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
