# SP Optimization Pipeline

The optimizer uses a 3-layer architecture:
1. **Greedy threshold system** (`ev_optimizer.js`) — always fast, always available
2. **Evolutionary search** (`spread_optimizer.js` → `spread_scorer.js`) — better results, computed async
3. **Worker thread parallelism** (`evolutionary_worker.js`) — used only by team build

## Layer 1: Greedy Threshold Optimization (`ev_optimizer.js`)

### Purpose
Produces 3 priority-scored SP spreads instantly without `@smogon/calc` calls. Used as
the response for `GET /api/recommend/evs/:pokemon` when evolutionary results aren't ready,
and as the permanent fallback for Pokemon with no threat-matrix data.

### Exports
- `optimizeEvs(pokemon, nature, item)` → `[{sp, final_stats, ...}, {sp, final_stats, ...}, {sp, final_stats, ...}]`
- `getOrComputeEvolutionarySpread(pokemonRow, nature, ...)` — orchestrates fire-and-forget evolutionary search + fallback
- `findDefensiveThresholds()` + `findSpeedThresholds()` + `findOffensiveThresholds()` — per-category threshold scanning
- `findSurvivalThreshold()` — binary search for minimum SP to survive a specific attacker/move
- `applyRoleMultipliers()` — priority adjustment by role
- `getEvolutionaryStatus()` — query evolutionary cache readiness

### Threshold System Constants

`ROLE_MULTIPLIERS` (line ~27):
- `fast_offense`: 3× speed, 2× offense, 1× defense
- `slow_bulky_offense`: 2× defense, 2× offense, 1× speed
- `slow_bulky_support`: 3× defense, 2× speed, 1× offense
- `fast_support`: 3× speed, 2× defense, 1× offense

These are role-based priority weights used by the greedy threshold scanner to decide which
thresholds to prioritize — they affect spread selection, not the `@smogon/calc` output.

## Layer 2: Evolutionary Search (`spread_optimizer.js` + `spread_scorer.js`)

### `spread_optimizer.js` — Genetic Algorithm

```
findOptimalSpread(pokemonRow, nature, role, threatMatrix, metaContext, 
                   observationCount, item, teamBuild, seeds, fieldOpts)
```

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `pokemonRow` | DB row for the Pokemon (base stats, types) |
| `nature` | Nature string (e.g., "Adamant") |
| `role` | From `classifyRole()` |
| `threatMatrix` | From `getThreatMatrix()` |
| `metaContext` | From `getMetaContext()` |
| `observationCount` | From `getObservationCount()` |
| `item` | Resolved item |
| `teamBuild` | Boolean — affects POP_INIT/GENERATIONS |
| `seeds` | Nerd of Now expert sets (from `getNerdOfNowSets()`) |
| `fieldOpts` | Optional weather/terrain override |

**Search Parameters:**
- Solo request: 200 init candidates (POP_INIT), 40 generations
- Team build: 300 init candidates, 60 generations
- Local search: ±8 SP range (team build) or ±5 (solo) in Phase C

**GA Phases:**
- Phase A — Initialization: N seeds from Nerd of Now (up to POP_INIT), rest random
- Phase B — Main loop: selection → crossover → mutation for N generations
- Phase C — Local search: neighborhood hill-climb around best result
- Returns all candidates sorted by `scoreSpread()` descending

### `spread_scorer.js` — Fitness Function

The core scoring function `scoreSpread(spread, pokemonRow, nature, role, threatMatrix, ...)`:

**TYPE_VALUES** (verified at `spread_scorer.js`):
```
ohko_prevented: 10.0, 2hko_prevented: 3.0, 3hko_prevented: 0.3,
4hko_prevented: 0.05, ohko_achieved: 8.0, 2hko_achieved: 2.0,
speed_tier: 4.0, trickroom_speed: 3.0
```

**Scoring formula:** `contribution = TYPE_VALUES[tier] × effective_weight × role_mult × factor`

**Aggression Multiplier** (applied to DEFENSIVE checks only):
- Super effective (≥2x): ×2.5
- STAB + neutral (1x): ×1.2
- Offensive-role attacker: ×1.0
- Support-role, STAB, ≤1x: ×0.20 (`AGGRESSION_SUPPORT_STAB`)
- Support-role, non-STAB, ≤1x: ×0.05 (`AGGRESSION_SUPPORT_OFF_STAB`)
- Non-damaging move: ×0.0

