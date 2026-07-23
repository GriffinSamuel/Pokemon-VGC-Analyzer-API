const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const cron = require('node-cron');
const { runPythonScript } = require('../utils/ml');
const { getThreatMatrix } = require('../utils/threat_matrix');
const { getMetaContext } = require('../utils/speed_context');

const MODELS_DIR = path.join(__dirname, '..', 'ml', 'models');
const RETRAIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const RETRAINABLE_MODELS = [
  { name: 'move_model', metaFile: 'move_model_meta.json', script: 'train_moves.py' },
  { name: 'ev_model', metaFile: 'ev_model_meta.json', script: 'train_evs.py' },
  { name: 'synergy_model', metaFile: 'synergy_meta.json', script: 'train_synergy.py' },
];

async function computeUsageStats() {
  logger.info('Computing usage stats...');
  try {
    const totalRes = await pool.query(`
      SELECT COUNT(*) as total 
      FROM tournament_teams 
      WHERE tournament_date >= NOW() - INTERVAL '30 days'
    `);
    const totalTeams = parseInt(totalRes.rows[0].total);

    if (totalTeams === 0) {
      logger.info('No teams in last 30 days, skipping stats');
      return;
    }

    const statsRes = await pool.query(`
      WITH recent_teams AS (
        SELECT * FROM tournament_teams
        WHERE tournament_date >= NOW() - INTERVAL '30 days'
      ),
      pokemon_expanded AS (
        SELECT
          t.wins,
          t.losses,
          t.placement,
          COALESCE(p->>'normalizedName', p->>'name') as pokemon_name
        FROM recent_teams t,
        jsonb_array_elements(t.pokemon) as p
      )
      SELECT
        pokemon_name,
        COUNT(*) as usage_count,
        ROUND(COUNT(*) * 100.0 / $1, 2) as usage_percent,
        ROUND(AVG(
          CASE WHEN (wins + losses) > 0
          THEN wins::decimal / (wins + losses) * 100
          ELSE NULL END
        ), 2) as avg_win_rate,
        MIN(placement) as best_placement
      FROM pokemon_expanded
      WHERE pokemon_name IS NOT NULL
      GROUP BY pokemon_name
      ORDER BY usage_count DESC
    `, [totalTeams]);

    for (const row of statsRes.rows) {
      await pool.query(`
        INSERT INTO usage_stats 
          (pokemon_name, format, usage_count, total_teams, usage_percent, avg_win_rate, best_placement, computed_at)
        VALUES ($1, 'Champions-MB', $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (pokemon_name, format) DO UPDATE SET
          usage_count = EXCLUDED.usage_count,
          total_teams = EXCLUDED.total_teams,
          usage_percent = EXCLUDED.usage_percent,
          avg_win_rate = EXCLUDED.avg_win_rate,
          best_placement = EXCLUDED.best_placement,
          computed_at = NOW()
      `, [
        row.pokemon_name,
        row.usage_count,
        totalTeams,
        row.usage_percent,
        row.avg_win_rate,
        row.best_placement
      ]);
    }

    logger.info(`Usage stats computed for ${statsRes.rows.length} Pokemon across ${totalTeams} teams`);

    // Threat matrix is derived from usage_stats — force it fresh right after a
    // recompute rather than relying only on its own incidental TTL alignment.
    await getThreatMatrix({ forceRefresh: true });
    // Tailwind/Trick Room meta prevalence is derived from tournament_teams directly
    // (not usage_stats), but stats.js's 6hr tick is this project's one established
    // "recompute derived caches" cadence, so it refreshes here too.
    await getMetaContext({ forceRefresh: true });
  } catch (err) {
    logger.error('Failed to compute usage stats', { error: err.message });
  }
}

function isModelStale(metaFile) {
  const metaPath = path.join(MODELS_DIR, metaFile);
  if (!fs.existsSync(metaPath)) return true;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return Date.now() - new Date(meta.trained_at).getTime() > RETRAIN_INTERVAL_MS;
  } catch (err) {
    return true;
  }
}

function retrainStaleModels() {
  for (const { name, metaFile, script } of RETRAINABLE_MODELS) {
    if (!isModelStale(metaFile)) continue;

    logger.info(`${name} is stale (>7 days old), retraining...`);
    runPythonScript(script)
      .then((result) => {
        logger.info(`${name} retrained successfully`, result);
      })
      .catch((err) => {
        logger.error(`${name} retrain failed`, { error: err.message });
      });
  }
}

computeUsageStats();
retrainStaleModels();

cron.schedule('0 */6 * * *', () => {
  logger.info('Scheduled stats recompute triggered');
  computeUsageStats();
  retrainStaleModels();
});

module.exports = { computeUsageStats, retrainStaleModels };