/**
 * Nerd of Now set parser — fetches and caches expert-created competitive Pokemon
 * sets from the NCP-VGC-Damage-Calculator repository.
 *
 * Repository: https://github.com/nerd-of-now/NCP-VGC-Damage-Calculator
 * File fetched: script_res/setdex_ncp-g10.js (Gen 10 Champions M-B competitive sets)
 *
 * File format: JavaScript with `var setdex = {};` followed by `setdex["Name"] = {...}`
 * assignments. Each set contains: evs (classic 0-252 format, abbreviated keys),
 * nature, optional ability, optional item, optional tera_type, moves array.
 * Abbreviated EV keys: hp/hp, at/atk, df/def, sa/spa, sd/spd, sp/spe.
 *
 * This module:
 * 1. Fetches the raw JS file from GitHub on first use
 * 2. Parses it using regex-based extraction (not eval — the file is fetched from
 *    an external URL, so eval would be a security risk)
 * 3. Converts classic EVs to Champions Stat Points (0-32 per stat, 66 total)
 * 4. Normalizes Pokemon names using normalize.js for DB-format compatibility
 * 5. Caches parsed sets locally in src/ml/data/nerd_of_now_sets.json
 * 6. Refreshes the cache once every 24 hours or on server restart
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { normalizePokemonName } = require('./normalize');

const SETDEX_URL = 'https://raw.githubusercontent.com/nerd-of-now/NCP-VGC-Damage-Calculator/main/script_res/setdex_ncp-g10.js';
const CACHE_DIR = path.join(__dirname, '..', 'ml', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'nerd_of_now_sets.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SP_BUDGET_TOTAL = 66;
const SP_CAP = 32;

// EV stat key mapping from Nerd of Now's abbreviated format to internal format.
// Nerd of Now uses: hp, at, df, sa, sd, sp as the abbreviation convention
// (matching the classic "HP / Atk / Def / SpA / SpD / Spe" ordering).
const EV_KEY_MAP = { hp: 'hp', at: 'atk', df: 'def', sa: 'spa', sd: 'spd', sp: 'spe' };
const SP_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

// In-memory cache: { sets: {pokemonName: [set, ...]}, fetchedAt: number }
let inMemoryCache = null;

/**
 * Convert a single classic EV value (0-252) to a Stat Point value (0-32).
 * Uses the standard formula: SP = (EV + 4) / 8 for any EV > 0.
 * This is the inverse of the official conversion: EV = 8 × SP − 4.
 */
function evToSp(ev) {
  if (!ev || ev <= 0) return 0;
  const sp = (ev + 4) / 8;
  return Math.round(sp);
}

/**
 * Convert a full EV object (Nerd of Now format) to a Stat Point object.
 * Ensures total does not exceed 66 SP budget — scales down proportionally if needed.
 */
function convertEVsToSP(evs) {
  const sp = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  let total = 0;

  // Convert each stat
  for (const [evKey, spKey] of Object.entries(EV_KEY_MAP)) {
    const value = evToSp(evs[evKey]);
    const capped = Math.min(value, SP_CAP);
    sp[spKey] = capped;
    total += capped;
  }

  // If total exceeds budget, scale down proportionally
  if (total > SP_BUDGET_TOTAL) {
    const scale = SP_BUDGET_TOTAL / total;
    const scaled = {};
    let scaledTotal = 0;
    for (const key of SP_KEYS) {
      const raw = Math.round(sp[key] * scale);
      scaled[key] = Math.min(raw, SP_CAP);
      scaledTotal += scaled[key];
    }
    // Fix rounding surplus: subtract from highest stat(s)
    if (scaledTotal > SP_BUDGET_TOTAL) {
      const sorted = [...SP_KEYS].sort((a, b) => scaled[b] - scaled[a]);
      for (const key of sorted) {
        if (scaledTotal <= SP_BUDGET_TOTAL) break;
        if (scaled[key] > 0) { scaled[key]--; scaledTotal--; }
      }
    }
    // Fix rounding deficit: add to highest stat(s) with room
    if (scaledTotal < SP_BUDGET_TOTAL) {
      const sorted = [...SP_KEYS].sort((a, b) => scaled[b] - scaled[a]);
      for (const key of sorted) {
        if (scaledTotal >= SP_BUDGET_TOTAL) break;
        if (scaled[key] < SP_CAP) { scaled[key]++; scaledTotal++; }
      }
    }
    logger.warn('Nerd of Now set exceeded SP budget — scaled down proportionally', {
      original_total: total, scaled_total: scaledTotal, sp,
    });
    return scaled;
  }

  return sp;
}

