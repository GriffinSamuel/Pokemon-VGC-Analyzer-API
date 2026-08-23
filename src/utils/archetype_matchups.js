/**
 * Archetype matchup analysis — live, data-derived replacement for the static
 * ARCHETYPES table in team_analyzer.js.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The old implementation carried a hand-written table: a fixed list of
 * `key_threats` per archetype and a single hardcoded `key_threat_speed`. That
 * speed was then printed against whichever key threat happened to be listed
 * first, which is how "Charizard-Mega-Y (~185 effective Speed)" reached the
 * output — 185 was written as a "Chlorophyll-boosted sweeper ballpark" (i.e.
 * Venusaur-Mega doubling in sun) and had nothing to do with Charizard, whose
 * ceiling under the SP system is floor((100 + 32 + 20) x 1.1) = 167.
 *
 * Nothing here is hardcoded per archetype except the archetype DEFINITIONS
 * themselves (what makes a team a rain team). Threat lists, speeds, damage and
 * counters are all computed from tournament_teams + the real calculator.
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

const pool = require('../db/pool');
const { effectivenessAgainst, resistancesOf } = require('./typeChart');
const { getMostCommonSpread, getCommonSpreads, getSpeciesRow } = require('./ev_observations');
const {
  damagePercentRange, effectiveSpeed, typesOf,
} = require('./team_analyzer');
const { buildSwaps } = require('./archetype_swaps');

// --- ARCHETYPE DEFINITIONS ---------------------------------------------------

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

// Roles that count as a sweeper. Support roles are explicitly excluded — a
// fast_support Whimsicott is not a win condition.
const SWEEPER_ROLES = new Set(['fast_offense', 'slow_bulky_offense']);

// Archetype-specific utility: what actually earns its slot in this matchup.
const UTILITY_MOVES = {
  [TRICK_ROOM_ARCHETYPE]: new Set(['taunt', 'imprison', 'encore', 'fake out', 'trick room']),
  [HYPER_OFFENSE_ARCHETYPE]: new Set(['fake out', 'sucker punch', 'aqua jet', 'bullet punch', 'extreme speed', 'ice shard', 'shadow sneak', 'quick guard', 'protect']),
};
const SPREAD_HEAVY_ARCHETYPES = new Set(['Sand team', 'Snow team', 'Hyper Offense']);

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

/**
 * Scan every tournament team once, tag it, and accumulate per-archetype member
 * usage plus each member's observed ability/item/move distributions.
 */
async function buildArchetypeMeta() {
  const { rows } = await pool.query('SELECT pokemon FROM tournament_teams');

  const meta = {};
  for (const name of ALL_ARCHETYPES) {
    meta[name] = { archetype: name, team_count: 0, members: new Map() };
  }

  for (const row of rows) {
    const mons = Array.isArray(row.pokemon) ? row.pokemon : [];
    if (mons.length === 0) continue;
    const tags = tagsForTeam(mons);
    if (tags.size === 0) continue;

    for (const tag of tags) {
      const bucket = meta[tag];
      if (!bucket) continue;
      bucket.team_count += 1;
      for (const mon of mons) {
        const displayName = mon.normalizedName || mon.name;
        if (!displayName) continue;
        const key = lower(displayName);
        let entry = bucket.members.get(key);
        if (!entry) {
          entry = { name: displayName, count: 0, abilities: new Map(), items: new Map(), moves: new Map() };
          bucket.members.set(key, entry);
        }
        entry.count += 1;
        if (mon.ability) entry.abilities.set(mon.ability, (entry.abilities.get(mon.ability) || 0) + 1);
        if (mon.item) entry.items.set(mon.item, (entry.items.get(mon.item) || 0) + 1);
        for (const atk of mon.attacks || []) {
          entry.moves.set(atk, (entry.moves.get(atk) || 0) + 1);
        }
      }
    }
  }

  const topOf = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // tournament_teams records the BASE form's ability for Mega Pokemon
  // (species_key() falls back), so Swampert-Mega came through as Torrent and
  // Charizard-Mega-Y as Blaze. A Mega's ability is fixed by the form, so the
  // pokemon table is authoritative and the scraped value is simply wrong.
  const megaAbility = new Map();
  for (const bucket of Object.values(meta)) {
    for (const entry of bucket.members.values()) {
      if (!/-mega/i.test(entry.name) || megaAbility.has(lower(entry.name))) continue;
      const row = await getSpeciesRow(lower(entry.name)).catch(() => null);
      megaAbility.set(lower(entry.name), row?.ability1 || null);
    }
  }
  for (const bucket of Object.values(meta)) {
    for (const entry of bucket.members.values()) {
      entry.usage = bucket.team_count > 0 ? entry.count / bucket.team_count : 0;
      entry.top_ability = megaAbility.get(lower(entry.name)) || topOf(entry.abilities);
      entry.top_item = topOf(entry.items);
      entry.top_moves = [...entry.moves.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([move, count]) => ({ move, frequency: entry.count > 0 ? count / entry.count : 0 }));
    }
  }
  return meta;
}

// --- OUR SIDE ----------------------------------------------------------------

/** A Mega build: the resolved species is a Mega form and the item is its stone. */
function isMegaBuild(member) {
  const speciesIsMega = /-mega/i.test(String(member.pokemonRow?.name || member.pokemon || ''));
  const item = lower(member.item);
  const holdsStone = /ite( [xy])?$/.test(item);
  return speciesIsMega && holdsStone;
}

function isSweeper(member) {
  return SWEEPER_ROLES.has(member.role);
}

/**
 * "Key" Pokemon on our side: the Mega (irreplaceable, one per team) plus any
 * sweeper. Support roles are deliberately not key — losing a Whimsicott hurts,
 * but it is not the win condition the opponent is playing to remove.
 */
function ourKeyPokemon(team) {
  const seen = new Set();
  const keys = [];
  for (const m of team) {
    if (!isMegaBuild(m) && !isSweeper(m)) continue;
    if (seen.has(m.pokemon)) continue;
    seen.add(m.pokemon);
    keys.push(m);
  }
  // Never return an empty key list — fall back to the highest raw offensive
  // stat so downstream sections always have something to reason about.
  if (keys.length === 0 && team.length > 0) {
    const best = [...team].sort((a, b) => {
      const av = Math.max(a.pokemonRow?.atk || 0, a.pokemonRow?.spa || 0);
      const bv = Math.max(b.pokemonRow?.atk || 0, b.pokemonRow?.spa || 0);
      return bv - av;
    })[0];
    keys.push(best);
  }
  return keys;
}

// --- DAMAGE PLUMBING ---------------------------------------------------------

const moveRowCache = new Map();
async function getMoveRowCached(moveName) {
  const key = lower(moveName);
  if (moveRowCache.has(key)) return moveRowCache.get(key);
  const { rows } = await pool.query('SELECT * FROM moves WHERE LOWER(name) = $1 LIMIT 1', [key]);
  const row = rows[0] || null;
  moveRowCache.set(key, row);
  return row;
}

