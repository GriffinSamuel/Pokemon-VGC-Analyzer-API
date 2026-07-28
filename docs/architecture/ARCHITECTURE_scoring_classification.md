# Scoring System & Classification

## Threshold Formatting

### Defensive Thresholds
Format: `{move_name} ({damage_range})` + `{attacker_build}` + `{spread_frequency}`

Example from `team.js` text output:
```
OFFENSIVE THRESHOLDS:
  Earthquake (125-148) — Jolly 32 Atk Choice Band Landorus-T (10% spread)
```

### Speed Benchmarks
`getMetaContext()` returns:
```javascript
{speed_benchmarks: [{pokemon: "Garchomp", speed: 102, usage: 18.3}, ...], 
 ability_prevalence: {...},
 scarf_frequency: 0.20}
```

### Offensive Thresholds
Same format as defensive, but attacker is the team's Pokemon:
```
DEFENSIVE THRESHOLDS:
  Moonblast (115-136) — Modest 32 SpA Choice Specs Flutter Mane (8% spread)
```

---

## KO Tier Classification

**Defensive (spread_scorer.js):**
- `koCheckValue = Math.max(all damage values)` — the worst single damage roll from any top-3 build's full roll range
- Purpose: "can I survive the worst-case hit from this threat?"

**Offensive (spread_scorer.js):**
- `koCheckMin = Math.min(minimum damage rolls)` — the bulkiest target's minimum damage roll
- Purpose: "can I guarantee the KO on the bulkiest reasonable target?"

**4HKO branch** exists separately from 3HKO, each with its own `TYPE_VALUES` entry:
- `3hko_prevented: 0.3`, `4hko_prevented: 0.05`
- `ohko_achieved: 8.0`, `2hko_achieved: 2.0`

---

## Aggression Multiplier

Applied to DEFENSIVE checks only in `spread_scorer.js` (spread scoring direction):

| Condition | Multiplier | Purpose |
|-----------|-----------|---------|
| Super effective (≥2× type) | 2.5 | High-priority threat |
| STAB + neutral (1×) | 1.2 | Likely move |
| Offensive role attacker | 1.0 | Baseline |
| Support role, STAB, ≤1× | 0.20 | Low threat (`AGGRESSION_SUPPORT_STAB`) |
| Support role, non-STAB, ≤1× | 0.05 | Minimal threat (`AGGRESSION_SUPPORT_OFF_STAB`) |
| Non-damaging move | 0.0 | Ignored |

**Attacker role** determined by `role_classifier.js` — attacker with `fast_offense` or `slow_bulky_offense` role gets offensive treatment; `slow_bulky_support` and `fast_support` get support treatment.

---

## Speed-OHKO Link

```
SPEED_OHKO_LINK_MULTIPLIER = 3.0
```

When the defender's spread enables outspeeding an attacker AND that attacker OHKOs at
baseline (0 investment in the relevant stat), the speed-tier contribution is tripled.
This reflects the VGC principle: outspeeding a OHKO threat is one of the most valuable
things a spread can do.

**Death Trap Penalty:**
- `DEATH_TRAP_MIN_WEIGHT = 0.15` — minimum threat weight for penalty to apply
- `PENALTY_MULTIPLIER = 2.0` — when: outsped AND OHKO'd at baseline AND no Protect/priority
  in top 4 moves → spread is penalized (death trap scenario)

---

## Speed Comparison in Team Build

`team_analyzer.js:effectiveSpeed()`:
```javascript
function effectiveSpeed(pokemonRow, item, abilityName) {
  let speed = pokemonRow.spe;
  if (item === 'Choice Scarf') speed = Math.floor(speed * 1.5);
  if (abilityName && CONDITIONAL_SPEED_ABILITIES[abilityName]) speed *= 2;
  return speed;
}
```

**Trick Room viability gate** (`isTrickRoomViableTeam()`):
All three conditions must hold:
1. Median team base Speed < 70
2. 3+ members with base Speed < 80
3. 1+ member with base Speed < 60

Hard filter — Trick Room removed from both move recommendations and synergy output
for non-viable teams.

---

## Choice Item Restriction

`CHOICE_ITEMS_BANNING_PROTECT` in `team.js`: Choice Scarf/Band/Specs holders have
Protect hard-filtered from their move list entirely (not just warned). This is a
mechanical restriction in the game, not a suggestion.

---

## Mega Form Naming Convention

**Display names:** `Swampert-Mega`, `Charizard-Mega-X`, `Charizard-Mega-Y`
**Item names:** `Swampertite`, `Charizardite X`, `Charizardite Y`

`normalize.js:MEGA_ITEM_MAP` (78+ entries) maps item → Mega form name.

**Audit:** `auditMegaItemMappings()` runs on startup — queries all items in DB ending
with `-ite` or `-nite`, checks each against MEGA_ITEM_MAP, logs unmapped ones.

---

## Item Ability Resolution Convention

Two-pass in `team.js` (build flow):
1. **Provisional pick:** most common ability from real frequency data
2. **Weather context:** if team has weather setter + conditional ability (Swift Swim), pick conditionally
3. **Final pick:** override provisional if weather context supports conditional

`CHOICE_ITEMS_BANNING_PROTECT` also excludes Choice Scarf when real conditional-speed
ability is active — prevents contradictory recommendations.

---

## Recommendation Engine Output Shapes

### GET /api/recommend/evs/:pokemon
```javascript
{
  pokemon, nature, item, role, observations,
  spreads: [
    {sp: [32,0,14,0,20,0], nature: 'Bold', final_stats: {hp:207,...}, 
     thresholds_met: [...], thresholds_missed: [...], ...},
    ...  // 3 spreads
  ]
}
```

### GET /api/recommend/moves/:pokemon
```javascript
{
  pokemon, appearances, moves: [
    {move: 'Earthquake', slot: 1, confidence: 0.82, notes: '...'},
    ...  // 4 moves
  ]
}
```

### GET /api/recommend/synergy/:pokemon
```javascript
{
  pokemon, strong: [{pokemon, score, reasons: [...]}], 
  weak: [{pokemon, score, reasons: [...]}]
}
```

---

## Recommendation Scoring System

`recommend.js:800` validate endpoint:
- Parses `?sp=32-0-14-0-20-0&nature=Bold` query params
- Validates: 6 integers 0-32, total ≤ 66
- Returns `{score, final_stats, thresholds_met, thresholds_missed, vs_evolutionary_rank1}`
- Uses same `scoreSpread()` the evolutionary search uses

---

## SP Cap Per-Stat Enforcement

**32 per stat, 66 total.**

Enforcement points (verified):
1. `spread_optimizer.js:validateSpread()` — after every GA operation
2. `recommend.js:813` — validate endpoint input
3. `spread_scorer.js:1094` — final assertion in `minimizeSpread()`
4. `team.js:1044-1058` — pre-validation before team build pipeline
5. `spread_optimizer.js` — GA mutation + crossover both clamp to 0-32 range

---

## SP Budget Exhaustion

Unspent SP is always represented as 0 in a slot. The 6-integer `[hp, atk, def, spa, spd, spe]`
array sums to ≤ 66. When no additional breakpoints are achievable, the optimizer
stops spending and leaves budget unused. This is valid — the budget is a ceiling,
not a target.