/**
 * Strip C-style comments (/* *​/) and single-line comments (//) from JS source.
 */
function stripComments(str) {
  return str
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * Find the matching closing brace index starting from `startIdx`.
 * Returns the index of the matching `}` or the end of the string.
 */
function findMatchingBrace(str, startIdx) {
  let depth = 1;
  let i = startIdx;
  while (depth > 0 && i < str.length) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') depth--;
    if (depth > 0) i++;
  }
  return i;
}

/**
 * Extract key-value pairs from a JSON-like object string. Handles quoted string
 * values, numeric values, arrays, and nested objects. This is a lightweight parser
 * that handles the structure of the setdex file without using eval().
 */
function extractField(str, fieldName) {
  const regex = new RegExp(`"${fieldName}"\\s*:\\s*`);
  const match = regex.exec(str);
  if (!match) return null;
  const start = match.index + match[0].length;
  const firstChar = str[start];
  if (firstChar === '"') {
    // String value
    const endQuote = str.indexOf('"', start + 1);
    return endQuote === -1 ? '' : str.slice(start + 1, endQuote);
  }
  if (firstChar === '{') {
    // Nested object — extract via brace matching
    const end = findMatchingBrace(str, start + 1);
    return str.slice(start, end + 1);
  }
  if (firstChar === '[') {
    // Array — find matching bracket
    const end = str.indexOf(']', start);
    return end === -1 ? '[]' : str.slice(start, end + 1);
  }
  // Number or other literal — read until comma or closing brace
  const end = str.slice(start).search(/[,}\]]/);
  return end === -1 ? str.slice(start).trim() : str.slice(start, start + end).trim();
}

/**
 * Parse a single set object string into a structured set object.
 */
function parseSetObject(inner, pokemonName, setName) {
  const evsStr = extractField(inner, 'evs');
  const nature = extractField(inner, 'nature');
  const item = extractField(inner, 'item');
  const movesStr = extractField(inner, 'moves');

  if (!evsStr || !nature) return null;

  // Parse EV object: "hp":0, "at":252, etc.
  const evs = {};
  const evRegex = /"([a-z]+)"\s*:\s*(\d+)/g;
  let evMatch;
  while ((evMatch = evRegex.exec(evsStr)) !== null) {
    evs[evMatch[1]] = parseInt(evMatch[2], 10);
  }

  // Convert to SP
  const sp = convertEVsToSP(evs);

  // Parse moves array
  const moves = [];
  if (movesStr) {
    const moveRegex = /"([^"]+)"/g;
    let m;
    while ((m = moveRegex.exec(movesStr)) !== null) {
      moves.push(m[1]);
    }
  }

  // Normalize Pokemon name — use the item (if present) for Mega detection,
  // otherwise just pass the name through normalizePokemonName.
  const normalizedName = normalizePokemonName(
    pokemonName.replace(/[\s_]/g, '-').toLowerCase(),
    item || null
  ) || pokemonName;

  return {
    label: setName,
    nature,
    item: item || null,
    moves,
    sp,
    source_name: pokemonName,
    db_name: normalizedName,
  };
}

/**
 * Parse a Pokemon entry's object string (containing multiple named sets)
 * into an array of parsed set objects.
 */
