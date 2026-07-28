# Damage Calc Conventions

## Production Calculator: @smogon/calc

All production damage calculations use `@smogon/calc` (Gen 9). The `nerd_of_now_calc.js` exists as a standalone ported reference but is **not imported by any other module** — it is not used in production paths.

**Verified at:** `nerd_of_now_calc.js:1` (no import references in codebase).

---

## buildPokemon Boundary

`damage.js:buildPokemon(speciesRow, evs, nature, level, item, ability)` is the sole bridge from SP to EV:

```javascript
function buildPokemon(speciesRow, evs, nature, level, item, ability) {
  return new calc.Pokemon(gen, speciesRow.name, {
    level, nature, item, ability,
    evs: { hp: evs[0], atk: evs[1], def: evs[2], spa: evs[3], spd: evs[4], spe: evs[5] },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  });
}
```

- `evs` parameter is always classic EVs (0-252), converted from SP via `spToEv()` before this call
- `gen = calc.Generations.get(9)` (Gen 9)
- `level = 50` (constant)
- IVs are always 31 (Champions has no IV mechanic)

**Verified at:** `damage.js:22-26`.

---

## Weather Application Order

The order in which weather, terrain, and field conditions are applied to a damage calculation:

1. **Base power** determined by move's static properties (from `moves` table)
2. **Weather Ball type/power resolution** (special case — see below)
3. **Solar Beam charge skip and BP penalty** (0.5x in rain/sand/snow)
4. **Item multiplier** applied by `@smogon/calc` natively (Choice Band/Specs, Life Orb, Assault Vest)
5. **Weather type boost** (Rain boosts Water 1.5x, Sun boosts Fire 1.5x) applied by `@smogon/calc`
6. **Field weather** set in `@smogon/calc` `Field({weather: 'Rain'})` etc.
7. **Recoil** computed after damage, capped at target's remaining HP

**Verified at:** `spread_scorer.js:14-16` (item natively handled), `team_analyzer.js:143-153` (Weather Ball resolution).

---

## Weather Ball Rules

Weather Ball is stored in the `moves` table as Normal-type / 40 BP (its no-weather values). It is genuinely dynamic — type AND power change under active weather:

| Active Weather | Type | Base BP | Weather Bonus |
|---------------|------|---------|---------------|
| Rain | Water | 100 | ×1.5 (Rain boosts Water) |
| Sun | Fire | 100 | ×1.5 (Sun boosts Fire) |
| Sand | Rock | 100 | — |
| Snow | Ice | 100 | — |

The `WEATHER_BALL_TYPES` mapping exists identically in three places (intentional duplication):
- `synergy_reasons.js:17` — `WEATHER_BALL_TYPES = { Rain: 'Water', Sun: 'Fire', Sand: 'Rock', Snow: 'Ice' }`
- `team_analyzer.js:146` — same mapping
- `team.js:539-551` — same mapping with weather bonus calculation

**Verified at:** All three locations confirmed by grep.

---

## Recoil Convention

Recoil is computed post-damage, not as part of the `@smogon/calc` call. The formula:

```
recoil_pct = min(damage_dealt × recoil_ratio, max_recoil_pct)
```

Where `max_recoil_pct` is the move's maximum recoil as a percentage (e.g., Flare Blitz = 33.3%, Wild Charge = 25%, Head Smash = 50%). Damage is capped at the target's remaining HP (100%) before applying the ratio, so overkill doesn't inflate recoil.

Recoil text format: `(24.6-29.1% recoil to attacker)` or `(33.3% recoil to attacker — capped)`.

**Verified at:** `spread_scorer.js:563-583` (`buildRecoilText()`), `RECOIL_MOVES` map at `spread_scorer.js:107`.

---

## Aggression Multiplier (Defensive Scoring Only)

The aggression multiplier models whether an attacker would realistically deploy a specific move against a specific defender. Applied ONLY to defensive checks in `spread_scorer.js`:

| Condition | Multiplier | Constant |
|-----------|-----------|----------|
| Non-damaging move | 0.0 | `AGGRESSION_NON_DAMAGING` |
| Support role, non-STAB, ≤1× effective | 0.05 | `AGGRESSION_SUPPORT_OFF_STAB` |
| Support role, STAB, ≤1× effective | 0.20 | `AGGRESSION_SUPPORT_STAB` |
| Offensive role attacker | 1.0 | `AGGRESSION_OFFENSIVE_ROLE` |
| STAB + neutral (1×) | 1.2 | `AGGRESSION_STAB_NEUTRAL` |
| Super effective (≥2×) | 2.5 | `AGGRESSION_SUPER_EFFECTIVE` |