**Speed-OHKO Link** (`SPEED_OHKO_LINK_MULTIPLIER = 3.0`):
- When the attacker would OHKO at baseline AND the defender outspeeds, the speed-tier
  contribution is multiplied by 3.0
- `DEATH_TRAP_MIN_WEIGHT = 0.15`, `PENALTY_MULTIPLIER = 2.0`:
  When outsped + OHKO'd at baseline + no Protect/priority in top 4 moves → penalty

**KO Tier Classification:**
- Defensive: `koCheckValue = Math.max(maxs)` — worst single damage roll from any top-3 build
- Offensive: `koCheckMin = Math.min(mins)` — bulkiest target's minimum damage roll

### Damage Calc Cache (`damageCalcCache`)
An in-memory `Map<string, {result, timestamp}>` inside `spread_scorer.js` that caches
`@smogon/calc` results during a single search run. Keyed by
`attacker:defender:move:attackerSp:defenderSp:attackerItem:defenderItem:field`. Cleared
between search runs. Separate from serebii.js's `damageCache` for POST /api/damage.

### Role-Specific Weights in GA

`spread_optimizer.js` `ROLE_WEIGHTS`:
- `fast_offense`: `{bulk: 0.2, speed: 0.50, offense: 0.30}`
- `slow_bulky_offense`: `{bulk: 0.50, speed: 0.10, offense: 0.40}`
- `slow_bulky_support`: `{bulk: 0.70, speed: 0.20, offense: 0.10}`
- `fast_support`: `{bulk: 0.30, speed: 0.50, offense: 0.20}`

These weight the GA's multi-objective selection pressure (bulk vs speed vs offense).

### SCORER_VERSION

`spread_scorer.js`'s `SCORER_VERSION = 9` (line ~52). Included in the evolutionary cache
key so that when the scoring function changes, cached results from prior versions are
automatically invalidated.

## Layer 3: Worker Threads (`evolutionary_worker.js`)

Only the team-build path uses worker threads — `POST /api/team/build` needs 6 concurrent
SP searches under its ~30s budget. Without workers, 6 searches serialize to ~6× the
single-Pokemon cost because `@smogon/calc` `calculate()` is synchronous CPU work.

- Each worker creates its own `pg.Pool` instance (closed explicitly before exit)
- Communication via `workerData` (input) and `parentPort.postMessage` (output)
- Pool connection count = number of concurrent workers (not shared with main thread)

## Threat Matrix (`threat_matrix.js`)

```
buildThreatMatrix() → [{attacker, move, weight, type, ...}] with top 50 attackers × top 10 moves
```

- Built from `usage_stats` — top 50 Pokemon by usage, their top 10 most common moves
- Weighted by usage_percent
- Cached with 6-hour refresh interval (matches stats.js cadence)
- Consumed by `ev_optimizer.js` and `recommend.js`

## Observe Data Layer (`ev_observations.js`)

Shared query helpers for the `ev_observations` table:

| Function | Returns |
|----------|---------|
| `getSpeciesRow(name)` | Pokemon DB row (with hyphen-fallback for Megas) |
| `getObservationCount(name)` | Count of SP observations |
| `getNatureDistribution(name)` | `[{nature, count, frequency}]` |
| `getCommonSpreads(name)` | `[{sp, frequency, count}]` top spreads |
| `getCommonSpeedTiers(name)` | `[{speed_stat, count, frequency}]` |
| `getMostCommonSpread(name)` | Single most-common spread or null |
| `getCommonItems(name)` | Top 5 items by frequency |
| `getTopDamageAffectingItem(items)` | First item in list that affects damage |

## Evolutionary Cache

`ev_optimizer.js` maintains an in-memory cache (`EVOLUTIONARY_CACHE`) for evolutionary
results. Keyed by `pokemon:nature:item:teamBuild` + `SCORER_VERSION`. The `X-Spread-Status`
header in responses indicates `computing` (greedy fallback returned, search in progress)
vs `optimal` (evolutionary result returned).
