#!/usr/bin/env node
/**
 * add_missing_move.js — insert one move into `moves`, sourced from @pkmn/dex,
 * for a move seed.js's normal pass excludes (isNonstandard) but that is
 * legal and observed in this format's real tournament play.
 *
 * Light of Ruin is the first case: @pkmn/dex marks it isNonstandard="Past"
 * because it was a Gen 6 Diancie-event move, but it transfers via Home and
 * is fully legal (and played — 167 observed tournament rows) in Champions
 * Regulation M-B. The broad seed.js filter treats "not obtainable in a
 * fresh save" and "not legal in this format" as the same thing, which they
 * are not; rather than loosen that filter for everyone, moves that clear
 * this distinction get added one at a time, deliberately, here.
 *
 * Row shape comes from src/db/seed_moves.js — the same encoding seed.js
 * uses for every other row, not a hand-typed guess that could drift.
 *
 * Usage:
 *   node scripts\add_missing_move.js "Light of Ruin"
 */

const { Dex } = require('@pkmn/dex');
const pool = require('../src/db/pool');
const { insertMoveRow } = require('../src/db/seed_moves');

(async () => {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts\\add_missing_move.js "<move name>"');
    process.exitCode = 1;
    return;
  }
  try {
    const move = Dex.moves.get(name);
    if (!move.exists) {
      console.error(`@pkmn/dex has no move called "${name}"`);
      process.exitCode = 1;
      return;
    }
    console.log('--- dex data ---');
    console.log(JSON.stringify({
      name: move.name,
      isNonstandard: move.isNonstandard,
      type: move.type,
      category: move.category,
      basePower: move.basePower,
      accuracy: move.accuracy,
      pp: move.pp,
      priority: move.priority,
      recoil: move.recoil,
      flags: move.flags,
    }, null, 2));

    const existing = await pool.query('SELECT id FROM moves WHERE name = $1', [move.name]);
    if (existing.rows.length > 0) {
      console.log(`\nAlready present (moves.id=${existing.rows[0].id}) — nothing to do.`);
      return;
    }

    const id = await insertMoveRow(pool, move);
    console.log(id ? `\nInserted moves.id=${id}` : '\nInsert reported no id (unexpected — check ON CONFLICT).');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
