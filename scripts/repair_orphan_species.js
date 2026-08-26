#!/usr/bin/env node
/**
 * repair_orphan_species.js — resolve the 334 tournament_teams rows stranded
 * under the literal species "M" or "F" by the gender-marker parser bug
 * (fixed in parsePokemonBlock, HANDOFF_data_integrity_step3.md item 3).
 *
 * tournament_teams has no raw-paste-text column (checked: id, tournament_id,
 * tournament_name, tournament_date, player_name, placement, wins, losses,
 * team_hash, pokemon, scraped_at — nothing else), so exact re-parsing is not
 * possible. Every other field on the row (item, ability, attacks, evs,
 * nature) survived the bug untouched — only the species-name regex was
 * broken — so species is inferred from those.
 *
 * Two confidence tiers, and a third bucket for what doesn't resolve:
 *
 *   EXACT      — the held item is a Mega Stone (MEGA_ITEM_MAP), the same
 *                mechanism normalizePokemonName() already uses for a
 *                correctly-parsed row. As certain as any Mega row ever is.
 *   INFERENCE  — the ability uniquely narrows to one species AND every one
 *                of the row's 4 observed attacks is in that species'
 *                pokemon_moves, AND (see loadUsageCounts below) at least one
 *                surviving candidate has independent usage elsewhere in the
 *                dataset. If ability alone leaves exactly a base/-F
 *                gender-variant pair (Basculegion/Basculegion-F, Indeedee/
 *                Indeedee-F, etc.), the row's own m/f bucket breaks the tie
 *                — that is information already recovered by the parser fix,
 *                not a guess.
 *   UNRESOLVED — anything else. Counted and printed, never guessed, never
 *                silently dropped.
 *
 * Dry-run by default: computes and reports every resolution, writes nothing.
 * Pass --apply to UPDATE the EXACT and INFERENCE rows in place (UNRESOLVED
 * rows are never written, in any mode).
 *
 * MARKER, NOT PREDICATE — an --apply write also sets a "repairedFrom" key
 * on the touched pokemon element, holding its pre-repair {name,
 * normalizedName}. This project's Mega Stone rescue path
 * (normalizePokemonName's MEGA_ITEM_MAP branch) independently produces rows
 * whose raw scraped `id` is *also* literally "m"/"f" but whose `name` is a
 * real species — 133 of them exist right now, on a totally clean database.
 * A predicate like `id IN ('m','f') AND name NOT IN ('m','f')` cannot tell
 * those apart from a row this script wrote, so it must never be used to
 * detect a prior run or to revert one — an earlier version of this file did
 * exactly that and it was wrong. The explicit `repairedFrom` key has no
 * such collision: nothing else in the pipeline writes it.
 *
 * Usage:
 *   node scripts\repair_orphan_species.js              (report only)
 *   node scripts\repair_orphan_species.js --apply       (report AND write)
 *   node scripts\repair_orphan_species.js --apply --force-rerun
 *                                                        (see guard below)
 *   node scripts\repair_orphan_species.js --revert       (undo a prior --apply)
 */

const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const { MEGA_ITEM_MAP } = require('../src/utils/normalize');

const lower = (s) => String(s || '').toLowerCase();
const REVERT_LOG_PATH = path.join('logs', 'repair_orphan_species_revert.json');

async function findOrphans() {
  const { rows } = await pool.query(`
    SELECT id, pokemon
      FROM tournament_teams
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(pokemon) p
        WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) IN ('m','f')
     )
  `);
  // Flatten to individual orphan pokemon entries, keeping the parent team row
  // id and array index so a resolved entry can be written back precisely.
  const orphans = [];
  for (const row of rows) {
    row.pokemon.forEach((p, idx) => {
      const key = lower(p.normalizedName || p.name);
      if (key === 'm' || key === 'f') orphans.push({ teamId: row.id, idx, p, bucket: key });
    });
  }
  return orphans;
}

async function loadPokemonTable() {
  const { rows } = await pool.query('SELECT id, name, ability1, ability2, ability_hidden FROM pokemon');
  return rows;
}

