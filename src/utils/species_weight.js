/**
 * species_weight.js — species weight in kg, for the weight-based moves.
 *
 * WHY THIS FILE EXISTS: the `pokemon` table has no weight column, so
 * `attacker.weight` / `defender.weight` were never populated by anything. That
 * is not a cosmetic gap. In nerd_of_now_calc.js the weight tables read:
 *
 *     if (defWeight === 0) return 120;   // Grass Knot
 *     if (defWeight === 0) return 120;   // Heavy Slam / Heat Crash
 *
 * A missing weight fell straight through to the CEILING of each table. Every
 * Grass Knot, Heavy Slam, Heat Crash and Low Kick in the product was reported
 * at maximum power against every target, including the light ones those moves
 * are weakest against. Over-reporting is the worse direction of error for a
 * tool whose whole output is "you survive this" or "you don't".
 *
 * @pkmn/dex already ships the weights and is already a dependency (typeChart.js
 * uses it), so this needs no schema change and no backfill.
 */

const { Dex } = require('@pkmn/dex');

// Species lookups are pure and hot (every weight move, every spread, every
// matchup), so memoise. Misses are cached too — a name the dex cannot resolve
// will not resolve on the second attempt either.
const cache = new Map();

/**
 * Weight in kilograms, or null when the species cannot be resolved.
 *
 * Returns null rather than 0 deliberately. 0 is a number the weight tables will
 * happily do arithmetic with; null forces every caller to decide what an
 * unknown weight means, which is what the old default-to-0 path failed to do.
 */
function weightOf(speciesName) {
  if (!speciesName) return null;
  const key = String(speciesName).toLowerCase();
  if (cache.has(key)) return cache.get(key);

  let weight = null;
  try {
    const species = Dex.species.get(speciesName);
    // `exists` guards the dex's habit of returning a hollow object for unknown
    // names rather than undefined.
    if (species && species.exists && typeof species.weightkg === 'number' && species.weightkg > 0) {
      weight = species.weightkg;
    }
  } catch (_err) {
    weight = null;
  }

  cache.set(key, weight);
  return weight;
}

module.exports = { weightOf };
