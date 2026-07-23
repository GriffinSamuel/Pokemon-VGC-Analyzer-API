const fetch = require('node-fetch');
const cron = require('node-cron');
const crypto = require('crypto');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { recordHealth } = require('../utils/health');
const { parseShowdownTeam } = require('../routes/team');

// Limitless has no Stat Point data anywhere in its API (verified live against
// /tournaments/{id}/standings — every decklist entry is exactly
// {id,name,item,ability,attacks,nature,tera}). VGCPastes' "Champions M-B Repository"
// tab links out to pokepast.es exports that do have real Stat Points (written under
// the "EVs:" line label, a holdover from the classic Showdown paste format).
const SHEET_ID = '1axlwmzPA49rYkqXh7zHvAtSP-TKbM0ijGYBPRflLSWw';
const CHAMPIONS_MB_GID = '1458357160';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${CHAMPIONS_MB_GID}`;
const SCRAPER_NAME = 'vgcpastes-scraper';

// Column indices in the "Champions M-B Repository" tab, verified against a live export.
const COL = {
  TEAM_ID: 0,
  TEAM_DESCRIPTION: 1,
  FULL_NAME: 3,
  POKEPASTE: 24,
  DATE_SHARED: 29,
  TOURNAMENT_EVENT: 30,
  RANK: 31,
};

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashTeam(pokemonArray) {
  return crypto.createHash('sha256').update(JSON.stringify(pokemonArray)).digest('hex').substring(0, 64);
}

// Minimal RFC4180-ish CSV parser (no CSV dependency exists in package.json, and this
// is the only place that needs one). Operates over the full text, not line-by-line,
// so quoted fields with embedded commas/newlines (present in this sheet's header
// banner) are handled correctly.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore — the following \n closes the row
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchText(url, label) {
  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res.text();
    },
    { label, retries: 3, baseDelay: 1000 }
  );
}

function parseDateShared(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d.toISOString().split('T')[0];
}

function parseRank(raw) {
  const trimmed = (raw || '').trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
}

function resolveTournamentName(row, description) {
  const event = (row[COL.TOURNAMENT_EVENT] || '').trim();
  if (event && event !== '-') return event;
  return `VGCPastes: ${description}`;
}

async function scrape() {
  logger.info('VGCPastes scraper started');
  try {
    const csvText = await fetchText(CSV_URL, 'fetch VGCPastes Champions M-B sheet');
    const allRows = parseCsv(csvText);
    // 3 banner/header rows precede the data; a handful of exports have a trailing
    // blank line (no Team ID) that this filter also excludes.
    const dataRows = allRows.slice(3).filter((r) => (r[COL.TEAM_ID] || '').trim().startsWith('MB'));
    logger.info(`Found ${dataRows.length} VGCPastes Champions M-B rows`);

    const teamIds = dataRows.map((r) => `vgcpastes-${r[COL.TEAM_ID].trim()}`);
    const { rows: existing } = teamIds.length
      ? await pool.query('SELECT tournament_id FROM tournament_teams WHERE tournament_id = ANY($1)', [teamIds])
      : { rows: [] };
    const alreadySeen = new Set(existing.map((r) => r.tournament_id));

    // Politeness/efficiency: only fetch pokepast.es pages for rows we haven't
    // already stored — avoids re-fetching ~470 unchanged third-party pages every run.
    const newRows = dataRows.filter((r) => !alreadySeen.has(`vgcpastes-${r[COL.TEAM_ID].trim()}`));
    logger.info(`${newRows.length} new VGCPastes teams to fetch (${alreadySeen.size} already stored)`);

    let teamsInserted = 0;
    let observationsInserted = 0;

    for (const row of newRows) {
      const teamId = row[COL.TEAM_ID].trim();
      const pokepasteUrl = (row[COL.POKEPASTE] || '').trim();
      if (!pokepasteUrl) { continue; }

      try {
        const rawPaste = await fetchText(`${pokepasteUrl}/raw`, `fetch pokepaste ${teamId}`);

        // Detect per-mon EVs-line presence directly from the raw text (exact,
        // rather than inferring "missing" from an all-zero default) using the
        // same block split parseShowdownTeam uses internally, so indices align.
        const blocks = rawPaste.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
        const hasEvsLine = blocks.map((b) => /^evs:/im.test(b));

        const mons = parseShowdownTeam(rawPaste);
        if (mons.length === 0) { await sleep(250); continue; }

        const tournamentId = `vgcpastes-${teamId}`;
        const description = row[COL.TEAM_DESCRIPTION] || teamId;
        const placement = parseRank(row[COL.RANK]);
        const teamHash = hashTeam(mons);

        const result = await pool.query(
          `INSERT INTO tournament_teams
           (tournament_id, tournament_name, tournament_date, player_name,
            placement, wins, losses, team_hash, pokemon)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (team_hash) DO NOTHING`,
          [
            tournamentId,
            resolveTournamentName(row, description),
            parseDateShared(row[COL.DATE_SHARED]),
            row[COL.FULL_NAME] || null,
            placement,
            null,
            null,
            teamHash,
            JSON.stringify(mons),
          ]
        );
        if (result.rowCount > 0) teamsInserted++;

        // Independent of whether the team row itself was a dedup no-op — always
        // try to capture SP data, since Limitless (this DB's other source) never has it.
        // team.js's shared Showdown parser calls this field `evs` (the literal pokepaste
        // line label, "EVs:") but for Champions Reg M-B the numbers it extracts (0-32
        // range) are actually Stat Points — see CLAUDE.md's "Stat Point System" section.
        for (let i = 0; i < mons.length; i++) {
          if (!hasEvsLine[i]) continue;
          const mon = mons[i];
          const sp = mon.evs || {};
          const allStatsPresent = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].every((k) => Number.isInteger(sp[k]));
          if (!allStatsPresent) continue; // never insert an incomplete SP row
          const spTotal = Object.values(sp).reduce((a, b) => a + b, 0);
          if (spTotal === 0) continue; // never insert a null/empty spread

          await pool.query(
            `INSERT INTO ev_observations
             (pokemon_name, normalized_name, nature, item, sp, moves, tournament_id, placement)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [mon.name, mon.normalizedName, mon.nature, mon.item, JSON.stringify(sp), JSON.stringify(mon.attacks), tournamentId, placement]
          );
          observationsInserted++;
        }
      } catch (err) {
        logger.error('Failed to process VGCPastes team', { teamId, error: err.message });
      }

      await sleep(250);
    }

    logger.info(`VGCPastes scrape complete: ${teamsInserted} new teams, ${observationsInserted} new SP observations`);
    await recordHealth(SCRAPER_NAME, true);
  } catch (err) {
    await recordHealth(SCRAPER_NAME, false, err.message);
    logger.error('VGCPastes scraper failed', { error: err.message });
  }
}

scrape();

cron.schedule('0 */6 * * *', () => {
  logger.info('Scheduled VGCPastes scrape triggered');
  scrape();
});

module.exports = { scrape };
