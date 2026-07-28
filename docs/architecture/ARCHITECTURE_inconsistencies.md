# Inconsistency Catalogue

Every file where two files do the same thing differently, duplicated logic that
could drift, varying naming, or differing format strings for the same concept.

**Severity:** P0 = correctness risk, P1 = maintenance risk, P2 = cosmetic.

---

## Existing Catalogue (verified against current source)

### 1. Weather vocabulary triplication [P1]

**Files:**
- `synergy_reasons.js:8-9` — `WEATHER_SETTERS` dict (`{Drizzle: 'Rain', ...}`)
- `synergy_reasons.js:11` — `WEATHER_LABELS` dict (`{Rain: 'Rain', Sun: 'Sun', Sand: 'Sandstorm', Snow: 'Snow'}`)
- `item_optimizer.js` — `WEATHER_SETTER_ABILITIES`, `WEATHER_SETTER_MOVES` (calc-oriented strings)
- `team_analyzer.js` — inline weather object
- `nerd_of_now_calc.js` — weather handling internal
- `train_synergy.py:37-43` — `FIELD_CONDITIONS` list (mining-oriented)

**Issue:** Weather string vocabulary is duplicated across 6+ locations with slightly different formats and purposes (calc strings vs display strings vs mining strings).

**Verification:** All 6 locations confirmed by full file reads. `synergy_reasons.js:3-6` explicitly notes this is intentional ("separate small copy of this fixed vocabulary already exists").

---

### 2. Nature modifiers triplication [P1]

**Files:**
- `stat_formula.js:14-28` — `NATURE_MODIFIERS` (array of `[boosted, hindered]` stat names)
- `features.py:26-49` — `NATURE_MODIFIERS` dict `{name: (boost, hinder)}`
- `team.js` (inline) — `NATURE_BOOSTS` object

**Issue:** Same nature table in 3 places. Adding a new nature requires updating all three.

**Verification:** All three locations confirmed by full file reads.

---

### 3. `WEATHER_SETTERS` exists in both `synergy_reasons.js` and `item_optimizer.js` [P1]

**Files:**
- `synergy_reasons.js:7-9` — `{Drizzle: 'Rain', Drought: 'Sun', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow'}`
- `item_optimizer.js` — `WEATHER_SETTER_ABILITIES` (same 4 abilities, same weather strings)

**Issue:** Nearly identical tables, slightly different variable names. `item_optimizer.js`'s is calc-oriented while `synergy_reasons.js`'s is reasoning-oriented, but the actual content is the same.

**Verification:** Both confirmed by full file reads.

---

### 4. `getSpeciesRow()` fallback strategy [P0]

**Files:**
- `ev_observations.js:13-26` — hyphen-strip fallback loop (`key.split('-').slice(0, -1)`)
- `damage.js` (line ~18) — `normalizePokemonName()` chain

**Issue:** `getSpeciesRow()` uses its own fallback logic that differs from `normalizePokemonName()`'s. A Mega form that resolves via one path may fail the other.

**Verification:** Confirmed by full file reads. `ev_observations.js` comment says "identical failure mode to the raichuite/beedrilite/staraptite typos above".

---

### 5. `round()` helper duplication [P2]

**Files:**
- `ev_observations.js:4-7` — local `round()` function
- `threat_matrix.js:16-19` — identical local `round()` function
- `role_classifier.js` (not present) — no local copy, uses inline Math operations

**Issue:** Same `round(value, decimals)` function copied in two files.

**Verification:** Both copies confirmed by full file reads.

---

## Newly Discovered Inconsistencies

### 6. `role_classifier.js` vs `train_evs.py` — role inference [P1]

**Files:**
- `role_classifier.js:15-37` — rule-based classification (base stats + support ratio thresholds)
- `train_evs.py` — ML-based role classification (GradientBoosting on features + moveset)

**Issue:** Two different role classification systems with the same vocabulary. `role_classifier.js` is used at runtime; `train_evs.py`'s model is used only for generating `ev_recommendations.json` (which `role_classifier.js` reads for SP observation data). The ML model's 4 roles match the rule-based system but are derived differently.

**Verification:** Both confirmed by full file reads. `role_classifier.js:32-36` checks `ev_recommendations.json` from ML but uses its own rule system as the primary classifier.

---

### 7. `nerd_of_now_calc.js` vs `@smogon/calc` damage formulas [P2]

**Files:**
- `nerd_of_now_calc.js` — ported Nerd of Now damage calculator (standalone)
- `@smogon/calc` — used by `damage.js`, `spread_scorer.js`, `team_analyzer.js`

**Issue:** Two independent damage calculators. `nerd_of_now_calc.js` is not imported by any other source file — it's a standalone ported utility. The project uses `@smogon/calc` for all production damage calculations.

**Verification:** `nerd_of_now_calc.js:1` confirms standalone: "not imported by any other module". No import statement in the codebase references it (verified via module.exports analysis).

---

### 8. `pool.js` console.error vs logger.error [P2]

**Files:**
- `pool.js:12` — `console.error('Unexpected DB error', err)`
- All other files — `logger.error()`

**Issue:** `pool.js` uses raw `console.error()` instead of the project's logger. Since `pool.js` is required before `logger.js` is available (it's the first import), this is likely intentional — but means DB errors bypass the structured logging system.

**Verification:** Confirmed at `pool.js:12`.

---

### 9. Health function inconsistency [P2]

**Files:**
- `health.js` — exports `recordSuccess`, `recordFailure`, `recordHealth`, `checkHealth`
- `limitless.js:8` — imports `recordSuccess, recordFailure` (separate calls)
- `serebii.js:7` — imports `recordHealth` (single convenience call)
- `vgcpastes.js:7` — imports `recordHealth` (single convenience call)

**Issue:** `limitless.js` uses separate `recordSuccess()`/`recordFailure()` calls, while the other two scrapers use the convenience wrapper `recordHealth()`. Both approaches work but inconsistency suggests `limitless.js` was written earlier and never updated.

**Verification:** All import statements confirmed by full file reads.

---

### 10. `DAMAGE_AFFECTING_ITEMS` defined in `ev_observations.js`, re-exported in `spread_scorer.js` [P2]

**Files:**
- `ev_observations.js:229` — defines `DAMAGE_AFFECTING_ITEMS` (Set of item names)
- `spread_scorer.js:8` — imports and re-exports from `ev_observations`

**Issue:** Item vocabulary lives in `ev_observations.js` (data layer) but is conceptually a damage-calc concern. The `DAMAGE_AFFECTING_ITEMS` Set appears to be consumed only by `spread_scorer.js` and `team_analyzer.js`.

**Verification:** Confirmed by import analysis.

---

### 11. `NATURE_MODIFIERS` in `stat_formula.js` uses array format, `features.py` uses dict [P2]

**Files:**
- `stat_formula.js:14-28` — Array: `lonely: ['atk', 'def']` (boosted, hindered)
- `features.py:26-49` — Dict: `{"lonely": ("atk", "def")}`

**Issue:** Same data, different formats. The semantic content is identical but the structural difference means any cross-language comparison must convert between formats.

**Verification:** Confirmed by full file reads.

---

## Summary

| Severity | Count | Theme |
|----------|-------|-------|
| P0 | 1 | Species resolution inconsistency |
| P1 | 4 | Vocabulary duplication (weather, nature, role classification) |
| P2 | 6 | Cosmetic / minor duplication (round, console.error, re-exports) |
| **Total** | **11** | |
