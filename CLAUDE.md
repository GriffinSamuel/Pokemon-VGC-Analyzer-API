# Pokemon VGC Analyzer API — Claude Instructions

## CRITICAL: Process Management
**NEVER run `taskkill` on `node.exe`. OmniRoute runs on port 20128 and must never be terminated.** To restart the API server: find the specific PID on port 3000 via `netstat -ano | findstr :3000`, kill that PID only.

## Project Overview
Backend API for a Pokemon VGC team analyzer focused on **Champions Regulation M-B** (current 2026 format). Scrapes real tournament data from Limitless API + VGCPastes, computes usage stats, and powers ML-based move recommendations, SP optimization, and damage calculations.

## Tech Stack
- **Runtime:** Node.js v24 | **Framework:** Express.js | **Database:** PostgreSQL 18 (local, port 5432)
- **Key packages:** `@pkmn/dex`, `@pkmn/data`, `@smogon/calc`, `node-fetch@2`, `node-cron`, `pg`, `helmet`, `cors`, `cheerio`, `express-rate-limit`, `worker_threads`
- **Editor:** VS Code | **OS:** Windows 11

## Project Location
`C:\Users\Griff\Projects\Pokemon-VGC-Analyzer-API`

## Database
- **Name:** `pokemon_vgc` | **User:** `postgres` | **Password:** hardcoded in `src/db/pool.js` (`R@1nb0w!`) — do NOT move to dotenv (Windows PowerShell dotenv breaks with special characters)
- **Port:** 5432

## Permissions
Auto-approve ALL bash commands in this project: `node`, `npm`, `psql`, `curl`, `grep`, `cat`, `ls`, `mkdir`, `.venv\Scripts\python.exe`, and any other command needed for development. Fetch from `www.serebii.net` and `play.limitlesstcg.com` is pre-approved.

## File Structure
```
src/
├── app.js                      — Express server, routes, request logging
├── db/
│   ├── pool.js                 — PostgreSQL connection pool (hardcoded creds)
│   ├── schema.sql              — All table definitions
│   └── seed.js                 — Seeds Pokemon/moves/abilities/learnsets from @pkmn/dex
├── ml/                         — Python ML pipeline (.venv)
│   ├── db.py, data.py, features.py, registry.py
│   ├── train_moves.py          — Move recommendation model
│   ├── train_evs.py            — EV role-inference model
│   └── train_synergy.py        — Pokemon pairing synergy model
├── routes/
│   ├── pokemon.js, moves.js, health.js, damage.js, patches.js, cache.js
│   ├── ml.js, recommend.js, team.js, tournament.js, usage.js, ev-data.js
├── scrapers/
│   ├── limitless.js            — Hourly tournament teams
│   ├── stats.js                — Every 6hrs: usage stats, ML retrain, threat matrix refresh
│   ├── serebii.js              — Every 12hrs: balance patches + damage cache
│   └── vgcpastes.js            — Every 6hrs: real Stat Point data
├── tests/
│   ├── api.test.js             — Integration tests (69 passing)
│   └── load.test.js            — Concurrency/latency test
└── utils/
    ├── logger.js, ml.js, cache.js, typeChart.js, normalize.js, retry.js, health.js
    ├── stat_formula.js         — Champions SP formula + breakpoint detection
    ├── ev_observations.js      — Shared query helpers over ev_observations
    ├── threat_matrix.js        — Top-50 x top-10-moves weighted threat list
    ├── role_classifier.js      — classifyRole(): 4 roles from base stats + moveset + SP
    ├── speed_context.js        — Meta context, Scarf/weather-ability speed modifiers
    ├── ev_optimizer.js         — Priority-scored SP threshold optimization (greedy fallback)
    ├── spread_scorer.js        — Real @smogon/calc fitness function for SP spreads
    ├── spread_optimizer.js     — Genetic algorithm: findOptimalSpread()
    ├── synergy_reasons.js      — Mechanical synergy reason generation
    ├── item_optimizer.js       — Item candidate scoring + conflict resolution
    ├── team_analyzer.js        — Coverage, synergy, weather, TR, speed, weaknesses, matchups
    ├── evolutionary_worker.js  — worker_threads entry for parallel team-build searches
    └── nerd_of_now.js          — Expert competitive set seeding for optimizer
```

