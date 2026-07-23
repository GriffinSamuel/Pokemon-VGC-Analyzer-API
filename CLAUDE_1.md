# Pokemon VGC Analyzer API — Claude Instructions

## Project Overview
A backend API for a Pokemon VGC team analyzer focused on **Pokemon Champions Regulation M-B** (current competitive format as of 2026). Automatically scrapes real tournament data from the Limitless API, computes usage statistics, and powers ML-based move recommendations and damage calculations.

## Tech Stack
- **Runtime:** Node.js v24
- **Framework:** Express.js
- **Database:** PostgreSQL 18, local, port 5432
- **Key packages:** `@pkmn/dex`, `@pkmn/data`, `node-fetch@2`, `node-cron`, `pg`, `dotenv`, `helmet`, `cors`, `@smogon/calc`, `cheerio`
- **ML:** Python 3.12 via `.venv` (scikit-learn, pandas, numpy, psycopg2-binary, joblib)
- **Editor:** VS Code
- **OS:** Windows 11

## Python Environment
Python is installed via `.venv` in the project root. Plain `python` is intercepted by Windows Store — always use:
```bash
.venv\Scripts\Activate.ps1   # activate for the session (then use python normally)
# OR
.venv\Scripts\python.exe src/ml/train.py  # run directly without activating
```

## Project Location
```
C:\Users\Griff\Projects\Pokemon-VGC-Analyzer-API
```

## Database
- **Name:** `pokemon_vgc`
- **User:** `postgres`
- **Password:** hardcoded in `src/db/pool.js` — do not move to dotenv (special characters break Windows PowerShell dotenv handling)
- **Port:** 5432

---

## Permissions — No Approval Needed
You have standing permission to do all of the following without asking:

### Network
- Fetch from `www.serebii.net` (balance patch monitor)
- Fetch from `play.limitlesstcg.com` (tournament scraper)
- Run `npm install` for any package in this project

### File System
- Read/write files in `C:\Users\Griff\AppData\Local\Temp` for HTML inspection during development
- Read any file inside `C:\Users\Griff\Projects\Pokemon-VGC-Analyzer-API`

### Commands
- `node -e` — inline Node.js scripts for database checks or quick tests
- `npm install` — installing packages
- `grep`, `head`, `curl` — inspecting downloaded HTML or files
- `psql -U postgres -d pokemon_vgc` — running SQL against the local database
- Running any file in `src/scrapers/`, `src/db/`, or `src/tests/`

---

## File Structure
```
Pokemon-VGC-Analyzer-API/
├── src/
│   ├── app.js                  — Express server, routes, request logging
│   ├── db/
│   │   ├── pool.js             — PostgreSQL connection pool (hardcoded credentials)
│   │   ├── schema.sql          — All table definitions and indexes
│   │   └── seed.js             — Seeds all Pokemon/moves/abilities/learnsets from @pkmn/dex
│   ├── ml/
│   │   ├── data/               — Exported CSVs (gitignored)
│   │   ├── models/             — Saved model files (gitignored)
│   │   ├── db.py               — PostgreSQL connection for Python
│   │   ├── data.py             — Tournament data exporter
│   │   ├── features.py         — Feature engineering (encoding, normalization)
│   │   ├── train.py            — Model training pipeline
│   │   └── registry.py         — Model version registry
│   ├── routes/
│   │   ├── pokemon.js          — GET /api/pokemon, /api/pokemon/:name, /api/pokemon/:name/moves
│   │   ├── moves.js            — GET /api/moves, /api/moves/:name?type=
│   │   ├── health.js           — GET /api/health
│   │   ├── damage.js           — POST /api/damage
│   │   ├── patches.js          — GET /api/patches
│   │   └── ml.js               — GET /api/ml/status
│   ├── scrapers/
│   │   ├── limitless.js        — Hourly scraper pulling Champions M-B tournament teams
│   │   ├── stats.js            — Every 6hrs computes usage stats + triggers ML retraining
│   │   └── serebii.js          — Every 12hrs checks for balance patches
│   ├── tests/
│   │   └── api.test.js         — Integration tests (run with: node src/tests/api.test.js)
│   └── utils/
│       ├── logger.js           — JSON logger writing to logs/ folder
│       ├── ml.js               — Node.js bridge to call Python ML scripts
│       ├── normalize.js        — Pokemon name normalization + all 55 Mega Evolution mappings
│       ├── retry.js            — Exponential backoff retry wrapper (withRetry)
│       └── health.js           — Records scraper success/failure to DB (recordHealth)
├── .venv/                      — Python virtual environment (gitignored)
├── logs/                       — Auto-created, daily rotating log files
├── .env                        — DB env vars (not used for password — see pool.js)
├── CLAUDE.md                   — This file
└── package.json
```

