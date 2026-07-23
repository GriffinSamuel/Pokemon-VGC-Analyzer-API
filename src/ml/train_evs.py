import json
import sys
from collections import Counter, defaultdict

from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

from data import load_moves, load_pokemon_species, load_winning_teams, species_key, unique_attacks
from features import FEATURE_NAMES, NATURE_MODIFIERS, build_pokemon_feature_vector
from registry import MODELS_DIR, save_ev_model

# There is no EV data anywhere in tournament_teams (verified: 0 of 7,674 pokemon
# entries have an "evs" key). Every recommendation here is inferred from nature +
# moveset + base stats, not learned from real EV spreads — see infer_role().
SUPPORT_MOVES = {
    "protect", "follow me", "tailwind", "wide guard", "quick guard",
    "rage powder", "helping hand", "trick room", "taunt", "encore",
}

ROLES = ["physical_attacker", "special_attacker", "mixed", "defensive_wall", "speed_control"]

ROLE_SPREADS = {
    "physical_attacker": [
        {"evs": {"hp": 4, "atk": 252, "def": 0, "spa": 0, "spd": 0, "spe": 252},
         "notes": "Standard offensive spread — maximizes damage output and Speed"},
        {"evs": {"hp": 252, "atk": 252, "def": 0, "spa": 0, "spd": 4, "spe": 0},
         "notes": "Bulky attacker — trades Speed for HP/survivability"},
        {"evs": {"hp": 4, "atk": 252, "def": 0, "spa": 0, "spd": 252, "spe": 0},
         "notes": "Special-bulk attacker — invests in SpD instead of Speed"},
    ],
    "special_attacker": [
        {"evs": {"hp": 4, "atk": 0, "def": 0, "spa": 252, "spd": 0, "spe": 252},
         "notes": "Standard offensive spread — maximizes damage output and Speed"},
        {"evs": {"hp": 252, "atk": 0, "def": 4, "spa": 252, "spd": 0, "spe": 0},
         "notes": "Bulky attacker — trades Speed for physical bulk"},
        {"evs": {"hp": 4, "atk": 0, "def": 0, "spa": 252, "spd": 252, "spe": 0},
         "notes": "Special-bulk attacker — invests in SpD instead of Speed"},
    ],
    "mixed": [
        {"evs": {"hp": 4, "atk": 126, "def": 0, "spa": 126, "spd": 0, "spe": 252},
         "notes": "Balanced mixed attacker — splits investment between Atk and SpA"},
        {"evs": {"hp": 252, "atk": 128, "def": 0, "spa": 128, "spd": 0, "spe": 0},
         "notes": "Bulky mixed attacker — sacrifices Speed for HP"},
        {"evs": {"hp": 0, "atk": 252, "def": 0, "spa": 4, "spd": 0, "spe": 252},
         "notes": "Physical-leaning mixed — Atk-focused with just enough SpA for coverage"},
    ],
    "defensive_wall": [
        {"evs": {"hp": 252, "atk": 0, "def": 252, "spa": 0, "spd": 4, "spe": 0},
         "notes": "Physically defensive wall — maximizes HP and Def"},
        {"evs": {"hp": 252, "atk": 0, "def": 4, "spa": 0, "spd": 252, "spe": 0},
         "notes": "Specially defensive wall — maximizes HP and SpD"},
        {"evs": {"hp": 252, "atk": 0, "def": 128, "spa": 0, "spd": 128, "spe": 0},
         "notes": "Mixed wall — balanced physical/special bulk"},
    ],
    "speed_control": [
        {"evs": {"hp": 252, "atk": 0, "def": 4, "spa": 0, "spd": 0, "spe": 252},
         "notes": "Max Speed support — outpaces threats to set Tailwind/utility first"},
        {"evs": {"hp": 252, "atk": 0, "def": 252, "spa": 0, "spd": 4, "spe": 0},
         "notes": "Bulky Trick Room support — low Speed is intentional under Trick Room"},
        {"evs": {"hp": 244, "atk": 0, "def": 132, "spa": 0, "spd": 132, "spe": 0},
         "notes": "Bulky support — survives hits to guarantee its utility move lands"},
    ],
}


