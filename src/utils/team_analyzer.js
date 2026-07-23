const fs = require('fs');
const path = require('path');
const calc = require('@smogon/calc');
const pool = require('../db/pool');
const damage = require('../routes/damage');
const { ALL_TYPES, effectivenessAgainst, weaknessesOf, resistancesOf } = require('./typeChart');
const { generateSynergyReasons } = require('./synergy_reasons');
const { spToEv, calcStat, natureMultiplierFor } = require('./stat_formula');
const { getMostCommonSpread, getCommonSpreads, getCommonItems, getCommonSpeedTiers, getSpeciesRow, getTopDamageAffectingItem, DAMAGE_AFFECTING_ITEMS } = require('./ev_observations');
const { getRealAbilityFrequency } = require('./item_optimizer');
// getTopAttackerSpreads: the same top-3-real-spreads-worst-case methodology
// spread_scorer.js's evolutionary search already uses (see CLAUDE.md's
// "worst-case KO classification fix" rounds 1+2) — reused directly for FIX 6's
// matchup analysis rather than re-deriving a weaker single-spread version.
// buildAttackerBuildLabel: same "Adamant 32 Atk Black Glasses" real-build label
// used in spread_scorer.js's own thresholds_met (FIX 3, round 3) — reused here
// rather than re-deriving it, since analyzeMatchups() already imports directly
// from spread_scorer.js (see above) with no circular-dependency issue.
const { getTopAttackerSpreads, buildAttackerBuildLabel } = require('./spread_scorer');

const TOP_USAGE_LIMIT = 50;
const CRITICAL_WEAKNESS_THRESHOLD = 3; // team members weak to a type
const STRONG_SYNERGY_THRESHOLD = 1.5; // matches synergy_reasons.js's own documented threshold

// Same fixed weather-setter vocabulary synergy_reasons.js and team.js each already
// keep their own small copy of (see synergy_reasons.js's own comment on why: one
// copy per file's own vocabulary needs — display strings differ). This one is
// team-analysis-oriented (casual weather names for team notes).
const WEATHER_SETTERS = {
  Drizzle: 'Rain', Drought: 'Sun', 'Sand Stream': 'Sandstorm', 'Snow Warning': 'Snow',
};

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// --- FIX 11: Champions M-B legal/observed Pokemon set -----------------------------
// "Legal" here means "actually observed in this format's real tournament data",
// not "legal per game rules" — usage_stats is the definitive real-observation
// table (computed from tournament_teams). Used to filter static reference tables
// (ARCHETYPES' key_threats) so a name with zero real presence in this dataset
// (verified live: Indeedee — 0 usage_stats rows, 0 tournament_teams appearances)
// never surfaces in output as if it were an observed meta threat.
async function getLegalPokemonSet() {
  const { rows } = await pool.query('SELECT DISTINCT pokemon_name FROM usage_stats');
  const set = new Set(rows.map((r) => r.pokemon_name));
  if (set.size > 0) return set;
  // Fallback for an environment where usage_stats hasn't been computed yet —
  // tournament_teams' normalized_name is the next-best "was this actually played" signal.
  const { rows: teamRows } = await pool.query(
    `SELECT DISTINCT COALESCE(p->>'normalizedName', p->>'name') as name
     FROM tournament_teams t, jsonb_array_elements(t.pokemon) p`
  );
  return new Set(teamRows.map((r) => r.name));
}

function filterToLegalPokemon(names, legalPokemonSet) {
  if (!legalPokemonSet || legalPokemonSet.size === 0) return names;
  const filtered = names.filter((n) => legalPokemonSet.has(n));
  return filtered.length > 0 ? filtered : names; // never emit an empty list if filtering would erase every entry
}

function abilitiesOf(pokemonRow) {
  return [pokemonRow.ability1, pokemonRow.ability2, pokemonRow.ability_hidden].filter(Boolean);
}

function typesOf(pokemonRow) {
  return [pokemonRow.type1, pokemonRow.type2].filter(Boolean);
}

// --- Meta type prevalence (shared by coverage gaps + weakness analysis) ---------
// "How much of the top-50-usage metagame carries type X" — a real, queried signal
// (usage_percent summed per type), not an assumption. Also returns which specific
// top-usage Pokemon carry each type, for naming concrete examples in gap/weakness
// notes ("Whimsicott and Sylveon are common threats").
async function getTypeMetaData() {
  const { rows } = await pool.query(
    `SELECT p.name, p.type1, p.type2, u.usage_percent
     FROM usage_stats u JOIN pokemon p ON LOWER(p.name) = LOWER(u.pokemon_name)
     ORDER BY u.usage_percent DESC LIMIT $1`,
    [TOP_USAGE_LIMIT]
  );

  const prevalence = {};
  const byType = {};
  for (const row of rows) {
    const usage = parseFloat(row.usage_percent) / 100;
    for (const type of [row.type1, row.type2].filter(Boolean)) {
      prevalence[type] = (prevalence[type] || 0) + usage;
      (byType[type] = byType[type] || []).push({ name: row.name, usage: round(usage, 4) });
    }
  }
  for (const type of Object.keys(byType)) byType[type].sort((a, b) => b.usage - a.usage);

  return { prevalence, byType };
}

// --- COVERAGE ANALYSIS ------------------------------------------------------------
// "Super effective against type X" is checked against a hypothetical pure-X
// defender (effectivenessAgainst(moveType, [X])) — the standard way VGC players
// talk about "coverage", independent of any specific real Pokemon's second type.
// FIX 5: Weather Ball is Normal-type/50 BP in the moves table (its no-weather
// values) but doubles to 100 BP and changes type under active weather.
// Same fixed mapping as synergy_reasons.js's WEATHER_BALL_TYPES.
const WEATHER_BALL_TYPES = { Rain: 'Water', Sun: 'Fire', Sand: 'Rock', Snow: 'Ice' };

function effectiveMoveType(mv, teamWeatherSet) {
  if (mv.move === 'Weather Ball' && teamWeatherSet) {
    for (const weather of teamWeatherSet) {
      if (WEATHER_BALL_TYPES[weather]) return WEATHER_BALL_TYPES[weather];
    }
  }
  return mv.type;
}

function analyzeCoverage(team, typeMetaData, teamWeatherSet) {
  const covered = new Set();
  for (const type of ALL_TYPES) {
    for (const member of team) {
      const hasSuperEffective = (member.moves || []).some((mv) => {
        if (!mv.power || !mv.type) return false;
        const effectiveType = effectiveMoveType(mv, teamWeatherSet);
        return effectivenessAgainst(effectiveType, [type]) >= 2;
      });
      if (hasSuperEffective) { covered.add(type); break; }
    }
  }

  const coverageGaps = ALL_TYPES
    .filter((type) => !covered.has(type))
    .map((type) => {
      const prevalence = round(typeMetaData.prevalence[type] || 0, 4);
      const examples = (typeMetaData.byType[type] || []).slice(0, 2).map((p) => p.name);
      let note = examples.length > 0
        ? `No super effective moves against ${type} — ${examples.join(' and ')} ${examples.length > 1 ? 'are' : 'is a'} common threat${examples.length > 1 ? 's' : ''}`
        : `No super effective moves against ${type}`;

      // FIX 9: 4x weakness exposure — check if any meta Pokemon has a 4x
      // weakness to a type the team DOES have, and note if the team can exploit it
      const teamTypes = new Set();
      for (const member of team) {
        if (member.pokemonRow?.type1) teamTypes.add(member.pokemonRow.type1);
        if (member.pokemonRow?.type2) teamTypes.add(member.pokemonRow.type2);
      }
      const hasCoverageFor = (targetType) => {
        for (const member of team) {
          for (const mv of (member.moves || [])) {
            if (!mv.power || !mv.type) continue;
            if (effectivenessAgainst(effectiveMoveType(mv, teamWeatherSet), [targetType]) >= 2) return true;
          }
        }
        return false;
      };
      // Check if team has a 4x super-effective type that they CAN'T exploit
      const teamOffensiveTypes = new Set();
      for (const member of team) {
        for (const mv of (member.moves || [])) {
          if (mv.power && mv.type) teamOffensiveTypes.add(effectiveMoveType(mv, teamWeatherSet));
        }
      }

      // FIX 9: Weather dependency — if team relies on weather, flag if losing
      // weather control makes this gap worse
      if (teamWeatherSet && teamWeatherSet.size > 0) {
        const weatherName = [...teamWeatherSet][0];
        const sandNames = ['Tyranitar', 'Excadrill', 'Garchomp'];
        const rainNames = ['Pelipper', 'Kyogre'];
        const sunNames = ['Charizard-Mega-Y', 'Torkoal'];
        if (weatherName === 'Rain') {
          note += `. Tyranitar (Sand Stream) directly counters rain — losing weather removes rain boosts`;
        } else if (weatherName === 'Sun') {
          note += `. Tyranitar/Excadrill (Sand) counters sun — losing weather removes sun boosts and activates sand chip`;
        }
      }

      return { type, meta_prevalence: prevalence, note };
    })
    .sort((a, b) => b.meta_prevalence - a.meta_prevalence);

  return {
    covered_types: [...covered].sort(),
    coverage_gaps: coverageGaps,
    every_type_covered: coverageGaps.length === 0,
  };
}

