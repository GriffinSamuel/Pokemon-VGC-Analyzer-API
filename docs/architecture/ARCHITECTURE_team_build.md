# Team Build Flow

## Entry Point

`POST /api/team/build` in `team.js:1040-1317` — takes exactly 6 Pokemon names.
Accepts `application/json` and `text/plain` (controlled by `Accept` header).

## Pipeline (in order)

### Phase 1: Validation & Lookup
`team.js:1044-1058` — validates 6 names, queries DB for each, 400 on missing.

### Phase 2: Role Classification
`team.js:1061-1063` — `classifyRole()` for each team member.
See `ARCHITECTURE_scoring_classification.md` for full detail.

Returns one of: `fast_offense`, `slow_bulky_offense`, `slow_bulky_support`, `fast_support`.

### Phase 3: Item Optimization
`team.js:1065-1073` — Two-pass item resolution:

**Pass 1 — Weather Detection** (`detectTeamWeatherContext()`):
- Scans all 6 team members' known abilities and moves for weather-setting
- Returns weather context (`Rain`, `Sun`, `Sand`, `Snow`, or `null`)
- Used for conditional-speed-ability resolution

**Pass 2 — Ability & Item Assignment** (`getRealAbilityFrequency()` + `resolveRealAbility()`):
- For each Pokemon: query real ability frequency from `tournament_teams` JSONB
- If team weather supports a conditional ability (Swift Swim in Rain), prefer it
- Choice Scarf excluded when real conditional-speed ability is active
- Provisional pick → weather context → final pick

**Item Scoring** (`getScoredCandidateItems()`):
- Top 5 real observed items from `ev_observations` (via `getCommonItems()`)
- Each scored by: `frequency × item_role_fit`
- `item_role_fit` computed from role compatibility (offensive items for fast_offense, etc.)
- Generic fallback items scored at 0.25

**Conflict Resolution** (`resolveItemConflicts()`):
- When two Pokemon share the same rare item, greedy assign by `loss_of_value`
- Leftovers, Life Orb, Rocky Helmet are single-instance
- Items with quantity > 1 in rules can be shared

### Phase 4: Move Recommendations
`team.js:1085-1106` — Top 4-6 moves with team context notes:
- Calls `getMoveRecommendationsFor()` for each Pokemon
- Filters: type coverage gaps, weather synergy, TR consideration
- Choice item holders have Protect hard-filtered (`CHOICE_ITEMS_BANNING_PROTECT`)
- Trick Room priority: `isTrickRoomViableTeam()` gate (median Spe < 70, 3+ < 80, 1+ < 60)
- Synergy notes appended per-move

### Phase 5: SP Optimization (Parallel via Worker Threads)
`team.js:1108-1160` — `getOrComputeEvolutionarySpread()` for each of 6 Pokemon:

1. Spawns 6 `Worker` threads via `evolutionary_worker.js`
2. Each worker runs `spread_optimizer.findOptimalSpread()` independently
3. Real OS-level parallelism (not `Promise.all()` which serializes CPU-bound work)
4. Results collected via `parentPort.on('message')`
5. Single-worker failure doesn't fail the whole team build — Pokemon with failed search
   falls back to greedy threshold results

Each worker receives: `{pokemonRow, nature, role, threatMatrix, metaContext, 
observationCount, item, teamBuild: true, seeds, fieldOpts}`

Search parameters for team build: 300 initial candidates, 60 generations, ±8 local search range.

### Phase 6: Team Analysis
`team.js:1162-1260` — `team_analyzer.analyzeTeam()`:

#### analyzeCoverage()
- Computes type coverage of all team moves combined
- Finds coverage gaps (types no team member hits super effectively)
- For each gap: suggests which team member can learn a coverage move via `suggestCoverageReplacements()`
- Reports duplicate-coverage (multiple team members hitting same type)

#### analyzeSynergies()
- Weather synergy: setters + abusers
- Trick Room: beneficiaries (base Spe < 50) + hurt members (base Spe > 80)
- Redirection: Follow Me/Rage Powder users
- Wide Guard synergy: Wide Guard + teammates weak to spread moves
- Hospitality: Sipper Steam ability synergy
- Core archetype detection (Sun, Rain, Sand, TR, Hyper Offense, Balance, Stall)

#### analyzeWeather()
- Detects weather setters (abilities + moves) on team
- Identifies weather abusers (Swift Swim, Chlorophyll, etc.)
- Reports if weather is set but no abusers present (and vice versa)

