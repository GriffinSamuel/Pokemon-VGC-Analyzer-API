const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const { runSerebiiScraper } = require('./scrapers/serebii');
const { auditMegaItemMappings } = require('./utils/normalize');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — limit is 100 requests per minute' },
  // src/tests/load.test.js fires concurrent bursts from a single IP to measure raw
  // endpoint performance — that's the rate limiter's job to block in production, so
  // the load test opts out of it explicitly rather than the limiter being weakened.
  skip: () => process.env.DISABLE_RATE_LIMIT === 'true',
}));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP Request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    });
  });
  next();
});

app.use('/api/pokemon', require('./routes/pokemon'));
app.use('/api/moves', require('./routes/moves'));
app.use('/api/health', require('./routes/health'));
app.use('/api/damage', require('./routes/damage'));
app.use('/api/patches', require('./routes/patches'));
app.use('/api/cache', require('./routes/cache'));
app.use('/api/ml', require('./routes/ml'));
app.use('/api/recommend', require('./routes/recommend'));
app.use('/api/team', require('./routes/team'));
app.use('/api/tournament', require('./routes/tournament'));
app.use('/api/usage', require('./routes/usage'));
app.use('/api/ev-data', require('./routes/ev-data'));

app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    message: err.message,
    path: req.path,
    method: req.method,
  });
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  runSerebiiScraper();
  auditMegaItemMappings();
  app.listen(PORT, () => logger.info(`Server running on http://localhost:${PORT}`));
}

module.exports = app;