const speciesCache = new Map();
async function getSpeciesCached(nameLower) {
  if (speciesCache.has(nameLower)) return speciesCache.get(nameLower);
  const row = await getSpeciesRow(nameLower).catch(() => null);
  speciesCache.set(nameLower, row);
  return row;
}

const spreadCache = new Map();
async function getSpreadCached(nameLower) {
  if (spreadCache.has(nameLower)) return spreadCache.get(nameLower);
  const spread = await getMostCommonSpread(nameLower).catch(() => null);
  spreadCache.set(nameLower, spread);
  return spread;
}

/** Weather this archetype plays under, if any. */
function archetypeWeather(archetype) {
  for (const [weather, name] of Object.entries(WEATHER_ARCHETYPE)) {
    if (name === archetype) return weather;
  }
  return null;
}

/** One damage result, or null when the move/species can't be resolved. */
async function calcThreatDamage(attackerEntry, moveName, defenderMember, weather) {
  // Accepts either shape for the same reason as calcOurDamage below.
  const attackerName = lower(attackerEntry.pokemon || attackerEntry.name);
  if (!attackerName) return null;
  const attackerRow = await getSpeciesCached(attackerName);
  if (!attackerRow) return null;
  const moveRow = await getMoveRowCached(moveName);
  if (!moveRow || !moveRow.power) return null;
  const spread = await getSpreadCached(attackerName);
  const attackerSide = {
    nature: spread?.nature || 'Hardy',
    sp: spread?.sp || {},
    item: attackerEntry.top_item || '',
    ability: attackerEntry.top_ability || '',
    ivs: { hp: 31 },
  };
  const defenderSide = {
    nature: defenderMember.nature,
    sp: defenderMember.sp,
    item: defenderMember.item,
    ability: defenderMember.ability,
    ivs: { hp: 31 },
  };
  try {
    const dmg = damagePercentRange(attackerRow, attackerSide, defenderMember.pokemonRow, defenderSide, moveName, weather);
    return { ...dmg, move: moveName, move_row: moveRow, attacker_row: attackerRow, attacker_side: attackerSide };
  } catch (_err) {
    return null;
  }
}

/**
 * Our member attacking a meta Pokemon.
 *
 * The defender is built from its REAL observed set: most common SP spread,
 * nature, item and ability. Leaving the item off (as the first version did)
 * silently calculates every target as itemless, which inflates our damage
 * against anything running Assault Vest, Eviolite or a resist berry — the exact
 * targets where knowing whether we OHKO actually matters.
 */
async function calcOurDamage(member, mv, targetEntry, weather) {
  // Threat objects from buildKeyThreats use `.pokemon`; raw meta entries from
  // buildArchetypeMeta use `.name`. This function was written against the second
  // shape and called with the first, so every lookup resolved "undefined",
  // returned null, and silently produced an empty Counters section.
  const targetName = lower(targetEntry.pokemon || targetEntry.name);
  if (!targetName) return null;
  const targetRow = await getSpeciesCached(targetName);
  if (!targetRow) return null;
  const spread = await getSpreadCached(targetName);
  const attackerSide = { nature: member.nature, item: member.item, ability: member.ability, sp: member.sp, ivs: { hp: 31 } };
  const targetSide = {
    nature: spread?.nature || 'Hardy',
    sp: spread?.sp || {},
    item: targetEntry.item || targetEntry.top_item || '',
    ability: targetEntry.ability || targetEntry.top_ability || '',
    ivs: { hp: 31 },
  };
  try {
    const dmg = damagePercentRange(member.pokemonRow, attackerSide, targetRow, targetSide, mv.move, weather);
    return { ...dmg, move: mv.move, target_row: targetRow, target_spread: spread, target_side: targetSide };
  } catch (_err) {
    return null;
  }
}

/** "32HP / 12Def / 0SpD, Modest @ Assault Vest" — how the defender was built. */
function describeDefender(spread, side) {
  const sp = spread?.sp || {};
  const parts = `${sp.hp || 0}HP / ${sp.def || 0}Def / ${sp.spd || 0}SpD, ${spread?.nature || 'Hardy'}`;
  const item = side?.item ? ` @ ${side.item}` : '';
  const ability = side?.ability ? ` (${side.ability})` : '';
  return `${parts}${item}${ability}`;
}

/**
 * Shared ordering rule for Counters and Resistances: hardest hit first, then by
 * how common the opposing Pokemon is. Damage decides which line matters most;
 * usage breaks ties toward the threat you will actually face.
 */
const WEATHER_BALL_BY_WEATHER = { Rain: 'Water', Sun: 'Fire', Sand: 'Rock', Snow: 'Ice' };

/**
 * Weather Ball's real attacking type for a given user. A Pokemon that sets its
 * own weather always attacks under it (Pelipper's Drizzle makes its Weather Ball
 * Water); otherwise the field weather decides. Without this the moves table's
 * static Normal leaks into the output — visible as
 * "Pelipper's Weather Ball (Normal, 0.5x)" against a Steel type.
 */
function resolveTypeFor(moveName, tableType, abilityOfUser, fieldWeather) {
  if (moveName !== 'Weather Ball') return tableType;
  const weather = WEATHER_ABILITY[lower(abilityOfUser)] || fieldWeather;
  return (weather && WEATHER_BALL_BY_WEATHER[weather]) || tableType;
}

/**
 * The weather THIS member plays under: its own weather ability if it has one
 * (Pelipper's Drizzle means Pelipper attacks in rain no matter what else is on
 * the field), otherwise a weather move it carries, otherwise the field default.
 *
 * A function of the same name lives in team_analyzer.js. This file previously
 * CALLED that one without importing it — a ReferenceError that node --check
 * cannot see, because it validates syntax and not bindings. Defined locally
 * rather than exported and shared, since the two files already keep their own
 * copies of WEATHER_ABILITY / WEATHER_MOVE and crossing that boundary for one
 * helper is what caused the mistake.
 */
function weatherForMember(member, fallbackWeather) {
  const byAbility = WEATHER_ABILITY[lower(member && member.ability)];
  if (byAbility) return byAbility;
  for (const mv of (member && member.moves) || []) {
    const byMove = WEATHER_MOVE[lower(mv.move)];
    if (byMove) return byMove;
  }
  return fallbackWeather || null;
}

