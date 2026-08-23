/**
 * Matchup-specific swap suggestions: moves, items, and Pokemon.
 *
 * Everything here is scoped to ONE archetype at a time — the whole point is
 * "what would I change to beat rain specifically", not general team advice.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE
 * --------------------------------------
 * 1. A proposed move must actually HIT HARDER than the move it replaces, against
 *    the same target. Super effective is not the goal; damage is. Thief is 2x on
 *    a Steel type and still does less than a resisted Weather Ball, and the
 *    first version happily suggested exactly that.
 * 2. A move is not just its damage. Weather Ball is this team's weather payoff,
 *    Tailwind is its speed control — cutting either to gain 5% on one threat is
 *    a downgrade the damage numbers alone cannot see.
 * 3. A Pokemon is not just its matchup contribution. Whimsicott brings Tailwind,
 *    Prankster Encore and redirection pressure; Pelipper brings the rain and
 *    Wide Guard. Dropping them "because they have no super effective move
 *    against rain" is the wrong answer even when the arithmetic says otherwise.
 *
 * COST MODEL
 * ----------
 * Item swaps re-run the full evolutionary spread search. The optimal spread for
 * (Pokemon, item) does NOT depend on the archetype — the optimizer scores
 * against the whole threat matrix — so each pair is computed once and reused
 * across all six archetypes.
 */

const pool = require('../db/pool');
const { effectivenessAgainst } = require('./typeChart');
const { getMostCommonSpread, getCommonItems, getSpeciesRow } = require('./ev_observations');
const { damagePercentRange } = require('./team_analyzer');
const { getOrComputeEvolutionarySpread } = require('./ev_optimizer');

const lower = (s) => String(s || '').toLowerCase();

// --- BOUNDS ------------------------------------------------------------------
const MAX_MOVE_SWAPS = 2;
const MAX_ITEM_SWAPS = 2;
const MAX_POKEMON_SWAPS = 2;
const ITEM_CANDIDATES_PER_MEMBER = 3;
const POKEMON_CANDIDATE_POOL = 40;
const LEARNSET_SHORTLIST = 15;   // candidates real-calced per member, by estimate
const MIN_DAMAGE_GAIN = 15;      // percentage points a replacement must add
const HEAVY_DAMAGE_PCT = 70;     // "this member is under real pressure here"

// Moves that are never coverage slots — cutting them loses the thing that makes
// the build work, regardless of what the damage numbers say.
const PROTECTED_MOVES = new Set([
  'protect', 'detect', 'spiky shield', 'wide guard', 'quick guard',
  'fake out', 'follow me', 'rage powder', 'tailwind', 'trick room',
  'encore', 'taunt', 'imprison', 'helping hand', 'sleep powder',
  'thunder wave', 'will-o-wisp', 'icy wind', 'electroweb',
]);

// Damaging moves that carry team-level utility beyond their damage.
const UTILITY_DAMAGING_MOVES = new Set(['weather ball', 'solar beam', 'solar blade']);

// NEVER suggested, under any circumstances. Two-turn and semi-invulnerable moves
// give the opponent a free turn to switch, set up, or simply KO the user before
// the move lands; raw base power makes them look attractive to a damage-ranking
// heuristic, which is exactly why this is a hard list and not a weighting.
const NEVER_SUGGEST = new Set([
  'dig', 'dive', 'fly', 'bounce', 'phantom force', 'shadow force',
  'sky attack', 'skull bash', 'razor wind', 'ice burn', 'freeze shock',
  'geomancy', 'meteor beam', 'electro shot', 'solar beam', 'solar blade',
  'sky drop', 'hyper beam', 'giga impact', 'blast burn', 'hydro cannon',
  'frenzy plant', 'rock wrecker', 'roar of time', 'prismatic laser',
  'eternabeam', 'last resort', 'explosion', 'self-destruct', 'misty explosion',
  'final gambit', 'memento', 'healing wish', 'lunar dance',
]);