---

## Database Tables
```sql
pokemon          — All Pokemon with base stats, types, abilities (seeded from @pkmn/dex)
moves            — All moves with type, power, accuracy, priority, flags (JSONB)
pokemon_moves    — Learnset join table (which Pokemon learns which moves)
abilities        — All abilities with descriptions
items            — Items table (name, description)
balance_patches  — Stat/ability changes detected from Serebii (Week 3)
tournament_teams — Real tournament teams scraped from Limitless API (1,012 rows)
usage_stats      — Computed 30-day rolling usage percentages and win rates (156 rows)
scraper_health   — Tracks when scrapers last ran successfully
```

---

## Code Patterns — Always Follow These

### Adding a new route
Follow the exact pattern in `src/routes/pokemon.js`:
- Use `express.Router()`
- Use `async/await` with try/catch
- Log errors via `logger.error()`
- Return consistent JSON error shapes: `{ error: 'message' }`
- Register the route in `app.js` with `app.use('/api/routename', require('./routes/routename'))`

### Adding a new scraper
Follow the exact pattern in `src/scrapers/limitless.js`:
- Wrap fetches in `withRetry()` from `src/utils/retry.js`
- Call `recordHealth(SCRAPER_NAME, true/false, errorMsg)` from `src/utils/health.js` after every run
- Schedule with `node-cron`
- Log start, progress, and completion via `logger.info()`
- Log failures via `logger.error()` with stack trace

### Error responses
```js
res.status(400).json({ error: 'Descriptive message here' });
res.status(404).json({ error: 'Pokemon not found: <name>' });
res.status(500).json({ error: 'Internal server error' });
```

### Database queries
Always use parameterised queries via `pool.query('SELECT...', [params])`. Never string-interpolate user input into SQL.

### Pokemon name lookups
Always do case-insensitive name matching:
```sql
WHERE LOWER(name) = LOWER($1)
```

---

## Key Design Decisions

### Why Limitless API instead of Pikalytics?
Pikalytics has no public API. Limitless is the tournament platform Pikalytics sources from. The Limitless API is documented, stable, and free without an API key.

### Why top half finishers only?
Keeps usage stats focused on well-performing players. Win rates run slightly higher than Pikalytics (~59% vs ~51%) as a known tradeoff.

### Why hardcode DB credentials in pool.js?
Password `R@1nb0w!` contains characters that break Windows PowerShell dotenv handling. Do not "fix" this — it is intentional for local development.

### Why @pkmn/dex for seeding?
Pokemon Showdown data powers millions of competitive battles and is already verified. Seeded the entire database in ~2 minutes.

### Doubles spread move reduction
In doubles (VGC), spread moves like Earthquake that hit all adjacent targets deal 0.75x damage. Always apply this reduction in the damage calculator — do not skip it.

### Damage calculator returns guaranteed KOs only
Never return probability-based results like "60% chance to OHKO". Only return guaranteed tiers: `1HKO`, `2HKO`, `3HKO`, or `none`. Probability results are useless for team building.

