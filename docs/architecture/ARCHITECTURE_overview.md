# Architecture Overview — Pokemon VGC Analyzer API

## Project Purpose

Backend API for analyzing Pokemon VGC teams in **Champions Regulation M-B** (2026 format). Scrapes
real tournament data from Limitless API + VGCPastes, computes usage stats, and powers ML-based
move recommendations, SP (Stat Point) optimization, damage calculations, and full team analysis.

---

## Module Map — Every Source File

Each entry lists: **Responsibility → Exports → Key Imports → Who Consumes It**

### Root

| File | Responsibility | Exports | Imports from project | Consumed by |
|------|---------------|---------|---------------------|-------------|
| `app.js` | Express server bootstrap, middleware, route mounting, startup tasks | `app` (Express instance) | `logger`, `serebii.runSerebiiScraper`, `normalize.auditMegaItemMappings` | `api.test.js`, `load.test.js` |

### Database (`src/db/`)

| File | Responsibility | Exports | Imports from project | Consumed by |
|------|---------------|---------|---------------------|-------------|
| `pool.js` | PostgreSQL connection pool (hardcoded creds) | `pool` (pg.Pool instance) | *(none)* | All routes, scrapers, seed, tests |
| `schema.sql` | All table DDL (12 tables, indexes) | *(not a module)* | *(none)* | Manual `psql -f` runs |
| `seed.js` | Seeds Pokemon/moves/abilities/learnsets from `@pkmn/dex` | *(self-executing)* | `pool` | Manual runs |

### Routes (`src/routes/`)

| File | Responsibility | Exports | Imports from project | Consumed by |
|------|---------------|---------|---------------------|-------------|
| `pokemon.js` | `GET /api/pokemon[/:name][/:name/moves]` | router | `pool` | `app.js` |
| `moves.js` | `GET /api/moves[/:name]` (?type filter) | router | `pool` | `app.js` |
| `health.js` | `GET /api/health` (scraper status) | router | `health.checkHealth` | `app.js` |
| `damage.js` | `POST /api/damage`, `POST /api/damage/realistic` | router, `gen`, `LEVEL`, `buildPokemon` | `pool`, `calc`, `serebii`, `normalize`, `stat_formula`, `ev_observations`, `logger` | `app.js`, `spread_scorer.js`, `team_analyzer.js`, `ev_optimizer.js` |
| `patches.js` | `GET /api/patches` (?pokemon, ?limit) | router | `pool` | `app.js` |
| `cache.js` | `GET /api/cache/stats` | router | `serebii.getCacheStats` | `app.js` |
| `ml.js` | `GET /api/ml/status` | router | `fs`, `logger` | `app.js` |
| `tournament.js` | `GET /api/tournament/teams` | router | `pool`, `logger` | `app.js` |
| `usage.js` | `GET /api/usage[/:name]` | router | `pool`, `logger` | `app.js` |
| `ev-data.js` | `GET /api/ev-data/:pokemon` | router | `logger`, `ev_observations` | `app.js` |
| `recommend.js` | Multiple recommend endpoints (moves, evs, synergy, team suggestions) | router, `getMoveRecommendationsFor` | `pool`, `logger`, `cache`, `typeChart`, `synergy_reasons`, `ev_optimizer`, `threat_matrix`, `speed_context`, `role_classifier`, `spread_scorer`, `stat_formula`, `ev_observations` | `app.js` |
| `team.js` | `POST /api/team/import`, `POST /api/team/compare`, `POST /api/team/build` | router, `parseShowdownTeam` | `pool`, `logger`, `normalize`, `typeChart`, `role_classifier`, `spread_scorer`, `item_optimizer`, `ev_optimizer`, `nerd_of_now`, `team_analyzer`, `stat_formula`, `ev_observations`, `speed_context`, `synergy_reasons` | `app.js`, `vgcpastes.js` |

### Scrapers (`src/scrapers/`)

