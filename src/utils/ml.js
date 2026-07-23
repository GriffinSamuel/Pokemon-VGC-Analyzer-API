const path = require('path');
const { spawn } = require('child_process');
const logger = require('./logger');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PYTHON_PATH = path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe');
const ML_DIR = path.join(PROJECT_ROOT, 'src', 'ml');

function runPythonScript(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ML_DIR, scriptName);
    const proc = spawn(PYTHON_PATH, [scriptPath, ...args], { cwd: ML_DIR });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python process (${PYTHON_PATH}): ${err.message}`));
    });

    proc.on('close', (code) => {
      if (stderr) {
        logger.info(`${scriptName} stderr output`, { stderr: stderr.trim() });
      }

      if (code !== 0) {
        reject(new Error(`${scriptName} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }

      const resultLine = stdout.split('\n').find(line => line.startsWith('RESULT_JSON:'));
      if (!resultLine) {
        reject(new Error(`${scriptName} did not produce a RESULT_JSON line. stdout: ${stdout.trim()}`));
        return;
      }

      try {
        resolve(JSON.parse(resultLine.slice('RESULT_JSON:'.length)));
      } catch (err) {
        reject(new Error(`Failed to parse RESULT_JSON from ${scriptName}: ${err.message}`));
      }
    });
  });
}

module.exports = { runPythonScript, PYTHON_PATH };
