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
const { getMostCommonSpread, getCommonSpreads, getCommonItems, getSpeciesRow } = require('./ev_observations');
const { damagePercentRange, effectiveSpeed, selfInflictedStatus } = require('./team_analyzer');
const { getOrComputeEvolutionarySpread } = require('./ev_optimizer');
const { RECOIL_MOVES } = require('./spread_scorer');
// Reached directly, not through team_analyzer's damagePercentRange, for ONE
// reason: damagePercentRange never forwards a `field` object to the calculator
// and has no way to express a -1 Attack stage. Screens, Friend Guard and
// Intimidate are therefore unreachable through it, and a swap argued on
// "brings Reflect" with no number attached is the note-instead-of-a-calc that
// this section is supposed to stop producing.
const { CalcDamage, getMoveData, buildStatsFromSP } = require('./nerd_of_now_calc');
const { calcStat, natureMultiplierFor } = require('./stat_formula');
const { baseSpeciesFallback } = require('./species_base_form');
const { round } = require('./format');

const lower = (s) => String(s || '').toLowerCase();

// --- BOUNDS ------------------------------------------------------------------
const MAX_MOVE_SWAPS = 2;
const MAX_ITEM_SWAPS = 2;
const MAX_POKEMON_SWAPS = 2;
const ITEM_CANDIDATES_PER_MEMBER = 3;
// No cap. This was 40 — a `LIMIT 40` on usage_stats ordered by usage, which the
// output then labelled "40 legal Pokemon considered". The format has 256. So 216
// legal Pokemon, 84% of Regulation M-B, were never considered as a swap in any
// archetype, and the label made that truncation read as a fact about the format
// rather than a bound we chose. `getLegalPokemonSet()` was already computing the
// real set and being passed all the way down here — buildSwaps just never
// destructured it, so it arrived and was dropped.
const POKEMON_CANDIDATE_POOL = null;
const LEARNSET_SHORTLIST = 15;   // candidates real-calced per member, by estimate
const MIN_DAMAGE_GAIN = 15;      // percentage points a replacement must add
const HEAVY_DAMAGE_PCT = 70;     // "this member is under real pressure here"

// Pokemon-swap enrichment bounds. Every one of these truncates something, so
// every one of them has a matching `*_truncated` count in the output. A capped
// list that renders identically to a complete one is the failure this project
// already shipped once as "40 legal Pokemon considered".
const POKEMON_REALCALC_SHORTLIST = 12; // type-scored candidates given a full real evaluation
const MAX_DELTA_LINES = 8;             // per delta list (gains/loses/survives/vulnerable)
const MAX_FIELD_RECOMPUTES = 12;       // before/after lines per field effect group
const MAX_BACKFILL_LOSSES = 6;         // irreplaceable losses searched per swap
const MAX_BACKFILL_RESULTS = 5;        // replacements reported per loss
const BACKFILL_VERIFY_LIMIT = 3;       // of those, re-verified on a fresh optimised spread
// A coverage backfill sharing a type with the lost move is not the same as
// covering anything — Umbreon's Snarl at 13.5-16.2% is not a Dark-coverage
// replacement just because it is Dark. This is the floor for "does something".
const COVERAGE_MEANINGFUL_MIN_PERCENT = 30;

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
const moveRowCache = new Map();
const investmentCache = new Map();
const candidateBuildCache = new Map();
const threatSpeedCache = new Map();
const knowsMoveCache = new Map();
const moveKnownAnywhereCache = new Map();

async function getMoveRow(moveName) {
  const key = lower(moveName);
  if (moveRowCache.has(key)) return moveRowCache.get(key);
  const { rows } = await pool.query(
    'SELECT name, type, category, power FROM moves WHERE LOWER(name) = $1 LIMIT 1', [key]
  ).catch(() => ({ rows: [] }));
  const row = rows[0] || null;
  moveRowCache.set(key, row);
  return row;
}

// --- COMPOSITION LADDER (PHASE 3) --------------------------------------------
//
// candidateProfile() used to pick item, ability, spread and moves via FOUR
// INDEPENDENT argmaxes over all observed rows of a species — and item came
// from a DIFFERENT table (ev_observations) than ability/moves (tournament_teams),
// so even the marginals weren't drawn from the same population. The result was
// frequently a Pokemon nobody ever brought (Venusaur: Life Orb from the
// aggressive build, Sleep Powder from the unrelated Focus Sash support build —
// see scripts/check_set_coherence.js, which flagged 38 of 129 species this way).
//
// Replaced with STAGED, CONDITIONAL composition over a single joint source
// (tournament_teams.pokemon[], the only place item/ability/nature/sp/moves and
// teammates/archetype all live on the same row): item -> moves (from rows
// running that item) -> ability, spread/nature (from rows matching both). The
// pool those rows are drawn from widens only as far as it needs to:
//   Level 1: rows of this species alongside a teammate also on the team being
//            analyzed
//   Level 2: rows of this species on the same archetype
//   Level 3: all observed rows of this species
// A level is used once it holds >= MIN_LEVEL_ROWS rows; if none do, Level 3 is
// used regardless of size (a threat must never be suppressed for thin data —
// see MIN_LEVEL_ROWS's comment).

const { tagsForTeam } = require('./archetype_tags');

// 8 rows, per the brief's explicit threshold rule. Checked live: with 129
// species swept, this is NOT "nearly everything falls to Level 3" — see the
// PHASE 3 commit message for the actual level-usage breakdown.
const MIN_LEVEL_ROWS = 8;

let allTeamsCache = null;
async function getAllTeamMonArrays() {
  if (allTeamsCache) return allTeamsCache;
  const { rows } = await pool.query('SELECT pokemon FROM tournament_teams');
  allTeamsCache = rows
    .map((r) => (Array.isArray(r.pokemon) ? r.pokemon : []))
    .filter((mons) => mons.length > 0);
  return allTeamsCache;
}

/**
 * Every observed occurrence of `nameLower` across tournament_teams, each
 * carrying its own item/ability/nature/sp/moves plus that occurrence's
 * teammates and archetype tags (derived from its whole team) — the single
 * joint source every stage of the ladder below draws from.
 */
const occurrenceCache = new Map();
async function observedOccurrences(nameLower) {
  if (occurrenceCache.has(nameLower)) return occurrenceCache.get(nameLower);
  const teams = await getAllTeamMonArrays();
  const occurrences = [];
  for (const mons of teams) {
    let matched = null;
    for (const mon of mons) {
      if (lower(mon.normalizedName || mon.name) === nameLower) { matched = mon; break; }
    }
    if (!matched) continue;
    const spTotal = matched.evs
      ? Object.values(matched.evs).reduce((sum, v) => sum + (v || 0), 0)
      : 0;
    occurrences.push({
      item: matched.item || null,
      ability: matched.ability || null,
      nature: matched.nature || null,
      // The scraped field is named `evs` but stores Champions SP (0-32/stat,
      // 66 total) directly — see CLAUDE.md's SP System section. Only trust it
      // as a real spread when it actually sums to something (many rows have
      // no spread data at all: 2928 of 10602 total pokemon rows, per PHASE 1c
      // investigation notes).
      sp: spTotal > 0 ? matched.evs : null,
      moves: matched.attacks || [],
      teammates: new Set(
        mons.filter((m) => m !== matched)
          .map((m) => lower(m.normalizedName || m.name))
          .filter(Boolean)
      ),
      archetypes: tagsForTeam(mons),
    });
  }
  occurrenceCache.set(nameLower, occurrences);
  return occurrences;
}

/** Rank-1 by count, or null if the pool has no non-null values for this key. */
function argmaxBy(items, keyFn) {
  const counts = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null || k === '') continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [k, c] of counts) {
    if (c > bestCount) { best = k; bestCount = c; }
  }
  return best;
}

