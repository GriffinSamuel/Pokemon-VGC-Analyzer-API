const express = require('express');
const router = express.Router();
const { getCacheStats } = require('../scrapers/serebii');

router.get('/stats', async (req, res, next) => {
  try {
    res.json(getCacheStats());
  } catch (err) { next(err); }
});

module.exports = router;
