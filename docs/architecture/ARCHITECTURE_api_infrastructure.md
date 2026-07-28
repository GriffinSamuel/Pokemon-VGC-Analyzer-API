# API Infrastructure

## Server Bootstrap (`app.js`)

**Middleware stack (in order):**
1. `helmet()` — security headers
2. `cors()` — CORS
3. `express.json()` — body parsing
4. `rateLimit()` — 100 req/min/IP (skippable via `DISABLE_RATE_LIMIT=true`)

**Route mounting:**
```
/api/pokemon        → routes/pokemon.js
/api/moves          → routes/moves.js
/api/health         → routes/health.js
/api/damage         → routes/damage.js
/api/patches        → routes/patches.js
/api/cache          → routes/cache.js
/api/ml             → routes/ml.js
/api/tournament     → routes/tournament.js
/api/usage          → routes/usage.js
/api/ev-data        → routes/ev-data.js
/api/recommend      → routes/recommend.js
/api/team           → routes/team.js
```

**Global error handler:** `app.use((err, req, res, next) => ...)` catches all
unhandled errors. Logs via `logger.error()` and returns `{error: message}`.

**Startup sequence** (only when `require.main === module`):
1. `runSerebiiScraper()` — immediate first scrape
2. `auditMegaItemMappings()` — verify all items in DB have MEGA_ITEM_MAP entries
3. `app.listen(PORT)` — PORT defaults to 3000

---

## Simple CRUD Routes

| Route | File | Operations |
|-------|------|-----------|
| `pokemon.js` | GET list, GET by name, GET moves by name | DB queries via pool |
| `moves.js` | GET list (optional ?type= filter), GET by name | DB queries via pool |
| `patches.js` | GET by ?pokemon= or all, with ?limit= | DB query |
| `usage.js` | GET list with ?limit=&min_usage=, GET by name | DB query |
| `ev-data.js` | GET :pokemon — common spreads + speed tiers | `ev_observations` functions |
| `tournament.js` | GET /teams with ?format=&placement=&pokemon=&limit=&page= | DB query with placement cutoffs |

**Placement cutoffs** in `tournament.js`:
```javascript
PLACEMENT_CUTOFFS = { top8: 8, top16: 16, top32: 32 }
```
Also accepts `top50percent`.

---

## ML Status Route (`ml.js`)

Reads model metadata from `src/ml/models/`:
- `move_model_meta.json` — move model status
- `ev_model_meta.json` — EV model status
- `synergy_meta.json` — synergy model status

Returns: `{models: {...}, top_synergy_pairs: [...], last_training_run: timestamp}`

---

## Cache Infrastructure

### `utils/cache.js` — Generic TTL + LRU Cache

`createCache({ttlMs, maxSize})` → `{get, set, stats}`

- Insertion-order eviction (oldest key removed when at capacity)
- TTL-based expiry on `get()` (lazy deletion)
- `stats()` returns: `{size, max, oldest_entry_age_seconds}`

**Used by:** `recommend.js` (recomputation cache for spread results)

### `scrapers/serebii.js` — Damage Cache

LRU cache for `@smogon/calc` POST /api/damage results:
- `CACHE_TTL_MS = 6 * 60 * 60 * 1000` (6 hours)
- `CACHE_MAX_SIZE = 10,000`
- Invalidated per-Pokemon by `invalidateCacheForPokemon()` (called when Serebii detects a balance patch)

---

## Logging (`logger.js`)

JSON-structured logging to `logs/` directory:
- `app-YYYY-MM-DD.log` — all info + error
- `error-YYYY-MM-DD.log` — errors only
- Both files use `fs.appendFileSync()` (synchronous)
- Log format: `{level, timestamp, message, ...meta}`

---

## Retry Logic (`retry.js`)

`withRetry(fn, {retries=3, label, baseDelay=1000})`:
- Exponential backoff: `baseDelay × 2^(attempt-1)`
- Logs each failure before retry
- Re-throws last error after all retries exhausted

---

## Health Monitoring (`utils/health.js`)

- `recordSuccess(scraperName)` — update `scraper_health` table
- `recordFailure(scraperName, error)` — record error
- `recordHealth(scraperName, success, error)` — convenience wrapper
- `checkHealth()` — returns all scraper statuses + computed `hours_since_success`

**Alert threshold:** `checkHealth()` logs `ALERT` when any scraper hasn't succeeded in > 2 hours.

---

## Rate Limiting

`express-rate-limit` applied globally in `app.js`:
- 100 requests per minute per IP
- Returns `{error: "Too many requests — limit is 100 requests per minute"}` on 429

**Opt-out:** `process.env.DISABLE_RATE_LIMIT = 'true'` — used by `load.test.js`.

---

## Test Infrastructure

### `api.test.js` — 69 Integration Tests

Runs an Express server in-process (`app.listen()`), makes `fetch()` calls,
tears down after. Tests:
- All CRUD endpoints (pokemon, moves, patches, usage, tournaments)
- Damage calc (both `/api/damage` and `/api/damage/realistic`)
- Recommendation endpoints (moves, evs, synergy, validate)
- Team operations (import, compare, build)
- Cache behavior (invalidation)
- Health endpoint (degraded status when scraper fails)
- Rate limiting (429 within 110 rapid requests)

### `load.test.js` — Concurrency/Latency Test

Sets `DISABLE_RATE_LIMIT=true` to bypass rate limiting:
- 20 concurrent requests per endpoint
- p95 latency target: 200ms for most, 500ms for team/build
- PASS/FAIL per endpoint

---

## Express 5 Note

This project uses **Express v5** (`"express": "^5.2.1"` in package.json). Key
difference from v4: async error handling is built in — unhandled promise rejections
in route handlers are automatically passed to the error handler without needing
`try/catch` + `next(err)` wrappers. However, the codebase still uses explicit
`try/catch` + `next(err)` in most routes.