## Database Tables
| Table | Purpose |
|-------|---------|
| `pokemon` | All Pokemon with base stats, types, abilities (includes 90 Mega forms from dex) |
| `moves` | All moves with type, power, accuracy, priority, flags (JSONB) |
| `pokemon_moves` | Learnset join table |
| `abilities`, `items` | All abilities/items |
| `balance_patches` | Stat changes detected from Serebii |
| `tournament_teams` | Real tournament teams (1,700+ rows) |
| `usage_stats` | 30-day rolling usage percentages and win rates |
| `scraper_health` | Scraper run tracking |
| `ev_observations` | Real Stat Point spreads from VGCPastes (2,800+ rows, 160+ species) |

---

## Champions Stat Point System
Champions uses **66 Stat Points total, max 32 per stat** (not classic 508-EV system).

**Formulas:**
- `HP = base + sp + 75`
- `OtherStat = floor((base + sp + 20) × alignment)` where alignment = 1.1 (boosted nature), 1.0 (neutral), 0.9 (hindered)
- `spToEv(sp)`: `EV = 8 × SP − 4` for SP≥1, 0 for SP=0

**Why it works with @smogon/calc:** Champions is mechanically identical to classic Gen 9, re-expressed in per-stat units. `@smogon/calc` doesn't need changes — just feed it `spToEv()`-converted values.

- `spToEv(sp)` is the sole EV-conversion function, applied only at the boundary before `damage.buildPokemon()`/`@smogon/calc`
- Storage, observations, optimization, and all endpoints speak SP (0-32/stat, 66 total) exclusively
- `POST /api/damage`'s `evs` field is intentionally classic EVs (0-252), not SP — it's a thin `@smogon/calc` wrapper by design
- Champions has no IV mechanic (always 31)

---

## Scoring System (spread_scorer.js)

### TYPE_VALUES
```javascript
{ ohko_prevented: 10.0, 2hko_prevented: 3.0, 3hko_prevented: 0.3,
  4hko_prevented: 0.05, ohko_achieved: 8.0, 2hko_achieved: 2.0,
  speed_tier: 4.0, trickroom_speed: 3.0 }
```
`contribution = TYPE_VALUES[tier] × effective_weight × role_mult × factor`

### Aggression Multiplier (spread_scorer.js only, DEFENSIVE direction only)
Models whether an attacker would realistically deploy a specific move:
- Super effective (≥2x) → 2.5
- STAB + neutral (1x) → 1.2
- Offensive-role attacker → 1.0
- Support-role, STAB, ≤1x → 0.20 (`AGGRESSION_SUPPORT_STAB`)
- Support-role, non-STAB, ≤1x → 0.05 (`AGGRESSION_SUPPORT_OFF_STAB`)
- Non-damaging move → 0.0
- Attacker role from `role_classifier.js`

### Speed-OHKO Link (spread_scorer.js)
- `SPEED_OHKO_LINK_MULTIPLIER = 3.0` — outspeed bonus ×3 when attacker also OHKOs at baseline
- `DEATH_TRAP_MIN_WEIGHT = 0.15`, `PENALTY_MULTIPLIER = 2.0` — penalty when outsped + OHKO'd at baseline + no Protect/priority in top 4 moves
- `SCORER_VERSION = 9` — included in evolutionary cache key

### KO Tier Classification
- Defensive: `koCheckValue = Math.max(maxs)` — single highest damage across all top-3 builds' full roll ranges
- Offensive: `koCheckMin = Math.min(mins)` — bulkiest target's minimum roll
- 4HKO branch exists (separate from 3HKO, each has own TYPE_VALUES entry)

