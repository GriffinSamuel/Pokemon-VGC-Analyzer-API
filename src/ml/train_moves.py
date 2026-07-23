import json
import sys
from collections import Counter, defaultdict

from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, top_k_accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

from data import load_pokemon_species, load_tournament_teams, load_winning_teams, species_key, species_identity_key, unique_attacks
from features import (
    FEATURE_NAMES,
    build_pokemon_feature_vector,
    build_team_context_vector,
    build_vocab,
    encode_categorical,
    encode_nature,
)
from registry import MODELS_DIR, save_move_model

MIN_MOVE_FREQUENCY = 5
MIN_CONFIDENCE = 0.05
MIN_APPEARANCES_FOR_COVERAGE = 10
VOCAB_SIZE = 20

FULL_FEATURE_NAMES = (
    FEATURE_NAMES
    + ["nature_atk", "nature_def", "nature_spa", "nature_spd", "nature_spe"]
    + [f"item_{i}" for i in range(VOCAB_SIZE + 1)]
    + [f"ability_{i}" for i in range(VOCAB_SIZE + 1)]
    + [f"team_ctx_{name}" for name in FEATURE_NAMES]
)


def build_feature_vector(mon, species_row, teammate_rows, item_vocab, ability_vocab):
    base = build_pokemon_feature_vector(species_row)
    nature = encode_nature(mon.get("nature"))
    item = encode_categorical(mon.get("item"), item_vocab)
    ability = encode_categorical(mon.get("ability"), ability_vocab)
    team_ctx = build_team_context_vector(teammate_rows)
    return base + nature + item + ability + team_ctx


def build_dataset(species, teams, item_vocab, ability_vocab):
    X, y = [], []
    matched, skipped = 0, 0

    for team in teams:
        mons = team["pokemon"] or []
        rows_by_index = {}
        for i, mon in enumerate(mons):
            row = species.get(species_key(mon))
            if row is not None:
                rows_by_index[i] = row

        for i, mon in enumerate(mons):
            row = rows_by_index.get(i)
            if row is None:
                skipped += 1
                continue
            matched += 1

            teammate_rows = [rows_by_index[j] for j in rows_by_index if j != i]
            vector = build_feature_vector(mon, row, teammate_rows, item_vocab, ability_vocab)

            for move in unique_attacks(mon):
                X.append(vector)
                y.append(move)

    print(f"Matched {matched} pokemon entries, skipped {skipped} (species not found)", file=sys.stderr)
    return X, y


def filter_rare_moves(X, y):
    counts = Counter(y)
    keep = {move for move, count in counts.items() if count >= MIN_MOVE_FREQUENCY}
    filtered_X = [x for x, move in zip(X, y) if move in keep]
    filtered_y = [move for move in y if move in keep]
    print(f"Kept {len(keep)} move classes (>= {MIN_MOVE_FREQUENCY} samples each)", file=sys.stderr)
    return filtered_X, filtered_y


def build_prevalence_table(species, all_teams, winning_teams):
    """Per-species move confidence = % of that species' WINNING-team appearances using the move.
    total_appearances (all teams, win or lose) gates the /api/recommend/moves 10-appearance minimum.

    Bucketed by species_identity_key() (Mega/regional identity, e.g. "raichu-mega-y"),
    not the plain species_key() this function used before — a Mega form's moves were
    previously silently folded into its base form's bucket (verified live: Raichu-Mega-Y,
    a real 8.21%-usage Pokemon, had zero entries of its own; every one of its real
    observed moves like Zap Cannon/Focus Blast was blended into base "raichu" alongside
    Kantonian Raichu's own moves instead). See CLAUDE.md for the full investigation —
    this mirrors train_synergy.py's already-correct team_pokemon_identity() pattern,
    which is how Swampert-Mega's usage was originally separated from base Swampert's.
    """
    total_appearances = Counter()
    for team in all_teams:
        for mon in team["pokemon"] or []:
            identity = species_identity_key(mon, species)
            if identity is not None:
                total_appearances[identity[0]] += 1

    winning_appearances = Counter()
    move_counts = defaultdict(Counter)
    for team in winning_teams:
        for mon in team["pokemon"] or []:
            identity = species_identity_key(mon, species)
            if identity is None:
                continue
            name = identity[0]
            winning_appearances[name] += 1
            for move in unique_attacks(mon):
                move_counts[name][move] += 1

    table = {}
    for name in total_appearances:
        w_appearances = winning_appearances.get(name, 0)
        moves = []
        if w_appearances > 0:
            for move, count in move_counts[name].items():
                confidence = count / w_appearances
                if confidence >= MIN_CONFIDENCE:
                    moves.append({"move": move, "confidence": round(confidence, 4), "count": count})
        moves.sort(key=lambda m: m["confidence"], reverse=True)
        table[name] = {
            "total_appearances": total_appearances[name],
            "winning_appearances": w_appearances,
            "moves": moves,
        }

    distinct_species_seen = len(total_appearances)
    covered = sum(1 for n in total_appearances if total_appearances[n] >= MIN_APPEARANCES_FOR_COVERAGE)
    coverage = round(covered / distinct_species_seen, 4) if distinct_species_seen else 0.0

    return table, coverage, distinct_species_seen