| File | Responsibility | Exports | Imports from project | Consumed by |
|------|---------------|---------|---------------------|-------------|
| `limitless.js` | Scrape Limitless API for tournament teams (hourly cron) | `scrape` | `fetch`, `cron`, `pool`, `normalize`, `retry`, `health` | *(self-executing)* |
| `serebii.js` | Scrape Serebii for balance patches (12hr cron) + damage cache | `runSerebiiScraper`, `damageCache`, `invalidateCacheForPokemon`, `buildCacheKey`, `getCachedDamage`, `setCachedDamage`, `getCacheStats` | `fetch`, `cron`, `cheerio`, `pool`, `retry`, `health` | `app.js`, `damage.js`, `cache.js` |
| `stats.js` | Compute usage stats + retrain stale ML models (6hr cron) | `computeUsageStats`, `retrainStaleModels` | `pool`, `cron`, `ml.runPythonScript`, `threat_matrix`, `speed_context` | *(self-executing)* |
| `vgcpastes.js` | Scrape Google Sheets VGCPastes for real Stat Point data (6hr cron) | `scrape` | `fetch`, `cron`, `pool`, `retry`, `health`, `team.parseShowdownTeam` | *(self-executing)* |

### Utils (`src/utils/`)

| File | Responsibility | Exports | Imports from project | Consumed by |
|------|---------------|---------|---------------------|-------------|
| `logger.js` | JSON-structured logger (info + error streams, daily rotation) | `logger` (`{info, error}`) | *(none)* | All files |
| `retry.js` | Exponential-backoff retry wrapper | `withRetry` | `logger` | `limitless.js`, `serebii.js`, `vgcpastes.js` |
| `health.js` | Scraper health DB persistence + alert threshold detection | `recordSuccess`, `recordFailure`, `recordHealth`, `checkHealth` | `pool`, `logger` | `limitless.js`, `serebii.js`, `vgcpastes.js`, `health.js` (route), `stats.js` |
| `cache.js` | Generic TTL + LRU-eviction cache factory | `createCache` | *(none)* | `recommend.js` |
| `normalize.js` | Pokemon name normalization, team parsing, Mega item mapping | `normalizePokemonName`, `normalizeTeam`, `auditMegaItemMappings`, `MEGA_ITEM_MAP` | `Dex`, `pool`, `logger` | `limitless.js`, `damage.js`, `team.js`, `app.js` |
| `typeChart.js` | Type effectiveness (from `@pkmn/dex` damageTaken) | `ALL_TYPES`, `effectivenessAgainst`, `weaknessesOf`, `resistancesOf` | `Dex` | `team.js`, `recommend.js`, `synergy_reasons.js`, `team_analyzer.js`, `spread_scorer.js`, `api.test.js` |
| `stat_formula.js` | Champions SP formula, stat calculation, breakpoint detection | `SP_CAP_PER_STAT`, `SP_BUDGET_TOTAL`, `SP_STEPS`, `spToEv`, `calcStat`, `findBreakpoints`, `snapToBreakpoint`, `findMinSpForStat`, `natureMultiplierFor` | *(none)* | `damage.js`, `team.js`, `recommend.js`, `ev_optimizer.js`, `spread_optimizer.js`, `spread_scorer.js`, `ev_observations.js`, `item_optimizer.js`, `speed_context.js`, `threat_matrix.js`, `nerd_of_now.js`, `team_analyzer.js`, `role_classifier.js` |
| `ev_observations.js` | DB queries over `ev_observations` + `pokemon` tables | `getSpeciesRow`, `getObservationCount`, `getNatureDistribution`, `getCommonSpreads`, `getCommonSpeedTiers`, `getMostCommonSpread`, `getCommonItems`, `getTopDamageAffectingItem`, `DAMAGE_AFFECTING_ITEMS` | `pool`, `stat_formula` | `damage.js`, `team.js`, `recommend.js`, `ev_optimizer.js`, `spread_scorer.js`, `item_optimizer.js`, `speed_context.js`, `threat_matrix.js`, `role_classifier.js`, `ev-data.js` |
| `role_classifier.js` | `classifyRole()` → one of 4 roles from base stats + moveset + SP observations | `classifyRole`, `FAST_SPEED_THRESHOLD`, `OFFENSIVE_STAT_THRESHOLD`, `BULKY_TOTAL_THRESHOLD` | `pool`, `ev_observations.getSpeciesRow`, `fs` | `team.js`, `recommend.js`, `ev_optimizer.js`, `spread_scorer.js`, `item_optimizer.js` |
| `speed_context.js` | Meta speed tiers, Scarf/ability speed modifiers, Trick Room relevance | `getMetaContext`, `getSpeedModifiers`, `getAbilityFrequency`, `trickroomRelevant`, `SCARF_FREQUENCY_THRESHOLD`, `CONDITION_PREVALENCE_THRESHOLD`, `ABILITY_PROFILE_FREQUENCY_THRESHOLD` | `pool`, `ev_observations`, `stat_formula` | `team.js`, `recommend.js`, `ev_optimizer.js`, `spread_scorer.js`, `stats.js` |
| `threat_matrix.js` | Build top-50 × top-10-moves weighted threat list from usage data | `getThreatMatrix`, `buildThreatMatrix`, `TOP_ATTACKERS`, `TOP_MOVES_PER_ATTACKER` | `pool`, `ev_observations`, `stat_formula` | `ev_optimizer.js`, `recommend.js`, `stats.js` |
| `synergy_reasons.js` | Mechanical synergy reason generation from type/weather/ability interactions | `generateSynergyReasons` | `typeChart.effectivenessAgainst` | `team.js`, `recommend.js`, `team_analyzer.js` |
| `ml.js` | Node ↔ Python bridge via child process | `runPythonScript`, `PYTHON_PATH` | `path`, `child_process`, `logger` | `stats.js` |
| `nerd_of_now.js` | Fetch + parse expert competitive sets from Nerd of Now GitHub repo | `getNerdOfNowSets`, `getSeedLabel`, `clearCache`, `getAvailablePokemon`, `getStats`, `loadCache`, `evToSp`, `convertEVsToSP` | `fetch`, `pool`, `stat_formula`, `logger`, `Dex` | `team.js`, `spread_optimizer.js` |
| `nerd_of_now_calc.js` | Ported Nerd of Now damage calculator (standalone, not `@smogon/calc`) | `CalcDamage`, `detectTeamWeather`, `buildStatsFromSP`, `calcBaseDamage`, `calcStatHP`, `calcStatNonHP`, `getNatureMult`, `chainMods`, `pokeRound`, `getMoveEffectiveness` | *(none — self-contained)* | *(not imported by any other source file — standalone utility)* |
| `item_optimizer.js` | Item candidate scoring, conflict resolution, ability resolution, weather detection | `getScoredCandidateItems`, `resolveItemConflicts`, `buildItemSpNotes`, `getRealAbilityFrequency`, `detectTeamWeatherContext`, `resolveRealAbility`, `isConditionalSpeedAbility`, `conditionalSpeedAbilityWeather`, `itemBreakpointBonus`, `findLifeOrbBreakpoints`, `findLeftoversBreakpoints`, `megaStoneSynergyPenalty`, `OFFENSIVE_ROLES`, `BULKY_ROLES`, `WEATHER_SETTER_ABILITIES`, `WEATHER_SETTER_MOVES` | `pool`, `ev_observations`, `stat_formula`, `role_classifier` | `team.js`, `spread_scorer.js`, `api.test.js` |
| `spread_scorer.js` | Fitness function for SP spreads using `@smogon/calc` | `scoreSpread`, `minimizeSpread`, `koFromPercent`, `getTopAttackerSpreads`, `getPokemonRow`, `getMoveRow`, `buildRecoilText`, `RECOIL_MOVES`, `topMovesFor`, `damageCalcCache`, `MIN_THREAT_WEIGHT`, `TYPE_VALUES`, `SCORER_VERSION`, `computeAggressionMultiplier`, `buildAttackerBuildLabel` | `pool`, `calc`, `damage`, `stat_formula`, `ev_observations`, `speed_context`, `item_optimizer`, `role_classifier`, `typeChart` | `spread_optimizer.js`, `ev_optimizer.js`, `recommend.js`, `team.js` |
| `spread_optimizer.js` | Genetic algorithm search: `findOptimalSpread()` | `findOptimalSpread`, `determineLockedIndices`, `generateCandidate`, `crossover`, `mutate`, `generateNeighborhood`, `validateSpread`, `ROLE_WEIGHTS`, `POP_INIT`, `GENERATIONS` | `spread_scorer`, `stat_formula`, `nerd_of_now`, `logger` | `ev_optimizer.js`, `evolutionary_worker.js` |
| `evolutionary_worker.js` | `worker_threads` entry point for parallel team-build SP searches | *(self-executing worker)* | `spread_optimizer.findOptimalSpread` | `ev_optimizer.js` |
| `ev_optimizer.js` | SP threshold optimization (greedy fallback) + evolutionary orchestration | `optimizeEvs`, `getOrComputeEvolutionarySpread`, `findDefensiveThresholds`, `findSpeedThresholds`, `findOffensiveThresholds`, `findSurvivalThreshold`, `applyRoleMultipliers`, `getEvolutionaryStatus`, `ROLE_MULTIPLIERS`, `ROLE_PRIORITY_TEXT` | `pool`, `calc`, `damage`, `stat_formula`, `threat_matrix`, `ev_observations`, `role_classifier`, `spread_optimizer`, `spread_scorer`, `speed_context`, `Worker` | `recommend.js`, `team.js` |
| `team_analyzer.js` | Full team analysis: coverage, synergy, weather, TR, speed, weaknesses, archetype matchups | `analyzeTeam`, `analyzeCoverage`, `analyzeSynergies`, `analyzeWeather`, `analyzeTrickRoom`, `analyzeSpeedTiers`, `analyzeWeaknesses`, `analyzeArchetypeMatchups`, `analyzeMatchups`, `getLegalPokemonSet`, `buildWideGuardSynergy`, `buildRagePowderSynergy`, `buildHospitalitySynergy`, `batchFetchTopMoveData`, `suggestCoverageReplacements`, `ARCHETYPES` | `pool`, `calc`, `damage`, `typeChart`, `synergy_reasons`, `stat_formula`, `ev_observations`, `item_optimizer` | `team.js` |

