/**
 * Tests for Phase 5: the projection sources, the aggregate and the calibration log.
 *
 * Everything here is offline: `fetchImpl` and `storage` are injected, and the model
 * is a small synthetic league built in `mkModel()` rather than `fixture.json` — the
 * fixture is the engine contract and must never be aggregated or shrunk.
 *
 *   node extension/test/projections.mjs
 */
import { parseCsv, parseCsvObjects } from "../engine/sources/csv.js";
import { loadSleeperProjections, pprColumn, trimWeek, weekUrl } from "../engine/sources/sleeperproj.js";
import { IDS_URL, WEEKLY_URL, loadFantasyProsWeek, trimIds, trimWeekly } from "../engine/sources/fantasypros.js";
import { aggregateProjections } from "../engine/aggregate.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const close = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; }, async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const mkFetch = (table) => { const calls = []; const f = async (url) => { calls.push(url);
  const hit = table[url]; if (!hit) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; }; f.calls = calls; return f; };

/**
 * A synthetic league: four RBs and two QBs over three weeks. Deliberately not the
 * fixture — `fixture.json` is the engine contract and must never be aggregated.
 * Shaped like `loadLeague`'s return: `proj` is an object keyed by week number.
 */
const mkModel = (weeks = [5, 6, 7]) => {
  const spec = [
    [101, "RB", 10], [102, "RB", 20], [103, "RB", 30], [104, "RB", 40],
    [201, "QB", 15], [202, "QB", 25],
  ];
  return {
    weeks: [...weeks],
    settings: { pprValue: 0.5, currentWeek: weeks[0] },
    players: new Map(spec.map(([id, pos, base]) => [id, {
      id, name: `p${id}`, pos, nfl: "X", eligibleSlots: [], rawStats: [],
      proj: Object.fromEntries(weeks.map((w) => [w, base])),
    }])),
  };
};
const src = (name, week, entries) => ({ name, byWeek: new Map([[week, new Map(entries)]]) });

/* ---- 1. CSV ---- */
{
  const rows = parseCsv('a,b,c\n1,"x,y",3\n');
  ok(rows.length === 2, "csv: two rows");
  ok(rows[1][1] === "x,y", "csv: quoted comma stays one field");
  ok(rows[1][2] === "3", "csv: field after a quoted field");

  ok(parseCsv("a,b\n,2\n")[1][0] === "", "csv: leading empty field");
  ok(parseCsv("a,b\n1,\n")[1][1] === "", "csv: trailing empty field");
  ok(parseCsv('a\n"he said ""hi"""\n')[1][0] === 'he said "hi"', "csv: escaped quotes");
  ok(parseCsv("a,b\r\n1,2\r\n").length === 2, "csv: CRLF");
  ok(parseCsv("a,b\n1,2").length === 2, "csv: no trailing newline");
  ok(parseCsv("").length === 0, "csv: empty input");
  ok(parseCsv('a\n"x\ny"\n')[1][0] === "x\ny", "csv: newline inside quotes");

  const objs = parseCsvObjects(' fp_id ,r2p_pts\n7,12.5\n8,\n');
  ok(objs.length === 2, "csvObjects: two objects");
  ok(objs[0].fp_id === "7", "csvObjects: header is trimmed");
  ok(objs[0].r2p_pts === "12.5", "csvObjects: value read");
  ok(objs[1].r2p_pts === "", "csvObjects: empty field is an empty string");
  ok(parseCsvObjects("a,b\n1,2\n\n").length === 1, "csvObjects: blank trailing line ignored");
  ok(parseCsvObjects("").length === 0, "csvObjects: empty input");
}

