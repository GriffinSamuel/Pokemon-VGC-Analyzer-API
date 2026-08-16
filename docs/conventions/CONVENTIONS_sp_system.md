# SP System Conventions

## The Two Formulas

Champions uses Stat Points (SP), not the classic 508-EV system. Level is always 50, IVs are always 31.

```
HP  = base + sp + 75
X   = floor((base + sp + 20) × alignment)
```

Where alignment = 1.1 (boosted nature), 1.0 (neutral), 0.9 (hindered).

`evsToSp()` converts classic EVs (0-252) from `POST /api/damage` input to SP (0-32) internally. CalcDamage speaks SP natively — no EV conversion at the calc boundary.

**Verified at:** `stat_formula.js:20-36` (`calcStat()`), `stat_formula.js:40-44` (`spToEv()`).

---

## SP Caps and Budget

| Constant | Value | Meaning |
|----------|-------|---------|
| `SP_CAP_PER_STAT` | 32 | Maximum SP in any single stat |
| `SP_BUDGET_TOTAL` | 66 | Sum of all 6 stats |

A spread is valid if and only if every stat is in [0, 32] and the total is ≤ 66. The budget is a ceiling, not a target — unspent SP is valid when no additional breakpoints are achievable.

---

## Enforcement Points (invariant: every GA operation must respect caps)

1. `validateSpread()` in `spread_optimizer.js:14-28` — validates after every GA operation; clamps on violation, throws on unclamped total > 66
2. `recommend.js:812` — validates `?sp=` input on the validate endpoint
3. `spread_scorer.js:1093-1094` — final assertion in `minimizeSpread()` after stripping unattributable SP
4. `redistributeOverflow()` in `spread_optimizer.js:119-149` — called after every crossover, mutation, and generation step; caps each stat at 32, subtracts overflow from lowest-weighted nonzero stats
5. `generateCandidate()` in `spread_optimizer.js:165` — clamps at generation time

---

## spToEv Boundary (invariant)

All damage calcs use CalcDamage() from `nerd_of_now_calc.js`, which speaks SP (0-32) natively. `evsToSp()` is called only at the `POST /api/damage` API boundary to convert classic EV inputs. The entire codebase speaks SP (0-32/stat, 66 total) except this single API input boundary:
- `damage.buildPokemon()` converts SP→EV at construction time
- `POST /api/damage` accepts classic EVs directly (intentional thin wrapper)

**Verified at:** `damage.js:evsToSp()` (API boundary only), `nerd_of_now_calc.js:CalcDamage()` (SP-native calculator).

---

## Defensive Threshold Attribution

Every defensive `thresholds_met` entry is tagged with the ONE stat whose investment produced it. The rule, in order:

1. The move's real defending stat is the primary candidate — `def` for a Physical hit, `spd` for a Special one.
2. That stat is "load-bearing" if forcing it to 0 (every other stat left at its candidate value) changes the KO tier. If so, attribute to it.
3. Only if the real defending stat is NOT load-bearing, test HP the same way. If HP is load-bearing, attribute to `hp`.
4. If neither is load-bearing alone, the threshold is dropped (see the guard below).

**Why the order matters:** HP is the denominator of every damage percentage, so zeroing it moves a KO tier in nearly every case. An HP-first rule therefore relabels essentially every defensive threshold as `hp`, leaving Def and SpD with nothing tagged to them — and `minimizeSpread()` only protects investment that some `thresholds_met` entry depends on, so it strips Def/SpD out. Measured live on the standing six-Pokemon team: 100% of surviving thresholds tagged `hp`, 0 tagged `def`/`spd`, with Archaludon losing SpD 13→0 and Pelipper losing Def 21→0.

**Verified at:** `spread_scorer.js` DEFENSIVE loop, `zeroedKoFor()` and the attribution block immediately after it.

---

## Marginal-Value Guard

A defensive threshold only justifies SP if the attributed stat's investment produces a **KO-tier improvement** relative to that stat sitting at 0:

```javascript
if (tierIndex(koResult) <= tierIndex(koWithoutAttributed)) continue;
```

A 2HKO→3HKO or 3HKO→no_ko gain counts. The bar is NOT "would we be OHKO'd without it".

**Why:** `defensiveFactor()` already credits sub-OHKO tier deltas, and `score += contribution` banks them before this point. The guard decides only what enters `thresholds_met`. If the guard is stricter than the scorer, the two optimise different objectives — and because `minimizeSpread()` accepts or rejects each −1 SP step purely on `thresholds_met`, SP the scorer paid for gets refunded. **Scoring and display must never disagree.**

The prior rule was `verifyResult.koCheckValue < 100`. Its counterfactual zeroes one stat while `baseline_ko` zeroes all six, so the counterfactual can never deal more damage than the baseline — meaning that test could only pass when `baseline_ko` was already `OHKO`. Every sub-OHKO improvement was silently discarded.

**Known gap:** a threshold that is load-bearing only ACROSS stats (neither Def nor HP alone flips the tier, but removing both does) is still dropped. See the cross-stat attribution item in the project journal.

**Verified at:** `spread_scorer.js` DEFENSIVE loop, immediately before `met.push(...)`.

**Note:** `recommend.js:206`'s `survival_without_investment` check is a SEPARATE, older filter that applies only to the `GET /api/recommend/evs` JSON path. It does not govern the Why block and is not reachable from `POST /api/team/build`.

---