**Rule chain (order matters):**
1. Status / no power → 0.0
2. ≥2× effective → 2.5 (regardless of role or STAB)
3. STAB + 1× effective → 1.2 (regardless of role)
4. Offensive role → 1.0
5. Otherwise → 0.20 (STAB) or 0.05 (non-STAB)

**Verified at:** `spread_scorer.js:144-153`.

---

## TYPE_VALUES (Scoring Constants)

```javascript
TYPE_VALUES = {
  ohko_prevented:   10.0,   // highest value — surviving an OHKO is critical
  2hko_prevented:    3.0,   // significant but less than OHKO
  3hko_prevented:    0.3,   // marginal — 3HKOs rarely matter in VGC doubles
  4hko_prevented:    0.05,  // near-zero — opponent likely switches before 4 hits
  ohko_achieved:      8.0,  // offensive OHKO is valuable
  2hko_achieved:      2.0,  // offensive 2HKO
  speed_tier:         4.0,  // outspeeding benchmarks
  trickroom_speed:    3.0,  // under-speeding benchmarks (TR)
}
```

3HKO and 4HKO are pushed toward zero because in real VGC doubles, the opponent likely switches, speed/priority/partner-play intervene before 3+ hits land, and SP spent chasing those thresholds is usually wasted.

---

## KO Tier Classification

**Defensive direction:** `koCheckValue = Math.max(all damage values)` — the worst single damage roll from any top-3 build's full roll range. "Can I survive the worst-case hit?"

**Offensive direction:** `koCheckMin = Math.min(minimum damage rolls)` — the bulkiest target's minimum damage roll. "Can I guarantee the KO on the bulkiest reasonable target?"

---

## Verified Against Nerd of Now Standard

The project maintains a ported Nerd of Now calculator (`nerd_of_now_calc.js`) as a reference implementation. The standard for "verified against Nerd of Now" means:

- The ported calculator produces the same damage ranges as the upstream JavaScript calculator
- Any discrepancy between `@smogon/calc` and the Nerd of Now calculator is investigated
- The Nerd of Now calculator uses Champions-specific stat formulas (`CALC_HP_CHAMP`, `CALC_STAT_CHAMP`)

This is a reference/validation tool, not a production path.

---

## Item Threading

Items are threaded into `@smogon/calc` via the `item` parameter of `damage.buildPokemon()`. `@smogon/calc` natively models:
- Choice Scarf/Band/Specs (damage + speed multipliers)
- Life Orb (damage + recoil)
- Assault Vest (SpD ×1.5)

Items NOT modeled natively by `@smogon/calc` (handled by the scorer's own logic):
- Leftovers (HP recovery — modeled as breakpoint bonus in `item_optimizer.js`)
- Rocky Helmet (attacker recoil — not modeled in scoring)
- Focus Sash (survival guarantee — handled via sash penalty in `spread_scorer.js`)

---

## Weather Setter Vocabulary

Fixed game-mechanics vocabulary duplicated across 4+ locations:

| Location | Purpose | Keys |
|----------|---------|------|
| `synergy_reasons.js:7-9` | Calc-oriented weather strings | `{Drizzle: 'Rain', Drought: 'Sun', 'Sand Stream': 'Sand', 'Snow Warning': 'Snow'}` |
| `item_optimizer.js:80-85` | Ability→weather mapping | Same 4 abilities |
| `team_analyzer.js` | Display-oriented | Same abilities, plus `WEATHER_LABELS` for output |
| `train_synergy.py:37-43` | Mining-oriented | `FIELD_CONDITIONS` list |

All use the same underlying values but in different formats — this is intentional per code comments, not drift.

---

## Ability Threading

Abilities are resolved via `item_optimizer.js:resolveRealAbility()`:
1. Query real ability frequency from `tournament_teams` JSONB
2. Filter conditional abilities (Swift Swim, etc.) based on team weather context
3. Two-pass: provisional pick → weather context → final pick
4. Choice Scarf excluded when real conditional-speed ability is active

The ability is passed to `@smogon/calc` via `damage.buildPokemon(…, ability)`.