function parseNamedSets(objectStr, pokemonName) {
  const results = [];
  const setRegex = /"([^"]+)"\s*:\s*\{/g;
  let match;

  while ((match = setRegex.exec(objectStr)) !== null) {
    const setName = match[1];
    const startIdx = match.index + match[0].length;
    const endIdx = findMatchingBrace(objectStr, startIdx);

    // Filter out placeholder entries (empty-string keys or placeholder text)
    if (!setName || setName.startsWith('PLACEHOLDER') || setName.startsWith('xx')) continue;

    const inner = objectStr.slice(startIdx, endIdx);
    try {
      const parsed = parseSetObject(inner, pokemonName, setName);
      if (parsed && parsed.sp) {
        // Only include sets that have actual SP investment (not all-zero)
        const hasInvestment = Object.values(parsed.sp).some(v => v > 0);
        if (hasInvestment) {
          results.push(parsed);
        }
      }
    } catch (err) {
      // Skip unparseable sets silently
    }
  }

  return results;
}

/**
 * Fetch and parse the Nerd of Now set file from GitHub.
 * Returns a map of normalized Pokemon name -> array of parsed sets.
 *
 * File format: `var SETDEX_GEN9 = { "PokemonName": { "SetName": {...}, ... }, ... };`
 * — a single large object literal. After stripping comments and the variable
 * declaration, the remaining text is parseable as JSON.
 */