const TEAM_UTILITY_MOVES = {
  tailwind: 'team Speed control',
  'trick room': 'Speed inversion',
  'wide guard': 'spread-move protection',
  'quick guard': 'priority protection',
  'follow me': 'redirection',
  'rage powder': 'redirection',
  'fake out': 'turn-one disruption',
  encore: 'lock-in disruption',
  taunt: 'status/setup denial',
  'icy wind': 'team Speed control',
  electroweb: 'team Speed control',
  'helping hand': 'damage amplification',
};
const WEATHER_ABILITIES = { drizzle: 'Rain', drought: 'Sun', 'sand stream': 'Sand', 'snow warning': 'Snow' };

// --- SHARED CACHES -----------------------------------------------------------
const learnsetCache = new Map();
const respreadCache = new Map();
const candidateProfileCache = new Map();

async function getLearnset(speciesName) {
  const key = lower(speciesName);
  if (learnsetCache.has(key)) return learnsetCache.get(key);
  const tryFetch = async (name) => {
    const { rows } = await pool.query(
      `SELECT m.name, m.type, m.category, m.power
         FROM moves m
         JOIN pokemon_moves pm ON pm.move_id = m.id
         JOIN pokemon p ON p.id = pm.pokemon_id
        WHERE LOWER(p.name) = $1 AND m.power > 0`,
      [name]
    );
    return rows;
  };
  let rows = await tryFetch(key);
  // Mega forms have no `pokemon` row (documented gap); a Mega's movepool is its
  // base form's.
  if (rows.length === 0 && key.includes('-mega')) rows = await tryFetch(key.replace(/-mega(-[xy])?$/, ''));
  learnsetCache.set(key, rows);
  return rows;
}

function isMegaBuild(member) {
  return /-mega/i.test(String(member.pokemonRow?.name || member.pokemon || ''))
    && /ite( [xy])?$/.test(lower(member.item));
}

// --- TEAM VALUE --------------------------------------------------------------

/**
 * What the TEAM loses if this member is removed — independent of any one
 * matchup. This is the counterweight to a purely matchup-driven drop
 * suggestion.
 */
function teamValueOf(member, team, synergies, coverageGapTypes) {
  const contributions = [];
  let score = 0;

  if (isMegaBuild(member)) {
    contributions.push('the team\'s only Mega slot');
    score += 100; // effectively undroppable
  }

  const weather = WEATHER_ABILITIES[lower(member.ability)];
  if (weather) {
    const others = team.filter((m) => m !== member && WEATHER_ABILITIES[lower(m.ability)] === weather);
    contributions.push(others.length === 0 ? `sole ${weather} setter` : `${weather} setter`);
    score += others.length === 0 ? 60 : 20;
  }

  for (const mv of member.moves || []) {
    const util = TEAM_UTILITY_MOVES[lower(mv.move)];
    if (!util) continue;
    const others = team.filter((m) => m !== member && (m.moves || []).some((x) => lower(x.move) === lower(mv.move)));
    contributions.push(others.length === 0 ? `only ${mv.move} (${util})` : `${mv.move} (${util})`);
    score += others.length === 0 ? 25 : 8;
  }

  // Unique attacking types — losing the team's only Fire move is a coverage hole.
  const myTypes = new Set((member.moves || []).filter((mv) => mv.power && mv.type).map((mv) => mv.type));
  const otherTypes = new Set();
  for (const m of team) {
    if (m === member) continue;
    for (const mv of m.moves || []) if (mv.power && mv.type) otherTypes.add(mv.type);
  }
  const uniqueTypes = [...myTypes].filter((t) => !otherTypes.has(t));
  if (uniqueTypes.length > 0) {
    contributions.push(`only source of ${uniqueTypes.join(', ')} coverage`);
    score += 15 * uniqueTypes.length;
  }

  const pairs = (synergies || []).filter((s) => s.pair?.length === 2 && s.pair.includes(member.pokemon));
  if (pairs.length > 0) {
    contributions.push(`${pairs.length} mechanical synergy pair${pairs.length === 1 ? '' : 's'}`);
    score += 12 * pairs.length;
  }

  if (contributions.length === 0) contributions.push('no unique team role beyond its own damage');
  return { score, contributions };
}

