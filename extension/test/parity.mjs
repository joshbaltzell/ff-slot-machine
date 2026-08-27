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
import { shrinkProjections, CALIBRATION_K } from "../engine/calibrate.js";
import { Phi, phi, winProb, leverage } from "../engine/winprob.js";

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

/* ---- 4. positionLimits: an ESPN setting, applied as a filter on results ---- */
{
  // Give every fixture position an integer id, the way ESPN's defaultPositionId works.
  const POS_ID = Object.fromEntries([...new Set(F.pos)].map((p, i) => [p, i + 1]));
  const withIds = (limits) => ({
    ...model,
    settings: { ...model.settings, positionLimits: limits },
    players: new Map([...model.players].map(([id, p]) => [id, { ...p, posId: POS_ID[p.pos] }])),
  });
  const mk = (limits) => new Engine(withIds(limits), { starters },
    new Map(F.pos.map((p, i) => [i, masks[i]])));

  const free = mk(null);
  ok(free.legal(free.roster.get(F.teams[0])), "no limits: every roster is legal");

  // Cap RBs at exactly what the first team carries today. Any trade that hands
  // them one more RB without taking one away must vanish; nothing else may change.
  const team0 = F.teams[0];
  const rbCount = F.rosters[team0].filter((i) => F.pos[i] === "RB").length;
  const capped = mk({ [POS_ID.RB]: rbCount });
  ok(capped.legal(capped.roster.get(team0)), "a roster at the cap is legal");
  const rbIdx = F.rosters[team0].find((i) => F.pos[i] === "RB");
  const wrIdx = F.rosters[team0].find((i) => F.pos[i] === "WR");
  const extraRb = F.rosters[F.teams[1]].find((i) => F.pos[i] === "RB");
  ok(!capped.legal(capped.swap(capped.roster.get(team0), [wrIdx], [extraRb])),
     "WR out, RB in over the cap is illegal");
  ok(capped.legal(capped.swap(capped.roster.get(team0), [rbIdx], [extraRb])),
     "RB out, RB in stays legal");
  ok(capped.score([[team0, F.teams[1], [wrIdx]], [F.teams[1], team0, [extraRb]]], "1-for-1") === null,
     "score() returns null for an illegal trade");
  ok(capped.score([[team0, F.teams[1], [rbIdx]], [F.teams[1], team0, [extraRb]]], "1-for-1") !== null,
     "score() still scores a legal trade");

  const allFree = await free.findTwoTeam(1, 0.05);
  const allCapped = await capped.findTwoTeam(1, 0.05);
  ok(allFree.length === GOLDEN.length, "posId on players does not change the golden set");
  ok(allCapped.length < allFree.length, "the cap removes at least one trade");
  ok(allCapped.every((t) => t.sides.every((s) =>
       capped.legal(capped.swap(capped.roster.get(s.team), s.sent, s.received)))),
     "every surviving trade is legal for every side");
  const keyOf = (t) => JSON.stringify(t.sides.map((s) => [s.team, s.sent, s.received]));
  const kept = new Set(allCapped.map(keyOf));
  ok(allFree.filter((t) => !kept.has(keyOf(t))).every((t) => t.sides.some((s) =>
       !capped.legal(capped.swap(capped.roster.get(s.team), s.sent, s.received)))),
     "every removed trade was illegal for some side");
}

/* ---- 5. shrinkage: pull projections toward the positional mean ---- */
{
  const clone = () => new Map([...model.players].map(([id, p]) => [id, { ...p, proj: { ...p.proj } }]));
  const flat = (m) => [...m.values()].map((p) => F.weeks.map((w) => p.proj[w]));

  const same = clone();
  shrinkProjections(same, F.weeks, { RB: 1, WR: 1, TE: 1, QB: 1, TQB: 1 });
  ok(JSON.stringify(flat(same)) === JSON.stringify(flat(model.players)), "k = 1 is the identity");

  const half = clone();
  const r = shrinkProjections(half, F.weeks, { RB: 0.5 });
  ok(r.changed > 0, "reports how many players changed");
  const rbs = [...model.players.values()].filter((p) => p.pos === "RB");
  for (const w of F.weeks.slice(0, 3)) {
    const live = rbs.filter((p) => p.proj[w] > 0);
    const mean = live.reduce((a, p) => a + p.proj[w], 0) / live.length;
    for (const p of live) {
      const before = p.proj[w] - mean, after = half.get(p.id).proj[w] - mean;
      ok(Math.abs(after - before / 2) < 0.011, `RB deviation halved wk${w} p${p.id}`);
    }
    // order within the position is preserved
    const orderA = live.map((p) => p.id).sort((a, b) => model.players.get(b).proj[w] - model.players.get(a).proj[w]);
    const orderB = live.map((p) => p.id).sort((a, b) => half.get(b).proj[w] - half.get(a).proj[w]);
    ok(orderA.join() === orderB.join(), `RB order preserved wk${w}`);
    ok(rbs.filter((p) => !(p.proj[w] > 0)).every((p) => half.get(p.id).proj[w] === p.proj[w]),
       `bye zeros untouched wk${w}`);
  }
  const wr = [...model.players.values()].find((p) => p.pos === "WR");
  ok(half.get(wr.id).proj[F.weeks[0]] === wr.proj[F.weeks[0]], "positions absent from k are untouched");
  ok(CALIBRATION_K.QB === 0.67 && CALIBRATION_K.RB === 0.79 && CALIBRATION_K.WR === 0.85 && CALIBRATION_K.TE === 0.72,
     "literature slopes are the defaults");
}

