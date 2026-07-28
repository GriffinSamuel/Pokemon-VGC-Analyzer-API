# ML Module

Python 3.12 via `.venv` (Windows — system Python intercepted by Windows Store stub).
Node calls via `src/utils/ml.js`'s `runPythonScript()`.

---

## Python Files

### `db.py` — Database Connection

Identical hardcoded credentials to `pool.js` (intentional — see CLAUDE.md). Uses
`psycopg2` with `RealDictCursor` to return row objects.

Key exports:
- `get_connection()` → raw psycopg2 connection
- `fetch_all(query, params)` → list of `RealDictRow`

### `data.py` — Data Loaders

Loads data from DB for model training:

| Function | Returns |
|----------|---------|
| `load_tournament_teams()` | All teams: `[{id, pokemon: [...], wins, losses}]` |
| `load_winning_teams()` | Teams with wins > losses |
| `load_pokemon_species()` | `{name_lower: {hp..spe, type1, type2, ability1, ...}}` |
| `load_moves()` | `{name: {type, power, category, ...}}` |
| `load_abilities()` | `{name: description}` |

**Key helper functions:**
- `species_key(mon)`: returns `mon["id"]` (Showdown id), NOT `mon["name"].lower()` (which may carry gender symbols). This is the correct key for tournament data.
- `species_identity_key(mon, species)`: prefers `normalizedName` (COALESCE), validates against species table. Correct for Mega form bucketing.
- `unique_attacks(pokemon_entry)`: deduplicates move list preserving order.

### `features.py` — Feature Engineering

24-dimensional feature vector for Pokemon:
- **Dimensions 0-5:** Base stats (`[hp, atk, def, spa, spd, spe] / 255`)
- **Dimensions 6-23:** Type one-hot encoding (18 types)

Also provides:
- `NATURE_MODIFIERS` dict — identical values to `stat_formula.js` (duplicated by design)
- `build_pokemon_feature_vector(species)` → 24-element list
- `build_team_context_vector(species, moves, abilities)` → 24-element team-context vector
- `build_vocab(items)` / `encode_categorical(items, vocab)` — categorical encoding helpers

### `registry.py` — Model Persistence

Manages saving/loading models and metadata:

| Path | Content |
|------|---------|
| `models/move_model.joblib` | RandomForestClassifier (move recommendations) |
| `models/move_model_meta.json` | Accuracy, training date, prevalence table |
| `models/ev_model.joblib` | GradientBoostingClassifier (role prediction) |
| `models/ev_model_meta.json` | Accuracy, training date, role distribution |
| `models/ev_recommendations.json` | Per-species role distributions and templates |
| `models/role_spread_templates.json` | Role → SP template mapping |
| `models/synergy_matrix.joblib` | Co-occurrence matrix (binary) |
| `models/synergy_matrix.json` | JSON version for Node consumption |
| `models/synergy_meta.json` | Training metadata + top pairs |
| `models/ability_synergies.json` | Ability-based synergy rules |

---

## Training Scripts

### `train_moves.py` — Move Recommendations

**Model:** `RandomForestClassifier` (scikit-learn)
**Purpose:** Per-slot move recommendation per Pokemon

**Data sources:**
- `load_winning_teams()` — only winning teams (wins > losses)
- Per-species: counts move appearances across teams

**Feature construction:**
- 24-dim Pokemon feature vector (stats + types)
- Team context vector
- Move name encoding
- Ability encoding
- Nature encoding

**Output:**
- `move_model.joblib` + `move_model_meta.json`
- `move_recommendations.json` — keyed by species, with prevalence ≥ 5%

### `train_evs.py` — Role Classification

**Model:** `GradientBoostingClassifier` (scikit-learn)
**Purpose:** Predict Pokemon role from features + moveset

**Key insight:** There is no EV data in `tournament_teams` (verified: 0 of 7,674 entries
have an "evs" key). Role is inferred from nature + moveset + base stats via `infer_role()`.

**Roles** (identical vocabulary to `role_classifier.js`):
- `fast_offense`
- `slow_bulky_offense`
- `slow_bulky_support`
- `fast_support`

**Output:**
- `ev_model.joblib` + `ev_model_meta.json`
- `ev_recommendations.json` — per-species role distributions + templates
- `role_spread_templates.json` — role → default SP allocation

### `train_synergy.py` — Pokemon Pairing Synergy

**Model:** Co-occurrence analysis (no ML classifier)
**Purpose:** Find strong/weak Pokemon pairings based on real tournament co-presence

**Scoring:**
- `score = co_occurrence / sqrt(freq_pokemon_a × freq_pokemon_b)`
- `MIN_COOCCURRENCE = 5`

**Ability synergy rules:**
Mines weather/terrain ability pairs from `abilities` table descriptions:
```python
FIELD_CONDITIONS = ['rain', 'sun', 'sand', 'snow', 'psychic terrain', ...]
```
Finds setter+abuser pairs (e.g., Drizzle + Swift Swim) by scanning ability descriptions
for weather/terrain keywords.

**Output:**
- `synergy_matrix.joblib` + `synergy_matrix.json` — all pair scores
- `synergy_meta.json` — training metadata + top strongest/weakest pairs
- `ability_synergies.json` — ability-based synergy rules

---

## Node ↔ Python Bridge (`ml.js`)

```javascript
runPythonScript(scriptName, args) → Promise<object>
```

Spawns `.venv/Scripts/python.exe` as a child process. Parses stdout for a
`RESULT_JSON:{...}` line. Rejects if exit code ≠ 0 or no RESULT_JSON line found.
Logs stderr via `logger.info()`.

**Convention:** Every Python script must print `RESULT_JSON:{json}` as its final
output line to communicate results back to Node.

---

## Generated Data (for Node consumption)

| File | Created by | Consumed by |
|------|-----------|-------------|
| `move_recommendations.json` | `train_moves.py` | `recommend.js` (`getMoveRecommendationsFor()`) |
| `ev_recommendations.json` | `train_evs.py` | `role_classifier.js` |
| `role_spread_templates.json` | `train_evs.py` | `ev_optimizer.js` (role templates) |
| `synergy_matrix.json` | `train_synergy.py` | `recommend.js` (synergy endpoint) |
| `ability_synergies.json` | `train_synergy.py` | `synergy_reasons.js` |

**All files live in `src/ml/models/`.** Retrained on 7-day cycle via `stats.js`.
