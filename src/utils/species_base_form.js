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
 *
 * BUT `Dex.species.get(x).name !== x` is not always a safe normalisation.
 * Champions Reg M-B invented species names @pkmn/dex has never heard of
 * (Floette-Eternal-Mega is not a real dex entry) and the lookup fuzzy-matches
 * to the nearest thing it does know (Floette-Mega) WITHOUT saying so. Trusting
 * that resolution's `baseSpecies` answers "what is Floette-Mega's base"
 * (Floette) — a different, wrong question from the one asked, and Floette's
 * learnset genuinely lacks Light of Ruin, Eternal Flower Floette's signature
 * move. That is a silent mis-resolution, not a missing fallback, and it must
 * not be swallowed the way the old code swallowed it.
 */

const { Dex, toID } = require('@pkmn/dex');

/**
 * @param {string} speciesName - a name as stored in this project's `pokemon`
 *   table, which may not be a real @pkmn/dex entry.
 * @returns {{base: string|null, mismatch: boolean, resolvedTo: string|null}}
 *   `base` — the species name to retry under, or null if there is none safe
 *     to use (nothing to fall back to, dex doesn't know the name at all, OR
 *     the dex silently answered a different species — see `mismatch`).
 *   `mismatch` — true when Dex.species.get(speciesName) resolved to a
 *     DIFFERENT species than the one asked about (toID mismatch). `base` is
 *     always null when this is true: using that species' baseSpecies would
 *     be answering the wrong question, so callers get no fallback rather
 *     than a wrong one. `resolvedTo` names what the dex actually answered
 *     with, for diagnostics.
 */
function baseSpeciesFallback(speciesName) {
  const sp = Dex.species.get(speciesName);
  if (!sp?.exists) return { base: null, mismatch: false, resolvedTo: null };

  if (toID(sp.name) !== toID(speciesName)) {
    return { base: null, mismatch: true, resolvedTo: sp.name };
  }

  if (!sp.baseSpecies || toID(sp.baseSpecies) === toID(speciesName)) {
    return { base: null, mismatch: false, resolvedTo: sp.name };
  }
  return { base: sp.baseSpecies, mismatch: false, resolvedTo: sp.name };
}

module.exports = { baseSpeciesFallback };
