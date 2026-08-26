const fs = require('fs');
const path = require('path');

if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const logFile = path.join('logs', `app-${new Date().toISOString().split('T')[0]}.log`);
const errorFile = path.join('logs', `error-${new Date().toISOString().split('T')[0]}.log`);

function timestamp() {
  return new Date().toISOString();
}

function writeToFile(file, message) {
  fs.appendFileSync(file, message + '\n');
}

const logger = {
  info(message, meta = {}) {
    const line = JSON.stringify({ level: 'info', timestamp: timestamp(), message, ...meta });
    console.error(line);
    writeToFile(logFile, line);
  },
  error(message, meta = {}) {
    const line = JSON.stringify({ level: 'error', timestamp: timestamp(), message, ...meta });
    console.error(line);
    writeToFile(errorFile, line);
    writeToFile(logFile, line);
  }
};

module.exports = logger;