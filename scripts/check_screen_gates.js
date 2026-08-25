#!/usr/bin/env node
/**
 * check_screen_gates.js — walk every gate between "this candidate runs Reflect"
 * and "the swap output says a word about screens", and print which one closed.
 *
 * The set-coherence sweep cleared candidateProfile(): Sableye composes as
 * Light Clay / Prankster / Light Screen, Rain Dance, Reflect, Encore, and 13
 * real tournament rows ran exactly that. So the screens are IN set_moves and
 * the composition is not the problem. Something downstream drops them.
 *
 * fieldEffectAnalysis() (archetype_swaps.js:1197) gates a screen on:
 *
 *   1. the move is in candidate.set_moves          <- confirmed present
 *   2. knowsMove(candidate, effect)                <- learnset table
 *      OR a teammate runs it OR a threat runs it
 *   3. !already_on_team
 *   4. at least one threat move where the incoming
 *      category matches the screen's category AND
 *      before.min >= 100 || before.max >= HEAVY_DAMAGE_PCT
 *
 * Gate 2 is the suspect: it queries pokemon_moves, and if that table was built
 * from damaging moves only, every status move on every Pokemon reads as
 * "absent from its learnset" and gets silently pushed to `skipped`.
 *
 * Usage:
 *   node scripts\check_screen_gates.js
 *   node scripts\check_screen_gates.js sableye
 */

const pool = require('../src/db/pool');

const lower = (s) => String(s || '').toLowerCase().trim();
const SCREENS = ['Reflect', 'Light Screen', 'Aurora Veil'];

/** Verbatim copy of knowsMove() from archetype_swaps.js, minus the cache. */
async function knowsMove(speciesName, moveName) {
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
  const key = lower(speciesName);
  let hit = await tryFetch(key);
  if (!hit && key.includes('-')) hit = await tryFetch(key.split('-')[0]);
  return hit;
}

/** Is pokemon_moves populated with status moves AT ALL, or damaging only? */
async function learnsetShape() {
  const { rows } = await pool.query(
    `SELECT COALESCE(m.category, '(null)') AS category,
            COUNT(*)::int                  AS learnset_rows,
            COUNT(DISTINCT pm.pokemon_id)::int AS species
       FROM pokemon_moves pm
       JOIN moves m ON m.id = pm.move_id
      GROUP BY 1 ORDER BY learnset_rows DESC`
  ).catch((e) => { console.error(e.message); return { rows: [] }; });
  return rows;
}

/** Do the screen moves exist in `moves` at all, and how are they categorised? */
async function screenMoveRows() {
  const { rows } = await pool.query(
    `SELECT name, category, power, type FROM moves
      WHERE LOWER(name) = ANY($1)`,
    [SCREENS.map(lower)]
  ).catch(() => ({ rows: [] }));
  return rows;
}

/** How many species have each screen in pokemon_moves? */
async function screenLearnsetCoverage() {
  const { rows } = await pool.query(
    `SELECT m.name, COUNT(DISTINCT pm.pokemon_id)::int AS species
       FROM moves m
       JOIN pokemon_moves pm ON pm.move_id = m.id
      WHERE LOWER(m.name) = ANY($1)
      GROUP BY m.name ORDER BY species DESC`,
    [SCREENS.map(lower)]
  ).catch(() => ({ rows: [] }));
  return rows;
}

/** Every species observed running a screen in tournament play. */
async function observedScreenUsers() {
  const { rows } = await pool.query(
    `SELECT LOWER(COALESCE(p->>'normalizedName', p->>'name')) AS name,
            a.move_name AS move,
            COUNT(*)::int AS count
       FROM tournament_teams t,
            jsonb_array_elements(t.pokemon) p,
            jsonb_array_elements_text(p->'attacks') AS a(move_name)
      WHERE LOWER(a.move_name) = ANY($1)
      GROUP BY 1,2 ORDER BY count DESC`,
    [SCREENS.map(lower)]
  ).catch(() => ({ rows: [] }));
  return rows;
}

/** Top-4 pooled moves, i.e. exactly what becomes candidate.set_moves. */
async function setMoves(nameLower) {
  const { rows } = await pool.query(
    `SELECT a.move_name AS move, COUNT(*)::int AS count
       FROM tournament_teams t,
            jsonb_array_elements(t.pokemon) p,
            jsonb_array_elements_text(p->'attacks') AS a(move_name)
      WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) = $1
      GROUP BY 1 ORDER BY count DESC LIMIT 4`,
    [nameLower]
  ).catch(() => ({ rows: [] }));
  return rows.map((r) => r.move);
}

