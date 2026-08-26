#!/usr/bin/env node
/**
 * normalize_stored_moves.js — rewrite already-stored `attacks` strings in
 * tournament_teams to their canonical display form.
 *
 * normalizeMoveName() (src/utils/normalize.js) already stops new bad rows at
 * both ingestion points (normalizeTeam(), used by both the Limitless and
 * VGCPastes/raw-text pipelines) but was never run over what is already
 * stored. This does that, once, as a standalone re-runnable pass.
 *
 * For every DISTINCT observed attacks string, Dex.moves.get(name) is asked
 * for the canonical form. Dex.moves.get() normalises via toID() internally,
 * so it is a no-op for an already-correct display name ("Protect" stays
 * "Protect") and a real fix for an ID-style or mis-cased string ("protect",
 * "trickroom", "WIDE GUARD" all resolve to their one canonical form). A
 * genuine typo the dex does not recognise ("Solat Beam") is left completely
 * alone and reported separately — there is no safe way to guess what it
 * meant.
 *
 * Dry-run by default: computes and reports every rewrite, writes nothing.
 * Pass --apply to UPDATE every occurrence of a resolved, differing string.
 *
 * MARKER DISCIPLINE, same reasoning as repair_orphan_species.js: an --apply
 * writes a positional revert record (team_id, pokemon array index, attack
 * array index, original string) to logs/normalize_stored_moves_revert.json
 * BEFORE any UPDATE runs. Unlike the orphan repair, individual `attacks`
 * entries are bare strings inside a JSON array, not objects -- there is
 * nowhere to attach an in-row "repairedFrom"-style marker without changing
 * the array's shape, which would be its own footgun for every other reader
 * of `attacks`. The positional record is therefore the ONLY undo path here,
 * not a belt-and-braces second one -- treat it as load-bearing. No value
 * predicate is used to detect a prior run: this operation is naturally
 * idempotent (a canonical string dex-resolves to itself, so a second run
 * over already-normalized data finds zero rewrites) and carries none of the
 * orphan repair's self-reinforcing usage-prior risk, so no --force-rerun
 * guard is needed.
 *
 * Usage:
 *   node scripts\normalize_stored_moves.js              (report only)
 *   node scripts\normalize_stored_moves.js --apply       (report AND write)
 *   node scripts\normalize_stored_moves.js --revert       (undo a prior --apply)
 */

const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const { Dex } = require('@pkmn/dex');

const REVERT_LOG_PATH = path.join('logs', 'normalize_stored_moves_revert.json');
const UNRESOLVABLE_PATH = path.join('logs', 'unresolvable_move_names.md');

async function loadDistinctMoveStrings() {
  const { rows } = await pool.query(`
    SELECT a.val AS move_string, COUNT(*)::int AS cnt
      FROM tournament_teams t,
           jsonb_array_elements(t.pokemon) p,
           jsonb_array_elements_text(p->'attacks') AS a(val)
     GROUP BY 1
     ORDER BY 1
  `);
  return rows;
}

