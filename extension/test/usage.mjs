/**
 * Tests for Phase 6 (usage): the Sleeper weekly stats feed, the usage arithmetic,
 * the sell-high / buy-low selection, breakouts, the crowd split, FAAB bids and the
 * panel helpers - all offline, with fetch, storage and the clock injected.
 *
 *   node extension/test/usage.mjs
 */
import { weekUrl, trimStats, loadWeekStats, loadSeasonStats, STAT_FIELDS }
  from "../engine/sources/sleeperstats.js";
import { USAGE_K, DRIVER, quantile, ptsKeyFor, usageTable,
         assetRows, breakouts, depthChanges, crowdSplit, bestOfferFor }
  from "../engine/usage.js";
import { FAAB_K, offRound, faabBids } from "../engine/faab.js";
import { readSettings } from "../engine/league.js";
import { USAGE_HINT, usageOrNull, usageView, ownersOf, assetsSection, breakoutSection,
         waiverView, faCrowdCols, faCrowdCells } from "../panel/usage.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const near = (a, b, e = 1e-9) => a != null && Math.abs(a - b) <= e;

/* Injection helpers, same shape as sources.mjs and market.mjs. */
const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; }, async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const mkFetch = (table) => { const calls = []; const f = async (url) => { calls.push(url);
  const hit = table[url]; if (!hit) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; }; f.calls = calls; return f; };
const deadFetch = () => { const f = async () => { throw new Error("network down"); }; f.calls = []; return f; };
const stuckFetch = () => { const f = () => new Promise(() => {}); f.calls = []; return f; };

/* ---- 1. the Sleeper weekly stats feed ---- */
{
  const url = weekUrl(2026, 3);
  ok(url === "https://api.sleeper.app/stats/nfl/2026/3?season_type=regular"
     + "&position[]=QB&position[]=RB&position[]=WR&position[]=TE",
     "the week URL is built exactly as the spec names it");

  const arrForm = [
    { player_id: "s1", team: "AAA",
      stats: { off_snp: 54, tm_off_snp: 60, rec_tgt: 16, pts_ppr: 20, junk: 9 } },
    { player: { player_id: "s2", team: "BBB" }, stats: { off_snp: 30, tm_off_snp: 60 } },
    { player_id: "s3", stats: {} },
  ];
  const a = trimStats(arrForm);
  ok(a.length === 2, "an entry with no usable stat is dropped");
  ok(a[0].player_id === "s1" && a[0].off_snp === 54 && a[0].team === "AAA",
     "the array shape is read, with the team carried");
  ok(!("junk" in a[0]), "unknown fields are trimmed away");
  ok(a[1].player_id === "s2" && a[1].team === "BBB",
     "a nested player object supplies the id and the team");

  const mapForm = { s1: { off_snp: 54, tm_off_snp: 60, rec_tgt: 16, junk: 1 },
                    s2: { stats: { off_snp: 30 }, team: "BBB" } };
  const b = trimStats(mapForm);
  ok(b.length === 2 && b[0].player_id === "s1" && b[0].rec_tgt === 16,
     "the object-map shape reads the same, so a feed reshape does not empty the table");
  ok(b[1].team === "BBB" && b[1].off_snp === 30,
     "…including when the map's value nests its stats");
  ok(trimStats(null).length === 0 && trimStats(undefined).length === 0,
     "a null payload trims to nothing rather than throwing");
  ok(STAT_FIELDS.includes("off_snp") && STAT_FIELDS.includes("tm_off_snp")
     && STAT_FIELDS.includes("rec_air_yd") && STAT_FIELDS.includes("pass_att"),
     "the trimmed field list carries everything the usage math reads");

  const table = {};
  for (let w = 1; w <= 4; w++) table[weekUrl(2026, w)] = arrForm;
  delete table[weekUrl(2026, 3)];                       // week 3 is a 404
  const fetchImpl = mkFetch(table);
  const storage = mkStorage();
  const s = await loadSeasonStats(2026, 5, { fetchImpl, storage, now: 0 });
  ok(JSON.stringify(s.weeks) === "[1,2,4]", "every played week before the current one is fetched");
  ok(JSON.stringify(s.failed) === "[3]", "a week that fails is reported, not thrown");
  ok(s.byWeek.get(1).get("s1").off_snp === 54, "rows come back keyed by sleeper id");
  ok(fetchImpl.calls.length === 4, "one call per played week");

  // The most recent played week gets a six-hour TTL; older weeks are done and get a
  // week. Same cache key either way, so the TTL is the only thing that changes.
  const st2 = mkStorage();
  const f2 = mkFetch(table);
  await loadSeasonStats(2026, 5, { fetchImpl: f2, storage: st2, now: 0 });
  ok(f2.calls.length === 4, "the cold run makes one call per played week");
  const again = await loadSeasonStats(2026, 5, { fetchImpl: f2, storage: st2, now: 12 * 3600e3 });
  ok(again.byWeek.has(1) && again.byWeek.has(4), "both weeks still resolve half a day later");
  ok(f2.calls.length === 6,
     "…and half a day later only two calls go out: the six-hour week 4, and week 3, "
     + "which failed and so has no cache to be fresh");
  ok(!f2.calls.slice(4).includes(weekUrl(2026, 1)),
     "a finished week is not refetched inside its seven-day life");

  const s0 = await loadSeasonStats(2026, 1, { fetchImpl: mkFetch({}), storage: mkStorage(), now: 0 });
  ok(s0.weeks.length === 0 && s0.failed.length === 0,
     "before week 2 there is nothing played, and nothing is fetched");

  const dead = deadFetch();
  const sd = await loadSeasonStats(2026, 5, { fetchImpl: dead, storage: mkStorage(), now: 0 });
  ok(sd.byWeek.size === 0 && sd.failed.length === 4,
     "a dead feed yields an empty table and four reported failures, never a throw");
}

