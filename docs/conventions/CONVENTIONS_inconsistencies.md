# Inconsistency Catalogue

Every place where two files do the same thing differently, duplicated logic that could drift, varying naming, or differing format strings for the same concept.

**Severity:** P0 = correctness risk, P1 = maintenance risk, P2 = cosmetic.
**Status:** Each entry is current as of the last full read (2026-07-28).
- **FIXED (f0382c7):** `round()` helper consolidated into `src/utils/format.js`
- **FIXED (ba42827):** `nerd_of_now.js` imports `SP_CAP_PER_STAT`/`SP_BUDGET_TOTAL` from `stat_formula.js`
- **FIXED (ba42827):** `limitless.js` switched to `recordHealth()` wrapper
- **FIXED (edf1e83):** `STAT_ORDER`/`STAT_INDEX` consolidated into `stat_formula.js`

---

## P0 — Correctness Risk

### 1. Species resolution fallback differs between ev_observations.js and normalize.js (INVESTIGATED — NOT A CODE INCONSISTENCY)

**Files:**
- `ev_observations.js:9-18` — `getSpeciesRow()` queries DB directly, hyphen-strip fallback for -suffix forms
- `normalize.js:126-139` — `normalizePokemonName()` multi-step chain: `MEGA_ITEM_MAP` → `MANUAL_MAP` → `@pkmn/dex` → title-case fallback

**Finding (2026-07-28):** The two functions serve different purposes and are NOT inconsistent by design:
- `getSpeciesRow()` returns a **DB row** (for base stats, types) — cannot use `normalizePokemonName` because that returns a string, not a row
- `normalizePokemonName()` returns a **display name string** — uses `@pkmn/dex` and manual maps

**Stale comment fixed:** The old comment claimed "pokemon has zero -Mega rows" — false (there are 90 Mega rows in the DB). Updated to reflect reality: the hyphen-strip is a safety net for any hyphenated suffix lacking a DB row.

**Root cause:** 23 species (Aerodactyl-Mega, Alakazam-Mega, etc.) have Mega rows but NO base-form row in the `pokemon` table. This is a DB seeding gap, not a code inconsistency — if the base-form row existed, `getSpeciesRow("aerodactyl-mega")` → strip to "aerodactyl" → would find the base row.

**Status:** Not a code-level inconsistency. The hyphen-strip fallback is correctly needed. The true correctness risk is the 23 missing base-form rows in the `pokemon` table (separate DB seeding task). Update comment if the seeding gap is closed.

**Verified at:** Both functions confirmed by full file reads + DB queries (90 Mega rows confirmed, 23 species with Mega-only coverage confirmed).

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

### 3. Nature modifiers triplicated (ACCEPTED — CROSS-LANGUAGE)

**Files:**
- `stat_formula.js:14-28` — `NATURE_MODIFIERS` (array of `[boosted, hindered]` stat names)
- `features.py:26-49` — `NATURE_MODIFIERS` dict `{name: (boost, hinder)}`
- `team.js` (inline) — `NATURE_BOOSTS` object

**Issue:** Same nature table in 3 places with different data structures (array vs dict vs inline object). Adding a nature requires updating all three.