// --- 1. MOVE SWAPS -----------------------------------------------------------

async function threatDefenderSide(threat) {
  const row = await getSpeciesRow(lower(threat.pokemon)).catch(() => null);
  if (!row) return null;
  const spread = await getMostCommonSpread(lower(threat.pokemon)).catch(() => null);
  return {
    row,
    side: {
      nature: spread?.nature || 'Hardy',
      sp: spread?.sp || {},
      item: threat.item || '',
      ability: threat.ability || '',
      ivs: { hp: 31 },
    },
  };
}

function attackerSideOf(member) {
  return { nature: member.nature, item: member.item, ability: member.ability, sp: member.sp, ivs: { hp: 31 } };
}

function safeCalc(attackerRow, attackerSide, defRow, defSide, moveName, weather) {
  try {
    return damagePercentRange(attackerRow, attackerSide, defRow, defSide, moveName, weather);
  } catch (_err) {
    return null;
  }
}

async function buildMoveSwaps(team, threats, weather, teamValues) {
  const suggestions = [];

  // Resolve every threat's defensive side once.
  const defenders = [];
  for (const t of threats) {
    const d = await threatDefenderSide(t);
    if (d) defenders.push({ threat: t, ...d });
  }
  if (defenders.length === 0) return suggestions;

  for (const member of team) {
    const attackerSide = attackerSideOf(member);
    const known = new Set((member.moves || []).map((mv) => lower(mv.move)));

    // What each of our CURRENT moves already does to each threat. This is the
    // bar a replacement has to clear — the first version never computed it,
    // which is how "Weather Ball -> Thief" got suggested.
    const currentBest = new Map(); // threat name -> { max, move }
    for (const d of defenders) {
      // MINIMUM damage, not maximum. A comparison on max rolls says
      // "Iron Head is the least useful slot at 109.7%" while recommending a
      // replacement that does 44.6% — comparing a best case against a best case
      // to justify a swap you would make on the guaranteed number.
      let best = { min: -1, max: -1, move: null };
      for (const mv of (member.moves || []).slice(0, 4)) {
        if (!mv.power || !mv.type) continue;
        const dmg = safeCalc(member.pokemonRow, attackerSide, d.row, d.side, mv.move, weather);
        if (dmg && dmg.min > best.min) best = { min: dmg.min, max: dmg.max, move: mv.move };
      }
      currentBest.set(d.threat.pokemon, best);
    }

    // Cuttable moves: damaging, not protection/utility, not a utility-damaging
    // move like Weather Ball, and not the team's only source of its type.
    const teamOtherTypes = new Set();
    for (const m of team) {
      if (m === member) continue;
      for (const mv of m.moves || []) if (mv.power && mv.type) teamOtherTypes.add(mv.type);
    }
    const cuttable = (member.moves || []).filter((mv) => mv.power && mv.type
      && !PROTECTED_MOVES.has(lower(mv.move))
      && !UTILITY_DAMAGING_MOVES.has(lower(mv.move))
      && teamOtherTypes.has(mv.type));
    if (cuttable.length === 0) continue;

    // Cut the move that contributes least damage in THIS matchup.
    const cutScored = [];
    for (const mv of cuttable) {
      let bestHere = 0;
      for (const d of defenders) {
        const dmg = safeCalc(member.pokemonRow, attackerSide, d.row, d.side, mv.move, weather);
        if (dmg && dmg.min > bestHere) bestHere = dmg.min;
      }
      cutScored.push({ mv, bestHere });
    }
    cutScored.sort((a, b) => a.bestHere - b.bestHere);
    const cut = cutScored[0];

    // Candidate replacements: ALL damaging learnset moves, ranked by an estimate
    // (power x STAB x effectiveness), not filtered to super effective. The best
    // answer is often a high-power neutral move, which the old super-effective-
    // only filter could never surface.
    const learnset = await getLearnset(member.pokemonRow?.name || member.pokemon);
    if (learnset.length === 0) continue;
    const physical = (member.sp?.atk || 0) >= (member.sp?.spa || 0);
    const ourTypes = [member.pokemonRow?.type1, member.pokemonRow?.type2].filter(Boolean);

    const shortlist = learnset
      .filter((c) => !known.has(lower(c.name)))
      .filter((c) => !NEVER_SUGGEST.has(lower(c.name)))
      .filter((c) => (physical ? c.category === 'Physical' : c.category === 'Special'))
      .map((c) => {
        const stab = ourTypes.includes(c.type) ? 1.5 : 1;
        const bestEff = defenders.reduce((acc, d) => Math.max(acc, effectivenessAgainst(c.type, d.threat.types)), 0);
        return { c, estimate: (c.power || 0) * stab * bestEff };
      })
      .filter((x) => x.estimate > 0)
      .sort((a, b) => b.estimate - a.estimate)
      .slice(0, LEARNSET_SHORTLIST)
      .map((x) => x.c);

    let best = null;
    for (const cand of shortlist) {
      for (const d of defenders) {
        const dmg = safeCalc(member.pokemonRow, attackerSide, d.row, d.side, cand.name, weather);
        if (!dmg) continue;
        const baseline = currentBest.get(d.threat.pokemon) || { min: 0, max: 0, move: null };
        const gain = dmg.min - baseline.min;
        const newlyOhkos = dmg.min >= 100 && baseline.min < 100;
        // The rule: beat what we already have, by a margin that matters, or turn
        // a non-KO into a KO.
        if (!newlyOhkos && gain < MIN_DAMAGE_GAIN) continue;

        const entry = {
          pokemon: member.pokemon,
          drop: cut.mv.move,
          drop_damage: `${cut.bestHere}% guaranteed`,
          add: cand.name,
          move_type: cand.type,
          move_power: cand.power,
          target: d.threat.pokemon,
          target_usage: d.threat.usage,
          multiplier: effectivenessAgainst(cand.type, d.threat.types),
          damage_range: `${dmg.min}-${dmg.max}%`,
          damage_max: dmg.max,
          damage_min: dmg.min,
          gain,
          ohko: dmg.min >= 100,
          newly_ohkos: newlyOhkos,
          replaces_best: baseline.move,
          replaces_best_damage: baseline.min,
          reason: `${cand.name} does ${dmg.min}-${dmg.max}% to ${d.threat.pokemon}; the best this build currently guarantees is ${baseline.move || 'nothing'} at ${baseline.min}% (+${gain.toFixed(1)} points)${newlyOhkos ? ', converting it into an OHKO' : ''}. ${cut.mv.move} is the least useful slot here at ${cut.bestHere}% guaranteed.`,
        };
        if (!best || entry.gain > best.gain) best = entry;
      }
    }
    if (best) suggestions.push(best);
  }

  suggestions.sort((a, b) => (b.newly_ohkos === a.newly_ohkos ? 0 : b.newly_ohkos ? 1 : -1)
    || b.gain - a.gain
    || b.target_usage - a.target_usage);
  return suggestions.slice(0, MAX_MOVE_SWAPS);
}

