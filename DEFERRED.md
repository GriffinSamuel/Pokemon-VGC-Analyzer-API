# Deferred findings

Findings that were investigated, understood, and deliberately not fixed.
Each is a project-owner decision, not an oversight. CLAUDE.md's "Known
Issues" carries one-line summaries of the ones that affect reading output;
this file carries why each was left alone and what the fix would involve.

Do not start any of these without an explicit decision. Verify any number
here against the database before restating it — several are dated.

Updated 2026-08-27 after a full build pass (see logs/BRIEF_current_pass.md /
logs/PROGRESS_current_pass.md for the session record, not committed —
logs/ is gitignored). Items resolved that session are removed below, with
the resolving commit named.

## RESOLVED this session

- **`cron.schedule()` at module load** (`serebii.js`) — fixed in `af2b1ce`.
  Moved into an exported `startScheduler()`, called only from `app.js`'s
  `require.main === module` block.
- **Unseeded GA** (`spread_optimizer.js`) — fixed in `8485a28`. Seeded
  mulberry32 PRNG, one instance per `findOptimalSpread()` call. Verified
  same-process and fresh-process runs now produce byte-identical output.
  `ev_optimizer.js`'s `evolutionaryCache` was confirmed to be a pure speed
  cache (replays a prior result, doesn't influence what a fresh computation
  produces) — left unchanged.
- **`move_recommendations.json` retrain** — regenerated (`train_moves.py`,
  not committed — `src/ml/models/` is gitignored). Result changed less than
  expected: 182 -> 184 species keys, top moves for spot-checked species
  (garchomp/venusaur/raichu-mega-y) byte-identical to the stale July file.
  The dataset itself hadn't materially changed since the July retrain.
- **`candidateProfile()` blends mutually exclusive builds**, and its
  **Mega-forms-with-no-item** sub-case — fixed in `8c57378`. Replaced the
  four independent argmaxes with staged, conditional composition over a
  single joint source. `check_set_coherence.js` (rewritten in the same
  commit to exercise the real code path) now reports 0 of 123 checked
  species composing a set nobody ever played, down from 38 of 129.
  Chandelure-Mega and Crabominable-Mega now correctly compose with their
  Mega stone instead of `@(none)`.

