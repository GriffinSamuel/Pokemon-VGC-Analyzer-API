const path = require('path');
const { SP_BUDGET_TOTAL, SP_CAP_PER_STAT, natureMultiplierFor, findBreakpoints } = require('./stat_formula');
const { scoreSpread, minimizeSpread } = require('./spread_scorer');
const logger = require('./logger');
const { getNerdOfNowSets } = require('./nerd_of_now');

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_INDEX = { hp: 0, atk: 1, def: 2, spa: 3, spd: 4, spe: 5 };
const EMPTY_LOCKED = new Set(); // default "no locked stats" for callers outside findOptimalSpread (e.g. direct tests)

// SP validation + clamping (REGRESSION A): verify no stat exceeds 32 and
// total does not exceed 66 after every GA operation. If violated, clamp
// values to valid range rather than crashing; log a warning.
function validateSpread(sp) {
  const errors = [];
  let total = 0;
  for (const stat of STATS) {
    const val = sp[stat] || 0;
    total += val;
    if (val < 0) errors.push(`${stat} is negative: ${val}`);
    if (val > SP_CAP_PER_STAT) errors.push(`${stat} exceeds cap: ${val} > ${SP_CAP_PER_STAT}`);
  }
  if (total > SP_BUDGET_TOTAL) errors.push(`Total ${total} exceeds budget ${SP_BUDGET_TOTAL}`);
  return { valid: errors.length === 0, errors };
}

function clampSpread(sp) {
  const clamped = { ...sp };
  for (const stat of STATS) {
    if (clamped[stat] > SP_CAP_PER_STAT) clamped[stat] = SP_CAP_PER_STAT;
    if (clamped[stat] < 0) clamped[stat] = 0;
  }
  return clamped;
}

const POST_VALIDATION_HOOK = (sp) => {
  const result = validateSpread(sp);
  if (!result.valid) {
    logger.error('SP cap violation detected and clamped', { errors: result.errors, sp });
  }
};

const POP_INIT = 200;
const GENERATIONS = 40;
// FIX 3: team-build requests search deeper than individual /api/recommend/evs
// requests — the worker-thread parallelism (evolutionary_worker.js) already
// distributes the extra cost across 6 OS threads, so the wall-clock budget per
// Pokemon (not per-team) is what matters; individual requests are unaffected.
const TEAM_BUILD_POP_INIT = 300;
const TEAM_BUILD_GENERATIONS = 60;
const ELITES = 40;
const CROSSOVER_COUNT = 100;
const MUTATION_COUNT = 60;
const DIVERSITY_INJECTION_EVERY = 10;
const DIVERSITY_INJECTION_SIZE = 20;
const STAGNATION_LIMIT = 10;
const STAGNATION_INJECTION_SIZE = 40;
const LOCAL_SEARCH_RANGE = 5;
const TEAM_BUILD_LOCAL_SEARCH_RANGE = 8;
const LOCAL_SEARCH_CAP_PER_ELITE = 3000; // see generateNeighborhood() — a disclosed bound on the literal spec's
// "-5 to +5 on all 6 stats, all combinations" (11^6 before pruning), which is
// computationally infeasible to run to completion for a live API endpoint even
// once, let alone per elite. Sum<=66 pruning (see below) already eliminates the
// vast majority of the 11^6 space since SP values are never negative; this cap
// bounds the (rarer) case of an elite with enough headroom that the pruned space
// is still large, so Phase C stays a genuine neighborhood search rather than an
// unbounded combinatorial blowup.

// Role weight vectors [hp, atk, def, spa, spd, spe], as specified.
const ROLE_WEIGHTS = {
  slow_bulky_support: [0.30, 0.01, 0.25, 0.05, 0.30, 0.09],
  slow_bulky_offense: [0.25, 0.30, 0.15, 0.10, 0.10, 0.10],
  fast_offense: [0.10, 0.30, 0.05, 0.10, 0.05, 0.40],
  fast_support: [0.20, 0.05, 0.10, 0.05, 0.10, 0.50],
};

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function spreadToArray(spread) {
  return STATS.map((k) => spread[k] || 0);
}