def infer_role(species_row, nature, move_names, moves_lookup):
    plus, _minus = NATURE_MODIFIERS.get((nature or "").lower(), (None, None))

    physical = special = support_hits = 0
    for name in move_names:
        if (name or "").lower() in SUPPORT_MOVES:
            support_hits += 1
        mv = moves_lookup.get((name or "").lower())
        if not mv or not mv.get("power"):
            continue
        category = (mv.get("category") or "").lower()
        if category == "physical":
            physical += 1
        elif category == "special":
            special += 1

    damaging = physical + special

    if plus == "spe" and support_hits >= 2 and damaging <= 2:
        return "speed_control"
    if damaging == 0:
        return "defensive_wall"
    if physical > 0 and special > 0:
        return "mixed"
    if physical > special:
        return "physical_attacker"
    if special > physical:
        return "special_attacker"
    return "physical_attacker" if species_row["atk"] >= species_row["spa"] else "special_attacker"


def build_role_dataset(species, moves, teams):
    X, y = [], []
    role_counts_by_species = defaultdict(Counter)

    for team in teams:
        for mon in team["pokemon"] or []:
            name = species_key(mon)
            row = species.get(name)
            if row is None:
                continue
            role = infer_role(row, mon.get("nature"), unique_attacks(mon), moves)
            X.append(build_pokemon_feature_vector(row))
            y.append(role)
            role_counts_by_species[name][role] += 1

    return X, y, role_counts_by_species


def build_recommendations(role_counts_by_species):
    table = {}
    for name, counts in role_counts_by_species.items():
        total = sum(counts.values())
        distribution = {role: round(count / total, 4) for role, count in counts.items()}
        ranked_roles = sorted(distribution.items(), key=lambda kv: kv[1], reverse=True)
        primary_role = ranked_roles[0][0]

        spreads = []
        top_role, top_prevalence = ranked_roles[0]
        spreads.append({**ROLE_SPREADS[top_role][0], "role": top_role, "prevalence": top_prevalence})
        spreads.append({**ROLE_SPREADS[top_role][1], "role": top_role, "prevalence": top_prevalence})
        if len(ranked_roles) > 1:
            second_role, second_prevalence = ranked_roles[1]
            spreads.append({**ROLE_SPREADS[second_role][0], "role": second_role, "prevalence": second_prevalence})
        else:
            spreads.append({**ROLE_SPREADS[top_role][2], "role": top_role, "prevalence": top_prevalence})

        table[name] = {
            "primary_role": primary_role,
            "role_distribution": distribution,
            "total_appearances": total,
            "spreads": spreads,
        }
    return table


def train():
    species = load_pokemon_species()
    moves = load_moves()
    teams = load_winning_teams()

    print("EV data availability: 0/7674 tournament pokemon entries have real EV data "
          "(verified against tournament_teams.pokemon JSONB) — all spreads below are "
          "inferred from nature + moveset + base stats, not learned from real EVs.", file=sys.stderr)

    X, y, role_counts_by_species = build_role_dataset(species, moves, teams)
    if len(X) == 0:
        raise RuntimeError("No role-labeled training data found — check tournament_teams and pokemon tables")

    encoder = LabelEncoder()
    y_encoded = encoder.fit_transform(y)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y_encoded, test_size=0.2, random_state=42, stratify=y_encoded
    )

    model = GradientBoostingClassifier(n_estimators=150, random_state=42)
    model.fit(X_train, y_train)
    accuracy = accuracy_score(y_test, model.predict(X_test))

    recommendations = build_recommendations(role_counts_by_species)

    metadata = {
        "training_samples": len(X),
        "real_ev_samples": 0,
        "inferred_samples": len(X),
        "roles_covered": sorted(set(y)),
        "accuracy": round(float(accuracy), 4),
        "accuracy_metric": "role_classification_top_1",
        "distinct_species": len(role_counts_by_species),
    }
    meta = save_ev_model(model, encoder, FEATURE_NAMES, metadata)

    with open(MODELS_DIR / "ev_recommendations.json", "w") as f:
        json.dump({"trained_at": meta["trained_at"], "pokemon": recommendations}, f, indent=2)

    with open(MODELS_DIR / "role_spread_templates.json", "w") as f:
        json.dump({"roles": ROLES, "templates": ROLE_SPREADS}, f, indent=2)

    print(f"Role classifier accuracy: {accuracy:.4f} ({len(X)} samples, roles: {sorted(set(y))})", file=sys.stderr)

    garchomp = recommendations.get("garchomp")
    if garchomp:
        print(f"Garchomp role distribution: {garchomp['role_distribution']}", file=sys.stderr)

    result = {"status": "success", **meta}
    print(f"RESULT_JSON:{json.dumps(result)}")
    return result


if __name__ == "__main__":
    train()