async function fetchAndParse() {
  logger.info('Fetching Nerd of Now sets from GitHub...');
  const response = await fetch(SETDEX_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Nerd of Now sets: HTTP ${response.status}`);
  }
  const text = await response.text();
  const cleaned = stripComments(text);

  // Extract the JSON object body: remove `var SETDEX_GEN9 = ` (or similar prefix)
  // and the trailing `;`.
  const eqIdx = cleaned.indexOf('=');
  if (eqIdx < 0) throw new Error('Could not find assignment in setdex file');
  let body = cleaned.slice(eqIdx + 1).trim();
  if (body.endsWith(';')) body = body.slice(0, -1).trim();
  if (body.endsWith('};')) body = body.slice(0, -2).trim();

  // Parse the top-level object as JSON. The setdex file uses trailing commas
  // (valid in JS, not in JSON) — strip them before passing to JSON.parse.
  let topLevel;
  try {
    const jsonStr = body
      .replace(/,\s*\}/g, '}')
      .replace(/,\s*\]/g, ']');
    topLevel = JSON.parse(jsonStr);
  } catch (jsonErr) {
    // Some entries may have trailing commas or other JS-isms — try a more lenient
    // extraction: walk the JSON manually and extract each Pokemon entry
    logger.warn('JSON.parse failed on setdex, using regex extraction fallback', { error: jsonErr.message });
    topLevel = extractPokemonEntries(body);
  }

  const bySourceName = {};
  const byDbName = {};

  for (const [sourceName, setsObj] of Object.entries(topLevel)) {
    if (!setsObj || typeof setsObj !== 'object') continue;

    const parsedSets = [];
    for (const [setName, setData] of Object.entries(setsObj)) {
      if (!setData || typeof setData !== 'object') continue;
      if (!setData.evs || !setData.nature) continue;

      try {
        const parsed = parseSetObjectFromEntry(setData, sourceName, setName);
        if (parsed && parsed.sp) {
          const hasInvestment = Object.values(parsed.sp).some(v => v > 0);
          if (hasInvestment) parsedSets.push(parsed);
        }
      } catch (err) { /* skip unparseable */ }
    }

    if (parsedSets.length > 0) {
      bySourceName[sourceName] = parsedSets;
      for (const set of parsedSets) {
        const dbName = set.db_name;
        if (!byDbName[dbName]) byDbName[dbName] = [];
        if (!byDbName[dbName].some(e => e.label === set.label)) {
          byDbName[dbName].push(set);
        }
      }
    }
  }

  logger.info(`Parsed Nerd of Now sets: ${Object.keys(byDbName).length} Pokemon found`);

  return {
    by_source_name: bySourceName,
    by_db_name: byDbName,
    parsed_at: new Date().toISOString(),
    pokemon_count: Object.keys(byDbName).length,
    total_sets: Object.values(byDbName).reduce((s, sets) => s + sets.length, 0),
  };
}

/**
 * Parse a set entry from a pre-parsed JS object (already has evs, nature, moves etc.)
 */
function parseSetObjectFromEntry(data, pokemonName, setName) {
  const evs = data.evs || {};
  const sp = convertEVsToSP(evs);
  const moves = (data.moves || []).filter(m => m && typeof m === 'string');

  const normalizedName = normalizePokemonName(
    pokemonName.replace(/[\s_]/g, '-').toLowerCase(),
    data.item || null
  ) || pokemonName;

  return {
    label: setName,
    nature: data.nature,
    item: data.item || null,
    moves,
    sp,
    source_name: pokemonName,
    db_name: normalizedName,
  };
}

/**
 * Fallback parser for when JSON.parse fails — extracts Pokemon entries using
 * brace-matching (handles trailing commas and other JS-isms).
 */
function extractPokemonEntries(body) {
  const result = {};
  // Match top-level keys: "PokemonName": { ... }
  const pokemonRegex = /"([^"]+)"\s*:\s*\{/g;
  let match;

  while ((match = pokemonRegex.exec(body)) !== null) {
    const pokemonName = match[1];
    const startIdx = match.index + match[0].length;
    const endIdx = findMatchingBrace(body, startIdx);
    const innerStr = body.slice(startIdx, endIdx);

    // Parse each named set within this Pokemon's entry
    const pokemonObj = {};
    const setRegex = /"([^"]+)"\s*:\s*\{/g;
    let setMatch;

    while ((setMatch = setRegex.exec(innerStr)) !== null) {
      const setName = setMatch[1];
      if (!setName || setName.startsWith('PLACEHOLDER')) continue;
      const setStart = setMatch.index + setMatch[0].length;
      const setEnd = findMatchingBrace(innerStr, setStart);
      const setStr = innerStr.slice(setStart, setEnd);

      // Extract fields from the set string
      const evsStr = extractField(setStr, 'evs');
      const nature = extractField(setStr, 'nature');
      const item = extractField(setStr, 'item');
      const movesStr = extractField(setStr, 'moves');

      if (!evsStr || !nature) continue;

      const evs = {};
      const evRegex = /"([a-z]+)"\s*:\s*(\d+)/g;
      let evMatch;
      while ((evMatch = evRegex.exec(evsStr)) !== null) {
        evs[evMatch[1]] = parseInt(evMatch[2], 10);
      }

      const moves = [];
      if (movesStr) {
        const moveRegex = /"([^"]+)"/g;
        let m;
        while ((m = moveRegex.exec(movesStr)) !== null) moves.push(m[1]);
      }

      pokemonObj[setName] = { evs, nature: nature || 'Hardy', item: item || undefined, moves };
    }

    if (Object.keys(pokemonObj).length > 0) {
      result[pokemonName] = pokemonObj;
    }
  }

  return result;
}

/**
 * Ensure the cache directory exists.
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Load or refresh the parsed Nerd of Now sets cache.
 * Reads from local JSON cache if fresh, otherwise fetches from GitHub.
 */
async function loadCache() {
  // Check in-memory cache first
  if (inMemoryCache && Date.now() - inMemoryCache.fetchedAt < CACHE_TTL_MS) {
    return inMemoryCache;
  }

  // Check local file cache
  ensureCacheDir();
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const stat = fs.statSync(CACHE_FILE);
      const age = Date.now() - stat.mtimeMs;
      if (age < CACHE_TTL_MS) {
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        inMemoryCache = { sets: data, fetchedAt: Date.now() };
        logger.info(`Loaded Nerd of Now sets from cache (${Object.keys(data.by_db_name || {}).length} Pokemon)`);
        return inMemoryCache;
      }
    } catch (err) {
      logger.warn('Failed to read cached Nerd of Now sets, re-fetching', { error: err.message });
    }
  }

  // Fetch and parse
  try {
    const data = await fetchAndParse();
    const cacheData = {
      by_source_name: data.by_source_name,
      by_db_name: data.by_db_name,
      parsed_at: data.parsed_at,
      pokemon_count: data.pokemon_count,
      total_sets: data.total_sets,
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf8');
    inMemoryCache = { sets: cacheData, fetchedAt: Date.now() };
    logger.info(`Cached Nerd of Now sets (${data.pokemon_count} Pokemon, ${data.total_sets} total sets)`);
    return inMemoryCache;
  } catch (err) {
    logger.error('Failed to fetch Nerd of Now sets', { error: err.message });
    // Fall back to stale file cache if available
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      inMemoryCache = { sets: data, fetchedAt: Date.now() };
      return inMemoryCache;
    }
    return { sets: { by_db_name: {}, by_source_name: {} }, fetchedAt: Date.now() };
  }
}

/**
 * Get Nerd of Now sets for a specific Pokemon by name.
 * @param {string} pokemonName - Pokemon name (case-insensitive)
 * @returns {Promise<Array<{label, nature, item, moves, sp}>>} Array of parsed sets,
 *          or empty array if no sets found.
 */
async function getNerdOfNowSets(pokemonName) {
  if (!pokemonName) return [];

  try {
    const cache = await loadCache();
    const sets = cache.sets.by_db_name || {};

    // Case-insensitive lookup: the cache stores Pokemon names as returned by
    // normalizePokemonName (e.g. "Garchomp", "Flutter Mane"). The caller may pass
    // any casing, so find the matching key.
    const key = Object.keys(sets).find(
      k => k.toLowerCase() === pokemonName.toLowerCase()
    );
    if (key) return sets[key];

    // Try with hyphen-stripping for Mega forms etc. (e.g. "Garchomp-Mega" -> "Garchomp")
    const baseName = pokemonName.split('-')[0].toLowerCase();
    const baseKey = Object.keys(sets).find(k => k.toLowerCase() === baseName);
    if (baseKey) return sets[baseKey];

    // Try with the source name format (case-insensitive)
    const sourceSets = cache.sets.by_source_name || {};
    const sourceKey = Object.keys(sourceSets).find(
      k => k.toLowerCase() === pokemonName.toLowerCase()
    );
    if (sourceKey) return sets[sourceKey] || sourceSets[sourceKey];

    return [];
  } catch (err) {
    logger.error('Error getting Nerd of Now sets', { pokemonName, error: err.message });
    return [];
  }
}

/**
 * Get the set label for a given set's SP spread (approximate match).
 * Used for SEEDS section logging.
 */
async function getSeedLabel(pokemonName, sp) {
  const sets = await getNerdOfNowSets(pokemonName);
  if (sets.length === 0) return null;

  // Find the closest matching set by SP spread
  let bestMatch = null;
  let bestDist = Infinity;

  for (const set of sets) {
    let dist = 0;
    for (const key of SP_KEYS) {
      dist += Math.abs((set.sp[key] || 0) - (sp[key] || 0));
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = set;
    }
  }

  return bestMatch ? { label: bestMatch.label, sp: bestMatch.sp, distance: bestDist } : null;
}

/**
 * Clear the in-memory cache (e.g. on server restart or explicit invalidation).
 */
function clearCache() {
  inMemoryCache = null;
}

/**
 * List all Pokemon names that have Nerd of Now sets available.
 */
function getAvailablePokemon() {
  if (inMemoryCache) {
    return Object.keys(inMemoryCache.sets.by_db_name || {});
  }
  return [];
}

/**
 * Get total count of available Nerd of Now sets.
 */
function getStats() {
  if (inMemoryCache) {
    return {
      pokemon_count: inMemoryCache.sets.pokemon_count || Object.keys(inMemoryCache.sets.by_db_name || {}).length,
      total_sets: inMemoryCache.sets.total_sets || 0,
    };
  }
  return { pokemon_count: 0, total_sets: 0 };
}

module.exports = {
  getNerdOfNowSets,
  getSeedLabel,
  clearCache,
  getAvailablePokemon,
  getStats,
  loadCache,
  evToSp,
  convertEVsToSP,
};