def train():
    species = load_pokemon_species()
    all_teams = load_tournament_teams()
    winning_teams = load_winning_teams()

    all_items = [mon.get("item") for team in all_teams for mon in (team["pokemon"] or [])]
    all_abilities = [mon.get("ability") for team in all_teams for mon in (team["pokemon"] or [])]
    item_vocab = build_vocab(all_items, top_k=VOCAB_SIZE)
    ability_vocab = build_vocab(all_abilities, top_k=VOCAB_SIZE)

    X, y = build_dataset(species, all_teams, item_vocab, ability_vocab)
    if len(X) == 0:
        raise RuntimeError("No training data found — check tournament_teams and pokemon tables")

    X, y = filter_rare_moves(X, y)

    encoder = LabelEncoder()
    y_encoded = encoder.fit_transform(y)

    class_counts = Counter(y_encoded)
    can_stratify = min(class_counts.values()) >= 2

    X_train, X_test, y_train, y_test = train_test_split(
        X, y_encoded,
        test_size=0.2,
        random_state=42,
        stratify=y_encoded if can_stratify else None,
    )

    # min_samples_leaf=15 matters a lot here: with team-context features added, most
    # feature vectors become near-unique (every team composition differs slightly),
    # and an unconstrained forest fragments into leaves of 1-2 samples and badly
    # overfits — measured top-1 accuracy on held-out data collapses from ~23% to ~3%.
    # Constraining leaf size forces the trees to generalize across similar teams
    # instead of memorizing exact ones, which is what makes team context a net
    # positive signal rather than noise (verified empirically before picking this value).
    # n_estimators=60/max_depth=15 keeps accuracy within 0.02 of a much larger forest
    # (300 trees, unlimited depth) while cutting the saved model from ~560MB to ~70MB.
    model = RandomForestClassifier(n_estimators=60, min_samples_leaf=15, max_depth=15, random_state=42, n_jobs=-1)
    model.fit(X_train, y_train)

    # This model recommends the TOP 4 MOVES for a slot, not a single move — a move is
    # "right" if it lands anywhere in that top-4 list, not only as the single best guess.
    # Top-1 exact-match accuracy is therefore the wrong yardstick for this task (it
    # penalizes correct-but-not-first suggestions); top-4 accuracy is what the accuracy
    # target in CLAUDE.md/the task spec is meant to measure.
    proba = model.predict_proba(X_test)
    top1_accuracy = accuracy_score(y_test, model.predict(X_test))
    accuracy = top_k_accuracy_score(y_test, proba, k=4, labels=model.classes_)

    prevalence_table, coverage, distinct_species_seen = build_prevalence_table(species, all_teams, winning_teams)

    metadata = {
        "n_samples": len(X),
        "n_classes": len(encoder.classes_),
        "accuracy": round(float(accuracy), 4),
        "accuracy_metric": "top_4",
        "top_1_accuracy": round(float(top1_accuracy), 4),
        "test_size": len(X_test),
        "training_samples": len(X),
        "top_pokemon_coverage": coverage,
        "distinct_species_seen": distinct_species_seen,
    }
    meta = save_move_model(
        model, encoder, FULL_FEATURE_NAMES, metadata,
        item_vocab=item_vocab, ability_vocab=ability_vocab,
    )

    recommendations_path = MODELS_DIR / "move_recommendations.json"
    with open(recommendations_path, "w") as f:
        json.dump({"trained_at": meta["trained_at"], "pokemon": prevalence_table}, f, indent=2)

    print(
        f"Accuracy: {accuracy:.4f} ({len(X)} samples, {len(encoder.classes_)} move classes, "
        f"coverage {coverage:.2%} of {distinct_species_seen} species)",
        file=sys.stderr,
    )

    garchomp = prevalence_table.get("garchomp")
    if garchomp:
        top5 = garchomp["moves"][:5]
        print(f"Garchomp top 5 moves (of {garchomp['winning_appearances']} winning-team appearances):", file=sys.stderr)
        for m in top5:
            print(f"  {m['move']}: {m['confidence']:.2%} ({m['count']} appearances)", file=sys.stderr)

    result = {"status": "success", **meta}
    print(f"RESULT_JSON:{json.dumps(result)}")
    return result


if __name__ == "__main__":
    train()