function arrayToSpread(values) {
  const spread = {};
  STATS.forEach((k, i) => { spread[k] = values[i]; });
  return spread;
}

function sumArr(values) {
  return values.reduce((a, b) => a + b, 0);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Caps each stat at 32; overflow moves to the next-highest-weighted stat with
// room. Then, if total still exceeds the 66 budget, subtracts from the
// lowest-weighted nonzero stat(s) until it fits. No breakpoint snapping.
// `lockedIndices` (FIX 1 — offensive-stat locking): a locked stat never
// receives overflow budget, on top of already never being assigned any in the
// first place — defensive, since values[lockedIndex] should already be 0.
function redistributeOverflow(values, weights, lockedIndices = EMPTY_LOCKED) {
  const descByWeight = STATS.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
  for (let i = 0; i < values.length; i++) {
    while (values[i] > SP_CAP_PER_STAT) {
      const excess = values[i] - SP_CAP_PER_STAT;
      values[i] = SP_CAP_PER_STAT;
      let placed = false;
      for (const j of descByWeight) {
        if (j === i || lockedIndices.has(j)) continue;
        const room = SP_CAP_PER_STAT - values[j];
        if (room > 0) {
          values[j] += Math.min(room, excess);
          placed = true;
          break;
        }
      }
      if (!placed) break; // no room anywhere — excess is simply dropped (sum ends up < 66, still valid)
    }
  }
  for (const i of lockedIndices) values[i] = 0; // hard guarantee, regardless of how values[] got here
  let sum = sumArr(values);
  if (sum > SP_BUDGET_TOTAL) {
    let over = sum - SP_BUDGET_TOTAL;
    const ascByWeight = STATS.map((_, i) => i).sort((a, b) => weights[a] - weights[b]);
    for (const i of ascByWeight) {
      if (over <= 0) break;
      const take = Math.min(values[i], over);
      values[i] -= take;
      over -= take;
    }
  }
}

// generateCandidate(weights): sample 6 values proportional to weights summing to
// 66, round to integers (largest fractional remainders get the rounding residual),
// then enforce the 0-32 per-stat cap and 66 total via redistributeOverflow. No
// breakpoint snapping — raw integers only, per the search-time constraint.
// `lockedIndices` (FIX 1): a locked offensive stat (the "wrong" one for this
// Pokemon's physical/special lean, or both for slow_bulky_support) gets its
// weight zeroed before sampling and is excluded from the residual-rounding
// pool, so it never receives any SP at generation time.
// FIX 4: Speed-first allocation for fast roles. When role is fast_offense or
// fast_support and base Speed >= 90, allocate 32 SP to Speed first, then
// distribute the remaining 34 SP across other stats by weight. This ensures
// fast Pokemon always reach max speed to win speed ties in common tiers.
const FAST_ROLE_SPEED_FIRST_THRESHOLD = 90;
function generateCandidate(weights, lockedIndices = EMPTY_LOCKED, role, pokemonRow) {
  const effectiveWeights = weights.map((w, i) => (lockedIndices.has(i) ? 0 : w));

  // FIX 4: For fast roles with base Speed >= 90, pin Speed to 32 first
  const isFastRole = role === 'fast_offense' || role === 'fast_support';
  const hasHighBaseSpeed = pokemonRow && pokemonRow.spe >= FAST_ROLE_SPEED_FIRST_THRESHOLD;
  if (isFastRole && hasHighBaseSpeed && !lockedIndices.has(STAT_INDEX.spe)) {
    // Pin speed to 32, distribute remaining 34 SP
    const remainingBudget = SP_BUDGET_TOTAL - SP_CAP_PER_STAT;
    const remainingWeights = effectiveWeights.map((w, i) => i === STAT_INDEX.spe ? 0 : w);
    const totalW = remainingWeights.reduce((a, b) => a + b, 0);
    if (totalW > 0) {
      const raw = remainingWeights.map((w) => (w / totalW) * remainingBudget);
      const values = raw.map(Math.floor);
      let residual = remainingBudget - sumArr(values);
      const byFrac = raw
        .map((v, i) => ({ i, frac: v - Math.floor(v), w: remainingWeights[i] }))
        .filter((entry) => !lockedIndices.has(entry.i))
        .sort((a, b) => b.frac - a.frac || b.w - a.w);
      for (let j = 0; j < byFrac.length && residual > 0; j++) {
        values[byFrac[j].i]++;
        residual--;
      }
      values[STAT_INDEX.spe] = SP_CAP_PER_STAT;
      redistributeOverflow(values, weights, lockedIndices);
      return arrayToSpread(values);
    }
  }

  const totalW = effectiveWeights.reduce((a, b) => a + b, 0);
  const raw = effectiveWeights.map((w) => (w / totalW) * SP_BUDGET_TOTAL);
  const values = raw.map(Math.floor);
  let residual = SP_BUDGET_TOTAL - sumArr(values);

  const byFrac = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v), w: effectiveWeights[i] }))
    .filter((entry) => !lockedIndices.has(entry.i))
    .sort((a, b) => b.frac - a.frac || b.w - a.w);
  let idx = 0;
  while (residual > 0 && byFrac.length > 0) {
    values[byFrac[idx % byFrac.length].i] += 1;
    residual -= 1;
    idx += 1;
  }

  redistributeOverflow(values, weights, lockedIndices);
  return arrayToSpread(values);
}