/* ---- the synthetic league every usage section shares ----
   Twelve players over four played weeks. Team offensive snaps are 60 every week for
   every team, and each NFL team's four listed receivers account for all forty of its
   targets and all four hundred of its air yards, so shares are exact.

   Team AAA's four WRs sit exactly on the line ppg = 2 + 20*WOPR. Team BBB's four all
   sit at the same WOPR (0.55) with points +4, -4, +2, -2 around that line. Two points
   at one x, symmetric about a line that already fits the other four exactly, leave the
   OLS solution unchanged - so A1..A4 have residual 0 and B1..B4 have residuals
   +4, -4, +2, -2 exactly. That is what makes the quartiles below hand-checkable. */
const P = [
  ["s1", 101, "A1", "WR", "AAA"], ["s2", 102, "A2", "WR", "AAA"],
  ["s3", 103, "A3", "WR", "AAA"], ["s4", 104, "A4", "WR", "AAA"],
  ["s5", 105, "B1", "WR", "BBB"], ["s6", 106, "B2", "WR", "BBB"],
  ["s7", 107, "B3", "WR", "BBB"], ["s8", 108, "B4", "WR", "BBB"],
  ["s9", 109, "R1", "RB", "AAA"], ["s10", 110, "R2", "RB", "AAA"],
  ["s11", 111, "Q1", "QB", "AAA"], ["s12", 112, "T1", "TE", "CCC"],
];

const bySleeper = new Map(P.map(([sid, espn, name, pos, nfl]) => [sid, {
  player_id: sid, espn_id: espn, full_name: name, position: pos, team: nfl,
  depth_chart_order: { s9: 1, s10: 2, s12: 1 }[sid] ?? null,
  depth_chart_position: pos,
}]));

const model = {
  settings: { pprValue: 0.5, currentWeek: 5 },
  players: new Map(P.map(([sid, espn, name, pos, nfl]) => [espn, { id: espn, name, pos, nfl }])),
};

const SNAP = {                            // off_snp, week by week; tm_off_snp is 60
  s1: [54, 54, 54, 54], s2: [48, 48, 48, 48], s3: [36, 36, 36, 36],
  s4: [12, 12, 36, 36],                   // A4: the breakout - same 4-week average, late jump
  s5: [54, 54, 54, 54], s6: [48, 48, 48, 48], s7: [30, 30, 30, 30], s8: [30, 30, 30, 30],
  s9: [54, 54, 54, 54], s10: [6, 6, 24, 24], s11: [60, 60, 60, 60], s12: [18, 18, 18, 18],
};
const TGT  = { s1: 16, s2: 12, s3: 8, s4: 4, s5: 10, s6: 10, s7: 10, s8: 10 };
const AIR  = { s1: 160, s2: 120, s3: 80, s4: 40, s5: 100, s6: 100, s7: 100, s8: 100 };
const PTS  = { s1: 19.6, s2: 15.2, s3: 10.8, s4: 6.4, s5: 17, s6: 9, s7: 15, s8: 11,
               s9: 12, s10: 4, s11: 20, s12: 5 };
