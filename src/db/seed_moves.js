/**
 * seed_moves.js — the exact column mapping from an @pkmn/dex Move object to
 * a `moves` table row.
 *
 * Extracted out of seed.js's moves-seeding loop so a move added outside the
 * normal full-seed pass (e.g. scripts/add_missing_move.js, for a move the
 * broad isNonstandard filter excluded even though it's legal and observed in
 * this format) is byte-for-byte the same shape as every row seed.js already
 * inserted — not a hand-typed row that drifts from the rest of the table.
 */

/**
 * @param {import('pg').Pool | import('pg').PoolClient} client
 * @param {import('@pkmn/dex').Move} move
 * @returns {Promise<number|null>} the inserted row's id, or null if it
 *   already existed (ON CONFLICT DO NOTHING) or was skipped.
 */
async function insertMoveRow(client, move) {
  const { rows } = await client.query(
    `INSERT INTO moves (name, type, category, power, accuracy, pp, priority, flags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [
      move.name,
      move.type,
      move.category,
      move.basePower || null,
      move.accuracy === true ? 100 : move.accuracy || null,
      move.pp,
      move.priority || 0,
      JSON.stringify({
        contact: !!move.flags?.contact,
        recoil: move.recoil || null,
        drain: move.drain || null,
      }),
    ]
  );
  return rows[0]?.id ?? null;
}

module.exports = { insertMoveRow };
