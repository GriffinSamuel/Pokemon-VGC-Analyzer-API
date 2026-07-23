const pool = require('../db/pool');
const logger = require('./logger');

async function recordSuccess(scraperName) {
  await pool.query(`
    INSERT INTO scraper_health (scraper_name, last_success, last_attempt, total_runs)
    VALUES ($1, NOW(), NOW(), 1)
    ON CONFLICT (scraper_name) DO UPDATE SET
      last_success = NOW(),
      last_attempt = NOW(),
      last_error = NULL,
      total_runs = scraper_health.total_runs + 1
  `, [scraperName]);
}

async function recordFailure(scraperName, error) {
  await pool.query(`
    INSERT INTO scraper_health (scraper_name, last_attempt, last_error, total_runs, total_failures)
    VALUES ($1, NOW(), $2, 1, 1)
    ON CONFLICT (scraper_name) DO UPDATE SET
      last_attempt = NOW(),
      last_error = $2,
      total_runs = scraper_health.total_runs + 1,
      total_failures = scraper_health.total_failures + 1
  `, [scraperName, error]);
}

async function recordHealth(scraperName, success, error) {
  if (success) {
    await recordSuccess(scraperName);
  } else {
    await recordFailure(scraperName, error);
  }
}

async function checkHealth() {
  const { rows } = await pool.query(`
    SELECT 
      scraper_name,
      last_success,
      last_attempt,
      last_error,
      total_runs,
      total_failures,
      EXTRACT(EPOCH FROM (NOW() - last_success)) / 3600 as hours_since_success
    FROM scraper_health
  `);

  for (const row of rows) {
    const hours = parseFloat(row.hours_since_success);
    if (hours > 2) {
      logger.error(`ALERT: ${row.scraper_name} has not run successfully in ${hours.toFixed(1)} hours`, {
        last_success: row.last_success,
        last_error: row.last_error
      });
    } else {
      logger.info(`${row.scraper_name} healthy — last success ${hours.toFixed(1)}hrs ago`);
    }
  }

  return rows;
}

module.exports = { recordSuccess, recordFailure, recordHealth, checkHealth };