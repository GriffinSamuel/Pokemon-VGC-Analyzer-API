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
 *                pokemon_moves (now well-populated — see the earlier
 *                pokemon_moves rebuild). If ability alone leaves exactly a
 *                base/-F gender-variant pair (Basculegion/Basculegion-F,
 *                Indeedee/Indeedee-F, etc.), the row's own m/f bucket breaks
 *                the tie — that is information already recovered by the
 *                parser fix, not a guess.
 *   UNRESOLVED — anything else. Counted and printed, never guessed, never
 *                silently dropped.
 *
 * Dry-run by default: computes and reports every resolution, writes nothing.
 * Pass --apply to UPDATE the EXACT and INFERENCE rows in place (UNRESOLVED
 * rows are never written, in any mode).
 *
 * Usage:
 *   node scripts\repair_orphan_species.js            (report only)
 *   node scripts\repair_orphan_species.js --apply     (report AND write)
 */

const pool = require('../src/db/pool');
const { MEGA_ITEM_MAP } = require('../src/utils/normalize');

const lower = (s) => String(s || '').toLowerCase();

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

function resolveByAbilityAndMoveset(orphan, pokemonRows, learnsets) {
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

  let pool_ = movesetCandidates.length > 0 ? movesetCandidates : abilityCandidates;
  if (movesetCandidates.length === 0) {
    // Ability matched but moveset didn't confirm anyone — do not silently
    // fall back to the (weaker) ability-only candidate set as if it were
    // equally confident.
    return { status: 'unresolved', reason: `ability "${orphan.p.ability}" matched ${abilityCandidates.length} species but none has all 4 observed moves in its learnset` };
  }

  if (pool_.length === 1) return { status: 'inference', species: pool_[0].name, reason: 'ability + moveset uniquely identify it' };

  // Multiple survivors: only accept if they are all gender-variant forms of
  // the same species stem — then the row's own m/f bucket (real information
  // recovered by the parser fix) breaks the tie.
  const stems = new Set(pool_.map((row) => genderStem(row.name)));
  if (stems.size === 1) {
    const wantSuffix = orphan.bucket === 'f' ? '-f' : null; // male forms in this table are typically the bare name, not "-m"
    const genderMatch = pool_.find((row) => (wantSuffix ? lower(row.name).endsWith(wantSuffix) : !lower(row.name).endsWith('-f')));
    if (genderMatch) return { status: 'inference', species: genderMatch.name, reason: `ability + moveset narrowed to a gender-variant pair, broken by the row's own "${orphan.bucket}" bucket` };
  }

  return { status: 'unresolved', reason: `ability + moveset narrowed to ${pool_.length} species (${pool_.map((r) => r.name).join(', ')}), not a single confident answer` };
}

function resolveOrphan(orphan, pokemonRows, learnsets) {
  const itemLower = lower(orphan.p.item);
  if (itemLower && MEGA_ITEM_MAP[itemLower]) {
    return { status: 'exact', species: MEGA_ITEM_MAP[itemLower], reason: `held item "${orphan.p.item}" is a Mega Stone` };
  }
  return resolveByAbilityAndMoveset(orphan, pokemonRows, learnsets);
}

(async () => {
  const apply = process.argv.includes('--apply');
  try {
    const orphans = await findOrphans();
    const pokemonRows = await loadPokemonTable();
    const learnsets = await loadLearnsetSets();

    console.log(`${orphans.length} orphaned pokemon entries found across their team rows.\n`);

    const exact = [];
    const inference = [];
    const unresolved = [];

    for (const orphan of orphans) {
      const result = resolveOrphan(orphan, pokemonRows, learnsets);
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

    console.log('\nApplying EXACT and INFERENCE resolutions...');
    let written = 0;
    for (const r of [...exact, ...inference]) {
      const result = await pool.query(
        `UPDATE tournament_teams
            SET pokemon = jsonb_set(
              jsonb_set(pokemon, ARRAY[$2::text, 'name'], to_jsonb($3::text)),
              ARRAY[$2::text, 'normalizedName'], to_jsonb($3::text)
            )
          WHERE id = $1`,
        [r.teamId, String(r.idx), r.result.species]
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
