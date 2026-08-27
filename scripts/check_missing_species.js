// Measurement only — PHASE 1c. Reports species with no `pokemon` table row,
// from two angles: what's actually been observed in tournament_teams, and
// what the legal usage_stats swap pool (256 species) can't build a profile
// for. The second figure uses getSpeciesRow() from ev_observations.js — the
// same resolver candidateProfile() calls in archetype_swaps.js — so the
// count here matches the report's "N skipped for missing species data" line
// exactly, hyphen-stripping fallback included (see getSpeciesRow's comment).
const { toID } = require('@pkmn/dex');
const pool = require('../src/db/pool');
const { getSpeciesRow } = require('../src/utils/ev_observations');

async function main() {
  const obs = await pool.query(`
    SELECT COALESCE(p->>'normalizedName', p->>'name') AS species, COUNT(*) AS rows
    FROM tournament_teams, jsonb_array_elements(pokemon) AS p
    GROUP BY 1
  `);
  console.log('distinct species observed in tournament_teams:', obs.rows.length);

  const pokemonNames = await pool.query('SELECT name FROM pokemon');
  const pokemonIds = new Set(pokemonNames.rows.map((r) => toID(r.name)));
  const missingObserved = obs.rows
    .filter((r) => !pokemonIds.has(toID(r.species)))
    .map((r) => ({ species: r.species, rows: parseInt(r.rows, 10) }))
    .sort((a, b) => b.rows - a.rows);
  console.log(`observed species with NO pokemon table row (toID join): ${missingObserved.length}`);
  for (const m of missingObserved) console.log(`  ${m.species}\t${m.rows} rows`);

  const usage = await pool.query('SELECT DISTINCT pokemon_name FROM usage_stats ORDER BY pokemon_name');
  let misses = 0;
  const missList = [];
  for (const r of usage.rows) {
    const row = await getSpeciesRow(r.pokemon_name.toLowerCase()).catch(() => null);
    if (!row) { misses++; missList.push(r.pokemon_name); }
  }
  console.log(`\nusage_stats species (${usage.rows.length} total) with getSpeciesRow() miss: ${misses}`);
  console.log('(this is the exact figure/logic behind the "N skipped for missing species data" bounds line)');
  for (const name of missList) console.log(`  ${name}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
