# Format & Naming Conventions

## Threshold Formatting

Thresholds in team builder text output follow this exact pattern:
```
{THRESHOLD_CATEGORY} THRESHOLDS:
  {MoveName} ({minDamage}-{maxDamage}) — {Nature} {SP} {StatName} {Item} {Pokemon} ({frequency}% spread)
```

Categories: `OFFENSIVE`, `DEFENSIVE`, `WEATHER`, `SECONDARY`.

---

## Spread Representation

**Internal (everywhere except damage endpoint):**
```javascript
[hp, atk, def, spa, spd, spe]  // integers 0-32, sum ≤ 66
```

**`@smogon/calc` boundary:**
```javascript
{hp: EV, atk: EV, def: EV, spa: EV, spd: EV, spe: EV}  // integers 0-252
```
Converted via `spToEv()` at this boundary only.

**POST /api/damage `evs` field:** Classic EVs (0-252), not SP — intentional design choice.

---

## Mega Form Naming

| Context | Convention | Example |
|---------|-----------|---------|
| DB `pokemon.name` | `{Base}-Mega` or `{Base}-Mega-{X/Y}` | `Swampert-Mega`, `Charizard-Mega-X` |
| Item name | `{Base}ite` or `{Base}ite {X/Y}` | `Swampertite`, `Charizardite X` |
| Display in API response | Same as DB name | `Swampert-Mega` |
| Internal keys | Lowercase DB name | `swampert-mega` |

`MEGA_ITEM_MAP` in `normalize.js` handles the item→form mapping (78+ entries).

---

## Normalized Name Keys

`ev_observations.normalized_name` is the canonical key for SP observation data:
- Case-sensitive exact dex name (e.g., `"Swampert-Mega"`)
- `getSpeciesRow(nameLower)` queries with `LOWER(normalized_name) = $1`
- Hyphen-fallback: `"swampert-mega"` → fail → `"swampert"` → find base form

---

## Item & Ability Handling in Damage Strings

In `buildAttackerBuildLabel()` (`spread_scorer.js`):
```
{Nature} {SP} {StatName} {Item} {Pokemon}
Example: "Adamant 32 Atk Choice Band Landorus-T"
```

Ability names used in damage context: exact DB name (e.g., `"Intimidate"`, `"Drizzle"`).

Weather strings in `@smogon/calc` Field:
- `Rain`, `Sun`, `Sand`, `Snow` (not `"Sandstorm"` — `@smogon/calc`'s vocabulary)

---

## JSON Response Format

Standard error shape:
```javascript
{error: "Descriptive message here"}
```

Standard success for empty lists:
```javascript
[]
```

Rate limiting:
```javascript
{error: "Too many requests — limit is 100 requests per minute"}
```

---

## DB Query Conventions

- All queries use parameterized `$1, $2, ...` (no string interpolation)
- `LOWER()` used for case-insensitive lookups on `name` columns
- `INSERT ... ON CONFLICT ... DO UPDATE` used throughout for idempotent inserts
- All route errors call `next(err)` — never `res.status(500).send()` directly (except global handler)

---

## Log Line Format

```javascript
logger.info('message', {key: value})
// → JSON: {"level":"info","timestamp":"...","message":"message","key":"value"}

logger.error('message', {error: err.message})
// → JSON: {"level":"error","timestamp":"...","message":"message","error":"..."}
// → also writes to error-{date}.log
```

---

## File Naming

| Directory | Convention |
|-----------|-----------|
| `routes/` | `{domain}.js` (singular: `pokemon.js`, `damage.js`, `team.js`) |
| `utils/` | `{function_name}.js` (snake_case: `stat_formula.js`, `ev_optimizer.js`) |
| `scrapers/` | `{source}.js` (lowercase: `limitless.js`, `serebii.js`) |
| `ml/` | `{action}_{target}.py` (snake_case: `train_moves.py`, `train_evs.py`) |

---

## Test Convention

Tests in `src/tests/api.test.js`:
- Self-contained: spins up Express server, runs fetch calls, tears down
- Custom assertion: `assert(condition, message)` — throws on failure
- Tests organized as `test('description', async () => {...})`
- Final summary: `{passed} tests run — {passed} passed, {failed} failed`

---

## Cron Job Convention

Each scraper follows the same pattern:
```javascript
scrape();  // Run immediately on require

cron.schedule('schedule', () => {
  logger.info('Scheduled {name} scrape triggered');
  scrape();
});

module.exports = { scrape };
```

Health recording: `recordSuccess(name)` on completion, `recordFailure(name, err.message)` on error.

---

## ML Output Convention

All Python training scripts end with:
```python
result = {"status": "success", ...metadata...}
print(f"RESULT_JSON:{json.dumps(result)}")
```

`runPythonScript()` in `ml.js` parses this `RESULT_JSON:` line from stdout.
Stderr is logged via `logger.info()` but doesn't affect result parsing.

---

## Dual-Export Pattern

Routes that export both a router and internal functions:
```javascript
module.exports = router;
module.exports.parseShowdownTeam = parseShowdownTeam;  // team.js
module.exports.getMoveRecommendationsFor = getMoveRecommendationsFor;  // recommend.js
module.exports.gen = gen;  // damage.js
module.exports.LEVEL = LEVEL;  // damage.js
module.exports.buildPokemon = buildPokemon;  // damage.js
```

This allows other modules to require underlying functions without an HTTP round-trip.

---

## Express 5 vs 4 Pattern

This project uses Express 5 (`^5.2.1`). Async errors are auto-caught, but the codebase
still wraps every route handler in `try/catch` + `next(err)` for explicit control.
New code should follow this existing pattern for consistency.