### Serebii ability parsing
Serebii's ability change descriptions are freeform prose and cannot be reliably parsed. The balance patch monitor only tracks **stat changes** (HP, Attack, Defense, Sp. Atk, Sp. Def, Speed). The `change_type` column supports `'ability'` for future use but nothing populates it yet.

### Pokemon forme name resolution
Use the suffix map in `src/utils/normalize.js` for formes that share a visible name but differ by sprite filename (e.g. `-c` → `-Crowned`, `-o` → `-Origin`). Never store two distinct formes under the same `pokemon_name` — `invalidateCacheForPokemon()` would fire incorrectly.

---

## Useful Commands
```bash
# Activate Python venv (do this before running any python commands)
.venv\Scripts\Activate.ps1

# Train ML models
python src/ml/train.py

# Run data exporter
python src/ml/data.py

# Check ML model status
curl.exe http://localhost:3000/api/ml/status

# Start the server
node src/app.js

# Run all integration tests
node src/tests/api.test.js

# Run the Limitless scraper manually
node src/scrapers/limitless.js

# Recompute usage stats
node src/scrapers/stats.js

# Run the Serebii scraper manually
node src/scrapers/serebii.js

# Re-seed the database
node src/db/seed.js

# Re-apply schema
psql -U postgres -d pokemon_vgc -f src/db/schema.sql

# Check tournament team count
node -e "const pool = require('./src/db/pool'); pool.query('SELECT COUNT(*) FROM tournament_teams').then(r => { console.log(r.rows); pool.end(); });"

# Check top Pokemon usage
node -e "const pool = require('./src/db/pool'); pool.query('SELECT pokemon_name, usage_percent FROM usage_stats ORDER BY usage_count DESC LIMIT 10').then(r => { console.table(r.rows); pool.end(); });"

# Check balance patches
node -e "const pool = require('./src/db/pool'); pool.query('SELECT * FROM balance_patches ORDER BY detected_at DESC LIMIT 10').then(r => { console.table(r.rows); pool.end(); });"
```

---

## API Endpoints

### Complete (Weeks 1–4)
```
GET  /api/pokemon                     — All Pokemon ordered by Pokedex number
GET  /api/pokemon/:name               — Single Pokemon (case insensitive)
GET  /api/pokemon/:name/moves         — All moves a Pokemon can learn
GET  /api/moves                       — All moves (optional ?type= filter)
GET  /api/moves/:name                 — Single move by name
GET  /api/health                      — Scraper health (200 healthy / 503 degraded)
POST /api/damage                      — Damage calculation with guaranteed KO result
GET  /api/patches                     — Recent balance patches (?pokemon= ?limit=)
GET  /api/cache/stats                 — Cache size, max, oldest entry age
GET  /api/ml/status                   — ML model readiness and accuracy stats
```

### Week 5 (ML models)
```
GET  /api/recommend/moves/:pokemon    — ML move recommendations with confidence scores
GET  /api/recommend/evs/:pokemon      — ML EV spread recommendations
```

### Week 6 (Team features + polish)
```
GET  /api/tournament/teams            — Browse tournament teams with filters
GET  /api/usage                       — Usage stats for all Pokemon
GET  /api/usage/:name                 — Usage stats for specific Pokemon
POST /api/team/import                 — Parse Pokemon Showdown format team
POST /api/team/compare                — Compare two teams
```

---

## Development Plan Status (7 Weeks)
- ✅ Week 1 — Database schema, seeding, Express server, logging, 10 integration tests
- ✅ Week 2 — Limitless scraper, name normalization, usage stats, retry logic, health monitoring
- ✅ Week 3 — Serebii balance patch monitor, damage calculator, cache layer (20 tests passing)
- ✅ Week 4 — ML pipeline infrastructure, baseline model at 22.9% accuracy (20 tests passing)
- 🔲 Week 5 — Full move recommendation model, EV optimizer, synergy detection
- 🔲 Week 6 — Team comparison, tournament browser, API optimization, CI/CD
- 🔲 Week 7 — Production deployment, monitoring, reliability, 48hr unattended run
