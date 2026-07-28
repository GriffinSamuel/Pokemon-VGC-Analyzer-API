# Damage Calculation System

Two independent damage calculators exist in the codebase:
1. **`@smogon/calc`** (production) — used by `POST /api/damage`, team build optimizer, evolutionary search
2. **`nerd_of_now_calc.js`** (ported reference) — standalone, not currently imported by any other module

## @smogon/calc Usage

### Entry Points

| Endpoint/Path | What it does | Source |
|--------------|-------------|--------|
| `POST /api/damage` | Direct `@smogon/calc` wrapper — takes classic EVs (0-252), not SP | `damage.js:30-113` |
| `POST /api/damage/realistic` | Auto-resolves SP from `ev_observations`, converts to EVs | `damage.js:145-208` |
| `spread_scorer.js` | Thousands of `calculate()` calls during evolutionary search | ~20 call sites |
| `team_analyzer.js` | Matchup analysis OHKO checks | ~10 call sites |

### buildPokemon() (`damage.js:22-26`)

Wraps `@smogon/calc`'s `Pokemon` constructor:
```javascript
function buildPokemon(speciesRow, evs, nature, level, item, ability) {
  return new calc.Pokemon(gen, speciesRow.name, {
    level, nature, item, ability,
    evs: { hp: evs[0], atk: evs[1], def: evs[2], spa: evs[3], spd: evs[4], spe: evs[5] },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  });
}
```

- Exported from `damage.js:214` and consumed by `spread_scorer.js`, `team_analyzer.js`, `ev_optimizer.js`
- `spToEv()` is called at this boundary (see `ARCHITECTURE_sp_system.md`)

### Field Construction

`damage.js` builds `@smogon/calc` `Field` with weather and terrain. Team build flow
constructs field context from `detectTeamWeatherContext()` in `item_optimizer.js`
and passes it through to `spread_scorer.js`.

### POST /api/damage Realistic Resolution

`POST /api/damage/realistic` (`damage.js:145-208`):
1. Resolves attacker/defender names via `normalizePokemonName()`
2. Looks up most-common SP spread from `ev_observations` per Pokemon
3. Converts SP to EVs via `spToEv()`
4. Resolves nature from most-common observation (or Adamant/neutral defaults)
5. Performs `@smogon/calc` `calculate()`
6. Returns: min/max damage, percent ranges, SP source info, cached status

### Damage Cache (`serebii.js`)

`damageCache` in `serebii.js` — an LRU cache with TTL for `POST /api/damage` results:
- `CACHE_TTL_MS`: 6 hours (21,600,000 ms)
- `CACHE_MAX_SIZE`: 10,000 entries
- Insertion-order eviction (oldest entry removed when at capacity)
- Keyed by cache key built via `buildCacheKey()` from Pokemon names + move + params
- Invalidated per-Pokemon when a balance patch changes relevant stats

The cache is separate from `spread_scorer.js`'s `damageCalcCache` (which is per-search-session).

## Type Chart (`typeChart.js`)

Uses `@pkmn/dex`'s `damageTaken` codes:
```javascript
CODE_TO_MULTIPLIER = { 0: 1, 1: 2, 2: 0.5, 3: 0 };
```

Exported functions:
| Function | Purpose |
|----------|---------|
| `effectivenessAgainst(attackType, [defType1, defType2])` | Combined type multiplier |
| `weaknessesOf([types])` | `{Type: multiplier}` where multiplier > 1 |
| `resistancesOf([types])` | `{Type: multiplier}` where multiplier < 1 |

## Name Normalization (`normalize.js`)

### normalizePokemonName()

Resolves display names to DB keys:
1. Exact match from `normalizeTeam()` data first
2. Then exact match from DB
3. Then `@pkmn/dex` `Dex.species.get()` 
4. Then hyphen-truncation (progressively shorter prefixes)
5. Falls back to `MANUAL_MAP` for gender forms (Basculegion-F, Indeedee-F, etc.)
6. Returns null if no resolution

### normalizeTeam()

Parses Showdown export format: splits on newlines, identifies Pokemon sections by lines
containing " @" (item indicator). Returns `[{name, item, ...}]` array.

### MEGA_ITEM_MAP

78+ entries mapping item names (e.g., "Swampertite") to Mega form names
("Swampert-Mega"). Used by `normalizeTeam()` during team parsing. Audit function
`auditMegaItemMappings()` runs on startup checking for unmapped `-ite`/`-nite` items.

### Team Parsing Flow

```
vgcpastes.js parse → team.js parseShowdownTeam() →
  Handles: EVs line (as SP), nature, ability, item, moves, Tera type
  SP regex: /EVs:\s*(\d+)\s*HP\s*\/\s*(\d+)\s*Atk\s*\/\s*.../i (classic format)
  Converts to SP via spToEv() reverse: SP = (EV + 4) / 8
```

## nerd_of_now_calc.js (Ported Reference Calculator)

Self-contained, imports nothing from the project. Exports 13 functions including
`CalcDamage()`, `calcBaseDamage()`, `calcStatHP()`, `calcStatNonHP()`.

Not currently imported by any other module — a standalone utility available for
verification or future use. Uses Champions-specific formulas (`CALC_HP_CHAMP`,
`CALC_STAT_CHAMP`) rather than `@smogon/calc`.

## Mega Form Damage Resolution

When a Mega form is the attacker or defender:
1. `normalizePokemonName()` finds the row by direct name (e.g., "Swampert-Mega")
2. The `pokemon` table has 90 Mega rows with real base stats
3. Fallback: hyphen-strip to base form → `Dex.species.get()` → base stats
4. `auditMegaItemMappings()` on startup logs any unmapped items