## Unspendable SP

SP in a stat with no qualifying threshold is classified as "unspendable" in the Why block. Every SP must be accounted for: either justified by a threshold or marked unspendable. The final line of every Why block is:

```
  SP: {justifiedSp} justified + {unspendableTotal} unspendable = 66 total
```

**Verified at:** `team.js:794-798`.

---

## Focus Sash Rule

When a Pokemon holds Focus Sash, its OHKO_prevented contribution is reduced by 90% (multiplied by 0.1). The Sash already guarantees survival from one OHKO at full HP — spending SP to also survive that OHKO is wasteful.

2HKO and 3HKO prevention still matters (Sash does not prevent follow-up hits after the first).

**Verified at:** `spread_scorer.js:693-698`:
```javascript
const isFocusSash = itemLower === 'focus sash';
const sashPenalty = (isFocusSash && multKey === 'ohko_prevented') ? 0.1 : 1;
```

---

## Locked Offensive Stats (invariant)

For every Pokemon, the optimizer locks (hard-zeros) the less relevant offensive stat:
- `slow_bulky_support` → locks Atk AND SpA to 0
- All other roles → locks whichever of Atk/SpA is lower
- A locked stat never receives SP at generation, crossover, mutation, or Phase C
- `redistributeOverflow()` re-zeros locked stats after any operation

**Verified at:** `spread_optimizer.js:364-374` (`determineLockedIndices()`), `spread_optimizer.js:119,138` (hard zero in redistribute).

---

## Fast-Role Speed-First Allocation

When role is `fast_offense` or `fast_support` and base Speed ≥ 90, the generator pins Speed to 32 first, then distributes the remaining 34 SP across other stats by weight. This ensures fast Pokemon always reach max speed to win speed ties in common tiers.

**Verified at:** `spread_optimizer.js:160-191` (`FAST_ROLE_SPEED_FIRST_THRESHOLD = 90`).

---

## SP Minimization

After the GA finds its top spread, a minimization pass runs (`spread_scorer.js:minimizeSpread()`):
The function greedily decreases each stat by 1 SP, verifying via scoreSpread() that the score is unchanged. Every SP removal is checked against all thresholds — there is no bulk-strip step, so defensive SP that is load-bearing for a threshold attributed to a different stat (e.g., Def enabling an HP-tagged survival threshold) is never silently removed.

Priority order: HP → relevant defense → relevant offense → remaining → speed.
The loop repeats until no stat can be decreased further.

After minimization completes, a final scoreSpread() pass computes thresholds_met against the actual minimized spread, ensuring all displayed damage numbers match the printed spread exactly.

This ensures the final spread is the minimum SP that achieves its score. Only runs in team-build mode.

**Verified at:** `spread_optimizer.js:573-580`, `spread_scorer.js:1040-1120`.

---

## Breakpoint Detection

`findBreakpoints(baseStat, alignment, isHp)` in `stat_formula.js:50-72`:
- For each SP value 0-32, computes the resulting stat
- Returns `[{sp, stat, jump}]` where `jump` is the delta from the previous SP
- A "breakpoint" is where `jump > 0` (SP spent produced a real stat increase)
- Non-integer jumps mean the SP was partially wasted

`snapToBreakpoint(sp, baseStat, alignment, isHp)` finds the next SP value that produces a real stat gain.

---

## Role Multipliers (in ev_optimizer.js)

`ROLE_MULTIPLIERS` weights the greedy threshold scanner's priority by category:

| Role | Defense | Speed | Offense |
|------|---------|-------|---------|
| fast_offense | 1× | 3× | 2× |
| slow_bulky_offense | 2× | 1× | 2× |
| slow_bulky_support | 3× | 2× | 1× |
| fast_support | 2× | 3× | 1× |

These affect spread selection in the greedy system, not the CalcDamage output.

---

## SCORER_VERSION

`SCORER_VERSION = 9` in `spread_scorer.js:58`. Included in the evolutionary cache key (`ev_optimizer.js:599`) so that when the scoring function changes, cached results from prior versions are automatically invalidated. Bump this when any scoring constant changes.

---

## Nerd of Now Seed Conversion

`nerd_of_now.js:evToSp(EV) = (EV + 4) / 8`, capped at 32/stat, 66 total. If seeds exceed budget, they are scaled down proportionally. Seeds fill N slots in GA Phase A; the rest are random. Treated identically to random candidates during evolution.

---

## Speed-OHKO Link

`SPEED_OHKO_LINK_MULTIPLIER = 3.0`: when a defender outspeeds an attacker AND that attacker OHKOs at baseline, the speed-tier contribution is tripled. This reflects VGC's principle that outspeeding a OHKO threat is one of the most valuable things a spread can do.

---

## Death Trap Penalty

When a common threat:
1. OHKOs at baseline (0 SP in defensive stat)
2. Outspeeds the current spread
3. No Protect or priority in the Pokemon's top 4 moves

Then: `score -= threat.weight × DEATH_TRAP_PENALTY_MULTIPLIER × roleMult.ohko_prevented`

This penalizes spreads that put the Pokemon in a "death trap" — guaranteed KO with no way to avoid the hit.

---

## Speed Tie Penalty

`FIX 6` in `spread_scorer.js:922`: when this Pokemon ties exactly with a common speed-tier threat, a small penalty is applied. Speed ties are 50/50 in-game — a spread that ties is strictly worse than one that outspeeds.
