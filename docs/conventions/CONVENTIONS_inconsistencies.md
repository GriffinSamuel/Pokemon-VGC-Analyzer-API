# Inconsistency Catalogue

Every place where two files do the same thing differently, duplicated logic that could drift, varying naming, or differing format strings for the same concept.

**Severity:** P0 = correctness risk, P1 = maintenance risk, P2 = cosmetic.
**Status:** Each entry is current as of the last full read (2026-07-24).

---

## P0 — Correctness Risk

### 1. Species resolution fallback differs between ev_observations.js and normalize.js

**Files:**
- `ev_observations.js:13-26` — `getSpeciesRow()` uses its own hyphen-strip fallback loop (`key.split('-').slice(0, -1)`)
- `normalize.js:normalizePokemonName()` — multi-step resolution chain (exact match → DB → `@pkmn/dex` → hyphen-strip → manual map)

**Issue:** A Mega form that resolves via one path may fail the other. The two functions have different fallback strategies for the same problem (resolving a Pokemon name to its DB row).

**Verified at:** Both functions confirmed by full file reads.

---

## P1 — Maintenance Risk

### 2. Weather vocabulary duplicated in 6+ locations

**Files:**
- `synergy_reasons.js:7-9` — `WEATHER_SETTERS` (`{Drizzle: 'Rain', ...}`)
- `synergy_reasons.js:11` — `WEATHER_LABELS` (`{Rain: 'Rain', Sand: 'Sandstorm', ...}`)
- `item_optimizer.js:80-85` — `WEATHER_SETTER_ABILITIES` (same 4 abilities, calc strings)
- `team_analyzer.js:146` — `WEATHER_BALL_TYPES` (same weather→type mapping)
- `team.js:539` — inline Weather Ball type mapping
- `train_synergy.py:37-43` — `FIELD_CONDITIONS` list (mining-oriented)

**Issue:** Same weather string vocabulary in 6+ places with slightly different formats. Adding a weather type requires updating all locations.

**Status:** Intentional per code comments — each copy serves a different purpose (calc strings vs display strings vs mining strings).

**Verified at:** All 6 locations confirmed by grep.

---

### 3. Nature modifiers triplicated

**Files:**
- `stat_formula.js:14-28` — `NATURE_MODIFIERS` (array of `[boosted, hindered]` stat names)
- `features.py:26-49` — `NATURE_MODIFIERS` dict `{name: (boost, hinder)}`
- `team.js` (inline) — `NATURE_BOOSTS` object

**Issue:** Same nature table in 3 places with different data structures (array vs dict vs inline object). Adding a nature requires updating all three.

**Verified at:** All three locations confirmed by full file reads.

---

### 4. role_classifier.js (rule-based) vs train_evs.py (ML) — two role systems

**Files:**
- `role_classifier.js:15-37` — rule-based classification (base stats + support ratio thresholds)
- `train_evs.py` — GradientBoostingClassifier (features + moveset → role prediction)

**Issue:** Two different role classification systems with the same 4-role vocabulary. `role_classifier.js` is used at runtime; `train_evs.py`'s model generates `ev_recommendations.json` (which `role_classifier.js` reads for SP observation data). The ML model and rule system can disagree on a Pokemon's role.

**Verified at:** Both confirmed by full file reads. `role_classifier.js:32-36` checks ML output but uses rules as primary classifier.

---

### 5. WEATHER_SETTERS exists in both synergy_reasons.js and item_optimizer.js

**Files:**
- `synergy_reasons.js:7-9` — `{Drizzle: 'Rain', Drought: 'Sun', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow'}`
- `item_optimizer.js:80-85` — `WEATHER_SETTER_ABILITIES` (same 4 abilities, same weather strings)

**Issue:** Nearly identical tables with different variable names. `item_optimizer.js`'s is calc-oriented while `synergy_reasons.js`'s is reasoning-oriented, but the actual content is the same.

**Verified at:** Both confirmed by full file reads.

---

## P2 — Cosmetic

### 6. `round()` helper duplicated

**Files:**
- `ev_observations.js:4-7` — local `round(value, decimals)`
- `threat_matrix.js:16-19` — identical local `round(value, decimals)`

**Issue:** Same utility function copied in two files. Should be in a shared utility.

**Verified at:** Both copies confirmed by full file reads.

---

### 7. pool.js uses console.error instead of logger.error

**Files:**
- `pool.js:12` — `console.error('Unexpected DB error', err)`
- All other files — `logger.error()`

**Issue:** DB errors bypass the structured logging system. Likely intentional since `pool.js` is required before `logger.js` is available, but means DB errors are not captured in the error log file.

**Verified at:** `pool.js:12` confirmed.

---

### 8. limitless.js uses separate recordSuccess/recordFailure; others use recordHealth wrapper

**Files:**
- `limitless.js:8` — imports `recordSuccess, recordFailure` (separate calls)
- `serebii.js:7` — imports `recordHealth` (single convenience call)
- `vgcpastes.js:7` — imports `recordHealth` (single convenience call)

**Issue:** Inconsistent health recording API usage. `limitless.js` was likely written earlier and never updated to use the convenience wrapper.

**Verified at:** All import statements confirmed by full file reads.

---

### 9. DAMAGE_AFFECTING_ITEMS defined in ev_observations.js, re-exported in spread_scorer.js

**Files:**
- `ev_observations.js:229` — defines `DAMAGE_AFFECTING_ITEMS` (Set of item names)
- `spread_scorer.js:8` — imports and re-exports from `ev_observations`

**Issue:** Item vocabulary lives in the data layer (`ev_observations.js`) but is conceptually a damage-calc concern. Consumed only by `spread_scorer.js` and `team_analyzer.js`.

**Verified at:** Confirmed by import analysis.

---

### 10. NATURE_MODIFIERS uses array format in JS, dict format in Python

**Files:**
- `stat_formula.js:14-28` — Array: `lonely: ['atk', 'def']` (boosted, hindered)
- `features.py:26-49` — Dict: `{"lonely": ("atk", "def")}`

**Issue:** Same data, different structural formats. Semantic content is identical but any cross-language comparison must convert between formats.

**Verified at:** Both confirmed by full file reads.

---

### 11. Nerd of Now constants duplicated with main codebase

**Files:**
- `nerd_of_now.js:32-33` — `SP_BUDGET_TOTAL = 66`, `SP_CAP = 32`
- `stat_formula.js:5-6` — `SP_CAP_PER_STAT = 32`, `SP_BUDGET_TOTAL = 66`

**Issue:** Same constants defined in two files with different names (`SP_CAP` vs `SP_CAP_PER_STAT`). `nerd_of_now.js` should import from `stat_formula.js` instead of redeclaring.

**Verified at:** Both locations confirmed by grep.