// Crossover: for each stat, inherit from parent A or B with equal probability.
// If the combined sum exceeds budget, proportionally scale down before the usual
// cap/redistribute pass. `lockedIndices` (FIX 1): both parents should already be
// 0 there, but locked indices are still force-zeroed and excluded from the
// residual fixup loop as a hard guarantee, not just an assumption about parents.
function crossover(parentSpA, parentSpB, weights, lockedIndices = EMPTY_LOCKED) {
  const a = spreadToArray(parentSpA);
  const b = spreadToArray(parentSpB);
  let values = a.map((v, i) => (Math.random() < 0.5 ? v : b[i]));
  for (const i of lockedIndices) values[i] = 0;

  let sum = sumArr(values);
  if (sum > SP_BUDGET_TOTAL) {
    const scale = SP_BUDGET_TOTAL / sum;
    values = values.map((v) => Math.floor(v * scale));
    for (const i of lockedIndices) values[i] = 0;
    let residual = SP_BUDGET_TOTAL - sumArr(values);
    const descByWeight = STATS.map((_, i) => i).sort((x, y) => weights[y] - weights[x]).filter((i) => !lockedIndices.has(i));
    let idx = 0;
    while (residual !== 0 && idx < descByWeight.length * 4 && descByWeight.length > 0) {
      const i = descByWeight[idx % descByWeight.length];
      if (residual > 0 && values[i] < SP_CAP_PER_STAT) { values[i] += 1; residual -= 1; }
      else if (residual < 0 && values[i] > 0) { values[i] -= 1; residual += 1; }
      idx += 1;
    }
  }

  redistributeOverflow(values, weights, lockedIndices);
  return arrayToSpread(values);
}