/**
 * Independent usage prior: how many times each species appears in
 * tournament_teams via a genuine (non-orphan) parse. At the point this runs,
 * every still-unresolved orphan's own species field is still literally
 * "m"/"f" -- never the candidate species itself -- so this count already
 * excludes every row this script could possibly be about to touch, with no
 * extra filtering needed.
 *
 * Added after a live miss: ability+moveset alone picked "Impidimp" 26 times
 * with zero independent usage anywhere in the dataset (Impidimp does not see
 * competitive play; every occurrence was this bug). The tie was really being
 * broken by a hole in pokemon_moves, not by evidence.
 *
 * SELF-REINFORCEMENT WARNING: this count reads tournament_teams -- the same
 * table this script writes to. On a clean database (checked once per run by
 * countRepairedRows(), below) that is fine. On a SECOND run over rows this
 * script already resolved, a species' usage count here would include rows
 * THIS SCRIPT itself wrote on the prior run, so a future tie would be
 * decided by our own earlier inference rather than by independent evidence.
 * That is exactly the contamination the --force-rerun guard exists to catch.
 */
async function loadUsageCounts() {
  const { rows } = await pool.query(`
    SELECT COALESCE(elem->>'normalizedName', elem->>'name') AS species, COUNT(*) AS cnt
      FROM tournament_teams t, jsonb_array_elements(t.pokemon) elem
     GROUP BY 1
  `);
  const map = new Map();
  for (const r of rows) map.set(lower(r.species), parseInt(r.cnt, 10));
  return map;
}

/**
 * Rows already carrying the "repairedFrom" marker from a prior --apply.
 * This is the ONLY thing that identifies a prior run -- see the file-level
 * comment on why a value-based predicate (id/name mismatch) cannot be used
 * for this instead.
 */
async function countRepairedRows() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS cnt
      FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
     WHERE p ? 'repairedFrom'
  `);
  return rows[0].cnt;
}

async function loadLearnsetSets() {
  // species name (lowercased) -> Set of move names (lowercased) it can learn.
  const { rows } = await pool.query(`
    SELECT p.name AS species, m.name AS move
      FROM pokemon_moves pm
      JOIN pokemon p ON p.id = pm.pokemon_id
      JOIN moves m ON m.id = pm.move_id
  `);
  const map = new Map();
  for (const r of rows) {
    const key = lower(r.species);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(lower(r.move));
  }
  return map;
}

/** Species sharing the same stem, differing only by a trailing "-F"/"-M". */
function genderStem(name) {
  return lower(name).replace(/-f$|-m$/, '');
}

function resolveByAbilityAndMoveset(orphan, pokemonRows, learnsets, usageCounts) {
  const ability = lower(orphan.p.ability);
  if (!ability) return { status: 'unresolved', reason: 'no ability on the row to match against' };

  const abilityCandidates = pokemonRows.filter((row) => [row.ability1, row.ability2, row.ability_hidden]
    .some((a) => lower(a) === ability));
  if (abilityCandidates.length === 0) return { status: 'unresolved', reason: `ability "${orphan.p.ability}" matches no species` };

  const attacks = (orphan.p.attacks || []).map(lower).filter(Boolean);
  const movesetCandidates = abilityCandidates.filter((row) => {
    const known = learnsets.get(lower(row.name));
    if (!known) return false;
    return attacks.every((a) => known.has(a));
  });

  if (movesetCandidates.length === 0) {
    // Ability matched but moveset didn't confirm anyone — do not silently
    // fall back to the (weaker) ability-only candidate set as if it were
    // equally confident.
    return { status: 'unresolved', reason: `ability "${orphan.p.ability}" matched ${abilityCandidates.length} species but none has all 4 observed moves in its learnset` };
  }

  // Usage prior: a candidate this dataset never independently plays is not a
  // credible answer, however cleanly its ability+moveset matched — that's
  // exactly how "Impidimp" (0 independent usage) beat "Grimmsnarl" (236) 26
  // times. Prefer candidates with real usage; only fall back to the full
  // (zero-usage) pool if literally nothing survives, so the reason for that
  // is visible rather than silently resolving to a ghost.
  const withUsage = movesetCandidates.filter((row) => (usageCounts.get(lower(row.name)) || 0) > 0);
  const usageNarrowed = withUsage.length > 0 && withUsage.length < movesetCandidates.length;
  if (withUsage.length === 0) {
    return { status: 'unresolved', reason: `ability + moveset matched ${movesetCandidates.length} species (${movesetCandidates.map((r) => r.name).join(', ')}) but none has any independent usage elsewhere in tournament_teams` };
  }
  const pool_ = withUsage;

  if (pool_.length === 1) {
    return {
      status: 'inference',
      species: pool_[0].name,
      reason: usageNarrowed
        ? `ability + moveset matched ${movesetCandidates.length} species; only "${pool_[0].name}" has independent usage elsewhere in tournament_teams (${usageCounts.get(lower(pool_[0].name))})`
        : 'ability + moveset uniquely identify it',
    };
  }

  // Multiple survivors: only accept if they are all gender-variant forms of
  // the same species stem — then the row's own m/f bucket (real information
  // recovered by the parser fix) breaks the tie.
  const stems = new Set(pool_.map((row) => genderStem(row.name)));
  if (stems.size === 1) {
    const wantSuffix = orphan.bucket === 'f' ? '-f' : null; // male forms in this table are typically the bare name, not "-m"
    const genderMatch = pool_.find((row) => (wantSuffix ? lower(row.name).endsWith(wantSuffix) : !lower(row.name).endsWith('-f')));
    if (genderMatch) return { status: 'inference', species: genderMatch.name, reason: `ability + moveset narrowed to a gender-variant pair, broken by the row's own "${orphan.bucket}" bucket` };
  }

  return { status: 'unresolved', reason: `ability + moveset + usage narrowed to ${pool_.length} species (${pool_.map((r) => r.name).join(', ')}), not a single confident answer` };
}

