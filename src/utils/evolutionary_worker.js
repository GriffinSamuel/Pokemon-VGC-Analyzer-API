const { parentPort, workerData } = require('worker_threads');
const { findOptimalSpread } = require('./spread_optimizer');

// Why this file exists: findOptimalSpread()'s genetic search (spread_optimizer.js
// -> spread_scorer.js) is genuinely CPU-bound — measured ~19s of real synchronous
// work per Pokemon (thousands of @smogon/calc calculate() calls; DB lookups inside
// spread_scorer.js are memoized after first use and are not the bottleneck). A
// plain Promise.all() over 6 of these in one JS thread does not run them
// concurrently — the event loop can't interleave synchronous CPU work, so 6 calls
// serialize to ~6x the single-Pokemon cost (verified live: ~115s for 6 vs ~19s for
// 1). Running each Pokemon's search in its own worker thread gives genuine
// OS-level parallelism instead, which is what POST /api/team/build needs to keep
// 6 searches under its ~30s budget. Only the team-build path (via
// ev_optimizer.js's getOrComputeEvolutionarySpread) uses this — the standalone
// GET /api/recommend/evs endpoint's existing fire-and-forget background trigger
// still calls findOptimalSpread() directly in-process, unchanged.
(async () => {
  const { pokemonRow, nature, role, threatMatrix, metaContext, observationCount, item, teamBuild, seeds, fieldOpts } = workerData;
  try {
    const result = await findOptimalSpread(pokemonRow, nature, role, threatMatrix, metaContext, observationCount, item, teamBuild, seeds, fieldOpts);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message, stack: err.stack });
  } finally {
    // Each worker thread gets its own module registry, so spread_scorer.js's
    // `require('../db/pool')` creates a brand new pg Pool local to this worker —
    // its open connections would otherwise keep the worker's event loop alive
    // indefinitely (pg keeps idle connections open), so it must be closed
    // explicitly before the worker script finishes.
    try { require('../db/pool').end(); } catch (_err) { /* already closed */ }
  }
})();