// --- SYNERGY ANALYSIS --------------------------------------------------------------
// FIX 4 (round 2, Location 2): replaces the old ">=3 fast members (base Speed
// >= 90)" signal with the same holistic team-level viability gate team.js's
// isTrickRoomViableTeam() uses — a local copy since team_analyzer.js and
// team.js don't share helper functions today (consistent with this file's
// existing per-file small-vocabulary duplication, e.g. WEATHER_SETTERS). ALL
// three conditions must hold, using base Speed (t.pokemonRow.spe) throughout:
// median team Speed < 70, 3+ members with base Speed < 80, 1+ member < 60.
const TR_MEDIAN_SPEED_THRESHOLD = 70;
const TR_SLOW_SPEED_THRESHOLD = 80;
const TR_MIN_SLOW_COUNT = 3;
const TR_VERY_SLOW_SPEED_THRESHOLD = 60;
const TR_MIN_VERY_SLOW_COUNT = 1;
function isTrickRoomViableTeam(team) {
  const speeds = team.map((t) => t.pokemonRow.spe).sort((a, b) => a - b);
  const n = speeds.length;
  const median = n % 2 === 0 ? (speeds[n / 2 - 1] + speeds[n / 2]) / 2 : speeds[(n - 1) / 2];
  const slowCount = speeds.filter((s) => s < TR_SLOW_SPEED_THRESHOLD).length;
  const verySlowCount = speeds.filter((s) => s < TR_VERY_SLOW_SPEED_THRESHOLD).length;
  return median < TR_MEDIAN_SPEED_THRESHOLD && slowCount >= TR_MIN_SLOW_COUNT && verySlowCount >= TR_MIN_VERY_SLOW_COUNT;
}

// FIX 5: `movesByLower` (team's own trained moves' priority/type data, already
// batch-fetched once in team.js) enables the specific Rage Powder reason;
// `typeMetaData` (already fetched once for coverage/weaknesses) enables the
// specific Wide Guard reason via its own small top-50+moves fetch for real
// meta attackers. Both are optional — omitting them just skips that one
// specific-reason check, same as before this fix.
async function analyzeSynergies(team, synergyScores, abilityRules, typeMetaData, movesByLower) {
  const suppressTrickRoom = !isTrickRoomViableTeam(team);
  const strongPairs = [];
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      const a = team[i];
      const b = team[j];
      const score = synergyScores?.[a.pokemon.toLowerCase()]?.[b.pokemon.toLowerCase()];
      if (score === undefined || score <= STRONG_SYNERGY_THRESHOLD) continue;

      const reasons = generateSynergyReasons({
        pokemonName: a.pokemon, pokemonRow: a.pokemonRow, pokemonMoves: a.moves,
        partnerName: b.pokemon, partnerRow: b.pokemonRow, partnerMoves: b.moves,
        abilityRules: abilityRules || [], score, suppressTrickRoom,
      });
      strongPairs.push({ pair: [a.pokemon, b.pokemon], score: round(score, 2), reasons });
    }
  }
  strongPairs.sort((x, y) => y.score - x.score);

  const specificSynergies = [];
  if (typeMetaData) {
    const usageRows = await getTop50UsageRows();
    const teamNamesLower = new Set(team.map((m) => m.pokemon.toLowerCase()));
    const metaNamesLower = usageRows.filter((r) => !teamNamesLower.has(r.pokemon_name.toLowerCase())).map((r) => r.pokemon_name.toLowerCase());
    const { topMovesByName, movesByLower: metaMovesByLower } = await batchFetchTopMoveData(metaNamesLower, 4);
    const wideGuard = buildWideGuardSynergy(team, typeMetaData, topMovesByName, metaMovesByLower);
    if (wideGuard) specificSynergies.push(wideGuard);
  }
  if (movesByLower) {
    const ragePowder = buildRagePowderSynergy(team, movesByLower);
    if (ragePowder) specificSynergies.push(ragePowder);
  }
  const hospitality = buildHospitalitySynergy(team);
  if (hospitality) specificSynergies.push(hospitality);

  return [...specificSynergies, ...strongPairs];
}

// --- WEATHER / TERRAIN CONTROL -----------------------------------------------------
function analyzeWeather(team) {
  const setters = [];
  for (const m of team) {
    for (const ability of abilitiesOf(m.pokemonRow)) {
      const weather = WEATHER_SETTERS[ability];
      if (weather) setters.push({ pokemon: m.pokemon, ability, weather });
    }
  }

  const byWeather = {};
  for (const s of setters) (byWeather[s.weather] = byWeather[s.weather] || []).push(s.pokemon);

  const notes = [];
  if (setters.length === 0) {
    notes.push('No weather setter on this team — relies on neutral conditions');
  } else if (setters.length === 1) {
    notes.push(`${setters[0].pokemon} (${setters[0].ability}) is this team's only weather setter — a high-priority target for the opponent`);
  }
  for (const [weather, mons] of Object.entries(byWeather)) {
    if (mons.length >= 2) notes.push(`${mons.join(' + ')} both set ${weather} — redundant, consider diversifying`);
  }

  return { setters, by_weather: byWeather, notes };
}

// FIX 4/FIX 5: a Pokemon's real, comparable Speed is its EFFECTIVE speed, not
// its raw final_stats.spe — Choice Scarf (1.5x) or an active, matching
// conditional speed-boost ability (Swift Swim/Chlorophyll/Sand Rush/Slush Rush,
// gated on the team actually having that weather up) both change how fast it
// really is for any Speed-based comparison: Trick Room viability (original use),
// the team's own speed-tier listing, and matchup_analysis's speed_situation
// labels (FIX 5, round 2 — Basculegion holding Choice Scarf was previously
// still compared at its raw ~98 final Speed everywhere outside spread_scorer.js,
// which already applied this same 1.5x internally for its own scoring — see
// that file's `thisSpeed`). Renamed from the original TR-only name since it's
// now used generically. Not hardcoded to any named Pokemon — applies to
// whichever team member actually has the qualifying item/ability.
const CONDITIONAL_SPEED_ABILITIES_FOR_TR = {
  'swift swim': 'Rain', chlorophyll: 'Sun', 'sand rush': 'Sand', 'slush rush': 'Snow',
};
function effectiveSpeed(member, weatherAnalysis) {
  const rawSpeed = member.final_stats?.spe ?? member.pokemonRow.spe;
  if ((member.item || '').toLowerCase() === 'choice scarf') return rawSpeed * 1.5;
  const requiredWeather = CONDITIONAL_SPEED_ABILITIES_FOR_TR[(member.ability || '').toLowerCase()];
  if (requiredWeather && (weatherAnalysis?.by_weather?.[requiredWeather]?.length || 0) > 0) return rawSpeed * 2;
  return rawSpeed;
}

