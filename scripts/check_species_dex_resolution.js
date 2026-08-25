#!/usr/bin/env node
/**
 * check_species_dex_resolution.js — for every row in `pokemon`, does
 * @pkmn/dex know this exact name, and if it resolves to something, is that
 * something the SAME species (toID match) or a silent substitution?
 *
 * Written after finding that Dex.species.get('Floette-Eternal-Mega') answers
 * with Floette-Mega (baseSpecies "Floette") without saying so — a Champions
 * Reg M-B invented species name the real dex has never heard of, fuzzy-
 * matched to the nearest thing it does know. baseSpeciesFallback() now
 * refuses to use a mismatched resolution (species_base_form.js), but that
 * only stops it from being used WRONGLY — it doesn't tell us how many other
 * `pokemon` rows are in the same position. This does.
 *
 * Read-only.
 *
 * Usage:
 *   node scripts\check_species_dex_resolution.js
 */

const { Dex, toID } = require('@pkmn/dex');
const pool = require('../src/db/pool');

(async () => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM pokemon ORDER BY name');
    console.log(`${rows.length} pokemon rows checked against @pkmn/dex.\n`);

    const unknown = [];
    const mismatch = [];

    for (const row of rows) {
      const sp = Dex.species.get(row.name);
      if (!sp?.exists) {
        unknown.push(row.name);
        continue;
      }
      if (toID(sp.name) !== toID(row.name)) {
        mismatch.push({ stored: row.name, resolvedTo: sp.name, baseSpecies: sp.baseSpecies });
      }
    }

    console.log(`--- unknown to @pkmn/dex entirely (${unknown.length}) ---`);
    for (const n of unknown) console.log(`  ${n}`);

    console.log(`\n--- resolves to a DIFFERENT species (${mismatch.length}) ---`);
    for (const m of mismatch) {
      console.log(`  ${m.stored.padEnd(28)} -> dex answers "${m.resolvedTo}" (baseSpecies: ${m.baseSpecies || '(none)'})`);
    }

    const clean = rows.length - unknown.length - mismatch.length;
    console.log(`\n${clean} of ${rows.length} rows resolve cleanly (dex knows the exact name, no substitution).`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