// --- PLAUSIBLE WEATHERS -------------------------------------------------------
//
// A damage figure with no weather stated is not a fact, it is one of several.
// Solar Beam into Swampert-Mega is 81-97% in rain and an OHKO in sun, and both
// are live: they set rain, we set sun. Every calc is therefore reported under
// every weather that can realistically be up — theirs, plus each weather WE can
// set — and each line says which.
function plausibleWeathers(archetypeWeather, team) {
  const out = [];
  const seen = new Set();
  const push = (weather, source) => {
    const key = weather || 'none';
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ weather, source });
  };
  if (archetypeWeather) push(archetypeWeather, `their ${archetypeWeather}`);
  for (const m of team) {
    const w = WEATHER_ABILITY[lower(m.ability)];
    if (w) push(w, `our ${w} (${m.pokemon})`);
  }
  for (const m of team) {
    for (const mv of m.moves || []) {
      const w = WEATHER_MOVE[lower(mv.move)];
      if (w) push(w, `our ${w} (${m.pokemon}'s ${mv.move})`);
    }
  }
  if (out.length === 0) push(null, 'no weather');
  return out;
}

// --- SWEEPER CLASSIFICATION ---------------------------------------------------
//
// Judged on OBSERVED SP INVESTMENT, not base stats.
//
// Base stats said Sinistcha (121 base SpA), Grimmsnarl (120) and Farigiraf (110)
// were sweepers. In real play all three are Bold/Impish and put their SP into HP
// and defences — Sinistcha's most common spread is 32HP/14Def/20SpD with zero
// offensive investment. A high base stat nobody invests in is not a threat; what
// the sets actually do is.
const SWEEPER_MIN_OFFENSIVE_SP = 12;   // of 32, usage-weighted across observed sets
const SWEEPER_MIN_DAMAGING_MOVES = 2;
const SPEED_CONTROL_MOVES = new Set(['trick room', 'tailwind', 'icy wind', 'electroweb', 'thunder wave', 'string shot']);

async function offensiveInvestment(nameLower) {
  const data = await getCommonSpreads(nameLower).catch(() => null);
  if (!data || !data.spreads || data.spreads.length === 0) return null;
  let weighted = 0;
  let totalFreq = 0;
  for (const sp of data.spreads) {
    const invested = Math.max(sp.sp?.atk || 0, sp.sp?.spa || 0);
    weighted += invested * (sp.frequency || 0);
    totalFreq += sp.frequency || 0;
  }
  return totalFreq > 0 ? weighted / totalFreq : null;
}

// --- KO COVERAGE --------------------------------------------------------------
//
// "OHKOs it" against the single most common spread is a half-answer: the
// question in practice is how many of the sets you might actually face it beats,
// and which one breaks it. Walks every observed spread, not just the modal one.
async function koCoverage(member, mv, threat, weather) {
  const nameLower = lower(threat.pokemon);
  const data = await getCommonSpreads(nameLower).catch(() => null);
  const targetRow = await getSpeciesCached(nameLower);
  if (!data || !targetRow || data.spreads.length === 0) return null;

  const attackerSide = { nature: member.nature, item: member.item, ability: member.ability, sp: member.sp, ivs: { hp: 31 } };
  const bulk = (sp) => (sp.hp || 0) + Math.max(sp.def || 0, sp.spd || 0);

  let covered = 0;
  let totalFreq = 0;
  let worstBeaten = null;
  let firstSurvivor = null;

  for (const entry of data.spreads) {
    const side = {
      nature: entry.nature || 'Hardy',
      sp: entry.sp || {},
      item: threat.item || '',
      ability: threat.ability || '',
      ivs: { hp: 31 },
    };
    let dmg = null;
    try {
      dmg = damagePercentRange(member.pokemonRow, attackerSide, targetRow, side, mv.move, weather);
    } catch (_err) { continue; }
    if (!dmg) continue;
    totalFreq += entry.frequency || 0;
    const label = `${entry.sp?.hp || 0}HP/${entry.sp?.def || 0}Def/${entry.sp?.spd || 0}SpD ${entry.nature || 'Hardy'}`;
    if (dmg.min >= 100) {
      covered += entry.frequency || 0;
      if (!worstBeaten || bulk(entry.sp || {}) > worstBeaten.bulk) {
        worstBeaten = { label, bulk: bulk(entry.sp || {}), range: `${dmg.min}-${dmg.max}%` };
      }
    } else if (!firstSurvivor || bulk(entry.sp || {}) < firstSurvivor.bulk) {
      firstSurvivor = { label, bulk: bulk(entry.sp || {}), range: `${dmg.min}-${dmg.max}%` };
    }
  }

  if (totalFreq === 0) return null;
  return {
    covered_pct: covered / totalFreq,
    sets_seen: data.spreads.length,
    worst_beaten: worstBeaten,
    breaks_on: firstSurvivor,
  };
}

function byDamageThenUsage(a, b) {
  const ad = a.damage_max ?? -1;
  const bd = b.damage_max ?? -1;
  if (bd !== ad) return bd - ad;
  return (b.target_usage ?? 0) - (a.target_usage ?? 0);
}

// --- KEY THREATS -------------------------------------------------------------

const THREAT_POOL_SIZE = 14;
const MIN_ARCHETYPE_USAGE = 0.05;

/**
 * Key threats = the archetype's sweepers, plus anything that OHKOs or has a 4x
 * super effective move against one of OUR key Pokemon.
 */
