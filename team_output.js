/**
 * team_output.js — READ-ONLY. Prints the POST /api/team/build text/plain response.
 *
 *   node team_output.js
 *   node team_output.js Garchomp Pelipper Sinistcha Kingambit Basculegion Archaludon
 *   node team_output.js --section=archetype
 *   node team_output.js --sections
 *
 * The full response is now well over 1000 lines, which is VS Code's default
 * terminal scrollback — the earliest sections scroll out of the buffer and look
 * truncated. --section prints one part so it fits.
 *
 * Boots the Express app in-process on an ephemeral port the same way
 * src/tests/api.test.js does — no running server needed, nothing touches :3000.
 */

// Section dividers in the response look like "── ARCHETYPE MATCHUPS ────────".
// Everything before the first divider is the per-Pokemon builds.
const BUILDS_SECTION = 'BUILDS';

function splitSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = { name: BUILDS_SECTION, lines: [] };
  for (const line of lines) {
    const m = line.match(/^──\s+(.+?)\s+─+$/);
    if (m) {
      sections.push(current);
      current = { name: m[1].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.filter((s) => s.lines.some((l) => l.trim()));
}

const app = require('./src/app');
const pool = require('./src/db/pool');

const DEFAULT_TEAM = ['Charizard-Mega-Y', 'Venusaur', 'Whimsicott', 'Kingambit', 'Archaludon', 'Pelipper'];

(async () => {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const names = argv.filter((a) => !a.startsWith('--'));
  const listOnly = flags.includes('--sections');
  const wanted = (flags.find((f) => f.startsWith('--section=')) || '').split('=')[1] || null;

  const team = names.length > 0 ? names : DEFAULT_TEAM;
  if (team.length !== 6) {
    console.log(`Need exactly 6 Pokemon, got ${team.length}: ${team.join(', ')}`);
    process.exit(1);
  }

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;

  try {
    const started = Date.now();
    const res = await fetch(`${base}/api/team/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify({ team }),
    });
    const text = await res.text();

    if (res.status !== 200) {
      console.log(`\nHTTP ${res.status}\n${text}`);
      return;
    }

    // Console only. Redirect to a file yourself if you want one:
    //   node team_output.js | Out-File logs\out.txt -Encoding utf8
    const sections = splitSections(text);
    const totalLines = text.split('\n').length;

    if (listOnly) {
      console.log(`\n${totalLines} lines total across ${sections.length} sections:\n`);
      for (const sec of sections) {
        console.log(`  --section=${sec.name.toLowerCase().split(' ')[0].padEnd(12)} ${String(sec.lines.length).padStart(5)} lines   (${sec.name})`);
      }
      console.log(`\nbuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return;
    }

    if (wanted) {
      const key = wanted.toLowerCase();
      const matched = sections.filter((sec) => sec.name.toLowerCase().startsWith(key));
      if (matched.length === 0) {
        console.log(`No section matching "${wanted}". Available: ${sections.map((sec) => sec.name.toLowerCase().split(' ')[0]).join(', ')}`);
        return;
      }
      for (const sec of matched) console.log('\n' + sec.lines.join('\n'));
      console.log('='.repeat(78));
      console.log(`built in ${((Date.now() - started) / 1000).toFixed(1)}s — showed ${matched.reduce((n, sec) => n + sec.lines.length, 0)} of ${totalLines} lines`);
      return;
    }

    console.log('\n' + text);
    console.log('='.repeat(78));
    console.log(`built in ${((Date.now() - started) / 1000).toFixed(1)}s — ${totalLines} lines`);
    if (totalLines > 1000) {
      console.log(`NOTE: ${totalLines} lines exceeds VS Code's default 1000-line terminal scrollback,`);
      console.log('      so the top has likely scrolled out. Use --sections to list parts,');
      console.log('      or raise "terminal.integrated.scrollback" in VS Code settings.');
    }
  } catch (err) {
    console.log(`FAILED — ${err.message}\n${err.stack}`);
  } finally {
    server.close();
    await pool.end();
  }
})();
