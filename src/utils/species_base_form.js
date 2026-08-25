/**
 * species_base_form.js — the one fallback mechanism for "this exact form has
 * no row of its own, try its base species instead."
 *
 * knowsMove() and getLearnset() in archetype_swaps.js each had their own copy
 * of this as a regex strip (`.replace(/-mega(-[xy])?$/, '')`), which only
 * ever covered Megas and silently did nothing for every other battle-only or
 * aliased form (Indeedee-M, Zacian-Crowned, etc.). @pkmn/dex already knows
 * the real relationship via `species.baseSpecies` — no reason to maintain a
 * second, narrower guess of the same fact.
 */

const { Dex } = require('@pkmn/dex');

const lower = (s) => String(s || '').toLowerCase();

/**
 * The base-species name to retry under, or null if `speciesName` doesn't
 * resolve or is already its own base species (nothing to fall back to).
 */
function baseSpeciesFallback(speciesName) {
  const sp = Dex.species.get(speciesName);
  if (!sp?.exists || !sp.baseSpecies) return null;
  if (lower(sp.baseSpecies) === lower(speciesName)) return null;
  return sp.baseSpecies;
}

module.exports = { baseSpeciesFallback };