async function buildKeyThreats(bucket, ourKeys, weather, weathers) {
  const candidates = [...bucket.members.values()]
    .filter((e) => e.usage >= MIN_ARCHETYPE_USAGE)
    .sort((a, b) => b.usage - a.usage)
    .slice(0, THREAT_POOL_SIZE);

  const threats = [];
  for (const entry of candidates) {
    const row = await getSpeciesCached(lower(entry.name));
    if (!row) continue;
    const entryTypes = [row.type1, row.type2].filter(Boolean);

    let damagingMoves = 0;
    const reasons = [];
    const ohkoLines = [];
    let quadOn = null;
    let bestSpeed = null;
    let speedControl = null;

    const spread = await getSpreadCached(lower(entry.name));
    bestSpeed = row.spe != null
      ? effectiveSpeed(
        { pokemonRow: row, final_stats: null, sp: spread?.sp || {}, nature: spread?.nature || 'Hardy', ability: entry.top_ability, item: entry.top_item },
        { setters: weather ? [{ weather }] : [] }
      )
      : null;

    for (const mvEntry of entry.top_moves) {
      if (SPEED_CONTROL_MOVES.has(lower(mvEntry.move)) && !speedControl) speedControl = mvEntry.move;
      const moveRow = await getMoveRowCached(mvEntry.move);
      if (!moveRow || !moveRow.power) continue;
      damagingMoves += 1;

      for (const key of ourKeys) {
        const eff = effectivenessAgainst(moveRow.type, typesOf(key.pokemonRow));
        if (eff >= 4 && !quadOn) {
          quadOn = { our: key.pokemon, move: mvEntry.move, type: moveRow.type, multiplier: eff };
        }
        // Every plausible weather, each labelled. The bare
        // "OHKOs Charizard-Mega-Y with Wave Crash (251.7-296.6%)" did not say
        // whether that was rain or sun, and the two are different numbers.
        for (const w of weathers) {
          const dmg = await calcThreatDamage(entry, mvEntry.move, key, w.weather);
          if (dmg && dmg.min >= 100) {
            ohkoLines.push(`OHKOs ${key.pokemon} with ${mvEntry.move} in ${w.source} (${dmg.min}-${dmg.max}%)`);
          }
        }
      }
    }

    // Sweeper by what the sets actually invest in, not by base stats.
    const investment = await offensiveInvestment(lower(entry.name));
    const sweeper = damagingMoves >= SWEEPER_MIN_DAMAGING_MOVES
      && investment != null && investment >= SWEEPER_MIN_OFFENSIVE_SP;

    for (const line of ohkoLines.slice(0, 4)) reasons.push(line);
    if (quadOn) reasons.push(`${quadOn.multiplier}x on ${quadOn.our} with ${quadOn.move} (${quadOn.type})`);
    if (sweeper && reasons.length === 0) {
      reasons.push(`sweeper — ${investment.toFixed(1)}/32 average SP into its attacking stat across observed sets`);
    }
    if (speedControl && !sweeper) {
      reasons.push(`speed control — runs ${speedControl}${investment != null ? ` (only ${investment.toFixed(1)}/32 offensive SP, not a sweeper)` : ''}`);
    }

    if (!sweeper && !speedControl && ohkoLines.length === 0 && !quadOn) continue;

    threats.push({
      pokemon: entry.name,
      types: entryTypes,
      usage: entry.usage,
      speed: bestSpeed,
      // Exposed so the reported speed can be checked against what the SP system
      // actually permits: floor((base + 32 + 20) x 1.1), doubled only by a
      // speed-doubling ability under its weather. The old hardcoded
      // key_threat_speed of 185 on Charizard-Mega-Y violated this — its ceiling
      // is 167 — and nothing in the output made that checkable.
      base_speed: row.spe ?? null,
      ability: entry.top_ability,
      item: entry.top_item,
      top_moves: entry.top_moves.map((m) => m.move),
      is_sweeper: sweeper,
      speed_control: speedControl,
      offensive_investment: investment,
      reasons,
    });
  }

  threats.sort((a, b) => b.usage - a.usage);
  return threats.slice(0, 6);
}

// --- RESISTANCES -------------------------------------------------------------

/**
 * Our members that resist a key threat's attacking moves, WITH the real damage
 * that resisted hit still does.
 *
 * "Resists it" on its own is not decision-grade information — a resisted hit
 * from a Choice Specs attacker can still be a 2HKO. Every entry here is a real
 * calc: the threat's most common damaging moves it actually runs, from its most
 * common SP spread, item and ability, against our member's real build.
 */
async function buildResistances(team, threats) {
  const out = [];
  for (const member of team) {
    const memberTypes = typesOf(member.pokemonRow);
    const resisted = [];

    for (const threat of threats) {
      for (const moveName of threat.top_moves) {
        const moveRow = await getMoveRowCached(moveName);
        if (!moveRow || !moveRow.power) continue;
        const realType = resolveTypeFor(moveName, moveRow.type, threat.ability, null);
        const eff = effectivenessAgainst(realType, memberTypes);
        if (eff >= 1) continue; // not resisted — belongs in the threat list, not here

        const entry = {
          target: threat.pokemon,
          target_usage: threat.usage,
          move: moveName,
          move_type: realType,
          multiplier: eff,
          damage_max: null,
          damage_range: null,
          attacker_build: null,
        };

        if (eff === 0) {
          entry.damage_max = 0;
          entry.damage_range = '0% (immune)';
          entry.attacker_build = `${threat.ability || 'no ability'}${threat.item ? ` @ ${threat.item}` : ''}`;
        } else {
          const dmg = await calcThreatDamage(
            { name: threat.pokemon, top_item: threat.item, top_ability: threat.ability },
            moveName, member, null
          );
          if (!dmg) continue;
          const spread = await getSpreadCached(lower(threat.pokemon));
          entry.damage_max = dmg.max;
          entry.damage_range = `${dmg.min}-${dmg.max}%`;
          entry.attacker_build = describeDefender(spread, { item: threat.item, ability: threat.ability });
        }
        resisted.push(entry);
      }
    }

    if (resisted.length === 0) continue;
    // Sorted most damage first, as specified. Note this puts the SHAKIEST
    // resist at the top — the resisted hit that still lands hardest.
    resisted.sort(byDamageThenUsage);
    out.push({ pokemon: member.pokemon, resists: resisted });
  }

  // Members whose worst resisted hit is biggest come first, same rule.
  out.sort((a, b) => byDamageThenUsage(a.resists[0], b.resists[0]));
  return out;
}

// --- COUNTERS ----------------------------------------------------------------

/**
 * Full damage calc for anything that OHKOs a key threat; a bare move + multiplier
 * for super effective coverage that does not OHKO.
 */
