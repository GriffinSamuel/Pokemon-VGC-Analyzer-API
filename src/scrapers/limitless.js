const fetch = require('node-fetch');
const cron = require('node-cron');
const crypto = require('crypto');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { normalizeTeam } = require('../utils/normalize');
const { withRetry } = require('../utils/retry');
const { recordSuccess, recordFailure } = require('../utils/health');

const API = 'https://play.limitlesstcg.com/api';

function isChampionsMB(tournament) {
  const name = tournament.name.toLowerCase();
  return (
    name.includes('m-b') &&
    !name.includes('smogon') &&
    !name.includes('showdown') &&
    tournament.players >= 16
  );
}

function hashTeam(decklist) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(decklist))
    .digest('hex')
    .substring(0, 64);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJSON(url, label) {
  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res.json();
    },
    { label, retries: 3, baseDelay: 1000 }
  );
}

async function scrape() {
  logger.info('Scraper started');
  try {
    const tournaments = await fetchJSON(
      `${API}/tournaments?game=VGC&limit=100`,
      'fetch tournaments'
    );

    const mbTournaments = tournaments.filter(isChampionsMB);
    logger.info(`Found ${mbTournaments.length} Champions M-B tournaments`);

    for (const tournament of mbTournaments) {
      try {
        const details = await fetchJSON(
          `${API}/tournaments/${tournament.id}/details`,
          `fetch details for ${tournament.id}`
        );

        if (!details.decklists) {
          logger.info(`Skipping ${tournament.name} - no team submissions`);
          await sleep(300);
          continue;
        }

        const standings = await fetchJSON(
          `${API}/tournaments/${tournament.id}/standings`,
          `fetch standings for ${tournament.id}`
        );

        const cutoff = Math.ceil(tournament.players / 2);
        const topPlayers = standings.filter(
          p => p.placing && p.placing <= cutoff && p.decklist
        );

        let inserted = 0;
        for (const player of topPlayers) {
          const normalizedDecklist = normalizeTeam(player.decklist);
          const teamHash = hashTeam(player.decklist);

          try {
            const result = await pool.query(
              `INSERT INTO tournament_teams
               (tournament_id, tournament_name, tournament_date, player_name,
                placement, wins, losses, team_hash, pokemon)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (team_hash) DO NOTHING`,
              [
                tournament.id,
                tournament.name,
                tournament.date.split('T')[0],
                player.name,
                player.placing,
                player.record?.wins || 0,
                player.record?.losses || 0,
                teamHash,
                JSON.stringify(normalizedDecklist)
              ]
            );
            if (result.rowCount > 0) inserted++;
          } catch (err) {
            logger.error('Failed to insert team', {
              player: player.name,
              error: err.message
            });
          }
        }

        logger.info(`${tournament.name}: ${inserted} new teams inserted`);
        await sleep(500);

      } catch (err) {
        logger.error(`Failed to process tournament`, {
          tournament: tournament.name,
          error: err.message
        });
        await sleep(1000);
      }
    }

    await recordSuccess('limitless-scraper');
    logger.info('Scrape complete');
  } catch (err) {
    await recordFailure('limitless-scraper', err.message);
    logger.error('Scraper failed', { error: err.message });
  }
}

scrape();

cron.schedule('0 * * * *', () => {
  logger.info('Hourly scrape triggered');
  scrape();
});

module.exports = { scrape };