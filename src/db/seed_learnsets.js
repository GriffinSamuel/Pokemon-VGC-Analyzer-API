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
 */

const { Dex, toID } = require('@pkmn/dex');
const { baseSpeciesFallback } = require('../utils/species_base_form');

/**
 * @param {import('pg').Pool | import('pg').PoolClient} client - anything
 *   with a .query() method; a bare pool is fine, this is purely additive
 *   (every insert is ON CONFLICT DO NOTHING).
 * @returns {Promise<{inserted: number, dropped: Map<string, number>}>}
 *   `dropped` is dex move id -> how many species' learnsets referenced it
 *   with no matching `moves` row. Report it; do not swallow it.
 */
async function seedLearnsets(client) {
  const movesResult = await client.query('SELECT id, name FROM moves');
  const moveIdByToId = new Map();
  for (const row of movesResult.rows) moveIdByToId.set(toID(row.name), row.id);

  const pokemonResult = await client.query('SELECT id, name FROM pokemon');
  const pokemonIdByName = new Map();
  for (const row of pokemonResult.rows) pokemonIdByName.set(row.name, row.id);

  let inserted = 0;
  const dropped = new Map();

  for (const species of Dex.species.all()) {
    if (!species.exists || species.isNonstandard) continue;

    let learnset = await Dex.learnsets.get(species.name);
    if (!learnset?.learnset) {
      // species.name is drawn straight from Dex.species.all(), so this is
      // always a genuine dex identity — no mismatch is possible here, unlike
      // the archetype_swaps.js callers which look up this project's own
      // (sometimes invented) species names.
      const { base } = baseSpeciesFallback(species.name);
      if (base) learnset = await Dex.learnsets.get(base);
    }
    if (!learnset?.learnset) continue;

    const pokemonId = pokemonIdByName.get(species.name);
    if (!pokemonId) continue;

    for (const moveId of Object.keys(learnset.learnset)) {
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

module.exports = { seedLearnsets };
