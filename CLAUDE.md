# Pokemon VGC Analyzer API — Claude Instructions

## CRITICAL: Process Management
**NEVER run `taskkill` on `node.exe`. OmniRoute runs on port 20128 and must never be terminated.** To restart the API server: find the specific PID on port 3000 via `netstat -ano | findstr :3000`, kill that PID only.

## CRITICAL: Python Environment
Python is installed via `.venv` in the project root. Plain `python` is intercepted by Windows Store — always use:
- `.venv\Scripts\python.exe` in shell commands
- `src/utils/ml.js`'s `runPythonScript()` for programmatic calls

## CRITICAL: Conventions & Structure Docs
**Before editing any file, consult `docs/conventions/INDEX.md` and read the relevant `CONVENTIONS_*.md` for that subsystem's conventions. For structural relationships (call sites, data flow, module map), use `graphify query "<question>"` or `graphify path "<A>" "<B>"` — graphify owns the architecture layer.**

---

## Project Overview
Backend API for a Pokemon VGC team analyzer focused on **Champions Regulation M-B** (current 2026 format). Scrapes real tournament data from Limitless API + VGCPastes, computes usage stats, and powers ML-based move recommendations, SP optimization, and damage calculations.

## Tech Stack
- **Runtime:** Node.js v24 | **Framework:** Express.js | **Database:** PostgreSQL 18 (local, port 5432)
- **Key packages:** `@pkmn/dex`, `@pkmn/data`, `@smogon/calc`, `node-fetch@2`, `node-cron`, `pg`, `helmet`, `cors`, `cheerio`, `express-rate-limit`, `worker_threads`
- **ML:** Python 3.12 via `.venv` (scikit-learn, pandas, numpy, psycopg2-binary, joblib)
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
    ├── spread_scorer.js        — Real CalcDamage fitness function for SP spreads
    ├── spread_optimizer.js     — Genetic algorithm: findOptimalSpread()
    ├── synergy_reasons.js      — Mechanical synergy reason generation
    ├── item_optimizer.js       — Item candidate scoring + conflict resolution
    ├── team_analyzer.js        — Coverage, synergy, weather, TR, speed, weaknesses, matchups
    ├── evolutionary_worker.js  — worker_threads entry for parallel team-build searches
    ├── nerd_of_now.js          — Expert competitive set seeding for optimizer
    └── nerd_of_now_calc.js     — Ported Nerd of Now damage calculator (standalone)
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

## Champions Stat Point System (Critical Conventions)

Champions uses **66 Stat Points total, max 32 per stat** (not classic 508-EV system).

**Formulas:**
- `HP = base + sp + 75`
- `OtherStat = floor((base + sp + 20) × alignment)` where alignment = 1.1 (boosted), 1.0 (neutral), 0.9 (hindered)
- `spToEv(sp)`: `EV = 8 × SP − 4` for SP≥1, 0 for SP=0

**Why CalcDamage works:** Champions is mechanically identical to classic Gen 9, re-expressed in per-stat units. `nerd_of_now_calc.js` ports the Nerd of Now calculator to speak SP (0-32) natively — no EV conversion needed.

**Key rules:**
- All damage calcs use `CalcDamage()` from `nerd_of_now_calc.js` — `@smogon/calc` is fully retired
- Storage, observations, optimization, and all API endpoints speak SP (0-32/stat, 66 total) exclusively
- `POST /api/damage`'s `evs` field is intentionally classic EVs (0-252), not SP — converted to SP internally via `evsToSp()`
- Champions has no IV mechanic (always 31)
- `validateSpread()` in `spread_optimizer.js` enforces caps after every GA operation; `recommend.js:813` enforces on input; `spread_scorer.js:1094` asserts final total
- `slow_bulky_support` locks Atk AND SpA to 0; other roles lock the weaker of Atk/SpA
- Unspent SP is 0 in a slot — budget is a ceiling, not a target
- `nerd_of_now.js:evToSp(EV) = (EV + 4) / 8` — cap 32/stat, 66 total (proportional scale-down)

---

