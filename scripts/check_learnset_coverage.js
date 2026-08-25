#!/usr/bin/env node
/**
 * check_learnset_coverage.js — every move observed in real tournament play,
 * checked against the `moves` table (does the calculator know it at all) and
 * `pokemon_moves` (does any species' learnset point at it).
 *
 * Written for Defect A in HANDOFF_data_integrity.md: Light Screen and Aurora
 * Veil have zero pokemon_moves rows even though they're in `moves` with
 * correct category/type, which makes knowsMove() report a real Pokemon as
 * unable to learn a move it demonstrably ran in tournament play. This script
 * quantifies how far that gap extends before anything gets fixed.
 *
 * Usage:
 *   node scripts\check_learnset_coverage.js
 */

const pool = require('../src/db/pool');

const QUERY = `
WITH observed AS (
  SELECT a.move_name AS move, COUNT(*)::int AS observed_rows
    FROM tournament_teams t,
         jsonb_array_elements(t.pokemon) p,
         jsonb_array_elements_text(p->'attacks') AS a(move_name)
   GROUP BY 1
)
SELECT o.move,
       o.observed_rows,
       (SELECT COUNT(*)::int FROM moves m
         WHERE LOWER(m.name) = LOWER(o.move))                       AS in_moves_table,
       (SELECT COUNT(*)::int FROM moves m
          JOIN pokemon_moves pm ON pm.move_id = m.id
         WHERE LOWER(m.name) = LOWER(o.move))                       AS learnset_rows
  FROM observed o
 ORDER BY learnset_rows ASC, o.observed_rows DESC;
`;

(async () => {
  try {
    const { rows } = await pool.query(QUERY);

    const noMovesRow = rows.filter((r) => r.in_moves_table === 0);
    const noLearnset = rows.filter((r) => r.learnset_rows === 0);
    // "In moves table but zero learnset rows" is the Light Screen/Aurora Veil
    // class specifically — known to the calculator, unreachable by legality.
    const knownButUnlearnable = rows.filter((r) => r.in_moves_table > 0 && r.learnset_rows === 0);

    console.log(`--- observed moves: ${rows.length} distinct ---\n`);

    console.log(`unknown to the calculator entirely (in_moves_table = 0): ${noMovesRow.length}`);
    for (const r of noMovesRow) {
      console.log(`  ${r.move.padEnd(24)} observed_rows=${r.observed_rows}`);
    }

    console.log(`\nzero learnset coverage (learnset_rows = 0): ${noLearnset.length}`);
    console.log(`  of which known to \`moves\` but unlearnable by anyone: ${knownButUnlearnable.length}`);
    for (const r of knownButUnlearnable) {
      console.log(`  ${r.move.padEnd(24)} observed_rows=${r.observed_rows}`);
    }

    console.log(`\n--- full table, learnset_rows ASC then observed_rows DESC ---`);
    for (const r of rows) {
      console.log(`  ${r.move.padEnd(24)} observed=${String(r.observed_rows).padStart(5)}  in_moves=${r.in_moves_table}  learnset_rows=${r.learnset_rows}`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