async function buildCounters(team, threats, weather, weathers) {
  const ohkos = [];
  const superEffective = [];
  // Counted, not swallowed. An empty Counters section is a legitimate result
  // AND the symptom of a resolution bug, and those two looked identical until
  // the .name/.pokemon mismatch made every calc return null.
  let calcFailures = 0;
  let calcAttempts = 0;

  for (const threat of threats) {
    const threatRow = await getSpeciesCached(lower(threat.pokemon));
    if (!threatRow) continue;
    const threatTypes = [threatRow.type1, threatRow.type2].filter(Boolean);
    const spread = await getSpreadCached(lower(threat.pokemon));

    for (const member of team) {
      for (const mv of (member.moves || []).slice(0, 4)) {
        if (!mv.power || !mv.type) continue;
        // ONE weather for both the label and the calculation. These were
        // separate: the label used the member's own weather (Charizard's
        // Drought -> Fire) while the calc used the archetype's weather, which is
        // null for Trick Room and Hyper Offense. Weather Ball was therefore
        // labelled "Fire" and calculated as Normal — and Normal is 0x into
        // Gholdengo and Sinistcha, which is why those lines read "0-0%".
        // One entry per plausible weather. A member that sets its own weather
        // overrides the field for its own attacks (Pelipper's Weather Ball is
        // Water under its own Drizzle regardless of what else is up).
        for (const w of weathers) {
          const memberWeather = weatherForMember(member, w.weather);
          const ourType = resolveTypeFor(mv.move, mv.type, member.ability, memberWeather);
          const eff = effectivenessAgainst(ourType, threatTypes);
          calcAttempts += 1;
          const dmg = await calcOurDamage(member, mv, threat, memberWeather);
          if (!dmg) { calcFailures += 1; continue; }

          const base = {
            pokemon: member.pokemon,
            move: mv.move,
            move_type: ourType,
            weather: memberWeather,
            weather_source: w.source,
            target: threat.pokemon,
            target_usage: threat.usage,
            multiplier: eff,
            damage_max: dmg.max,
            damage_range: `${dmg.min}-${dmg.max}%`,
            attacker_build: `${member.nature} ${member.item || 'no item'}${member.ability ? ` ${member.ability}` : ''}`,
            target_build: describeDefender(spread, dmg.target_side),
            // How common the spread this calc was actually run against is. A
            // damage range means something different against the spread 70% of
            // players run than against one 8% of them run, and every line
            // printed identically regardless until this was carried through.
            target_build_frequency: spread?.frequency ?? null,
            target_observations: spread?.total_observations ?? null,
          };

          if (dmg.min >= 100) {
            // How many of the sets we might actually face does this beat?
            base.coverage = await koCoverage(member, mv, threat, memberWeather);
            ohkos.push(base);
            continue;
          }
          if (eff >= 2) superEffective.push(base);
        }
      }
    }
  }

  // Collapse duplicates: if a move does the same damage in rain and in sun, one
  // line says so rather than three identical ones.
  const collapse = (list) => {
    const byKey = new Map();
    for (const e of list) {
      const key = `${e.pokemon}|${e.move}|${e.target}|${e.damage_range}|${e.move_type}`;
      if (!byKey.has(key)) { byKey.set(key, { ...e, weathers: [] }); }
      const kept = byKey.get(key);
      if (e.weather_source && !kept.weathers.includes(e.weather_source)) kept.weathers.push(e.weather_source);
    }
    return [...byKey.values()];
  };

  const collapsedOhkos = collapse(ohkos);
  const collapsedSe = collapse(superEffective);
  collapsedOhkos.sort(byDamageThenUsage);
  collapsedSe.sort(byDamageThenUsage);
  return {
    ohkos: collapsedOhkos,
    super_effective: collapsedSe,
    calc_attempts: calcAttempts,
    calc_failures: calcFailures,
  };
}

// --- WIN / LOSE CONDITIONS ---------------------------------------------------

function ourWeatherSetters(team) {
  return team.filter((m) => WEATHER_ABILITY[lower(m.ability)]
    || (m.moves || []).some((mv) => WEATHER_MOVE[lower(mv.move)]));
}

function hasMove(member, moveName) {
  return (member.moves || []).some((mv) => lower(mv.move) === moveName);
}

/**
 * Which weather an OHKO line assumes. Never print a damage figure unattributed
 * when more than one weather is plausible — the same move against the same
 * target is a different number in rain and in sun.
 */
function koWeatherTag(k) {
  if (k.weathers && k.weathers.length > 0) return `[${k.weathers.join(' / ')}]`;
  if (k.weather) return `[in ${k.weather}]`;
  return '[no weather]';
}

/**
 * How likely this OHKO actually is to happen, in the two senses that matter at
 * team-preview: how common the spread the calc was run against is, and how many
 * of the OTHER spreads that Pokemon is seen on the same move still beats.
 *
 * "Kowtow Cleave vs Basculegion — 126.7-151.3%" reads as a guaranteed KO. It is
 * guaranteed against ONE spread. If that spread is 18% of usage and the move
 * drops to 94% against the bulky one, the line is describing a coin flip. Both
 * numbers already existed (koCoverage ran for every OHKO and was rendered in
 * Counters); the Win Condition simply never surfaced them.
 */
function koLikelihoodNote(k) {
  const parts = [];

  if (k.target_build_frequency != null) {
    const obs = k.target_observations ? ` of ${k.target_observations} observed` : '';
    parts.push(`that exact spread is ${(k.target_build_frequency * 100).toFixed(0)}%${obs}`);
  }

  const c = k.coverage;
  if (c) {
    parts.push(`the move KOs ${(c.covered_pct * 100).toFixed(0)}% of the ${c.sets_seen} spread${c.sets_seen === 1 ? '' : 's'} seen on it`);
    if (c.breaks_on) {
      parts.push(`survives on ${c.breaks_on.label} (${c.breaks_on.range})`);
    } else if (c.covered_pct >= 1) {
      parts.push('no observed spread survives it');
    }
  } else {
    // Said out loud rather than left blank: "no sample" and "beats everything"
    // are opposite conclusions and must not render the same way.
    parts.push('no spread sample for this target — coverage across other spreads is unknown');
  }

  return parts.length > 0 ? `KO likelihood: ${parts.join('; ')}` : null;
}

/** One OHKO win-condition line, with its weather and its KO likelihood. */
function ohkoWinLine(label, k, targetName) {
  const note = koLikelihoodNote(k);
  const head = `${label}: ${k.pokemon}'s ${k.move} vs ${targetName} — ${k.damage_range} ${koWeatherTag(k)} (${k.target_build})`;
  return note ? `${head}\n${note}` : head;
}

