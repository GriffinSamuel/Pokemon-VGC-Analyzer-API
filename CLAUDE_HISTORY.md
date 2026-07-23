# CLAUDE.md Historical Changelog

Preserved for reference — never auto-loaded into context. Contains the full narrative history of every fix, investigation, and decision from the project's life.

---

## Historical Round Narratives

### Post-Team-Builder Correctness Pass
A follow-up task's own investigation steps were run for real before any fix. Two premises didn't hold:
- The proposed `getTypeEffectiveness` rewrite was backwards (`damageTaken[moveType]` vs correct `damageTaken[defType]`). Verified wrong on every case. Not implemented.
- Two "expected" type-effectiveness values were wrong: Ground vs Steel/Dark is really 2.0, not 0.0; Fighting vs Steel/Flying is really 1.0, not 0.5. Both locked as regression tests with correct values.

**Applied fixes** (applied only to POST /api/team/build):
- FIX 2: `mitigationFor()` already distinguished immune vs resist; `teamResistsOrImmuneTo()` now returns real multiplier + correct verb.
- FIX 3+4: `item_optimizer.js` gained `getRealAbilityFrequency()`/`resolveRealAbility()`/`detectTeamWeatherContext()`. Real ability frequency picks (no hardcoded per-species overrides). Choice Scarf excluded when real conditional-speed ability is active.
- FIX 5+6: New `analyzeWallMatchups()` replaced by `analyzeMatchups()` (`ohko_opportunities`/`ohko_risks`, top 20 each). Stamina-staged +0/+1/+2 Defense. Recovery/risk-based difficulty ratings.
- FIX 8: Trick Room checks team base-Speed profile (`isTrickRoomViableTeam()`).
- FIX 9: Spread-move-only immunity synergies (`SPREAD_MOVES` gate). Weakness-coverage reason removed.
- FIX 10: Dynamic Weather Ball typing (`WEATHER_BALL_TYPES`).
- FIX 11: `getLegalPokemonSet()` filters key_threats to Pokemon with real `usage_stats` (fixed Indeedee ghost entry).
- 69 tests (7 new: type-effectiveness pins, Garchomp ability, no-duplicate-items, Basculegion Adaptability, TR-suppressed team).

### Post-Team-Builder (Locked stats, speed_ohko_link, deeper search, etc.)
- `determineLockedIndices()`: slow_bulky_support locks Atk+SpA; others lock the weaker offensive stat. Hard-enforced through every GA stage.
- `speed_ohko_link` (3.0x multiplier when threat both outspeeds and OHKOs at baseline) + `speed_death_trap_penalty` in `spread_scorer.js`.
- SPEED section sources from full threat matrix (includes mirror matchups).
- `TEAM_BUILD_POP_INIT`/`GENERATIONS`/`LOCAL_SEARCH_RANGE` = 300/60/±8 vs individual defaults 200/40/±5. `teamBuild` flag threaded through workers.
- `analyzeMatchups()` replaces `analyzeWallMatchups()`: ohko_opportunities/ohko_risks, top 20 each, reusing top-3-spreads worst-case.
- TR suppressed from synergy list for 3+-fast-member team. TR beneficiary/hurt uses effective Speed.
- Wide Guard/Rage Powder/Hospitality synergies named specifically with real data.
- 69 tests (6 new: locked stats, matchup_analysis, Hospitality, TR-suppressed).

### Six-fix round (aggression multiplier, Choice+Protect, Mega items, holistic TR, Scarf speed)
- `AGGRESSION_SUPPORT_STAB` 0.40→0.20, `AGGRESSION_SUPPORT_OFF_STAB` 0.15→0.05. `SCORER_VERSION` bumped 3→4 and wired into evolutionary cache key (first time it was load-bearing).
- `CHOICE_ITEMS_BANNING_PROTECT` set hard-filters Protect from Choice-locked members.
- 15 real Mega-item mismatches in `MEGA_ITEM_MAP` (Raichu n-less typo, Beedrillite double-L, Staraptornite→Staraptite, 13 missing entries). Backfilled `normalizedName` across 1,767 rows. Raichu split: Mega-Y 8.21%, Mega-X 1.47%, base 0.85%. Disclosed: `move_recommendations.json` still blends under one "raichu" key (Python `species_key()` unchanged); `getThreatMatrix()` generates zero entries for Raichu-Mega-Y.
- `isTrickRoomViableTeam()`: median Speed < 70, 3+ members < 80, 1+ member < 60. Hard filter.
- `effectiveSpeed()` (renamed from `effectiveSpeedForTrickRoom`) used in `analyzeSpeedTiers`/`analyzeMatchups`.
- 69 tests (0 new — all behavior changes to existing endpoints).

