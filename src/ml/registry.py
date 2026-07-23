import json
from datetime import datetime, timezone
from pathlib import Path

import joblib

MODELS_DIR = Path(__file__).parent / "models"

MOVE_MODEL_PATH = MODELS_DIR / "move_model.joblib"
MOVE_MODEL_META_PATH = MODELS_DIR / "move_model_meta.json"

EV_MODEL_PATH = MODELS_DIR / "ev_model.joblib"
EV_MODEL_META_PATH = MODELS_DIR / "ev_model_meta.json"

SYNERGY_MATRIX_PATH = MODELS_DIR / "synergy_matrix.joblib"
SYNERGY_META_PATH = MODELS_DIR / "synergy_meta.json"


def _save(bundle, bundle_path, meta_path, metadata):
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, bundle_path)

    meta = {
        **metadata,
        "trained_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def _status(bundle_path, meta_path):
    if not bundle_path.exists() or not meta_path.exists():
        return {"ready": False}
    with open(meta_path) as f:
        meta = json.load(f)
    return {"ready": True, **meta}


def save_move_model(model, label_encoder, feature_names, metadata, item_vocab=None, ability_vocab=None):
    bundle = {
        "model": model,
        "label_encoder": label_encoder,
        "feature_names": feature_names,
        "item_vocab": item_vocab,
        "ability_vocab": ability_vocab,
    }
    return _save(bundle, MOVE_MODEL_PATH, MOVE_MODEL_META_PATH, metadata)


def load_move_model():
    bundle = joblib.load(MOVE_MODEL_PATH)
    with open(MOVE_MODEL_META_PATH) as f:
        meta = json.load(f)
    return bundle, meta


def move_model_status():
    return _status(MOVE_MODEL_PATH, MOVE_MODEL_META_PATH)


def save_ev_model(model, label_encoder, feature_names, metadata):
    bundle = {"model": model, "label_encoder": label_encoder, "feature_names": feature_names}
    return _save(bundle, EV_MODEL_PATH, EV_MODEL_META_PATH, metadata)


def load_ev_model():
    bundle = joblib.load(EV_MODEL_PATH)
    with open(EV_MODEL_META_PATH) as f:
        meta = json.load(f)
    return bundle, meta


def ev_model_status():
    return _status(EV_MODEL_PATH, EV_MODEL_META_PATH)


def save_synergy_matrix(scores, usage_counts, metadata):
    bundle = {"scores": scores, "usage_counts": usage_counts}
    return _save(bundle, SYNERGY_MATRIX_PATH, SYNERGY_META_PATH, metadata)


def load_synergy_matrix():
    bundle = joblib.load(SYNERGY_MATRIX_PATH)
    with open(SYNERGY_META_PATH) as f:
        meta = json.load(f)
    return bundle, meta


def synergy_model_status():
    return _status(SYNERGY_MATRIX_PATH, SYNERGY_META_PATH)


if __name__ == "__main__":
    print(json.dumps({
        "move_model": move_model_status(),
        "ev_model": ev_model_status(),
        "synergy_model": synergy_model_status(),
    }, indent=2))