/* ---- 2. Sleeper per-week projections ---- */
{
  ok(pprColumn(1) === "pts_ppr", "ppr 1.0 -> pts_ppr");
  ok(pprColumn(0.5) === "pts_half_ppr", "ppr 0.5 -> pts_half_ppr");
  ok(pprColumn(0) === "pts_std", "ppr 0 -> pts_std");
  ok(pprColumn(0.9) === "pts_ppr", "ppr 0.9 rounds to full");
  ok(pprColumn(0.4) === "pts_half_ppr", "ppr 0.4 rounds to half");
  ok(pprColumn(0.2) === "pts_std", "ppr 0.2 rounds to standard");
  ok(pprColumn(undefined) === "pts_std", "missing ppr value -> standard");

  const u = weekUrl(2026, 7);
  ok(u.startsWith("https://api.sleeper.app/projections/nfl/2026/7?"), "week url has no /v1 segment");
  ok(u.includes("season_type=regular"), "week url asks for the regular season");
  ok(["QB", "RB", "WR", "TE", "K", "DEF"].every((p) => u.includes(`position[]=${p}`)), "week url asks for six positions");

  const rawWeek = (mult) => [
    { player_id: "s1", stats: { pts_ppr: 20 * mult, pts_half_ppr: 18 * mult, pts_std: 16 * mult } },
    { player_id: "s2", stats: { pts_ppr: 10 * mult, pts_half_ppr: 9 * mult, pts_std: 8 * mult } },
    { player_id: "s3", stats: { pts_ppr: 5 * mult } },
    { player_id: "s9", stats: { pts_ppr: 99 } },          // no espn id in the crosswalk
    { player_id: "s4" },                                  // no stats at all
    { stats: { pts_ppr: 1 } },                            // no id at all
  ];
  const trimmed = trimWeek(rawWeek(1));
  ok(trimmed.length === 4, "trimWeek drops rows with no id and no stats");
  ok(!trimmed.some((r) => "player" in r), "trimWeek keeps only the columns we read");
  ok(trimmed[0].player_id === "s1" && trimmed[0].pts_std === 16, "trimWeek keeps all three columns");
  ok(trimWeek(null).length === 0, "trimWeek tolerates a non-array payload");

  const bySleeper = new Map([["s1", { espn_id: 101 }], ["s2", { espn_id: 102 }], ["s3", { espn_id: 103 }]]);
  const storage = mkStorage();
  const fetchImpl = mkFetch({ [weekUrl(2026, 5)]: rawWeek(1), [weekUrl(2026, 6)]: rawWeek(2) });
  const seen = [];
  const r = await loadSleeperProjections({ season: 2026, weeks: [5, 6, 7], pprValue: 0.5, bySleeper,
    fetchImpl, storage, now: 0, onProgress: (d, t) => seen.push([d, t]) });
  ok(r.byWeek.get(5).get(101) === 18, "half-ppr column is used");
  ok(r.byWeek.get(6).get(102) === 18, "each week is fetched separately");
  ok(r.byWeek.get(5).get(103) === 5, "a row missing the chosen column falls back rather than vanishing");
  ok(!r.byWeek.get(5).has(99) && r.byWeek.get(5).size === 3, "a player with no espn id is dropped");
  ok(!r.byWeek.has(7), "a week whose fetch 404s is simply absent");
  ok(r.failed.length === 1 && r.failed[0] === 7, "the failed week is reported");
  ok(r.covered === 3, "covered counts distinct espn ids");
  ok(seen.length === 3 && seen[2][1] === 3, "progress is reported once per week");

  const again = await loadSleeperProjections({ season: 2026, weeks: [5], pprValue: 0.5, bySleeper,
    fetchImpl, storage, now: 1000 });
  ok(again.byWeek.get(5).get(101) === 18 && fetchImpl.calls.length === 3, "a fresh week comes from the cache");
  ok(JSON.stringify(storage._m.get("src.sleeperproj.2026.5").data).length
     < JSON.stringify(rawWeek(1)).length, "the cached copy is trimmed");

  const dead = await loadSleeperProjections({ season: 2026, weeks: [11, 12], pprValue: 1, bySleeper,
    fetchImpl: mkFetch({}), storage: mkStorage(), now: 0 });
  ok(dead.byWeek.size === 0 && dead.covered === 0 && dead.failed.length === 2, "a dead feed returns empty, not a throw");
}