## 1. `isNonstandard` species gate — mechanism fixed, neither original case unblocked
`seed_learnsets.js`'s gate (`if (!species.exists || species.isNonstandard) continue;`)
was fixed in `6116a3c`: an isNonstandard species is now seeded IF observed in
`tournament_teams`. The blast radius was much larger than expected — ALL 90
Mega-evolution forms are ALSO `isNonstandard: 'Past'` in `@pkmn/dex` (Mega
Evolution doesn't exist in modern gens), so the old gate silently excluded
every Mega form's learnset too. The fix added `pokemon_moves` coverage for
62 Mega forms with real observed usage (+5429 rows; verified none of the 62
have zero observed rows).

Neither of the two cases that motivated this fix actually got resolved,
for two different reasons:
- **Aegislash** (9 observed King's Shield rows): dex resolution is clean
  (exists in `Dex.species.all()`, own learnset has King's Shield) but
  Aegislash has **no row in the `pokemon` table at all** — see #3 below.
  `seedLearnsets`'s `if (!pokemonId) continue` still skips it regardless of
  the gate.
- **Floette-Eternal-Mega** (167 observed Light of Ruin rows): does not
  appear in `Dex.species.all()` at all. `Dex.species.get('Floette-Eternal-Mega')`
  silently fuzzy-matches to `Floette-Mega` — an unrelated real Pokemon
  (base Floette's Mega, not Floette-Eternal's). Neither that species nor
  the literal query's own learnset lookup contains Light of Ruin. No
  dex-supported species this legitimately resolves to — cannot be seeded
  without fabricating a learnset.

`check_learnset_coverage.js` confirms both King's Shield and Light of Ruin
still show `learnset_rows=0`. Fixing either needs separate work: a
`pokemon` row for Aegislash (see #3), and a real decision about how to
represent Floette-Eternal-Mega's moveset at all for Floette-Eternal-Mega.

## 2. `archetype_matchups.js`'s `buildArchetypeMeta()` — same 4-argmax defect, separate function
Discovered while scoping the `candidateProfile()` fix above: this function
(which composes the "key threats" shown in ARCHETYPE MATCHUPS / MATCHUP
ANALYSIS, via `entry.top_ability`/`top_item`/`top_moves`) has the identical
independent-argmax defect, plus a spread pulled from a separately-fetched
`getMostCommonSpread()` with no item/archetype conditioning at all. Not
fixed this session — `check_set_coherence.js`'s own doc comment and this
file's prior entry #3 (now resolved) both named `candidateProfile()`
specifically, and fixing this instance is a separate, larger refactor:
`entry.top_ability`/`top_item`/`top_moves` are read directly at ~15 call
sites across `buildBestTeamSet`, `buildExchangeGrid`, `calcThreatDamage`,
and others in `archetype_matchups.js`. No script currently audits this
function's output the way `check_set_coherence.js` now audits
`candidateProfile()`'s — would need one built first to have a target to fix
against.

## 3. Observed species missing from `pokemon` entirely
Refreshed numbers (`scripts/check_missing_species.js`, added this session):
220 species have >=1 observed `tournament_teams` row; 23 of those have no
`pokemon` table row (Aerodactyl 81 rows, Kangaskhan 27, Aegislash 14, the
two orphan buckets, Vanilluxe 8, then 17 more at 1-4 rows each). Of the
256-species legal `usage_stats` pool, 42 have no resolvable row via the
real production resolver (`getSpeciesRow()`, hyphen-stripping Mega fallback
included) — this is the exact figure and mechanism behind the report's "N
skipped for missing species data" bounds line (`archetype_swaps.js`'s
`buildPokemonSwaps()`, `profileMisses` counter). Aegislash (#1) is one
known case; Kangaskhan and Aerodactyl (both real, heavily-played) are two
more that only exist in the `pokemon` table as their `-Mega` form.

## 4. Heavy-recoil moves — tiebreak added, ban-list question still open
A recoil tiebreak was added this session (`ae0d3e0`) to
`searchPoolForOhko()`'s move comparison: when multiple candidate moves for
one Pokemon all clear the OHKO threshold, a non-recoil move now wins over
a recoil move regardless of raw damage percentage (recoil bought nothing
past 100%); a recoil move still wins when it's the sole path to the KO.
`RECOIL_MOVES` was also missing Light of Ruin entirely (confirmed via
`moves.flags->recoil` in the DB) despite 167 observed rows — added (0.50,
matching Head Smash). This closes the immediate "Light of Ruin must not be
blanket-excluded" concern, but the broader question — whether heavy-recoil
moves belong in the recommendation POOL at all, as opposed to just losing
ties against non-recoil alternatives — is still a format/design judgement,
not resolved here.

## 5. The ~133 mangled-id Mega rows — ACCEPTED / NO ACTION
Rows carrying a raw scraped `id` of `m`/`f` alongside a real name, rescued
at ingest by `normalizePokemonName`'s `MEGA_ITEM_MAP` branch. They are
correct downstream but the raw id is still garbage, which is why the orphan
repair had to key off an explicit `repairedFrom` marker rather than a value
predicate — see commit `89e8953`. Owner decision: leave as-is, the raw id
being ugly doesn't affect anything downstream.

## 6. `POST /api/team/build` Venusaur threshold-attribution test — pre-existing, exposed not caused this session
`src/tests/api.test.js`'s "Venusaur stat primaries are damage-ranked, and
hard hitters sit on Def/SpD not HP" test started failing during this
session's Phase 3 verification (90/91 passing, this the one failure).
Confirmed NOT caused by Phase 3/4's own changes — `threat_matrix.js` has no
`require()` path to `archetype_swaps.js` at all, so `candidateProfile()`'s
rewrite cannot reach Venusaur's own team-member build. Root cause: with the
GA now seeded (deterministic, see the resolved "Unseeded GA" item above),
Venusaur's own optimized spread lands on a case where the single hardest
threat (Froslass-Mega Blizzard, 99.5% max damage) is cited as both the HP
primary AND ties the SpD primary — so no Def/SpD primary strictly exceeds
HP's, the exact "absorbed into HP" pattern this regression test exists to
catch. This is a real, reproducible (now-deterministic) outcome, not
flakiness — but fixing it means touching `spread_scorer.js`'s
threshold/primary-attribution logic, which no phase of this session's brief
covered. Left as-is; flagged for an explicit decision.

## Standing cautions

- **Wall-clock time is not evidence.** One session measured 1028s -> 841s
  -> 282s for the same build with no code change between the last two, a
  ~3.6x spread (warm OS/Postgres caches is the plausible read).
- **A 0-byte or missing output file is not evidence of anything.** Check
  that a run finished before reading its output.
- **Verify a number before restating it.** Several figures inherited from
  earlier handoff docs did not reproduce (a "126 species" estimate was
  actually 129; an "87 observed pairs" comment was actually 81).
- **`check_undefined_calls.js` has a known false positive** on
  `serebii.js` (flags `runSerebiiScraper()` at a line number that doesn't
  match its actual call site) — confirmed present on unmodified `git HEAD`
  before any changes, not a signal of a real problem.
