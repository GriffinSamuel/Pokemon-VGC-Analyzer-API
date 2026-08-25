#!/usr/bin/env node
/**
 * rebuild_pokemon_moves.js — repair pokemon_moves in place from @pkmn/dex,
 * without re-running the full seed (which also touches abilities/moves/pokemon).
 *
 * See HANDOFF_data_integrity.md / HANDOFF_data_integrity_step3.md. The
 * learnset-seeding step in seed.js compared @pkmn/dex's move IDs
 * ("rockslide") against `moves.name` (display form, "Rock Slide") via a bare
 * LOWER(), which only ever matched single-word move names — 296 of 389
 * observed tournament moves had zero pokemon_moves rows as a result. This
 * backfills the missing rows using the fixed matching logic in
 * src/db/seed_learnsets.js (now also used by seed.js itself, so a fresh seed
 * cannot reintroduce the gap). Purely additive — every insert is
 * ON CONFLICT DO NOTHING, nothing existing is touched or removed.
 *
 * Usage:
 *   node scripts\rebuild_pokemon_moves.js
 */

const pool = require('../src/db/pool');
const { seedLearnsets } = require('../src/db/seed_learnsets');

async function counts() {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS rows, COUNT(DISTINCT move_id)::int AS distinct_moves FROM pokemon_moves'
  );
  return r.rows[0];
}

(async () => {
  try {
    const before = await counts();
    console.log('--- before ---');
    console.log(`  pokemon_moves rows: ${before.rows}`);
    console.log(`  distinct moves:     ${before.distinct_moves}`);

    console.log('\nRebuilding from @pkmn/dex (this may take a minute)...\n');
    const { inserted, dropped } = await seedLearnsets(pool);

    const after = await counts();
    console.log('--- after ---');
    console.log(`  pokemon_moves rows: ${after.rows}  (+${after.rows - before.rows})`);
    console.log(`  distinct moves:     ${after.distinct_moves}  (+${after.distinct_moves - before.distinct_moves})`);
    console.log(`  (${inserted} insert/confirm calls issued this run — includes rows already present)`);

    if (dropped.size > 0) {
      const total = [...dropped.values()].reduce((a, b) => a + b, 0);
      console.log(`\n${total} learnset keys had no matching moves row, across ${dropped.size} distinct dex move ids:`);
      for (const [id, c] of [...dropped.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${id.padEnd(24)} x${c}`);
      }
    } else {
      console.log('\nNo dropped learnset keys — every key had a matching moves row.');
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
