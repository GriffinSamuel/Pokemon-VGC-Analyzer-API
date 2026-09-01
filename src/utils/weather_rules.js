/**
 * Shared "does weather change this number" predicate — the single source of
 * truth for whether a damage figure needs a weather tag. Previously lived only
 * in archetype_matchups.js (weatherChangesDamage/resolveTypeFor); moved here so
 * spread_scorer.js and team.js can call the SAME predicate instead of each
 * growing their own, narrower copy — the exact "two implementations of the
 * same question" shape this codebase keeps re-breaking on.
 */

const { WEATHER_ABILITY } = require('./archetype_tags');

const lower = (s) => String(s || '').toLowerCase();

const WEATHER_BALL_BY_WEATHER = { Rain: 'Water', Sun: 'Fire', Sand: 'Rock', Snow: 'Ice' };

/**
 * Weather Ball's real attacking type for a given user. A Pokemon that sets its
 * own weather always attacks under it (Pelipper's Drizzle makes its Weather Ball
 * Water); otherwise the field weather decides.
 */
function normalizeWeather(weather) {
  if (!weather) return null;
  const s = String(weather);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function resolveTypeFor(moveName, tableType, abilityOfUser, fieldWeather) {
  if (moveName !== 'Weather Ball') return tableType;
  const weather = WEATHER_ABILITY[lower(abilityOfUser)] || normalizeWeather(fieldWeather);
  return (weather && WEATHER_BALL_BY_WEATHER[weather]) || tableType;
}

const WEATHER_SENSITIVE_TYPE = new Set(['Water', 'Fire']);
const WEATHER_DERIVED_TYPE_MOVES = new Set(['weather ball', 'terrain pulse']);
// Solar Beam/Blade's base power is genuinely halved outside Sun (Rain, Sand,
// AND Snow — verified against the dex and nerd_of_now_calc.js's solarBeamBP())
// — a real second NUMBER. Kept separate from CHARGE_SKIPPED_IN_WEATHER below:
// that set answers a narrower, different question ("does the charge TURN
// change") which Electro Shot also belongs to despite its power never moving.
// Conflating the two was the root cause of a duplicated, numerically identical
// "in our Rain: 2HKO (67.9-81%)" line for Electro Shot — its power is fixed in
// every weather (confirmed: nerd_of_now_calc.js has no Electro Shot handling
// at all), so it must NOT trigger a second damage calc here.
const SOLAR_CHARGE_MOVES = new Set(['solar beam', 'solar blade']);
// Reliability-gated, not damage-gated: the displayed range doesn't move, only
// whether the hit lands. Callers that want to disclose this should append a
// short accuracy note rather than running a second (numerically identical)
// alt-weather damage calc — see accuracyNoteFor() below.
const ACCURACY_GATED_BY_WEATHER_MOVES = new Set(['thunder', 'hurricane', 'blizzard']);
// Moves with a genuine charge/no-charge-turn mechanic, keyed to the ONE
// weather that removes the charge turn. Solar Beam/Blade appear here too —
// they skip the charge turn in Sun on top of the separate BP halving above —
// but Electro Shot belongs ONLY here, not in SOLAR_CHARGE_MOVES: Rain removes
// its charge turn without changing its power at all (dex: "the move completes
// in one turn" — base power 130 unconditionally). This is a USABILITY fact,
// not a damage fact — see chargeTurnNoteFor(), which renders it as prose
// rather than a second (possibly identical) damage figure.
const CHARGE_SKIPPED_IN_WEATHER = { 'solar beam': 'Sun', 'solar blade': 'Sun', 'electro shot': 'Rain' };

/**
 * Can `weather` change the damage NUMBER for this specific attack? Takes the
 * move's resolved type (post-ability, e.g. Weather Ball already resolved to
 * Fire/Water/Rock/Ice), its category, and the defender's types.
 *
 * `items.attackerItem` / `items.defenderItem` — Utility Umbrella negates
 * weather's effect on its holder (both offensively and defensively; the real
 * calculator, nerd_of_now_calc.js, already models this). Without checking it
 * here, an Umbrella holder's weather-independent number would still get
 * tagged as weather-dependent, which is wrong for the same reason every other
 * bug in this file's history is wrong: answering a narrower question ("is this
 * move type generically weather-sensitive") than the one actually asked ("is
 * weather live for THIS Pokemon on THIS turn").
 *
 * Deliberately does NOT check for Swift Swim / Chlorophyll / Sand Rush /
 * Slush Rush on either side — those change who moves first, not how hard the
 * hit lands, and a damage-number tag is not the place to disclose a turn-
 * order fact. Also deliberately does NOT gate on accuracy — see
 * ACCURACY_GATED_BY_WEATHER_MOVES / accuracyNoteFor() for that.
 */
function weatherChangesDamage(moveName, moveType, moveCategory, defenderTypes, weather, items = {}) {
  if (!weather) return false;
  const { attackerItem, defenderItem } = items;
  if (lower(attackerItem) === 'utility umbrella' || lower(defenderItem) === 'utility umbrella') return false;
  const name = lower(moveName);
  if (WEATHER_DERIVED_TYPE_MOVES.has(name)) return true;
  if (SOLAR_CHARGE_MOVES.has(name)) return true;
  if (moveType && WEATHER_SENSITIVE_TYPE.has(moveType) && (weather === 'Rain' || weather === 'Sun')) return true;
  if (weather === 'Sand' && moveCategory === 'Special' && (defenderTypes || []).includes('Rock')) return true;
  if (weather === 'Snow' && moveCategory === 'Physical' && (defenderTypes || []).includes('Ice')) return true;
  return false;
}

/**
 * A short reliability note for accuracy-gated moves — Thunder/Hurricane never
 * miss in Rain (50% accuracy in Sun instead), Blizzard never misses in
 * Snow/Hail. Returns null when the move isn't accuracy-gated or the weather
 * doesn't touch its accuracy, so callers can append it only when it says
 * something.
 */
function accuracyNoteFor(moveName, weather) {
  const name = lower(moveName);
  if (!ACCURACY_GATED_BY_WEATHER_MOVES.has(name)) return null;
  if (name === 'blizzard') return weather === 'Snow' ? 'never misses in Snow' : null;
  if (weather === 'Rain') return 'never misses in Rain';
  if (weather === 'Sun') return '50% accuracy in Sun';
  return null;
}

/**
 * A short note describing what `weather` changes about USING this move — the
 * charge-turn mechanic — as distinct from weatherChangesDamage()'s question of
 * whether weather changes the move's damage NUMBER. Returns null for any move
 * without a charge/no-charge weather mechanic, so callers can append it only
 * when it says something (same convention as accuracyNoteFor()).
 *
 * Deliberately does NOT take a `weather` argument: unlike a damage figure,
 * this is a fact about the move itself (which weather removes its charge
 * turn), not about the specific board state, so it renders the same
 * regardless of what's currently live — matching the brief's target shape of
 * "Electro Shot (67.9-81%, ...) — charges a turn first; fires immediately in
 * Rain" even when Rain isn't this team's own primary weather.
 *
 * `items.attackerItem` — Utility Umbrella on the MOVE'S USER forces the
 * normal 2-turn charge even in the weather that would otherwise skip it; the
 * dex explicitly calls this out for both Solar Beam/Blade and Electro Shot.
 */
function chargeTurnNoteFor(moveName, items = {}) {
  const name = lower(moveName);
  const skipWeather = CHARGE_SKIPPED_IN_WEATHER[name];
  if (!skipWeather) return null;
  if (lower(items.attackerItem) === 'utility umbrella') {
    return `charges a turn first — Utility Umbrella keeps it charging even in ${skipWeather}`;
  }
  return `charges a turn first; fires immediately in ${skipWeather}`;
}

module.exports = {
  WEATHER_BALL_BY_WEATHER,
  normalizeWeather,
  resolveTypeFor,
  weatherChangesDamage,
  accuracyNoteFor,
  chargeTurnNoteFor,
  WEATHER_SENSITIVE_TYPE,
  WEATHER_DERIVED_TYPE_MOVES,
  SOLAR_CHARGE_MOVES,
  ACCURACY_GATED_BY_WEATHER_MOVES,
  CHARGE_SKIPPED_IN_WEATHER,
};