**Status:** Accepted — the Python copy (#10 below) is inherently duplicated cross-language. The `team.js` inline is for a different purpose (display formatting) and can't easily share the JS array format. Consider a generator script if natures ever change, but they haven't since Gen 6.

**Verified at:** All three locations confirmed by full file reads.

---

### 4. role_classifier.js (rule-based) vs train_evs.py (ML) — two role systems (ACCEPTED — BY DESIGN)

**Files:**
- `role_classifier.js:15-37` — rule-based classification (base stats + support ratio thresholds)
- `train_evs.py` — GradientBoostingClassifier (features + moveset → role prediction)

**Issue:** Two different role classification systems with the same 4-role vocabulary. `role_classifier.js` is used at runtime; `train_evs.py`'s model generates `ev_recommendations.json` (which `role_classifier.js` reads for SP observation data). The ML model and rule system can disagree on a Pokemon's role.

**Status:** Accepted by design. The rule-based system is the runtime primary classifier; ML-produced roles serve as training-data signals and cross-validation. The two systems being independent is intentional — `role_classifier.js:32-36` uses ML output as an advisory input, not as the sole determinant.

**Verified at:** Both confirmed by full file reads. `role_classifier.js:32-36` checks ML output but uses rules as primary classifier.

---

### 5. WEATHER_SETTERS exists in both synergy_reasons.js and item_optimizer.js (ACCEPTED — SAME ROOT CAUSE AS #2)

**Files:**
- `synergy_reasons.js:7-9` — `{Drizzle: 'Rain', Drought: 'Sun', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow'}`
- `item_optimizer.js:80-85` — `WEATHER_SETTER_ABILITIES` (same 4 abilities, same weather strings)

**Issue:** Nearly identical tables with different variable names. `item_optimizer.js`'s is calc-oriented while `synergy_reasons.js`'s is reasoning-oriented, but the actual content is the same.

**Status:** Accepted — same root cause as #2. Each copy serves a different purpose. Add to all locations if weather setter abilities change.

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

### 7. pool.js uses console.error instead of logger.error (ACCEPTED — INITIALIZATION ORDER)

**Files:**
- `pool.js:12` — `console.error('Unexpected DB error', err)`
- All other files — `logger.error()`

**Issue:** DB errors bypass the structured logging system. Likely intentional since `pool.js` is required before `logger.js` is available, but means DB errors are not captured in the error log file.

**Status:** Accepted — `pool.js` is loaded before `logger.js` can be initialized, so `console.error` is the only option. Not fixable without circular dependency or lazy initialization.

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

### 9. DAMAGE_AFFECTING_ITEMS defined in ev_observations.js, re-exported in spread_scorer.js (ACCEPTED — DATA OWNERSHIP)

**Files:**
- `ev_observations.js:229` — defines `DAMAGE_AFFECTING_ITEMS` (Set of item names)
- `spread_scorer.js:8` — imports and re-exports from `ev_observations`

**Issue:** Item vocabulary lives in the data layer (`ev_observations.js`) but is conceptually a damage-calc concern. Consumed only by `spread_scorer.js` and `team_analyzer.js`.

**Status:** Accepted — the items list is needed where observations are parsed (ev_observations.js) to extract damage-affecting items. The re-export is a convenience to avoid requiring both files. Moving it would add a module without reducing coupling.

**Verified at:** Confirmed by import analysis.

---

### 10. NATURE_MODIFIERS uses array format in JS, dict format in Python (ACCEPTED — CROSS-LANGUAGE)

**Files:**
- `stat_formula.js:14-28` — Array: `lonely: ['atk', 'def']` (boosted, hindered)
- `features.py:26-49` — Dict: `{"lonely": ("atk", "def")}`

**Issue:** Same data, different structural formats. Semantic content is identical but any cross-language comparison must convert between formats.

**Status:** Accepted — cross-language duplication is inherent. Python's training scripts read this data directly and need the dict format for pandas/ML pipelines.

**Verified at:** Both confirmed by full file reads.

---

### 11. Nerd of Now constants duplicated with main codebase

**Files:**
- `nerd_of_now.js:32-33` — `SP_BUDGET_TOTAL = 66`, `SP_CAP = 32`
- `stat_formula.js:5-6` — `SP_CAP_PER_STAT = 32`, `SP_BUDGET_TOTAL = 66`

**Issue:** Same constants defined in two files with different names (`SP_CAP` vs `SP_CAP_PER_STAT`). `nerd_of_now.js` should import from `stat_formula.js` instead of redeclaring.

**Verified at:** Both locations confirmed by grep.
