# Data Pipeline — Scrapers, DB, Orchestration

## Database Schema (`schema.sql`)

12 tables with 21 indexes:

| Table | Primary Key | Purpose | Key Columns |
|-------|-------------|---------|-------------|
| `pokemon` | `id SERIAL` | All Pokemon + 90 Mega forms | `name, num, type1, type2, hp..spe, ability1, ability2, ability_hidden` |
| `moves` | `id SERIAL` | All moves | `name, type, category, power, accuracy, priority, pp, target, flags` |
| `pokemon_moves` | `pokemon_id, move_id` | Learnset join table | |
| `abilities` | `id SERIAL` | All abilities | `name, description` |
| `items` | `id SERIAL` | All items | `name, description` |
| `balance_patches` | `id SERIAL` | Detected stat changes | `pokemon_name, stat, old_value, new_value, detected_at` |
| `tournament_teams` | `id SERIAL` | Real tournament teams | `tournament_id, tournament_name, tournament_date, placement, wins, losses, pokemon, ability` |
| `usage_stats` | `id SERIAL` | 30-day rolling usage % | `pokemon_name, format, usage_count, usage_percent, avg_win_rate, rank` |
| `scraper_health` | `scraper_name` | Scraper run tracking | `last_success, last_attempt, last_error, total_runs, total_failures` |
| `ev_observations` | `id SERIAL` | Real SP spreads from VGCPastes | `normalized_name, species_id, format, nature, item, ability, evs (JSONB), sp_spread (JSONB), tera_type, moves` |

### Important Schema Details

- `pokemon.name`: unique, stores exact dex names (e.g., "Swampert-Mega") with Mega forms as separate rows
- `moves.flags`: JSONB column with move flag properties
- `tournament_teams.pokemon`: JSONB array of `{name, item, nature, ability, attacks: [...]}`
- `tournament_teams.ability`: individual ability name string (not JSONB)
- `ev_observations.evs`: JSONB `{hp, atk, def, spa, spd, spe}` in classic EV format (0-252)
- `ev_observations.sp_spread`: JSONB `[hp, atk, def, spa, spd, spe]` in SP (0-32)
- `ev_observations.normalized_name`: case-sensitive exact dex name (Mega-aware)

### Index Coverage
- `idx_pokemon_name`, `idx_moves_name`, `idx_abilities_name`, `idx_items_name`: primary lookup
- `idx_usage_pokemon_format`: composite for usage lookups
- `idx_teams_tournament`, `idx_teams_placement`, `idx_teams_date`: tournament query performance
- `idx_ev_obs_pokemon`: `LOWER(normalized_name)` for SP observation queries

---

## Scraper Schedules

| Scraper | Cron | Interval | Source | Target Table |
|---------|------|----------|--------|-------------|
| `limitless.js` | `0 * * * *` | Hourly | Limitless API | `tournament_teams` |
| `vgcpastes.js` | `0 */6 * * *` | Every 6 hours | Google Sheets → pokepast.es | `ev_observations` |
| `stats.js` | `0 */6 * * *` | Every 6 hours | DB (usage aggregation) + Python ML | `usage_stats` |
| `serebii.js` | `0 0,12 * * *` | Every 12 hours | Serebii patch page | `balance_patches` |

All scrapers start with a self-invocation on `require()` (run immediately once),
then schedule recurring cron jobs.

---

## Limitless Scraper (`limitless.js`)

**API:** `https://play.limitlesstcg.com/api`

**Filter logic:** `isChampionsMB()` — tournament name must contain "m-b" and must NOT
contain "smogon" (excludes Smogon-format tournaments).

**Flow:**
```
GET /tournaments → filter → GET /tournaments/{id}/standings → GET /tournaments/{id}/decklist/{deckId}
  → normalizeTeam() → INSERT INTO tournament_teams
```

**Insert:** `ON CONFLICT (tournament_id) DO UPDATE SET ...` — deduplicates by `tournament_id`.

**Error handling:** `withRetry()` with 3 attempts, exponential backoff.
Records `recordSuccess()` or `recordFailure()` to `scraper_health` table.

