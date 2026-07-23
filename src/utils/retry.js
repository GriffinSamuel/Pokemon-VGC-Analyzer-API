const logger = require('./logger');

async function withRetry(fn, options = {}) {
  const {
    retries = 3,
    label = 'operation',
    baseDelay = 1000,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const delay = baseDelay * Math.pow(2, attempt - 1);

      if (attempt < retries) {
        logger.error(`${label} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms`, {
          error: err.message
        });
        await new Promise(r => setTimeout(r, delay));
      } else {
        logger.error(`${label} failed after ${retries} attempts`, {
          error: err.message
        });
      }
    }
  }

  throw lastError;
}

module.exports = { withRetry };