// --- 2. ITEM SWAPS -----------------------------------------------------------

async function damageTakenBy(member, threats, sp, item, weather) {
  const hits = [];
  for (const threat of threats) {
    const d = await threatDefenderSide(threat);
    if (!d) continue;
    for (const moveName of threat.top_moves) {
      const dmg = safeCalc(d.row, d.side, member.pokemonRow,
        { nature: member.nature, sp, item, ability: member.ability, ivs: { hp: 31 } }, moveName, weather);
      if (!dmg) continue;
      hits.push({ threat: threat.pokemon, move: moveName, min: dmg.min, max: dmg.max, ohko: dmg.min >= 100 });
    }
  }
  return hits;
}

async function ohkoTargets(member, threats, sp, item, weather) {
  const out = new Set();
  for (const threat of threats) {
    const d = await threatDefenderSide(threat);
    if (!d) continue;
    for (const mv of (member.moves || []).slice(0, 4)) {
      if (!mv.power || !mv.type) continue;
      const dmg = safeCalc(member.pokemonRow,
        { nature: member.nature, item, ability: member.ability, sp, ivs: { hp: 31 } },
        d.row, d.side, mv.move, weather);
      if (dmg && dmg.min >= 100) out.add(`${threat.pokemon} (${mv.move})`);
    }
  }
  return out;
}

