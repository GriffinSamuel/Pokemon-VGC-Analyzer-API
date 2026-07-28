/**
 * Shared formatting utilities.
 *
 * Consolidates the duplicated `round()` helpers that were copy-pasted across
 * ev_observations.js, threat_matrix.js, spread_scorer.js, team_analyzer.js,
 * team.js, and recommend.js.
 */

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports = { round };
