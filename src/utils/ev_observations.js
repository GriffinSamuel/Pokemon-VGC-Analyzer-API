const pool = require('../db/pool');
const { calcStat, natureMultiplierFor } = require('./stat_formula');
const { round } = require('./format');

// Fall back to progressively shorter hyphenated prefixes for Mega forms
// (e.g. "swampert-mega" → "swampert"). Most Megas DO have their own DB rows
// (90 of them), but ~23 species (Aerodactyl-Mega, Alakazam-Mega, etc.) have
// Mega rows without a base-form row — and the first query with the full key
// already catches the 90 that exist. The fallback is a safety net for any
// hyphenated suffix (not just "-mega") that happens to lack a DB row, same
// pattern as recommend.js's topMovesFor().
async function getSpeciesRow(normalizedNameLower) {
  let key = normalizedNameLower;
  while (key) {
    const { rows } = await pool.query('SELECT * FROM pokemon WHERE LOWER(name) = $1', [key]);
    if (rows.length) return rows[0];
    const idx = key.lastIndexOf('-');
    if (idx === -1) break;
    key = key.slice(0, idx);
  }
  return null;
}

async function getObservationCount(normalizedNameLower) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as count FROM ev_observations WHERE LOWER(normalized_name) = $1',
    [normalizedNameLower]
  );
  return parseInt(rows[0].count, 10);
}

// Nature distribution with the 3-tier fallback chain: real ev_observations ->
// tournament_teams JSONB nature mode -> neutral/unknown.
async function getNatureDistribution(normalizedNameLower) {
  const { rows } = await pool.query(
    `SELECT nature, COUNT(*) as count FROM ev_observations
     WHERE LOWER(normalized_name) = $1 AND nature IS NOT NULL
     GROUP BY nature ORDER BY count DESC`,
    [normalizedNameLower]
  );
  const total = rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);

  if (total > 0) {
    const natures = rows.map((r) => ({
      nature: r.nature,
      count: parseInt(r.count, 10),
      frequency: round(parseInt(r.count, 10) / total, 4),
    }));
    const top = natures[0];
    if (top.frequency > 0.6) {
      return {
        source: 'ev_observations', classification: 'primary',
        primaryNature: top.nature, reliability: 1.0, total, natures,
      };
    }
    // No nature exceeds 40%, or an ambiguous 40-60% plurality — both treated
    // as "mixed" per the spec's two explicitly-defined buckets.
    return { source: 'ev_observations', classification: 'mixed', reliability: 0.7, total, natures };
  }

  const fallback = await pool.query(
    `SELECT p->>'nature' as nature, COUNT(*) as count
     FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
     WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) = $1 AND p->>'nature' IS NOT NULL
     GROUP BY p->>'nature' ORDER BY count DESC LIMIT 1`,
    [normalizedNameLower]
  );
  if (fallback.rows.length > 0) {
    const row = fallback.rows[0];
    return {
      source: 'tournament_teams', classification: 'primary',
      primaryNature: row.nature, reliability: 0.5, total: parseInt(row.count, 10),
      natures: [{ nature: row.nature, count: parseInt(row.count, 10), frequency: 1 }],
    };
  }

  return { source: 'none', classification: 'neutral', primaryNature: 'Hardy', reliability: 0.5, total: 0, natures: [] };
}

// Groups by exact (sp, nature) pair, ranked by observation frequency.
async function getCommonSpreads(normalizedNameLower) {
  const { rows } = await pool.query(
    `SELECT sp, nature, COUNT(*) as count
     FROM ev_observations
     WHERE LOWER(normalized_name) = $1
     GROUP BY sp, nature
     ORDER BY count DESC`,
    [normalizedNameLower]
  );
  const total = rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
  if (total === 0) return { total: 0, spreads: [] };

  const speciesRow = await getSpeciesRow(normalizedNameLower);
  const spreads = rows.map((r) => {
    const entry = {
      sp: r.sp,
      nature: r.nature,
      observations: parseInt(r.count, 10),
      frequency: round(parseInt(r.count, 10) / total, 4),
    };
    if (speciesRow) {
      entry.final_speed = calcStat(speciesRow.spe, r.sp.spe || 0, natureMultiplierFor(r.nature, 'spe'), false);
    }
    return entry;
  });
  return { total, spreads };
}

// Groups by (nature, Spe SP) only — coarser than getCommonSpreads, purpose-built
// for outspeed-threshold lookups where the rest of the spread doesn't matter.
async function getCommonSpeedTiers(normalizedNameLower) {
  const { rows } = await pool.query(
    `SELECT nature, (sp->>'spe')::int as spe_sp, COUNT(*) as count
     FROM ev_observations
     WHERE LOWER(normalized_name) = $1 AND sp ? 'spe'
     GROUP BY nature, spe_sp
     ORDER BY count DESC`,
    [normalizedNameLower]
  );
  const total = rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
  if (total === 0) return { total: 0, tiers: [] };

  const speciesRow = await getSpeciesRow(normalizedNameLower);
  const tiers = rows.map((r) => {
    const speSp = r.spe_sp || 0;
    const speedStat = speciesRow
      ? calcStat(speciesRow.spe, speSp, natureMultiplierFor(r.nature, 'spe'), false)
      : null;
    return {
      speed_stat: speedStat,
      frequency: round(parseInt(r.count, 10) / total, 4),
      nature: r.nature,
      spe_sp: speSp,
      observations: parseInt(r.count, 10),
      label: speedStat === null ? null : `${speSp >= 32 ? 'Max Speed' : `${speSp} Spe`} ${r.nature || ''}`.trim(),
    };
  });
  return { total, tiers };
}

