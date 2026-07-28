# Architecture Documentation Index

Read the relevant shard **before editing any file** in that subsystem.
Update the shard in the same session if your edit changes anything it documents.

---

| Shard | Summary |
|-------|---------|
| [ARCHITECTURE_overview.md](ARCHITECTURE_overview.md) | Module map (every file → responsibility → exports → consumers), key data flows (team build, damage calc, data pipeline) |
| [ARCHITECTURE_sp_system.md](ARCHITECTURE_sp_system.md) | Champions SP formula, stat calculation, spToEv boundary, caps (32/stat, 66 total), breakpoints, locked offensive stats, Nerd of Now seed conversion |
| [ARCHITECTURE_optimizer_pipeline.md](ARCHITECTURE_optimizer_pipeline.md) | 3-layer SP optimization: greedy thresholds (ev_optimizer), genetic algorithm (spread_optimizer), fitness function (spread_scorer), worker thread parallelism, threat matrix, observation data layer |
| [ARCHITECTURE_team_build.md](ARCHITECTURE_team_build.md) | POST /api/team/build end-to-end pipeline (7 phases), role classification, speed context, Trick Room viability, Nerd of Now seeded initialization, item optimizer, team compare/import |
| [ARCHITECTURE_damage_calc.md](ARCHITECTURE_damage_calc.md) | @smogon/calc usage, buildPokemon boundary, type chart, name normalization, Mega form resolution, damage cache, nerd_of_now_calc.js (standalone reference) |
| [ARCHITECTURE_data_pipeline.md](ARCHITECTURE_data_pipeline.md) | All 4 scrapers (Limitless, VGCPastes, stats, Serebii), DB schema (12 tables), seed script, connection pool, cron schedules |
| [ARCHITECTURE_ml_module.md](ARCHITECTURE_ml_module.md) | 7 Python files (data/db/features/registry + 3 training scripts), Node↔Python bridge, model outputs, training pipeline |
| [ARCHITECTURE_api_infrastructure.md](ARCHITECTURE_api_infrastructure.md) | Express server setup, route mounting, rate limiting, logging, retry, health monitoring, cache system, test infrastructure |
| [ARCHITECTURE_scoring_classification.md](ARCHITECTURE_scoring_classification.md) | Scoring system (TYPE_VALUES, aggression, speed-OHKO link), KO tier classification, speed comparison, Choice item restriction, recommendation output shapes |
| [ARCHITECTURE_inconsistencies.md](ARCHITECTURE_inconsistencies.md) | Inconsistency catalogue: 1 P0, 4 P1, 6 P2 issues — weather vocabulary duplication, nature modifiers triplication, species resolution inconsistency, and more |
| [ARCHITECTURE_conventions.md](ARCHITECTURE_conventions.md) | Format conventions (thresholds, spreads, Mega naming, item/ability strings, JSON responses), DB query patterns, file naming, test convention, cron convention |
