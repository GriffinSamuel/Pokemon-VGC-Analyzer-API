// Opt out of the rate limiter — this script intentionally fires concurrent bursts
// from a single IP to measure raw endpoint performance, which is exactly what the
// rate limiter exists to block in production. See app.js's `skip` option.
process.env.DISABLE_RATE_LIMIT = 'true';

const fetch = require('node-fetch');
const app = require('../app');
const pool = require('../db/pool');

function percentile(sortedTimings, p) {
  const index = Math.ceil((p / 100) * sortedTimings.length) - 1;
  return sortedTimings[Math.max(0, Math.min(index, sortedTimings.length - 1))];
}

async function fireConcurrent(count, requestFn) {
  const timings = [];
  let failures = 0;

  await Promise.all(Array.from({ length: count }, async () => {
    const start = Date.now();
    try {
      const res = await requestFn();
      timings.push(Date.now() - start);
      if (!res.ok) failures++;
    } catch (err) {
      timings.push(Date.now() - start);
      failures++;
    }
  }));

  timings.sort((a, b) => a - b);
  return {
    count,
    failures,
    avg: timings.reduce((a, b) => a + b, 0) / timings.length,
    p95: percentile(timings, 95),
  };
}

async function run() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const BASE_URL = `http://localhost:${server.address().port}`;

  const results = [];

  results.push({
    name: 'GET /api/pokemon',
    target: 500,
    ...(await fireConcurrent(100, () => fetch(`${BASE_URL}/api/pokemon`))),
  });

  results.push({
    name: 'POST /api/damage',
    target: 2000,
    ...(await fireConcurrent(50, () => fetch(`${BASE_URL}/api/damage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attacker: { name: 'Garchomp', evs: { atk: 252 }, nature: 'Adamant' },
        defender: { name: 'Basculegion-F', evs: { hp: 0 } },
        move: 'Earthquake',
      }),
    }))),
  });

  results.push({
    name: 'GET /api/recommend/moves/Garchomp',
    target: 500,
    ...(await fireConcurrent(50, () => fetch(`${BASE_URL}/api/recommend/moves/Garchomp`))),
  });

  console.log('\nLoad Test Results');
  console.log('='.repeat(96));
  console.log(
    'Endpoint'.padEnd(34) + 'Requests'.padEnd(10) + 'Failures'.padEnd(10) +
    'Avg (ms)'.padEnd(10) + 'P95 (ms)'.padEnd(10) + 'Target P95'.padEnd(12) + 'Result'
  );

  let anyFailed = false;
  for (const r of results) {
    const pass = r.p95 <= r.target && r.failures === 0;
    if (!pass) anyFailed = true;
    console.log(
      r.name.padEnd(34) +
      String(r.count).padEnd(10) +
      String(r.failures).padEnd(10) +
      r.avg.toFixed(1).padEnd(10) +
      String(r.p95).padEnd(10) +
      `<= ${r.target}`.padEnd(12) +
      (pass ? 'PASS' : 'FAIL')
    );
  }
  console.log('='.repeat(96));

  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  process.exit(anyFailed ? 1 : 0);
}

run();
