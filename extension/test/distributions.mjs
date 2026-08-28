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
         posFamily, attachCovariance, stacks, lineupRange } from "../engine/distribution.js";
import { gameplan, lineupStats, feasible } from "../engine/gameplan.js";

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

/* ---- 3. stack covariance ---- */
{
  // Team A's roster is fixture indices 0..15 and its week-1 starters are
  // 1 (TQB), 2 (RB), 3 (RB), 6 (WR), 7 (WR), 8 (WR), 10 (TE), 13 (D/ST), 14 (K).
  // With a uniform sigma of 10 across nine starters the independent spread is
  // sqrt(9 * 100) = 30 exactly, which makes every closed form below readable.
  const T0 = F.teams[0];
  const uniform = { bySigma: new Map(F.pos.map((_, i) => [i, 10])),
                    byPos: new Map(), global: 10, measured: F.pos.length,
                    residuals: new Map(), byPosResiduals: new Map() };
  const build = (nflOf) => {
    const m = mkModel(nflOf);
    const e = mkEngine(m);
    e.setVolatility(uniform);
    return { e, m };
  };
  const WK0 = [1, 2, 3, 6, 7, 8, 10, 13, 14];

  {
    const { e } = build(() => "X");
    const sm = e.starterMask(e.roster.get(T0));
    ok([...sm].filter(([, mm]) => mm[0]).map(([i]) => i).join(",") === WK0.join(","),
       "the fixture's week-1 starters are the nine this block reasons about");
    near(e.rosterSigma(e.roster.get(T0))[0], 30, 1e-9,
         "nine starters at sigma 10 are sqrt(900) with no correlation attached");
  }

  // The parity guard. Every fixture player is on "X", so attaching covariance to a
  // fixture engine must change nothing at all.
  {
    const { e, m } = build(() => "X");
    const before = Array.from(e.rosterSigma(e.roster.get(T0)));
    attachCovariance(e, m.players);
    const after = Array.from(e.rosterSigma(e.roster.get(T0)));
    ok(before.every((x, i) => Math.abs(x - after[i]) < 1e-12),
       "covariance attached to an all-\"X\" league is the independent value - the parity guard");
    ok(e.stacks(e.roster.get(T0), 0).length === 0,
       "and it reports no stacks");
  }

  // QB + WR on the same real team: sqrt(900 + 2 * 0.25 * 10 * 10) = sqrt(950).
  {
    const { e, m } = build((i) => (i === 1 || i === 6 ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], Math.sqrt(950), 1e-9,
         "a QB-WR stack widens the spread by exactly the closed form");
    const st = e.stacks(e.roster.get(T0), 0);
    ok(st.length === 1, "and the pair is listed once, not twice");
    ok(st[0].a === 1 && st[0].b === 6 && st[0].rho === CORR.qbToPass,
       "with the lower index first and the table's own value");
    ok(st[0].nfl === "KC" && st[0].label === "QB+WR", "and enough to render a flag");
  }

  // Two non-QB teammates: sqrt(900 + 2 * 0.10 * 100) = sqrt(920).
  {
    const { e, m } = build((i) => (i === 6 || i === 7 ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], Math.sqrt(920), 1e-9,
         "two receivers on one team are the non-QB constant");
  }

  // Three receivers: three pairs, sqrt(900 + 6 * 0.10 * 100) = sqrt(960).
  {
    const { e, m } = build((i) => ([6, 7, 8].includes(i) ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], Math.sqrt(960), 1e-9,
         "three teammates are three pairs, not two");
    ok(e.stacks(e.roster.get(T0), 0).length === 3, "and three stack rows");
  }

  // The whole passing game: 3 QB-WR pairs at .25 and 3 WR-WR pairs at .10.
  {
    const { e, m } = build((i) => ([1, 6, 7, 8].includes(i) ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], Math.sqrt(1110), 1e-9,
         "a QB with his three receivers is 900 + 150 + 60");
  }

  // A running back is uncorrelated with everybody, teammates included.
  {
    const { e, m } = build((i) => ([2, 3, 6].includes(i) ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], 30, 1e-9,
         "two RBs and a WR on one team add nothing - the RB rule overrides");
    ok(e.stacks(e.roster.get(T0), 0).length === 0, "and there is no stack to flag");
  }

  // A bench player on the same team is not a starter and must not count.
  {
    const { e, m } = build((i) => ([1, 0].includes(i) ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], 30, 1e-9,
         "a benched teammate contributes no covariance - only starters do");
  }

  // Cross-game, through the injected lookup. Without gameOf the term is skipped.
  {
    const { e, m } = build((i) => (i === 1 ? "KC" : i === 6 ? "BUF" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], 30, 1e-9,
         "with no schedule of pro games the cross-game term is skipped");

    const { e: e2, m: m2 } = build((i) => (i === 1 ? "KC" : i === 6 ? "BUF" : "X"));
    attachCovariance(e2, m2.players, {
      gameOf: (nfl, week) => (week === 1 && (nfl === "KC" || nfl === "BUF") ? "KC@BUF" : null),
    });
    near(e2.rosterSigma(e2.roster.get(T0))[0], Math.sqrt(890), 1e-9,
         "opponents in one game pull the spread in");
    near(e2.rosterSigma(e2.roster.get(T0))[1], 30, 1e-9,
         "and only in the week they actually meet");
  }

  // Availability composes: p = 0.5 on every starter halves the variance, correlated
  // or not, because the covariance term uses the same sqrt(p) * sigma deviations.
  {
    const { e, m } = build((i) => (i === 1 || i === 6 ? "KC" : "X"));
    attachCovariance(e, m.players);
    const plain = e.rosterSigma(e.roster.get(T0))[0];
    const half = new Map(e.roster.get(T0).map((i) => {
      const row = new Float64Array(NW).fill(1);
      if (WK0.includes(i)) row[0] = 0.5;
      return [e.ids[i], row];
    }));
    const { e: e3, m: m3 } = build((i) => (i === 1 || i === 6 ? "KC" : "X"));
    e3.setAvailability(half);
    attachCovariance(e3, m3.players);
    near(e3.rosterSigma(e3.roster.get(T0))[0], plain / Math.SQRT2, 1e-9,
         "p = 0.5 halves the variance of the correlated spread too");
  }

  // lineupRange puts the team total on a normal, which is the honest shape for a sum.
  {
    const { e, m } = build((i) => (i === 1 || i === 6 ? "KC" : "X"));
    attachCovariance(e, m.players);
    const r = lineupRange(e, e.roster.get(T0), 0);
    const mu = e.baseline.get(T0)[0];
    near(r.median, mu, 1e-9, "the centre of the team range is the lineup's mean");
    near(r.ceiling - r.median, Z90 * Math.sqrt(950), 1e-9,
         "and the ceiling is z90 sigmas above it, correlation included");
    near(r.median - r.floor, Z90 * Math.sqrt(950), 1e-9, "symmetrically below");
    ok(r.floor >= 0, "a team floor is never negative");
  }
}