### Tests

| File | Responsibility | Exports |
|------|---------------|--------|
| `api.test.js` | 69 integration tests across all endpoints | `runTests` (self-executing) |
| `load.test.js` | Concurrent load test with p95 latency targets | `run` (self-executing) |

---

## Key Data Flows

### POST /api/team/build (end-to-end)

```
team.js buildTeam() → 
  role_classifier.classifyRole() for each of 6 → 
  item_optimizer.getScoredCandidateItems() → 
  resolveItemConflicts() → 
  ev_optimizer.getOrComputeEvolutionarySpread() for each (6× parallel via Worker threads) →
    evolutionary_worker.js → spread_optimizer.findOptimalSpread() →
      spread_scorer.scoreSpread() (thousands of @smogon/calc calls) →
  team_analyzer.analyzeTeam() →
    analyzeCoverage(), analyzeSynergies(), analyzeWeather(),
    analyzeTrickRoom(), analyzeSpeedTiers(), analyzeWeaknesses(),
    analyzeArchetypeMatchups(), analyzeMatchups() →
  buildTeamBuildText() (text/plain formatter)
```

### Damage Calculation Path

```
damage.js POST /api/damage → 
  normalizePokemonName() on names →
  buildPokemon() using @smogon/calc (EVs via spToEv()) →
  @smogon/calc calculate() with Field (weather, terrain)
```

The standalone `nerd_of_now_calc.js` exists as a ported calculator but is not currently
imported by any other module — it was ported for reference/availability.

### Data Pipeline

```
limitless.js (hourly) → fetch tournaments from play.limitlesstcg.com → 
  normalizeTeam() → INSERT INTO tournament_teams

vgcpastes.js (every 6hr) → fetch Google Sheet → 
  parseShowdownTeam() from pokepast.es links → INSERT INTO ev_observations

stats.js (every 6hr) → 
  computeUsageStats() via SQL aggregation → INSERT INTO usage_stats →
  retrainStaleModels() → runPythonScript() for each model older than 7 days

serebii.js (every 12hr) → fetch patch.shtml → 
  INSERT INTO balance_patches → invalidate damage cache for changed Pokemon
```

---

## Directory Layout (summarized)

```
src/
├── app.js
├── db/            — schema.sql, pool.js, seed.js
├── ml/            — 7 Python files, models/ (generated)
├── routes/         — 13 route files
├── scrapers/       — 4 scrapers
├── tests/          — api.test.js, load.test.js
└── utils/          — 22 utility modules
```
