const { Dex } = require('@pkmn/dex');

const ALL_TYPES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice',
  'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug',
  'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
];

// @pkmn/dex's `damageTaken` codes: 0 normal, 1 weak (2x taken), 2 resist (0.5x), 3 immune (0x).
const CODE_TO_MULTIPLIER = { 0: 1, 1: 2, 2: 0.5, 3: 0 };

function multiplierAgainstType(attackingType, defendingType) {
  const damageTaken = Dex.types.get(defendingType)?.damageTaken;
  if (!damageTaken) return 1;
  return CODE_TO_MULTIPLIER[damageTaken[attackingType]] ?? 1;
}

function effectivenessAgainst(attackingType, defendingTypes) {
  return defendingTypes
    .filter(Boolean)
    .reduce((mult, defType) => mult * multiplierAgainstType(attackingType, defType), 1);
}

function weaknessesOf(defendingTypes) {
  const weaknesses = {};
  for (const attackingType of ALL_TYPES) {
    const mult = effectivenessAgainst(attackingType, defendingTypes);
    if (mult > 1) weaknesses[attackingType] = mult;
  }
  return weaknesses;
}

function resistancesOf(defendingTypes) {
  const resistances = {};
  for (const attackingType of ALL_TYPES) {
    const mult = effectivenessAgainst(attackingType, defendingTypes);
    if (mult < 1) resistances[attackingType] = mult;
  }
  return resistances;
}

module.exports = { ALL_TYPES, effectivenessAgainst, weaknessesOf, resistancesOf };