/* ---- 6. win probability ---- */
{
  ok(Math.abs(Phi(0) - 0.5) < 1e-7, "Phi(0) = 0.5");
  ok(Math.abs(Phi(1.96) - 0.9750021) < 1e-5, "Phi(1.96)");
  ok(Math.abs(Phi(-1.96) - 0.0249979) < 1e-5, "Phi(-1.96)");
  ok(Math.abs(phi(0) - 0.3989423) < 1e-6, "phi(0)");
  ok(Math.abs(winProb(100, 20, 90, 20) + winProb(90, 20, 100, 20) - 1) < 1e-9, "winProb is symmetric");
  ok(winProb(100, 0, 90, 0) === 1 && winProb(90, 0, 100, 0) === 0 && winProb(90, 0, 90, 0) === 0.5,
     "zero sigma degenerates to a comparison");
  ok(leverage(100, 20, 100, 20) > leverage(130, 20, 100, 20), "a point is worth more in a close game");

  // Analytic P matches a Monte Carlo of the same normals.
  let seed = 12345;
  const lcg = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const g = () => { let u = 0, v = 0; while (!u) u = lcg(); while (!v) v = lcg();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  let wins = 0; const N = 200000;
  for (let i = 0; i < N; i++) if (105 + 22 * g() > 100 + 18 * g()) wins++;
  ok(Math.abs(wins / N - winProb(105, 22, 100, 18)) < 0.01, "analytic P matches Monte Carlo");

  // Schedule: pair teams 0-1, 2-3, ... every regular-season week.
  const sched = new Map();
  for (const w of model.settings.regularSeasonWeeks) {
    const games = [];
    for (let i = 0; i + 1 < F.teams.length; i += 2) games.push([F.teams[i], F.teams[i + 1]]);
    sched.set(w, games);
  }
  eng.setSchedule(sched);
  ok(eng.opp.get(F.teams[0])[0] === F.teams[1], "opponent lookup follows the schedule");
  const p = eng.weekWins([F.teams[0]], new Map()).get(F.teams[0]);
  const a = eng.baseline.get(F.teams[0])[0], b = eng.baseline.get(F.teams[1])[0];
  ok(Math.abs(p[0] - Phi((a - b) / (25 * Math.SQRT2))) < 1e-9,
     "without measured volatility, P uses the ±25 fallback for both sides");
  const q = eng.weekWins([F.teams[1]], new Map()).get(F.teams[1]);
  ok(Math.abs(p[0] + q[0] - 1) < 1e-9, "the two sides of a game sum to one");
  const lev = eng.weekLeverage(F.teams[0]);
  ok(lev.length === NW && lev[0] > 0 && lev[0] <= 1, "leverage is a positive density per point");

  // Playoff weeks have no scheduled game: all-play fallback, still a probability.
  ok(p[NW - 1] >= 0 && p[NW - 1] <= 1, "unscheduled week falls back to all-play");

  // enrich: a trade that moves nobody changes nothing.
  const nothing = eng.score([[F.teams[0], F.teams[1], []], [F.teams[1], F.teams[0], []]], "1-for-1");
  await eng.enrich([nothing]);
  ok(nothing.sides.every((s) => s.win === 0 && s.winWeekly.every((x) => x === 0)),
     "null trade has zero win delta");

  // enrich a real trade: win deltas exist, are bounded, and match the weekly sum.
  const real = (await eng.findTwoTeam(1, 0.05)).slice(0, 5);
  await eng.enrich(real);
  for (const t of real) for (const s of t.sides) {
    const regSum = s.winWeekly.reduce((acc, x, w) => acc + (eng.regMask[w] ? x : 0), 0);
    ok(Math.abs(s.win - regSum) < 1e-9, "win is the regular-season sum of winWeekly");
    ok(Math.abs(s.win) < model.settings.regularSeasonWeeks.length, "win delta is bounded by games");
  }
  eng.setSchedule(new Map());   // leave the shared engine as other sections expect
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("ENGINE OK — reproduces the verified baseline exactly");