function resolveOrphan(orphan, pokemonRows, learnsets, usageCounts) {
  const itemLower = lower(orphan.p.item);
  if (itemLower && MEGA_ITEM_MAP[itemLower]) {
    return { status: 'exact', species: MEGA_ITEM_MAP[itemLower], reason: `held item "${orphan.p.item}" is a Mega Stone` };
  }
  return resolveByAbilityAndMoveset(orphan, pokemonRows, learnsets, usageCounts);
}

/**
 * Undo every row carrying a "repairedFrom" marker: restore name and
 * normalizedName from the marker's own payload, then remove the marker.
 * This is the executed, tested undo path — not a SQL snippet someone has to
 * reconstruct from a commit message.
 */
async function revertRepairs() {
  const { rows } = await pool.query(`
    SELECT t.id AS team_id, (ord - 1) AS idx, p->'repairedFrom'->>'name' AS orig_name,
           p->'repairedFrom'->>'normalizedName' AS orig_normalized_name
      FROM tournament_teams t,
           jsonb_array_elements(t.pokemon) WITH ORDINALITY AS arr(p, ord)
     WHERE p ? 'repairedFrom'
  `);

  console.log(`${rows.length} rows carry a "repairedFrom" marker. Reverting...`);
  let reverted = 0;
  for (const r of rows) {
    const result = await pool.query(
      `UPDATE tournament_teams
          SET pokemon = jsonb_set(
                jsonb_set(
                  pokemon #- ARRAY[$2::text, 'repairedFrom'],
                  ARRAY[$2::text, 'name'], to_jsonb($3::text)
                ),
                ARRAY[$2::text, 'normalizedName'], to_jsonb($4::text)
              )
        WHERE id = $1`,
      [r.team_id, String(r.idx), r.orig_name, r.orig_normalized_name]
    );
    if (result.rowCount > 0) reverted++;
  }
  console.log(`${reverted} team rows reverted.`);
  return reverted;
}

