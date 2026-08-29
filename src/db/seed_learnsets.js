/**
 * seed_learnsets.js — populate pokemon_moves from @pkmn/dex.
 *
 * Shared by src/db/seed.js (a fresh seed must not reintroduce this) and
 * scripts/rebuild_pokemon_moves.js (repairing an already-populated database
 * without re-running the full seed). One function, one bug fixed once.
 *
 * THE BUG THIS REPLACES: Dex.learnsets.get(species).learnset keys are dex
 * move IDs — lowercase, no spaces ("rockslide", "lightscreen") — not display
 * names ("Rock Slide", "Light Screen"). The old code compared them against
 * `moves.name` with a bare LOWER(), which only ever matches a move whose
 * display name happens to have no spaces (Endure, Facade, Protect, Rest,
 * Substitute — exactly the moves that were best-covered). Every multi-word
 * move — most of the competitively relevant movepool — silently failed the
 * comparison and was dropped by a bare `continue`.
 *
 * The fix is to compare on toID() on both sides via a single up-front Map,
 * and to never let a missed match disappear silently again.
 *
 * SECOND BUG THIS REPLACES: Dex.learnsets.get(species) is PER-FORM and does
 * NOT walk species.prevo. A real evolution keeps every level-up/egg/tutor
 * move its pre-evolution could legally learn (that's how the games work —
 * Showdown's own legality validator walks the prevo chain explicitly) but
 * @pkmn/dex's compiled learnset data does not merge that in automatically.
 * Confirmed live: Grimmsnarl's own dex learnset has Fake Out and Sucker
 * Punch (apparently assigned directly) but NOT Parting Shot, which exists
 * only on Impidimp's entry as a Gen 9 egg move ('9E') — a completely
 * standard Prankster Grimmsnarl set was unrepresentable in this table.
 * At full-dex scale: 395 species miss at least one prevo-inherited move,
 * 3151 (species,move) pairs total, 87 of which are moves actually observed
 * being played by that exact evolved species in tournament_teams (Kingambit
 * + Sucker Punch, Infernape + Fake Out, Corviknight + Roost, etc.).
 * Fixed by unioning each species' own learnset with the transitive union of
 * every species in its prevo chain, each resolved through the same
 * baseSpeciesFallback() used for the species' own form.
 */

const { Dex, toID } = require('@pkmn/dex');
const { baseSpeciesFallback } = require('../utils/species_base_form');

/**
 * Move-id set a species can draw on: its own dex learnset (falling back to
 * baseSpeciesFallback() for battle-only/alias forms, same as before) UNIONED
 * with the same for every species up its prevo chain, transitively.
 */
async function effectiveLearnsetIds(speciesName, cache) {
  if (cache.has(speciesName)) return cache.get(speciesName);

  const sp = Dex.species.get(speciesName);
  let learnset = await Dex.learnsets.get(sp.name);
  if (!learnset?.learnset) {
    const { base } = baseSpeciesFallback(sp.name);
    if (base) learnset = await Dex.learnsets.get(base);
  }
  const set = new Set(learnset?.learnset ? Object.keys(learnset.learnset) : []);

  if (sp.prevo) {
    const prevoSet = await effectiveLearnsetIds(sp.prevo, cache);
    for (const m of prevoSet) set.add(m);
  }

  cache.set(speciesName, set);
  return set;
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} client - anything
 *   with a .query() method; a bare pool is fine, this is purely additive
 *   (every insert is ON CONFLICT DO NOTHING).
 * @returns {Promise<{inserted: number, dropped: Map<string, number>}>}
 *   `dropped` is dex move id -> how many species' learnsets referenced it
 *   with no matching `moves` row. Report it; do not swallow it.
 */
// isNonstandard means "not obtainable in a fresh current-gen save" — it does
// NOT mean "illegal in this format" (Champions Regulation M-B is a homebrew
// format; a dex-flagged Past/Future species can still be real, played
// tournament content here). Aegislash ('Past') and Floette-Eternal-Mega
// ('Future', which itself only resolves via Dex.species.get()'s silent
// fuzzy-match to the unrelated Floette-Mega — see seed_learnsets test notes)
// were excluded from pokemon_moves regardless of real play. An isNonstandard
// species is now seeded IF it has been observed in tournament_teams; species
// with zero observed usage stay excluded exactly as before.
//
// Shared with seed.js's pokemon-table seeding step — that step had the exact
// same gate (`if (!species.exists || species.isNonstandard) continue;`,
// unfixed until now) as a SEPARATE copy, which is why Aegislash had no
// `pokemon` row at all even after this file's own gate was fixed: this
// file's fix only ever controlled `pokemon_moves`, never the species row
// seed.js's own query needed to exist first.
async function getObservedSpeciesIds(client) {
  const observedResult = await client.query(`
    SELECT DISTINCT COALESCE(p->>'normalizedName', p->>'name') AS species
    FROM tournament_teams, jsonb_array_elements(pokemon) AS p
  `);
  return new Set(observedResult.rows.map((row) => toID(row.species)));
}

async function seedLearnsets(client) {
  const movesResult = await client.query('SELECT id, name FROM moves');
  const moveIdByToId = new Map();
  for (const row of movesResult.rows) moveIdByToId.set(toID(row.name), row.id);

  const pokemonResult = await client.query('SELECT id, name FROM pokemon');
  const pokemonIdByName = new Map();
  for (const row of pokemonResult.rows) pokemonIdByName.set(row.name, row.id);

  const observedIds = await getObservedSpeciesIds(client);

  let inserted = 0;
  const dropped = new Map();
  const cache = new Map();

  for (const species of Dex.species.all()) {
    if (!species.exists) continue;
    if (species.isNonstandard && !observedIds.has(toID(species.name))) continue;

    const moveIds = await effectiveLearnsetIds(species.name, cache);
    if (moveIds.size === 0) continue;

    const pokemonId = pokemonIdByName.get(species.name);
    if (!pokemonId) continue;

    for (const moveId of moveIds) {
      const dbMoveId = moveIdByToId.get(moveId);
      if (!dbMoveId) {
        dropped.set(moveId, (dropped.get(moveId) || 0) + 1);
        continue;
      }
      await client.query(
        `INSERT INTO pokemon_moves (pokemon_id, move_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [pokemonId, dbMoveId]
      );
      inserted += 1;
    }
  }

  return { inserted, dropped };
}

module.exports = { seedLearnsets, getObservedSpeciesIds };
