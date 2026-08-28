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
import { CORR, Z90, quantiles, buildDistribution, playerRange, cv, rho, isRealTeam,
         posFamily } from "../engine/distribution.js";

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

/* ---- 2. quantiles, ranges and the correlation table ---- */
{
  const S = [-10, -5, 0, 5, 10];
  const TO = { p10: -20, p50: 0, p90: 20 };

  // n = 0 is pure prior.
  const none = quantiles([], TO);
  ok(none.p10 === -20 && none.p50 === 0 && none.p90 === 20,
     "with no sample the quantiles are the positional ones");

  // n = 5, n0 = 10 -> weight 1/3 on the sample. Linear-interpolated sample
  // quantiles of [-10,-5,0,5,10] are -8, 0, 8, so the shrunk values are exactly
  // (1/3)(-8) + (2/3)(-20) = -16, 0, and +16.
  const five = quantiles(S, TO);
  near(five.p10, -16, 1e-9, "n = 5 shrinks a third of the way to the sample");
  near(five.p50, 0, 1e-12, "the median of a symmetric sample and prior is zero");
  near(five.p90, 16, 1e-9, "and symmetrically on the ceiling");

  // n -> infinity is the sample's own. 200 copies of S has sample quantiles
  // -10, 0, 10 (the interpolation lands inside a run of equal values), and a
  // weight of 1000/1010, so p90 = 10.0990099...
  const big = [];
  for (let k = 0; k < 200; k++) big.push(...S);
  const many = quantiles(big, TO);
  near(many.p90, 10.099009900990099, 1e-9, "a large sample all but ignores the prior");
  ok(Math.abs(many.p90 - 10) < Math.abs(five.p90 - 8),
     "and is closer to its own quantile than a small one is to hers");
  ok(many.p10 < many.p50 && many.p50 < many.p90, "quantiles stay ordered");

  // playerRange floors at zero and keeps its order.
  const dist = { of: new Map([[7, { p10: -10, p50: -1, p90: 12, n: 8 }]]),
                 byPos: new Map([["WR", { p10: -6, p50: 0, p90: 6 }]]),
                 global: { p10: -5, p50: 0, p90: 5 },
                 cvOf: new Map(), byPosCv: new Map(), n0: 10 };
  const low = playerRange({ id: 7, pos: "WR", proj: { 3: 3 } }, 3, dist);
  ok(low.floor === 0, "a floor below zero is zero - nobody scores negative points");
  near(low.median, 2, 1e-12, "the median is the projection plus the median residual");
  near(low.ceiling, 15, 1e-12, "and the ceiling the projection plus p90");
  ok(low.floor <= low.median && low.median <= low.ceiling, "floor <= median <= ceiling");

  const high = playerRange({ id: 7, pos: "WR", proj: { 3: 14 } }, 3, dist);
  near(high.floor, 4, 1e-12, "a bigger projection lifts the floor off zero");
  near(high.ceiling, 26, 1e-12, "and the ceiling with it");

  const unknown = playerRange({ id: 99, pos: "WR", proj: { 3: 10 } }, 3, dist);
  near(unknown.floor, 4, 1e-12, "a player with no residuals falls back to his position");
  const alien = playerRange({ id: 99, pos: "HC", proj: { 3: 10 } }, 3, dist);
  near(alien.floor, 5, 1e-12, "and a position with no pool falls back to the league");

  // The correlation table. Real pro teams only.
  const P = (pos, nfl) => ({ pos, nfl });
  ok(rho(P("TQB", "KC"), P("WR", "KC")) === CORR.qbToPass, "QB to his own WR");
  ok(rho(P("QB", "KC"), P("TE", "KC")) === CORR.qbToPass, "QB to his own TE");
  ok(rho(P("WR", "KC"), P("TE", "KC")) === CORR.sameTeam, "two non-QB teammates");
  ok(rho(P("RB", "KC"), P("WR", "KC")) === 0, "a RB is uncorrelated with anyone");
  ok(rho(P("RB", "KC"), P("RB", "KC")) === 0, "including another RB");
  ok(rho(P("QB", "KC"), P("K", "KC")) === 0, "QB to a non-receiver is not in the table");
  ok(rho(P("WR", "KC"), P("WR", "BUF")) === 0, "different teams, different games");
  ok(rho(P("WR", "KC"), P("WR", "BUF"), { sameGame: true }) === CORR.sameGame,
     "opponents in the same game pull apart");
  ok(rho(P("TQB", "X"), P("WR", "X")) === 0,
     "the fixture's placeholder team is never correlated - this is what keeps parity green");
  ok(rho(P("TQB", "?"), P("WR", "?")) === 0, "nor is an unknown team");
  ok(rho(P("D/ST", "FA"), P("WR", "FA")) === 0, "nor a free agent");
  ok(!isRealTeam("X") && !isRealTeam("?") && !isRealTeam("FA") && isRealTeam("KC"),
     "isRealTeam names exactly the three placeholders");
  ok(CORR.qbToPass === 0.25 && CORR.sameTeam === 0.10 && CORR.rb === 0
       && CORR.sameGame === -0.05,
     "the constants are the ones the spec fixed");
  ok(posFamily("TQB") === "QB" && posFamily("QB") === "QB" && posFamily("RB") === "RB"
       && posFamily("WR") === "PASS" && posFamily("TE") === "PASS"
       && posFamily("D/ST") === "OTHER" && posFamily("K") === "OTHER",
     "a team quarterback is a quarterback; a kicker is neither passer nor runner");
  ok(Z90 > 1.28 && Z90 < 1.282, "z90 is the tenth-percentile normal deviate");

  // buildDistribution wires the three tiers together.
  //
  // Three WR players feed the positional CV pool so the prior is a genuine
  // median distinct from any one player's own raw CV: raw CVs (sigma / mean
  // projection) are player 1 = 6/10 = 0.6, player 2 = 4/10 = 0.4 and player 3
  // (measured only, never in `residuals`) = 5/10 = 0.5. Sorted [0.4, 0.5, 0.6]
  // medians to exactly 0.5 - equidistant (±0.1) from both players 1 and 2, so
  // the only thing that can move either player's shrunk CV off that midpoint
  // is the shrinkage weight n/(n+n0), not how far their own CV sits from it.
  {
    const vol = {
      bySigma: new Map([[1, 6], [2, 4], [3, 5]]),
      byPos: new Map([["WR", 6]]),
      global: 6,
      measured: 1,
      residuals: new Map([[1, [-6, -3, 0, 3, 6]], [2, [-2, 2]]]),
      byPosResiduals: new Map([["WR", [-6, -3, 0, 3, 6]]]),
    };
    const players = new Map([
      [1, { id: 1, pos: "WR", nfl: "KC", proj: { 1: 10, 2: 10, 3: 0 } }],
      [2, { id: 2, pos: "WR", nfl: "KC", proj: { 1: 10, 2: 10, 3: 0 } }],
      [3, { id: 3, pos: "WR", nfl: "KC", proj: { 1: 10, 2: 10, 3: 0 } }],
    ]);
    const d = buildDistribution(vol, players);
    ok(d.of.get(1).n === 5, "the sample size rides along");
    ok(d.byPos.has("WR"), "the positional prior is built from the pooled residuals");
    ok(d.of.get(2).p90 < d.of.get(1).p90,
       "a two-week sample is pulled harder toward a wider prior than a five-week one");
    ok(d.global.p10 < 0 && d.global.p90 > 0, "the league-wide prior exists as a last resort");
    ok(cv(players.get(1), d) > 0, "a measured player has a coefficient of variation");

    near(d.byPosCv.get("WR"), 0.5, 1e-9,
         "the WR prior is the median raw CV of 0.6, 0.4 and 0.5 - i.e. 0.5");

    // Player 1: 5 residual weeks, n0 = 10 -> weight 5/15 = 1/3 on his own 0.6.
    // (1/3)(0.6) + (2/3)(0.5) = 8/15.
    near(cv(players.get(1), d), 8 / 15, 1e-9,
         "shrunk a third of the way from the 0.5 prior to his own 0.6 CV");

    // Player 2: 2 residual weeks -> weight 2/12 = 1/6 on his own 0.4.
    // (1/6)(0.4) + (5/6)(0.5) = 29/60.
    near(cv(players.get(2), d), 29 / 60, 1e-9,
         "and player 2, with only two weeks, shrinks by the smaller weight 1/6");

    ok(Math.abs(cv(players.get(2), d) - d.byPosCv.get("WR")) <
       Math.abs(cv(players.get(1), d) - d.byPosCv.get("WR")),
       "fewer measured weeks (2) lands closer to the positional prior than more (5) - " +
       "same 0.1 distance from the prior on each raw CV, so only the weight can explain it");

    ok(cv({ id: 404, pos: "WR" }, d) === d.byPosCv.get("WR"),
       "an unmeasured player falls back to his position's");
    ok(cv({ id: 404, pos: "HC" }, d) === 0, "and to zero when even that is missing");
  }
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("DISTRIBUTIONS OK");