/* ---- 3. FantasyPros ECR via DynastyProcess ---- */
{
  const weekly = 'fp_id,player_name,pos,week,ecr,r2p_pts\n'
    + '7,"Smith, John",RB,5,3.1,14.25\n'
    + '8,Jones,WR,5,9.4,11.00\n'
    + '9,Ghost,TE,5,20.0,\n'
    + '10,Old,QB,4,1.0,25.00\n';
  const ids = "fantasypros_id,espn_id,name\n7,101,a\n8,102,b\n9,103,c\n10,104,d\n11,,e\n";

  const tw = trimWeekly(weekly);
  ok(tw.idKey === "fp_id", "the id column is probed from the header");
  ok(tw.hasPts === true, "r2p_pts is detected");
  ok(tw.rows.length === 3, "a row with no r2p_pts value is dropped");
  ok(tw.rows[0].fp === "7" && tw.rows[0].pts === 14.25 && tw.rows[0].week === 5, "a weekly row is read");
  ok(trimWeekly("fp_id,ecr\n7,1.0\n").hasPts === false, "no r2p_pts column is reported, not guessed");
  ok(trimWeekly("player_name,r2p_pts\nx,1.0\n").idKey === null, "no id column is reported");
  ok(trimWeekly("").rows.length === 0, "an empty CSV is tolerated");

  // Fail-open on week, ruled: `fp_latest_weekly.csv` is by definition the latest
  // week and may carry no `week` column at all; a row whose week can't be read is
  // kept for every requested week rather than dropped, because failing closed would
  // drop the whole file and silently disable the source.
  const noWeekCol = 'fp_id,pos,r2p_pts\n7,RB,14.25\n8,WR,11.00\n';
  ok(trimWeekly(noWeekCol).rows.every((row) => row.week === null),
    "no week column at all leaves week null on every row");

  const badWeek = 'fp_id,pos,week,r2p_pts\n7,RB,n/a,14.25\n';
  ok(trimWeekly(badWeek).rows[0].week === null, "an unparseable week cell reads as null, not a throw");

  const pairs = trimIds(ids);
  ok(pairs.length === 4, "id rows without an espn id are dropped");
  ok(pairs[0][0] === "7" && pairs[0][1] === 101, "espn_id is numeric");

  const storage = mkStorage();
  const fetchImpl = mkFetch({ [WEEKLY_URL]: weekly, [IDS_URL]: ids });
  const r = await loadFantasyProsWeek({ week: 5, fetchImpl, storage, now: 0 });
  ok(r.available === true, "the source reports itself available");
  ok(r.byEspn.get(101) === 14.25 && r.byEspn.get(102) === 11, "points arrive keyed by espn id");
  ok(!r.byEspn.has(104), "another week's row is filtered out");
  ok(r.byEspn.size === 2, "only the current week matched");
  ok(fetchImpl.calls.length === 2, "two files, one fetch each");

  const r2 = await loadFantasyProsWeek({ week: 5, fetchImpl, storage, now: 1000 });
  ok(r2.byEspn.get(101) === 14.25 && fetchImpl.calls.length === 2, "both files come from the cache");

  const noPts = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0,
    fetchImpl: mkFetch({ [WEEKLY_URL]: "fp_id,ecr\n7,1.0\n", [IDS_URL]: ids }) });
  ok(noPts.available === false && noPts.byEspn.size === 0, "no r2p_pts means the source is skipped");
  ok(/r2p_pts/.test(noPts.reason), "the reason names the missing column");

  const deadIds = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0,
    fetchImpl: mkFetch({ [WEEKLY_URL]: weekly }) });
  ok(deadIds.available === false && deadIds.byEspn.size === 0, "a dead crosswalk degrades to unavailable");

  const dead = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0, fetchImpl: mkFetch({}) });
  ok(dead.available === false && dead.reason.length > 0, "a dead feed returns a reason, not a throw");

  // Fail-open, end to end: a weekly file with no week column at all still produces
  // points for the requested week (the case that breaks if the fail-open is ever
  // "fixed" to fail closed instead).
  const noWeekE2E = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0,
    fetchImpl: mkFetch({ [WEEKLY_URL]: noWeekCol, [IDS_URL]: ids }) });
  ok(noWeekE2E.available === true && noWeekE2E.byEspn.get(101) === 14.25 && noWeekE2E.byEspn.get(102) === 11,
    "a weekly file with no week column at all still yields points for the requested week");

  // Fail-open, end to end: an unparseable week cell is kept too, not just a missing column.
  const badWeekE2E = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0,
    fetchImpl: mkFetch({ [WEEKLY_URL]: badWeek, [IDS_URL]: ids }) });
  ok(badWeekE2E.available === true && badWeekE2E.byEspn.get(101) === 14.25,
    "a row with an unparseable week cell is kept for the requested week");
  // (A row with a valid but different week is still excluded — already pinned above
  // by "another week's row is filtered out" / "only the current week matched".)

  // Degradation, end to end: the weekly file parses and has r2p_pts, but no candidate
  // id column (fantasypros_id / fp_id / id) is present in its header.
  const noIdColumn = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0,
    fetchImpl: mkFetch({ [WEEKLY_URL]: "player_name,pos,week,r2p_pts\nJohn,RB,5,14.25\n" }) });
  ok(noIdColumn.available === false && noIdColumn.byEspn.size === 0,
    "no candidate id column means the source is unavailable");
  ok(/id column/.test(noIdColumn.reason), "the reason names the missing id column");

  // Degradation, end to end: both files fetch fine and the id column is fine, but no
  // row's fantasypros id is present in the crosswalk, so nothing joins.
  const noJoin = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0,
    fetchImpl: mkFetch({ [WEEKLY_URL]: "fp_id,pos,week,r2p_pts\n999,RB,5,14.25\n", [IDS_URL]: ids }) });
  ok(noJoin.available === false && noJoin.byEspn.size === 0,
    "no matching id in the crosswalk degrades to unavailable");
  ok(/no rows matched/.test(noJoin.reason), "the reason is 'no rows matched'");
}

