# SP (Stat Point) System — Verified Conventions

## Champions Formula

Level is always **50**. IVs are always **31** (Champions has no IV mechanic).

```
HP  = base + sp + 75
Atk = floor((base + sp + 20) × alignment)
Def = floor((base + sp + 20) × alignment)
SpA = floor((base + sp + 20) × alignment)
SpD = floor((base + sp + 20) × alignment)
Spe = floor((base + sp + 20) × alignment)
```

Where `alignment` = **1.1** (boosted nature), **1.0** (neutral), **0.9** (hindered).

**Verified:** `stat_formula.js:20-36` — `calcStat()` implements this exactly.

## Caps and Budget

| Constant | Value | Enforced Where |
|----------|-------|----------------|
| `SP_CAP_PER_STAT` | 32 | `stat_formula.js:5` |
| `SP_BUDGET_TOTAL` | 66 | `stat_formula.js:6` |

**Boundary enforcement points** (all independently verify):
- `validateSpread()` in `spread_optimizer.js:14-28` — validates every GA operation; throws on violation
- `recommend.js:813` — validate endpoint rejects `sp` totals > 66
- `spread_scorer.js:1094` — final assertion throw in `minimizeSpread()` if total > 66
- `team.js` build flow — passes through GA pipeline which validates

## spToEv Conversion (the `@smogon/calc` boundary)

```javascript
// stat_formula.js:40-44
function spToEv(sp) {
  if (sp <= 0) return 0;
  return 8 * sp - 4;  // SP 1→32 maps to EV 4→252
}
```

**Critical design decision:** `spToEv()` is called ONLY at the boundary where data enters
`@smogon/calc` — in `damage.buildPokemon()` and nowhere else. Storage, observations,
optimization, and API endpoints speak SP (0-32/stat, 66 total) exclusively.

**Exception:** `POST /api/damage`'s `evs` field is intentionally classic EVs (0-252), not SP
— it's a thin `@smogon/calc` wrapper.

## SP Steps Array

`SP_STEPS` in `stat_formula.js:8-9` — `[0, 1, 2, ..., 32]`, generated via loop. Used by
`findBreakpoints()` and elsewhere to iterate all possible stat investments.

## Nature/Alignment Table

Duplicated in 3 places with identical values (0.9/1.0/1.1):
1. `stat_formula.js:14-28` — `NATURE_MODIFIERS` (array of `[boosted, hindered]` stat names)
2. `features.py:26-49` — `NATURE_MODIFIERS` dict `{name: (boost, hinder)}`
3. `team.js` (inline object in `NATURE_BOOSTS`)

## Breakpoint Detection

`findBreakpoints(baseStat, alignment, isHp)` in `stat_formula.js:50-72`:
- For each SP value (0-32), computes resulting stat using `calcStat()`
- Returns array of `{sp, stat, jump}` — the "jump" is the delta from the previous SP value
- A "breakpoint" is where `jump > 0` (the SP spent produced a real stat increase)
- Non-integer jumps mean the SP was partially wasted

**`snapToBreakpoint(sp, baseStat, alignment, isHp)`** (`stat_formula.js:75-94`):
- Finds the next SP value that produces a real stat gain
- Ensures no SP is "wasted" between breakpoints

## Unspent SP Representation

Unspent SP is always 0 in a slot. The 6-integer `[hp, atk, def, spa, spd, spe]` array
always sums to the SP budget or less. The optimizer may leave budget unused when no
additional breakpoints are achievable.

## Locked Offensive Stats

- `slow_bulky_support` → locks Atk AND SpA to 0
- All other roles → locks whichever of Atk/SpA is weaker
- Enforced in `spread_optimizer.js:determineLockedIndices()` (called at GA start)
- Hard-enforced through every GA stage: generation, crossover, mutation, Phase C local search

## Why Block Assembly

The "Why:" block in text output is assembled per-stat line by `buildWhyBlock()` in
`team.js` (the team build text formatter). Each line covers one non-zero SP stat,
naming: which move/breakpoint it targets, the build context, and the damage range.
Lines are ordered by stat (HP → Atk → Def → SpA → SpD → Spe) regardless of SP value.

## Speed Modifier Application

Applied in `team_analyzer.js:effectiveSpeed()`:
- Choice Scarf: ×1.5 (if item is Choice Scarf)
- Conditional-speed abilities: ×2 (if active — e.g., Swift Swim in rain)
- Same logic in `spread_scorer.js` for evolutionary search

## Nerd of Now Seed Conversion

`nerd_of_now.js:evToSp(EV)`:
```javascript
return (EV + 4) / 8;  // Classic EV (0-252) → SP (0-32)
```
Capped at 32/stat, 66 total (seeds exceeding budget are scaled down proportionally).

## Item Breakpoint Bonuses

`item_optimizer.js` computes additional survivability from items:
- Life Orb: +13% damage on attacker's moves (affects what KOs the defender)
- Leftovers: heals 1/16 HP each turn → effectively shifts 2HKO/3HKO thresholds
- Assault Vest: ×1.5 SpD (modeled by `@smogon/calc` natively)