function topMoveNames(items, n) {
  const counts = new Map();
  for (const it of items) {
    for (const mv of it.moves || []) counts.set(mv, (counts.get(mv) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([mv]) => mv);
}

/**
 * The single most common EXACT moveset among `items` — a joint pick, not four
 * independent per-move argmaxes. Marginal top-4-by-frequency can straddle two
 * mutually exclusive move slots (each individually more common than the move
 * that actually accompanies either of them), landing on a 4-move combination
 * nobody ran even after conditioning on item. Picking the whole moveset
 * together guarantees the result is one real row's exact loadout. Falls back
 * to the marginal top-4 only when no row in `items` has a usable moves array
 * (e.g. every row's attacks field was empty).
 */
function mostCommonMoveset(items, n) {
  const counts = new Map();
  for (const it of items) {
    const moves = it.moves || [];
    if (moves.length === 0) continue;
    const key = JSON.stringify([...moves].sort());
    if (!counts.has(key)) counts.set(key, { moves, count: 0 });
    counts.get(key).count += 1;
  }
  let best = null;
  let bestCount = 0;
  for (const v of counts.values()) {
    if (v.count > bestCount) { best = v.moves; bestCount = v.count; }
  }
  return best ? best.slice(0, n) : topMoveNames(items, n);
}

/**
 * Which level pool to compose from, per the threshold rule: use a level once
 * it holds >= MIN_LEVEL_ROWS; otherwise Level 3 regardless of size. NEVER
 * suppress a species for thin data — a threat vanishing from a matchup reads
 * as safety, the most dangerous way to be wrong.
 */
function selectLevel(occurrences, archetype, teamSpeciesSet) {
  if (teamSpeciesSet && teamSpeciesSet.size > 0) {
    const l1 = occurrences.filter((o) => [...o.teammates].some((t) => teamSpeciesSet.has(t)));
    if (l1.length >= MIN_LEVEL_ROWS) {
      return { level: 1, pool: l1, label: `from ${l1.length} observations alongside a shared teammate` };
    }
  }
  if (archetype) {
    const l2 = occurrences.filter((o) => o.archetypes.has(archetype));
    if (l2.length >= MIN_LEVEL_ROWS) {
      return { level: 2, pool: l2, label: `from ${l2.length} ${archetype} observations` };
    }
  }
  const tooFew = archetype ? ` — too few ${archetype} rows` : '';
  return { level: 3, pool: occurrences, label: `from all ${occurrences.length} observed${tooFew}` };
}

/**
 * The staged, conditional composition itself: item -> moves|ability (rows
 * running that item) -> nature/spread (rows matching item, then falling back
 * to any row of this species with spread data if the item-conditioned pool
 * has none — candidateBuild() already has its own evolutionary-search
 * fallback for a still-null spread, so this never blocks on missing SP data).
 */
async function composeFromLadder(nameLower, archetype, teamSpeciesSet) {
  const occurrences = await observedOccurrences(nameLower);
  if (occurrences.length === 0) return null;

  const { level, pool: levelPool, label } = selectLevel(occurrences, archetype, teamSpeciesSet);

  const item = argmaxBy(levelPool, (o) => o.item);
  const itemPool = item != null ? levelPool.filter((o) => o.item === item) : [];
  const conditionedPool = itemPool.length > 0 ? itemPool : levelPool;

  const moveNames = mostCommonMoveset(conditionedPool, 4);
  const moves = [];
  for (const mv of moveNames) {
    const row = await getMoveRow(mv);
    const count = conditionedPool.reduce((s, o) => s + ((o.moves || []).includes(mv) ? 1 : 0), 0);
    moves.push({
      move: row?.name || mv,
      type: row?.type || null,
      category: row?.category || null,
      power: row?.power || 0,
      frequency: conditionedPool.length > 0 ? count / conditionedPool.length : 0,
    });
  }

  const ability = argmaxBy(conditionedPool, (o) => o.ability);

  let spreadPool = conditionedPool.filter((o) => o.sp != null);
  if (spreadPool.length === 0) spreadPool = occurrences.filter((o) => o.sp != null);
  let spread = null;
  if (spreadPool.length > 0) {
    const spCounts = new Map();
    for (const o of spreadPool) {
      const k = JSON.stringify(o.sp) + '|' + (o.nature || '');
      if (!spCounts.has(k)) spCounts.set(k, { sp: o.sp, nature: o.nature, count: 0 });
      spCounts.get(k).count += 1;
    }
    const best = [...spCounts.values()].sort((a, b) => b.count - a.count)[0];
    spread = { sp: best.sp, nature: best.nature, observations: best.count, total_observations: spreadPool.length };
  }

  return {
    item,
    ability,
    moves,
    spread,
    provenance: { level, label, observation_count: levelPool.length, total_observed: occurrences.length },
  };
}

/**
 * Does ANY species have a pokemon_moves row for this move at all? Memoised
 * per move — one extra query, not one per species checked.
 *
 * This is what makes a missing row for one species meaningful. If the table
 * has never heard of the move (rebuilt from @pkmn/dex but still short 24
 * moves — see check_learnset_coverage.js), a missing row is a data gap, not
 * a legality answer, and must not be reported as one.
 */
async function moveKnownAnywhere(moveName) {
  const key = lower(moveName);
  if (moveKnownAnywhereCache.has(key)) return moveKnownAnywhereCache.get(key);
  const { rows } = await pool.query(
    `SELECT 1 FROM moves m JOIN pokemon_moves pm ON pm.move_id = m.id
      WHERE LOWER(m.name) = $1 LIMIT 1`,
    [key]
  ).catch(() => ({ rows: [] }));
  const known = rows.length > 0;
  moveKnownAnywhereCache.set(key, known);
  return known;
}

/**
 * Three-state legality, not a boolean:
 *   'legal'   — this species has a pokemon_moves row for this move.
 *   'illegal' — the move has rows for OTHER species but not this one. The
 *               table demonstrably knows this move and still excludes this
 *               species — a real denial.
 *   'unknown' — the move has zero pokemon_moves rows anywhere. We have no
 *               data. Callers must not treat this as a denial; it is exactly
 *               the false-negative that made the screens gate assert a
 *               Pokemon "cannot learn" a move it was observed running.
 */
async function knowsMove(speciesName, moveName) {
  const key = `${lower(speciesName)}|${lower(moveName)}`;
  if (knowsMoveCache.has(key)) return knowsMoveCache.get(key);
  const tryFetch = async (n) => {
    const { rows } = await pool.query(
      `SELECT 1
         FROM moves m
         JOIN pokemon_moves pm ON pm.move_id = m.id
         JOIN pokemon p ON p.id = pm.pokemon_id
        WHERE LOWER(p.name) = $1 AND LOWER(m.name) = $2
        LIMIT 1`,
      [n, lower(moveName)]
    ).catch(() => ({ rows: [] }));
    return rows.length > 0;
  };
  let found = await tryFetch(lower(speciesName));
  if (!found) {
    // A mismatch (the dex silently resolved to a different species than the
    // one asked about — see species_base_form.js) gets no fallback at all,
    // not a wrong one. That correctly leaves `found` false, which in turn
    // falls through to 'unknown' below rather than a false 'illegal' — the
    // three-state split is exactly what keeps this case honest.
    const { base } = baseSpeciesFallback(speciesName);
    if (base) found = await tryFetch(lower(base));
  }
  const verdict = found ? 'legal' : ((await moveKnownAnywhere(moveName)) ? 'illegal' : 'unknown');
  knowsMoveCache.set(key, verdict);
  return verdict;
}

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
  // Battle-only/alias forms (Megas, and others) have no `pokemon` row of
  // their own (documented gap); their movepool is their base species' —
  // but only when the dex actually resolved THIS species, not a different
  // one it silently substituted (mismatch; see species_base_form.js).
  if (rows.length === 0) {
    const { base } = baseSpeciesFallback(speciesName);
    if (base) rows = await tryFetch(lower(base));
  }
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

// --- FIELD-AWARE CALCULATION -------------------------------------------------

function baseStatsOf(row) {
  return { hp: row.hp, atk: row.atk, def: row.def, spa: row.spa, spd: row.spd, spe: row.spe };
}

/**
 * damagePercentRange, plus the field state it cannot express.
 *
 * Argument construction is deliberately identical to team_analyzer.js's
 * damagePercentRange so that a `field: null` call here and a damagePercentRange
 * call there are the same calculation — the before/after pairs in the field
 * section are both produced by THIS function precisely so that "before" is never
 * a differently-built number being compared against "after".
 *
 * `field` accepts { isReflect, isLightScreen, isAuroraVeil }; Friend Guard rides
 * on defenderSide.isFriendGuard, which is where CalcDamage reads it.
 */
function calcWithField(attackerRow, attackerSide, defenderRow, defenderSide, moveName, weather, field) {
  try {
    const moveData = getMoveData(moveName);
    const result = CalcDamage({
      attacker: {
        name: attackerRow.name,
        nature: attackerSide.nature || 'Hardy',
        sp: attackerSide.sp || {},
        item: attackerSide.item || '',
        ability: attackerSide.ability || attackerRow.ability || '',
        baseStats: baseStatsOf(attackerRow),
        types: [attackerRow.type1, attackerRow.type2].filter(Boolean),
        side: attackerSide.faintedCount != null ? { faintedCount: attackerSide.faintedCount } : undefined,
        timesHit: attackerSide.timesHit,
        hpFraction: attackerSide.hpFraction,
        status: attackerSide.status || '',
        consecutiveUses: attackerSide.consecutiveUses,
      },
      defender: {
        name: defenderRow.name,
        nature: defenderSide.nature || 'Hardy',
        sp: defenderSide.sp || {},
        item: defenderSide.item || '',
        ability: defenderSide.ability || defenderRow.ability || '',
        baseStats: baseStatsOf(defenderRow),
        types: [defenderRow.type1, defenderRow.type2].filter(Boolean),
        hpFraction: defenderSide.hpFraction,
        status: defenderSide.status || '',
        isFriendGuard: defenderSide.isFriendGuard === true,
      },
      move: moveData,
      isDouble: true,
      weather: weather || null,
      field: field || undefined,
    });
    return {
      min: round(result.minPercent, 1),
      max: round(result.maxPercent, 1),
      bp_unresolved: result.bp_unresolved === true,
      base_power_used: result.base_power_used,
    };
  } catch (_err) {
    return null;
  }
}

/**
 * The same attacker with Intimidate's -1 Attack stage already applied to its
 * FINAL Attack stat, expressed as a species row the calculator will rebuild that
 * exact stat from.
 *
 * This detour exists because CalcDamage copies `boosts` through but only ever
 * reads it for Stored Power and Punishment's base power — it is NOT applied to
 * the attacking stat (nerd_of_now_calc.js:990 reads attacker.stats.atk raw).
 * Passing boosts:{atk:-1} therefore looks correct and changes nothing, which is
 * exactly the class of silent no-op that file's own comment warns about.
 *
 * -1 is floor(atk * 2/3) on the stat, so the target stat is known exactly; the
 * search finds a (base Attack, nature) pair that reproduces it and VERIFIES the
 * result against the calculator's own stat builder — Attack hit exactly, Speed
 * unchanged, so Gyro Ball and Electro Ball are unaffected — before returning.
 *
 * A substitute nature is searched only because an Attack-boosting nature's
 * floor() genuinely skips some target values (measured: ~1.3% of base-Attack x
 * SP x nature combinations are unreachable while holding the nature fixed).
 * Swapping it is safe here and only here: this path runs for PHYSICAL moves
 * only, and for a physical move the calculator reads exactly two attacker stats
 * — Attack and Speed — both of which the verification pins. Returns null if
 * nothing verifies, and the caller then reports Intimidate as unmodelled rather
 * than printing an approximation.
 */
const ALL_NATURES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed',
  'Impish', 'Lax', 'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest',
  'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
];

function intimidatedAttackerRow(attackerRow, attackerSide) {
  const base = baseStatsOf(attackerRow);
  if (base.atk == null || base.spe == null) return null;
  const sp = attackerSide.sp || {};
  const realNature = attackerSide.nature || 'Hardy';
  const real = buildStatsFromSP(base, sp, realNature);
  const target = Math.floor(real.atk * 2 / 3);
  const spAtk = sp.atk || sp.at || 0;
  // The nature multiplier is between 0.9x and 1.1x, so the base value that lands
  // on `target` is inside this window; scanned rather than solved so the search
  // never has to assume which nature table the calculator is using.
  const from = Math.floor(target / 1.1) - 20 - spAtk - 2;
  const to = Math.ceil(target / 0.9) - 20 - spAtk + 2;
  for (const nature of [realNature, ...ALL_NATURES]) {
    for (let b = from; b <= to; b++) {
      const probe = buildStatsFromSP({ ...base, atk: b }, sp, nature);
      if (probe.atk === target && probe.spe === real.spe) {
        return {
          row: { ...attackerRow, atk: b },
          nature,
          nature_substituted: nature !== realNature,
          before_atk: real.atk,
          after_atk: target,
        };
      }
    }
  }
  return null;
}

// --- DERIVED ROLE VOCABULARY -------------------------------------------------
//
// A role is DERIVED, never per-species. The rule this enforces: a high BASE stat
// must never imply a role. Sinistcha (121 base SpA) and Grimmsnarl (120) were
// both classed as sweepers on base stats alone while every real set of either is
// Bold/Impish with zero offensive investment. Only what the observed sets
// actually invest in, and actually carry, is allowed to decide.
//
// The offensive thresholds are archetype_matchups.js's own sweeper test, not new
// ones, and observedInvestment()'s offensive half is its offensiveInvestment()
// verbatim. They are re-declared here rather than imported because
// archetype_matchups.js requires THIS file (importing back is a cycle) and
// because neither the constants nor the function are exported there.
const SWEEPER_MIN_OFFENSIVE_SP = 12;   // of 32, usage-weighted across observed sets
const SWEEPER_MIN_DAMAGING_MOVES = 2;
const SPEED_CONTROL_MOVES = new Set(['trick room', 'tailwind', 'icy wind', 'electroweb', 'thunder wave', 'string shot']);
const PIVOT_MOVES = new Set(['u-turn', 'volt switch', 'flip turn', 'parting shot', 'teleport', 'baton pass', 'shed tail', 'chilly reception']);
const ROLE_VOCABULARY = ['fast sweeper', 'bulky sweeper', 'fast support', 'bulky support', 'speed control', 'pivot', 'wallbreaker'];

/**
 * Usage-weighted SP investment across every observed spread — offensive
 * (max of atk/spa) and defensive (hp plus the larger defence) measured the same
 * way so the two are directly comparable, which is what decides "bulky".
 */
async function observedInvestment(nameLower) {
  if (investmentCache.has(nameLower)) return investmentCache.get(nameLower);
  const data = await getCommonSpreads(nameLower).catch(() => null);
  let out = null;
  if (data && data.spreads && data.spreads.length > 0) {
    let off = 0;
    let def = 0;
    let totalFreq = 0;
    for (const entry of data.spreads) {
      const f = entry.frequency || 0;
      off += Math.max(entry.sp?.atk || 0, entry.sp?.spa || 0) * f;
      def += ((entry.sp?.hp || 0) + Math.max(entry.sp?.def || 0, entry.sp?.spd || 0)) * f;
      totalFreq += f;
    }
    if (totalFreq > 0) {
      out = { offensive: off / totalFreq, defensive: def / totalFreq, sets_seen: data.spreads.length };
    }
  }
  investmentCache.set(nameLower, out);
  return out;
}

/**
 * Effective Speed from a REAL final stat.
 *
 * archetype_matchups.js's buildKeyThreats calls effectiveSpeed with
 * `final_stats: null`, so effectiveSpeed falls back to `pokemonRow.spe` and the
 * `speed` it publishes on every key threat is that threat's BASE Speed, not its
 * built Speed. Comparing a candidate's real final Speed (which can be 60+ points
 * higher) against those numbers would make literally everything "fast", so this
 * file computes both sides itself, from each Pokemon's own spread, and reports
 * the basis it used.
 */
function effectiveSpeedFor(row, sp, nature, item, ability, weather) {
  if (!row || row.spe == null) return null;
  const spe = calcStat(row.spe, sp?.spe || 0, natureMultiplierFor(nature || 'Hardy', 'spe'), false);
  return effectiveSpeed(
    { pokemonRow: row, final_stats: { spe }, sp: sp || {}, nature: nature || 'Hardy', item: item || '', ability: ability || '' },
    { by_weather: weather ? { [weather]: [{ weather }] } : {} }
  );
}

async function threatEffectiveSpeed(threat, weather) {
  const key = `${lower(threat.pokemon)}|${weather || 'none'}`;
  if (threatSpeedCache.has(key)) return threatSpeedCache.get(key);
  const row = await getSpeciesRow(lower(threat.pokemon)).catch(() => null);
  const spread = row ? await getMostCommonSpread(lower(threat.pokemon)).catch(() => null) : null;
  const speed = row
    ? effectiveSpeedFor(row, spread?.sp || {}, spread?.nature || 'Hardy', threat.item || '', threat.ability || '', weather)
    : null;
  threatSpeedCache.set(key, speed);
  return speed;
}

/** Median of the meta speeds we actually resolved — null when none resolved. */
function medianOf(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * One role from the fixed vocabulary, plus every signal it was derived from, so
 * the classification is checkable rather than asserted.
 *
 * `moves` is the set this Pokemon actually runs; `sp`/`nature`/`item`/`ability`
 * are the build being proposed (fresh optimised spread for a candidate, the real
 * assigned build for a team member) and decide only the Speed comparison. The
 * offensive/defensive split is always the usage-weighted OBSERVED investment,
 * because that is the measurement that survives the base-stat trap.
 */
async function deriveRole({ name, row, moves, sp, nature, item, ability, metaMedianSpeed, weather }) {
  const nameLower = lower(name);
  const investment = await observedInvestment(nameLower);

  let damaging = 0;
  let status = 0;
  let speedControlMove = null;
  let pivotMove = null;
  for (const mv of moves || []) {
    if ((mv.power || 0) > 0) damaging += 1; else status += 1;
    if (!speedControlMove && SPEED_CONTROL_MOVES.has(lower(mv.move))) speedControlMove = mv.move;
    if (!pivotMove && PIVOT_MOVES.has(lower(mv.move))) pivotMove = mv.move;
  }

  const effSpeed = effectiveSpeedFor(row, sp, nature, item, ability, weather);
  const faster = (effSpeed != null && metaMedianSpeed != null) ? effSpeed > metaMedianSpeed : null;

  const signals = {
    offensive_sp: investment ? round(investment.offensive, 2) : null,
    defensive_sp: investment ? round(investment.defensive, 2) : null,
    sets_sampled: investment ? investment.sets_seen : 0,
    damaging_moves: damaging,
    status_moves: status,
    moves_counted: (moves || []).length,
    speed_control_move: speedControlMove,
    pivot_move: pivotMove,
    effective_speed: effSpeed,
    meta_median_speed: metaMedianSpeed,
    faster_than_meta_median: faster,
    thresholds: {
      min_offensive_sp: SWEEPER_MIN_OFFENSIVE_SP,
      min_damaging_moves: SWEEPER_MIN_DAMAGING_MOVES,
      bulky_rule: 'defensive_sp > offensive_sp',
    },
    vocabulary: ROLE_VOCABULARY,
  };

  // Said out loud rather than guessed. "No observed spreads" and "support" are
  // opposite conclusions and must never render the same way.
  if (!investment) {
    return { role: null, unavailable_reason: `no observed SP spreads for ${name} — role is not derivable from usage data`, ...signals };
  }
  if (faster === null) {
    return { role: null, unavailable_reason: `no resolvable meta Speed baseline for ${name} — fast/bulky cannot be decided`, ...signals };
  }

  const offensive = investment.offensive >= SWEEPER_MIN_OFFENSIVE_SP && damaging >= SWEEPER_MIN_DAMAGING_MOVES;
  const bulky = investment.defensive > investment.offensive;

  let role;
  if (offensive) {
    // A wallbreaker is the residual offensive case: it invests to hit hard but
    // neither outruns the meta nor puts more into its defences than its offence.
    role = faster ? 'fast sweeper' : (bulky ? 'bulky sweeper' : 'wallbreaker');
  } else if (speedControlMove) {
    role = 'speed control';
  } else if (pivotMove) {
    role = 'pivot';
  } else {
    role = faster ? 'fast support' : 'bulky support';
  }
  return { role, unavailable_reason: null, ...signals };
}

// --- 3. POKEMON SWAPS --------------------------------------------------------

/**
 * @param {string} name
 * @param {{archetype?: string, teamSpeciesSet?: Set<string>}} [context] — the
 *   archetype being analyzed and the (lowercased) species already on the team
 *   under analysis, both optional. Without them, composition still works —
 *   it just starts at Level 2 (archetype-only) or falls straight to Level 3
 *   (all observed rows) — but callers scoped to one archetype/team (which is
 *   every real caller in this file) should always pass both, so the composed
 *   build actually makes sense for the matchup it's being shown in.
 */
async function candidateProfile(name, context = {}) {
  const key = lower(name);
  const { archetype = null, teamSpeciesSet = null } = context;
  const cacheKey = `${key}|${archetype || ''}`;
  if (candidateProfileCache.has(cacheKey)) return candidateProfileCache.get(cacheKey);
  const row = await getSpeciesRow(key).catch(() => null);
  if (!row) { candidateProfileCache.set(cacheKey, null); return null; }

  const composed = await composeFromLadder(key, archetype, teamSpeciesSet);
  const profile = {
    name: row.name,
    row,
    types: [row.type1, row.type2].filter(Boolean),
    spread: composed?.spread || null,
    item: composed?.item || '',
    ability: composed?.ability || row.ability1 || null,
    moves: composed?.moves || [],
    provenance: composed?.provenance || null,
  };
  candidateProfileCache.set(cacheKey, profile);
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

// --- BUILDS UNDER COMPARISON -------------------------------------------------

/**
 * `status` is threaded for the same reason archetype_matchups.js threads it: a
 * Guts Flame Orb holder is burned on purpose, so calculating it unburned
 * describes a set nobody plays — and on the receiving end it is what makes an
 * incoming Hex or Venoshock 130 BP rather than 65.
 */
function sideOfBuild(build) {
  return {
    nature: build.nature,
    item: build.item,
    ability: build.ability,
    sp: build.sp || {},
    ivs: { hp: 31 },
    status: selfInflictedStatus(build.item, build.ability),
  };
}

function formatSpread(sp, nature) {
  if (!sp) return 'no spread resolved';
  return `${formatSp(sp)}${nature ? `, ${nature}` : ''}`;
}

/**
 * A candidate evaluated on a FRESH optimised spread, not only on its modal
 * tournament spread — the modal spread was built for somebody else's team, and
 * judging a swap on it answers a different question than the one being asked.
 * Falls back to the modal spread when the search cannot run, and says which one
 * every number came from.
 */
async function candidateBuild(profile, fieldOpts) {
  // Content-keyed, not just species name: profile is now archetype/team-
  // conditioned (see candidateProfile), so two different archetypes can
  // legitimately produce two different profiles — and therefore two
  // different builds — for the same species. Keying on name alone would let
  // whichever archetype computed first silently win for every other one.
  const key = [
    lower(profile.name), profile.item || '', profile.ability || '',
    (profile.moves || []).map((m) => m.move).join(','),
    JSON.stringify(profile.spread?.sp || null), profile.spread?.nature || '',
  ].join('|');
  if (candidateBuildCache.has(key)) return candidateBuildCache.get(key);

  let sp = null;
  let nature = profile.spread?.nature || 'Hardy';
  let source = 'none';
  try {
    const evo = await getOrComputeEvolutionarySpread(profile.name, {
      item: profile.item || null, teamBuild: true, fieldOpts,
    });
    const evoSp = evo?.result?.spreads?.[0]?.sp || null;
    if (evoSp) { sp = evoSp; nature = evo.nature || nature; source = 'evolutionary'; }
  } catch (_err) { sp = null; }
  if (!sp && profile.spread?.sp) { sp = profile.spread.sp; source = 'observed_modal'; }

  // The SET, not the movepool. `profile.moves` is every move ever recorded on
  // this species, frequency-ordered — counting all of it would make "runs two
  // damaging moves" true of essentially everything, and would let a move seen
  // once in two hundred sets stand as a field effect this Pokemon brings. Four
  // is the same slice archetype_matchups.js takes for a threat's top_moves.
  const setMoves = (profile.moves || []).slice(0, 4);
  const used = setMoves.filter((mv) => (mv.power || 0) > 0 && mv.type);
  const damagingObserved = (profile.moves || []).filter((mv) => (mv.power || 0) > 0 && mv.type);
  const build = {
    name: profile.name,
    row: profile.row,
    types: profile.types,
    sp,
    nature,
    item: profile.item || '',
    ability: profile.ability || '',
    spread_source: source,
    spread_label: formatSpread(sp, nature),
    moves: used,
    set_moves: setMoves,
    all_moves: profile.moves || [],
    moves_source: (profile.moves || []).length > 0 ? 'tournament_teams' : 'none',
    moves_truncated: Math.max(0, setMoves.length - used.length),
    damaging_moves_outside_set: Math.max(0, damagingObserved.length - used.length),
    observed_move_count: (profile.moves || []).length,
    provenance: profile.provenance || null,
  };
  candidateBuildCache.set(key, build);
  return build;
}

/** The same shape for a member of OUR team, from its real assigned build. */
function memberBuild(member) {
  const damaging = (member.moves || []).filter((mv) => mv.power && mv.type).slice(0, 4);
  return {
    name: member.pokemon,
    row: member.pokemonRow,
    types: [member.pokemonRow?.type1, member.pokemonRow?.type2].filter(Boolean),
    sp: member.sp || {},
    nature: member.nature,
    item: member.item || '',
    ability: member.ability || '',
    spread_source: 'team_build',
    spread_label: formatSpread(member.sp, member.nature),
    moves: damaging,
    set_moves: member.moves || [],
    all_moves: member.moves || [],
    moves_source: 'team_build',
    moves_truncated: 0,
    damaging_moves_outside_set: 0,
    observed_move_count: (member.moves || []).length,
  };
}

/** threat name -> the hardest guaranteed hit this build lands on it. */
function ohkoLedger(build, defenders, weather) {
  const out = new Map();
  let failures = 0;
  for (const d of defenders) {
    let best = null;
    for (const mv of build.moves) {
      const dmg = calcWithField(build.row, sideOfBuild(build), d.row, d.side, mv.move, weather, null);
      if (!dmg) { failures += 1; continue; }
      if (!best || dmg.min > best.min) best = { move: mv.move, min: dmg.min, max: dmg.max };
    }
    if (best) out.set(d.threat.pokemon, best);
  }
  return { ledger: out, failures };
}

/** "threat|move" -> what that incoming attack does to this build. */
function incomingLedger(build, defenders, weather) {
  const out = new Map();
  let failures = 0;
  for (const d of defenders) {
    for (const moveName of d.threat.top_moves || []) {
      const dmg = calcWithField(d.row, d.side, build.row, sideOfBuild(build), moveName, weather, null);
      if (!dmg) { failures += 1; continue; }
      out.set(`${d.threat.pokemon}|${moveName}`, { threat: d.threat.pokemon, usage: d.threat.usage, move: moveName, ...dmg });
    }
  }
  return { ledger: out, failures };
}

function capList(list, max) {
  return { list: list.slice(0, max), truncated: Math.max(0, list.length - max) };
}

/**
 * What the swap actually trades, both directions, entirely from real calcs:
 * KOs gained, KOs given up, hits newly survived, hits newly fatal.
 */
function comparativeDelta(candidate, dropped, defenders, weather) {
  const candOff = ohkoLedger(candidate, defenders, weather);
  const dropOff = ohkoLedger(dropped, defenders, weather);
  const candIn = incomingLedger(candidate, defenders, weather);
  const dropIn = incomingLedger(dropped, defenders, weather);

  const gains = [];
  const losses = [];
  const shared = [];
  for (const d of defenders) {
    const name = d.threat.pokemon;
    const c = candOff.ledger.get(name);
    const o = dropOff.ledger.get(name);
    const cKo = !!c && c.min >= 100;
    const oKo = !!o && o.min >= 100;
    if (cKo && !oKo) {
      gains.push({
        threat: name, usage: d.threat.usage, move: c.move,
        damage_range: `${c.min}-${c.max}%`, damage_min: c.min, damage_max: c.max,
        dropped_best_move: o?.move || null, dropped_best_min: o?.min ?? null,
      });
    } else if (oKo && !cKo) {
      losses.push({
        threat: name, usage: d.threat.usage, move: o.move,
        damage_range: `${o.min}-${o.max}%`, damage_min: o.min, damage_max: o.max,
        candidate_best_move: c?.move || null, candidate_best_min: c?.min ?? null,
      });
    } else if (cKo && oKo) {
      shared.push(name);
    }
  }

  const survives = [];
  const vulnerable = [];
  for (const [key, cand] of candIn.ledger.entries()) {
    const drop = dropIn.ledger.get(key);
    if (!drop) continue;
    const candSurvives = cand.min < 100;
    const dropSurvives = drop.min < 100;
    const row = {
      threat: cand.threat, usage: cand.usage, move: cand.move,
      candidate_range: `${cand.min}-${cand.max}%`, candidate_min: cand.min, candidate_max: cand.max,
      dropped_range: `${drop.min}-${drop.max}%`, dropped_min: drop.min, dropped_max: drop.max,
    };
    if (candSurvives && !dropSurvives) survives.push(row);
    else if (!candSurvives && dropSurvives) vulnerable.push(row);
  }

  gains.sort((a, b) => b.usage - a.usage);
  losses.sort((a, b) => b.usage - a.usage);
  survives.sort((a, b) => b.dropped_min - a.dropped_min);
  vulnerable.sort((a, b) => b.candidate_min - a.candidate_min);

  const g = capList(gains, MAX_DELTA_LINES);
  const l = capList(losses, MAX_DELTA_LINES);
  const s = capList(survives, MAX_DELTA_LINES);
  const v = capList(vulnerable, MAX_DELTA_LINES);

  return {
    weather: weather || null,
    threats_evaluated: defenders.length,
    incoming_attacks_evaluated: candIn.ledger.size,
    gains_ohko_on: g.list,
    loses_ohko_on: l.list,
    shared_ohko_on: shared,
    newly_survives: s.list,
    newly_vulnerable: v.list,
    truncated: {
      gains_ohko_on: g.truncated,
      loses_ohko_on: l.truncated,
      newly_survives: s.truncated,
      newly_vulnerable: v.truncated,
    },
    calc_failures: candOff.failures + dropOff.failures + candIn.failures + dropIn.failures,
    net_score: gains.length * 2 - losses.length * 2 + survives.length - vulnerable.length,
    // Kept whole so a caller can reconcile the capped lists against the totals.
    totals: {
      gains_ohko_on: gains.length,
      loses_ohko_on: losses.length,
      newly_survives: survives.length,
      newly_vulnerable: vulnerable.length,
    },
  };
}

// --- FIELD EFFECTS, RECOMPUTED ------------------------------------------------

const SCREEN_MOVES = { reflect: 'Reflect', 'light screen': 'Light Screen', 'aurora veil': 'Aurora Veil' };
const SCREEN_FIELD_KEY = { Reflect: 'isReflect', 'Light Screen': 'isLightScreen', 'Aurora Veil': 'isAuroraVeil' };
// Which incoming category each screen actually touches. Aurora Veil is null =
// both, which is the whole reason it is worth more than either screen alone.
const SCREEN_CATEGORY = { Reflect: 'Physical', 'Light Screen': 'Special', 'Aurora Veil': null };
const FIELD_ABILITIES = { intimidate: 'Intimidate', 'friend guard': 'Friend Guard' };

function memberRunsMove(member, moveName) {
  return (member.moves || []).some((mv) => lower(mv.move) === lower(moveName));
}

// Aurora Veil does nothing without Snow on the field. Reporting its arithmetic
// for a team that has no way to make it Snow is a number that can never happen,
// which is worse than saying nothing — so it is gated on a real Snow source.
const SNOW_MOVES = new Set(['snowscape', 'hail', 'chilly reception']);

function snowSources(builds, weather) {
  const sources = [];
  if (weather === 'Snow') sources.push('the archetype\'s own Snow');
  for (const b of builds) {
    if (WEATHER_ABILITIES[lower(b.ability)] === 'Snow') sources.push(`${b.name} (${b.ability})`);
    for (const mv of b.set_moves || []) {
      if (SNOW_MOVES.has(lower(mv.move))) sources.push(`${b.name}'s ${mv.move}`);
    }
  }
  return sources;
}

/**
 * The field effects a candidate brings that the team does not already have, each
 * one recomputed against the calcs it actually changes.
 *
 * Screens are gated hard: nothing about a screen is emitted unless a Pokemon on
 * one of the two teams can genuinely set it — confirmed against the candidate's
 * observed tournament sets AND its learnset. A screen nobody can put up is not a
 * reason to make a swap, and printing the arithmetic for one is worse than
 * printing nothing.
 */
async function fieldEffectAnalysis(candidate, droppedName, team, defenders, threats, weather) {
  const remaining = team.filter((m) => m.pokemon !== droppedName);
  const remainingBuilds = remaining.map(memberBuild);
  const snow = snowSources([...remainingBuilds, candidate], weather);
  const brought = [];
  const skipped = [];

  for (const mv of candidate.set_moves) {
    const effect = SCREEN_MOVES[lower(mv.move)];
    if (!effect) continue;
    const learnsIt = await knowsMove(candidate.name, effect);
    // 'unknown' means the table has no data for this move at all — not that
    // the candidate can't learn it. mv is drawn from candidate.set_moves, so
    // the candidate is ALREADY observed running this exact move; that
    // observation outweighs a table gap. Only a real 'illegal' verdict (the
    // table demonstrably has data for this move and still excludes this
    // species) blocks the candidate as a setter.
    const candidateSets = learnsIt !== 'illegal';
    const oursSetting = remaining.filter((m) => memberRunsMove(m, effect)).map((m) => `${m.pokemon} (our side)`);
    const theirsSetting = threats
      .filter((t) => (t.top_moves || []).some((x) => lower(x) === lower(effect)))
      .map((t) => `${t.pokemon} (their side)`);
    const setters = [...(candidateSets ? [`${candidate.name} (incoming)`] : []), ...oursSetting, ...theirsSetting];
    if (setters.length === 0) {
      skipped.push(`${effect} — observed on ${candidate.name} in tournament data but absent from its learnset, and no Pokemon on either team can set it; not reported`);
      continue;
    }
    if (effect === 'Aurora Veil' && snow.length === 0) {
      skipped.push(`Aurora Veil — ${candidate.name} runs it, but neither this team nor ${weather ? `their ${weather}` : 'this matchup'} can put Snow on the field, so it can never go up; not reported`);
      continue;
    }
    brought.push({
      effect,
      source: mv.move,
      source_kind: 'move',
      observed_frequency: round(mv.frequency || 0, 4),
      learnset_confirmed: learnsIt,
      setters,
      already_on_team: remaining.some((m) => memberRunsMove(m, effect)),
    });
  }

  const abilityEffect = FIELD_ABILITIES[lower(candidate.ability)];
  if (abilityEffect) {
    brought.push({
      effect: abilityEffect,
      source: candidate.ability,
      source_kind: 'ability',
      observed_frequency: null,
      learnset_confirmed: null,
      setters: [`${candidate.name} (incoming)`],
      already_on_team: remaining.some((m) => lower(m.ability) === lower(candidate.ability)),
    });
  }

  const recomputes = [];
  let calcFailures = 0;
  let unmodelled = 0;
  const newEffects = brought.filter((b) => !b.already_on_team);

  for (const b of newEffects) {
    // Everyone the effect protects. Friend Guard is an ALLY-only aura — it never
    // reduces damage taken by its own holder — so the candidate is excluded from
    // its defender list and included in every other effect's.
    const defendersOnOurSide = b.effect === 'Friend Guard'
      ? remainingBuilds
      : [...remainingBuilds, candidate];

    for (const ourMon of defendersOnOurSide) {
      if (!ourMon.row) continue;
      for (const d of defenders) {
        for (const moveName of d.threat.top_moves || []) {
          const moveRow = await getMoveRow(moveName);
          if (!moveRow || !moveRow.power) continue;
          if (b.effect === 'Intimidate' && moveRow.category !== 'Physical') continue;
          const screenCat = SCREEN_CATEGORY[b.effect];
          if (screenCat !== undefined && screenCat !== null && moveRow.category !== screenCat) continue;

          const before = calcWithField(d.row, d.side, ourMon.row, sideOfBuild(ourMon), moveName, weather, null);
          if (!before) { calcFailures += 1; continue; }
          // Only hits that matter. A field effect shaving 3% off a 12% hit is
          // not an argument for a swap and would bury the ones that are.
          if (before.min < 100 && before.max < HEAVY_DAMAGE_PCT) continue;

          let after = null;
          let note = null;
          if (SCREEN_FIELD_KEY[b.effect]) {
            after = calcWithField(d.row, d.side, ourMon.row, sideOfBuild(ourMon), moveName, weather,
              { [SCREEN_FIELD_KEY[b.effect]]: true });
            if (b.effect === 'Aurora Veil') note = `holds only while Snow is up — Snow from: ${snow.join(', ')}`;
          } else if (b.effect === 'Friend Guard') {
            after = calcWithField(d.row, d.side, ourMon.row, { ...sideOfBuild(ourMon), isFriendGuard: true }, moveName, weather, null);
            note = `requires ${candidate.name} on the field alongside ${ourMon.name}`;
          } else if (b.effect === 'Intimidate') {
            const intimidated = intimidatedAttackerRow(d.row, d.side);
            if (!intimidated) {
              // Reported, never approximated. See intimidatedAttackerRow.
              unmodelled += 1;
              continue;
            }
            after = calcWithField(intimidated.row, { ...d.side, nature: intimidated.nature },
              ourMon.row, sideOfBuild(ourMon), moveName, weather, null);
            note = `${d.threat.pokemon} Attack ${intimidated.before_atk} -> ${intimidated.after_atk}`;
          }
          if (!after) { calcFailures += 1; continue; }

          recomputes.push({
            effect: b.effect,
            defender: ourMon.name,
            attacker: d.threat.pokemon,
            attacker_usage: d.threat.usage,
            move: moveName,
            move_category: moveRow.category,
            before_range: `${before.min}-${before.max}%`,
            before_min: before.min,
            before_max: before.max,
            before_ohko: before.min >= 100,
            after_range: `${after.min}-${after.max}%`,
            after_min: after.min,
            after_max: after.max,
            after_ohko: after.min >= 100,
            change_max: round(before.max - after.max, 1),
            prevents_ohko: before.min >= 100 && after.min < 100,
            exact: true,
            note,
          });
        }
      }
    }
  }

  recomputes.sort((a, b) => (b.prevents_ohko === a.prevents_ohko ? 0 : b.prevents_ohko ? 1 : -1)
    || b.change_max - a.change_max
    || b.attacker_usage - a.attacker_usage);
  const capped = capList(recomputes, MAX_FIELD_RECOMPUTES);

  // What the numbers assume. Stated because each of these is a condition the
  // calculation cannot itself enforce, and a before/after pair with the
  // condition left unsaid reads as unconditional.
  const caveats = [];
  for (const b of newEffects) {
    if (SCREEN_FIELD_KEY[b.effect]) {
      caveats.push(`${b.effect} figures assume it is already up — ${candidate.name} spends a turn setting it, and it lasts five (eight with Light Clay)`);
    }
    if (b.effect === 'Intimidate') {
      caveats.push(`Intimidate figures assume the drop landed — it triggers once per switch-in and is blocked by Clear Body, Inner Focus, Own Tempo, Oblivious, Scrappy, Guard Dog, a Clear Amulet or an existing -6`);
    }
    if (b.effect === 'Friend Guard') {
      caveats.push(`Friend Guard figures assume ${candidate.name} is on the field alongside the teammate being hit — it never reduces damage to itself`);
    }
  }

  return {
    brought,
    new_effects: newEffects.map((b) => b.effect),
    skipped,
    snow_sources: snow,
    caveats,
    recomputes: capped.list,
    recomputes_truncated: capped.truncated,
    recomputes_total: recomputes.length,
    calc_failures: calcFailures,
    intimidate_unmodelled: unmodelled,
  };
}

// --- BACKFILL SEARCH ----------------------------------------------------------

/**
 * What this drop costs that nothing left on the team replaces, and whether
 * ANYTHING in the whole legal pool covers it.
 *
 * Entirely generic: a loss is discovered by comparing ledgers, never by naming a
 * species or a threat. The two kinds of loss are the only two the team-value
 * model already recognises as irreplaceable — the last OHKO on a threat, and the
 * last source of an attacking type.
 */
function irreplaceableLosses(candidate, dropped, remainingBuilds, defenders, weather) {
  const losses = [];

  const dropOff = ohkoLedger(dropped, defenders, weather).ledger;
  const candOff = ohkoLedger(candidate, defenders, weather).ledger;
  const remainingOff = remainingBuilds.map((b) => ohkoLedger(b, defenders, weather).ledger);

  for (const d of defenders) {
    const name = d.threat.pokemon;
    const o = dropOff.get(name);
    if (!o || o.min < 100) continue;
    const c = candOff.get(name);
    if (c && c.min >= 100) continue;
    const someoneElse = remainingOff.some((led) => { const e = led.get(name); return e && e.min >= 100; });
    if (someoneElse) continue;
    losses.push({
      kind: 'ohko',
      what: name,
      usage: d.threat.usage,
      detail: `${dropped.name}'s ${o.move} is the team's only guaranteed KO on ${name} (${o.min}-${o.max}%), and ${candidate.name} does not replace it`,
      threat: d.threat,
      defender: d,
    });
  }

  const typesOfBuild = (b) => new Set(b.moves.filter((mv) => (mv.power || 0) > 0 && mv.type).map((mv) => mv.type));
  const droppedTypes = typesOfBuild(dropped);
  const kept = new Set();
  for (const b of [...remainingBuilds, candidate]) for (const t of typesOfBuild(b)) kept.add(t);
  for (const t of droppedTypes) {
    if (kept.has(t)) continue;
    losses.push({
      kind: 'coverage_type',
      what: t,
      usage: null,
      detail: `${dropped.name} is the team's only source of ${t} coverage and ${candidate.name} brings none`,
      threat: null,
      defender: null,
    });
  }

  losses.sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0));
  return losses;
}

async function searchPoolForOhko(loss, poolNames, weather, exclude, archetype, teamSpeciesSet) {
  const found = [];
  let profileMisses = 0;
  let searched = 0;
  const targetSpeed = await threatEffectiveSpeed(loss.threat, weather);

  for (const entry of poolNames) {
    if (exclude.has(lower(entry.name))) continue;
    searched += 1;
    const profile = await candidateProfile(entry.name, { archetype, teamSpeciesSet });
    if (!profile) { profileMisses += 1; continue; }
    const sp = profile.spread?.sp || null;
    if (!sp) continue;
    const side = {
      nature: profile.spread?.nature || 'Hardy', item: profile.item || '', ability: profile.ability || '',
      sp, ivs: { hp: 31 }, status: selfInflictedStatus(profile.item || '', profile.ability || ''),
    };

    // PHASE 4 — recoil tiebreak. This loop already compares every candidate
    // move for this Pokemon head-to-head (all must clear dmg.min >= 100 to
    // qualify at all, so by construction every survivor here already secures
    // the SAME outcome: a guaranteed OHKO). Past that threshold, extra damage
    // buys nothing — so a recoil move should only win when it is the ONLY
    // thing that reaches the OHKO; if a non-recoil move also gets there, the
    // recoil bought nothing and the non-recoil move wins regardless of which
    // has the higher raw percentage. This is a tiebreak, not a penalty curve —
    // a recoil move that is the sole path to the KO still wins as before.
    let best = null;
    let bestNonRecoil = null;
    // Slice first, filter second: the top six OBSERVED moves, then whichever of
    // those do damage. Filtering first reaches down the frequency list into
    // moves nobody actually runs, and manufactures a KO out of one of them.
    for (const mv of (profile.moves || []).slice(0, 6).filter((m) => (m.power || 0) > 0 && m.type)) {
      const dmg = calcWithField(profile.row, side, loss.defender.row, loss.defender.side, mv.move, weather, null);
      // bp_unresolved means the number is a guess at an assumed BP (Assurance,
      // Retaliate, Beat Up — ally/turn state this calculator does not model),
      // not a real damage figure. Reporting it as a guaranteed KO is worse than
      // reporting nothing.
      if (!dmg || dmg.min < 100 || dmg.bp_unresolved) continue;
      const candidate = { move: mv.move, type: mv.type, frequency: round(mv.frequency || 0, 4), ...dmg };
      if (!best || dmg.min > best.min) best = candidate;
      if (!RECOIL_MOVES.has(lower(mv.move)) && (!bestNonRecoil || dmg.min > bestNonRecoil.min)) bestNonRecoil = candidate;
    }
    if (bestNonRecoil) best = bestNonRecoil;
    if (!best) continue;

    // A Focus Sash on the target denies any single-hit KO from full HP, so
    // "can anything outspeed and OHKO this" has to be asked against the Sash
    // too — otherwise the answer is only true against the items it happens to
    // be observed holding. The Sash SUBSTITUTES for the target's observed item
    // rather than stacking with it, because a Sash set is not also an Assault
    // Vest set; `sash_replaces_item` names what was displaced so the comparison
    // is not mistaken for "same set, plus a Sash".
    // status is recomputed, not inherited: the displaced item may have been the
    // Orb that was self-inflicting it.
    const sashSide = { ...loss.defender.side, item: 'Focus Sash', status: selfInflictedStatus('Focus Sash', loss.defender.side.ability) };
    const sashed = calcWithField(profile.row, side, loss.defender.row, sashSide, best.move, weather, null);
    const speed = effectiveSpeedFor(profile.row, sp, side.nature, side.item, side.ability, weather);

    found.push({
      pokemon: profile.name,
      usage: entry.usage,
      types: profile.types,
      move: best.move,
      move_type: best.type,
      move_observed_frequency: best.frequency,
      damage_range: `${best.min}-${best.max}%`,
      damage_min: best.min,
      damage_max: best.max,
      ohko: true,
      spread_source: 'observed_modal',
      spread_label: formatSpread(sp, side.nature),
      nature: side.nature,
      item: side.item,
      ability: side.ability,
      effective_speed: speed,
      target_speed: targetSpeed,
      outspeeds: (speed != null && targetSpeed != null) ? speed > targetSpeed : null,
      ohko_through_focus_sash: sashed ? sashed.min >= 100 : null,
      sash_denies_ohko: sashed ? sashed.min < 100 : null,
      sash_replaces_item: loss.defender.side.item || null,
      verified_on_optimised_spread: false,
      build_provenance: profile.provenance?.label || null,
    });
  }

  // Speed used to sort ahead of damage, which could put a 100-116% option above
  // a 149-177.5% one just because the weaker one happened to outspeed. Judged
  // on guaranteed damage first, per the format owner's call.
  found.sort((a, b) => b.damage_min - a.damage_min || b.usage - a.usage);
  return { found, searched, profileMisses };
}

async function searchPoolForCoverage(loss, poolNames, defenders, weather, exclude, archetype, teamSpeciesSet) {
  const found = [];
  let profileMisses = 0;
  let searched = 0;

  for (const entry of poolNames) {
    if (exclude.has(lower(entry.name))) continue;
    searched += 1;
    const profile = await candidateProfile(entry.name, { archetype, teamSpeciesSet });
    if (!profile) { profileMisses += 1; continue; }
    const mv = (profile.moves || []).find((m) => (m.power || 0) > 0 && m.type === loss.what);
    if (!mv) continue;
    // Learnset-confirmed as well as observed, so a scrape artefact cannot invent
    // a coverage source that does not exist — but a table gap ('unknown') is
    // not evidence of that; only a real 'illegal' verdict vetoes a candidate
    // that already cleared the observed-frequency and damage-threshold checks.
    if ((await knowsMove(profile.name, mv.move)) === 'illegal') continue;
    const sp = profile.spread?.sp || null;
    const side = {
      nature: profile.spread?.nature || 'Hardy', item: profile.item || '', ability: profile.ability || '',
      sp: sp || {}, ivs: { hp: 31 }, status: selfInflictedStatus(profile.item || '', profile.ability || ''),
    };
    // "Covers this type" is not "covers anything" — check every key threat, not
    // an arbitrary first one, and require a real dent on at least one of them.
    // A shared type with no meaningful damage anywhere is filler, not coverage.
    let best = null;
    for (const d of defenders) {
      const dmg = calcWithField(profile.row, side, d.row, d.side, mv.move, weather, null);
      if (!dmg || dmg.bp_unresolved) continue;
      if (!best || dmg.min > best.dmg.min) best = { defender: d, dmg };
    }
    if (!best || best.dmg.min < COVERAGE_MEANINGFUL_MIN_PERCENT) continue;
    const dmg = best.dmg;
    found.push({
      pokemon: profile.name,
      usage: entry.usage,
      types: profile.types,
      move: mv.move,
      move_type: mv.type,
      move_observed_frequency: round(mv.frequency || 0, 4),
      damage_range: `${dmg.min}-${dmg.max}%`,
      damage_min: dmg.min,
      damage_max: dmg.max,
      damage_target: best.defender.threat.pokemon,
      ohko: dmg.min >= 100,
      spread_source: sp ? 'observed_modal' : 'none',
      spread_label: formatSpread(sp, side.nature),
      nature: side.nature,
      item: side.item,
      ability: side.ability,
      effective_speed: effectiveSpeedFor(profile.row, sp || {}, side.nature, side.item, side.ability, weather),
      target_speed: null,
      outspeeds: null,
      ohko_through_focus_sash: null,
      sash_denies_ohko: null,
      sash_replaces_item: null,
      verified_on_optimised_spread: false,
      build_provenance: profile.provenance?.label || null,
    });
  }

  found.sort((a, b) => (b.damage_min ?? -1) - (a.damage_min ?? -1) || b.usage - a.usage);
  return { found, searched, profileMisses };
}

/**
 * Re-run the top few finds on a fresh optimised spread. The pool scan uses each
 * species' modal tournament spread because 250-odd evolutionary searches per
 * loss is the one thing that genuinely will not finish; the shortlist that
 * actually gets reported is then re-checked on the spread we would really build.
 */
async function verifyBackfill(entries, loss, weather, fieldOpts, archetype, teamSpeciesSet) {
  for (const e of entries.slice(0, BACKFILL_VERIFY_LIMIT)) {
    const profile = await candidateProfile(e.pokemon, { archetype, teamSpeciesSet });
    if (!profile) continue;
    const build = await candidateBuild(profile, fieldOpts);
    if (!build || !build.sp || build.spread_source !== 'evolutionary') continue;
    const target = loss.kind === 'ohko' ? loss.defender : null;
    if (!target) continue;
    const dmg = calcWithField(build.row, sideOfBuild(build), target.row, target.side, e.move, weather, null);
    if (!dmg) continue;
    e.verified_on_optimised_spread = true;
    e.optimised_spread_label = build.spread_label;
    e.optimised_damage_range = `${dmg.min}-${dmg.max}%`;
    e.optimised_damage_min = dmg.min;
    e.optimised_ohko = dmg.min >= 100;
    e.effective_speed = effectiveSpeedFor(build.row, build.sp, build.nature, build.item, build.ability, weather);
    e.outspeeds = (e.effective_speed != null && e.target_speed != null) ? e.effective_speed > e.target_speed : null;
  }
  return entries;
}

async function backfillAnalysis(candidate, dropped, team, defenders, weather, poolNames, fieldOpts, archetype) {
  const remainingBuilds = team.filter((m) => m.pokemon !== dropped.name).map(memberBuild);
  const all = irreplaceableLosses(candidate, dropped, remainingBuilds, defenders, weather);
  const capped = capList(all, MAX_BACKFILL_LOSSES);
  const exclude = new Set([...team.map((m) => lower(m.pokemon)), lower(candidate.name)]);
  const teamSpeciesSet = new Set(team.map((m) => lower(m.pokemon)));

  const out = [];
  for (const loss of capped.list) {
    const scan = loss.kind === 'ohko'
      ? await searchPoolForOhko(loss, poolNames, weather, exclude, archetype, teamSpeciesSet)
      : await searchPoolForCoverage(loss, poolNames, defenders, weather, exclude, archetype, teamSpeciesSet);
    const top = capList(scan.found, MAX_BACKFILL_RESULTS);
    await verifyBackfill(top.list, loss, weather, fieldOpts, archetype, teamSpeciesSet);

    out.push({
      kind: loss.kind,
      what: loss.what,
      usage: loss.usage,
      detail: loss.detail,
      pool_searched: scan.searched,
      pool_profile_misses: scan.profileMisses,
      replacements: top.list,
      replacements_total: scan.found.length,
      replacements_truncated: top.truncated,
      nothing_found: scan.found.length === 0,
      // scan.searched is smaller than the bounds line's "256 legal Pokemon" by
      // design — it excludes the 6 Pokemon already on the team and the
      // candidate this backfill is being run for, neither of which a backfill
      // could sensibly suggest. Spelling out the arithmetic here instead of
      // just printing the smaller number is what makes the two lines read as
      // agreeing rather than as a discrepancy.
      statement: scan.found.length === 0
        ? (loss.kind === 'ohko'
          ? `Nothing in the ${scan.searched} legal Pokemon searched (${poolNames.length + team.length} total, minus the current 6 and ${candidate.name}) guarantees a KO on ${loss.what} from its observed spread — this loss is not backfillable from the pool`
          : `Nothing in the ${scan.searched} legal Pokemon searched (${poolNames.length + team.length} total, minus the current 6 and ${candidate.name}) is observed running a damaging ${loss.what} move — this coverage is not backfillable from the pool`)
        : `${scan.found.length} of the ${scan.searched} legal Pokemon searched (${poolNames.length + team.length} total, minus the current 6 and ${candidate.name}) cover this; the top ${top.list.length} are listed`,
    });
  }

  return {
    losses: out,
    losses_total: all.length,
    losses_truncated: capped.truncated,
    pool_size: poolNames.length,
    nothing_lost: all.length === 0,
  };
}

/**
 * Drop candidates are ranked by (matchup contribution) MINUS (what the team
 * loses). A member can be useless against rain and still be undroppable because
 * it is the only Tailwind, the only Flying coverage and half the team's synergy
 * pairs — which is the case for Whimsicott, and why the first version's
 * "drop Whimsicott" was wrong.
 */
const TEAM_VALUE_FLOOR = 40;

async function buildPokemonSwaps(team, threats, weakestMembers, teamValues, archetype, legalPokemonSet, weather, fieldOpts) {
  // Every legal Pokemon, not the top 40 by usage. A swap whose whole job is to
  // answer a specific threat is very often NOT a high-usage Pokemon — that is
  // most of the point of looking for one.
  const { rows: allRows } = await pool.query(
    POKEMON_CANDIDATE_POOL
      ? 'SELECT pokemon_name, usage_percent FROM usage_stats ORDER BY usage_percent DESC LIMIT $1'
      : 'SELECT pokemon_name, usage_percent FROM usage_stats ORDER BY usage_percent DESC',
    POKEMON_CANDIDATE_POOL ? [POKEMON_CANDIDATE_POOL] : []
  ).catch(() => ({ rows: [] }));

  // Intersect with the legal set when we have one. usage_stats IS the legal set
  // today, so this is belt-and-braces rather than a filter that currently bites —
  // but it means a future usage table carrying illegal entries cannot leak them
  // into a recommendation.
  const usageRows = (legalPokemonSet && legalPokemonSet.size > 0)
    ? allRows.filter((r) => legalPokemonSet.has(r.pokemon_name))
    : allRows;

  const onTeam = new Set(team.map((m) => lower(m.pokemon)));
  const scored = [];
  let profileMisses = 0;
  for (const r of usageRows) {
    if (onTeam.has(lower(r.pokemon_name))) continue;
    const profile = await candidateProfile(r.pokemon_name, { archetype, teamSpeciesSet: onTeam });
    // Counted, not swallowed. A Pokemon with no `pokemon` table row is silently
    // unswappable, and that is exactly the documented Mega-form data gap — worth
    // seeing in the output rather than inferring from an absence.
    if (!profile) { profileMisses += 1; continue; }
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

  // Everything below this line is real calculation, so it is resolved once and
  // shared: the threats as defenders, the meta Speed baseline, and the pool the
  // backfill search walks.
  const defenders = [];
  for (const t of threats) {
    const d = await threatDefenderSide(t);
    // Status applied once, here, so every downstream consumer of `defenders`
    // (delta, field effects, backfill) uses the same threat build. See
    // sideOfBuild for why it matters.
    if (d) defenders.push({ threat: t, row: d.row, side: { ...d.side, status: selfInflictedStatus(d.side.item, d.side.ability) } });
  }
  const metaSpeeds = [];
  for (const t of threats) metaSpeeds.push(await threatEffectiveSpeed(t, weather));
  const metaMedianSpeed = medianOf(metaSpeeds);
  // The WHOLE legal pool, not `scored`. `scored` drops everything the type chart
  // rates at zero or worse, and a backfill's entire job is to find the one
  // Pokemon that answers a specific problem — which is very often exactly the
  // Pokemon a general type-chart score has no reason to like.
  const poolNames = usageRows
    .filter((r) => !onTeam.has(lower(r.pokemon_name)))
    .map((r) => ({ name: r.pokemon_name, usage: parseFloat(r.usage_percent) / 100 }));

  const suggestions = [];
  const takenCandidates = new Set();
  let realEvaluated = 0;

  for (let i = 0; i < Math.min(MAX_POKEMON_SWAPS, droppable.length); i++) {
    const outgoing = droppable[i];
    const outgoingMember = team.find((m) => m.pokemon === outgoing.pokemon);
    if (!outgoingMember) continue;
    const dropped = memberBuild(outgoingMember);

    // The shortlist is type-chart-scored, but the CHOICE inside it is made on
    // real damage. Ranking swaps on the type chart alone is how a candidate that
    // resists everything and KOs nothing reached the top of this list.
    const shortlist = scored.filter((s) => !takenCandidates.has(lower(s.name))).slice(0, POKEMON_REALCALC_SHORTLIST);
    if (shortlist.length === 0) break;

    let best = null;
    for (const cand of shortlist) {
      const profile = await candidateProfile(cand.name, { archetype, teamSpeciesSet: onTeam });
      if (!profile) continue;
      const build = await candidateBuild(profile, fieldOpts);
      if (!build) continue;
      realEvaluated += 1;
      const delta = comparativeDelta(build, dropped, defenders, weather);
      if (!best || delta.net_score > best.delta.net_score
        || (delta.net_score === best.delta.net_score && cand.score > best.cand.score)) {
        best = { cand, build, delta };
      }
    }
    if (!best) continue;
    takenCandidates.add(lower(best.cand.name));

    const addRole = await deriveRole({
      name: best.build.name, row: best.build.row, moves: best.build.set_moves,
      sp: best.build.sp, nature: best.build.nature, item: best.build.item, ability: best.build.ability,
      metaMedianSpeed, weather,
    });
    const dropRole = await deriveRole({
      name: dropped.name, row: dropped.row, moves: dropped.set_moves,
      sp: dropped.sp, nature: dropped.nature, item: dropped.item, ability: dropped.ability,
      metaMedianSpeed, weather,
    });
    const fieldEffects = await fieldEffectAnalysis(best.build, outgoing.pokemon, team, defenders, threats, weather);
    const backfill = await backfillAnalysis(best.build, dropped, team, defenders, weather, poolNames, fieldOpts, archetype);

    suggestions.push({
      drop: outgoing.pokemon,
      add: best.build.name,
      add_types: best.build.types,
      add_usage: best.cand.usage,
      add_item: best.build.item,
      add_ability: best.build.ability,
      loses: outgoing.contributions,
      // Every clause is a counted result of a real calc. The previous version
      // ended on "matches up better", which was a type-chart opinion presented
      // in the same voice as the damage numbers around it.
      reason: `${outgoing.pokemon} contributes least against ${archetype} (${outgoing.why}) and holds no irreplaceable team role. `
        + `${best.build.name} (${best.build.types.join('/')}, ${addRole.role || 'role underivable'}) was picked from ${shortlist.length} real-calced candidates `
        + `(build composed ${best.build.provenance?.label || 'from all observed rows'}): `
        + `it guarantees a KO on ${best.delta.totals.gains_ohko_on} threat${best.delta.totals.gains_ohko_on === 1 ? '' : 's'} ${outgoing.pokemon} does not, `
        + `gives up ${best.delta.totals.loses_ohko_on}, `
        + `survives ${best.delta.totals.newly_survives} incoming attack${best.delta.totals.newly_survives === 1 ? '' : 's'} that KO ${outgoing.pokemon}, `
        + `and is newly KO'd by ${best.delta.totals.newly_vulnerable}`,
      add_role: addRole,
      drop_role: dropRole,
      add_build: {
        spread_source: best.build.spread_source,
        spread_label: best.build.spread_label,
        sp: best.build.sp,
        nature: best.build.nature,
        item: best.build.item,
        ability: best.build.ability,
        moves: best.build.moves.map((mv) => ({ move: mv.move, type: mv.type, category: mv.category, power: mv.power })),
        moves_source: best.build.moves_source,
        moves_truncated: best.build.moves_truncated,
        build_provenance: best.build.provenance?.label || null,
      },
      drop_build: {
        spread_source: dropped.spread_source,
        spread_label: dropped.spread_label,
        sp: dropped.sp,
        nature: dropped.nature,
        item: dropped.item,
        ability: dropped.ability,
        moves: dropped.moves.map((mv) => ({ move: mv.move, type: mv.type, category: mv.category, power: mv.power })),
        moves_source: dropped.moves_source,
        moves_truncated: dropped.moves_truncated,
      },
      delta: best.delta,
      field_effects: fieldEffects,
      backfill,
      candidates_real_evaluated: shortlist.length,
    });
  }

  return {
    suggestions,
    pool_considered: usageRows.length,
    pool_scored: scored.length,
    pool_profile_misses: profileMisses,
    protected: protectedMembers,
    meta_median_speed: metaMedianSpeed,
    meta_speed_basis: 'effective Speed from each key threat\'s own modal observed spread, recomputed here — key_threats[].speed is that threat\'s BASE Speed and is not comparable',
    candidates_real_evaluated: realEvaluated,
    realcalc_shortlist_size: POKEMON_REALCALC_SHORTLIST,
  };
}

// --- ENTRY POINT -------------------------------------------------------------

// `legalPokemonSet` was in the object archetype_matchups.js passes here and was
// simply absent from this destructure, so it arrived and vanished. Adding the
// name is the entire fix — which is worth remembering as a class of bug: an
// unused property in a destructured argument is invisible to `node --check` and
// to the undefined-call checker alike.
async function buildSwaps({ team, threats, archetype, weather, fieldOpts, weakestMembers, synergies, legalPokemonSet }) {
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
  const pokemon = await buildPokemonSwaps(team, enrichedThreats, weakestMembers || [], teamValues, archetype, legalPokemonSet, weather, fieldOpts);

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
      pokemon_pool_scored: pokemon.pool_scored,
      pokemon_pool_profile_misses: pokemon.pool_profile_misses,
      pokemon_realcalc_shortlist: pokemon.realcalc_shortlist_size,
      pokemon_candidates_real_evaluated: pokemon.candidates_real_evaluated,
      max_delta_lines: MAX_DELTA_LINES,
      max_field_recomputes: MAX_FIELD_RECOMPUTES,
      max_backfill_losses: MAX_BACKFILL_LOSSES,
      max_backfill_results: MAX_BACKFILL_RESULTS,
      backfill_verify_limit: BACKFILL_VERIFY_LIMIT,
      meta_median_speed: pokemon.meta_median_speed,
      meta_speed_basis: pokemon.meta_speed_basis,
      role_vocabulary: ROLE_VOCABULARY,
      sweeper_min_offensive_sp: SWEEPER_MIN_OFFENSIVE_SP,
      sweeper_min_damaging_moves: SWEEPER_MIN_DAMAGING_MOVES,
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
  // Exported for isolation tests: deriveRole and intimidatedAttackerRow are the
  // two pieces whose correctness cannot be read off the output, since one is a
  // classification and the other silently returns null when it cannot be exact.
  deriveRole,
  intimidatedAttackerRow,
  calcWithField,
  comparativeDelta,
  MIN_DAMAGE_GAIN,
  TEAM_VALUE_FLOOR,
  NEVER_SUGGEST,
  ROLE_VOCABULARY,
  SWEEPER_MIN_OFFENSIVE_SP,
  SWEEPER_MIN_DAMAGING_MOVES,
  // PHASE 3: exported so scripts/check_set_coherence.js validates the actual
  // composition code path (per archetype) instead of re-implementing a
  // parallel copy of it that could silently drift.
  candidateProfile,
  observedOccurrences,
  MIN_LEVEL_ROWS,
};