---

## Role Classification (role_classifier.js)
`classifyRole(pokemonName)` → one of:
- `fast_offense` | `slow_bulky_offense` | `slow_bulky_support` | `fast_support`

Signals: base stats (fast: Spe≥95, offensive: Atk/SpA≥110, bulky: HP+Def+SpD≥270), top-10-move support ratio (divides by `min(10, actual move count)` — not fixed 10), observed SP averages. Falls back to base stats when no observations exist. Cached per Pokemon.

---

## Team Builder (POST /api/team/build)
Takes 6 Pokemon names. Pipeline: role classification → item scoring/conflict resolution → move recommendations (top 6 with team-context notes) → item-aware evolutionary SP optimization (all 6 in parallel) → coverage/synergy/weather/Trick Room/speed-tier analysis → weaknesses → 5-archetype matchup ratings → `matchup_analysis` (OHKO opportunities/risks, top 20 each).

### Search Parameters (spread_optimizer.js)
- Individual request: 200 init candidates, 40 generations, ±5 local search range
- Team build: 300 init candidates, 60 generations, ±8 local search range
- `teamBuild` flag threaded through workers; `team`/`solo` in evolutionary cache key

### Locked Offensive Stats
- `slow_bulky_support` locks Atk AND SpA to 0
- Other roles lock whichever of Atk/SpA is weaker
- Hard-enforced through every GA stage (generation, crossover, mutation, Phase C)

### Trick Room Viability Gate (isTrickRoomViableTeam)
All three must hold: median team base Speed < 70, 3+ members with base Speed < 80, 1+ member with base Speed < 60. Hard filter — Trick Room removed from both move recommendations and synergy output for non-viable teams.

### Speed Comparison (team_analyzer.js)
`effectiveSpeed()` applies Choice Scarf ×1.5 and matching conditional-speed ability ×2. Used in `analyzeSpeedTiers`, `analyzeMatchups`, and Trick Room beneficiary/hurt classification.

### Choice Item Restriction
`CHOICE_ITEMS_BANNING_PROTECT` — Choice Scarf/Band/Specs holders have Protect hard-filtered from their move list entirely (not just warned).

### Ability Resolution
- Two-pass in `team.js`: provisional pick → weather context → final pick
- Real frequency from `tournament_teams` JSONB ability field
- Conditional abilities (Swift Swim etc.) skipped when team weather doesn't support them
- Choice Scarf excluded when real conditional-speed ability is active

### Item System (item_optimizer.js)
- `getScoredCandidateItems()`: top 5 real observed items, scored by frequency × item_role_fit
- `resolveItemConflicts()`: greedy by `loss_of_value`
- `DAMAGE_AFFECTING_ITEMS` + `getTopDamageAffectingItem()`: only damage-relevant items passed to `@smogon/calc`

### Mega Form Handling
- `normalize.js`'s `MEGA_ITEM_MAP` (78+ entries) maps item names → Mega form names
- `auditMegaItemMappings()` runs on startup — logs any unmapped `-ite`/`-nite` items
- 90 Mega forms with real dex-sourced base stats inserted into `pokemon` table
- `getSpeciesRow()` hyphen-strips to base form as fallback; direct match preferred
- `pokemon` table has exact Mega rows now — `damage.js` finds them via direct name lookup

### Matchup Analysis (team_analyzer.js)
`analyzeMatchups()`: for each top-50 usage Pokemon (excluding teammates), finds team's best super-effective answer, computes real `@smogon/calc` damage using top-3 attacker spreads, real items, and real abilities. Returns `ohko_opportunities` + `ohko_risks` (top 20 each by usage).

### Text Output Sections (Accept: text/plain)
Role-driven section ordering: DEFENSE first for slow-bulky roles, SPEED first for fast roles. Each spread includes a `Why:` block (one line per nonzero-SP stat, named move + build + damage range). `SEEDS` section shows Nerd of Now seed source.