async function loadAllPositions(moveStrings) {
  // Every (team_id, pokemon_idx, attack_idx) occurrence of any string in the
  // given set, so --apply can target exact positions rather than relying on
  // string matching at write time (which would corrupt sibling entries that
  // happen to share text after a partial rewrite).
  if (moveStrings.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT t.id AS team_id, (p.ord - 1) AS pokemon_idx, (a.ord - 1) AS attack_idx, a.val AS move_string
       FROM tournament_teams t,
            jsonb_array_elements(t.pokemon) WITH ORDINALITY AS p(elem, ord),
            jsonb_array_elements_text(p.elem->'attacks') WITH ORDINALITY AS a(val, ord)
      WHERE a.val = ANY($1::text[])`,
    [moveStrings]
  );
  return rows;
}

function classify(distinctRows) {
  const rewrites = []; // { from, to, count }
  const unresolvable = []; // { name, count }
  for (const r of distinctRows) {
    const move = Dex.moves.get(r.move_string);
    if (!move?.exists) {
      unresolvable.push({ name: r.move_string, count: r.cnt });
      continue;
    }
    if (move.name !== r.move_string) {
      rewrites.push({ from: r.move_string, to: move.name, count: r.cnt });
    }
  }
  return { rewrites, unresolvable };
}

async function revertNormalization() {
  if (!fs.existsSync(REVERT_LOG_PATH)) {
    console.log(`No revert record at ${REVERT_LOG_PATH} -- nothing to revert.`);
    return;
  }
  const records = JSON.parse(fs.readFileSync(REVERT_LOG_PATH, 'utf8'));
  console.log(`${records.length} positions recorded. Reverting...`);
  // A bare string in a JSON array has nowhere to carry a "this is ours"
  // marker the way repairedFrom does for the orphan repair -- this record
  // IS the only signal of what this script touched. That makes an unchecked
  // write dangerous: if anything else modified this exact position between
  // --apply and --revert (a re-scrape overwriting the row, a manual fix,
  // another tool), blindly restoring originalString would silently clobber
  // whatever is there now. Read the current value first and only revert if
  // it still matches what this script wrote -- "not ours to touch anymore"
  // is a skip, not a write.
  let reverted = 0;
  let skipped = 0;
  const driftDetails = [];
  for (const r of records) {
    const { rows: currentRows } = await pool.query(
      `SELECT pokemon #>> ARRAY[$2::text, 'attacks', $3::text] AS current_val
         FROM tournament_teams WHERE id = $1`,
      [r.teamId, String(r.pokemonIdx), String(r.attackIdx)]
    );
    const currentVal = currentRows[0]?.current_val;
    if (currentVal !== r.rewrittenTo) {
      skipped++;
      driftDetails.push({ ...r, currentVal });
      continue;
    }
    const result = await pool.query(
      `UPDATE tournament_teams
          SET pokemon = jsonb_set(
                pokemon,
                ARRAY[$2::text, 'attacks', $3::text],
                to_jsonb($4::text)
              )
        WHERE id = $1`,
      [r.teamId, String(r.pokemonIdx), String(r.attackIdx), r.originalString]
    );
    if (result.rowCount > 0) reverted++;
  }
  console.log(`${reverted} positions reverted.`);
  console.log(`${skipped} positions skipped because the position had drifted (current value no longer matches what this script wrote).`);
  if (driftDetails.length > 0) {
    console.log('\n--- drifted positions, not touched ---');
    for (const d of driftDetails) {
      console.log(`  team ${d.teamId} [${d.pokemonIdx}].attacks[${d.attackIdx}]: expected "${d.rewrittenTo}" (would revert to "${d.originalString}"), found "${d.currentVal}"`);
    }
  }
}

(async () => {
  const apply = process.argv.includes('--apply');
  const revert = process.argv.includes('--revert');

  try {
    if (revert) {
      await revertNormalization();
      return;
    }

    const distinct = await loadDistinctMoveStrings();
    console.log(`${distinct.length} distinct observed attacks strings in tournament_teams.\n`);

    const { rewrites, unresolvable } = classify(distinct);

    console.log(`REWRITES (resolves, canonical form differs):  ${rewrites.length}`);
    console.log(`UNRESOLVABLE (dex does not recognise):        ${unresolvable.length}`);

    console.log('\n--- rewrites ---');
    for (const r of rewrites) console.log(`  "${r.from}" -> "${r.to}"  (${r.count} rows)`);

    console.log('\n--- unresolvable (reported, left alone) ---');
    for (const u of unresolvable) console.log(`  "${u.name}"  (${u.count} rows)`);

    if (!fs.existsSync('logs')) fs.mkdirSync('logs');
    const totalRewriteRows = rewrites.reduce((n, r) => n + r.count, 0);
    const reportLines = [
      `${distinct.length} distinct observed attacks strings in tournament_teams.`,
      '',
      `REWRITES (resolves, canonical form differs): ${rewrites.length} distinct strings, ${totalRewriteRows} rows`,
      `UNRESOLVABLE (dex does not recognise):        ${unresolvable.length} distinct strings`,
      '',
      '--- rewrites, full list ---',
      ...rewrites.map((r) => `  "${r.from}" -> "${r.to}"  (${r.count} rows)`),
      '',
      '--- unresolvable, full list ---',
      ...unresolvable.map((u) => `  "${u.name}"  (${u.count} rows)`),
    ];
    const reportFileName = apply ? 'normalize_stored_moves_apply.log' : 'normalize_stored_moves_dryrun.log';
    fs.writeFileSync(path.join('logs', reportFileName), reportLines.join('\n') + '\n');
    console.log(`\nFull report saved to logs/${reportFileName}`);

    const unresolvableMd = [
      '# Unresolvable stored move names',
      '',
      'These `attacks` strings in `tournament_teams` do not resolve through `Dex.moves.get()`.',
      'They are reported and left alone -- there is no safe way to guess what a typo meant, and',
      '`normalize_stored_moves.js` never rewrites anything it cannot confidently resolve.',
      '',
      '| Move string | Row count |',
      '|---|---|',
      ...unresolvable.map((u) => `| ${u.name} | ${u.count} |`),
    ];
    fs.writeFileSync(UNRESOLVABLE_PATH, unresolvableMd.join('\n') + '\n');
    console.log(`Unresolvable list saved to ${UNRESOLVABLE_PATH}`);

    if (!apply) {
      console.log('\nDry run — nothing written. Re-run with --apply to write the rewrites.');
      return;
    }

    const rewriteStrings = rewrites.map((r) => r.from);
    const positions = await loadAllPositions(rewriteStrings);
    const rewriteMap = new Map(rewrites.map((r) => [r.from, r.to]));

    const revertRecord = positions.map((p) => ({
      teamId: p.team_id,
      pokemonIdx: p.pokemon_idx,
      attackIdx: p.attack_idx,
      originalString: p.move_string,
      rewrittenTo: rewriteMap.get(p.move_string),
      rewrittenAt: new Date().toISOString(),
    }));
    fs.writeFileSync(REVERT_LOG_PATH, JSON.stringify(revertRecord, null, 2));
    console.log(`\nRevert record written to ${REVERT_LOG_PATH} (${revertRecord.length} positions).`);

    console.log('Applying rewrites...');
    let written = 0;
    for (const p of positions) {
      const to = rewriteMap.get(p.move_string);
      const result = await pool.query(
        `UPDATE tournament_teams
            SET pokemon = jsonb_set(
                  pokemon,
                  ARRAY[$2::text, 'attacks', $3::text],
                  to_jsonb($4::text)
                )
          WHERE id = $1`,
        [p.team_id, String(p.pokemon_idx), String(p.attack_idx), to]
      );
      if (result.rowCount > 0) written++;
    }
    console.log(`${written} positions updated.`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
