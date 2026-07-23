const fetch = require('node-fetch');
const cron = require('node-cron');
const cheerio = require('cheerio');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { recordHealth } = require('../utils/health');

const PATCH_URL = 'https://www.serebii.net/scarletviolet/patch.shtml';
const SCRAPER_NAME = 'serebii-scraper';
const USER_AGENT = 'Mozilla/5.0 (compatible; PokemonVGCAnalyzer/1.0)';

const STAT_COLUMNS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

// Serebii prose uses regional prefixes ("Hisuian Zoroark") instead of the
// suffix form our pokemon table uses ("Zoroark-Hisui"). Unrecognized names
// (e.g. "Kleavor", which has no regional prefix) fall through unchanged.
const REGIONAL_PREFIXES = {
  Hisuian: 'Hisui',
  Galarian: 'Galar',
  Alolan: 'Alola',
  Paldean: 'Paldea',
};

const damageCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_SIZE = 500;

function invalidateCacheForPokemon(name) {
  const target = name.toLowerCase();
  for (const key of damageCache.keys()) {
    try {
      const body = JSON.parse(key);
      if (
        body.attacker?.name?.toLowerCase() === target ||
        body.defender?.name?.toLowerCase() === target
      ) {
        damageCache.delete(key);
      }
    } catch {
      damageCache.delete(key);
    }
  }
}

function buildCacheKey(body) {
  return JSON.stringify(sortKeysDeep(body));
}

function getCachedDamage(key) {
  const entry = damageCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    damageCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCachedDamage(key, value, timestamp = Date.now()) {
  if (!damageCache.has(key) && damageCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = damageCache.keys().next().value;
    damageCache.delete(oldestKey);
  }
  damageCache.set(key, { value, timestamp });
}

function getCacheStats() {
  let oldestTimestamp = null;
  for (const entry of damageCache.values()) {
    if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
      oldestTimestamp = entry.timestamp;
    }
  }
  return {
    size: damageCache.size,
    max: CACHE_MAX_SIZE,
    oldest_entry_age_seconds: oldestTimestamp === null
      ? 0
      : Math.floor((Date.now() - oldestTimestamp) / 1000),
  };
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function normalizeSerebiiName(rawName) {
  for (const [prefix, suffix] of Object.entries(REGIONAL_PREFIXES)) {
    const match = rawName.match(new RegExp(`^${prefix}\\s+(.+)$`, 'i'));
    if (match) return `${match[1]}-${suffix}`;
  }
  return rawName;
}

function parseReleaseDate(cellHtml) {
  const match = cellHtml.match(/Release Dates<\/b>:\s*<br\s*\/?>\s*<br\s*\/?>\s*([^<]+?)\s*<br/i);
  if (!match) return null;
  const cleaned = match[1].trim().replace(/(\d+)(st|nd|rd|th)/i, '$1');
  const date = new Date(cleaned);
  return isNaN(date) ? null : date.toISOString().split('T')[0];
}

function parseChanges(html) {
  const $ = cheerio.load(html);
  const changes = [];

  $('td.fooleft').each((i, el) => {
    const contentCell = $(el).closest('tr').next('tr').find('td.foocontent');
    if (!contentCell.length) return;

    const cellHtml = contentCell.html() || '';
    const releaseDate = parseReleaseDate(cellHtml);

    contentCell.find('table.dextable').each((j, table) => {
      const li = $(table).closest('li');
      const directText = li.contents().filter((k, n) => n.type === 'text').text();
      const nameMatch = directText.match(/Adjusted\s+(.+?)'s\s+stats/i);
      if (!nameMatch) return;
      const pokemonName = normalizeSerebiiName(nameMatch[1].trim());

      let nowRow = null;
      let beforeRow = null;
      $(table).find('tr').each((k, tr) => {
        const label = $(tr).find('td').first().text().trim();
        if (label === 'Now') nowRow = tr;
        if (label === 'Before') beforeRow = tr;
      });
      if (!nowRow || !beforeRow) return;

      const nowValues = $(nowRow).find('td').slice(1).map((k, td) => $(td).text().trim()).get();
      const beforeValues = $(beforeRow).find('td').slice(1).map((k, td) => $(td).text().trim()).get();

      STAT_COLUMNS.forEach((statKey, idx) => {
        if (nowValues[idx] !== beforeValues[idx] && nowValues[idx] !== undefined && beforeValues[idx] !== undefined) {
          changes.push({
            pokemon_name: pokemonName,
            change_type: 'stat',
            stat_changed: statKey,
            old_value: beforeValues[idx],
            new_value: nowValues[idx],
            raw_text: `${pokemonName} ${statKey} ${beforeValues[idx]} -> ${nowValues[idx]}`,
            release_date: releaseDate,
          });
        }
      });
    });
  });

  return changes;
}

async function storePatch(change) {
  const existing = await pool.query(
    'SELECT 1 FROM balance_patches WHERE raw_text = $1',
    [change.raw_text]
  );
  if (existing.rows.length > 0) return false;

  await pool.query(
    `INSERT INTO balance_patches
     (pokemon_name, change_type, stat_changed, old_value, new_value, raw_text, release_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      change.pokemon_name,
      change.change_type,
      change.stat_changed,
      change.old_value,
      change.new_value,
      change.raw_text,
      change.release_date,
    ]
  );
  return true;
}

async function fetchPatchPage() {
  return withRetry(
    async () => {
      const res = await fetch(PATCH_URL, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${PATCH_URL}`);
      return res.text();
    },
    { label: 'fetch serebii patch page', retries: 3, baseDelay: 1000 }
  );
}

async function runSerebiiScraper() {
  logger.info('Serebii scraper started');
  try {
    const html = await fetchPatchPage();
    const changes = parseChanges(html);
    logger.info(`Found ${changes.length} stat changes on Serebii patch page`);

    let inserted = 0;
    for (const change of changes) {
      const isNew = await storePatch(change);
      if (isNew) {
        inserted++;
        logger.info('New balance patch detected', { pokemon: change.pokemon_name, raw_text: change.raw_text });
        invalidateCacheForPokemon(change.pokemon_name);
      }
    }

    logger.info(`Serebii scrape complete: ${inserted} new patches inserted`);
    await recordHealth(SCRAPER_NAME, true);
  } catch (err) {
    await recordHealth(SCRAPER_NAME, false, err.message);
    logger.error('Serebii scraper failed', { error: err.message });
  }
}

cron.schedule('0 0,12 * * *', () => {
  logger.info('Scheduled Serebii scrape triggered');
  runSerebiiScraper();
});

module.exports = {
  runSerebiiScraper,
  damageCache,
  invalidateCacheForPokemon,
  buildCacheKey,
  getCachedDamage,
  setCachedDamage,
  getCacheStats,
  CACHE_TTL_MS,
  CACHE_MAX_SIZE,
};
