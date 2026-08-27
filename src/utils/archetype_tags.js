/**
 * Archetype definitions + per-team tagging — extracted from archetype_matchups.js
 * so archetype_swaps.js can derive the same archetype tags for a team without a
 * circular require (archetype_matchups.js already requires buildSwaps/teamValueOf
 * from archetype_swaps.js).
 *
 * ARCHETYPE MEMBERSHIP (per the format owner's definition)
 * -------------------------------------------------------
 *   Rain/Sun/Sand/Snow — the team contains a Pokemon that can SET that weather,
 *                        by ability (Drizzle/Drought/...) or by move (Rain
 *                        Dance/Sunny Day/...).
 *   Trick Room         — the team contains a Pokemon with Trick Room, UNLESS
 *                        that same Pokemon also carries Imprison. Imprison +
 *                        Trick Room on one Pokemon is anti-TR tech: it blocks
 *                        the opponent's TR rather than setting its own.
 *   Hyper Offense      — no weather tag and no TR tag, but the team has
 *                        Tailwind.
 *
 * A team can carry several tags at once (rain + sun, sun + TR, ...), so these
 * are tags, not an exclusive classification.
 */

const WEATHER_ABILITY = {
  drizzle: 'Rain', drought: 'Sun', 'sand stream': 'Sand', 'snow warning': 'Snow',
};
const WEATHER_MOVE = {
  'rain dance': 'Rain', 'sunny day': 'Sun', sandstorm: 'Sand',
  snowscape: 'Snow', hail: 'Snow',
};
const WEATHER_ARCHETYPE = { Rain: 'Rain team', Sun: 'Sun team', Sand: 'Sand team', Snow: 'Snow team' };
const TRICK_ROOM_ARCHETYPE = 'Trick Room team';
const HYPER_OFFENSE_ARCHETYPE = 'Hyper Offense';

const ALL_ARCHETYPES = [
  'Rain team', 'Sun team', 'Sand team', 'Snow team',
  TRICK_ROOM_ARCHETYPE, HYPER_OFFENSE_ARCHETYPE,
];

const lower = (s) => String(s || '').toLowerCase();

/** Tags for one tournament team's parsed Pokemon array. */
function tagsForTeam(mons) {
  const tags = new Set();
  let hasTrickRoomSetter = false;
  let hasTailwind = false;

  for (const mon of mons || []) {
    const attacks = (mon.attacks || []).map(lower);
    const attackSet = new Set(attacks);
    const ability = lower(mon.ability);

    const byAbility = WEATHER_ABILITY[ability];
    if (byAbility) tags.add(WEATHER_ARCHETYPE[byAbility]);
    for (const atk of attacks) {
      const byMove = WEATHER_MOVE[atk];
      if (byMove) tags.add(WEATHER_ARCHETYPE[byMove]);
    }

    // Imprison on the SAME Pokemon cancels it as a TR setter.
    if (attackSet.has('trick room') && !attackSet.has('imprison')) hasTrickRoomSetter = true;
    if (attackSet.has('tailwind')) hasTailwind = true;
  }

  if (hasTrickRoomSetter) tags.add(TRICK_ROOM_ARCHETYPE);
  // Hyper Offense is the residual: speed control without weather or TR.
  if (tags.size === 0 && hasTailwind) tags.add(HYPER_OFFENSE_ARCHETYPE);
  return tags;
}

module.exports = {
  WEATHER_ABILITY,
  WEATHER_MOVE,
  WEATHER_ARCHETYPE,
  TRICK_ROOM_ARCHETYPE,
  HYPER_OFFENSE_ARCHETYPE,
  ALL_ARCHETYPES,
  tagsForTeam,
};