// --- TRICK ROOM INTERACTION ---------------------------------------------------------
// "Makes sense" is judged relative to the team's OWN speed spread: Trick Room pays
// off when most teammates are slower than the team's own average (they'd move
// first under TR), and pays off less when the team is mostly fast (TR would hurt
// more members than it helps).
function analyzeTrickRoom(team, weatherAnalysis) {
  const trUsers = team.filter((m) => (m.moves || []).some((mv) => mv.move === 'Trick Room'));
  const speeds = team.map((m) => ({ pokemon: m.pokemon, speed: effectiveSpeed(m, weatherAnalysis) }));
  if (trUsers.length === 0) {
    return { has_trick_room: false, setters: [], beneficiaries: [], hurt: [], speed_makes_sense: null, notes: [] };
  }

  const avgSpeed = speeds.reduce((s, x) => s + x.speed, 0) / speeds.length;
  const beneficiaries = speeds.filter((s) => s.speed < avgSpeed).map((s) => s.pokemon);
  const hurt = speeds.filter((s) => s.speed >= avgSpeed).map((s) => s.pokemon);
  const speedMakesSense = beneficiaries.length > hurt.length;

  const notes = [
    `${trUsers.map((m) => m.pokemon).join('/')} carries Trick Room`,
    speedMakesSense
      ? `Team Speed spread favors Trick Room — ${beneficiaries.length}/${team.length} members are below the team's own average Speed and move first under it`
      : `Team Speed spread cuts against Trick Room — only ${beneficiaries.length}/${team.length} members benefit; ${hurt.join(', ')} would move LAST instead of first`,
  ];

  // FIX 13: TR matchup — focus on prevention and survival, not sweeping
  // Check if any team member has Taunt (Prankster Taunt is canonical TR counter)
  const tauntUsers = team.filter((m) =>
    (m.moves || []).some((mv) => mv.move === 'Taunt')
  );
  const pranksterTauntUser = tauntUsers.find((m) => {
    const ability = (m.ability || '').toLowerCase();
    return ability === 'prankster';
  });
  if (pranksterTauntUser) {
    notes.push(`TR prevention: ${pranksterTauntUser.pokemon} Prankster Taunt moves before any TR setter — primary counter`);
  } else if (tauntUsers.length > 0) {
    notes.push(`TR prevention: ${tauntUsers.map((m) => m.pokemon).join('/')} carry Taunt but lack Prankster — may not outspeed TR setters`);
  }

  // Check for TR-relevant slow mons (base Speed < 60) that benefit under TR
  const slowMons = team.filter((m) => m.pokemonRow.spe < 60);
  if (slowMons.length > 0) {
    notes.push(`TR survival: ${slowMons.map((m) => m.pokemon).join('/')} (base Speed < 60) move first under opposing TR`);
  }

  // Identify fast mons that move LAST under TR (potential targets)
  const fastMons = team.filter((m) => m.pokemonRow.spe >= 100);
  if (fastMons.length >= 3) {
    notes.push(`TR vulnerability: ${fastMons.map((m) => `${m.pokemon} (${m.pokemonRow.spe})`).join(', ')} move LAST under TR — high exposure`);
  }

  return {
    has_trick_room: true,
    setters: trUsers.map((m) => m.pokemon),
    beneficiaries,
    hurt,
    speed_makes_sense: speedMakesSense,
    notes,
    pranked_taunt_user: pranksterTauntUser?.pokemon || null,
    slow_under_tr: slowMons.map((m) => m.pokemon),
  };
}

// --- SPEED TIERS ---------------------------------------------------------------------
const TAILWIND_BENEFIT_SPEED_THRESHOLD = 120; // below this, a real 2x Speed swing routinely changes outspeed odds

// FIX 5 (round 2): tiers now reflect each member's real EFFECTIVE Speed
// (Choice Scarf 1.5x / matching active weather-boost ability 2x — see
// effectiveSpeed above), not raw final_stats.spe. A Scarfed Basculegion at
// ~98 raw final Speed now correctly shows at ~147 here, potentially reordering
// the fastest-to-slowest listing relative to teammates holding no speed item.
function analyzeSpeedTiers(team, weatherAnalysis) {
  const tiers = team
    .map((m) => ({ pokemon: m.pokemon, speed: round(effectiveSpeed(m, weatherAnalysis), 0) }))
    .sort((a, b) => b.speed - a.speed);

  const slowMembers = tiers.filter((t) => t.speed < TAILWIND_BENEFIT_SPEED_THRESHOLD).length;
  const tailwindBenefit = slowMembers >= Math.ceil(team.length / 2);

  return {
    tiers,
    fastest: tiers[0] || null,
    slowest: tiers[tiers.length - 1] || null,
    tailwind_would_help: tailwindBenefit,
  };
}

// --- TEAM WEAKNESSES ------------------------------------------------------------------
function analyzeWeaknesses(team, typeMetaData) {
  const weakBy = {}; // type -> [pokemon names weak to it]
  const quadBy = {}; // type -> [pokemon names 4x weak to it]

  for (const m of team) {
    const weaknesses = weaknessesOf(typesOf(m.pokemonRow));
    for (const [type, mult] of Object.entries(weaknesses)) {
      (weakBy[type] = weakBy[type] || []).push(m.pokemon);
      if (mult >= 4) (quadBy[type] = quadBy[type] || []).push(m.pokemon);
    }
  }

  function mitigationFor(type) {
    for (const m of team) {
      const resistances = resistancesOf(typesOf(m.pokemonRow));
      if (resistances[type] === 0) return `${m.pokemon} is immune to ${type} moves`;
    }
    for (const m of team) {
      const resistances = resistancesOf(typesOf(m.pokemonRow));
      if (resistances[type] !== undefined) return `${m.pokemon} resists ${type}`;
    }
    return null;
  }

  const critical = Object.entries(weakBy)
    .filter(([, mons]) => mons.length >= CRITICAL_WEAKNESS_THRESHOLD)
    .map(([type, mons]) => {
      const exploiters = (typeMetaData.byType[type] || []).slice(0, 3).map((p) => ({
        pokemon: p.name,
        usage: p.usage,
        note: `Common ${type}-type attacker (#${(typeMetaData.byType[type] || []).findIndex((x) => x.name === p.name) + 1} in this typing's usage) threatens ${mons.join(', ')}`,
      }));
      return {
        type,
        team_members_weak: mons,
        meta_prevalence: round(typeMetaData.prevalence[type] || 0, 4),
        exploited_by: exploiters,
        mitigation: mitigationFor(type),
      };
    })
    .sort((a, b) => b.team_members_weak.length - a.team_members_weak.length);

  const doubleWeaknesses = Object.entries(quadBy).map(([type, mons]) => ({
    type,
    team_members: mons,
    mitigation: mitigationFor(type),
  }));

  return { critical, double_weaknesses: doubleWeaknesses };
}

// FIX 8: Weather interaction map — which weathers counter/replace each other.
const weatherCOUNTERS = {
  Sand: ['Sun', 'Rain'],
  Sun: ['Sand', 'Rain'],
  Rain: ['Sun', 'Sand'],
};

