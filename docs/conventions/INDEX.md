# Conventions Documentation Index

> **STRUCTURE** (call graph, dependencies, what-calls-what, impact radius) lives in the **graphify knowledge graph** — query it, do not hand-maintain module map here. These docs cover **CONVENTIONS, INTENT, and INVARIANTS only**.

---

Before editing any file:
1. For **STRUCTURE** (what calls what, dependencies, impact of change) — query the graphify knowledge graph. Do not grep or read files one-by-one to reconstruct structure.
2. For **CONVENTIONS, INTENT, and INVARIANTS** — consult this index and read the relevant `CONVENTIONS_*.md` doc.
3. Update the relevant `CONVENTIONS_*.md` in the same session if your edit changes a documented rule.

---

| Doc | Summary |
|-----|---------|
| [CONVENTIONS_sp_system.md](CONVENTIONS_sp_system.md) | SP formulas, caps (32/stat, 66 total), enforcement points, spToEv boundary, marginal-value guard, Focus Sash rule, locked offensive stats, fast-role speed-first allocation, SP minimization, unspendable SP, SCORER_VERSION, speed-OHKO link, death trap penalty |
| [CONVENTIONS_damage_calc.md](CONVENTIONS_damage_calc.md) | @smogon/calc usage, buildPokemon boundary, weather application order, Weather Ball rules, recoil convention, aggression multiplier, TYPE_VALUES, KO tier classification, verified-against-Nerd-of-Now standard, item/ability threading |
| [CONVENTIONS_format_output.md](CONVENTIONS_format_output.md) | Spread representation, threshold line format, Why block assembly, secondary interactions "[also:...]", speed section format, attacker build label, recoil text format, Mega naming, Weather Ball display, text output section ordering, JSON error format |
| [CONVENTIONS_inconsistencies.md](CONVENTIONS_inconsistencies.md) | 11 inconsistencies catalogued (1 P0, 4 P1, 6 P2) — species resolution, weather vocabulary triplication, nature modifiers, role classification duality, and more |