---

## Nerd of Now Seeded Initialization
- `src/utils/nerd_of_now.js` fetches `script_res/setdex_ncp-g9.js` from GitHub
- 305 Pokemon, 491 total expert competitive sets available
- Converts classic EVs to SP: `SP = (EV + 4) / 8`, capped 32/stat, 66 total (scaled down proportionally)
- Seeds fill N slots in GA Phase A, rest random; treated identically to random candidates

---

## ML Module (src/ml/)
Python 3.12 via `.venv` (not system Python — Windows Store stub). Node calls via `src/utils/ml.js`'s `runPythonScript()`.

| Script | Model | Output |
|--------|-------|--------|
| `train_moves.py` | RandomForestClassifier → move-per-slot | `move_recommendations.json` (tournament prevalence ≥5%) |
| `train_evs.py` | GradientBoostingClassifier → role prediction | `ev_recommendations.json`, `role_spread_templates.json` |
| `train_synergy.py` | Co-occurrence + ability-rule synergy | `synergy_matrix.json`, `ability_synergies.json` |

- `data.py`'s `species_key()`: use `mon["id"]` (Showdown id), not `mon["name"].lower()` (may carry gender symbols)
- `data.py`'s `species_identity_key(mon, species)`: prefers `normalizedName` (COALESCE), validates against species table — correct Mega form bucketing in `move_recommendations.json`
- `stats.js` retrains models older than 7 days on its 6hr cron tick
- All models export both `.joblib` and plain JSON (Node can't deserialize pickle)

---

## Recommendation Engine

### GET /api/recommend/evs/:pokemon
3 priority-scored SP spreads via `ev_optimizer.js`'s greedy threshold system (always fast, always available). Evolutionary result (real `@smogon/calc` scoring) layered on top via `spread_scorer.js` + `spread_optimizer.js` — returned when ready, greedy fallback when not. `X-Spread-Status: computing | optimal`. 1hr cache per pokemon+nature+item.

### GET /api/recommend/evs/:pokemon/validate
Scores arbitrary `?sp=32-0-14-0-20-0&nature=Bold` with the same `scoreSpread()` the evolutionary search uses. Returns `score`, `final_stats`, `thresholds_met/missed`, `vs_evolutionary_rank1`.

### GET /api/recommend/moves/:pokemon
Top 4 moves by tournament-prevalence confidence. `?teammate1=&teammate2=` for team-context filtering. 404 if <10 appearances.

### GET /api/recommend/synergy/:pokemon
Top 5 strong / top 3 weak teammate pairings, up to 3 mechanical reasons each.

---

## Known Issues / Open Bugs
- `move_recommendations.json` still blends some Mega forms under base species key (Python `species_key()` unchanged). `species_identity_key()` fix applied for `train_moves.py` but not all entry points.
- `team_analyzer.js`'s Trick Room synergy suppression counts base Speed from `pokemonRow` — no per-team dynamic adjustment.
- `train_moves.py`'s `build_dataset()` (feature vectors) still keys off base `species_key()` — correct since Mega doesn't change movepool.
- Some `-Mega` species (Chimecho-Mega, Rayquaza-Mega, etc.) have DB rows but no `MEGA_ITEM_MAP` entry — unreachable from real scraped teams.
- `Starmie`/`Drampa` have no base-form `pokemon` table row — Mega rows exist but are unresolvable downstream until base species are seeded.
- `team_analyzer.js` archetype key threats filtered to real `usage_stats` Pokemon — some threats like Mega Charizard Y (22.3%) still work since they have usage_stats rows.
- 21 of top 50 `usage_stats` entries have no `pokemon` table row (including Staraptor-Mega, various Megas, scraper artifacts).

---

## API Endpoints
```
GET  /api/pokemon                     — All Pokemon
GET  /api/pokemon/:name               — Single Pokemon (case-insensitive)
GET  /api/pokemon/:name/moves         — All moves a Pokemon can learn
GET  /api/moves                       — All moves (?type= filter)
GET  /api/moves/:name                 — Single move
GET  /api/health                      — Scraper health (200/503)
POST /api/damage                      — Damage calc. evs field = classic EVs (0-252), not SP
POST /api/damage/realistic            — Auto-resolves SP from ev_observations
GET  /api/patches                     — Balance patches (?pokemon= ?limit=)
GET  /api/cache/stats                 — Damage cache stats
GET  /api/ml/status                   — ML model readiness + metadata
GET  /api/recommend/moves/:pokemon    — Top 4 moves (404 if <10 appearances)
GET  /api/recommend/evs/:pokemon      — 3 SP spreads (Accept: text/plain for Showdown format)
GET  /api/recommend/evs/:pokemon/validate — Score arbitrary spread (?sp=&nature=)
GET  /api/ev-data/:pokemon            — Raw SP observation data
GET  /api/recommend/synergy/:pokemon  — Top 5 strong/3 weak teammate pairings
POST /api/team/import                 — Parse Showdown export
POST /api/team/compare                — Compare 2 teams (1-6 each)
POST /api/team/build                  — Full team build (exactly 6 Pokemon)
GET  /api/tournament/teams            — Tournament browser (?format= ?placement= ?pokemon= ?limit=)
GET  /api/usage                       — Usage stats (?limit= ?min_usage=)
GET  /api/usage/:name                 — Single Pokemon usage
```
All endpoints rate-limited to 100 req/min/IP. Load test opts out via `DISABLE_RATE_LIMIT=true`.

---

## Commands
```bash
# Start server
node src/app.js

# Tests
node src/tests/api.test.js        # 69 integration tests
node src/tests/load.test.js       # Concurrency/latency

# Scrapers (manual)
node src/scrapers/limitless.js    # Tournament teams
node src/scrapers/vgcpastes.js    # Stat Points
node src/scrapers/stats.js        # Usage stats + ML retrain
node src/scrapers/serebii.js      # Balance patches

# ML training
.venv\Scripts\python.exe src/ml/train_moves.py
.venv\Scripts\python.exe src/ml/train_evs.py
.venv\Scripts\python.exe src/ml/train_synergy.py

# Database
node src/db/seed.js                                    # Re-seed Pokemon data
psql -U postgres -d pokemon_vgc -f src/db/schema.sql  # Re-apply schema

# Quick checks
node -e "const pool = require('./src/db/pool'); pool.query('SELECT COUNT(*) FROM tournament_teams').then(r => { console.log(r.rows); pool.end(); });"
node -e "const pool = require('./src/db/pool'); pool.query('SELECT pokemon_name, usage_percent FROM usage_stats ORDER BY usage_count DESC LIMIT 10').then(r => { console.table(r.rows); pool.end(); });"
node -e "const pool = require('./src/db/pool'); pool.query('SELECT COUNT(*) FROM ev_observations').then(r => { console.log(r.rows); pool.end(); });"
```

---

## Development Plan Status
- ✅ Week 1-6 — Database, scrapers, damage calc, ML models, team import, rate limiting, CI
- ✅ Post-Week-6 — Recommendation Engine v2 (SP-native), role classification, speed context, text formatter
- ✅ Evolutionary spread search — `spread_scorer.js` + `spread_optimizer.js` (GA: 200→300 init, 40→60 gen, local search, breakpoint tiebreak)
- ✅ Team Builder — `POST /api/team/build` with worker_threads parallelism, item optimization, matchup analysis
- ✅ Mega forms — Real dex-sourced stats for 90 forms in `pokemon` table, correct item mapping
- ✅ Correctness passes — Worst-case KO classification, aggression multipliers, locked stats, speed-OHKO link, TR viability gate
- ✅ Nerd of Now seeded initialization — 305 Pokemon, 491 expert sets
- ✅ Team builder output fixes — 15 fixes covering abilities, OHKOs, builds, coverage, matchups