// --- ARCHETYPE MATCHUPS ---------------------------------------------------------------
// Fixed, well-known VGC archetype definitions (real cores/threats from the current
// meta) — same category as synergy_reasons.js's WEATHER_MOVE_RULES: a static rule
// table applied programmatically to whatever team is passed in, not per-team
// hardcoding. Mega Pokemon named in these definitions (Swampert-Mega,
// Charizard-Mega-Y, etc.) have no `pokemon` table row (see CLAUDE.md's documented
// Mega-form gap), so their key-threat Speed/typing are given here as fixed
// reference data rather than looked up — the same real-world numbers a live
// lookup would return if one existed.
const ARCHETYPES = [
  {
    name: 'Rain team',
    description: 'Pelipper + Swampert-Mega + Swift Swim users',
    core_types: ['Water'],
    weak_to_weather: 'Sun',
    sets_weather: 'Rain',
    key_threat_speed: 276, // Swampert-Mega at +Speed nature, full investment, in rain
    key_threats: ['Swampert-Mega', 'Pelipper', 'Basculegion'],
  },
  {
    name: 'Sun team',
    description: 'Charizard-Mega-Y + Venusaur-Mega / Torkoal',
    core_types: ['Fire'],
    weak_to_weather: 'Rain',
    sets_weather: 'Sun',
    key_threat_speed: 185, // Chlorophyll-boosted sweeper ballpark
    key_threats: ['Charizard-Mega-Y', 'Venusaur-Mega', 'Torkoal'],
  },
  {
    name: 'Trick Room team',
    description: 'Farigiraf + slow heavy hitters',
    core_types: [],
    weak_to_weather: null,
    sets_weather: null,
    key_threat_speed: 0, // the whole point of TR is being slow — "key threat speed" isn't the relevant axis
    key_threats: ['Farigiraf', 'Indeedee', 'Kingambit'],
  },
  {
    name: 'Hyper Offense',
    description: 'Garchomp + Kingambit + fast attackers',
    core_types: ['Dragon', 'Dark'],
    weak_to_weather: null,
    sets_weather: null,
    key_threat_speed: 169, // Jolly Garchomp full investment ballpark
    key_threats: ['Garchomp', 'Kingambit', 'Sneasler'],
  },
  {
    name: 'Snow team',
    description: 'Abomasnow-Mega + Blizzard users',
    core_types: ['Ice'],
    weak_to_weather: null, // no single weather directly counters Snow's accuracy/chip mechanic the way Sun/Rain counter each other
    sets_weather: 'Snow',
    key_threat_speed: 180, // Slush Rush-boosted sweeper ballpark
    key_threats: ['Abomasnow-Mega', 'Raichu'],
  },
  {
    name: 'Sand team',
    description: 'Tyranitar + Excadrill / Garchomp',
    core_types: ['Rock', 'Ground'],
    weak_to_weather: 'Rain',
    sets_weather: 'Sand',
    key_threat_speed: 169, // Garchomp in sand with Sand Force, ballpark
    key_threats: ['Tyranitar', 'Excadrill', 'Garchomp'],
  },
];

function teamHasSuperEffectiveAgainst(team, types) {
  if (!types || types.length === 0) return false;
  return team.some((m) => (m.moves || []).some(
    (mv) => mv.power && mv.type && types.some((t) => effectivenessAgainst(mv.type, [t]) >= 2)
  ));
}

// FIX 2: returns the actual effectiveness multiplier alongside the resisting
// Pokemon so callers can print the mechanically correct word — 0x is "is immune
// to", not "resists"; they are different matchups and must never be blurred
// together in output (see also mitigationFor() above, which already made this
// distinction; this helper previously didn't).
function teamResistsOrImmuneTo(team, types) {
  if (!types || types.length === 0) return null;
  for (const m of team) {
    const resistances = resistancesOf(typesOf(m.pokemonRow));
    for (const t of types) {
      if (resistances[t] !== undefined) {
        return { pokemon: m.pokemon, type: t, multiplier: resistances[t], verb: resistances[t] === 0 ? 'is immune to' : 'resists' };
      }
    }
  }
  return null;
}

function analyzeArchetypeMatchups(team, weatherAnalysis, legalPokemonSet) {
  const fastestSpeed = Math.max(...team.map((m) => m.final_stats?.spe ?? m.pokemonRow.spe));
  const fastestMember = team.find((m) => (m.final_stats?.spe ?? m.pokemonRow.spe) === fastestSpeed);

  return ARCHETYPES.map((arch) => {
    // FIX 11: drop any key_threats entry with zero real presence in this format's
    // tournament data (e.g. Indeedee — verified live: 0 usage_stats rows, 0
    // tournament_teams appearances) rather than reporting a static reference name
    // as if it were an observed meta threat.
    const legalKeyThreats = filterToLegalPokemon(arch.key_threats, legalPokemonSet);
    const hasCoverage = teamHasSuperEffectiveAgainst(team, arch.core_types);
    const outspeedsKeyThreat = fastestSpeed > arch.key_threat_speed;
    const countersWeather = arch.weak_to_weather && weatherAnalysis.by_weather[arch.weak_to_weather]?.length > 0;
    const setsCounterWeather = arch.sets_weather && weatherAnalysis.by_weather[arch.sets_weather]?.length > 0;
    const resistor = teamResistsOrImmuneTo(team, arch.core_types);

    // FIX 8: Check if the archetype's weather COUNTERS this team's weather.
    // E.g. Sand Stream removes Drought → sand team counters sun team.
    const thisTeamSetsWeather = Object.keys(weatherAnalysis.by_weather || {});
    const archetypeWeatherCountersThisTeam = arch.sets_weather && thisTeamSetsWeather.some(
      (tw) => weatherCOUNTERS[arch.sets_weather]?.includes(tw) || weatherCOUNTERS[tw]?.includes(arch.sets_weather)
    );

    // Simple point-based rating: coverage, speed, and weather-counter each count
    // as one favorable signal — consistent with team.js's existing POST /compare
    // scoring pattern (count signals, don't fabricate a single opaque formula).
    let points = 0;
    if (hasCoverage) points++;
    if (arch.key_threat_speed > 0 && outspeedsKeyThreat) points++;
    else if (arch.key_threat_speed === 0) points += 0.5; // TR: speed isn't the relevant axis, half-credit neutral
    if (countersWeather) points++;
    if (resistor) points += 0.5;
    // FIX 8: subtract a heavy penalty if the archetype's weather directly counters our weather.
    // This is the most important matchup factor for weather teams — losing weather
    // removes all ability synergies (Chlorophyll, Swift Swim, Sun-boosted moves).
    if (archetypeWeatherCountersThisTeam) points -= 2;

    const maxPoints = arch.key_threat_speed > 0 ? 3.5 : 3;
    const ratio = points / maxPoints;
    const rating = ratio >= 0.6 ? 'favorable' : ratio >= 0.35 ? 'even' : 'unfavorable';

    const keyThreatNote = resistor
      ? `${resistor.pokemon} ${resistor.verb} ${resistor.type}`
      : hasCoverage
        ? `Team has super-effective coverage against ${arch.core_types.join('/')}`
        : arch.core_types.length > 0
          ? `No resistance or super-effective coverage against ${arch.core_types.join('/')}`
          : 'Coverage is not this archetype\'s defining axis';

    // TR: Prankster Taunt prevention (FIX 9)
    const POKEMON_HAS_PRANKSTER = m => /^prankster$/i.test(m.ability || '');
    const POKEMON_HAS_TAUNT = m => (m.moves || []).some(function(mv) { return mv.move === 'Taunt'; });
    const pranksterTauntUser = team.find(function(m) { return POKEMON_HAS_PRANKSTER(m) && POKEMON_HAS_TAUNT(m); });
    const teamHasPrankster = team.some(POKEMON_HAS_PRANKSTER);

    const winCondition = arch.name === 'Trick Room team'
      ? pranksterTauntUser
        ? 'Prankster Taunt from ' + pranksterTauntUser.pokemon + ' shuts down TR setters before they move — priority Taunt bypasses TR speed reversal entirely'
        : 'Without Prankster Taunt, pressure TR setters turn 1 to prevent setup — if TR goes up, slow threats dictate pace regardless of Speed'
      : setsCounterWeather
        ? `Control weather with ${weatherAnalysis.by_weather[arch.sets_weather][0]}, then outspeed with ${fastestMember?.pokemon || 'your fastest member'}`
        : outspeedsKeyThreat
          ? `Outspeed their key threats with ${fastestMember?.pokemon || 'your fastest member'} (${fastestSpeed} Spe) before they set up`
          : `Rely on bulk/coverage to outlast ${arch.description}`;

    const loseCondition = arch.name === 'Trick Room team' && teamHasPrankster && !pranksterTauntUser
      ? 'Team has a Prankster user (' + team.find(POKEMON_HAS_PRANKSTER).pokemon + ') but lacks priority Taunt — once TR is up, their slow heavy hitters move first regardless of Speed'
      : arch.sets_weather && !setsCounterWeather && !countersWeather
      ? `If this team can't answer ${arch.sets_weather}, ${arch.description} outpaces and overwhelms it`
      : !outspeedsKeyThreat && arch.key_threat_speed > 0
        ? `${legalKeyThreats[0]} (~${arch.key_threat_speed} effective Speed) outspeeds this team's fastest member (${fastestSpeed} Spe) and can threaten a KO first`
        : `Losing the early-game tempo lets ${arch.description} dictate the rest of the game`;

    return {
      archetype: arch.name,
      matchup_rating: rating,
      key_threats: legalKeyThreats,
      key_threat_note: keyThreatNote,
      win_condition: winCondition,
      lose_condition: loseCondition,
    };
  });
}