async function respreadFor(member, item, fieldOpts) {
  const key = `${lower(member.pokemon)}|${lower(item)}`;
  if (respreadCache.has(key)) return respreadCache.get(key);
  let sp = null;
  try {
    const evo = await getOrComputeEvolutionarySpread(member.pokemon, {
      item, nature: member.nature, teamBuild: true, fieldOpts,
    });
    sp = evo?.result?.spreads?.[0]?.sp || null;
  } catch (_err) { sp = null; }
  respreadCache.set(key, sp);
  return sp;
}

function formatSp(sp) {
  if (!sp) return 'unchanged (re-optimisation unavailable)';
  const labels = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
  return ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
    .filter((k) => (sp[k] || 0) > 0)
    .map((k) => `${sp[k]} ${labels[k]}`)
    .join(' / ');
}

/** Observed items, falling back to the base form for alternate/Mega forms. */
async function observedItemsFor(name) {
  let items = await getCommonItems(lower(name), 10).catch(() => []);
  if (items.length === 0 && lower(name).includes('-')) {
    items = await getCommonItems(lower(name).split('-')[0], 10).catch(() => []);
  }
  return items;
}

async function buildItemSwaps(team, threats, weather, fieldOpts) {
  const suggestions = [];
  const skipped = [];

  for (const member of team) {
    // A Mega's item IS its stone — swapping it un-Megas the Pokemon, so there is
    // no item decision to make. The first version did not exclude these, and
    // since the Mega was usually the only member being OHKO'd, the whole section
    // came out empty.
    if (isMegaBuild(member)) {
      skipped.push(`${member.pokemon} (Mega stone is mandatory)`);
      continue;
    }

    const currentHits = await damageTakenBy(member, threats, member.sp, member.item, weather);
    // Trigger on real pressure, not only on a guaranteed OHKO. A 2HKO from the
    // most common threat is exactly the case a resist berry is meant to fix.
    const pressured = currentHits.filter((h) => h.ohko || h.max >= HEAVY_DAMAGE_PCT);
    if (pressured.length === 0) continue;

    const observed = await observedItemsFor(member.pokemon);
    const candidates = observed
      .map((i) => i.item)
      .filter((i) => i && lower(i) !== lower(member.item))
      .slice(0, ITEM_CANDIDATES_PER_MEMBER);
    if (candidates.length === 0) {
      skipped.push(`${member.pokemon} (no observed alternative items)`);
      continue;
    }

    const currentKos = await ohkoTargets(member, threats, member.sp, member.item, weather);

    let best = null;
    for (const item of candidates) {
      const sp = await respreadFor(member, item, fieldOpts);
      const effectiveSp = sp || member.sp;
      const newHits = await damageTakenBy(member, threats, effectiveSp, item, weather);

      const improved = pressured.map((old) => {
        const after = newHits.find((n) => n.threat === old.threat && n.move === old.move);
        if (!after) return null;
        const survivesNow = old.ohko && !after.ohko;
        const drop = old.max - after.max;
        if (!survivesNow && drop < 5) return null;
        return { ...old, after, survivesNow, drop };
      }).filter(Boolean);
      if (improved.length === 0) continue;

      const newKos = await ohkoTargets(member, threats, effectiveSp, item, weather);
      const lostKos = [...currentKos].filter((k) => !newKos.has(k));

      const net = improved.filter((i) => i.survivesNow).length * 2
        + improved.length - lostKos.length * 2;
      const entry = {
        pokemon: member.pokemon,
        drop: member.item,
        add: item,
        net,
        new_spread: formatSp(sp),
        respread_ran: !!sp,
        now_survives: improved.map((i) => `${i.threat}'s ${i.move}: ${i.min}-${i.max}%${i.old_ohko ? ' OHKO' : ''} -> ${i.after.min}-${i.after.max}%${i.survivesNow ? ' (no longer an OHKO)' : ''}`),
        loses_ohko_on: lostKos,
      };
      if (!best || entry.net > best.net) best = entry;
    }
    if (best) suggestions.push(best);
  }

  suggestions.sort((a, b) => b.net - a.net);
  return { suggestions: suggestions.slice(0, MAX_ITEM_SWAPS), skipped };
}

