# Unresolvable stored move names

These `attacks` strings in `tournament_teams` do not resolve through `Dex.moves.get()`.
They are reported and left alone -- there is no safe way to guess what a typo meant, and
`normalize_stored_moves.js` never rewrites anything it cannot confidently resolve.

| Move string | Row count |
|---|---|
| Gigadrein | 1 |
| Matcha Gatcha | 1 |
| Solat Beam | 2 |