async function traceSpecies(name) {
  const key = lower(name);
  const moves = await setMoves(key);
  const screensInSet = moves.filter((m) => SCREENS.map(lower).includes(lower(m)));

  console.log(`\n=== ${name} ===`);
  console.log(`gate 1  set_moves (top-4 pooled): ${moves.join(', ') || '(none)'}`);
  if (screensInSet.length === 0) {
    console.log(`        no screen in the set -> fieldEffectAnalysis never looks at one. STOP.`);
    return;
  }
  console.log(`        screens present: ${screensInSet.join(', ')}  -> PASS`);

  for (const s of screensInSet) {
    const canonical = SCREENS.find((x) => lower(x) === lower(s)) || s;
    const learns = await knowsMove(key, canonical);
    console.log(`gate 2  knowsMove(${name}, "${canonical}") = ${learns}`);
    if (!learns) {
      console.log(`        -> learnset says no. Unless a teammate or a threat also runs`);
      console.log(`           ${canonical}, setters is empty and this is pushed to`);
      console.log(`           \`skipped\` with the message:`);
      console.log(`           "${canonical} — observed on ${name} in tournament data but absent`);
      console.log(`            from its learnset, and no Pokemon on either team can set it;`);
      console.log(`            not reported"`);
      console.log(`        -> THIS IS THE CLOSED GATE.`);
    } else {
      console.log(`        -> PASS. Gate 2 is not the problem for this screen.`);
    }
  }
}

(async () => {
  try {
    console.log(`--- pokemon_moves composition by move category ---`);
    const shape = await learnsetShape();
    if (shape.length === 0) {
      console.log(`  (query failed or table empty — pokemon_moves may not exist)`);
    }
    for (const r of shape) {
      console.log(`  ${String(r.category).padEnd(10)} ${String(r.learnset_rows).padStart(8)} rows across ${r.species} species`);
    }
    const hasStatus = shape.some((r) => lower(r.category) === 'status' && r.learnset_rows > 0);
    console.log(`\n  status moves present in learnset table: ${hasStatus}`);
    if (!hasStatus) {
      console.log(`  ** every status move on every species reads as "not in its learnset" **`);
      console.log(`  ** that silently kills all three screens, Tailwind, Trick Room, **`);
      console.log(`  ** Will-O-Wisp, Fake Out, Encore — anything without a power value. **`);
    }

    console.log(`\n--- screen moves in the \`moves\` table ---`);
    const rows = await screenMoveRows();
    if (rows.length === 0) console.log(`  none of the three screens exist in \`moves\` at all`);
    for (const r of rows) console.log(`  ${r.name.padEnd(14)} category=${r.category} power=${r.power} type=${r.type}`);
    for (const s of SCREENS) {
      if (!rows.some((r) => lower(r.name) === lower(s))) console.log(`  MISSING: ${s}`);
    }

    console.log(`\n--- screen learnset coverage (species per screen) ---`);
    const cov = await screenLearnsetCoverage();
    if (cov.length === 0) console.log(`  zero species have any screen in pokemon_moves`);
    for (const r of cov) console.log(`  ${r.name.padEnd(14)} ${r.species} species`);

    console.log(`\n--- species OBSERVED running a screen in tournament play ---`);
    const users = await observedScreenUsers();
    if (users.length === 0) {
      console.log(`  none — the dataset genuinely contains no screen users.`);
    } else {
      const bySpecies = new Map();
      for (const u of users) {
        if (!bySpecies.has(u.name)) bySpecies.set(u.name, []);
        bySpecies.get(u.name).push(`${u.move} x${u.count}`);
      }
      console.log(`  ${bySpecies.size} distinct species, ${users.reduce((s, u) => s + u.count, 0)} rows`);
      for (const [n, list] of [...bySpecies.entries()].slice(0, 20)) {
        console.log(`  ${n.padEnd(22)} ${list.join(', ')}`);
      }
    }

    const arg = process.argv[2];
    const targets = arg ? [arg] : [...new Set((await observedScreenUsers()).map((u) => u.name))].slice(0, 10);
    console.log(`\n--- gate trace ---`);
    for (const t of targets) await traceSpecies(t);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
