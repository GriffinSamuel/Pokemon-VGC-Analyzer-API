const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const logger = require('../utils/logger');

const MODELS_DIR = path.join(__dirname, '..', 'ml', 'models');

function readMeta(filename) {
  const filePath = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(filePath)) return { ready: false };
  return { ready: true, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
}

router.get('/status', (req, res, next) => {
  try {
    const moveModel = readMeta('move_model_meta.json');
    const evModel = readMeta('ev_model_meta.json');
    const synergyModel = readMeta('synergy_meta.json');

    const trainedTimestamps = [moveModel, evModel, synergyModel]
      .map((m) => m.trained_at)
      .filter(Boolean)
      .sort();
    const lastTrainingRun = trainedTimestamps.length ? trainedTimestamps[trainedTimestamps.length - 1] : null;

    res.json({
      models: {
        move_model: moveModel,
        ev_model: evModel,
        synergy_model: synergyModel,
      },
      top_synergy_pairs: (synergyModel.top_strongest_pairs || []).slice(0, 5),
      last_training_run: lastTrainingRun,
    });
  } catch (err) {
    logger.error('Failed to read ML status', { error: err.message });
    next(err);
  }
});

module.exports = router;