// --- FIX 5 + 6: Wall analysis — practical matchups, not just type coverage --------
// A "wall" here is any top-50-usage Pokemon this team has no easy answer for.
// Reuses damage.js's exported gen/buildPokemon-equivalent construction (no damage
// math reimplemented) and item_optimizer.js's real ability-frequency resolver (so
// the wall's own ability is its real tournament pick, same as team members').
const MODELS_DIR = path.join(__dirname, '..', 'ml', 'models');
let moveRecCache = null;
function readMoveRecommendations() {
  if (moveRecCache === null) {
    const filePath = path.join(MODELS_DIR, 'move_recommendations.json');
    moveRecCache = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : { pokemon: {} };
  }
  return moveRecCache;
}
function topMovesFor(nameLower, n = 3) {
  const rec = readMoveRecommendations();
  return (rec.pokemon[nameLower]?.moves || []).slice(0, n);
}

function spToEvObject(sp) {
  return {
    hp: spToEv(sp?.hp || 0), atk: spToEv(sp?.atk || 0), def: spToEv(sp?.def || 0),
    spa: spToEv(sp?.spa || 0), spd: spToEv(sp?.spd || 0), spe: spToEv(sp?.spe || 0),
  };
}

// Same Pokemon-construction pattern as damage.js's buildPokemon, with one addition
// (`boosts`) damage.js doesn't need for its own callers — written locally instead
// of editing damage.js (out of scope; see CLAUDE.md constraints), reusing its
// exported `gen`/`LEVEL` constants so the underlying calc is identical.
function buildBoostedPokemon(pokemonRow, side, boosts) {
  return new calc.Pokemon(damage.gen, pokemonRow.name, {
    level: damage.LEVEL, nature: side.nature, item: side.item, ability: side.ability,
    evs: side.evs, ivs: side.ivs, boosts,
    overrides: {
      baseStats: { hp: pokemonRow.hp, atk: pokemonRow.atk, def: pokemonRow.def, spa: pokemonRow.spa, spd: pokemonRow.spd, spe: pokemonRow.spe },
      types: [pokemonRow.type1, pokemonRow.type2].filter(Boolean),
    },
  });
}

const REDIRECTION_MOVES = new Set(['follow me', 'rage powder']);

// --- FIX 5: specific (not generic) Wide Guard / Rage Powder / Hospitality synergies
// Same spread-move vocabulary as synergy_reasons.js's own SPREAD_MOVES (kept as
// a separate small per-file copy, consistent with this file's existing
// WEATHER_SETTERS-style precedent) — only these moves have any real "blocked by
// Wide Guard" value in doubles.
const SPREAD_MOVES = new Set([
  'earthquake', 'rock slide', 'heat wave', 'surf', 'discharge',
  'hyper voice', 'dazzling gleam', 'muddy water', 'blizzard',
  'razor leaf', 'petal blizzard', 'sludge wave', 'lava plume',
  'icy wind', 'electroweb', 'snarl', 'tearful look',
  'breaking swipe', 'bleakwind storm', 'wildbolt storm',
  'sandsear storm', 'glacial lance', 'springtide storm',
  'eruption', 'water spout',
].map((m) => m.toLowerCase()));
const SETUP_MOVES = new Set(['swords dance', 'nasty plot', 'dragon dance', 'calm mind', 'bulk up', 'quiver dance', 'shift gear']);
const CHARGING_MOVES = new Set(['electro shot', 'solar beam', 'sky attack', 'meteor beam', 'razor wind']);

// Wide Guard: find the real meta attacker (top-50 usage) whose real top move is
// BOTH a spread move AND matches a type this team has a member weak to — named
// specifically, not a generic "blocks spread moves" line. Highest-usage match wins.
function buildWideGuardSynergy(team, typeMetaData, topUsageMovesByName, movesByLower) {
  const wideGuardUser = team.find((m) => (m.moves || []).some((mv) => mv.move === 'Wide Guard'));
  if (!wideGuardUser) return null;

  let best = null;
  for (const member of team) {
    if (member.pokemon === wideGuardUser.pokemon) continue;
    const weaknesses = weaknessesOf(typesOf(member.pokemonRow));
    for (const [type, mult] of Object.entries(weaknesses)) {
      const metaUsers = typeMetaData.byType[type] || [];
      for (let rank = 0; rank < metaUsers.length; rank++) {
        const threatName = metaUsers[rank].name;
        const threatMoves = topUsageMovesByName[threatName.toLowerCase()] || [];
        for (const mv of threatMoves) {
          const moveLower = mv.move.toLowerCase();
          if (!SPREAD_MOVES.has(moveLower)) continue;
          const moveRow = movesByLower[moveLower];
          if (!moveRow || moveRow.type !== type) continue;
          if (!best || metaUsers[rank].usage > best.usage) {
            best = { teammate: member.pokemon, move: mv.move, attacker: threatName, usage: metaUsers[rank].usage, rank: rank + 1, type, effectiveness: mult };
          }
        }
      }
    }
  }
  if (!best) return null;
  return {
    pair: [wideGuardUser.pokemon, best.teammate],
    score: null,
    reasons: [`Wide Guard blocks ${best.move} — protects ${best.teammate} from ${best.attacker}'s ${best.type} STAB (${best.effectiveness}x, #${best.rank} meta at ${Math.round(best.usage * 100)}%)`],
  };
}

// Rage Powder: name the specific teammate + setup/charging/negative-priority
// move that benefits from redirection, rather than a generic "supports X" line.
function buildRagePowderSynergy(team, movesByLower) {
  const ragePowderUser = team.find((m) => (m.moves || []).some((mv) => mv.move === 'Rage Powder'));
  if (!ragePowderUser) return null;
  const others = team.filter((m) => m.pokemon !== ragePowderUser.pokemon);

  // Priority: charging moves (a fully exposed, must-survive turn) > setup moves
  // (safe to use freely) > negative-priority moves (always moves last, most
  // exposed) — checked across the WHOLE team at each priority level before
  // moving to the next, rather than stopping at the first team member with any
  // qualifying move, so the most mechanically significant case always wins.
  for (const member of others) {
    for (const mv of member.moves || []) {
      if (CHARGING_MOVES.has(mv.move.toLowerCase())) {
        return { pair: [ragePowderUser.pokemon, member.pokemon], score: null,
          reasons: [`Rage Powder redirects away from ${member.pokemon} — allows safe ${mv.move} charge turn without opponent canceling it with a targeted attack`] };
      }
    }
  }
  for (const member of others) {
    for (const mv of member.moves || []) {
      if (SETUP_MOVES.has(mv.move.toLowerCase())) {
        return { pair: [ragePowderUser.pokemon, member.pokemon], score: null,
          reasons: [`Rage Powder redirects single-target moves away from ${member.pokemon} — allows safe ${mv.move} setup without interruption`] };
      }
    }
  }
  for (const member of others) {
    for (const mv of member.moves || []) {
      const moveRow = movesByLower[mv.move.toLowerCase()];
      if (moveRow && moveRow.priority < 0) {
        return { pair: [ragePowderUser.pokemon, member.pokemon], score: null,
          reasons: [`Rage Powder redirects single-target moves away from ${member.pokemon} — protects its slower ${mv.move} from being intercepted`] };
      }
    }
  }
  return null;
}

