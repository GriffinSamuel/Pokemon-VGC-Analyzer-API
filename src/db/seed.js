const { Dex } = require('@pkmn/dex');
const pool = require('./pool');

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
      await client.query(
        `INSERT INTO moves (name, type, category, power, accuracy, pp, priority, flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (name) DO NOTHING`,
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
          })
        ]
      );
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
    for (const species of Dex.species.all()) {
      if (!species.exists || species.isNonstandard) continue;

      const learnset = await Dex.learnsets.get(species.name);
      if (!learnset?.learnset) continue;

      const pkmnRow = await client.query(
        'SELECT id FROM pokemon WHERE name = $1', [species.name]
      );
      if (!pkmnRow.rows.length) continue;
      const pokemonId = pkmnRow.rows[0].id;

      for (const moveName of Object.keys(learnset.learnset)) {
        const moveRow = await client.query(
          'SELECT id FROM moves WHERE LOWER(name) = LOWER($1)', [moveName]
        );
        if (!moveRow.rows.length) continue;
        await client.query(
          `INSERT INTO pokemon_moves (pokemon_id, move_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [pokemonId, moveRow.rows[0].id]
        );
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