async function buildConditions(archetype, team, threats, bucket, weather, counters) {
  const lose = [];
  const win = [];
  const weatherOfArchetype = archetypeWeather(archetype);

  if (weatherOfArchetype) {
    // --- weather archetypes ---
    const ourSetters = ourWeatherSetters(team);
    const ourWeathers = new Set(ourSetters.map((m) => WEATHER_ABILITY[lower(m.ability)]
      || (m.moves || []).map((mv) => WEATHER_MOVE[lower(mv.move)]).find(Boolean)).filter(Boolean));
    const sharesWeather = ourWeathers.has(weatherOfArchetype);

    // Every branch below MUST push a lose condition. The first version had no
    // else-branch for "we run this same weather", so any archetype whose weather
    // we also set (Sun and Rain, for a Drought + Drizzle team) printed an empty
    // Lose Condition — read as "nothing can go wrong here", which is the exact
    // opposite of a weather mirror, where losing the weather war is the game.
    if (ourSetters.length === 0) {
      lose.push(`No weather setter on this team — their ${weatherOfArchetype} goes up unopposed and stays up all game`);
    } else if (sharesWeather) {
      const ourMatching = ourSetters.filter((m) => (WEATHER_ABILITY[lower(m.ability)]
        || (m.moves || []).map((mv) => WEATHER_MOVE[lower(mv.move)]).find(Boolean)) === weatherOfArchetype);
      const theirSettersForLose = threats.filter((t) => WEATHER_ABILITY[lower(t.ability)] === weatherOfArchetype);
      // Weather mirror: the ability that activates LAST is the one that sticks,
      // so the slower setter wins the war. Being outsped here means our own
      // abusers spend the game under their identical weather with their side
      // holding the tempo.
      const outsped = ourMatching.filter((m) => {
        const ourSpeed = m.final_stats?.spe ?? m.pokemonRow.spe;
        return theirSettersForLose.some((t) => t.speed != null && t.speed < ourSpeed);
      });
      // Only a real problem if this is our LAST setter of that weather. With a
      // second setter (or a weather move) we simply re-set it, and being faster
      // costs nothing. The first version ignored backups entirely and called a
      // mirror lost on speed alone.
      const backups = ourMatching.filter((m) => !outsped.includes(m));
      const weatherMoveBackups = team.filter((m) => (m.moves || [])
        .some((mv) => WEATHER_MOVE[lower(mv.move)] === weatherOfArchetype));
      if (outsped.length > 0 && backups.length === 0 && weatherMoveBackups.length === 0) {
        lose.push(`Weather mirror — ${outsped.map((m) => m.pokemon).join(', ')} ${outsped.length === 1 ? 'is' : 'are'} FASTER than their setter, so our ${weatherOfArchetype} lands first and theirs overwrites it, and we have no second ${weatherOfArchetype} setter to re-establish it`);
      } else if (outsped.length > 0) {
        lose.push(`Losing the ${weatherOfArchetype} war only matters if ${[...backups, ...weatherMoveBackups].map((m) => m.pokemon).join('/')} is also removed — until then we can re-set it after their setter lands`);
      }
      const removable = ourMatching.filter((m) => threats.some((t) => t.reasons.some((r) => r.includes(m.pokemon))));
      for (const m of removable) {
        const killer = threats.find((t) => t.reasons.some((r) => r.includes(m.pokemon)));
        lose.push(`Losing ${m.pokemon} to ${killer.pokemon} — our ${weatherOfArchetype} stops coming back while theirs keeps re-setting`);
      }
      if (outsped.length === 0 && removable.length === 0) {
        lose.push(`Trading the weather war down — if ${ourMatching.map((m) => m.pokemon).join('/')} goes down first, their ${weatherOfArchetype} setter re-establishes it and the mirror flips against us`);
      }
    } else {
      const primary = ourSetters[0];
      const threatensSetter = threats.find((t) => t.reasons.some((r) => r.includes(primary.pokemon)));
      lose.push(threatensSetter
        ? `They remove ${primary.pokemon} (${threatensSetter.pokemon} ${threatensSetter.reasons[0]}), and with our only ${[...ourWeathers][0]} setter gone their ${weatherOfArchetype} is permanent`
        : `They OHKO ${primary.pokemon} before it can set ${[...ourWeathers][0]}, leaving their ${weatherOfArchetype} up for the rest of the game`);
    }

    // Win: kill their setter, win the weather war on speed, run a backup
    // setter, or simply share the weather.
    const theirSetters = threats.filter((t) => WEATHER_ABILITY[lower(t.ability)] === weatherOfArchetype);
    for (const setter of theirSetters) {
      const kills = counters.ohkos.filter((o) => o.target === setter.pokemon);
      for (const k of kills) {
        win.push(ohkoWinLine(`OHKO their ${weatherOfArchetype} setter`, k, setter.pokemon));
      }
      if (kills.length === 0) {
        win.push(`Remove ${setter.pokemon} (their ${weatherOfArchetype} setter) — no current member OHKOs it, so this needs chip or a double-up`);
      }
    }
    // Slower setter wins the weather war: the last ability to activate sticks.
    for (const setter of theirSetters) {
      const slower = ourSetters.filter((m) => {
        const ourSpeed = m.final_stats?.spe ?? m.pokemonRow.spe;
        return setter.speed != null && ourSpeed < setter.speed;
      });
      for (const m of slower) {
        win.push(`Win the weather war with ${m.pokemon} — slower than ${setter.pokemon} (${m.final_stats?.spe ?? m.pokemonRow.spe} vs ${setter.speed}), so our weather lands second and sticks`);
      }
    }
    const backupSetters = ourSetters.filter((m) => (m.moves || []).some((mv) => WEATHER_MOVE[lower(mv.move)]));
    for (const m of backupSetters) {
      const mv = (m.moves || []).find((x) => WEATHER_MOVE[lower(x.move)]);
      win.push(`Backup setter: ${m.pokemon}'s ${mv.move} re-sets weather after their setter is gone or ours is KO'd`);
    }
    if (sharesWeather) {
      win.push(`Shared weather — their ${weatherOfArchetype} powers our ${weatherOfArchetype} abusers too; let them set it and use it`);
    }
  } else if (archetype === TRICK_ROOM_ARCHETYPE) {
    lose.push('Trick Room goes up — every Speed number on this team inverts and their slow attackers move first for five turns');

    const trSetters = threats.filter((t) => t.top_moves.some((m) => lower(m) === 'trick room'));
    for (const setter of trSetters) {
      const kills = counters.ohkos.filter((o) => o.target === setter.pokemon);
      for (const k of kills) {
        win.push(ohkoWinLine('OHKO their TR setter', k, setter.pokemon));
      }
      if (kills.length === 0) {
        win.push(`${setter.pokemon} sets TR and no member OHKOs it — TR prevention has to come from disruption, not damage`);
      }
    }
    for (const member of team) {
      if (hasMove(member, 'taunt')) win.push(`${member.pokemon}'s Taunt blocks Trick Room outright`);
      if (hasMove(member, 'imprison') && hasMove(member, 'trick room')) win.push(`${member.pokemon} runs Imprison + Trick Room — they cannot set TR at all`);
      else if (hasMove(member, 'trick room')) win.push(`${member.pokemon} carries Trick Room — re-setting it flips their turn order back and hands the advantage to us`);
      if (hasMove(member, 'encore')) win.push(`${member.pokemon}'s Encore locks their setter out of a second Trick Room`);
      if (hasMove(member, 'fake out')) win.push(`${member.pokemon}'s Fake Out denies the setter its turn`);
    }
  } else {
    // Hyper Offense
    const keys = ourKeyPokemon(team).map((m) => m.pokemon);
    lose.push(`Losing ${keys.join(' or ')} — this team's damage comes from them, and hyper offense wins by removing them early`);
    const sweepers = threats.filter((t) => t.is_sweeper);
    for (const sweeper of sweepers) {
      const kills = counters.ohkos.filter((o) => o.target === sweeper.pokemon);
      for (const k of kills) {
        win.push(ohkoWinLine('OHKO their sweeper', k, sweeper.pokemon));
      }
    }
    if (win.length === 0 && sweepers.length > 0) {
      win.push(`No member OHKOs ${sweepers.map((s) => s.pokemon).join(' or ')} — this matchup has to be won on speed control and Protect turns, not trades`);
    }
  }

  // Backstop. A silently empty Lose Condition reads as "nothing can go wrong",
  // which is never true and is indistinguishable from a missing branch — that is
  // precisely how the weather-mirror gap above went unnoticed. If a future
  // archetype produces nothing, say so explicitly instead of printing blank.
  if (lose.length === 0) {
    lose.push(`No specific lose condition derived for ${archetype} — the general risk is losing ${ourKeyPokemon(team).map((m) => m.pokemon).join(' or ')} without trading for one of their key threats`);
  }
  return { lose_conditions: lose, win_conditions: win };
}

