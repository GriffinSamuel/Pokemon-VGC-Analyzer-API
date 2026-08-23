#!/usr/bin/env node
/**
 * check_undefined_calls.js — catches calls to functions that do not exist.
 *
 * WHY: `node --check` validates SYNTAX, not BINDINGS. A call to a function that
 * was never defined or imported in this file parses perfectly and throws a
 * ReferenceError only when that code path executes at runtime. This has now
 * bitten this project twice:
 *
 *   - spread_scorer.js  calling `attackerAbility` from a block it was not scoped to
 *   - archetype_matchups.js  calling `weatherForMember`, which lives in team_analyzer.js
 *
 * Both passed `node --check`. Neither was reachable in a quick smoke test.
 *
 * This is a deliberately conservative heuristic, not a type checker: it only
 * reports a bare `name(...)` call where `name` is neither declared in the file,
 * nor destructured from a require, nor a known global. Method calls (`x.name()`)
 * are ignored entirely.
 *
 *   node scripts/check_undefined_calls.js src/utils/*.js src/routes/*.js
 *
 * Exit code 1 if anything is unresolved.
 */

const fs = require('fs');
const path = require('path');

const GLOBALS = new Set([
  // language + control flow that regex-matches like a call
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'await', 'new', 'do', 'else', 'try', 'throw', 'delete', 'void', 'in', 'of',
  'case', 'yield', 'super', 'this', 'import', 'export', 'class', 'extends',
  'async', 'get', 'set', 'static', 'from', 'as',
  // runtime globals
  'require', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Math', 'JSON',
  'Set', 'Map', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'BigInt',
  'process', 'console', 'Buffer', 'structuredClone', 'queueMicrotask', 'fetch',
  'URL', 'URLSearchParams', 'AbortController', 'TextEncoder', 'TextDecoder',
]);

function declaredNames(src) {
  const names = new Set();
  const add = (re, group = 1) => {
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[group]);
  };

  add(/\bfunction\s+([A-Za-z_$][\w$]*)/g);
  // Shorthand methods in object literals and classes: `info(message) {`.
  // These are DEFINITIONS that regex-match exactly like calls — logger.js's
  // `info(...)`/`error(...)` were reported as undefined until this line existed.
  // Over-collecting here only suppresses reports, which is the safe direction.
  add(/^\s*(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g);
  // for (const x of ...) / catch (err)
  add(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g);

  // Destructured declarations and requires: const { a, b: c } = ...
  const destructure = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
  let m;
  while ((m = destructure.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const piece = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(piece)) names.add(piece);
    }
  }

  // Function parameters — collected loosely across all signatures. Over-
  // collecting here only makes the check MORE conservative (fewer reports),
  // which is the right direction for a heuristic that must not cry wolf.
  const params = /(?:function\s*[A-Za-z_$\w]*\s*|\)\s*=>|\(\s*)\(?([^)]*)\)?\s*(?:=>|\{)/g;
  while ((m = params.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const piece = part.split('=')[0].replace(/[{}[\].]/g, ' ').trim().split(/\s+/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(piece)) names.add(piece);
    }
  }
  return names;
}

function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ') // line comments
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``') // template literals
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    // Regex literals. Without this, /ite( [xy])?$/ reads as a call to ite().
    .replace(/([=(,:[!&|?{};]\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g, '$1RE');
}

function check(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = strip(raw);
  const declared = declaredNames(src);
  const problems = [];

  // A bare call: not preceded by `.` (method) and not a declaration keyword.
  const call = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  const seen = new Set();
  while ((m = call.exec(src)) !== null) {
    const name = m[2];
    if (GLOBALS.has(name) || declared.has(name) || seen.has(name)) continue;
    seen.add(name);
    const line = raw.slice(0, m.index).split('\n').length;
    problems.push({ name, line });
  }
  return problems;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/check_undefined_calls.js <file...>');
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const problems = check(file);
  if (problems.length === 0) {
    console.log(`OK    ${path.relative(process.cwd(), file)}`);
    continue;
  }
  failed += problems.length;
  console.log(`FAIL  ${path.relative(process.cwd(), file)}`);
  for (const p of problems) console.log(`        line ${p.line}: ${p.name}() is not defined or imported in this file`);
}
process.exit(failed > 0 ? 1 : 0);