const TD   = { s1: 4, s2: 3, s3: 2, s4: 1, s5: 6, s6: 1, s7: 4, s8: 2, s9: 4, s10: 0, s11: 2 };
const RUSH = { s9: 15, s10: 5, s11: 4 };  // rush attempts per week
const PASS = { s11: 30 };

const byWeek = new Map();
for (let k = 0; k < 4; k++) {
  const m = new Map();
  for (const [sid] of bySleeper) {
    const total = TD[sid] ?? 0;
    // Spread the four-week touchdown total across the weeks deterministically.
    const td = Math.floor((total * (k + 1)) / 4) - Math.floor((total * k) / 4);
    const rusher = RUSH[sid] != null;
    m.set(sid, {
      player_id: sid, team: bySleeper.get(sid).team,
      off_snp: SNAP[sid][k], tm_off_snp: 60,
      rec_tgt: TGT[sid] ?? 0, rec_air_yd: AIR[sid] ?? 0, rec: 0,
      rush_att: RUSH[sid] ?? 0, pass_att: PASS[sid] ?? 0,
      rec_td: rusher ? 0 : td, rush_td: rusher ? td : 0,
      pts_half_ppr: PTS[sid], pts_ppr: PTS[sid] + 5, pts_std: PTS[sid] - 5,
    });
  }
  byWeek.set(k + 1, m);
}

const STATS = { byWeek, bySleeper };

// A1 A2 A3 R2 and B2 B4 belong to "Theirs"; B1 B3 R1 Q1 to "Mine"; A4 and T1 are free.
const OWNER = new Map([
  [105, "Mine"], [107, "Mine"], [109, "Mine"], [111, "Mine"],
  [101, "Theirs"], [102, "Theirs"], [103, "Theirs"],
  [106, "Theirs"], [108, "Theirs"], [110, "Theirs"],
]);

