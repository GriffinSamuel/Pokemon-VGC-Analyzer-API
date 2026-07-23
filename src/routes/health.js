const express = require('express');
const router = express.Router();
const { checkHealth } = require('../utils/health');

router.get('/', async (req, res, next) => {
  try {
    const health = await checkHealth();
    const allHealthy = health.every(s =>
      parseFloat(s.hours_since_success) <= 2
    );
    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'healthy' : 'degraded',
      scrapers: health
    });
  } catch (err) { next(err); }
});

module.exports = router;