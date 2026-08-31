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
// Fixed base power, but usability itself is weather-gated (Sun/Rain removes
// the charge turn) — the number on the page is misleading without the tag
// even though the figure itself would be identical in any other weather.
const CHARGE_GATED_BY_WEATHER_MOVES = new Set(['solar beam', 'solar blade', 'electro shot']);
// Reliability-gated, not damage-gated: the displayed range doesn't move, only
// whether the hit lands. Callers that want to disclose this should append a
// short accuracy note rather than running a second (numerically identical)
// alt-weather damage calc — see accuracyNoteFor() below.
const ACCURACY_GATED_BY_WEATHER_MOVES = new Set(['thunder', 'hurricane', 'blizzard']);

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
  if (CHARGE_GATED_BY_WEATHER_MOVES.has(name)) return true;
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

module.exports = {
  WEATHER_BALL_BY_WEATHER,
  normalizeWeather,
  resolveTypeFor,
  weatherChangesDamage,
  accuracyNoteFor,
  WEATHER_SENSITIVE_TYPE,
  WEATHER_DERIVED_TYPE_MOVES,
  CHARGE_GATED_BY_WEATHER_MOVES,
  ACCURACY_GATED_BY_WEATHER_MOVES,
};
