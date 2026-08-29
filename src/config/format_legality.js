// Champions Regulation M-B species legality — HONEST LIMITATION, READ BEFORE EDITING.
//
// No authoritative source of format legality exists anywhere in this repo or
// database. There is no regulation table, no banlist, no dex-format ruleset —
// `items` (schema.sql) is defined but has 0 rows; `pokemon` is seeded from
// @pkmn/dex broadly (filtered only by `isNonstandard` + observed-in-
// tournament_teams, which is a "was this obtainable/played" filter, not a
// legality ruling — see seed_learnsets.js/seed.js). The closest existing
// thing, `getLegalPokemonSet()` (team_analyzer.js), is explicitly documented
// there as an OBSERVED-usage proxy, not game-rules legality, and reusing it
// here would be exactly the defect this file exists to avoid: a species with
// zero tournament_teams rows is either (a) illegal, or (b) legal but never
// picked — usage_stats/tournament_teams cannot tell these apart, and
// conflating them would wrongly reject every legal-but-unpopular species.
//
// So this list is a manually curated denylist, not a derived one. It only
// contains species explicitly confirmed illegal by the format owner — it is
// NOT exhaustive, and a species missing from it is NOT thereby confirmed
// legal (it may simply not have been reviewed yet). Every entry needs a
// reason a human supplied, not an inferred one.
//
// Where this should really live: a `format_legality` DB table (species name,
// legal boolean, source/reason, reviewed_at) populated from whatever
// authoritative Regulation M-B ruleset the format's owner works from — ideally
// scraped or imported from that source rather than hand-maintained here, the
// same way tournament_teams/usage_stats are populated from real external data
// rather than guessed. Until that source exists, this hardcoded list is the
// smallest honest thing that can be defended: it rejects only what has
// actually been confirmed illegal, and refuses to guess at anything else.
const ILLEGAL_SPECIES = new Map([
  ['raging bolt', 'Not legal in Champions Regulation M-B (confirmed by format owner; 0 observed tournament_teams appearances)'],
  ['ursaluna-bloodmoon', 'Not legal in Champions Regulation M-B (confirmed by format owner; 0 observed tournament_teams appearances)'],
]);

function checkSpeciesLegality(name) {
  const reason = ILLEGAL_SPECIES.get(String(name || '').toLowerCase());
  return reason ? { legal: false, reason } : { legal: true, reason: null };
}

module.exports = { checkSpeciesLegality, ILLEGAL_SPECIES };