### Round 3: Mega data separation
- `auditMegaItemMappings()` on startup (`normalize.js` wired into `app.js`). Caught own predecessor's Staraptite regression.
- `species_identity_key()` added to `data.py`, `train_moves.py` switched to it. Retrained `move_recommendations.json` — real separate entries for raichu-mega-y, staraptor-mega, etc.
- `getPokemonRow()` in `spread_scorer.js` now uses `getSpeciesRow()` fallback (hyphen-strips to base when no Mega row). Same fix in `analyzeMatchups()`.
- Display name regression fixed: `row.pokemon_name` for display, `candidateRow` for stats/typing.
- HP dump-stat fix: removed mechanical SP top-up in `mutate()`; added per-threshold HP attribution in `spread_scorer.js` (5 calls per run, not per candidate).
- `DAMAGE_AFFECTING_ITEMS` + `getTopDamageAffectingItem()` in `ev_observations.js`. Real items threaded into both `spread_scorer.js` and `team_analyzer.js`. Found and fixed `[object Object]` bug.
- `SCORER_VERSION` bumped 4→5. 69 tests.

### Round 4: Mega Pokemon get real base stats
- `@pkmn/dex` (v0.10.11) has genuine, structured data for all 89 Mega forms. `Dex.species.all().filter(s => s.isMega)` is the reliable marker.
- `auditMegaItemMappings()` runs on startup (`if (require.main === module)` guard in `app.js`).
- `species_identity_key()` in `data.py` keys `move_recommendations.json` bucketing by `normalizedName` (preferred) with base-name validity check.
- `CHOICE_ITEMS_BANNING_PROTECT` set + per-member `.filter()` in `team.js`.
- `spread_optimizer.js`: `determineLockedIndices()` hard-locked through every GA stage.
- `spread_scorer.js`: `SPEED_OHKO_LINK_MULTIPLIER` (3.0), `DEATH_TRAP_MIN_WEIGHT`/`PENALTY_MULTIPLIER` (0.15/2.0). SPEED section uses full threat matrix for mirror matchups.
- `DAMAGE_AFFECTING_ITEMS` + `getTopDamageAffectingItem()` (returns plain string).
- `AGGRESSION_SUPPORT_STAB` 0.20, `AGGRESSION_SUPPORT_OFF_STAB` 0.05, `SCORER_VERSION` 6.
- 90 Mega forms inserted into `pokemon` table (89 dex-derived + Floette-Eternal-Mega alias).
- `spread_optimizer.js`: `TEAM_BUILD_POP_INIT`/`GENERATIONS`/`LOCAL_SEARCH_RANGE` (300/60/±8), `teamBuild` flag, `team`/`solo` cache key segment.
- 69 tests.

### Round 5: Stat formula investigated and refuted
- `POST /api/damage`'s `evs` field is a classic EV field (0-252), not SP. Passing `spToEv(32)=252` reproduced exact expected values. `calcStat()` isolated unit calls matched every hand-computed value. Four errors in task's own hand-calculations found. Zero code changes. 69 tests.

### Nerd of Now Seeded Initialization
- `src/utils/nerd_of_now.js` fetches `script_res/setdex_ncp-g9.js` from GitHub, caches locally 24hr.
- Classic EVs → SP via `SP = (EV + 4) / 8`, capped 32/stat, 66 total (scaled down proportionally).
- 305 Pokemon, 491 total sets. Seeds treated identically to random candidates.
- `SCORER_VERSION` bumped 5→6. SEEDS section in text/plain output.

### Team Builder Output Fixes (15 fixes)
- FIX 1: Mega forms show "Ability: X (base: Y)" using both Mega and base DB rows.
- FIX 2+11: OHKO entries show both attacker and defender speed numbers.
- FIX 3+4+5+7: Offensive/defensive/weather/secondary thresholds formatted with move name, damage range, attacker build, spread frequency.
- FIX 6: Coverage gap shows which team member would be OHKO'd by each threat.
- FIX 8: Duplicate Pokemon names removed from coverage suggestions.
- FIX 9: Coverage suggestions name specific learnable moves; never remove key moves.
- FIX 10: Weather Ball shows 100 BP in weather, correct type.
- FIX 11: MATCHUP ANALYSIS section with OHKO opportunities/risks, full builds, spread breakdowns.
- FIX 12: Threat ordering by damage descending, top 10.
- FIX 13: Sand archetype with weather war counter check.
- FIX 14: TR matchup focuses on Prankster Taunt prevention.
- FIX 15: Quick fix recommendations for unfavorable matchups.
- 69 tests.