/* ---- 2. the usage table: shares, WOPR, expected touchdowns, the fit, the trend ---- */
{
  ok(ptsKeyFor(1) === "pts_ppr" && ptsKeyFor(0.5) === "pts_half_ppr"
     && ptsKeyFor(0) === "pts_std",
     "the points column follows the league's own PPR setting");

  ok(quantile([-4, -2, 0, 0, 0, 0, 2, 4], 0.25) === -0.5,
     "quantile interpolates the lower quartile the way R type 7 does");
  ok(quantile([-4, -2, 0, 0, 0, 0, 2, 4], 0.75) === 0.5, "…and the upper quartile");
  ok(quantile([], 0.5) === null && quantile([7], 0.9) === 7,
     "an empty list has no quantile and a single value is its own");

  const u = usageTable(model, STATS, 5);
  const R = (id) => u.rows.get(id);
  ok(JSON.stringify(u.weeks) === "[1,2,3,4]" && JSON.stringify(u.recent) === "[1,2,3,4]",
     "four played weeks, all four inside the recent window");
  ok(u.ptsKey === "pts_half_ppr", "a 0.5-PPR league reads the half-PPR column");
  ok(u.rows.size === 12, "every player with a stat row and a model entry is in the table");

  ok(near(R(101).snapShare, 0.9) && near(R(104).snapShare, 0.4),
     "snap share is offensive snaps over team offensive snaps");
  ok(near(R(101).targetShare, 0.4) && near(R(101).airShare, 0.4),
     "target and air-yard shares are taken against the team's own totals");
  ok(near(R(101).wopr, 1.5 * 0.4 + 0.7 * 0.4) && near(R(101).wopr, 0.88),
     "WOPR is 1.5 x target share + 0.7 x air share");
  ok(near(R(105).wopr, 0.55) && near(R(108).wopr, 0.55),
     "the four BBB receivers split their team evenly and share one WOPR");
  ok(R(112).targetShare === null && R(112).wopr === null,
     "a player whose team recorded no targets has no share to report, not a zero one");

  // xTD = 0.04*rush_att + 0.06*rec_tgt over the window. A1 saw 64 targets and scored
  // four times: 4 - 3.84 = 0.16. B1 saw 40 and scored six: 6 - 2.40 = 3.60.
  ok(near(R(101).tdOver, 0.16), "touchdowns over expectation, receiving");
  ok(near(R(105).tdOver, 3.6), "…and it is strongly positive for the lucky scorer");
  ok(R(106).tdOver < 0 && near(R(106).tdOver, -1.4),
     "…and negative for the one who has not scored");
  ok(near(R(109).tdOver, 1.6),
     "a runner's expectation comes off his carries: 4 - 0.04 x 60");
  ok(R(111).tdOver === null,
     "a quarterback has no touchdown expectation here - these fields carry no passing TDs");

  ok(R(101).driverKey === "wopr" && R(109).driverKey === "touches"
     && R(111).driverKey === "dropbacks",
     "each position is fitted against the usage that actually drives it");
  ok(near(R(109).driver, 15), "a runner's driver is carries plus targets per game");
  ok(near(R(111).driver, 34), "a passer's driver is dropbacks plus carries per game");

  const fit = u.fits.get("WR");
  ok(fit && fit.n === 8 && near(fit.a, 2) && near(fit.b, 20),
     "the WR fit recovers the line the fixture was built on: ppg = 2 + 20 x WOPR");
  for (const id of [101, 102, 103, 104])
    ok(near(R(id).ppgOverUsage, 0),
       `a player exactly on the fit has a residual of zero (${R(id).name})`);
  ok(near(R(105).ppgOverUsage, 4) && near(R(106).ppgOverUsage, -4),
     "the symmetric pair around the line carries +4 and -4");
  ok(near(R(107).ppgOverUsage, 2) && near(R(108).ppgOverUsage, -2),
     "…and the inner pair +2 and -2");
  ok(u.fits.has("WR") && !u.fits.has("RB") && !u.fits.has("QB") && !u.fits.has("TE"),
     "only a position with enough players gets a fit");
  ok(R(109).ppgOverUsage === null && R(111).ppgOverUsage === null
     && R(112).ppgOverUsage === null,
     "a position with no fit reports null, not zero - zero would mean 'on the line'");

  ok(near(R(104).trend, 0.4),
     "the trend catches A4's snap jump: 0.80 over the last two weeks minus 0.20 before");
  ok(near(R(110).trend, 0.3), "…and R2's smaller one");
  ok(near(R(101).trend, 0), "a steady player trends at zero");

  // Three played weeks is not enough for a two-versus-two comparison.
  const short = new Map([[1, byWeek.get(1)], [2, byWeek.get(2)], [3, byWeek.get(3)]]);
  const us = usageTable({ ...model, settings: { ...model.settings, currentWeek: 4 } },
                        { byWeek: short, bySleeper }, 4);
  ok(us.rows.get(104).trend === null,
     "with fewer than four played weeks there is no trend to report");
  ok(us.recent.length === 3 && us.rows.get(101).games === 3,
     "the recent window shrinks to the weeks that exist");

  // A player who did not appear in the earlier pair played no snaps: that is a real
  // zero, not missing data, and it is exactly what a mid-season promotion looks like.
  const late = new Map([...byWeek].map(([w, m]) => {
    if (w > 2) return [w, m];
    const c = new Map(m); c.delete("s4"); return [w, c];
  }));
  const ul = usageTable(model, { byWeek: late, bySleeper }, 5);
  ok(near(ul.rows.get(104).trend, 0.6),
     "a player with no rows in the earlier pair trends against a snap share of zero");
  ok(ul.rows.get(104).games === 2, "…and is credited with only the games he played");

  // Weeks at or after the current one have not been played and must not be read.
  const withFuture = new Map([...byWeek, [5, byWeek.get(1)], [6, byWeek.get(1)]]);
  const uf = usageTable(model, { byWeek: withFuture, bySleeper }, 5);
  ok(JSON.stringify(uf.weeks) === "[1,2,3,4]",
     "weeks from the current one onward are ignored even when the feed carries them");

  // A player Sleeper knows and this league does not is not in the table.
  const extra = new Map([...bySleeper, ["s99", { player_id: "s99", espn_id: 999, team: "AAA" }]]);
  ok(usageTable(model, { byWeek, bySleeper: extra }, 5).rows.size === 12,
     "a player outside this league's model never reaches the table");

  const empty = usageTable(model, { byWeek: new Map(), bySleeper }, 5);
  ok(empty.rows.size === 0 && empty.fits.size === 0 && empty.weeks.length === 0,
     "no stats at all yields an empty table rather than a throw");
  ok(usageTable(model, null, 5).rows.size === 0, "…and so does no stats object at all");
}