(async () => {
  const apply = process.argv.includes('--apply');
  const forceRerun = process.argv.includes('--force-rerun');
  const revert = process.argv.includes('--revert');

  try {
    if (revert) {
      await revertRepairs();
      return;
    }

    // Contamination guard: repairedFrom is the only reliable signal that a
    // prior --apply already ran. If it has, loadUsageCounts() below would be
    // reading species counts partly produced by this script's own earlier
    // inference, not independent tournament evidence. Refuse to proceed
    // silently.
    const repairedCount = await countRepairedRows();
    if (repairedCount > 0) {
      console.log('='.repeat(78));
      console.log(`WARNING: ${repairedCount} rows already carry a "repairedFrom" marker from a prior repair run.`);
      console.log('The usage prior this script relies on counts species occurrences across');
      console.log('tournament_teams, which now includes those already-resolved rows — so a tie');
      console.log('today would be decided by our own earlier inference, not independent evidence.');
      console.log('='.repeat(78));
      if (!forceRerun) {
        console.log('Refusing to proceed. Re-run with --force-rerun to continue anyway.');
        process.exitCode = 1;
        return;
      }
      console.log('--force-rerun passed: proceeding despite the contaminated usage prior.');
    }

    const orphans = await findOrphans();
    const pokemonRows = await loadPokemonTable();
    const learnsets = await loadLearnsetSets();
    const usageCounts = await loadUsageCounts();

    console.log(`${orphans.length} orphaned pokemon entries found across their team rows.\n`);

    const exact = [];
    const inference = [];
    const unresolved = [];

    for (const orphan of orphans) {
      const result = resolveOrphan(orphan, pokemonRows, learnsets, usageCounts);
      const record = { ...orphan, result };
      if (result.status === 'exact') exact.push(record);
      else if (result.status === 'inference') inference.push(record);
      else unresolved.push(record);
    }

    console.log(`EXACT (Mega Stone item):      ${exact.length}`);
    console.log(`INFERENCE (ability+moveset):  ${inference.length}`);
    console.log(`UNRESOLVED (left as-is):      ${unresolved.length}`);

    console.log('\n--- EXACT resolutions ---');
    for (const r of exact) console.log(`  team ${r.teamId} [${r.idx}]: ${r.bucket.toUpperCase()} -> ${r.result.species}  (${r.result.reason})`);

    console.log('\n--- INFERENCE resolutions ---');
    for (const r of inference) console.log(`  team ${r.teamId} [${r.idx}]: ${r.bucket.toUpperCase()} -> ${r.result.species}  ability=${r.p.ability}  (${r.result.reason})`);

    console.log('\n--- UNRESOLVED (counted, not guessed) ---');
    for (const r of unresolved) console.log(`  team ${r.teamId} [${r.idx}]: ${r.bucket.toUpperCase()}  ability=${r.p.ability}  item=${r.p.item}  attacks=${JSON.stringify(r.p.attacks)}  (${r.result.reason})`);

    if (!apply) {
      console.log('\nDry run — nothing written. Re-run with --apply to write EXACT and INFERENCE resolutions.');
      return;
    }

    const toWrite = [...exact, ...inference];

    // Belt and braces: an independent, predicate-free revert record, written
    // BEFORE any UPDATE runs. If the repairedFrom marker approach turns out
    // to have a flaw, this file is a positional (team_id, idx) record that
    // does not depend on any inferred pattern in the data.
    if (!fs.existsSync('logs')) fs.mkdirSync('logs');
    const revertRecord = toWrite.map((r) => ({
      teamId: r.teamId,
      idx: r.idx,
      originalName: r.p.name,
      originalNormalizedName: r.p.normalizedName,
      resolvedSpecies: r.result.species,
      resolvedAt: new Date().toISOString(),
    }));
    fs.writeFileSync(REVERT_LOG_PATH, JSON.stringify(revertRecord, null, 2));
    console.log(`\nRevert record written to ${REVERT_LOG_PATH} (${revertRecord.length} rows).`);

    console.log('Applying EXACT and INFERENCE resolutions...');
    let written = 0;
    for (const r of toWrite) {
      const marker = JSON.stringify({ name: r.p.name, normalizedName: r.p.normalizedName });
      const result = await pool.query(
        `UPDATE tournament_teams
            SET pokemon = jsonb_set(
                  jsonb_set(
                    jsonb_set(pokemon, ARRAY[$2::text, 'name'], to_jsonb($3::text)),
                    ARRAY[$2::text, 'normalizedName'], to_jsonb($3::text)
                  ),
                  ARRAY[$2::text, 'repairedFrom'], $4::jsonb
                )
          WHERE id = $1`,
        [r.teamId, String(r.idx), r.result.species, marker]
      );
      if (result.rowCount > 0) written++;
    }
    console.log(`${written} team rows updated.`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