/* ---- 4. the weekly P(win) lineup ---- */
{
  // A two-team, one-week, one-seat league, so every number below is checkable by
  // hand. Team A may start one RB: a steady 10 or a wild 8.
  const tiny = (opts) => {
    const { slots: sl, starters: st } = buildSlots(opts.slotCounts);
    const model = {
      weeks: [1],
      settings: { currentWeek: 1, regularSeasonWeeks: [1], playoffWeeks: [],
                  playoffRoundWeeks: [], playoffTeams: 2, playoffReseed: false,
                  lineupSlotCounts: opts.slotCounts },
      players: new Map(opts.players.map((p) => [p.id, {
        ...p, proj: { 1: p.p }, bye: 0,
      }])),
      teams: new Map([
        [0, { id: 0, name: "Team A", roster: new Set(opts.a) }],
        [1, { id: 1, name: "Team B", roster: new Set(opts.b) }],
      ]),
    };
    const mk = new Map(opts.players.map((p) => [p.id, seatMask(p.eligibleSlots, sl)]));
    const e = new Engine(model, { starters: st }, mk);
    e.setVolatility({ bySigma: new Map(opts.players.map((p) => [p.id, p.s])),
                      byPos: new Map(), global: 10, measured: opts.players.length,
                      residuals: new Map(), byPosResiduals: new Map() });
    attachCovariance(e, model.players);
    e.setSchedule(new Map([[1, [["Team A", "Team B"]]]]));
    return { e, model };
  };
  const RB = [2, 20], WR = [4, 20];

  // Trailing badly: the wild lineup is worth 14.6 percentage points.
  {
    const { e } = tiny({
      slotCounts: { "2": 1 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 10, s: 2 },
                { id: 1, pos: "RB", nfl: "X", eligibleSlots: RB, p: 8, s: 12 },
                { id: 2, pos: "RB", nfl: "X", eligibleSlots: RB, p: 20, s: 5 }],
      a: [0, 1], b: [2],
    });
    const gp = gameplan(e, "Team A", 0);
    ok(gp.opponent === "Team B", "the plan names the scheduled opponent");
    near(gp.pWinMean, 0.031658830926, 1e-9,
         "the mean-optimal lineup is a 3.2% shot against a 20-point favourite");
    near(gp.pWinBest, 0.177983534902, 1e-9,
         "and the high-variance lineup is a 17.8% shot");
    ok(gp.swaps.length === 1, "one swap gets there");
    ok(gp.swaps[0].out === 0 && gp.swaps[0].in === 1,
       "the steady 10 comes out for the wild 8");
    near(gp.swaps[0].dP, 0.146324703976, 1e-9, "and it is worth 14.6 points of win probability");
    ok(gp.lineupMean.join(",") === "0" && gp.lineupBest.join(",") === "1",
       "both lineups are reported");
    ok(gp.me.ceiling > gp.me.median && gp.me.median > gp.me.floor,
       "the range is ordered");
    ok(gp.them.median > gp.me.median, "and the favourite's centre is above ours");
  }

  // Leading comfortably: variance is now the enemy and nothing moves.
  {
    const { e } = tiny({
      slotCounts: { "2": 1 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 10, s: 2 },
                { id: 1, pos: "RB", nfl: "X", eligibleSlots: RB, p: 8, s: 12 },
                { id: 2, pos: "RB", nfl: "X", eligibleSlots: RB, p: 2, s: 5 }],
      a: [0, 1], b: [2],
    });
    const gp = gameplan(e, "Team A", 0);
    near(gp.pWinMean, 0.931302555604, 1e-9, "a heavy favourite wins 93% of the time");
    ok(gp.swaps.length === 0, "and never trades that away for a swingier lineup");
    ok(gp.pWinBest === gp.pWinMean, "so the best plan is the mean-optimal one");
    ok(gp.lineupBest.join(",") === gp.lineupMean.join(","), "and the same lineup");
  }

  // Legality: a swap that cannot be seated is never offered. One RB seat and one WR
  // seat; swapping the RB out for a second WR would leave the RB seat empty.
  {
    const { e } = tiny({
      slotCounts: { "2": 1, "4": 1 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 10, s: 2 },
                { id: 1, pos: "WR", nfl: "X", eligibleSlots: WR, p: 9, s: 3 },
                { id: 2, pos: "WR", nfl: "X", eligibleSlots: WR, p: 8, s: 14 },
                { id: 3, pos: "RB", nfl: "X", eligibleSlots: RB, p: 30, s: 5 }],
      a: [0, 1, 2], b: [3],
    });
    ok(feasible(e, [0, 1]), "a RB and a WR fill a RB seat and a WR seat");
    ok(!feasible(e, [1, 2]), "two WRs cannot fill a RB seat");
    const gp = gameplan(e, "Team A", 0);
    ok(gp.swaps.every((s) => s.out !== 0),
       "the RB is never swapped out for a second WR - the lineup would be illegal");
    near(gp.pWinMean, 0.037176402015, 1e-9, "the mean-optimal lineup's odds");
    near(gp.pWinBest, 0.211855333665, 1e-9, "and the best legal lineup's");
  }

  // P(win) never decreases across accepted swaps, and the search terminates.
  {
    const { e } = tiny({
      slotCounts: { "2": 2 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 12, s: 1 },
                { id: 1, pos: "RB", nfl: "X", eligibleSlots: RB, p: 11, s: 2 },
                { id: 2, pos: "RB", nfl: "X", eligibleSlots: RB, p: 9, s: 18 },
                { id: 3, pos: "RB", nfl: "X", eligibleSlots: RB, p: 8, s: 20 },
                { id: 4, pos: "RB", nfl: "X", eligibleSlots: RB, p: 60, s: 4 }],
      a: [0, 1, 2, 3], b: [4],
    });
    const gp = gameplan(e, "Team A", 0);
    ok(gp.swaps.every((s) => s.dP > 0), "every accepted swap strictly raised P(win)");
    ok(gp.pWinBest >= gp.pWinMean, "so the plan is never worse than the mean lineup");
    near(gp.pWinBest - gp.pWinMean,
         gp.swaps.reduce((a, s) => a + s.dP, 0), 1e-9,
         "and the deltas sum to the total gain");
    ok(gp.lineupBest.length === gp.lineupMean.length,
       "a swap keeps the lineup the same size");
    ok(feasible(e, gp.lineupBest), "and legal");
  }

  // lineupStats agrees with rosterSigma on the lineup rosterSigma would pick.
  {
    const T0 = F.teams[0];
    const m = mkModel((i) => ([1, 6, 7].includes(i) ? "KC" : "X"));
    const e = mkEngine(m);
    e.setVolatility({ bySigma: new Map(F.pos.map((_, i) => [i, 10])), byPos: new Map(),
                      global: 10, measured: F.pos.length,
                      residuals: new Map(), byPosResiduals: new Map() });
    attachCovariance(e, m.players);
    const sm = e.starterMask(e.roster.get(T0));
    const on = [...sm].filter(([, mm]) => mm[0]).map(([i]) => i);
    near(lineupStats(e, on, 0).sigma, e.rosterSigma(e.roster.get(T0))[0], 1e-9,
         "the two spread calculations agree on the optimal lineup - a drift guard");
    near(lineupStats(e, on, 0).mu, e.baseline.get(T0)[0], 1e-9,
         "and so do the means");
  }

  // No opponent, no plan.
  {
    const { e } = tiny({
      slotCounts: { "2": 1 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 10, s: 2 },
                { id: 2, pos: "RB", nfl: "X", eligibleSlots: RB, p: 9, s: 5 }],
      a: [0], b: [2],
    });
    e.setSchedule(new Map());
    ok(gameplan(e, "Team A", 0) === null,
       "with nobody to play there is no gameplan");
    const bare = mkEngine(mkModel());
    ok(gameplan(bare, F.teams[0], 0) === null,
       "and with no measured volatility there is none either");
  }
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("DISTRIBUTIONS OK");