/* ---- 3. selection: who to sell, who to ask for, who is breaking out ---- */
{
  const u = usageTable(model, STATS, 5);
  const a = assetRows(u, OWNER, "Mine");

  const wr = a.cut.get("WR");
  ok(wr && near(wr.resQ1, -0.5) && near(wr.resQ3, 0.5),
     "the WR residual quartiles are the fixture's own -0.5 and +0.5");
  ok(near(wr.tdQ3, 0.52), "…and the upper quartile of touchdowns over expectation is 0.52");
  ok(near(wr.drvMed, 0.55), "…and the median WOPR is 0.55");
  ok(!a.cut.has("RB") && !a.cut.has("QB"),
     "a position too thin to fit is too thin to cut into quarters");

  ok(a.sell.map((r) => r.name).join(",") === "B1,B3",
     "sell high is mine, top quartile on BOTH residual and touchdowns over expectation");
  ok(a.sell.every((r) => r.owner === "Mine"), "…and never somebody else's player");
  ok(!a.sell.some((r) => r.name === "A1"),
     "a player with a positive tdOver but a zero residual is not a sell-high");

  ok(a.buy.map((r) => r.name).join(",") === "B2,B4",
     "buy low is theirs, at or above the median driver and in the bottom residual quartile");
  ok(a.buy.every((r) => r.owner != null && r.owner !== "Mine"),
     "…owned by somebody else, never a free agent and never mine");
  ok(a.buy[0].ppgOverUsage < a.buy[1].ppgOverUsage,
     "buy low leads with the worst residual - the biggest gap between usage and output");
  ok(a.sell[0].ppgOverUsage > a.sell[1].ppgOverUsage,
     "sell high leads with the best");

  // A free agent who would otherwise qualify still must not appear in buy low.
  const faOwner = new Map(OWNER); faOwner.delete(106);
  ok(!assetRows(u, faOwner, "Mine").buy.some((r) => r.name === "B2"),
     "a qualifying free agent is excluded from buy low - there is nothing to trade for");

  ok(assetRows(usageTable(model, { byWeek: new Map(), bySleeper }, 5), OWNER, "Mine")
       .sell.length === 0,
     "no stats means no sell-high list rather than a throw");

  /* breakouts */
  const crowd = new Map([[104, 900], [110, 50]]);
  const depth = new Map([["s12", 1]]);
  const b = breakouts(u, OWNER, crowd, depth);
  ok(b.map((r) => r.name).join(",") === "A4,R2,T1",
     "breakouts are ordered by the size of the snap-share jump");
  ok(b[0].crowd === 900 && b[1].crowd === 50 && b[2].crowd === 0,
     "each row carries the crowd's 24-hour add count");
  ok(b[0].owner === null && b[1].owner === "Theirs",
     "free agents and low-usage rostered players both qualify");
  ok(b[2].depthDelta === 1 && near(b[2].trend, 0),
     "a depth-chart promotion qualifies on its own, with no snap jump");
  ok(!b.some((r) => r.name === "R1"),
     "a rostered player already taking most of the snaps is not a breakout");
  ok(breakouts(u, OWNER, null, null).map((r) => r.name).join(",") === "A4,R2",
     "with no crowd and no depth data the snap jumps still stand alone");

  /* the depth-chart memo */
  const d1 = depthChanges(bySleeper, 1000, null);
  ok(d1.delta.size === 0, "the first run has no before to compare against");
  ok(d1.memo.at === 1000 && d1.memo.order.s10 === 2, "…but it records what it saw");
  const moved = new Map([...bySleeper].map(([k, v]) =>
    [k, k === "s10" ? { ...v, depth_chart_order: 1 } : v]));
  const d2 = depthChanges(moved, 2000, d1.memo);
  ok(d2.delta.get("s10") === 1, "a player moving from second to first reports +1");
  ok(d2.delta.size === 1, "…and nobody who did not move reports anything");
  const d3 = depthChanges(moved, 2000, d2.memo);
  ok(d3.delta.get("s10") === 1,
     "re-reading the same file keeps the delta rather than eating it on the first render");
  const d4 = depthChanges(bySleeper, 3000, d3.memo);
  ok(d4.delta.get("s10") === -1, "…and a demotion reports negative");

  /* crowd split */
  const ups = [{ fa: 1 }, { fa: 2 }, { fa: 3 }, { fa: 4 }];
  const loud = crowdSplit(ups, (x) => ({ 1: 1000, 2: 250 }[x.fa] ?? 0));
  ok(loud.threshold === 250 && loud.max === 1000,
     "the contested line is a quarter of the loudest add in this pool");
  ok(loud.split.get(1).contested && loud.split.get(2).contested
     && !loud.split.get(3).contested,
     "…and it splits quiet from contested at exactly that line");
  const quiet = crowdSplit(ups, (x) => ({ 1: 10, 2: 5 }[x.fa] ?? 0));
  ok(quiet.threshold === USAGE_K.CROWD_FLOOR && ![...quiet.split.values()].some((v) => v.contested),
     "the floor stops the loudest of a handful of near-zero counts being called contested");
  ok(crowdSplit([], () => 0).split.size === 0, "an empty pool splits into nothing");

  /* best offer */
  const trades = [
    { shape: "1-for-1", sides: [{ team: "Mine", sent: [7], received: [9], gain: 0.30 },
                                { team: "Theirs", sent: [9], received: [7], gain: 0.10 }] },
    { shape: "2-for-2", sides: [{ team: "Mine", sent: [7, 8], received: [9, 10], gain: 0.55 },
                                { team: "Theirs", sent: [9, 10], received: [7, 8], gain: 0.05 }] },
  ];
  const bo = bestOfferFor(7, trades, "Mine");
  ok(bo && near(bo.gain, 0.55) && bo.shape === "2-for-2" && bo.dir === "send",
     "the best offer moving a player is the one that gains my side the most");
  ok(bestOfferFor(9, trades, "Mine").dir === "get",
     "a player coming the other way is reported as one I would receive");
  ok(bestOfferFor(42, trades, "Mine") === null, "a player in no trade has no offer");
  ok(bestOfferFor(7, [], "Mine") === null, "…and neither does anyone when there are no trades");
}