async function getMostCommonSpread(normalizedNameLower) {
  const { total, spreads } = await getCommonSpreads(normalizedNameLower);
  if (!spreads.length) return null;
  return { ...spreads[0], total_observations: total };
}

// Top-N most common items, ev_observations first (it's the one source tied to a
// real SP+nature+item combo). Supplemented from tournament_teams' JSONB item
// field only when ev_observations has FEWER than `minCount` distinct items for
// this species — unlike the nature/ability precedent elsewhere in this codebase
// (which deliberately never merges ev_observations and tournament_teams into one
// fabricated joint distribution because both samples are individually large
// enough to stand alone), here the merge only fires when the primary sample is
// too sparse to be useful by itself, and each entry keeps a `source` tag so
// callers can see which sample it actually came from.
async function getCommonItems(normalizedNameLower, minCount = 5) {
  const { rows } = await pool.query(
    `SELECT item, COUNT(*) as count FROM ev_observations
     WHERE LOWER(normalized_name) = $1 AND item IS NOT NULL
     GROUP BY item ORDER BY count DESC`,
    [normalizedNameLower]
  );
  const items = rows.map((r) => ({ item: r.item, count: parseInt(r.count, 10), source: 'ev_observations' }));

  if (items.length < minCount) {
    const seen = new Set(items.map((i) => i.item.toLowerCase()));
    const { rows: fallbackRows } = await pool.query(
      `SELECT p->>'item' as item, COUNT(*) as count
       FROM tournament_teams t, jsonb_array_elements(t.pokemon) p
       WHERE LOWER(COALESCE(p->>'normalizedName', p->>'name')) = $1 AND p->>'item' IS NOT NULL
       GROUP BY p->>'item' ORDER BY count DESC`,
      [normalizedNameLower]
    );
    for (const r of fallbackRows) {
      const lower = r.item.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      items.push({ item: r.item, count: parseInt(r.count, 10), source: 'tournament_teams' });
    }
  }

  const top = items.slice(0, minCount);
  const total = top.reduce((sum, i) => sum + i.count, 0);
  return top.map((i) => ({
    item: i.item,
    count: i.count,
    frequency: total > 0 ? round(i.count / total, 4) : 0,
    source: i.source,
  }));
}

// FIX 3/4: items that change an attacker's OUTGOING damage output — as opposed
// to Leftovers/Sitrus Berry/Rocky Helmet/Assault Vest/Focus Sash/etc., which
// affect survivability, recovery, or the opponent's own damage, never this
// Pokemon's own attack. @smogon/calc already correctly implements every one of
// these when `item` is passed into damage.buildPokemon() (no math reimplemented
// here) — this set exists only to decide WHICH of an attacker's real top-3
// observed items is worth actually testing/displaying for a damage calculation,
// rather than picking their single most-common item regardless of whether it's
// damage-relevant at all (e.g. a real Kingambit might run Leftovers 20% of the
// time — irrelevant to how hard its Sucker Punch hits).
const DAMAGE_AFFECTING_ITEMS = new Set([
  'choice band', 'choice specs', 'life orb', 'expert belt', 'muscle band', 'wise glasses',
  'thick club', 'light ball', 'deep sea tooth',
  // Type-boosting held items (1.2x same-type move) — the standard Gen 9 set.
  'black glasses', 'black belt', 'charcoal', 'mystic water', 'magnet', 'miracle seed',
  'nevermeltice', 'never-melt ice', 'silk scarf', 'poison barb', 'soft sand', 'sharp beak',
  'twisted spoon', 'silverpowder', 'silver powder', 'hard stone', 'spell tag', 'dragon fang',
  'metal coat', 'sea incense', 'odd incense',
  // Plates (Judgment/Multi-Attack) — same 1.2x same-type mechanism as the items above.
  'flame plate', 'splash plate', 'zap plate', 'meadow plate', 'icicle plate', 'fist plate',
  'toxic plate', 'earth plate', 'sky plate', 'mind plate', 'insect plate', 'stone plate',
  'spooky plate', 'draco plate', 'dread plate', 'iron plate', 'pixie plate',
]);

// Top real observed item for an attacker, restricted to damage-affecting items
// only (see DAMAGE_AFFECTING_ITEMS) — `getCommonItems()`'s own top-1 pick can't
// be used directly for a damage calc, since it might be a non-damage item like
// Leftovers even when a real damage item exists further down that attacker's
// real item list. Returns null (no item) when this attacker has no real
// damage-affecting item observed at all, rather than guessing.
async function getTopDamageAffectingItem(normalizedNameLower) {
  const items = await getCommonItems(normalizedNameLower, 10);
  const damaging = items.filter((i) => DAMAGE_AFFECTING_ITEMS.has(i.item.toLowerCase()));
  return damaging[0] || null;
}

// Spread prevalence: % of a species' ev_observations matching this exact (sp, nature)
// combo. Used to show how common a specific build is.
// Returns a decimal (0-1), or null if no data.
async function getSpreadPrevalence(normalizedNameLower, sp, nature) {
  const { total, spreads } = await getCommonSpreads(normalizedNameLower);
  if (total === 0) return null;
  const spKey = JSON.stringify(sp);
  const match = spreads.find((s) => JSON.stringify(s.sp) === spKey && (s.nature || '').toLowerCase() === (nature || '').toLowerCase());
  if (!match) return null;
  return round(match.observations / total, 4);
}

module.exports = {
  getSpeciesRow,
  getObservationCount,
  getNatureDistribution,
  getCommonSpreads,
  getCommonSpeedTiers,
  getMostCommonSpread,
  getCommonItems,
  getTopDamageAffectingItem,
  getSpreadPrevalence,
  DAMAGE_AFFECTING_ITEMS,
};
