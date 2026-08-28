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
import { FIT_POS, MIN_N, MIN_WEEKS, attachActuals, fitSlopes, loadLog, logKey, logWeek,
         mergeSlopes, summary, weeksStored, weeksWithActuals } from "../engine/calibration.js";
import { CALIBRATION_K } from "../engine/calibrate.js";
import { bandMean, bandTag, bindSourcesChips, calibrationSection, runProjections, sourcesChips }
  from "../panel/projections.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const close = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

// Clones on the way in and on the way out, because `chrome.storage.local` does: it
// serializes. A mock that handed back the same object reference would let code that
// mutates a loaded value and never writes it back pass — which is exactly the bug
// the "actuals are written back" test below is guarding against.
const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: structuredClone(m.get(k)) }; },
  async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
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
  // `teamId` matters: `loadFreeAgents` gives free agents null and the calibration
  // log keeps only rostered players, so every player here is on a team unless a
  // test deliberately makes one a free agent.
  const spec = [
    [101, "RB", 10], [102, "RB", 20], [103, "RB", 30], [104, "RB", 40],
    [201, "QB", 15], [202, "QB", 25],
  ];
  return {
    weeks: [...weeks],
    settings: { pprValue: 0.5, currentWeek: weeks[0] },
    players: new Map(spec.map(([id, pos, base], i) => [id, {
      id, name: `p${id}`, pos, nfl: "X", eligibleSlots: [], rawStats: [], teamId: 1 + (i % 2),
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

  // Only the shape matters, not the scale: a source published at any multiple of its
  // own scale is the same source. This is the property that makes averaging a feed
  // scored under someone else's rules legitimate at all, so it is guarded with a
  // source that genuinely DISAGREES with ESPN (it ranks 101 first, ESPN ranks him
  // last) and covers only part of the position — a source proportional to ESPN's own
  // shape would pass even if the normalization were broken.
  //
  // Hand-computed at scale 1: shared 101:30, 102:10, 103:20 -> mS = 20; ESPN live
  // 10,20,30,40 -> mE = 25; kS = ((10+20+30)/3)/25 = 0.8.
  //   frac_s : 1.2, 0.4, 0.8      frac_E : 0.4, 0.8, 1.2, 1.6
  //   agg(101) = 25*(0.4+1.2)/2 = 20 ; agg(102) = 15 ; agg(103) = 25 ; 104 untouched
  //   band(101) = 25*|0.4-1.2|/2 = 10 ; band(102) = band(103) = 5
  // The `kS` factor is load-bearing in these numbers — drop it and agg(101) becomes
  // 25*(0.4+1.5)/2 = 23.75 — so this block pins the correction as well as the scale.
  {
    const shape = [[101, 30], [102, 10], [103, 20]];
    const at = (k) => {
      const m = mkModel();
      const r = aggregateProjections(m, [src("sleeper", 5, shape.map(([id, v]) => [id, v * k]))], [5]);
      return { proj: [101, 102, 103, 104].map((id) => m.players.get(id).proj[5]),
               band: [101, 102, 103].map((id) => r.band.get(id)[0]) };
    };
    const base = at(1);
    ok(base.proj.join() === "20,15,25,40", `the disagreeing source lands where kS says (${base.proj})`);
    ok(close(base.band[0], 10) && close(base.band[1], 5) && close(base.band[2], 5),
       `and the band with it (${base.band})`);
    // 2x is the invariant CLAUDE.md names; 0.5x and 0.37x are the same claim from the
    // other side. `proj` is rounded to two decimals so it compares exactly; the band
    // is raw, so it agrees to floating-point rather than bit for bit.
    for (const k of [2, 0.5, 0.37]) {
      const s = at(k);
      ok(s.proj.join() === base.proj.join(), `a source at ${k}x aggregates identically (${s.proj})`);
      ok(s.band.every((b, i) => close(b, base.band[i], 1e-9)),
         `a source at ${k}x bands identically (${s.band})`);
    }
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
    ok(r.touched === 0 && r.band.size === 0, "no sources changes nothing");
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
    ok(r5.touched === 4, "touched counts the players the aggregate wrote to");
    // The name is the point: agreement writes the same number back and still counts.
    const m6 = mkModel();
    const r6 = aggregateProjections(m6, [src("sleeper", 5, [[101, 10], [102, 20], [103, 30], [104, 40]])], [5]);
    ok(r6.touched === 4 && close(m6.players.get(101).proj[5], 10),
       "touched counts a player a source agreed with exactly");
  }
}

/* ---- 5. the calibration log ---- */
{
  ok(logKey(7, 2026) === "ffsm.calib.7.2026", "the log is keyed by league and season");

  /* storage round trip */
  {
    const storage = mkStorage();
    const ref = { storage, leagueId: 7, seasonId: 2026 };
    await logWeek({ ...ref, week: 5, rows: [{ id: 101, pos: "RB", espn: 10, sleeper: 11, fp: 12, agg: 11 }], now: 1 });
    await logWeek({ ...ref, week: 6, rows: [{ id: 101, pos: "RB", espn: 20, sleeper: null, fp: null, agg: 20 }], now: 2 });
    const log = await loadLog(ref);
    ok(weeksStored(log) === 2, "two weeks stored");
    ok(log.weeks["5"].rows[0].sleeper === 11, "a row round-trips");
    ok(log.weeks["5"].at === 1, "each week records when it was written");
    await logWeek({ ...ref, week: 5, rows: [{ id: 101, pos: "RB", espn: 99, sleeper: null, fp: null, agg: 99 }], now: 3 });
    const log2 = await loadLog(ref);
    ok(weeksStored(log2) === 2 && log2.weeks["5"].rows[0].espn === 99, "re-running a week overwrites it");
    ok((await loadLog({ storage, leagueId: 8, seasonId: 2026 })).weeks
       && weeksStored(await loadLog({ storage, leagueId: 8, seasonId: 2026 })) === 0,
       "an unknown league reads as an empty log");
  }

  /* actuals come from ESPN's own rawStats, filtered on seasonId */
  {
    const log = { weeks: { 5: { at: 0, rows: [
      { id: 101, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10 },
      { id: 999, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10 },
    ] } } };
    // The decoys come FIRST on purpose. `attachActuals` uses `.find()`, so with the
    // true row leading, dropping any predicate from the filter would still pass and
    // the test would advertise a guarantee it does not provide. In this order every
    // predicate is load-bearing: remove `seasonId` and 2025's 99 wins, remove
    // `statSourceId` and the projection's 88 wins, remove `statSplitTypeId` and the
    // season-total 77 wins. Reading last season's numbers measures ~15% low.
    const players = new Map([[101, { id: 101, rawStats: [
      { statSourceId: 0, statSplitTypeId: 1, seasonId: 2025, scoringPeriodId: 5, appliedTotal: 99 },
      { statSourceId: 1, statSplitTypeId: 1, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 88 },
      { statSourceId: 0, statSplitTypeId: 0, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 77 },
      { statSourceId: 0, statSplitTypeId: 1, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 13.456 },
    ] }]]);
    const r = attachActuals(log, players, 2026);
    ok(close(log.weeks["5"].rows[0].actual, 13.46), "the actual is read and rounded");
    ok(log.weeks["5"].rows[1].actual === undefined, "a player no longer in the league is left alone");
    ok(r.filled === 1, "filled counts the rows joined");
    ok(weeksWithActuals(log) === 1, "a week with any actual counts");
    ok(weeksWithActuals({ weeks: { 6: { rows: [{ id: 1, espn: 1 }] } } }) === 0, "a week with no actuals does not");

    // `filled` means "rows now carrying an actual", not "rows newly joined this
    // call": a row that arrived already filled counts, and is left as it was.
    const pre = { weeks: { 5: { at: 0, rows: [
      { id: 101, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10, actual: 7 },
      { id: 777, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10 },
    ] } } };
    ok(attachActuals(pre, players, 2026).filled === 1, "filled counts a row that was already filled");
    ok(close(pre.weeks["5"].rows[0].actual, 7), "an actual already present is not overwritten");
  }

  /* MAE, bias and slope on a hand-checkable log */
  {
    // espn 10 -> actual 12 (err +2) ; espn 20 -> actual 16 (err -4)
    const log = { weeks: {
      5: { at: 0, rows: [{ id: 1, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10, actual: 12 }] },
      6: { at: 0, rows: [{ id: 1, pos: "RB", espn: 20, sleeper: null, fp: null, agg: 20, actual: 16 }] },
    } };
    const rows = summary(log);
    const rb = rows.find((r) => r.source === "espn" && r.pos === "RB");
    ok(rb.n === 2, "summary counts pairs");
    ok(close(rb.mae, 3), "MAE is the mean absolute error");
    ok(close(rb.bias, -1), "bias is the mean signed error");
    ok(close(rb.slope, 0.4), "slope is OLS of actual on projection");
    ok(rows.every((r) => r.source !== "sleeper"), "a source with no values produces no row");
    ok(summary({ weeks: {} }).length === 0, "an empty log summarises to nothing");
  }

  /* a synthetic season: actual = 0.8 * proj + deterministic noise */
  {
    // A small LCG so the test is reproducible: real noise, no Math.random.
    // MINSTD: seed * 48271 stays inside the safe-integer range. The textbook
    // (seed * 1103515245 + 12345) does not, and silently degenerates.
    let seed = 12345;
    const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 - 0.5) * 4; };
    const weeks = {};
    for (let w = 1; w <= 8; w++) {
      const rows = [];
      for (const pos of FIT_POS)
        for (let k = 0; k < 20; k++) {
          const proj = 4 + k * 1.2;
          rows.push({ id: `${pos}${k}`, pos, espn: proj, sleeper: null, fp: null,
                      agg: proj, actual: Math.round((0.8 * proj + noise()) * 100) / 100 });
        }
      weeks[w] = { at: 0, rows };
    }
    const log = { weeks };
    ok(weeksWithActuals(log) === 8, "eight weeks have actuals");
    const k = fitSlopes(log);
    ok(k !== null, "with eight weeks the fit runs");
    ok(FIT_POS.every((p) => Math.abs(k[p] - 0.8) < 0.05), `fitted slopes land near 0.8 (${JSON.stringify(k)})`);

    /* fewer than six weeks with actuals returns null slopes */
    const short = { weeks: Object.fromEntries(Object.entries(weeks).slice(0, 5)) };
    ok(weeksWithActuals(short) === 5, "five weeks in the short log");
    ok(fitSlopes(short) === null, "fewer than six weeks with actuals returns null");

    /* a position below the observation floor is null rather than a noisy number */
    const thin = { weeks: Object.fromEntries(Object.entries(weeks).map(([w, e]) =>
      [w, { at: 0, rows: e.rows.filter((r) => r.pos !== "TE" || Number(r.id.slice(2)) < 1) }])) };
    const kThin = fitSlopes(thin);
    ok(kThin.TE === null, `a position with fewer than ${MIN_N} pairs is null`);
    ok(typeof kThin.QB === "number", "the other positions still fit");

    /* an absurd slope is clamped rather than trusted */
    const wild = { weeks: Object.fromEntries(Object.entries(weeks).map(([w, e]) =>
      [w, { at: 0, rows: e.rows.map((r) => ({ ...r, actual: r.agg * 9 })) }])) };
    ok(fitSlopes(wild).RB === 1.2, "a slope above the clamp is clamped");
    const flat = { weeks: Object.fromEntries(Object.entries(weeks).map(([w, e]) =>
      [w, { at: 0, rows: e.rows.map((r) => ({ ...r, actual: r.agg * 0.01 })) }])) };
    ok(fitSlopes(flat).RB === 0.3, "a slope below the clamp is clamped");

    ok(MIN_WEEKS === 6, "the week floor is six");
  }

  /* the fit is WITHIN-week, and the two estimators are distinguishable */
  {
    // Every week has the same within-week slope (0.8) but a very different level:
    // week w's projections start 30 points higher than week w-1's. The level is
    // arranged so the BETWEEN-week slope is exactly 1 — each week's mean actual
    // equals its mean projection — which is the direction real weekly levels drift
    // (a high-scoring week is high for everyone, projections included).
    //
    // A pooled OLS mixes the two, weighted by their sums of squares. Here the
    // between-week spread swamps the within-week spread (756000 vs 7660.8), so a
    // pooled fit lands near 1.0 — under-shrinkage, the wrong direction for a
    // shrinkage feature. `shrinkProjections` re-centres on each week's own mean, so
    // 0.8 is the number it needs and the number the fit must return.
    const weeks = {};
    for (let w = 1; w <= 8; w++) {
      const level = 4 + 30 * (w - 1);
      const projs = Array.from({ length: 20 }, (_, k) => level + 1.2 * k);
      const meanProj = projs.reduce((a, b) => a + b, 0) / projs.length;
      weeks[w] = { at: 0, rows: projs.map((proj, k) => ({
        id: `RB${k}`, pos: "RB", espn: proj, sleeper: null, fp: null, agg: proj,
        actual: 0.8 * proj + 0.2 * meanProj,     // within 0.8, between exactly 1
      })) };
    }
    const log = { weeks };

    // The pooled estimator, computed here so the test shows what it is rejecting.
    const all = Object.values(weeks).flatMap((e) => e.rows.map((r) => [r.agg, r.actual]));
    const mx = all.reduce((a, [x]) => a + x, 0) / all.length;
    const my = all.reduce((a, [, y]) => a + y, 0) / all.length;
    const pooled = all.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0)
                 / all.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    ok(Math.abs(pooled - 1) < 0.01, `the pooled estimator is dragged to ~1 (${pooled.toFixed(4)})`);
    ok(Math.abs(pooled - 0.8) > 0.15, "which is nowhere near the real within-week slope");

    const k = fitSlopes(log);
    ok(close(k.RB, 0.8, 1e-9), `the within-week fit recovers 0.8 exactly (${k.RB})`);
    ok(k.QB === null && k.WR === null && k.TE === null, "positions with no rows stay null");
  }

  /* rows with no variation cannot produce a slope */
  {
    const rows = [];
    for (let k = 0; k < 25; k++) rows.push({ id: k, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10, actual: 11 });
    const log = { weeks: Object.fromEntries([1, 2, 3, 4, 5, 6].map((w) => [w, { at: 0, rows: rows.map((r) => ({ ...r })) }])) };
    ok(fitSlopes(log).RB === null, "no spread in the projections means no slope");
    ok(close(summary(log).find((r) => r.source === "agg" && r.pos === "RB").bias, 1), "bias still works");
  }

  /* mergeSlopes: fitted where measured, literature where not */
  {
    const none = mergeSlopes(null);
    ok(Object.keys(none.k).length === Object.keys(CALIBRATION_K).length
       && Object.keys(CALIBRATION_K).every((p) => none.k[p] === CALIBRATION_K[p]),
       "no fit falls back to the literature constants");
    ok(none.fitted === false && none.positions.length === 0, "no fit reports itself as unfitted");

    const allNull = mergeSlopes({ QB: null, RB: null, WR: null, TE: null });
    ok(FIT_POS.every((p) => allNull.k[p] === CALIBRATION_K[p]), "an all-null fit is the same fallback");
    ok(allNull.fitted === false && allNull.positions.length === 0, "an all-null fit is not reported as fitted");

    const part = mergeSlopes({ QB: null, RB: 0.9, WR: null, TE: null });
    ok(part.k.RB === 0.9, "a measured position uses its fitted slope");
    ok(part.k.QB === CALIBRATION_K.QB && part.k.WR === CALIBRATION_K.WR && part.k.TE === CALIBRATION_K.TE,
       "the unmeasured positions keep the literature constants");
    ok(part.fitted === true && part.positions.length === 1 && part.positions[0] === "RB",
       "positions names exactly what was measured");
    ok(CALIBRATION_K.QB === 0.67 && CALIBRATION_K.RB === 0.79 && CALIBRATION_K.WR === 0.85
       && CALIBRATION_K.TE === 0.72, "merging does not mutate the imported constants");
  }
}

/* ---- 6. the panel module ---- */
{
  /* band helpers */
  {
    const band = new Map([[1, Float64Array.from([2, 4, 0])], [2, Float64Array.from([0.3, 0.3, 0.3])]]);
    ok(close(bandMean(band, 1), 2), "bandMean is a plain mean over every week");
    ok(bandMean(band, 99) === 0, "an unknown player bands at zero");
    ok(bandMean(null, 1) === 0, "no band at all is zero");
    ok(bandTag(band, 1).trim() === "±2.0", "a band over the threshold renders");
    ok(bandTag(band, 2) === "", "a band under the threshold is silent");
    ok(bandTag(band, 99) === "", "an unknown player renders nothing");
  }

  /* chips reflect the toggle */
  {
    const on = sourcesChips({ aggregate: true });
    ok(on.includes('id="sources"'), "the chip group has an id to bind to");
    ok(/data-v="1"[^>]*aria-pressed="true"/.test(on), "aggregate on is pressed");
    ok(/data-v="0"[^>]*aria-pressed="false"/.test(on), "espn-only is not pressed");
    const off = sourcesChips({ aggregate: false });
    ok(/data-v="0"[^>]*aria-pressed="true"/.test(off), "the toggle flips");
  }

  /* bindSourcesChips: the click guard reads the chip's own aria-pressed, not a
     global. Regression for a bug where the guard read `window.__aggregate`
     instead: with that global unset (as it is here, and as it is before Task 7's
     `start()` first runs), clicking the Aggregate chip silently no-opped no
     matter which chip was actually pressed, wedging the toggle into ESPN-only. */
  {
    const mkBtn = (v, pressed) => ({
      dataset: { v },
      _pressed: pressed,
      getAttribute(k) { return k === "aria-pressed" ? String(this._pressed) : null; },
      onclick: null,
    });
    // Current state: aggregate is OFF (ESPN only is the pressed chip) — the exact
    // state the old bug got stuck in.
    const btnOn = mkBtn("1", false);    // Aggregate, not pressed
    const btnOff = mkBtn("0", true);    // ESPN only, pressed
    const root = { querySelectorAll: () => [btnOn, btnOff] };

    const storage = mkStorage();
    let reloads = 0;
    bindSourcesChips(root, { storage, reload: () => { reloads++; } });

    await btnOff.onclick();
    ok((await storage.get("ffsm.aggregate"))["ffsm.aggregate"] === undefined,
      "clicking the already-pressed chip writes nothing");
    ok(reloads === 0, "clicking the already-pressed chip does not reload");

    await btnOn.onclick();
    ok((await storage.get("ffsm.aggregate"))["ffsm.aggregate"] === true,
      "clicking the unpressed chip persists the new value");
    ok(reloads === 1, "clicking the unpressed chip reloads exactly once");
  }

  /* the calibration section */
  {
    const grid = (id, cols, rows, opts) => `<table id="${id}">${rows.map((r) => opts.row(r, 0)).join("")}</table>`;
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const html = calibrationSection({
      summaryRows: [{ source: "espn", pos: "RB", n: 40, mae: 5.5, bias: -1.2, slope: 0.81 },
                    { source: "agg", pos: "RB", n: 40, mae: 5.1, bias: -0.9, slope: null }],
      fitted: true, fittedPositions: ["RB"], k: { QB: 0.67, RB: 0.81, WR: 0.85, TE: 0.72 },
      weeksStored: 8, weeksWithActuals: 7,
    }, { grid, esc });
    ok(html.includes("<section"), "it returns a section");
    ok(/Calibration/.test(html), "it is titled");
    ok(html.includes("0.81"), "a fitted slope is shown");
    ok(html.includes("—"), "a null slope renders as a dash");
    ok(/fitted/i.test(html), "the note says fitted slopes are in use");
    // The phrases, not the digits: `/8/` and `/7/` were satisfied by the 0.81 and
    // 0.67 already in the markup, so they asserted nothing.
    ok(/8 weeks logged/.test(html), "it says how many weeks are logged");
    ok(/7 with actuals/.test(html), "it says how many carry actuals");

    const early = calibrationSection({ summaryRows: [], fitted: false, fittedPositions: [],
      k: { QB: 0.67, RB: 0.79, WR: 0.85, TE: 0.72 }, weeksStored: 1, weeksWithActuals: 0 },
      { grid, esc });
    ok(/literature/i.test(early), "before the fit the note says literature slopes");
    ok(!/undefined/.test(early), "an empty log renders without holes");
  }

  /* runProjections end to end, offline */
  {
    const lines = [];
    const say = (t, c) => { lines.push(String(t)); return {}; };
    const model = mkModel([5, 6]);
    for (const p of model.players.values())
      p.rawStats = [{ statSourceId: 0, statSplitTypeId: 1, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 12 }];
    model.settings = { pprValue: 0.5, currentWeek: 5 };

    const sleeperPlayers = Object.fromEntries([101, 102, 103, 104, 201, 202].map((id, i) =>
      [`s${i}`, { player_id: `s${i}`, espn_id: id, full_name: `p${id}`, position: "RB" }]));
    const wk = (mult) => [101, 102, 103, 104, 201, 202].map((id, i) => ({
      player_id: `s${i}`, stats: { pts_ppr: 0, pts_half_ppr: [10, 20, 30, 40, 15, 25][i] * mult, pts_std: 0 } }));
    const table = {
      "https://api.sleeper.app/v1/players/nfl": sleeperPlayers,
      [(await import("../engine/sources/sleeperproj.js")).weekUrl(2026, 5)]: wk(1),
      [(await import("../engine/sources/sleeperproj.js")).weekUrl(2026, 6)]: wk(1),
    };
    const storage = mkStorage();
    const P = await runProjections({ model, ref: { leagueId: 7, seasonId: 2026 }, say,
      fetchImpl: mkFetch(table), storage, now: 0 });

    ok(P.aggregate === true, "the toggle defaults to on");
    ok(P.coverage.sleeper === 6, "coverage is reported");
    ok(P.band instanceof Map, "a band comes back");
    ok(P.k && typeof P.k.RB === "number", "a slope map comes back");
    ok(P.fitted === false, "one week of actuals is not enough to fit");
    ok(close(P.k.RB, 0.79) && close(P.k.QB, 0.67), "so the literature slopes are in use");
    ok(P.weeksStored === 1, "the current week was logged");
    ok(lines.some((l) => /Sleeper covers 6/.test(l)), `a coverage line is logged (${JSON.stringify(lines)})`);
    ok(lines.some((l) => /calibration log/.test(l)), "a calibration-log line is logged");
    ok(lines.some((l) => /FantasyPros/.test(l)), "FantasyPros is mentioned even when unavailable");

    const log = (await storage.get("ffsm.calib.7.2026"))["ffsm.calib.7.2026"];
    const row = log.weeks["5"].rows.find((r) => r.id === 101);
    ok(row.espn === 10, "the logged espn value is the pre-aggregate one");
    ok(Number.isFinite(row.agg), "the logged agg value is the post-aggregate one");
    ok(row.pos === "RB" && row.id === 101, "id and pos are logged");
    ok(row.fp === null, "an unavailable source logs null, not a guess");

    /* toggle off: no fetches, agg = espn */
    const model2 = mkModel([5, 6]);
    const f2 = mkFetch(table);
    await storage.set({ "ffsm.aggregate": false });
    const P2 = await runProjections({ model: model2, ref: { leagueId: 7, seasonId: 2026 }, say,
      fetchImpl: f2, storage, now: 0 });
    ok(P2.aggregate === false, "the stored toggle is honoured");
    ok(f2.calls.length === 0, "nothing is fetched when the toggle is off");
    ok(model2.players.get(101).proj[5] === 10, "espn-only leaves the projections alone");
    ok(P2.band.size === 0, "espn-only produces no band");

    /* every feed dead: still no throw, still espn */
    await storage.set({ "ffsm.aggregate": true });
    const model3 = mkModel([5, 6]);
    const P3 = await runProjections({ model: model3, ref: { leagueId: 9, seasonId: 2026 }, say,
      fetchImpl: mkFetch({}), storage: mkStorage(), now: 0 });
    ok(model3.players.get(101).proj[5] === 10, "a dead feed leaves agg = espn");
    ok(P3.k.RB === 0.79, "a dead feed still yields usable slopes");
    ok(P3.coverage.sleeper === 0 && P3.coverage.fp === 0, "coverage is zero, not undefined");
  }

  /* the log keeps rostered players only; the aggregate still covers everyone */
  {
    const model = mkModel([5, 6]);
    // A free agent exactly as `loadFreeAgents` builds one: `teamId: null`. `panel.js`
    // merges the pool (limit 400) into `model.players` BEFORE `runProjections` runs,
    // so an unfiltered log is roughly 70% deep-bench adds projected 2-5 points that
    // score 0 because they were inactive — a different slope, outnumbering the
    // players who actually start about 2.5 to 1.
    model.players.set(105, { id: 105, name: "fa105", pos: "RB", nfl: "X", eligibleSlots: [],
      rawStats: [], teamId: null, proj: { 5: 25, 6: 25 } });
    model.settings = { pprValue: 0.5, currentWeek: 5 };

    const { weekUrl } = await import("../engine/sources/sleeperproj.js");
    const ids = [101, 102, 103, 104, 105];
    const players = Object.fromEntries(ids.map((id, i) =>
      [`s${i}`, { player_id: `s${i}`, espn_id: id, full_name: `p${id}`, position: "RB" }]));
    // A source that disagrees, so "was aggregated" is visible as a moved number.
    const rows = ids.map((id, i) => ({ player_id: `s${i}`,
      stats: { pts_ppr: 0, pts_half_ppr: [40, 30, 20, 10, 50][i], pts_std: 0 } }));
    const storage = mkStorage();
    const PF = await runProjections({ model, ref: { leagueId: 11, seasonId: 2026 }, say: () => {},
      storage, now: 0, fetchImpl: mkFetch({ "https://api.sleeper.app/v1/players/nfl": players,
        [weekUrl(2026, 5)]: rows, [weekUrl(2026, 6)]: rows }) });

    ok(model.players.get(105).proj[5] !== 25, "the free agent IS aggregated");
    ok(model.players.get(101).proj[5] !== 10, "and so is the rostered player");
    ok(model.players.get(105).proj[5] > 25, "the free agent moves toward the source that likes him");
    ok(PF.band.has(105), "the free agent gets a ± band, so the trade UI can show it");
    ok(PF.coverage.sleeper === 5, "and he counts toward coverage");
    const key = logKey(11, 2026);
    const logged = (await storage.get(key))[key].weeks["5"].rows.map((r) => r.id);
    ok(!logged.includes(105), "but the free agent is NOT in the calibration log");
    ok(logged.includes(101), "while the rostered player is");
    ok(logged.length === 6, `only the six rostered players are logged (${logged})`);
  }

  /* actuals joined during a run are written back, not just held in memory */
  {
    const storage = mkStorage();
    const ref = { leagueId: 12, seasonId: 2026 };
    // Week 5 as last week's run left it: logged, no actual yet.
    await logWeek({ storage, ...ref, week: 5, now: 0,
      rows: [{ id: 101, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10 }] });

    const model = mkModel([6, 7]);
    model.settings = { pprValue: 0.5, currentWeek: 6 };
    model.players.get(101).rawStats = [
      { statSourceId: 0, statSplitTypeId: 1, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 13.5 }];
    await storage.set({ "ffsm.aggregate": false });     // nothing to fetch; the log is the point
    await runProjections({ model, ref, say: () => {}, storage, fetchImpl: mkFetch({}), now: 0 });

    const reloaded = await loadLog({ storage, ...ref });
    ok(close(reloaded.weeks["5"].rows[0].actual, 13.5),
       "an actual joined this run is readable from storage on the next loadLog");
    ok(weeksWithActuals(reloaded) === 1, "and the reloaded log counts that week");
  }
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PROJECTIONS OK");