/* ---- 4. FAAB: what to bid, and the most it is worth ---- */
{
  // Every bid ends in 1 or 6 - the numbers are exactly 5k+1 - so a tie with a manager
  // who bid a round number is one you win.
  ok(offRound(0.2) === 1 && offRound(1) === 1 && offRound(3) === 1 && offRound(4) === 6,
     "small raw bids round to the nearest off-round figure, never below 1");
  ok(offRound(8) === 6 && offRound(9) === 11 && offRound(12) === 11 && offRound(14) === 16,
     "…and larger ones round to the nearer of the two neighbours");
  for (let x = 0; x < 200; x += 7.3) ok((offRound(x) - 1) % 5 === 0, `${x.toFixed(1)} rounds to 5k+1`);
  ok([0.2, 4, 9, 76.19].map(offRound).join(",") === "1,6,11,76",
     "offRound survives being handed to .map, which passes an index where K goes");

  const upgrades = [
    { fa: 1, gain: 2.0 }, { fa: 2, gain: 1.5 }, { fa: 3, gain: 1.0 },
    { fa: 4, gain: 0.5 }, { fa: 5, gain: 0.25 }, { fa: 6, gain: 0.1 },
  ];
  const crowds = { 1: 1000, 2: 250 };
  const crowdOf = (u) => crowds[u.fa] ?? 0;

  // Top-five gains sum to 5.25. fa1 takes 2.0/5.25 of a 100 budget, doubled by a
  // crowd of 1000 -> 76.19 -> 76. The median points-per-dollar across the top five
  // is 0.416667, so the most fa1 is worth is 20/0.416667 = 48.
  const p = faabBids(upgrades, { budget: 100, myRemaining: 100, weeksLeft: 10, crowdOf });
  ok(p.mode === "faab", "a league with a budget gets bids");
  ok(near(p.perDollar, 0.4166666667, 1e-6), "the field's rate is the top five's median");
  const bid = (fa) => p.bids.get(fa).bid, max = (fa) => p.bids.get(fa).max;
  ok(bid(1) === 76 && bid(2) === 41 && bid(3) === 21 && bid(4) === 11 && bid(5) === 6 && bid(6) === 1,
     "each suggested bid is gain share x remaining budget x urgency, rounded off-round");
  ok(max(1) === 48 && max(2) === 36 && max(3) === 24 && max(4) === 12 && max(5) === 6 && max(6) === 2,
     "the most sensible bid is where the add's points per dollar meets the field's rate");
  ok(max(1) < bid(1),
     "a maximum below the suggestion is the signal that the crowd, not the points, is "
     + "driving the price");
  ok(p.bids.get(1).crowd === 1000 && p.bids.get(3).crowd === 0,
     "each bid carries the crowd count that set its urgency");

  // Urgency is capped: twice the base, never more, however loud the crowd gets.
  const shout = faabBids(upgrades, { budget: 100, myRemaining: 100, weeksLeft: 10,
                                     crowdOf: (u) => (u.fa === 1 ? 100000 : 0) });
  ok(shout.bids.get(1).bid === 76, "an enormous crowd cannot push urgency past double");

  const broke = faabBids(upgrades, { budget: 100, myRemaining: 5, weeksLeft: 10, crowdOf });
  ok(broke.bids.get(1).bid === 5,
     "a bid is clamped to what is left, even when that is not an off-round number");
  ok([...broke.bids.values()].every((v) => v.bid <= 5), "…and so is every other bid");

  const spent = faabBids(upgrades, { budget: 100, myRemaining: 0, weeksLeft: 10, crowdOf });
  ok([...spent.bids.values()].every((v) => v.bid === 0),
     "a team with nothing left bids nothing");

  const none = faabBids(upgrades, { budget: 0, myRemaining: 0, weeksLeft: 10, crowdOf });
  ok(none.mode === "priority" && none.bids.size === 0,
     "a league with no budget is a waiver-priority league, and gets no bids at all");
  ok(faabBids([], { budget: 100, myRemaining: 100, weeksLeft: 10, crowdOf }).bids.size === 0,
     "no upgrades, no bids");

  /* the two league.js fields */
  const s = readSettings({ settings: { acquisitionSettings: { acquisitionBudget: 100 } } });
  ok(s.faabBudget === 100, "the FAAB budget is read from the league settings");
  ok(readSettings({ settings: {} }).faabBudget === 0,
     "a league that does not bid reports a budget of zero rather than undefined");
  ok(readSettings({ settings: { acquisitionSettings: { acquisitionBudget: "0" } } })
       .faabBudget === 0, "…and a string zero is still zero");
}