// Mutation: perturb 1-3 randomly selected stats by an integer in [-8, +8], clamp
// to 0-32, then repair the total (subtract from lowest-weighted if over budget,
// top up the highest-weighted stats if under 60). `lockedIndices` (FIX 1): never
// selected for mutation and never a top-up target — stays at 0 through mutation.
function mutate(eliteSp, weights, lockedIndices = EMPTY_LOCKED) {
  const values = spreadToArray(eliteSp);
  for (const i of lockedIndices) values[i] = 0;
  const mutableIndices = STATS.map((_, i) => i).filter((i) => !lockedIndices.has(i));
  const numMutations = Math.min(1 + Math.floor(Math.random() * 3), mutableIndices.length);
  const indices = new Set();
  while (indices.size < numMutations) indices.add(mutableIndices[Math.floor(Math.random() * mutableIndices.length)]);
  for (const i of indices) {
    const delta = Math.floor(Math.random() * 17) - 8;
    values[i] = clamp(values[i] + delta, 0, SP_CAP_PER_STAT);
  }

  let sum = sumArr(values);
  if (sum > SP_BUDGET_TOTAL) {
    let over = sum - SP_BUDGET_TOTAL;
    const ascByWeight = STATS.map((_, i) => i).sort((a, b) => weights[a] - weights[b]);
    for (const i of ascByWeight) {
      if (over <= 0) break;
      const take = Math.min(values[i], over);
      values[i] -= take;
      over -= take;
    }
  }
  // FIX 2: removed the old "if sum < 60, top up the highest-weighted stats back
  // toward 66" branch. That was the real, verified root cause of HP being
  // treated as a mechanical dump stat: a mutation that happened to reduce total
  // SP got its budget silently refilled by ROLE_WEIGHT priority alone (usually
  // landing on HP for bulky roles, since HP typically carries the highest single
  // weight — 0.25-0.30 — in ROLE_WEIGHTS), with no check for whether that extra
  // SP actually cleared any real threshold. A candidate that legitimately spends
  // fewer than 66 SP (because the remaining points don't earn anything in
  // scoreSpread()) is now a valid, competing outcome the GA can converge to —
  // selection (not mechanical repair) decides whether more SP anywhere is worth
  // keeping, exactly as every other stat's investment is already decided.
  for (const i of lockedIndices) values[i] = 0;
  return arrayToSpread(values);
}

// Rank-weighted random pick: elites must already be sorted best-first. Weight is
// linear in rank (n - index), so the top elite is picked ~n times as often as
// the bottom one, without ever fully excluding lower-ranked elites.
function pickWeightedByRank(elites) {
  const n = elites.length;
  let r = Math.random() * ((n * (n + 1)) / 2);
  for (let i = 0; i < n; i++) {
    r -= (n - i);
    if (r <= 0) return elites[i];
  }
  return elites[n - 1];
}

// Phase C neighborhood: every combination of each stat +/-range from the elite
// (range is +/-5 for individual requests, +/-8 for team builds — FIX 3),
// subject to the 0-32 per-stat cap and (via early pruning) the 66 total budget.
// Pruning is exact and lossless: SP values are never negative, so once the
// running partial sum exceeds 66, no completion of the remaining stats can bring
// it back down — that branch is safely dropped. LOCAL_SEARCH_CAP_PER_ELITE bounds
// the (rarer) case where an elite has enough headroom that the pruned space is
// still very large. `lockedIndices` (FIX 1): a locked stat only ever tries d=0
// (stays at its already-0 base value) — Phase C refines around an elite without
// ever reintroducing SP into a stat the rest of the search keeps at 0.
function generateNeighborhood(baseSpread, cap = LOCAL_SEARCH_CAP_PER_ELITE, lockedIndices = EMPTY_LOCKED, range = LOCAL_SEARCH_RANGE) {
  const base = spreadToArray(baseSpread);
  const results = [];

  function rec(i, current, sum) {
    if (results.length >= cap) return;
    if (i === STATS.length) {
      results.push(current.slice());
      return;
    }
    if (lockedIndices.has(i)) {
      current.push(0);
      rec(i + 1, current, sum);
      current.pop();
      return;
    }
    for (let d = -range; d <= range; d++) {
      if (results.length >= cap) return;
      const v = base[i] + d;
      if (v < 0 || v > SP_CAP_PER_STAT) continue;
      const newSum = sum + v;
      if (newSum > SP_BUDGET_TOTAL) continue;
      current.push(v);
      rec(i + 1, current, newSum);
      current.pop();
    }
  }
  rec(0, [], 0);
  return results.map(arrayToSpread);
}

// Phase D tiebreaker only: count how many stats' invested SP is NOT sitting in a
// findBreakpoints() dead zone (0 investment is trivially "efficient").
function breakpointEfficiency(sp, pokemonRow, nature) {
  let efficient = 0;
  for (const key of STATS) {
    const spVal = sp[key] || 0;
    if (spVal === 0) { efficient++; continue; }
    const isHp = key === 'hp';
    const alignment = isHp ? 1.0 : natureMultiplierFor(nature, key);
    const wasted = findBreakpoints(pokemonRow[key], alignment, isHp);
    if (!wasted.includes(spVal)) efficient++;
  }
  return efficient;
}