// --- BEST TEAM SET -----------------------------------------------------------
//
// Weights agreed with the format owner. Synergy dominates deliberately: a
// synergy pair pays off every turn both Pokemon are on the field, whereas a
// resistance or a super effective move only pays when that specific matchup
// occurs.
const WEIGHTS = {
  synergy: 0.35,
  offense: 0.20,
  defense: 0.20,
  speed: 0.125,
  utility: 0.125,
};
const BRING_COUNT = 4;

function offenseScore(member, threats, counters) {
  if (threats.length === 0) return 0;
  let total = 0;
  for (const threat of threats) {
    const ohko = counters.ohkos.some((o) => o.pokemon === member.pokemon && o.target === threat.pokemon);
    if (ohko) { total += 1.0; continue; }
    const se = counters.super_effective
      .filter((s) => s.pokemon === member.pokemon && s.target === threat.pokemon)
      .sort((a, b) => b.multiplier - a.multiplier)[0];
    if (se) { total += se.multiplier >= 4 ? 0.7 : 0.4; continue; }
    // Everything we have is resisted by this threat — a genuine negative.
    const anyMove = (member.moves || []).some((mv) => mv.power && mv.type);
    if (anyMove) {
      const best = Math.max(...(member.moves || [])
        .filter((mv) => mv.power && mv.type)
        .map((mv) => effectivenessAgainst(mv.type, threat.types)), 0);
      total += best < 1 ? -0.2 : 0;
    }
  }
  return total / threats.length;
}

async function defenseScore(member, threats, weather) {
  if (threats.length === 0) return 0;
  let survived = 0;
  let tested = 0;
  for (const threat of threats) {
    for (const moveName of threat.top_moves.slice(0, 2)) {
      const dmg = await calcThreatDamage({ name: threat.pokemon, top_item: threat.item, top_ability: threat.ability }, moveName, member, weather);
      if (!dmg) continue;
      tested += 1;
      if (dmg.min < 100) survived += 1;
    }
  }
  return tested === 0 ? 0 : survived / tested;
}

function speedScore(member, threats, archetype, weatherAnalysis) {
  if (threats.length === 0) return 0;
  const ours = effectiveSpeed(member, weatherAnalysis);
  const trickRoom = archetype === TRICK_ROOM_ARCHETYPE;
  let total = 0;
  let counted = 0;
  for (const threat of threats) {
    if (threat.speed == null) continue;
    counted += 1;
    if (ours === threat.speed) { total += 0.5; continue; }
    const faster = ours > threat.speed;
    // Under Trick Room the slower Pokemon acts first, so the sign flips.
    total += (trickRoom ? !faster : faster) ? 1 : 0;
  }
  return counted === 0 ? 0 : total / counted;
}

function utilityScore(member, archetype) {
  const moves = (member.moves || []).map((mv) => lower(mv.move));
  let score = 0;
  const weatherOfArchetype = archetypeWeather(archetype);
  if (weatherOfArchetype) {
    if (WEATHER_ABILITY[lower(member.ability)]) score += 1;
    if (moves.some((m) => WEATHER_MOVE[m])) score += 0.5;
  }
  const archetypeMoves = UTILITY_MOVES[archetype];
  if (archetypeMoves) {
    for (const m of moves) if (archetypeMoves.has(m)) score += 0.4;
  }
  if (SPREAD_HEAVY_ARCHETYPES.has(archetype) && moves.includes('wide guard')) score += 0.6;
  return Math.min(score, 1);
}

/** Mechanical synergy pairs contained entirely within a candidate subset. */
function synergyScore(subset, synergies) {
  if (!synergies || synergies.length === 0) return 0;
  const names = new Set(subset.map((m) => m.pokemon));
  let pairs = 0;
  for (const s of synergies) {
    if (s.pair.length === 2 && names.has(s.pair[0]) && names.has(s.pair[1])) pairs += 1;
  }
  // Normalised against the maximum possible pairs inside a set of this size.
  const maxPairs = (subset.length * (subset.length - 1)) / 2;
  return maxPairs === 0 ? 0 : Math.min(pairs / maxPairs, 1);
}