#### analyzeTrickRoom()
- Runs `isTrickRoomViableTeam()` — if not viable, TR removed from recommendations
- Reports which members benefit (low Spe) and which are hurt (high Spe)
- For viable TR: reports Prankster Taunt prevention considerations

#### analyzeSpeedTiers()
- Computes `effectiveSpeed()` for each team member (accounting for Scarf + abilities)
- Compares against meta speed benchmarks from `getMetaContext()`
- Reports speed tier advantages/disadvantages
- Identifies speed ties (same effective speed stats)

#### analyzeWeaknesses()
- Type coverage: counts team members weak to each type
- Reports types where 2+ team members share a weakness
- For each shared weakness: identifies which team member(s) carry it
- Archetype threat analysis: for each of 5 archetypes (Sun, Rain, Sand, Trick Room, 
  Hyper Offense), checks team's ability to handle key threats of that style

#### analyzeArchetypeMatchups()
5 archetype matchup ratings:
- Sun, Rain, Sand, Trick Room, Hyper Offense
- For each: checks key threats filtered to Pokemon with actual `usage_stats` rows
- Computes Weather Ball counter-check for sand archetype
- Returns rating: strong / neutral / weak + reasoning

#### analyzeMatchups()
- For each Pokemon in top 50 usage (excluding teammates):
- Finds team's best super-effective answer
- Computes real `@smogon/calc` damage using top-3 attacker spreads, items, abilities
- Returns `ohko_opportunities` (team OHKOs the meta threat) + `ohko_risks` 
  (meta threat OHKOs the team) — top 20 each by usage weight

### Phase 7: Text Output
`team.js:1262-1317` — `buildTeamBuildText(responseBody, team)`:

**Section ordering** depends on team's primary role:
- DEFENSE first for slow-bulky roles
- SPEED first for fast roles

**Spread blocks** include:
- `Why:` block (one line per non-zero SP stat)
- Named move + build + damage range for each threshold
- Nerd of Now seed source in SEEDS section

**Sections:**
1. TEAM OVERVIEW (role, items, abilities)
2. INDIVIDUAL BUILDS (moves, SP spreads with Why:, SEEDS)
3. COVERAGE (gaps + suggestions)
4. SYNERGY (weather, TR, redirection, core archetype)
5. SPEED TIERS (benchmarks, ties)
6. WEAKNESSES (shared weaknesses, archetype threats)
7. MATCHUP ANALYSIS (OHKO opportunities + risks)
8. ARCHETYPE MATCHUPS (5 archetype ratings)
9. QUICK FIX RECOMMENDATIONS

### team_analyzer.js Exports

| Export | Purpose |
|--------|---------|
| `analyzeTeam(team, topMoves, seeds, spreads)` | Full pipeline orchestrator |
| `analyzeCoverage(team, topMoves)` | Type coverage matrix |
| `analyzeSynergies(team, topMoves)` | All synergy analysis |
| `analyzeWeather(team)` | Weather setter/abuser detection |
| `analyzeTrickRoom(team)` | TR viability + beneficiary detection |
| `analyzeSpeedTiers(team, metaContext)` | Speed comparison vs meta |
| `analyzeWeaknesses(team)` | Shared weakness detection + archetype threats |
| `analyzeArchetypeMatchups(team, metaContext)` | 5-archetype matchup rating |
| `analyzeMatchups(team, topMoves, spreads)` | Full @smogon/calc matchup analysis |
| `getLegalPokemonSet()` | Valid Pokemon set for coverage suggestions |
| `suggestCoverageReplacements(team, topMoves)` | Move replacement for coverage gaps |
| `ARCHETYPES` | Archetype definition constants |

## Role Classification (`role_classifier.js`)

```
classifyRole(pokemonName) → {role, signals, confidence}
```

### Classification Signals
| Signal | Fast Threshold | Notes |
|--------|---------------|-------|
| `FAST_SPEED_THRESHOLD` | Spe ≥ 95 | Categories as "fast" |
| `OFFENSIVE_STAT_THRESHOLD` | Atk or SpA ≥ 110 | Categories as "offensive" |
| `BULKY_TOTAL_THRESHOLD` | HP+Def+SpD ≥ 270 | Categories as "bulky" |

### Classification Logic
1. If NOT bulky AND fast AND offensive → `fast_offense`
2. If bulky AND NOT fast AND offensive → `slow_bulky_offense`
3. If bulky AND NOT fast AND NOT offensive → `slow_bulky_support`
4. If fast AND NOT bulky AND NOT offensive → `fast_support`
5. Mixed signals resolve by: speed_focused vs attack_focused vs defense_focused scores
6. SP observations override: if observed average SP split conflicts, adjust weighting