// FIX 1: lock the "wrong" offensive stat to 0 SP for the entire search — a
// slow_bulky_support locks BOTH Atk and SpA (no offensive investment at all);
// every other role locks whichever of Atk/SpA is NOT this Pokemon's stronger
// attacking stat (same atk-vs-spa tie-break convention already used by
// item_optimizer.js's isPhysicalLeaning() — atk >= spa -> physical). This is
// genuinely new functionality: verified live before this fix that no
// locked-stat mechanism existed anywhere in this file (only a soft ROLE_WEIGHTS
// bias, never a hard zero).
function determineLockedIndices(role, pokemonRow) {
  const locked = new Set();
  if (role === 'slow_bulky_support') {
    locked.add(STAT_INDEX.atk);
    locked.add(STAT_INDEX.spa);
    return locked;
  }
  if (pokemonRow.atk >= pokemonRow.spa) locked.add(STAT_INDEX.spa);
  else locked.add(STAT_INDEX.atk);
  return locked;
}

/**
 * findOptimalSpread(pokemon, nature, role, threatMatrix, metaContext, evObservations, item, teamBuild)
 * Runs the full genetic search (Phase A init -> Phase B evolution -> Phase C local
 * search -> Phase D tiebreak) and returns the top 5 spreads with full scoring
 * detail, plus run stats (duration, unique spreads evaluated). `item` (optional)
 * is threaded straight through to every scoreSpread() call — see spread_scorer.js
 * for how Choice Scarf/Assault Vest/Life Orb/Leftovers actually affect scoring.
 * `teamBuild` (FIX 3, default false): POST /api/team/build passes true for a
 * deeper search (300 candidates/60 generations/±8 Phase C range vs. the
 * individual-request defaults of 200/40/±5) — worker_threads parallelism
 * (evolutionary_worker.js) already isolates the extra per-Pokemon cost onto its
 * own OS thread, so this doesn't change individual /api/recommend/evs timing.
 */