// --- 3. POKEMON SWAPS --------------------------------------------------------

async function candidateProfile(name) {
  const key = lower(name);
  if (candidateProfileCache.has(key)) return candidateProfileCache.get(key);
  const row = await getSpeciesRow(key).catch(() => null);
  if (!row) { candidateProfileCache.set(key, null); return null; }
  const spread = await getMostCommonSpread(key).catch(() => null);
  const items = await getCommonItems(key, 1).catch(() => []);
  const profile = {
    name: row.name,
    row,
    types: [row.type1, row.type2].filter(Boolean),
    spread,
    item: items[0]?.item || '',
  };
  candidateProfileCache.set(key, profile);
  return profile;
}

function candidateMatchupScore(profile, threats) {
  if (!profile || threats.length === 0) return 0;
  let defensive = 0;
  let offensive = 0;
  for (const threat of threats) {
    for (const moveType of threat.move_types || []) {
      const eff = effectivenessAgainst(moveType, profile.types);
      if (eff === 0) defensive += 1;
      else if (eff < 1) defensive += 0.6;
      else if (eff >= 2) defensive -= 0.8;
    }
    for (const ourType of profile.types) {
      const eff = effectivenessAgainst(ourType, threat.types);
      if (eff >= 4) offensive += 1;
      else if (eff >= 2) offensive += 0.6;
    }
  }
  return (defensive + offensive) / Math.max(threats.length, 1);
}

/**
 * Drop candidates are ranked by (matchup contribution) MINUS (what the team
 * loses). A member can be useless against rain and still be undroppable because
 * it is the only Tailwind, the only Flying coverage and half the team's synergy
 * pairs — which is the case for Whimsicott, and why the first version's
 * "drop Whimsicott" was wrong.
 */
const TEAM_VALUE_FLOOR = 40;

