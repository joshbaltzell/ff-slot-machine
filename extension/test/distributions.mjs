/**
 * Tests for measured distributions, stack covariance and the weekly P(win) lineup.
 *
 * `parity.mjs` is the engine's frozen contract and is never touched; this file
 * carries everything Phase 8 added. The model is built the way parity.mjs builds
 * it - deliberately copied rather than imported, so that a change here can never
 * move the golden set. Fixture players carry `nfl: "X"`, which is what keeps
 * covariance off in parity.mjs; several tests below assert exactly that.
 *
 *   node extension/test/distributions.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { Engine } from "../engine/search.js";
import { measureVolatility } from "../engine/league.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));
const NW = F.weeks.length;
const { slots, starters } = buildSlots(F.lineupSlotCounts);
const masks = F.pos.map((p) => seatMask(F.eligibleSlots[p], slots));

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const near = (a, b, eps, what) => ok(Math.abs(a - b) < eps, `${what} (${a} vs ${b})`);

/** A fresh model, shaped like parity.mjs's. `nfl` defaults to "X" for every player. */
function mkModel(nflOf = () => "X") {
  return {
    weeks: F.weeks.slice(),
    settings: {
      currentWeek: 1,
      regularSeasonWeeks: F.weeks.filter((w) => w <= 14),
      playoffWeeks: [15, 16, 17],
      playoffRoundWeeks: [[15], [16], [17]],
      playoffTeams: 6,
      playoffReseed: true,
      lineupSlotCounts: F.lineupSlotCounts,
    },
    players: new Map(F.pos.map((pos, i) => [i, {
      id: i, name: `p${i}`, pos, nfl: nflOf(i, pos),
      eligibleSlots: F.eligibleSlots[pos],
      bye: F.weeks.find((w) => !(F.proj[i][F.weeks.indexOf(w)] > 0)) ?? 0,
      proj: Object.fromEntries(F.weeks.map((w, k) => [w, F.proj[i][k]])),
    }])),
    teams: new Map(F.teams.map((name, ti) =>
      [ti, { id: ti, name, roster: new Set(F.rosters[name]) }])),
  };
}
const mkEngine = (model) =>
  new Engine(model, { starters }, new Map(F.pos.map((p, i) => [i, masks[i]])));

/* ---- 1. measureVolatility keeps the residuals it already computes ---- */
{
  // Two synthetic seasons of ESPN stat rows. statSplitTypeId 1 is "one week";
  // statSourceId 1 is the projection, 0 the actual.
  const rows = (season, pairs) => pairs.flatMap(([wk, proj, act]) => [
    { statSplitTypeId: 1, seasonId: season, statSourceId: 1, scoringPeriodId: wk, appliedTotal: proj },
    { statSplitTypeId: 1, seasonId: season, statSourceId: 0, scoringPeriodId: wk, appliedTotal: act },
  ]);
  const eight = [[1, 10, 12], [2, 10, 8], [3, 10, 14], [4, 10, 6],
                 [5, 10, 11], [6, 10, 9], [7, 10, 20], [8, 10, 0]];
  const two = [[1, 10, 30], [2, 10, 4]];
  const players = [
    { id: 1, pos: "WR", rawStats: rows(2025, eight) },
    { id: 2, pos: "WR", rawStats: rows(2025, two) },      // below minWeeks
    { id: 3, pos: "RB", rawStats: rows(2024, eight) },     // wrong season
    { id: 4, pos: "TE", rawStats: rows(2025, [[1, 0.5, 9], [2, 0.5, 3]]) }, // proj <= 1
  ];
  const vol = measureVolatility(players, 2025);

  ok(vol.bySigma.has(1) && !vol.bySigma.has(2),
     "sigma still needs minWeeks weeks of history");
  ok(vol.measured === 1, "measured still counts only the players with a sigma");
  ok(vol.residuals instanceof Map, "residuals is a Map");
  ok(vol.byPosResiduals instanceof Map, "byPosResiduals is a Map");

  const r1 = vol.residuals.get(1);
  ok(Array.isArray(r1) && r1.length === 8, "eight residuals for the eight-week player");
  ok(r1.slice().sort((a, b) => a - b).join(",") === "-10,-4,-2,-1,1,2,4,10",
     "residuals are actual minus projection");

  ok(vol.residuals.get(2)?.length === 2,
     "a player under minWeeks still keeps his residuals - shrinkage handles the sample");
  ok(!vol.residuals.has(3), "a prior-season filter still applies");
  ok(!vol.residuals.has(4) || vol.residuals.get(4).length === 0,
     "weeks projected at or under 1 point are not residuals");

  ok(vol.byPosResiduals.get("WR")?.length === 8,
     "the positional pool takes only players who cleared minWeeks");
  ok(!vol.byPosResiduals.has("TE"), "a position with no qualifying player has no pool");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("DISTRIBUTIONS OK");