/* ---- 5. the panel module ---- */
{
  const gridCalls = [];
  const fakeGrid = (id, cols, rows, o) => { gridCalls.push({ id, cols, rows, o }); return `<!--${id}-->`; };

  const loaded = { players: { bySleeper, byEspn: new Map(), at: 1000 },
                   stats: { byWeek, weeks: [1, 2, 3, 4], failed: [], at: 1000 },
                   trending: [{ player_id: "s4", count: 900 }, { player_id: "s10", count: 50 }] };
  const view = usageView(model, loaded, 5, null);
  ok(view.table.rows.size === 12, "the view carries the usage table");
  ok(view.crowdByEspn.get(104) === 900,
     "trending adds are joined onto ESPN ids through the Sleeper crosswalk");
  ok(usageView(model, null, 5, null) === null, "no feed, no view");

  // A minimal engine stand-in: the section code reads only ids, teams and roster.
  const eng = { ids: [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112],
                teams: ["Mine", "Theirs"],
                roster: new Map([["Mine", [4, 6, 8, 10]], ["Theirs", [0, 1, 2, 5, 7, 9]]]),
                index: new Map([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]
                  .map((id, i) => [id, i])) };
  ok(ownersOf(eng).get(105) === "Mine" && ownersOf(eng).get(101) === "Theirs"
     && !ownersOf(eng).has(104),
     "owners are read off the engine's rosters; anyone unowned is a free agent");

  gridCalls.length = 0;
  const html = assetsSection(eng, model, view, { myTeam: "Mine", grid: fakeGrid, trades: [] });
  ok(html.startsWith("<section") && gridCalls.length === 2, "two grids: sell high and buy low");
  ok(gridCalls[0].rows.map((r) => r.name).join(",") === "B1,B3", "…the first is mine");
  ok(gridCalls[1].rows.map((r) => r.name).join(",") === "B2,B4", "…the second is theirs");
  ok(gridCalls[0].cols.some((c) => c.key === "wopr")
     && gridCalls[0].cols.some((c) => c.key === "tdover")
     && gridCalls[0].cols.some((c) => c.key === "resid")
     && gridCalls[0].cols.some((c) => c.key === "offer"),
     "the spec's columns are all present");
  ok(gridCalls[0].cols !== gridCalls[1].cols,
     "each grid gets fresh column objects - grid() keeps sort state per id");

  // The row renderer must be exercised directly; a recorder never calls it.
  const rowHtml = gridCalls[0].o.row({ ...view.table.rows.get(105), owner: "Mine",
    name: 'x"><img src=x>', pos: 'RB"><img src=x>' });
  ok(!/<img src=x>/.test(rowHtml), "the row escapes a hostile name and position");
  ok(/&lt;img/.test(rowHtml), "…by entity-encoding rather than by stripping");

  gridCalls.length = 0;
  const dead = assetsSection(eng, model, null, { myTeam: "Mine", grid: fakeGrid, trades: [] });
  ok(dead.startsWith("<section") && gridCalls.every((g) => g.rows.length === 0),
     "with no feed the section still renders, with empty grids");
  ok(gridCalls.every((g) => /unavailable/i.test(g.o.empty)),
     "…and says why rather than reading as 'nobody qualifies'");

  gridCalls.length = 0;
  breakoutSection(eng, model, view, { myTeam: "Mine", grid: fakeGrid });
  ok(gridCalls.length === 1 && gridCalls[0].rows.map((r) => r.name).join(",") === "A4,R2",
     "breakout watch lists the snap jumps, ordered");
  const bRow = gridCalls[0].o.row({ ...gridCalls[0].rows[0], name: '<b>x</b>' });
  ok(!/<b>x<\/b>/.test(bRow), "the breakout row escapes too");

  /* the two free-agent columns */
  const ups = [{ fa: 3, gain: 2.0 }, { fa: 9, gain: 0.4 }];
  const wv = waiverView(ups, view, eng,
    { budget: 100, myRemaining: 100, weeksLeft: 10 });
  ok(wv.mode === "faab" && wv.live === true, "a live feed and a budget give real bids");
  ok(faCrowdCols(wv).length === 2, "the free-agent grid gains exactly two columns");
  ok((faCrowdCells(ups[0], wv).match(/<td/g) ?? []).length === 2,
     "…and exactly two cells");
  const deadWv = waiverView(ups, null, eng, { budget: 100, myRemaining: 100, weeksLeft: 10 });
  ok((faCrowdCells(ups[0], deadWv).match(/<td/g) ?? []).length === 2,
     "a dead feed still renders two cells, so the column count never shifts");
  ok(/—/.test(faCrowdCells(ups[0], deadWv)), "…both showing a dash");
  const noBudget = waiverView(ups, view, eng, { budget: 0, myRemaining: 0, weeksLeft: 10 });
  ok(noBudget.mode === "priority" && /—/.test(faCrowdCells(ups[0], noBudget).split("</td>")[1]),
     "a no-FAAB league shows no bid");
  ok((faCrowdCells(ups[0], null).match(/<td/g) ?? []).length === 2,
     "…and so does no waiver view at all");

  /* the loaders swallow every failure */
  const say = []; const rec = (t, c) => say.push([t, c]);
  ok(await usageOrNull({ settings: { currentWeek: 1 } }, 2026, rec,
       { fetchImpl: deadFetch(), storage: mkStorage(), now: 0 }) === null,
     "before any game is played there is no usage to load");
  ok(await usageOrNull(model, 2026, rec,
       { fetchImpl: deadFetch(), storage: mkStorage(), now: 0 }) === null,
     "a dead feed returns null rather than throwing");
  ok(say.some(([, c]) => c === "err"), "…and says so once, in the log");
  const stuck = await usageOrNull(model, 2026, rec,
    { fetchImpl: stuckFetch(), storage: mkStorage(), now: 0, timeoutMs: 20 });
  ok(stuck === null, "a feed that accepts the connection and never answers gives up");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("USAGE OK");