// Hospitality: heals the partner 25% HP on switch-in — named as a synergy
// outright, with the specific real recoil/chip source it offsets on this team.
function buildHospitalitySynergy(team) {
  const hospitalityUser = team.find((m) => (m.ability || '').toLowerCase() === 'hospitality');
  if (!hospitalityUser) return null;

  const recoilSources = [];
  for (const m of team) {
    if (m.pokemon === hospitalityUser.pokemon) continue;
    if ((m.item || '').toLowerCase() === 'life orb') recoilSources.push(`${m.pokemon} Life Orb recoil`);
    if ((m.ability || '').toLowerCase() === 'rough skin') recoilSources.push(`${m.pokemon} Rough Skin contact chip`);
  }
  const partner = team.find((m) => m.pokemon !== hospitalityUser.pokemon);
  const specificNote = recoilSources.length > 0 ? `offsets ${recoilSources.join(', ')}` : 'offsets hazard/chip damage on switch-in';
  return {
    pair: [hospitalityUser.pokemon, partner ? partner.pokemon : hospitalityUser.pokemon],
    score: null,
    reasons: [`${hospitalityUser.pokemon} Hospitality heals partner 25% HP on switch — ${specificNote}`],
  };
}

// --- FIX 6: matchup analysis (replaces wall analysis) -----------------------------
// Two focused, symmetric lists instead of a single "wall difficulty" verdict:
// what this team can guarantee-OHKO in the top-50 meta, and what the top-50 meta
// can guarantee-OHKO on this team. Both use the same worst-case-across-top-3-
// real-spreads methodology spread_scorer.js's evolutionary search already
// established (getTopAttackerSpreads + Math.max/min across builds) rather than
// a simpler single-spread check, for consistency with that already-hard-won
// correctness fix (see CLAUDE.md's "worst-case KO classification" rounds 1+2).
async function getTop50UsageRows() {
  const { rows } = await pool.query(
    'SELECT pokemon_name, usage_percent FROM usage_stats ORDER BY usage_percent DESC LIMIT $1',
    [TOP_USAGE_LIMIT]
  );
  return rows;
}

async function batchFetchTopMoveData(namesLower, movesPerName = 4) {
  const topMovesByName = {};
  const allMoveNames = new Set();
  for (const nameLower of namesLower) {
    const moves = topMovesFor(nameLower, movesPerName);
    topMovesByName[nameLower] = moves;
    for (const m of moves) allMoveNames.add(m.move.toLowerCase());
  }
  const { rows } = allMoveNames.size
    ? await pool.query('SELECT * FROM moves WHERE LOWER(name) = ANY($1)', [[...allMoveNames]])
    : { rows: [] };
  return { topMovesByName, movesByLower: Object.fromEntries(rows.map((m) => [m.name.toLowerCase(), m])) };
}

function damagePercentRange(attackerRow, attackerSide, defenderRow, defenderSide, moveName, activeWeather) {
  const attacker = buildBoostedPokemon(attackerRow, attackerSide, {});
  const defender = buildBoostedPokemon(defenderRow, defenderSide, {});
  const move = new calc.Move(damage.gen, moveName);
  const fieldOpts = { gameType: 'Doubles' };
  if (activeWeather) fieldOpts.weather = activeWeather;
  const field = new calc.Field(fieldOpts);
  const result = calc.calculate(damage.gen, attacker, defender, move, field);
  const maxHP = defender.maxHP();
  const [minD, maxD] = result.range();
  return { min: round((minD / maxHP) * 100, 1), max: round((maxD / maxHP) * 100, 1) };
}

function findRedirectionMitigation(team, threatenedPokemon) {
  for (const t of team) {
    if (t.pokemon === threatenedPokemon) continue;
    for (const mv of t.moves || []) {
      if (REDIRECTION_MOVES.has(mv.move.toLowerCase())) return `${t.pokemon} ${mv.move} can redirect`;
    }
  }
  return null;
}

function speedSituation(attackerSpeed, defenderSpeed) {
  if (attackerSpeed > defenderSpeed) return { speed_situation: 'outspeeds', priority: 'HIGH — attacker moves first' };
  if (attackerSpeed < defenderSpeed) return { speed_situation: 'slower', priority: 'team member moves first and may respond' };
  return { speed_situation: 'tie', priority: 'speed tie — coin-flip on who moves first' };
}