async function buildPokemonSwaps(team, threats, weakestMembers, teamValues, archetype) {
  const { rows: usageRows } = await pool.query(
    'SELECT pokemon_name, usage_percent FROM usage_stats ORDER BY usage_percent DESC LIMIT $1',
    [POKEMON_CANDIDATE_POOL]
  ).catch(() => ({ rows: [] }));

  const onTeam = new Set(team.map((m) => lower(m.pokemon)));
  const scored = [];
  for (const r of usageRows) {
    if (onTeam.has(lower(r.pokemon_name))) continue;
    const profile = await candidateProfile(r.pokemon_name);
    if (!profile) continue;
    const score = candidateMatchupScore(profile, threats);
    if (score <= 0) continue;
    scored.push({ name: profile.name, types: profile.types, usage: parseFloat(r.usage_percent) / 100, score, item: profile.item });
  }
  scored.sort((a, b) => b.score - a.score || b.usage - a.usage);

  // Droppability = poor matchup contribution AND low irreplaceable team value.
  const droppable = weakestMembers
    .map((w) => {
      const tv = teamValues.get(w.pokemon) || { score: 0, contributions: [] };
      return { ...w, team_value: tv.score, contributions: tv.contributions, droppability: -w.total - tv.score / 100 };
    })
    .filter((w) => w.team_value < TEAM_VALUE_FLOOR)
    .sort((a, b) => b.droppability - a.droppability);

  const protectedMembers = weakestMembers
    .map((w) => ({ ...w, ...(teamValues.get(w.pokemon) || { score: 0, contributions: [] }) }))
    .filter((w) => w.score >= TEAM_VALUE_FLOOR)
    .map((w) => `${w.pokemon} (${w.contributions.join('; ')})`);

  const suggestions = [];
  for (let i = 0; i < Math.min(MAX_POKEMON_SWAPS, scored.length, droppable.length); i++) {
    const incoming = scored[i];
    const outgoing = droppable[i];
    suggestions.push({
      drop: outgoing.pokemon,
      add: incoming.name,
      add_types: incoming.types,
      add_usage: incoming.usage,
      add_item: incoming.item,
      loses: outgoing.contributions,
      reason: `${outgoing.pokemon} contributes least against ${archetype} (${outgoing.why}) and holds no irreplaceable team role; ${incoming.name} (${incoming.types.join('/')}) matches up better against ${threats.slice(0, 3).map((t) => t.pokemon).join(', ')}`,
    });
  }
  return { suggestions, pool_considered: usageRows.length, protected: protectedMembers };
}

// --- ENTRY POINT -------------------------------------------------------------

async function buildSwaps({ team, threats, archetype, weather, fieldOpts, weakestMembers, synergies }) {
  const enrichedThreats = [];
  for (const t of threats) {
    const moveTypes = [];
    for (const moveName of t.top_moves || []) {
      const { rows } = await pool.query('SELECT type, power FROM moves WHERE LOWER(name) = $1 LIMIT 1', [lower(moveName)])
        .catch(() => ({ rows: [] }));
      if (rows[0]?.power && rows[0]?.type) moveTypes.push(rows[0].type);
    }
    enrichedThreats.push({ ...t, move_types: moveTypes });
  }

  const teamValues = new Map();
  for (const m of team) teamValues.set(m.pokemon, teamValueOf(m, team, synergies));

  const moves = await buildMoveSwaps(team, enrichedThreats, weather, teamValues);
  const items = await buildItemSwaps(team, enrichedThreats, weather, fieldOpts);
  const pokemon = await buildPokemonSwaps(team, enrichedThreats, weakestMembers || [], teamValues, archetype);

  return {
    archetype,
    moves,
    items: items.suggestions,
    items_skipped: items.skipped,
    pokemon: pokemon.suggestions,
    pokemon_protected: pokemon.protected,
    team_values: [...teamValues.entries()].map(([pokemonName, v]) => ({ pokemon: pokemonName, ...v })),
    bounds: {
      max_move_swaps: MAX_MOVE_SWAPS,
      max_item_swaps: MAX_ITEM_SWAPS,
      max_pokemon_swaps: MAX_POKEMON_SWAPS,
      item_candidates_per_member: ITEM_CANDIDATES_PER_MEMBER,
      learnset_shortlist: LEARNSET_SHORTLIST,
      min_damage_gain: MIN_DAMAGE_GAIN,
      pokemon_pool_considered: pokemon.pool_considered,
    },
  };
}

module.exports = {
  buildSwaps,
  buildMoveSwaps,
  buildItemSwaps,
  buildPokemonSwaps,
  teamValueOf,
  getLearnset,
  MIN_DAMAGE_GAIN,
  TEAM_VALUE_FLOOR,
  NEVER_SUGGEST,
};
