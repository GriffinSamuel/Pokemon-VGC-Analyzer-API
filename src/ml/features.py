from collections import Counter

ALL_TYPES = [
    "Normal", "Fire", "Water", "Electric", "Grass", "Ice",
    "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug",
    "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
]

STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"]
MAX_STAT = 255

FEATURE_NAMES = STAT_KEYS + ALL_TYPES


def encode_stats(species_row):
    return [species_row[key] / MAX_STAT for key in STAT_KEYS]


def encode_types(species_row):
    types = {species_row.get("type1"), species_row.get("type2")}
    return [1.0 if t in types else 0.0 for t in ALL_TYPES]


def build_pokemon_feature_vector(species_row):
    return encode_stats(species_row) + encode_types(species_row)


# (stat gaining +10%, stat losing -10%) — neutral natures map to (None, None).
NATURE_MODIFIERS = {
    "hardy": (None, None), "docile": (None, None), "serious": (None, None),
    "bashful": (None, None), "quirky": (None, None),
    "lonely": ("atk", "def"), "brave": ("atk", "spe"), "adamant": ("atk", "spa"), "naughty": ("atk", "spd"),
    "bold": ("def", "atk"), "relaxed": ("def", "spe"), "impish": ("def", "spa"), "lax": ("def", "spd"),
    "timid": ("spe", "atk"), "hasty": ("spe", "def"), "jolly": ("spe", "spa"), "naive": ("spe", "spd"),
    "modest": ("spa", "atk"), "mild": ("spa", "def"), "quiet": ("spa", "spe"), "rash": ("spa", "spd"),
    "calm": ("spd", "atk"), "gentle": ("spd", "def"), "sassy": ("spd", "spe"), "careful": ("spd", "spa"),
}

NATURE_STAT_KEYS = ["atk", "def", "spa", "spd", "spe"]


def encode_nature(nature_name):
    """5-dim vector (atk/def/spa/spd/spe) of +0.1/-0.1/0.0 nature modifiers. HP is never nature-affected."""
    plus, minus = NATURE_MODIFIERS.get((nature_name or "").lower(), (None, None))
    vector = []
    for key in NATURE_STAT_KEYS:
        if key == plus:
            vector.append(0.1)
        elif key == minus:
            vector.append(-0.1)
        else:
            vector.append(0.0)
    return vector


def build_vocab(values, top_k=20):
    """Top-k most frequent values (desc by count, tie-broken alphabetically) plus an 'Other' bucket."""
    counts = Counter(v for v in values if v)
    top = [v for v, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:top_k]]
    return top + ["Other"]


def encode_categorical(value, vocab):
    """One-hot over vocab; unknown/missing values fall into the trailing 'Other' bucket."""
    index = vocab.index(value) if value in vocab else len(vocab) - 1
    return [1.0 if i == index else 0.0 for i in range(len(vocab))]


def build_team_context_vector(teammate_species_rows):
    """Average 24-dim species vector across teammates (excludes the Pokemon itself). Zeros if no teammates matched."""
    if not teammate_species_rows:
        return [0.0] * len(FEATURE_NAMES)
    vectors = [build_pokemon_feature_vector(row) for row in teammate_species_rows]
    return [sum(col) / len(vectors) for col in zip(*vectors)]


if __name__ == "__main__":
    from data import load_pokemon_species

    species = load_pokemon_species()
    garchomp = species["garchomp"]
    vector = build_pokemon_feature_vector(garchomp)

    print(f"Feature names ({len(FEATURE_NAMES)}): {FEATURE_NAMES}")
    print(f"Garchomp vector ({len(vector)}): {vector}")

    assert len(vector) == len(FEATURE_NAMES) == 24

    expected_stats = [108, 130, 95, 80, 85, 102]
    for key, expected in zip(STAT_KEYS, expected_stats):
        assert garchomp[key] == expected, f"{key} mismatch: {garchomp[key]} != {expected}"

    assert vector[STAT_KEYS.index("hp")] == 108 / MAX_STAT
    assert vector[STAT_KEYS.index("spe")] == 102 / MAX_STAT
    assert vector[FEATURE_NAMES.index("Dragon")] == 1.0
    assert vector[FEATURE_NAMES.index("Ground")] == 1.0
    assert sum(vector[len(STAT_KEYS):]) == 2.0, "exactly two types should be set"

    print("Garchomp feature encoding test passed.")
