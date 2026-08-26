# 19 unresolved orphan rows

`scripts/repair_orphan_species.js --apply` resolved 315 of the 334 rows stranded under the
literal species `M`/`F` by the gender-marker parser bug (see `HANDOFF_data_integrity_step3.md`
Defect B, fixed in `parsePokemonBlock`). These 19 remain in the `m`/`f` buckets by design — the
script counts and reports them rather than guessing. Several are genuine evolutionary/species
ambiguities with real tournament usage on both sides; guessing would introduce wrong data with no
way to distinguish it from correct data later.

Row identity is `(team_id, array index)` into `tournament_teams.pokemon`. All other fields on
each row (item, ability, attacks, evs, nature) are original and untouched.

| Team | Idx | Bucket | Ability | Item | Attacks | Why unresolved |
|---|---|---|---|---|---|---|
| 5838 | 4 | M | Screen Cleaner | Never-Melt Ice | Freeze-Dry, Frost Breath, Charm, Fake Out | Ability "Screen Cleaner" matches no species in the `pokemon` table |
| 5853 | 1 | M | Prankster | Mental Herb | Light Screen, Skill Swap, Rain Dance, Sunny Day | Ability + moveset narrowed to Sableye vs. Meowstic — both real, both play this way |
| 5867 | 0 | F | Scrappy | Silk Scarf | Last Resort, Fake Out | Ability matched 3 species, none has both moves in its learnset |
| 5905 | 5 | F | Scrappy | Silk Scarf | Fake Out, Last Resort | Same as above |
| 5921 | 1 | F | Scrappy | Silk Scarf | Fake Out, Last Resort | Same as above |
| 5958 | 0 | F | Symbiosis | Sitrus Berry | Dazzling Gleam, Pollen Puff, Synthesis, Charm | Matched Flabébé/Floette/Florges; none has independent usage elsewhere |
| 5997 | 4 | F | Sweet Veil | Chople Berry | Dazzling Gleam | Narrowed to Tsareena vs. Alcremie — not a single confident answer |
| 6011 | 4 | M | Prankster | Light Clay | Foul Play, Fake Out, Reflect, Light Screen | Narrowed to **Sableye vs. Grimmsnarl** — real usage on both sides |
| 6028 | 0 | F | Scrappy | Silk Scarf | Fake Out, Last Resort | Same as 5867 |
| 5922 | 3 | F | Scrappy | Silk Scarf | Last Resort, Fake Out | Same as 5867 |
| 6054 | 0 | F | Scrappy | Silk Scarf | Fake Out, Last Resort | Same as 5867 |
| 5889 | 0 | F | Snow Warning | Never-Melt Ice | Blizzard, Weather Ball, Aurora Veil, Protect | Narrowed to **Ninetales-Alola vs. Abomasnow** — real usage on both sides |
| 5889 | 4 | F | Scrappy | Silk Scarf | Last Resort, Fake Out | Same as 5867 |
| 6125 | 2 | M | Lightning Rod | Focus Sash | Rain Dance, Fake Out, Endeavor, Thunderbolt | Narrowed to **Pikachu vs. Raichu** — real usage on both sides |
| 5843 | 0 | M | Justified | Life Orb | Rock Slide, Sucker Punch, Close Combat, Detect | Ability matched 9 species, none has all 4 moves in its learnset |
| 6177 | 3 | F | Scrappy | Silk Scarf | Last Resort, Fake Out | Same as 5867 |
| 6203 | 3 | F | Flower Veil | Choice Scarf | Moonblast, Dazzling Gleam, Energy Ball, Trick | Matched Floette/Florges; neither has independent usage elsewhere |
| 6205 | 2 | M | Chlorophyll | Focus Sash | Leaf Storm, Sludge Bomb, Sleep Powder, Protect | Narrowed to **Venusaur vs. Vileplume** — real usage on both sides |
| 5806 | 4 | M | Prankster | Roseli Berry | Spirit Break, Scratch, Fake Out, Parting Shot | Ability matched 17 species, none has all 4 moves in its learnset |

## Pattern notes

Full accounting, 8 + 6 + 1 + 2 + 2 = 19:

- **8 rows** are the same "Scrappy + Silk Scarf + Fake Out/Last Resort" set (5867, 5905, 5921,
  5922, 5889[4], 6028, 6054, 6177). **Checked directly and ruled out as a learnset hole**: only
  3 species carry Scrappy as ability1/2/hidden in the `pokemon` table — Decidueye-Hisui, Flamigo,
  Lopunny-Mega — and per `@pkmn/dex` (including Decidueye-Hisui's full prevo chain through
  Dartrix/Rowlet, already reflected in the rebuilt `pokemon_moves`), **none of the three can learn
  Fake Out or Last Resort at all**. This is not the Impidimp/Parting Shot pattern (a real
  prevo-inheritance gap) — there is no dex-supported species this could resolve to. Genuinely
  unresolvable by ability+moveset; left as-is correctly.
- **6 rows are genuine two-way species ties** with real, independent tournament usage on both
  candidates: Sableye/Meowstic (5853), Sableye/Grimmsnarl (6011), Ninetales-Alola/Abomasnow (5889[0]),
  Pikachu/Raichu (6125), Venusaur/Vileplume (6205), and Tsareena/Alcremie (5997, via Sweet Veil —
  previously miscategorized below with the zero-usage rows; it is a two-way tie like the other five).
- **1 row** (5838, "Screen Cleaner") has an ability that matches no species in the `pokemon` table
  at all — a data gap, not an ambiguity.
- **2 rows** are zero-independent-usage Fairy-line ties that never narrow past a multi-way ability
  match: 5958 (Symbiosis: Flabébé/Floette/Florges) and 6203 (Flower Veil: Floette/Florges).
- **2 rows** are ability-matched-but-moveset-unconfirmed gaps, not narrowed to any candidate list:
  5843 (Justified matched 9 species, none has all 4 observed moves) and 5806 (Prankster matched 17
  species, none has all 4 observed moves).

## Downstream impact

Anything reading the `m`/`f` species buckets after this repair is reading **19 rows of noise**,
down from 334. `check_screen_gates.js` confirms the `m` bucket now carries only 2 Light Screen +
1 Reflect (from row 6011 above, which is genuinely ambiguous between two real screen-setters) and
`f` carries 1 Aurora Veil (from row 5889[0], ambiguous between two real Aurora Veil setters). No
other move frequencies, spreads, or item picks are affected by these 19 remaining rows.

The Scrappy cluster was checked and is confirmed NOT a learnset hole (see Pattern notes above) —
this file's count stays at 19; it does not drop to 11. Had the dex check instead shown a genuine
gap, this file's Scrappy rows would move from "unresolved" to "resolvable, blocked on an upstream
`seed_learnsets.js` fix" and the file would need regenerating at 11 rows.