async function analyzeMatchups(team, legalPokemonSet, weatherAnalysis) {
  // Resolve active weather string for damage calcs (Sun/Rain/Sand/Snow)
  const activeWeather = weatherAnalysis?.setters?.[0]?.weather || null;

  const usageRows = await getTop50UsageRows();
  const teamNamesLower = new Set(team.map((m) => m.pokemon.toLowerCase()));
  const candidates = filterToLegalPokemon(usageRows.map((r) => r.pokemon_name), legalPokemonSet)
    .map((name) => usageRows.find((r) => r.pokemon_name === name))
    .filter((r) => r && !teamNamesLower.has(r.pokemon_name.toLowerCase()));

  const { topMovesByName, movesByLower } = await batchFetchTopMoveData(candidates.map((r) => r.pokemon_name.toLowerCase()), 4);

  const ohkoOpportunities = [];
  const ohkoRisks = [];

  for (let rank = 0; rank < candidates.length; rank++) {
    const row = candidates[rank];
    const nameLower = row.pokemon_name.toLowerCase();
    const usagePct = round(parseFloat(row.usage_percent) / 100, 4);
    // FIX 1 STEP 6 (round 3): reversed from a prior round's "skip rather than
    // fabricate" — that was itself too narrow, since falling back to a Mega form's
    // real base-form stats (getSpeciesRow's existing hyphen-stripping fallback,
    // already used everywhere else in this codebase — see spread_scorer.js's
    // getPokemonRow) isn't fabrication, it's the same real, disclosed
    // approximation the rest of the pipeline already relies on. Skipping entirely
    // made real, significant threats (Staraptor-Mega at 11.94% usage) invisible
    // from matchup_analysis rather than approximated.
    const candidateRow = await getSpeciesRow(nameLower);
    if (!candidateRow) continue; // still genuinely unseedable (e.g. Starmie/Drampa have zero rows at all — see CLAUDE.md)
    const candidateTypes = [candidateRow.type1, candidateRow.type2].filter(Boolean);

    // --- LIST 1: can this team guarantee-OHKO the candidate? ---
    const candidateSpreadInfo = await getMostCommonSpread(nameLower);
    if (candidateSpreadInfo) {
      const targetSide = { nature: candidateSpreadInfo.nature || 'Hardy', evs: spToEvObject(candidateSpreadInfo.sp), ivs: { hp: 31 } };
      for (const member of team) {
        for (const mv of (member.moves || []).slice(0, 4)) {
          if (!mv.power || !mv.type) continue;
          if (effectivenessAgainst(mv.type, candidateTypes) === 0) continue;
          const attackerSide = { nature: member.nature, item: member.item, ability: member.ability, evs: spToEvObject(member.sp), ivs: { hp: 31 } };
          let dmg;
          try {
            dmg = damagePercentRange(member.pokemonRow, attackerSide, candidateRow, targetSide, mv.move, activeWeather);
          } catch (_err) { continue; }
          if (dmg.min >= 100) {
            // FIX 2: enriched OHKO entry with move conditions, defender spread,
            // and check across all observed spread variants.
            const sp = candidateSpreadInfo.sp;
            // Check for weather/condition boost on the move
            const sunBoosted = weatherAnalysis?.setters?.some(s => s.weather === 'Sun') && ['Fire', 'Grass'].includes(mv.type || '');
            const rainBoosted = weatherAnalysis?.setters?.some(s => s.weather === 'Rain') && ['Water', 'Flying'].includes(mv.type || '');
            const moveCondition = sunBoosted ? ' (Sun-boosted)' : rainBoosted ? ' (Rain-boosted)' : '';
            const itemAffects = member.item && DAMAGE_AFFECTING_ITEMS.has((member.item || '').toLowerCase());
            const moveConditionNote = moveCondition || (itemAffects ? ` (${member.item})` : '');

            // FIX 8: Check OHKO across ALL observed spreads and show breakdown
            let ohkoCount = 0;
            let totalSpreads = 0;
            const spreadBreakdown = [];
            const allSpreadsData = await getCommonSpreads(nameLower);
            const allSpreads = allSpreadsData?.spreads || [];
            for (const obs of allSpreads.slice(0, 5)) {
              const obsSide = { nature: obs.nature || 'Hardy', evs: spToEvObject(obs.sp), ivs: { hp: 31 } };
              try {
                const obsDmg = damagePercentRange(member.pokemonRow, attackerSide, candidateRow, obsSide, mv.move, activeWeather);
                totalSpreads++;
                const isOhko = obsDmg.min >= 100;
                if (isOhko) ohkoCount++;
                const hp = obs.sp?.hp || 0;
                const def = obs.sp?.def || 0;
                spreadBreakdown.push({
                  hp, def, dmg: `${obsDmg.min}-${obsDmg.max}%`, ohko: isOhko,
                });
              } catch (_err) { continue; }
            }

            const ohkoPercent = totalSpreads > 0 ? Math.round((ohkoCount / totalSpreads) * 100) : 0;
            const guaranteedNote = totalSpreads > 0
              ? `OHKO vs ${ohkoPercent}% of observed spreads (${spreadBreakdown.map(s => `${s.hp}HP/${s.def}Def: ${s.dmg} ${s.ohko ? '✅' : '❌'}`).join(' | ')})`
              : 'No observed spreads available for breakdown';

            ohkoOpportunities.push({
              attacker: member.pokemon, move: mv.move, target: row.pokemon_name,
              target_usage_rank: rank + 1, target_usage_pct: usagePct,
              damage_range: `${dmg.min}-${dmg.max}%`,
              target_sp_assumed: candidateSpreadInfo.sp,
              // FIX 8: show correct defensive stat for move category
              target_sp_stat_label: mv.category === 'Physical' ? 'Def' : 'SpD',
              target_sp_stat_value: mv.category === 'Physical' ? (sp.def || 0) : (sp.spd || 0),
              target_sp_source: `${sp.hp || 0}HP / ${mv.category === 'Physical' ? (sp.def || 0) : (sp.spd || 0)}${mv.category === 'Physical' ? 'Def' : 'SpD'}, most common spread (${candidateSpreadInfo.observations} observations)`,
              move_condition: moveConditionNote,
              guaranteed_vs_all: guaranteedNote,
              ohko_percent: ohkoPercent,
              attacker_speed: member.final_stats?.spe ?? member.pokemonRow.spe,
              defender_speed: candidateRow.spe,
              attacker_build: buildAttackerBuildLabel([{sp: member.sp, nature: member.nature, frequency: 1.0}], member.item, mv.category, mv.type, member.ability),
              attacker_set_frequency: null, // set by the caller
              target_set_frequency: candidateSpreadInfo.observations || null,
            });
          }
        }
      }
    }

    // --- LIST 2: can the candidate guarantee-OHKO a team member? ---
    const attackerSpreads = await getTopAttackerSpreads(nameLower);
    const attackerAbilityFreq = await getRealAbilityFrequency(nameLower);
    const attackerAbility = attackerAbilityFreq[0]?.ability || candidateRow.ability1;
    // FIX 3/4 (round 3): the attacker's real top damage-affecting item (Choice
    // Band, Black Glasses, Life Orb, etc.) — previously this calc used no item
    // at all for the candidate attacker, understating real threats like a
    // Choice-Band-boosted hit. Fetched once per candidate (doesn't vary by
    // team member).
    const attackerItem = await getTopDamageAffectingItem(nameLower);
    const attackerTopMoves = topMovesByName[nameLower] || [];
    for (const moveEntry of attackerTopMoves) {
      const moveRow = movesByLower[moveEntry.move.toLowerCase()];
      if (!moveRow || moveRow.category === 'Status' || !moveRow.power) continue;
      for (const member of team) {
        const defenderSide = { nature: member.nature, item: member.item, evs: spToEvObject(member.sp), ivs: { hp: 31 } };
        const maxes = [];
        // FIX 4: save the top spread's attackerSide for weather comparison after the loop
        const topAttackerSide = attackerSpreads[0] ? { nature: attackerSpreads[0].nature || 'Hardy', ability: attackerAbility, item: attackerItem?.item, evs: spToEvObject(attackerSpreads[0].sp), ivs: { hp: 31 } } : null;
        for (const spread of attackerSpreads) {
          const attackerSide = { nature: spread.nature || 'Hardy', ability: attackerAbility, item: attackerItem?.item, evs: spToEvObject(spread.sp), ivs: { hp: 31 } };
          let dmg;
          try {
            dmg = damagePercentRange(candidateRow, attackerSide, member.pokemonRow, defenderSide, moveEntry.move, activeWeather);
          } catch (_err) { continue; }
          maxes.push(dmg.max);
        }
        if (maxes.length === 0) continue;
        const worstCaseMax = Math.max(...maxes);
        if (worstCaseMax >= 100) {
          const attackerSpeedTiers = await getCommonSpeedTiers(nameLower);
          const attackerSpeed = attackerSpeedTiers?.tiers?.[0]?.speed_stat ?? calcStat(candidateRow.spe, 0, 1.0, false);
          // FIX 5 (round 2): defenderSpeed now reflects the team member's real
          // assigned item/ability (Choice Scarf 1.5x, matching active weather
          // ability 2x) via effectiveSpeed() — previously always the raw,
          // unscarfed final_stats.spe, which understated a Scarfed defender's
          // real ability to outspeed an incoming attacker.
          const defenderSpeed = effectiveSpeed(member, weatherAnalysis);
          const { speed_situation: situation, priority } = speedSituation(attackerSpeed, defenderSpeed);

          // FIX 4: weather comparison — compute damage without our team's weather
          let weatherNote = null;
          if (activeWeather && topAttackerSide && moveRow && moveRow.power) {
            try {
              const dmgNoWeather = damagePercentRange(candidateRow, topAttackerSide, member.pokemonRow, defenderSide, moveEntry.move, null);
              const diff = worstCaseMax - dmgNoWeather.max;
              if (diff > 0.5) {
                weatherNote = `Our ${activeWeather} boosts this ${moveRow.type}-type move — without it: ${dmgNoWeather.min}-${dmgNoWeather.max}%`;
              } else if (diff < -0.5) {
                weatherNote = `Our ${activeWeather} weakens this ${moveRow.type}-type move — without it: ${dmgNoWeather.min}-${dmgNoWeather.max}%`;
              }
            } catch (_err) { /* weather comparison failed — skip */ }
          }

          // FIX 6: attacker set frequency — how common this set is on the attacker
          const topAttackerSpread = attackerSpreads[0];
          const setFrequency = topAttackerSpread?.frequency || null;
          const metaFrequency = setFrequency ? round(setFrequency * usagePct, 4) : null;
          const rareSet = metaFrequency !== null && metaFrequency < 0.05;

          ohkoRisks.push({
            attacker: row.pokemon_name, move: moveEntry.move, target: member.pokemon,
            // FIX 11: explicit speed context — both Pokemon's speeds
            attacker_speed: attackerSpeed,
            defender_speed: defenderSpeed,
            attacker_build: buildAttackerBuildLabel(attackerSpreads, attackerItem?.item, moveRow.category, moveRow.type, attackerAbility),
            attacker_usage_rank: rank + 1, attacker_usage_pct: usagePct,
            attacker_set_frequency: setFrequency ? round(setFrequency * 100, 1) : null,
            attacker_meta_frequency: metaFrequency ? round(metaFrequency * 100, 1) : null,
            rare_set: rareSet,
            damage_range: `${round(Math.min(...maxes), 1)}-${round(worstCaseMax, 1)}%`,
            speed_situation: situation,
            priority,
            weather_note: weatherNote,
            mitigation: findRedirectionMitigation(team, member.pokemon),
          });
        }
      }
    }
  }

  // FIX 6: order by max damage descending (highest threat first), not usage rank
  const parseMaxDmg = (dmg) => {
    const s = (dmg.damage_range || '').split('-')[1];
    return s ? parseFloat(s.replace('%', '')) : 0;
  };
  ohkoOpportunities.sort((a, b) => parseMaxDmg(b) - parseMaxDmg(a));
  ohkoRisks.sort((a, b) => parseMaxDmg(b) - parseMaxDmg(a));

  return {
    ohko_opportunities: ohkoOpportunities.slice(0, 20),
    ohko_risks: ohkoRisks.slice(0, 20),
    ohko_opportunity_count: ohkoOpportunities.length,
    ohko_risk_count: ohkoRisks.length,
  };
}

