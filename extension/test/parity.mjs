/**
 * Regression tests for the engine.
 *
 * `fixture.json` is a frozen snapshot of a real ten-team league with names removed.
 * Its `baseline` values and `golden_1for1.json` were produced by an independent
 * Python implementation of the same rules and verified against it line for line -
 * 360 lineup assertions and 49 trades matching to six decimal places. That
 * implementation has since been retired, so these files are now the contract: if
 * the engine stops reproducing them, the engine changed.
 *
 * A caveat worth knowing before editing them: because the second implementation is
 * gone, these numbers can no longer be re-derived independently. Treat a mismatch
 * as a bug in the engine, and regenerate the fixtures only when you have decided
 * deliberately that the new behaviour is correct.
 *
 *   node extension/test/parity.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSlots, seatMask, bestLineup } from "../engine/lineup.js";
import { Engine, dedupe } from "../engine/search.js";
import { projectSeason } from "../engine/season.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(here, "golden_1for1.json")));
const NW = F.weeks.length;

const { slots, starters } = buildSlots(F.lineupSlotCounts);
const masks = F.pos.map((p) => seatMask(F.eligibleSlots[p], slots));

let checks = 0, failures = 0;
const ok = (cond, what) => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}`); }
};

/* ---- 1. lineup solver ---- */
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

console.log(`slots: ${starters} starters/week  [${[...slots].join(", ")}]`);
for (const team of F.teams) {
  const js = weekly(F.rosters[team]);
  const frozen = F.baseline[team];
  for (let w = 0; w < NW; w++)
    ok(Math.abs(js[w] - frozen[w]) < 1e-6, `${team} wk${F.weeks[w]}`);
}

/* ---- 2. engine, trades and shapes ---- */
const model = {
  weeks: F.weeks,
  settings: {
    regularSeasonWeeks: F.weeks.filter((w) => w <= 14),
    playoffWeeks: [15, 16, 17],
    playoffRoundWeeks: [[15], [16], [17]],
    playoffTeams: 6,
    playoffReseed: true,
    lineupSlotCounts: F.lineupSlotCounts,
  },
  players: new Map(F.pos.map((pos, i) => [i, {
    id: i, name: `p${i}`, pos, nfl: "X", eligibleSlots: F.eligibleSlots[pos],
    bye: F.weeks.find((w) => !(F.proj[i][F.weeks.indexOf(w)] > 0)) ?? 0,
    proj: Object.fromEntries(F.weeks.map((w, k) => [w, F.proj[i][k]])),
  }])),
  teams: new Map(F.teams.map((name, ti) => [ti, { id: ti, name, roster: new Set(F.rosters[name]) }])),
};
const eng = new Engine(model, { starters }, new Map(F.pos.map((p, i) => [i, masks[i]])));

for (const t of F.teams)
  for (let w = 0; w < NW; w++)
    ok(Math.abs(eng.baseline.get(t)[w] - F.baseline[t][w]) < 1e-6, `engine baseline ${t}`);

const key = (list) => JSON.stringify(list
  .map((t) => t.sides.map((s) => [s.team, s.sent.slice().sort((a, b) => a - b),
                                  Math.round(s.gain * 1e6) / 1e6])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));

const one = await eng.findTwoTeam(1, 0.05);
ok(one.length === GOLDEN.length, `1-for-1 count ${one.length} vs ${GOLDEN.length}`);
ok(key(one) === JSON.stringify(GOLDEN.slice().sort(
  (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))), "1-for-1 set matches golden");
ok(one.every((t) => t.sides.every((s) => s.gain > 0)), "every reported trade helps every side");

const three = await eng.findThreeWay(0.05);
ok(three.length === 92, `three-way count ${three.length} vs 92`);
ok(three.every((t) => t.sides.length === 3), "three-way has three sides");
ok(three.every((t) => {
  const sent = new Set(t.sides.map((s) => s.sent[0]));
  const recv = new Set(t.sides.map((s) => s.received[0]));
  return sent.size === 3 && [...sent].every((p) => recv.has(p));
}), "three-way is a true cycle");
ok(dedupe(three, 3).length === 46, `three-way dedupe ${dedupe(three, 3).length} vs 46`);

/* ---- 3. season simulation invariants ---- */
const proj = projectSeason(eng, new Map(), model.settings, { sims: 6000 });
const sum = (k) => proj.reduce((a, r) => a + r[k], 0);
ok(Math.abs(sum("wins") - (F.teams.length * 14) / 2) < 1e-6, "wins sum to games/2");
ok(Math.abs(sum("playoffPct") - 6) < 1e-6, "playoff odds sum to the bracket size");
ok(Math.abs(sum("byePct") - 2) < 1e-6, "bye odds sum to the number of byes");
ok(Math.abs(sum("titlePct") - 1) < 1e-6, "exactly one champion per season");

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("ENGINE OK — reproduces the verified baseline exactly");
