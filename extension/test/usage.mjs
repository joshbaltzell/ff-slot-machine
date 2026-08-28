/**
 * Tests for Phase 6 (usage): the Sleeper weekly stats feed, the usage arithmetic,
 * the sell-high / buy-low selection, breakouts, the crowd split, FAAB bids and the
 * panel helpers - all offline, with fetch, storage and the clock injected.
 *
 *   node extension/test/usage.mjs
 */
import { weekUrl, trimStats, loadWeekStats, loadSeasonStats, STAT_FIELDS }
  from "../engine/sources/sleeperstats.js";
import { USAGE_K, DRIVER, quantile, ptsKeyFor, usageTable } from "../engine/usage.js";

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

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("USAGE OK");
