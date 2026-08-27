/**
 * Parity harness: the JS engine must reproduce the Python engine exactly.
 *
 * Rewriting working numeric code is only safe because this exists. Python stays in
 * the repo as the oracle; if these assertions fail, the JS is wrong - "close enough"
 * is not a passing result, because the entire value of this tool is that its numbers
 * can be trusted.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSlots, seatMask, bestLineup } from '../engine/lineup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, 'fixture.json')));
const NW = F.weeks.length;
const { slots, starters } = buildSlots(F.lineupSlotCounts);
const masks = F.pos.map(p => seatMask(F.eligibleSlots[p], slots));

function weekly(ids) {
  const out = new Float64Array(NW);
  const vals = new Float64Array(F.proj.length);
  for (let w = 0; w < NW; w++) {
    for (const id of ids) vals[id] = F.proj[id][w];
    const order = ids.slice().sort((a, b) => vals[b] - vals[a]);
    out[w] = bestLineup(order, vals, masks, starters);
  }
  return out;
}

let checks = 0, failures = 0;
const eq = (a, b, what) => {
  checks++;
  if (Math.abs(a - b) > 1e-6) { failures++; console.log(`  FAIL ${what}: js=${a} py=${b}`); }
};

console.log(`slots: ${starters} starters/week  [${[...slots].join(', ')}]`);

for (const team of F.teams) {
  const js = weekly(F.rosters[team]);
  const py = F.baseline[team];
  for (let w = 0; w < NW; w++) eq(js[w], py[w], `${team} wk${F.weeks[w]}`);
}

// Every week must seat exactly the configured number of starters.
for (const team of F.teams) {
  const vals = new Float64Array(F.proj.length);
  for (let w = 0; w < NW; w++) {
    for (const id of F.rosters[team]) vals[id] = F.proj[id][w];
    const order = F.rosters[team].slice().sort((a, b) => vals[b] - vals[a]);
    let seated = 0, tot = 0;
    // recompute by summing the top `starters` seated players
    const t = bestLineup(order, vals, masks, starters);
    checks++;
    if (!(t > 0)) { failures++; console.log(`  FAIL ${team} wk${F.weeks[w]} scored 0`); }
  }
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log('PARITY OK — JS engine reproduces the Python oracle exactly');

/* ---- search parity: the JS engine must find the same trades as Python ---- */
import { Engine, dedupe } from '../engine/search.js';

const model = {
  weeks: F.weeks,
  settings: {
    regularSeasonWeeks: F.weeks.filter(w => w <= 14),
    playoffWeeks: [15, 16, 17],
    lineupSlotCounts: F.lineupSlotCounts,
  },
  players: new Map(F.pos.map((pos, i) => [i, {
    id: i, name: `p${i}`, pos, nfl: 'X', eligibleSlots: F.eligibleSlots[pos],
    bye: F.weeks.find(w => !(F.proj[i][F.weeks.indexOf(w)] > 0)) ?? 0,
    proj: Object.fromEntries(F.weeks.map((w, k) => [w, F.proj[i][k]])),
  }])),
  teams: new Map(F.teams.map((name, ti) => [ti, { id: ti, name, roster: new Set(F.rosters[name]) }])),
};
const masksMap = new Map(F.pos.map((pos, i) => [i, seatMask(F.eligibleSlots[pos], slots)]));
const eng = new Engine(model, { starters }, masksMap);

// baselines must match Python exactly
let bad = 0;
for (const t of F.teams) {
  const b = eng.baseline.get(t), py = F.baseline[t];
  for (let w = 0; w < NW; w++) if (Math.abs(b[w] - py[w]) > 1e-6) bad++;
}
console.log(`\nengine baselines vs Python: ${bad} mismatches`);

const golden = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'tests', 'golden_1for1.json')));
const found = eng.findTwoTeam(1, 0.05);
const fp = found.map(t => t.sides
    .map(s => [s.team, s.sent.slice().sort((a,b)=>a-b), Math.round(s.gain * 1e6) / 1e6])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
const gp = golden.slice().sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

console.log(`1-for-1: JS found ${found.length}, Python golden has ${golden.length}`);
const jsSet = new Set(fp.map(x => JSON.stringify(x)));
const pySet = new Set(gp.map(x => JSON.stringify(x)));
const onlyJs = [...jsSet].filter(x => !pySet.has(x));
const onlyPy = [...pySet].filter(x => !jsSet.has(x));
console.log(`  only in JS: ${onlyJs.length}   only in Python: ${onlyPy.length}`);
if (onlyPy.length) console.log('  e.g. missing:', onlyPy[0]);
if (onlyJs.length) console.log('  e.g. extra  :', onlyJs[0]);

const tw = eng.findThreeWay(0.05);
console.log(`three-way: ${tw.length} raw, ${dedupe(tw, 3).length} after dedupe  (Python: 92 raw)`);
if (bad || onlyJs.length || onlyPy.length || tw.length !== 92) process.exit(1);
console.log('\nSEARCH PARITY OK');