/* ---- 4. the aggregate: positional-fraction normalization ---- */
{
  // A source that agrees with ESPN exactly changes nothing and disagrees by nothing.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 10], [102, 20], [103, 30], [104, 40]]);
    const r = aggregateProjections(m, [s], [5, 6, 7]);
    ok(close(m.players.get(101).proj[5], 10) && close(m.players.get(104).proj[5], 40),
       "a source agreeing exactly leaves agg = espn");
    ok(close(r.band.get(101)[0], 0) && close(r.band.get(104)[0], 0), "agreement means band = 0");
    ok(close(m.players.get(101).proj[6], 10), "a week the source does not cover is untouched");
    ok(r.coverage.sleeper === 4, "coverage counts the players the source reached");
  }

  // Only the shape matters, not the scale: a source at 2x across the board is the
  // same source. This is what makes averaging a non-league-scored feed legitimate.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 20], [102, 40], [103, 60], [104, 80]]);
    aggregateProjections(m, [s], [5]);
    ok(close(m.players.get(101).proj[5], 10) && close(m.players.get(103).proj[5], 30),
       "a source at 2x scale is identical after normalization");
  }

  // One player doubled inside the source. Hand-computed:
  //   src = 20,20,30,40 -> mS = 27.5 ; mE = 25 ; kS = 1
  //   frac_s : 0.727272..., 0.727272..., 1.090909..., 1.454545...
  //   frac_E : 0.4, 0.8, 1.2, 1.6
  //   agg(101) = 25 * (0.4 + 0.727272...)/2 = 14.09
  //   agg(102) = 25 * (0.8 + 0.727272...)/2 = 19.09
  //   agg(104) = 25 * (1.6 + 1.454545...)/2 = 38.18
  //   band(101) = 25 * |0.4 - 0.727272...|/2 = 4.09
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 20], [102, 20], [103, 30], [104, 40]]);
    const r = aggregateProjections(m, [s], [5]);
    ok(close(m.players.get(101).proj[5], 14.09, 5e-3), "a doubled player moves halfway to the source");
    ok(close(m.players.get(102).proj[5], 19.09, 5e-3), "the other players move by the mean shift");
    ok(close(m.players.get(104).proj[5], 38.18, 5e-3), "the top player moves too");
    ok(close(r.band.get(101)[0], 4.09, 5e-3), "band is the population sd, scaled back to points");
    ok(close(r.band.get(103)[0], 25 * Math.abs(1.2 - 30 / 27.5) / 2, 1e-6), "band for a middling player");
  }

  // Two sources, both agreeing: still espn, still no band.
  {
    const m = mkModel();
    const a = src("sleeper", 5, [[101, 10], [102, 20], [103, 30], [104, 40]]);
    const b = src("fp", 5, [[101, 5], [102, 10], [103, 15], [104, 20]]);
    const r = aggregateProjections(m, [a, b], [5]);
    ok(close(m.players.get(102).proj[5], 20), "two agreeing sources produce agg = espn");
    ok(close(r.band.get(102)[0], 0), "two agreeing sources produce band = 0");
    ok(r.coverage.sleeper === 4 && r.coverage.fp === 4, "coverage is reported per source");
  }

  // A player nobody else covers is left exactly alone.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 20], [102, 20], [103, 30]]);
    const before = m.players.get(104).proj[5];
    const r = aggregateProjections(m, [s], [5]);
    ok(m.players.get(104).proj[5] === before, "a player only ESPN covers is unchanged");
    ok(!r.band.has(104) || close(r.band.get(104)[0], 0), "an uncovered player has no band");
    ok(r.coverage.sleeper === 3, "coverage excludes the player the source missed");
  }

  // Partial coverage must not shift the covered players (ruling 3): the source agrees
  // with ESPN on the three players it covers, so all three stay put even though the
  // subset's mean is well below the position's.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 10], [102, 20], [103, 30]]);
    aggregateProjections(m, [s], [5]);
    ok(close(m.players.get(101).proj[5], 10) && close(m.players.get(102).proj[5], 20)
       && close(m.players.get(103).proj[5], 30),
       "a source agreeing on a skewed subset does not move that subset");
  }

  // Positions are normalized independently.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[201, 30], [202, 25]]);
    aggregateProjections(m, [s], [5]);
    ok(m.players.get(101).proj[5] === 10, "an RB is untouched by a QB-only source");
    ok(m.players.get(201).proj[5] > 15, "the QB the source likes moves up");
    ok(m.players.get(202).proj[5] < 25, "the QB the source likes less moves down");
  }

  // Degradation and edges.
  {
    const m = mkModel();
    const r = aggregateProjections(m, [], [5, 6, 7]);
    ok(r.changed === 0 && r.band.size === 0, "no sources changes nothing");
    ok(m.players.get(103).proj[5] === 30, "no sources leaves ESPN alone");

    const m2 = mkModel();
    const dead = { name: "sleeper", byWeek: new Map() };
    aggregateProjections(m2, [dead], [5]);
    ok(m2.players.get(103).proj[5] === 30, "a dead source leaves agg = espn");

    const m3 = mkModel();
    aggregateProjections(m3, [src("sleeper", 5, [[101, 20]])], [5]);
    ok(m3.players.get(101).proj[5] === 10, "a source covering one player is ignored (no mean to take)");

    const m4 = mkModel();
    for (const p of m4.players.values()) p.proj[5] = 0;      // a bye-like week
    aggregateProjections(m4, [src("sleeper", 5, [[101, 20], [102, 20], [103, 30], [104, 40]])], [5]);
    ok(m4.players.get(101).proj[5] === 0, "a week with no ESPN projection is skipped");

    const m5 = mkModel();
    const r5 = aggregateProjections(m5, [src("sleeper", 5, [[101, 20], [102, 20], [103, 30], [104, 40]])], [5, 6, 7]);
    ok(r5.band.get(101).length === 3, "band is aligned to the weeks argument");
    ok(close(r5.band.get(101)[1], 0) && close(r5.band.get(101)[2], 0), "uncovered weeks band at zero");
    ok(r5.changed === 4, "changed counts the players actually moved");
  }
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PROJECTIONS OK");
