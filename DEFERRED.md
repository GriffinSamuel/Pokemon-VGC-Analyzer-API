# Deferred findings

Findings that were investigated, understood, and deliberately not fixed.
Each is a project-owner decision, not an oversight. CLAUDE.md's "Known
Issues" carries one-line summaries of the ones that affect reading output;
this file carries why each was left alone and what the fix would involve.

Do not start any of these without an explicit decision. Verify any number
here against the database before restating it — several are dated.

## 1. `cron.schedule()` at module load in `serebii.js:222`
Runs unconditionally when the module is required, not gated behind
`require.main === module` the way `runSerebiiScraper()`/`app.listen()` are
in `app.js`. Anything requiring `app.js` — including `team_output.js`'s
in-process boot — registers a scheduled job it never wants and then cannot
exit. Confirmed by isolated repro: `require('node-cron'); cron.schedule(...)`
alone hangs the process with zero handles shown by `process._getActiveHandles()`.
Agreed fix shape: move the call into an exported `startScheduler()`, called
only from `app.js`'s own `require.main === module` block. Gating it inside
`serebii.js` would be wrong — that disables the scrape when the server runs,
the one case that wants it. Deferred because it changes when the production
scrape registers.

## 2. `isNonstandard` species gate in `seed_learnsets.js`
`if (!species.exists || species.isNonstandard) continue;` excludes any
dex-flagged non-standard species from `pokemon_moves` regardless of real
play. Aegislash (`'Past'`, 9 observed King's Shield rows) and
Floette-Eternal-Mega (resolves via `Dex.species.get()` to `Floette-Mega`,
`'Future'`, 167 observed Light of Ruin rows) get zero coverage. Same defect
class as commit `26531b3`, which re-cut a move classification by observation
for exactly this reason — fixed there at the move level, still open at the
species level. Deferred because the fix changes which species are legal in
the swap pool.

## 3. `candidateProfile()` blends mutually exclusive builds
Four independent argmaxes over item, ability, spread and moves can take each
field from a different real build. `check_set_coherence.js` flags 38 of 129
species where the composed item + 4 moves never appeared together in any
observed row. Venusaur (69 rows, 35 distinct real sets): Sleep Powder never
co-occurs with Life Orb across all 21 observed Life Orb rows — the item
comes from the aggressive build, the fourth move from the Focus Sash support
build. The check compares only item + all 4 moves, so 38 is a floor.
Correlates with MORE data, not less: the flagged list is led by the
best-sampled species. Fix is a real design choice — modal whole-set vs.
constrained per-field composition — not a patch.

## 4. Composed sets with no item, including Megas
Five of the 38 compose `@(none)`, two of them Mega forms
(`chandelure-mega`, `crabominable-mega`). A Mega form without its stone
cannot exist; the stone is what makes it that form. Distinct from #3 —
surfaced by the same script but a different failure. Adjacent to #7.

## 5. Unseeded GA and per-process cache
`spread_optimizer.js` uses bare `Math.random()`; ratings move roughly ±3
between runs on identical input, so rating diffs across runs prove nothing.
`ev_optimizer.js`'s `evolutionaryCache` is per-process. Any future
before/after comparison of ratings needs a seed first.

## 6. `move_recommendations.json` retrain
Dated 2026-07-16. Predates the toID learnset rebuild, the prevo-chain fix,
the orphan-species repair, and the stored move-name normalization. Whatever
it encodes was learned from data that no longer exists in that form.

## 7. The ~133 mangled-id Mega rows
Rows carrying a raw scraped `id` of `m`/`f` alongside a real name, rescued
at ingest by `normalizePokemonName`'s `MEGA_ITEM_MAP` branch. They are
correct downstream but the raw id is still garbage, which is why the orphan
repair had to key off an explicit `repairedFrom` marker rather than a value
predicate — see commit `89e8953`.

## 8. Observed species missing from `pokemon` entirely
220 species have >=1 observed `tournament_teams` row against a 256-species
legal pool (`usage_stats`), and the archetype bounds line reports 42 skipped
per run "for missing species data". Nobody has counted the actual overlap.
Aegislash (#2) is one known case.

## 9. Heavy-recoil ban list
Light of Ruin carries 50% recoil. Whether moves at that recoil level belong
in the recommendation pool at all is a format/design judgement, not a bug.

## Standing cautions

- **Wall-clock time is not evidence.** One session measured 1028s -> 841s
  -> 282s for the same build with no code change between the last two, a
  ~3.6x spread (warm OS/Postgres caches is the plausible read). Do not
  upgrade #1 from "consistent with" to "the cause of" the runtime symptom
  on a before/after timing alone.
- **A 0-byte or missing output file is not evidence of anything.** Check
  that a run finished before reading its output.
- **Verify a number before restating it.** Several figures inherited from
  earlier handoff docs did not reproduce (a "126 species" estimate was
  actually 129; an "87 observed pairs" comment was actually 81).