---

## VGCPastes Scraper (`vgcpastes.js`)

**Why it exists:** Limitless has no Stat Point data anywhere in its API — every
decklist entry only contains `{id,name,item,ability,attacks,nature,tera}`. VGCPastes'
"Champions M-B Repository" tab links to pokepast.es exports that have real Stat Points.

**Source:** Google Sheets `1axlwmzPA49rYkqXh7zHvAtSP-TKbM0ijGYBPRflLSWw`, 
Champions M-B tab GID `1458357160`.

**Flow:**
```
Google Sheets → filter unique pokepast.es links → fetch each paste →
  parseShowdownTeam() from team.js → extract SP from "EVs:" line →
  INSERT INTO ev_observations
```

**SP Extraction:**
The paste format uses classic EV notation (`EVs: 252 Atk / 4 Def / 252 Spe`),
converted via `SP = (EV + 4) / 8`.

**Caveat:** Some pastes use real SP directly (Champions-native format: `EVs: 32 HP / 
20 Atk / 14 Def`), which also converts correctly since the formula handles both ranges.

---

## Stats Orchestrator (`stats.js`)

### Usage Stats Computation
```sql
WITH team_pokemon AS (
  SELECT UNNEST(pokemon) AS mon FROM tournament_teams 
  WHERE tournament_date > NOW() - INTERVAL '30 days'
)
SELECT mon->>'name' AS pokemon_name, COUNT(*) AS usage_count,
  ROUND(COUNT(*)::numeric / total_teams * 100, 2) AS usage_percent,
  ...
FROM team_pokemon
WHERE mon->>'name' IS NOT NULL AND mon->>'name' != ''
GROUP BY mon->>'name'
ORDER BY usage_count DESC;
```

### ML Retraining
- Models older than `RETRAIN_INTERVAL_MS` (7 days) are retrained
- Uses `runPythonScript()` from `utils/ml.js` for each training script
- Each script outputs `RESULT_JSON:{...}` to stdout; parsed by `ml.js`
- After retraining, `threat_matrix.js` cache is force-refreshed

---

## Seed Script (`seed.js`)

Seeds from `@pkmn/dex`:
1. Abilities (`Dex.abilities.all()`)
2. Moves (`Dex.moves.all()`) — including `flags` as JSON
3. Pokemon + learnsets (`Dex.species.all()`) — filters `isNonstandard` and `isAlternateForm`
4. Items (`Dex.items.all()`)

Uses transaction with `BEGIN`/`COMMIT`/`ROLLBACK`. Run via `node src/db/seed.js`.

### Mega Form Seeding
The `seed.js` script seeds all non-standard Mega forms (from `Dex.species.all()`)
that have real base stats and types. 90 Mega rows total. Each gets:
- Exact Mega base stats (different from base form)
- Correct typing (e.g., Mega Charizard Y is Fire/Flying, Mega Charizard X is Fire/Dragon)
- Abilities including the Mega-specific ability

---

## Connection Pool (`pool.js`)

Single `pg.Pool` instance, hardcoded credentials. Used by all modules.
`pool.on('error')` calls `process.exit(-1)` on unexpected DB errors.

**Python side:** `db.py` uses identical hardcoded credentials via `psycopg2`.
Not connected to the Node pool — each Python process opens/closes its own connection.

---

## Data Flow Diagram

```
Limitless API ──hourly──→ limitless.js ──→ tournament_teams table
                                                  │
Google Sheets ──6hr──→ vgcpastes.js ──→ ev_observations table
                                                  │
stats.js ◄─────────────6hr─────────────────────────┘
  │
  ├── SQL aggregation → usage_stats table
  └── ML retrain (if stale) → models/ files
          │
          ├── train_moves.py → move_model.joblib + move_model_meta.json
          ├── train_evs.py → ev_model.joblib + ev_model_meta.json + ev_recommendations.json + role_spread_templates.json
          └── train_synergy.py → synergy_matrix.joblib + synergy_meta.json + synergy_matrix.json + ability_synergies.json
```