## Known Issues / Open Bugs
- `move_recommendations.json` still blends some Mega forms under base species key (Python `species_key()` unchanged). `species_identity_key()` fix applied for `train_moves.py` but not all entry points.
- `team_analyzer.js`'s Trick Room synergy suppression counts base Speed from `pokemonRow` — no per-team dynamic adjustment.
- Some `-Mega` species (Chimecho-Mega, Rayquaza-Mega, etc.) have DB rows but no `MEGA_ITEM_MAP` entry — unreachable from real scraped teams.
- `nerd_of_now_calc.js` is a standalone ported calculator — not imported by any other module.
- `seed.js`'s `pokemon`-table seed had its own copy of the `isNonstandard` gate, unfixed until this changed too — Aegislash and 16 other observed-but-absent species (Aerodactyl, Kangaskhan, Starmie, Vanilluxe, etc.) now have `pokemon` rows. 25 of the 256 legal `usage_stats` species still miss via the real resolver (`scripts/check_missing_species.js`) — now dominated by regional-form naming mismatches (Hisuian/Galarian/Alolan/Rotom forms resolving under a different display name than the dex), not the isNonstandard gate.
- 6 species observed in `tournament_teams` still have no `pokemon` row: `F`/`M`/`Species-F`/`Species-M` — these are scraper name-normalization artifacts (a bare gender letter or suffix instead of a real species name), not a dex/seeding gap. Unscoped this session.
- Floette-Eternal-Mega does not exist in `Dex.species.all()` at all (`Dex.species.get()` silently fuzzy-matches it to the unrelated Floette-Mega) — cannot be seeded a learnset without fabricating one; needs an explicit decision on how to represent it. `knowsMove()` now has an `isDexResolvable()` guard so this can never regress into a false `'illegal'` veto on a move a dex-absent species is actually observed running.
- Heavy-recoil moves: whether they belong in the recommendation pool at all (vs. just losing ties against non-recoil alternatives, the fix already applied) is a format/design judgment call, not resolved.
- The ~133 mangled-`id` Mega rows (raw scraped id of `m`/`f` alongside a real name, rescued by `normalizePokemonName`'s `MEGA_ITEM_MAP` branch) are correct downstream — owner decision to leave the raw id as-is.
- **Fixed this session:** `species_key()`-based existence checks across the ML pipeline (`data.py`'s `species_identity_key()`, `train_synergy.py`'s `team_pokemon_identity()`, `train_evs.py`'s `build_role_dataset()`, `recommend.js`'s `speciesKey()`) preferred the scraped `id` field unconditionally. 467 `tournament_teams` entries across 60+ distinct species (verified live) carry a bare gender letter (`f`/`m`) in `id` instead of a real species id — distinct from the line above's 6 species, where `name` is *also* just a bare letter and unresolvable; here `name` is the correct display string ("Tinkaton") and the id-only lookup was simply ignoring it. This is what caused `GET /api/recommend/moves/Tinkaton` to 404 (true count 10, undercounted to 8). Fixed via `resolve_base_key()` (id-then-name fallback, `data.py`) and `normalizedName`-preference (`recommend.js`). `train_moves.py`'s Mega-blending gap (line above) is a *separate* defect in the same functions — this fix only touches existence resolution, not Mega-identity bucketing, and remains open.
- **Fixed this session:** the item-recommendation generic-fallback pool (`item_optimizer.js`'s old `GENERIC_FALLBACK_BY_ROLE`) was a hand-written list, not derived from this format's own data — it included Assault Vest, Choice Band, Choice Specs, and Rocky Helmet, all four confirmed to have zero observed occurrences across 10,000+ scraped item slots (the owner independently confirmed Assault Vest isn't legal in Champions Regulation M-B). Replaced with `getGlobalItemFrequency()`, a real observed-frequency query, ranked by `itemRoleFit()`. `DAMAGE_BOOSTING_ITEMS`/`itemRoleFit()` still contain a few other zero-observed items (Choice Band/Specs, Hard Stone, Silver Powder, Thick Club, Deep Sea Tooth) as inert scoring-only entries — harmless since they can no longer be *assigned* by either the real-candidate or fallback path, and left in place so the code already knows how to score them if real data ever includes one.
- No explicit Champions Regulation M-B species-legality list exists anywhere in this repo or DB (see `src/config/format_legality.js`'s header) — `POST /api/team/build` now rejects the small set of species explicitly confirmed illegal this session (Raging Bolt, Ursaluna-Bloodmoon), but that list is a manually-curated denylist, not derived from any data source, and is known-incomplete. A real fix needs an authoritative Regulation M-B ruleset to populate a proper `format_legality` table from.
- **Fixed this session:** `effectiveSpeed()` (`team_analyzer.js`) never computed a final stat itself — it only read a precomputed `final_stats.spe` or fell back to raw base Speed. Every opposing key threat (`buildKeyThreats`, `archetype_matchups.js`) passes `final_stats: null`, so every threat's reported Speed was its base stat while our own team used real final stats — e.g. a Rain team's Swampert-Mega (base 70, really ~244 effective under a full-Speed spread + Swift Swim + Rain) was reported at 70 and "outsped" by literally everything on our side. Also fixed in the same function: the weather-active check only understood one of the two live weather-context shapes (so the speed-doubling-ability branch could never fire for an opposing threat), Choice Scarf returned early before that branch ran (so Scarf + a doubling ability could never stack), and neither multiplier floored. `effectiveSpeed` now computes the final stat via the existing `calcStat`/`natureMultiplierFor` when `final_stats.spe` is absent, reads both weather-context shapes, and stacks Scarf/ability/an opt-in Tailwind multiplicatively with flooring after each step. `archetype_swaps.js` had already hand-rolled a correct workaround for this exact bug (`effectiveSpeedFor`, with a comment naming the defect) — simplified to delegate to the now-fixed `effectiveSpeed` instead of duplicating the SP formula. Verified live: the Rain archetype's weighted rating fell 61→48 (FAVORABLE→EVEN) now that our team correctly moves second against Swampert-Mega; every weather/Hyper-Offense archetype rating fell except Trick Room (42→47), which is the expected direction since TR inverts the speed comparison.
- **Fixed this session:** the archetype-matchup exchange grid (`buildExchangeGrid`) computed damage under a single weather — the archetype's own if it had one, else `null` — even for archetypes with no weather tag (Hyper Offense, Balance, Trick Room) whose team could still be running a real weather setter. It also never checked any OTHER plausible weather for a KO that might only land in one of them. Now: the grid's scoring weather falls back to the team's own weather when the archetype sets none, and per move, `weatherChangesDamage()` (already used correctly elsewhere) gates a cheap alternate-weather recalc, surfaced only when the number actually differs — a KO that only lands in one weather no longer reads as unconditional. The grid header now states its weather and Tailwind assumptions in plain language. A Tailwind scenario (2x Speed, 4 turns, never folded into the baseline order) is now computed for both sides and surfaced per-cell only when it flips who moves first.
- **Confirmed, not fixed — same defect, different section:** `buildResistances` (`archetype_matchups.js`) computes every "resisted hit still lands for N%" damage figure with weather hardcoded to `null`, unconditionally, with no `weatherChangesDamage()` gate and no per-scenario labelling — e.g. a Rain archetype's Water-type resisted hit is always shown as if no weather were up. This is the identical defect `buildExchangeGrid` was just fixed for (see above), left open here because fixing it requires the same weathers-plural threading this session already did for the exchange grid, not attempted here to keep this session's diff scoped to Tasks 1-2.
- **Confirmed, not fixed (explicitly out of scope this session — investigate before scoping a fix):** the `pokemon` table has no `ability` column (`ability1`/`ability2`/`ability_hidden` only), yet three real call sites build a `CalcDamage` side by reading a plain `.ability` off a `pokemon`-table row with no fallback to a real value: `spread_scorer.js`'s `runCalc` (feeds the SP-optimization genetic algorithm via `weightedDefensiveDamage`/`weightedOffensiveDamage` — every damage calc in the SP-spread-search path runs with NO ability on either side, though `nerd_of_now_calc.js` implements ~20 damage-affecting abilities), `src/routes/damage.js`'s `buildPokemon` (so `/api/damage` and `/api/damage/realistic` never model ability at all, regardless of what a client sends — there is no `side.ability` read anywhere in that file), and `team_analyzer.js`/`archetype_matchups.js`'s `damagePercentRange` (`ability: attackerSide.ability || attackerRow.ability || ''` — here the fallback is currently inert since every real caller already populates `attackerSide.ability` correctly, but it's the identical bug shape). Separately, `spread_scorer.js`'s `buildAttackerBuildLabel` resolves and prints the attacker's real ability correctly for display (`[ability1, ability2, ability_hidden].filter(Boolean)[0]`) — so a report line can print "... Defiant" for a calculation that never actually modeled Defiant. Needs its own scoped pass; estimate of SP-spread impact not yet sized.
- **Fixed this session:** the exchange grid's `their_best_damage` ("worst N%") and `theyOhko` verdict were both accumulated from the SCORING weather's calc only, even though the same cell already computed and displayed alternate-weather numbers below it — so a row could print "survives (worst 38.1%)" with a bigger "50.8%" shown two lines beneath it (real example, Archaludon vs. Pelipper in the Rain archetype; a second contradiction in the exact same row, Kingambit 67.1% vs. 89.9%, was also caught by the same fix and wasn't previously reported anywhere). `buildExchangeGrid` (`archetype_matchups.js`) now tracks every (move, weather-scenario) pair actually computed and takes the true max/OHKO status across all of them for the reader-facing verdict. This required splitting the old single `theyOhko` flag into `theyOhkoScoring` (unchanged, feeds only the numeric cell score) and `theyOhkoAny` (broadened to any displayed scenario, feeds the verdict text, `weakest_link`, and the row's "KOs ours" summary) — the two needs were in direct tension on one variable and conflating them would have silently changed ratings. Verified empirically via `git stash`: rerunning the full report against the pre-fix code produces identical archetype ratings (Rain 48, Sun 52, Sand 48, Snow 56, Trick Room 47, Hyper Offense 47, both before and after) — confirming the score formula is genuinely untouched, not just intended to be.
- **Fixed this session:** the exchange grid's primary damage line named no weather at all (`DIES to Weather Ball (110.7-129.8%)`), while a correctly-labelled alternate-weather figure for the exact same move sat orphaned on its own line below (`Weather Ball in our Sun (Charizard-Mega-Y): 18.5-21.4%`) with no visual connection between the two — a 6x swing that reads as a calculator bug without the label. `team.js` now has a `damageVerdict()` helper that folds every displayed scenario for the verdict-carrying move onto the verdict line itself, naming the weather source and (via the existing `resolveTypeFor()`, not a new resolver) the resolved type when it's Weather Ball/Terrain Pulse. A move weather genuinely cannot affect prints with no tag at all, matching this report's pre-existing convention elsewhere (the Counters section already omits a weather bracket rather than asserting "no effect") rather than introducing a second vocabulary for the same idea. Investigating the Charizard-Mega-Y/Pelipper cell surfaced a real mechanic worth noting: both scenarios show Weather Ball as Water-type (not Water-then-Fire as a naive read of "Sun" might suggest) because Pelipper's own Drizzle overrides whatever field weather we hypothetically bring for ITS attack — `resolveTypeFor()` already encodes this correctly ("a Pokemon that sets its own weather always attacks under it"); the real 6x swing is Rain's 1.5x boost vs. Sun's 0.5x penalty on an already-2x-effective STAB-less hit, not a type change. `buildResistances` (line above) still has the same unlabelled-weather flavor and was deliberately left untouched again this session for the same reason as before — it has no alternates machinery to fold in at all, a strictly bigger task than either fix here.

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

## Critical Invariants (ALWAYS ENFORCE)

1. **SP caps: 32 per stat, 66 total** — enforced by `validateSpread()` after every GA operation, by `recommend.js:812` on input, by `spread_scorer.js:1093` as final assertion
2. **Single calculator** — all damage calcs use `CalcDamage()` from `nerd_of_now_calc.js`. `@smogon/calc` is fully retired. Inputs are SP (0-32), no EV conversion at calc boundary.
3. **Marginal-value guard** — a defensive threshold only justifies SP investment if the Pokemon would be KO'd without it. If `survival_without_investment === true`, the threshold must not appear in the Why block.
4. **Focus Sash rule** — Focus Sash holders have OHKO_prevented contribution reduced by 90% (×0.1). 2HKO/3HKO prevention still matters.
5. **Locked offensive stats** — `slow_bulky_support` locks Atk AND SpA to 0; other roles lock whichever is weaker. Hard-enforced through every GA stage.
6. **Fast-role speed-first** — fast_offense/fast_support with base Spe ≥ 90 get Speed pinned to 32 first; remaining 34 SP distributed by weight.
7. **SCORER_VERSION** — bump when any scoring constant changes. Included in evolutionary cache key for automatic invalidation.
8. **Unspendable SP** — every SP must be accounted for: justified by a threshold or marked unspendable. Why block final line: `{justified} justified + {unspendable} unspendable = 66 total`.

---

## Conventions Documentation

Detailed conventions, intent, and invariants live in `docs/conventions/`. Consult before editing any file:

| Doc | Summary |
|-----|---------|
| [INDEX.md](docs/conventions/INDEX.md) | Master index with standing note and one-line summaries |
| `CONVENTIONS_sp_system.md` | SP formulas, caps, enforcement, spToEv boundary, marginal-value guard, Focus Sash, locked stats, minimization |
| `CONVENTIONS_damage_calc.md` | CalcDamage usage, weather/ability/item order, Weather Ball, recoil, aggression multiplier, TYPE_VALUES |
| `CONVENTIONS_format_output.md` | Threshold format, Why block, secondary interactions, build labels, Mega naming, section ordering |
| `CONVENTIONS_inconsistencies.md` | 11 inconsistencies (1 P0, 4 P1, 6 P2) — species resolution, weather vocab, nature modifiers, role duality |
