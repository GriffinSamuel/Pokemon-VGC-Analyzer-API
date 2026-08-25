const { Dex } = require('@pkmn/dex');
const pool = require('./pool');
const { seedLearnsets } = require('./seed_learnsets');
const { insertMoveRow } = require('./seed_moves');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Seeding abilities...');
    for (const ability of Dex.abilities.all()) {
      if (!ability.exists || ability.isNonstandard) continue;
      await client.query(
        `INSERT INTO abilities (name, description)
         VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [ability.name, ability.desc || ability.shortDesc || '']
      );
    }

    console.log('Seeding moves...');
    for (const move of Dex.moves.all()) {
      if (!move.exists || move.isNonstandard) continue;
      await insertMoveRow(client, move);
    }

    console.log('Seeding pokemon...');
    for (const species of Dex.species.all()) {
      if (!species.exists || species.isNonstandard) continue;
      await client.query(
        `INSERT INTO pokemon (name, num, type1, type2, hp, atk, def, spa, spd, spe,
                              ability1, ability2, ability_hidden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (name) DO NOTHING`,
        [
          species.name,
          species.num,
          species.types[0] || null,
          species.types[1] || null,
          species.baseStats.hp,
          species.baseStats.atk,
          species.baseStats.def,
          species.baseStats.spa,
          species.baseStats.spd,
          species.baseStats.spe,
          species.abilities['0'] || null,
          species.abilities['1'] || null,
          species.abilities['H'] || null,
        ]
      );
    }

    console.log('Seeding learnsets (this may take a minute)...');
    const { inserted, dropped } = await seedLearnsets(client);
    console.log(`  ${inserted} pokemon_moves rows inserted/confirmed`);
    if (dropped.size > 0) {
      const total = [...dropped.values()].reduce((a, b) => a + b, 0);
      console.log(`  ${total} learnset keys had no matching moves row, across ${dropped.size} distinct dex move ids (never silently truncate):`);
      for (const [id, c] of [...dropped.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${id.padEnd(24)} x${c}`);
      }
    }

    await client.query('COMMIT');
    console.log('✅ Seed complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err);
  } finally {
    client.release();
    pool.end();
  }
}

seed();