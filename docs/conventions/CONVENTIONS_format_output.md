# Format & Output Conventions

## Spread Representation

**Internal format (everywhere except `POST /api/damage`):**
```javascript
{ hp: 32, atk: 0, def: 14, spa: 0, spd: 20, spe: 0 }  // SP (0-32)
// or array: [32, 0, 14, 0, 20, 0]  (hp-atk-def-spa-spd-spe order)
```

**`POST /api/damage` input:** Classic EVs (0-252), not SP. Converted to SP internally via `evsToSp()` before reaching CalcDamage.

---

## Threshold Line Format

Thresholds in team builder text output follow this pattern:

```
OFFENSIVE THRESHOLDS:
  Earthquake (125-148) — Jolly 32 Atk Choice Band Landorus-T (10% spread)
DEFENSIVE THRESHOLDS:
  Moonblast (115-136) — Modest 32 SpA Choice Specs Flutter Mane (8% spread)
WEATHER THRESHOLDS:
  ...
SECONDARY THRESHOLDS:
  ...
```

Categories: `OFFENSIVE`, `DEFENSIVE`, `WEATHER`, `SECONDARY`. Each preceded by a `===` divider.

**Verified at:** `team.js:675-724` (`describeThresholdForWhy()`).

---

## Why Block Assembly

The Why block is one line per non-zero SP stat, showing the highest-contribution threshold that stat's investment addresses. Assembly logic in `team.js:buildSpAllocationWhy()`:

1. For each stat with SP > 0, find the highest-contribution threshold in `thresholds_met` tagged to that stat
2. If a threshold exists → `survives {threat} ({attacker_build}: {damage_min}-{damage_max}%{recoil})`
3. If no threshold but it's the primary offensive stat → `maximized for offensive role`
4. If no threshold and not primary offensive → `unspendable SP: {n} (no threshold cleared)`
5. Final line: `SP: {justified} justified + {unspendable} unspendable = 66 total`

**Verified at:** `team.js:754-798`.

---

## Secondary Interactions Format

When a defensive threshold has secondary interactions (other threats near the same breakpoint), they appear on a continuation line:

```
  survives Flutter Mane Moonblast (Modest 32 SpA Choice Specs Flutter Mane: 88-104%)
     [also: Garchomp Earthquake (72-85%, Adamant 32 Atk Choice Band Garchomp) | Landorus-T Earthquake (65-77%, Jolly 32 Atk Choice Band Landorus-T)]
```

Format: `[also: {attacker} {move} ({range}{, {build}}{recoil}) | ...]`

Sorted by max damage descending, top 4.

**Verified at:** `team.js:697-720`.

---

## Speed Section Format

Speed thresholds are formatted as:

```
OUTSPEED:
  Flutter Mane 240+ — 32 Spe: Garchomp 134 > Flutter Mane 130
  requires Scarf active (Choice Scarf, 20% run scarf, see skipped)
CONDITIONAL (weather/ability):
  requires Rain active (Swift Swim, 40% of Barraskewda) — 32 Spe: Gyarados 134 > Barraskewda 130
TRICK ROOM:
  outspeeds Landorus-T under TR (base 91, TR relevant)
```

Context notes appear when Scarf frequency or ability boost frequency is significant:
```
 — note: 20% run scarf, 40% run Swift Swim, see skipped
```

**Verified at:** `recommend.js:366-453`.

---

## Attacker Build Label

The build label in damage strings is formatted as:

```
{Nature} {SP} {StatLabel} {Item} {Ability}
Example: "Adamant 32 Atk Choice Band Landorus-T"
Example: "Modest 32 SpA Choice Specs Flutter Mane Drizzle"
```

- Item included only if it boosts this move's type (or is neutral like Life Orb)
- Ability included only if it affects damage output (`DAMAGE_AFFECTING_ABILITIES`)
- `StatLabel` is `Atk` for Physical, `SpA` for Special

**Verified at:** `spread_scorer.js:549-561` (`buildAttackerBuildLabel()`).

---

## Recoil Text Format

After a damage range, recoil is appended in parentheses:

```
(24.6-29.1% recoil to attacker)
(33.3% recoil to attacker — capped)
```

- Single value (min === max): `(24.6% recoil to attacker)`
- Range: `(24.6-29.1% recoil to attacker)`
- Capped at max recoil: `— capped` suffix
- Only shown on recoil moves (`RECOIL_MOVES` map)

**Verified at:** `spread_scorer.js:563-583`.

---

## Mega Form Naming

| Context | Convention | Example |
|---------|-----------|---------|
| DB `pokemon.name` | `{Base}-Mega` or `{Base}-Mega-{X/Y}` | `Swampert-Mega`, `Charizard-Mega-X` |
| Item name | `{Base}ite` or `{Base}ite {X/Y}` | `Swampertite`, `Charizardite X` |
| Display in API response | Same as DB name | `Swampert-Mega` |
| Internal keys | Lowercase DB name | `swampert-mega` |

`MEGA_ITEM_MAP` in `normalize.js` maps item names → Mega form names (78+ entries).

---

## Item/Ability in Damage Strings

Items appear in damage strings when they affect the move being evaluated:
- Choice Band/Specs/Scarf: always included when relevant to the stat
- Life Orb: included (boosts all damage)
- Focus Sash: included only in defensive context
- Type-boosting items: included when boosting the move's type

Abilities appear when they affect damage:
- Weather setters (Drizzle, Drought, etc.): included in build label
- Damage-boosting abilities: included
- Conditional-speed abilities: NOT in damage label (they affect speed, not damage)

**Verified at:** `spread_scorer.js:555-558` (item filter), `spread_scorer.js:558` (ability filter).

---

## Weather Ball Display Convention

Weather Ball's displayed type and power under active weather:
```
100 BP Water-type, assumes our Rain active (1.5x weather bonus = effective 150 BP)
100 BP Fire-type, assumes our Sun active (1.5x weather bonus = effective 150 BP)
100 BP Rock-type, assumes our Sand active
100 BP Ice-type, assumes our Snow active
```

Stored as Normal-type/40 BP in moves table — the dynamic resolution happens at display time, not in the DB.

**Verified at:** `team.js:539-551`.

---

## Text Output Section Ordering

Section order in team build text output depends on team's primary role:

**Fast roles (`fast_offense`, `fast_support`):** SPEED first
**Slow-bulky roles (`slow_bulky_offense`, `slow_bulky_support`):** DEFENSE first

Standard section order:
1. INDIVIDUAL BUILDS (per-Pokemon: moves, SP spread, Why block, SEEDS)
2. ITEM DECISIONS
3. COVERAGE (gaps + suggestions)
4. SYNERGY (weather, TR, redirection)
5. SPEED TIERS (benchmarks, ties)
6. WEAKNESSES (shared weaknesses)
7. MATCHUP ANALYSIS (OHKO opportunities + risks)
8. ARCHETYPE MATCHUPS
9. QUICK FIX RECOMMENDATIONS

**Verified at:** `team.js:802-1037`.

---

## Ability Display in Build Output

```
Ability: Intimidate
Ability: Swift Swim (base: Rain Dish)
```

When a Pokemon has a conditional ability (e.g., Swift Swim) and a base ability, both are shown: the resolved ability with the base ability in parentheses.

**Verified at:** `team.js:808-810`.

---

## JSON Response Error Format

All error responses use:
```json
{ "error": "Descriptive message here" }
```

Status codes: 400 (validation), 404 (not found), 429 (rate limit), 500 (internal).

---

## Threshold Score Format

In JSON responses, threshold scores are rounded to 3 decimal places:
```json
{ "score": 8.420, "threshold_type": "ohko_prevented", "sp_investment": 14 }
```

**Verified at:** `recommend.js:251` (`round(t.score, 3)`).

---

## Speed Benchmark Context Note

Speed benchmarks include contextual notes about real-world modifiers:
```
 — note: 20% run scarf, 40% run Swift Swim, see skipped
```

The two percentages come from independent samples (item field vs. ability field in different tables) and are surfaced separately, not combined.

**Verified at:** `recommend.js:385-393`.