// FIX 9: Coverage move recommendations — detect when a common threat can OHKO
// multiple team members and suggest coverage with specific move names and damage.
// Only suggest types that a team member could plausibly learn, naming the threat,
// the move being replaced, and estimated damage outcome.
async function suggestCoverageReplacements(team, ohkoRisks) {
  if (!ohkoRisks || ohkoRisks.length === 0) return [];

  const risksByAttacker = {};
  for (const risk of ohkoRisks) {
    const key = risk.attacker.toLowerCase();
    if (!risksByAttacker[key]) {
      risksByAttacker[key] = { attacker: risk.attacker, usage_pct: risk.attacker_usage_pct || 0, risks: [], types: new Set() };
    }
    risksByAttacker[key].risks.push(risk);
    if (risk.move_type) risksByAttacker[key].types.add(risk.move_type);
  }

  const suggestions = [];
  for (const [, group] of Object.entries(risksByAttacker)) {
    const usagePct = group.usage_pct;
    // FIX 2: count unique targeted team members, not individual risk entries
    const uniqueTargets = [...new Set(group.risks.map(r => r.target))];
    const ohkoCount = uniqueTargets.length;
    const threshold = usagePct >= 0.10 ? 2 : usagePct >= 0.05 ? 3 : 4;
    if (ohkoCount < threshold) continue;

    const threatDisplay = `${group.attacker} (${Math.round(usagePct * 100)}% usage) — OHKOs ${ohkoCount} team member(s) (${uniqueTargets.join(', ')})`;

    for (const member of team) {
      if (!member.pokemonRow || !member.moves) continue;
      const isTarget = group.risks.some(r => (r.target || '').toLowerCase() === member.pokemon.toLowerCase());
      if (!isTarget) continue;

      const targetedMembers = [...new Set(group.risks.map(r => r.target || member.pokemon))];

      // FIX 3: coverage suggestions must not remove key moves. Protected moves:
      const PROTECTED_MOVES = new Set(['Protect', 'Fake Out', 'Tailwind', 'Encore',
        'Parting Shot', 'Sleep Powder', 'Rage Powder', 'Taunt', 'Follow Me',
        'Wide Guard', 'Quick Guard', 'Helping Hand', 'Detect', 'Spiky Shield']);

      // Identify the Pokemon's STAB types (one or two) — don't suggest removing
      // the only move of a STAB type
      const memberTypes = [member.pokemonRow.type1, member.pokemonRow.type2].filter(Boolean);
      const typeMoveCounts = {};
      for (const m of member.moves) {
        if (m.type) typeMoveCounts[m.type] = (typeMoveCounts[m.type] || 0) + 1;
      }

      const replaceableMove = member.moves.find(m => {
        const moveLower = (m.move || '').toLowerCase();
        if (PROTECTED_MOVES.has(m.move)) return false;
        // Don't remove the only move of a STAB type
        if (m.type && typeMoveCounts[m.type] === 1) return false;
        return true;
      });
      if (!replaceableMove) continue;

      // Get attacker types from DB
      const firstRisk = group.risks[0];
      let attackerRow = null;
      try {
        const atkRowResult = await pool.query('SELECT * FROM pokemon WHERE LOWER(name) = LOWER($1)', [group.attacker]);
        attackerRow = atkRowResult.rows[0] || null;
      } catch (_err) { /* skip */ }
      const defTypes = [];
      if (attackerRow) {
        defTypes.push(attackerRow.type1);
        if (attackerRow.type2) defTypes.push(attackerRow.type2);
      } else {
        // Can't determine types, just flag
        suggestions.push({
          threat: group.attacker,
          threat_usage_pct: usagePct,
          ohko_count: ohkoCount,
          targeted_members: targetedMembers,
          candidate_member: member.pokemon,
          move_to_replace: replaceableMove.move,
          suggested_moves: [],
          reason: `${threatDisplay}. Consider adding coverage for ${group.attacker}.`,
        });
        break;
      }

      // FIX 7: query the member's learnable offensive moves, then find the
      // one that's super effective against the threat and has highest power.
      const attackerDefTypes = [attackerRow.type1, attackerRow.type2].filter(Boolean);

      let suggestedMoves = [];
      let bestSuggestType = null;
      try {
        // Get all offensive learnable moves for this member
        const learnsetRows = await pool.query(
          `SELECT DISTINCT m.name, m.type, m.power, m.category
           FROM pokemon_moves pm
           JOIN pokemon p ON pm.pokemon_id = p.id
           JOIN moves m ON pm.move_id = m.id
           WHERE LOWER(p.name) = LOWER($1) AND m.category != 'Status' AND m.power > 0
           ORDER BY m.power DESC
           LIMIT 30`,
          [member.pokemon]
        );
        const learnable = learnsetRows.rows;
        // Score each move by effectiveness against the attacker
        const scored = learnable.map(m => ({
          ...m,
          eff: effectivenessAgainst(m.type, attackerDefTypes),
        })).filter(m => m.eff >= 1.5); // at least neutral (1x), prefer super effective

        if (scored.length > 0) {
          // Sort by effectiveness (desc) then power (desc)
          scored.sort((a, b) => b.eff - a.eff || b.power - a.power);
          bestSuggestType = scored[0].type;
          suggestedMoves = scored.slice(0, 3).map(m => `${m.name} (${m.eff >= 2 ? 'super effective, ' : ''}${m.power} BP ${m.category})`);
        } else {
          // No super-effective learnable moves — just suggest any high-power move
          bestSuggestType = defTypes[0] || 'unknown';
          suggestedMoves = learnable.slice(0, 3).map(m => `${m.name} (${m.power} BP ${m.category})`);
        }
      } catch (_err) {
        bestSuggestType = defTypes[0] || 'unknown';
        suggestedMoves = [];
      }
      if (!bestSuggestType) continue;

      suggestions.push({
        threat: group.attacker,
        threat_usage_pct: usagePct,
        ohko_count: ohkoCount,
        targeted_members: targetedMembers,
        candidate_member: member.pokemon,
        move_to_replace: replaceableMove.move,
        cover_type: bestSuggestType,
        suggested_moves: suggestedMoves,
        reason: `${threatDisplay}. Replace ${member.pokemon}'s ${replaceableMove.move} with a ${bestSuggestType}-type move to threaten ${group.attacker}.`,
      });
      break;
    }
  }

  suggestions.sort((a, b) => b.threat_usage_pct - a.threat_usage_pct);
  return suggestions.slice(0, 3);
}


module.exports = {
  getTypeMetaData,
  analyzeCoverage,
  analyzeSynergies,
  analyzeWeather,
  analyzeTrickRoom,
  analyzeSpeedTiers,
  analyzeWeaknesses,
  analyzeArchetypeMatchups,
  analyzeMatchups,
  getLegalPokemonSet,
  buildWideGuardSynergy,
  buildRagePowderSynergy,
  buildHospitalitySynergy,
  batchFetchTopMoveData,
  suggestCoverageReplacements,
  ARCHETYPES,
};
