import json
import re
import sys
from collections import Counter
from itertools import combinations

from data import load_abilities, load_pokemon_species, load_tournament_teams, resolve_base_key
from registry import MODELS_DIR, save_synergy_matrix

MIN_COOCCURRENCE = 5

# Weather/terrain conditions Pokemon abilities can set or exploit. This is a fixed
# game-mechanics vocabulary (not guessed), used to mine setter/booster ability pairs
# directly out of the `abilities` table's description text rather than hardcoding
# specific pairs like "Drizzle + Swift Swim" by hand.
FIELD_CONDITIONS = [
    "Rain Dance", "Sunny Day", "Sandstorm", "Snow", "Hail",
    "Electric Terrain", "Grassy Terrain", "Psychic Terrain", "Misty Terrain",
]


def build_ability_synergy_rules(abilities):
    setters, boosters = {c: [] for c in FIELD_CONDITIONS}, {c: [] for c in FIELD_CONDITIONS}

    for row in abilities.values():
        name, desc = row["name"], row.get("description") or ""
        for condition in FIELD_CONDITIONS:
            if re.search(rf"summons\s+{re.escape(condition)}\b", desc, re.IGNORECASE):
                setters[condition].append(name)
            if (
                re.search(rf"if\s+{re.escape(condition)}\s+is active", desc, re.IGNORECASE)
                and re.search(r"speed", desc, re.IGNORECASE)
                and re.search(r"doubl", desc, re.IGNORECASE)
            ):
                boosters[condition].append(name)

    rules = []
    for condition in FIELD_CONDITIONS:
        for setter in setters[condition]:
            for booster in boosters[condition]:
                rules.append({
                    "setter_ability": setter,
                    "booster_ability": booster,
                    "condition": condition,
                    "reason": f"{setter} + {booster}",
                })
    return rules


def team_pokemon_identity(mon, species):
    """(key, display_name) for a scraped Pokemon entry, or None if unrecognized.

    Prefers `normalizedName` over `name` — COALESCE(normalizedName, name), matching
    the pattern in stats.js — so a Pokemon holding a Mega Stone (e.g. Swampert +
    Swampertite -> "Swampert-Mega", set by normalize.js) is tracked as a distinct
    identity from its base form instead of folding together.

    Validity is still checked via `resolve_base_key()` (id-then-name fallback —
    see data.py) against the `pokemon` species table, since that's the only
    reliable existence check available: the table has zero "-Mega" rows, so
    checking membership using the *normalized* name would reject every Mega
    entry outright. The normalized name is only substituted in for
    identity/display after that base check passes.
    """
    base_key = resolve_base_key(mon, species)
    if base_key is None:
        return None
    normalized = (mon.get("normalizedName") or "").strip()
    if normalized:
        return normalized.lower(), normalized
    return base_key, species[base_key]["name"]


def build_cooccurrence(species, teams):
    usage = Counter()
    co_occurrence = Counter()
    total_teams = 0
    display_names = {}

    for team in teams:
        identities = {}
        for mon in (team["pokemon"] or []):
            identity = team_pokemon_identity(mon, species)
            if identity is None:
                continue
            key, display = identity
            identities[key] = display
        if not identities:
            continue
        total_teams += 1
        for key, display in identities.items():
            usage[key] += 1
            display_names[key] = display
        for a, b in combinations(sorted(identities.keys()), 2):
            co_occurrence[(a, b)] += 1

    return usage, co_occurrence, total_teams, display_names


def compute_pair_scores(display_names, usage, co_occurrence, total_teams):
    pairs = []
    for (a, b), count in co_occurrence.items():
        if count < MIN_COOCCURRENCE:
            continue
        expected = usage[a] * usage[b] / total_teams
        if expected <= 0:
            continue
        pairs.append({
            "pokemon_a": display_names[a],
            "pokemon_b": display_names[b],
            "score": round(count / expected, 3),
            "co_occurrence": count,
        })
    pairs.sort(key=lambda p: p["score"], reverse=True)
    return pairs


def build_scores_lookup(pairs):
    """{species_lower: {partner_lower: score}} — symmetric, for O(1) partner lookup."""
    lookup = {}
    for pair in pairs:
        a, b = pair["pokemon_a"].lower(), pair["pokemon_b"].lower()
        lookup.setdefault(a, {})[b] = pair["score"]
        lookup.setdefault(b, {})[a] = pair["score"]
    return lookup


def train():
    species = load_pokemon_species()
    abilities = load_abilities()
    teams = load_tournament_teams()

    usage, co_occurrence, total_teams, display_names = build_cooccurrence(species, teams)
    pairs = compute_pair_scores(display_names, usage, co_occurrence, total_teams)
    scores_lookup = build_scores_lookup(pairs)
    ability_rules = build_ability_synergy_rules(abilities)

    # NOTE: Mega Pokemon are now tracked separately from their base form WHERE the
    # scraped entry has `normalizedName` set — but most historical rows predate that
    # field being populated (verified: only ~15% of Swampert+Swampertite appearances
    # have it), so "Swampert" still absorbs the majority of un-normalized Mega Swampert
    # entries. This is a data-completeness gap upstream of this script, not something
    # train_synergy.py can fully correct on its own.
    pelipper_swampert = scores_lookup.get("pelipper", {}).get("swampert")
    pelipper_swampert_mega = scores_lookup.get("pelipper", {}).get("swampert-mega")
    print(f"Pelipper + Swampert synergy score: {pelipper_swampert}", file=sys.stderr)
    print(f"Pelipper + Swampert-Mega synergy score: {pelipper_swampert_mega} "
          f"(threshold for 'strong' is 1.5)", file=sys.stderr)

    metadata = {
        "total_teams": total_teams,
        "pairs_analyzed": len(pairs),
        "min_cooccurrence_threshold": MIN_COOCCURRENCE,
        "ability_synergy_rules_found": len(ability_rules),
        "top_strongest_pairs": pairs[:20],
        "top_weakest_pairs": sorted(pairs, key=lambda p: p["score"])[:20],
    }
    meta = save_synergy_matrix(scores_lookup, dict(usage), metadata)

    with open(MODELS_DIR / "synergy_matrix.json", "w") as f:
        json.dump({"trained_at": meta["trained_at"], "scores": scores_lookup, "usage_counts": dict(usage)}, f, indent=2)

    with open(MODELS_DIR / "ability_synergies.json", "w") as f:
        json.dump({"trained_at": meta["trained_at"], "rules": ability_rules}, f, indent=2)

    print(f"Analyzed {len(pairs)} pairs across {total_teams} teams; found {len(ability_rules)} ability synergy rules", file=sys.stderr)
    print("Top 10 strongest pairs:", file=sys.stderr)
    for p in pairs[:10]:
        print(f"  {p['pokemon_a']} + {p['pokemon_b']}: {p['score']} ({p['co_occurrence']} co-occurrences)", file=sys.stderr)

    result = {"status": "success", "trained_at": meta["trained_at"], **{k: v for k, v in metadata.items() if k not in ("top_strongest_pairs", "top_weakest_pairs")}}
    print(f"RESULT_JSON:{json.dumps(result)}")
    return result


if __name__ == "__main__":
    train()
