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

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PROJECTIONS OK");
