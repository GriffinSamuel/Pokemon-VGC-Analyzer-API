// Pokemon Champions Reg M-B stat formula, verified against Bulbapedia's "Stat point"
// page (raw wikitext fetched and cross-checked by hand against the classic Gen9
// formula on Garchomp at three separate Stat Point values — see project history).
// Level is always 50, IVs are always 31 — Champions has no IV mechanic.
const SP_CAP_PER_STAT = 32;
const SP_BUDGET_TOTAL = 66;

const SP_STEPS = [];
for (let sp = 0; sp <= SP_CAP_PER_STAT; sp++) SP_STEPS.push(sp);

// Same nature +/- stat table as the rest of this project (team.js's NATURE_BOOSTS,
// features.py's NATURE_MODIFIERS) — Champions calls this "Alignment" but it's the
// identical 0.9/1.0/1.1 table, duplicated locally per this project's convention.
const NATURE_MODIFIERS = {
  hardy: [null, null], docile: [null, null], serious: [null, null], bashful: [null, null], quirky: [null, null],
  lonely: ['atk', 'def'], brave: ['atk', 'spe'], adamant: ['atk', 'spa'], naughty: ['atk', 'spd'],
  bold: ['def', 'atk'], relaxed: ['def', 'spe'], impish: ['def', 'spa'], lax: ['def', 'spd'],
  timid: ['spe', 'atk'], hasty: ['spe', 'def'], jolly: ['spe', 'spa'], naive: ['spe', 'spd'],
  modest: ['spa', 'atk'], mild: ['spa', 'def'], quiet: ['spa', 'spe'], rash: ['spa', 'spd'],
  calm: ['spd', 'atk'], gentle: ['spd', 'def'], sassy: ['spd', 'spe'], careful: ['spd', 'spa'],
};

function natureMultiplierFor(natureName, statKey) {
  const [plus, minus] = NATURE_MODIFIERS[(natureName || '').toLowerCase()] || [null, null];
  if (statKey === plus) return 1.1;
  if (statKey === minus) return 0.9;
  return 1.0;
}

// The ONLY place classic-EV numbers exist in this codebase. @smogon/calc has no
// native Stat Point support (verified — its source has zero references to "stat
// point" or "Champions"), so this bridges Champions' real SP values into the shape
// the damage calculator's underlying library expects. Per Bulbapedia: the first
// point in a stat costs 4 EV, every point after that costs 8 EV.
function spToEv(sp) {
  if (!sp || sp <= 0) return 0;
  return 8 * sp - 4;
}

// Champions' official formula (Bulbapedia "Stat point"):
//   HP:    Base + StatPoints + 75
//   Other: floor((Base + StatPoints + 20) * Alignment)
function calcStat(base, sp, alignment, isHp) {
  const clampedSp = Math.min(SP_CAP_PER_STAT, Math.max(0, sp));
  if (isHp) return base + clampedSp + 75;
  return Math.floor((base + clampedSp + 20) * alignment);
}

// SP values where increasing by 1 does NOT increase the final stat — wasted
// investment. Only arises from the Alignment floor() truncation; a neutral (1.0)
// stat has no breakpoints at all since every +1 SP is a full +1 raw point.
function findBreakpoints(base, alignment, isHp) {
  const wasted = [];
  for (let sp = 1; sp <= SP_CAP_PER_STAT; sp++) {
    if (calcStat(base, sp, alignment, isHp) === calcStat(base, sp - 1, alignment, isHp)) {
      wasted.push(sp);
    }
  }
  return wasted;
}

// Round a raw target SP down to the lowest SP that still produces the same final
// stat as the target — eliminates SP wasted inside a breakpoint's dead zone.
function snapToBreakpoint(targetSp, base, alignment, isHp) {
  const clamped = Math.min(SP_CAP_PER_STAT, Math.max(0, Math.round(targetSp)));
  const targetStat = calcStat(base, clamped, alignment, isHp);
  let sp = clamped;
  while (sp - 1 >= 0 && calcStat(base, sp - 1, alignment, isHp) === targetStat) {
    sp -= 1;
  }
  return { sp, stat: targetStat };
}

// Binary search SP_STEPS for the smallest SP where calcStat(...) >= targetStat.
// Already breakpoint-aligned by construction — returns the first (lowest) SP that
// clears the target, same guarantee snapToBreakpoint provides for a known target SP.
function findMinSpForStat(targetStat, base, alignment, isHp) {
  if (calcStat(base, SP_CAP_PER_STAT, alignment, isHp) < targetStat) return null; // unreachable within the SP cap

  let lo = 0;
  let hi = SP_STEPS.length - 1;
  let best = SP_STEPS[hi];
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const stat = calcStat(base, SP_STEPS[mid], alignment, isHp);
    if (stat >= targetStat) {
      best = SP_STEPS[mid];
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return { sp: best, stat: calcStat(base, best, alignment, isHp) };
}

module.exports = {
  SP_CAP_PER_STAT,
  SP_BUDGET_TOTAL,
  SP_STEPS,
  spToEv,
  calcStat,
  findBreakpoints,
  snapToBreakpoint,
  findMinSpForStat,
  natureMultiplierFor,
};