### Caching
Results cached in `roleCache` Map (in-memory, per-session).

## Speed Context (`speed_context.js`)

### `getMetaContext()`
Returns speed benchmarks and modifier prevalence from `usage_stats`:
- `{speed_benchmarks: [{pokemon, speed, usage}], ability_prevalence: {...}, scarf_frequency: ...}`

### `getSpeedModifiers(pokemonName)`
- Returns: `{hasChoiceScarf, hasConditionalSpeed, condition, abilityName}`
- Queries `ev_observations` + usage stats for item/ability frequency

### Constants
| Constant | Value | Meaning |
|----------|-------|---------|
| `SCARF_MULTIPLIER` | 1.5 | Speed boost from Choice Scarf |
| `ABILITY_BOOST_MULTIPLIER` | 2.0 | Speed boost from conditional abilities |
| `SCARF_FREQUENCY_THRESHOLD` | 0.20 | Min frequency to assume Scarf |
| `CONDITION_PREVALENCE_THRESHOLD` | 0.20 | Min prevalence for condition consideration |
| `ABILITY_PROFILE_FREQUENCY_THRESHOLD` | 0.10 | Min ability frequency to consider |

### Trick Room Relevance
`trickroomRelevant(pokemonSpeed, opponentSpeed)` — returns `true` when Pokemon's
Speed is LOWER than opponent's (inverse of normal speed ordering).

## Nerd of Now Seeded Initialization

`nerd_of_now.js` — Fetches `script_res/setdex_ncp-g10.js` from the Nerd of Now
GitHub repository (Gen 10 Champions M-B sets):

- 305 Pokemon, 491 total expert competitive sets available
- Converts classic EVs to SP: `SP = (EV + 4) / 8`, capped at 32/stat, 66 total
- Seeds fill N slots in GA Phase A (`POP_INIT = 200` or `300`), rest random
- Cache: local file `nerd_of_now_cache.json` with 24-hour TTL
- `getSeedLabel()` returns `"Nerd of Now"` or human-readable origin

### Set Parsing
1. Fetch raw JS file from GitHub
2. Try `JSON.parse()` after extracting `{...}` from `setdex["Name"] = {...}`
3. Fallback to regex extraction (line-by-line assignment parsing) if JSON parse fails
4. Sets without valid EV arrays are skipped with a warning
5. Gender forms resolved via `MANUAL_MAP`

## Item Optimizer (`item_optimizer.js`)

### Exports Detail

| Export | Purpose |
|--------|---------|
| `getScoredCandidateItems(pokemonRow, role)` | Top 5 observed items scored by frequency × role fit |
| `resolveItemConflicts(itemsByPokemon)` | Greedy conflict resolution |
| `buildItemSpNotes(pokemonRow, item)` | SP notes for item-specific breakpoints |
| `getRealAbilityFrequency(pokemonName)` | Query real ability frequency from tournament_teams |
| `detectTeamWeatherContext(team)` | Scan all members for weather-setting abilities/moves |
| `resolveRealAbility(pokemonRow, abilities, weatherContext)` | Final ability pick with weather context |
| `isConditionalSpeedAbility(abilityName)` | True for Swift Swim, Chlorophyll, etc. |
| `conditionalSpeedAbilityWeather(abilityName)` | Which weather activates it |
| `itemBreakpointBonus(pokemonRow, sp, item)` | Additional survivability from item |
| `megaStoneSynergyPenalty(item, pokemon)` | Adjust synergy when mega stone conflicts |

### Role-Based Item Fit Scoring
- `OFFENSIVE_ROLES` (`fast_offense`, `slow_bulky_offense`): prefer damage items (Choice Band,
  Life Orb, etc.)
- `BULKY_ROLES` (`slow_bulky_support`, `slow_bulky_offense`): prefer defensive items 
  (Leftovers, Rocky Helmet, etc.)

### Ability Resolution
Two-pass: provisional pick → weather context → final pick. Queries `tournament_teams` 
JSONB `ability` field for real frequencies, not hardcoded per-species overrides.

## Team Compare & Import

### POST /api/team/import
- Takes a Pokemon Showdown export string
- `parseShowdownTeam()` extracts Pokemon names, items, abilities, moves, nature, Tera type
- Returns `{pokemon, items, abilities, moves}` array
- 400 on empty or unparseable strings

### POST /api/team/compare
- Takes `team_a` and `team_b` (arrays of 1-6 Pokemon names each)
- For each member: gets type, ability, base stats, usage stats
- Head-to-head: `@smogon/calc` damage of each team's fastest vs the other's
- Returns `{team_a, team_b, head_to_head, summary}`