function combinations(items, k) {
  const out = [];
  const walk = (start, picked) => {
    if (picked.length === k) { out.push([...picked]); return; }
    for (let i = start; i < items.length; i++) {
      picked.push(items[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

/**
 * Exactly one Mega per set, chosen in its own bracket first (Megas compete only
 * with other Megas, since only one can be brought), then the remaining three
 * slots filled by whichever non-Mega trio maximises the weighted total
 * alongside that Mega.
 */
async function buildBestTeamSet(team, threats, counters, archetype, weatherAnalysis, synergies, weather) {
  const perMember = new Map();
  for (const member of team) {
    perMember.set(member.pokemon, {
      member,
      offense: offenseScore(member, threats, counters),
      defense: await defenseScore(member, threats, weather),
      speed: speedScore(member, threats, archetype, weatherAnalysis),
      utility: utilityScore(member, archetype),
    });
  }

  const soloScore = (name) => {
    const s = perMember.get(name);
    return WEIGHTS.offense * s.offense + WEIGHTS.defense * s.defense
      + WEIGHTS.speed * s.speed + WEIGHTS.utility * s.utility;
  };

  const megas = team.filter(isMegaBuild);
  const nonMegas = team.filter((m) => !isMegaBuild(m));

  let chosenMega = null;
  if (megas.length > 0) {
    chosenMega = [...megas].sort((a, b) => {
      // Megas are graded against each other on their own merits PLUS how well
      // they synergise with the rest of the roster.
      const aTotal = soloScore(a.pokemon) + WEIGHTS.synergy * synergyScore([a, ...team.filter((m) => m !== a)], synergies);
      const bTotal = soloScore(b.pokemon) + WEIGHTS.synergy * synergyScore([b, ...team.filter((m) => m !== b)], synergies);
      return bTotal - aTotal;
    })[0];
  }

  const fillSlots = chosenMega ? BRING_COUNT - 1 : BRING_COUNT;
  const pool = chosenMega ? nonMegas : team;
  if (pool.length < fillSlots) return null;

  let best = null;
  for (const trio of combinations(pool, fillSlots)) {
    const subset = chosenMega ? [chosenMega, ...trio] : trio;
    const mean = (fn) => subset.reduce((sum, m) => sum + fn(perMember.get(m.pokemon)), 0) / subset.length;
    const score = WEIGHTS.synergy * synergyScore(subset, synergies)
      + WEIGHTS.offense * mean((s) => s.offense)
      + WEIGHTS.defense * mean((s) => s.defense)
      + WEIGHTS.speed * mean((s) => s.speed)
      + WEIGHTS.utility * mean((s) => s.utility);
    if (!best || score > best.score) {
      best = {
        score,
        members: subset.map((m) => m.pokemon),
        mega: chosenMega ? chosenMega.pokemon : null,
        breakdown: {
          synergy: synergyScore(subset, synergies),
          offense: mean((s) => s.offense),
          defense: mean((s) => s.defense),
          speed: mean((s) => s.speed),
          utility: mean((s) => s.utility),
        },
      };
    }
  }
  // per_member is returned alongside so the swap analysis can identify who
  // contributes least in THIS matchup without recomputing every calc.
  if (best) best.per_member = perMember;
  return best;
}

/**
 * Our members ranked worst-first for this archetype, each with a short reason.
 * Feeds the "drop X, bring Y" side of Pokemon swaps.
 */
function weakestMembersFor(perMember) {
  if (!perMember) return [];
  return [...perMember.values()]
    .map((s) => {
      const total = WEIGHTS.offense * s.offense + WEIGHTS.defense * s.defense
        + WEIGHTS.speed * s.speed + WEIGHTS.utility * s.utility;
      const parts = [];
      if (s.offense <= 0) parts.push('no super effective answer to their key threats');
      if (s.defense < 0.5) parts.push('OHKO\'d by most of their common moves');
      if (s.speed === 0) parts.push('outsped by their whole threat list');
      if (parts.length === 0) parts.push('lowest weighted contribution here');
      return { pokemon: s.member.pokemon, total, why: parts.join(', ') };
    })
    .sort((a, b) => a.total - b.total);
}

// --- ENTRY POINT -------------------------------------------------------------

// Usage-weighted, threat-by-threat ledger.
//
// The previous rule counted a threat as "answered" if ANY member had any super
// effective move against it, then required only two resists. With six threats
// and six members that is satisfied essentially always, which is why every
// single archetype came out FAVORABLE — the rating carried no information.
//
// Three questions per threat, weighted by how often that threat actually
// appears in the archetype:
//   0.50  do we OHKO it
//   0.30  does at least one key Pokemon survive its best hit
//   0.20  do we outspeed it  (INVERTED under Trick Room)
const LEDGER_WEIGHTS = { ohko: 0.5, survive: 0.3, speed: 0.2 };
const FAVORABLE_AT = 0.6;
const UNFAVORABLE_BELOW = 0.3;

async function buildThreatLedger(team, ourKeys, threats, counters, archetype, weatherAnalysis, weather) {
  const trickRoom = archetype === TRICK_ROOM_ARCHETYPE;
  const ourSpeeds = team.map((m) => effectiveSpeed(m, weatherAnalysis));
  const fastest = Math.max(...ourSpeeds, 0);
  const slowest = Math.min(...ourSpeeds, Infinity);

  const rows = [];
  for (const threat of threats) {
    const ohko = counters.ohkos.some((o) => o.target === threat.pokemon);

    // Does anything we consider a win condition live through its best hit?
    let survives = false;
    let worstTaken = 0;
    for (const key of ourKeys) {
      let survivesThis = true;
      for (const moveName of threat.top_moves.slice(0, 3)) {
        const dmg = await calcThreatDamage(threat, moveName, key, weather);
        if (!dmg) continue;
        if (dmg.max > worstTaken) worstTaken = dmg.max;
        if (dmg.min >= 100) survivesThis = false;
      }
      if (survivesThis) { survives = true; break; }
    }

    let speedOk = false;
    if (threat.speed != null) {
      speedOk = trickRoom ? slowest < threat.speed : fastest > threat.speed;
    }

    const score = LEDGER_WEIGHTS.ohko * (ohko ? 1 : 0)
      + LEDGER_WEIGHTS.survive * (survives ? 1 : 0)
      + LEDGER_WEIGHTS.speed * (speedOk ? 1 : 0);

    rows.push({
      pokemon: threat.pokemon,
      usage: threat.usage,
      ohko,
      survives,
      speed_ok: speedOk,
      worst_damage_taken: worstTaken,
      score,
    });
  }

  const totalUsage = rows.reduce((sum, r) => sum + r.usage, 0);
  const weighted = totalUsage > 0
    ? rows.reduce((sum, r) => sum + r.usage * r.score, 0) / totalUsage
    : 0;

  const rating = weighted >= FAVORABLE_AT ? 'favorable'
    : weighted < UNFAVORABLE_BELOW ? 'unfavorable'
      : 'even';

  return { rating, weighted_score: weighted, rows };
}

async function analyzeArchetypeMatchupsLive(team, weatherAnalysis, synergies, legalPokemonSet, fieldOpts) {
  const meta = await buildArchetypeMeta();
  const ourKeys = ourKeyPokemon(team);
  const results = [];

  for (const archetype of ALL_ARCHETYPES) {
    const bucket = meta[archetype];
    if (!bucket || bucket.team_count === 0) continue;
    const weather = archetypeWeather(archetype);

    const weathers = plausibleWeathers(weather, team);
    const threats = await buildKeyThreats(bucket, ourKeys, weather, weathers);
    if (threats.length === 0) continue;

    const resistances = await buildResistances(team, threats);
    const counters = await buildCounters(team, threats, weather, weathers);
    const conditions = await buildConditions(archetype, team, threats, bucket, weather, counters);
    const bestSet = await buildBestTeamSet(team, threats, counters, archetype, weatherAnalysis, synergies, weather);

    let swaps = null;
    try {
      swaps = await buildSwaps({
        team,
        threats,
        archetype,
        weather,
        legalPokemonSet,
        fieldOpts,
        synergies,
        weakestMembers: weakestMembersFor(bestSet?.per_member),
      });
    } catch (err) {
      // Swaps are additive analysis — a failure here must not take the whole
      // matchup section down with it. Reported, not swallowed silently.
      swaps = { archetype, moves: [], items: [], pokemon: [], error: err.message };
    }

    const ledger = await buildThreatLedger(team, ourKeys, threats, counters, archetype, weatherAnalysis, weather);

    results.push({
      archetype,
      matchup_rating: ledger.rating,
      matchup_ledger: ledger,
      meta_team_count: bucket.team_count,
      our_key_pokemon: ourKeys.map((m) => m.pokemon),
      key_threats: threats,
      resistances,
      counters,
      ...conditions,
      possible_swaps: swaps,
      best_team_set: bestSet ? { ...bestSet, per_member: undefined } : null,
    });
  }

  return results;
}

module.exports = {
  analyzeArchetypeMatchupsLive,
  tagsForTeam,
  buildArchetypeMeta,
  ourKeyPokemon,
  isMegaBuild,
  // Exported for isolation tests only — pure string builders, no DB.
  koLikelihoodNote,
  ohkoWinLine,
  WEIGHTS,
  ALL_ARCHETYPES,
};