async function findOptimalSpread(pokemon, nature, role, threatMatrix, metaContext, evObservations, item, teamBuild = false, seeds = null, fieldOpts) {
  const startTime = Date.now();
  const weights = ROLE_WEIGHTS[role] || ROLE_WEIGHTS.fast_offense;
  const lockedIndices = determineLockedIndices(role, pokemon);
  const popInit = teamBuild ? TEAM_BUILD_POP_INIT : POP_INIT;
  const generations = teamBuild ? TEAM_BUILD_GENERATIONS : GENERATIONS;
  const localSearchRange = teamBuild ? TEAM_BUILD_LOCAL_SEARCH_RANGE : LOCAL_SEARCH_RANGE;

  const scoreCache = new Map(); // JSON(sp) -> numeric score, dedups identical spreads within this run

  async function scoreCandidate(candidate) {
    const key = JSON.stringify(candidate.sp);
    if (scoreCache.has(key)) {
      candidate.score = scoreCache.get(key);
      return;
    }
    const result = await scoreSpread(pokemon, candidate.sp, nature, role, threatMatrix, metaContext, Object.assign({}, { item }, fieldOpts ? { fieldOpts } : {}));
    scoreCache.set(key, result.score);
    candidate.score = result.score;
  }

  async function scoreUnscored(population) {
    let count = 0;
    for (const c of population) {
      if (c.score === undefined) {
        await scoreCandidate(c);
        count++;
        if (count % 25 === 0) await yieldToEventLoop();
      }
    }
  }

  // PHASE A — Nerd of Now seeded initialization + role-guided random fill
  let population = [];
  const nerdSeeds = seeds !== null ? seeds : (await getNerdOfNowSets(pokemon.name));
  let seededCount = 0;
  if (nerdSeeds && nerdSeeds.length > 0) {
    for (const set of nerdSeeds) {
      if (!set.sp) continue;
      // Apply locked stat constraints to the seed (zero out locked stats)
      const seedSp = clampSpread({ ...set.sp });
      for (const idx of lockedIndices) seedSp[STATS[idx]] = 0;
      POST_VALIDATION_HOOK(seedSp);
      population.push({ sp: seedSp, _seedLabel: set.label || 'Nerd of Now' });
      seededCount++;
    }
  }
  const remaining = Math.max(0, popInit - seededCount);
  for (let i = 0; i < remaining; i++) {
    const candidate = generateCandidate(weights, lockedIndices, role, pokemon);
    POST_VALIDATION_HOOK(candidate);
    population.push({ sp: candidate });
  }
  if (seededCount > 0) {
    logger.info(`Nerd of Now seeding: ${seededCount} seed(s) added for ${pokemon.name}`, {
      seeds: nerdSeeds.map(s => s.label || 'unnamed').join(', '),
    });
  }

  let bestScore = -Infinity;
  let stagnation = 0;

  // PHASE B — evolutionary search
  for (let gen = 0; gen < generations; gen++) {
    await scoreUnscored(population);
    await yieldToEventLoop();

    population.sort((a, b) => b.score - a.score);
    const elites = population.slice(0, ELITES);

    if (elites[0].score > bestScore + 1e-9) {
      bestScore = elites[0].score;
      stagnation = 0;
    } else {
      stagnation++;
    }

    const next = [...elites];

    for (let i = 0; i < CROSSOVER_COUNT; i++) {
      const a = pickWeightedByRank(elites);
      const b = pickWeightedByRank(elites);
      const c = crossover(a.sp, b.sp, weights, lockedIndices);
      POST_VALIDATION_HOOK(c);
      next.push({ sp: c });
    }
    for (let i = 0; i < MUTATION_COUNT; i++) {
      const e = pickWeightedByRank(elites);
      const m = mutate(e.sp, weights, lockedIndices);
      POST_VALIDATION_HOOK(m);
      next.push({ sp: m });
    }

    if (gen > 0 && gen % DIVERSITY_INJECTION_EVERY === 0) {
      for (let i = 0; i < DIVERSITY_INJECTION_SIZE; i++) {
        const d = generateCandidate(weights, lockedIndices);
        POST_VALIDATION_HOOK(d);
        next.push({ sp: d });
      }
    }
    if (stagnation >= STAGNATION_LIMIT) {
      for (let i = 0; i < STAGNATION_INJECTION_SIZE; i++) {
        const d = generateCandidate(weights, lockedIndices);
        POST_VALIDATION_HOOK(d);
        next.push({ sp: d });
      }
      stagnation = 0;
    }

    population = next;
  }

  await scoreUnscored(population);
  population.sort((a, b) => b.score - a.score);

  // PHASE C — local exhaustive (pruned/bounded) search around the top 5
  const top5 = population.slice(0, 5);
  const localCandidates = [];
  for (const elite of top5) {
    for (const sp of generateNeighborhood(elite.sp, LOCAL_SEARCH_CAP_PER_ELITE, lockedIndices, localSearchRange)) {
      const key = JSON.stringify(sp);
      if (scoreCache.has(key)) continue;
      POST_VALIDATION_HOOK(sp);
      localCandidates.push({ sp });
    }
  }
  await scoreUnscored(localCandidates);
  await yieldToEventLoop();

  // Merge, dedupe by exact spread, keep best score per unique spread.
  const byKey = new Map();
  for (const c of [...population, ...localCandidates]) {
    const key = JSON.stringify(c.sp);
    if (!byKey.has(key) || byKey.get(key).score < c.score) byKey.set(key, c);
  }
  let deduped = [...byKey.values()];

  // PHASE D — tiebreaker only, applied after full score-based sort
  deduped.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    return breakpointEfficiency(b.sp, pokemon, nature) - breakpointEfficiency(a.sp, pokemon, nature);
  });

  const top = deduped.slice(0, 5);

  // FIX 4: For fast roles with base Speed >= 90, ensure speed is at 32 in the
  // best candidate. If the top candidate has speed < 32, create a variant with
  // speed pinned to 32 (taking 1 SP from the lowest-weighted non-offensive stat)
  // and score it — if it scores higher or comparable, replace the top candidate.
  const isFastRole = role === 'fast_offense' || role === 'fast_support';
  const hasHighBaseSpeed = pokemon && pokemon.spe >= FAST_ROLE_SPEED_FIRST_THRESHOLD;
  if (isFastRole && hasHighBaseSpeed && !lockedIndices.has(STAT_INDEX.spe) && top[0]) {
    const bestSp = top[0].sp;
    if ((bestSp.spe || 0) < SP_CAP_PER_STAT) {
      // Create speed-32 variant
      const variant = { ...bestSp, spe: SP_CAP_PER_STAT };
      // Take 1 SP from lowest-weighted non-offensive stat that has SP to give
      const nonOffensiveStats = STATS.filter((s, i) =>
        i !== STAT_INDEX.spe && !lockedIndices.has(i) && s !== 'atk' && s !== 'spa' && (variant[s] || 0) > 0
      );
      nonOffensiveStats.sort((a, b) => {
        const wi = STATS.indexOf(a), wj = STATS.indexOf(b);
        return weights[wi] - weights[wj];
      });
      if (nonOffensiveStats.length > 0) {
        variant[nonOffensiveStats[0]] = (variant[nonOffensiveStats[0]] || 0) - 1;
        POST_VALIDATION_HOOK(variant);
        // Score the variant
        const variantScore = await scoreSpread(pokemon, variant, nature, role, threatMatrix, metaContext, { item, fieldOpts });
        // If variant scores within 5% of the best, use it (speed tie-breaking is critical)
        if (variantScore.score >= top[0].score * 0.95) {
          top[0] = { sp: variant, score: variantScore.score };
        }
      }
    }
  }

  // Detailed re-score (thresholds_met/thresholds_missed) only for the final top 5
  // — building that breakdown for every candidate evaluated during the search
  // would be wasted work (see scoreSpread's `options.detailed`).
  const spreads = [];
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const detail = await scoreSpread(pokemon, c.sp, nature, role, threatMatrix, metaContext, Object.assign({}, { detailed: true, item }, fieldOpts ? { fieldOpts } : {}));
    spreads.push({
      rank: i + 1,
      sp: c.sp,
      total_sp: sumArr(spreadToArray(c.sp)),
      final_stats: detail.final_stats,
      score: c.score,
      thresholds_met: detail.thresholds_met,
      thresholds_missed: detail.thresholds_missed,
    });
  }

  // SP MINIMIZATION: checks which stats have attributed thresholds and removes
  // SP from stats with no threshold (unspendable). Leftover SP redistributed by
  // role (see minimizeSpread in spread_scorer.js).
  if (spreads.length > 0 && teamBuild) {
    const topSpread = spreads[0];
    try {
      const minimResult = await minimizeSpread(pokemon, topSpread.sp, nature, role, threatMatrix, metaContext, item, fieldOpts);
      topSpread.sp = clampSpread(minimResult.minimized_sp);
      POST_VALIDATION_HOOK(topSpread.sp);
      topSpread.total_sp = sumArr(spreadToArray(topSpread.sp));
      topSpread.final_stats = minimResult.final_stats;
      topSpread.thresholds_met = minimResult.thresholds_met;
      topSpread.minimization = {
        reductions: minimResult.reductions,
        redistributed: minimResult.redistributed,
        total_leftover: minimResult.total_leftover,
      };
    } catch (err) {
      // Minimization failure is non-fatal — keep the un-minimized spread
    }
  }

  return {
    spreads,
    seeds_used: seededCount > 0
      ? nerdSeeds.map((s) => ({ label: s.label || 'Nerd of Now', sp: { ...s.sp }, source_name: s.source_name || null }))
      : [],
    run_stats: {
      duration_ms: Date.now() - startTime,
      unique_spreads_evaluated: scoreCache.size,
      generations,
      population_init: popInit,
      team_build: teamBuild,
      locked_stats: [...lockedIndices].map((i) => STATS[i]),
      sp_observations: evObservations ?? null,
    },
  };
}

module.exports = {
  findOptimalSpread,
  determineLockedIndices,
  generateCandidate,
  crossover,
  mutate,
  generateNeighborhood,
  validateSpread,
  ROLE_WEIGHTS,
  POP_INIT,
  GENERATIONS,
};
