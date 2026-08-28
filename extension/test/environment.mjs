/**
 * Phase 7 - game environment. Everything here runs offline: every fetch is injected,
 * and the streaming planner is driven from the same frozen fixture parity.mjs uses.
 *
 *   node extension/test/environment.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PRO_TEAM } from "../engine/league.js";
import { STADIUMS, PRO_TEAM_ID, stadiumOf, isOutdoor } from "../engine/sources/stadiums.js";
import { VEGAS_BASE, refId, impliedTotals, pickOdds, buildWeek, loadVegas }
  from "../engine/sources/vegas.js";
import { atKickoff, loadWeather } from "../engine/sources/weather.js";
import { ENV_K, envGroup, avgImplied, vegasFactor, weatherFactor, applyEnvironment }
  from "../engine/environment.js";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { Engine } from "../engine/search.js";
import { streamPlan } from "../engine/streaming.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));

let checks = 0, failures = 0;
const ok = (cond, what) => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}`); }
};

/* Injected storage and fetch, copied from sources.mjs so this file stays offline. */
const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; },
  async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const mkFetch = (table) => { const calls = []; const f = async (url) => { calls.push(url);
  const hit = table[url]; if (!hit) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; };
  f.calls = calls; return f; };

/* ---- 1. the stadium table ---- */
{
  const ids = Object.keys(STADIUMS).map(Number);
  ok(ids.length === 32, `32 stadium rows, got ${ids.length}`);
  ok(ids.every((id) => PRO_TEAM[id]), "every stadium key is an ESPN pro team id");
  const teams = Object.keys(PRO_TEAM).map(Number).filter((id) => id !== 0);
  ok(teams.every((id) => STADIUMS[id]), "every pro team except free agency has a stadium");
  ok(ids.every((id) => {
    const s = STADIUMS[id];
    return s.lat > 24 && s.lat < 48 && s.lon < -70 && s.lon > -126;
  }), "every stadium sits inside the continental United States");
  ok(ids.every((id) => ["open", "dome", "retractable"].includes(STADIUMS[id].roof)),
     "every roof is one of the three known kinds");
  ok(ids.every((id) => typeof STADIUMS[id].name === "string" && STADIUMS[id].name.length > 3),
     "every row is named");
  ok(STADIUMS[8].roof === "dome" && STADIUMS[16].roof === "dome"
     && STADIUMS[18].roof === "dome" && STADIUMS[13].roof === "dome",
     "Detroit, Minnesota, New Orleans and Las Vegas are domes");
  ok(STADIUMS[6].roof === "retractable" && STADIUMS[34].roof === "retractable"
     && STADIUMS[22].roof === "retractable" && STADIUMS[11].roof === "retractable"
     && STADIUMS[1].roof === "retractable",
     "Dallas, Houston, Arizona, Indianapolis and Atlanta are retractable");
  ok(STADIUMS[9].roof === "open" && STADIUMS[3].roof === "open"
     && STADIUMS[2].roof === "open" && STADIUMS[26].roof === "open",
     "Green Bay, Chicago, Buffalo and Seattle are open");
  ok(STADIUMS[19].lat === STADIUMS[20].lat && STADIUMS[19].lon === STADIUMS[20].lon,
     "the Giants and the Jets share MetLife");
  ok(STADIUMS[14].lat === STADIUMS[24].lat && STADIUMS[14].lon === STADIUMS[24].lon,
     "the Rams and the Chargers share SoFi");
  ok(Math.abs(STADIUMS[9].lat - 44.5) < 0.3 && Math.abs(STADIUMS[9].lon + 88.06) < 0.3,
     "Lambeau is where Lambeau is");
  ok(Math.abs(STADIUMS[15].lat - 25.96) < 0.3, "Miami is the southernmost stadium");

  ok(PRO_TEAM_ID.KC === 12 && PRO_TEAM_ID.BAL === 33 && PRO_TEAM_ID.HOU === 34,
     "abbreviation maps back to the pro team id");
  ok(Object.keys(PRO_TEAM_ID).length === 32, "32 abbreviations");
  ok(PRO_TEAM_ID.FA === undefined, "free agency is not a team");

  ok(isOutdoor(9) === true, "Green Bay is outdoors");
  ok(isOutdoor(18) === false, "a dome is not outdoors");
  ok(isOutdoor(6) === false, "a retractable roof counts as covered");
  ok(isOutdoor(999) === false, "an unknown team is not outdoors");
  ok(stadiumOf(12).name.length > 0 && stadiumOf(999) === null, "stadiumOf");
}

/* ---- 2. Vegas lines ---- */
{
  ok(refId("https://x/teams/12?lang=en&region=us") === 12, "refId reads the trailing id");
  ok(refId("https://x/events/401671789") === 401671789, "refId with no query string");
  ok(refId(undefined) === null && refId("https://x/teams/none") === null, "refId of nothing");

  const t = impliedTotals(47.5, -6.5);
  ok(Math.abs(t.favorite - 27) < 1e-9 && Math.abs(t.underdog - 20.5) < 1e-9,
     "implied totals split the over/under by the spread");
  ok(Math.abs(impliedTotals(47.5, 6.5).favorite - 27) < 1e-9, "the sign of the spread is ignored");
  ok(Math.abs(impliedTotals(44, 0).favorite - 22) < 1e-9, "a pick'em splits evenly");
  ok(impliedTotals(0, -3) === null && impliedTotals(undefined, -3) === null,
     "no total, no implied totals");

  const rows = [{ provider: { id: 999 }, overUnder: 40, spread: -1 },
                { provider: { id: 58 }, overUnder: 47.5, spread: -6.5 }];
  ok(pickOdds(rows).provider.id === 58, "ESPN BET is preferred when it is present");
  ok(pickOdds([rows[0]]).provider.id === 999, "any priced provider will do");
  ok(pickOdds([{ provider: { id: 58 } }]) === null, "a row with no total is unusable");
  ok(pickOdds([]) === null && pickOdds(undefined) === null, "no rows, no odds");

  const ev = (homeId, awayId, odds, date) => ({
    date,
    competitions: [{
      id: "c1", date,
      competitors: [{ homeAway: "home", team: { $ref: `x/teams/${homeId}?lang=en` } },
                    { homeAway: "away", team: { $ref: `x/teams/${awayId}?lang=en` } }],
    }],
    odds,
  });
  const wk = buildWeek([
    ev(12, 7, [{ provider: { id: 58 }, overUnder: 47.5, spread: -6.5,
                 homeTeamOdds: { favorite: true }, awayTeamOdds: { favorite: false } }],
       "2026-09-13T17:00Z"),
    ev(3, 9, [{ provider: { id: 58 }, overUnder: 40, spread: 3,
                homeTeamOdds: { favorite: false }, awayTeamOdds: { favorite: true } }],
       "2026-09-13T20:25Z"),
    ev(1, 2, [], null),
  ]);
  ok(wk.size === 4, `only priced games reach the map (${wk.size})`);
  ok(Math.abs(wk.get(12).implied - 27) < 1e-9, "the home favourite gets the bigger half");
  ok(Math.abs(wk.get(7).implied - 20.5) < 1e-9, "the away underdog gets the smaller half");
  ok(Math.abs(wk.get(9).implied - 21.5) < 1e-9, "the away favourite gets the bigger half");
  ok(Math.abs(wk.get(3).implied - 18.5) < 1e-9, "the home underdog gets the smaller half");
  ok(wk.get(12).opp === 7 && wk.get(7).opp === 12, "each side names the other");
  ok(Math.abs(wk.get(12).oppImplied - 20.5) < 1e-9, "oppImplied mirrors the other side");
  ok(wk.get(12).home === true && wk.get(7).home === false, "the home flag");
  ok(Math.abs(wk.get(12).total - 47.5) < 1e-9 && Math.abs(wk.get(12).spread - 6.5) < 1e-9,
     "the raw line rides along, spread unsigned");
  ok(wk.get(12).kickoff === "2026-09-13T17:00Z", "kickoff comes off the competition");
  ok(!wk.has(1) && !wk.has(2), "an unpriced game is absent, not zero");

  // A favourite flagged nowhere falls back to the sign of the spread, which ESPN
  // quotes from the home team's point of view.
  const implicit = buildWeek([ev(21, 6, [{ provider: { id: 58 }, overUnder: 50, spread: -7 }], null)]);
  ok(Math.abs(implicit.get(21).implied - 28.5) < 1e-9,
     "a negative spread means the home team is favoured");
}

/* ---- 2b. loadVegas over an injected feed ---- */
{
  const B = VEGAS_BASE;
  const season = 2026, week = 4;
  const list = `${B}/seasons/${season}/types/2/weeks/${week}/events`;
  const table = {
    [list]: { items: [{ $ref: `${B}/events/401?lang=en` }, { $ref: `${B}/events/402?lang=en` }] },
    [`${B}/events/401?lang=en`]: {
      date: "2026-09-27T17:00Z",
      competitions: [{ id: "401", date: "2026-09-27T17:00Z",
        odds: { $ref: `${B}/events/401/competitions/401/odds` },
        competitors: [{ homeAway: "home", team: { $ref: `${B}/teams/12?lang=en` } },
                      { homeAway: "away", team: { $ref: `${B}/teams/7?lang=en` } }] }],
    },
    [`${B}/events/401/competitions/401/odds`]: {
      items: [{ provider: { id: 58 }, overUnder: 50, spread: -4, homeTeamOdds: { favorite: true } }],
    },
    // No odds $ref and no odds resource: this game must be dropped, not fatal.
    [`${B}/events/402?lang=en`]: {
      date: "2026-09-27T17:00Z",
      competitions: [{ id: "402", date: "2026-09-27T17:00Z",
        competitors: [{ homeAway: "home", team: { $ref: `${B}/teams/9?lang=en` } },
                      { homeAway: "away", team: { $ref: `${B}/teams/3?lang=en` } }] }],
    },
  };
  const storage = mkStorage();
  const fetchImpl = mkFetch(table);
  const v = await loadVegas(season, [week], { fetchImpl, storage, now: 0 });
  ok(v.get(week).size === 2, `one priced game, two teams (${v.get(week).size})`);
  ok(Math.abs(v.get(week).get(12).implied - 27) < 1e-9, "the implied total survives the whole pipe");
  ok(!v.get(week).has(9), "a game whose odds resource is missing is dropped, not fatal");

  const before = fetchImpl.calls.length;
  await loadVegas(season, [week], { fetchImpl, storage, now: 3600e3 });
  ok(fetchImpl.calls.length === before, "a second load inside the three-hour TTL is free");

  const dead = await loadVegas(season, [week, week + 1], { fetchImpl, storage: mkStorage(),
    now: 0, ttlMs: 1 });
  ok(dead.get(week + 1) instanceof Map && dead.get(week + 1).size === 0,
     "a week with no schedule is an empty map, not a throw");

  const allDead = await loadVegas(season, [week], { fetchImpl: mkFetch({}), storage: mkStorage(), now: 0 });
  ok(allDead.get(week).size === 0, "a dead feed is an empty map, not a throw");
}

/* ---- 3. weather ---- */
{
  const hourly = {
    time: ["2026-09-27T16:00", "2026-09-27T17:00", "2026-09-27T18:00"],
    wind_speed_10m: [10, 22, 30],
    wind_gusts_10m: [15, 31, 40],
    precipitation_probability: [5, 80, 90],
  };
  const at = atKickoff(hourly, "2026-09-27T17:00Z");
  ok(at.wind === 22 && at.gust === 31 && at.precipProb === 80, "the sample nearest kickoff");
  ok(atKickoff(hourly, "2026-09-27T16:20Z").wind === 10, "nearest, not next");
  ok(atKickoff(hourly, "2026-09-27T17:40Z").wind === 30, "18:00 is nearer to 17:40 than 17:00");
  ok(atKickoff(hourly, "2026-10-04T17:00Z") === null,
     "a kickoff the forecast does not reach has no reading");
  ok(atKickoff({ time: [] }, "2026-09-27T17:00Z") === null, "an empty forecast");
  ok(atKickoff(undefined, "2026-09-27T17:00Z") === null, "no forecast at all");

  const noWind = {
    time: ["2026-09-27T16:00", "2026-09-27T17:00", "2026-09-27T18:00"],
    wind_speed_10m: [10, 22],                          // no entry for 18:00
    wind_gusts_10m: [15, 31, 40],
    precipitation_probability: [5, 80, 90],
  };
  ok(atKickoff(noWind, "2026-09-27T18:00Z") === null,
     "the nearest sample has no wind value, so there is no reading at all");

  const noPrecip = {
    time: ["2026-09-27T16:00", "2026-09-27T17:00"],
    wind_speed_10m: [10, 22],
    wind_gusts_10m: [15, 31],
    precipitation_probability: [5],                    // no entry for 17:00
  };
  const r2 = atKickoff(noPrecip, "2026-09-27T17:00Z");
  ok(r2 !== null && r2.wind === 22 && r2.precipProb === 0,
     "wind is present so a row comes back, with missing precip defaulting to 0");

  const week = new Map([
    [9,  { home: true,  opp: 3,  kickoff: "2026-09-27T17:00Z" }],   // Green Bay, open
    [3,  { home: false, opp: 9,  kickoff: "2026-09-27T17:00Z" }],
    [18, { home: true,  opp: 1,  kickoff: "2026-09-27T17:00Z" }],   // New Orleans, dome
    [1,  { home: false, opp: 18, kickoff: "2026-09-27T17:00Z" }],
    [6,  { home: true,  opp: 21, kickoff: "2026-09-27T17:00Z" }],   // Dallas, retractable
    [21, { home: false, opp: 6,  kickoff: "2026-09-27T17:00Z" }],
    [2,  { home: true,  opp: 5,  kickoff: null }],                  // Buffalo, no kickoff time
    [5,  { home: false, opp: 2,  kickoff: null }],
  ]);
  const gb = STADIUMS[9];
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${gb.lat}&longitude=${gb.lon}`
    + "&hourly=wind_speed_10m,wind_gusts_10m,precipitation_probability"
    + "&forecast_days=7&wind_speed_unit=mph&timezone=UTC";
  const fetchImpl = mkFetch({ [url]: { hourly } });
  const wx = await loadWeather(week, { fetchImpl, storage: mkStorage(), now: 0 });
  ok(fetchImpl.calls.length === 1, `one request per open-roof stadium (${fetchImpl.calls.length})`);
  ok(wx.get(9)?.wind === 22, "the home team gets the forecast");
  ok(wx.get(3)?.wind === 22, "so does the visitor - same field, same wind");
  ok(wx.get(9)?.stadium === "Lambeau Field", "the row names the stadium");
  ok(!wx.has(18) && !wx.has(1), "a dome is never fetched");
  ok(!wx.has(6) && !wx.has(21), "neither is a retractable roof");
  ok(!wx.has(2) && !wx.has(5), "a game with no kickoff time is skipped");

  const dead = await loadWeather(week, { fetchImpl: mkFetch({}), storage: mkStorage(), now: 0 });
  ok(dead.size === 0, "a dead forecast is an empty map, not a throw");
  ok((await loadWeather(new Map(), { fetchImpl, storage: mkStorage(), now: 0 })).size === 0,
     "no games, no forecasts");

  const windlessHourly = { ...hourly, wind_speed_10m: hourly.wind_speed_10m.slice(0, 1) };
  const windlessWx = await loadWeather(week,
    { fetchImpl: mkFetch({ [url]: { hourly: windlessHourly } }), storage: mkStorage(), now: 0 });
  ok(!windlessWx.has(9) && !windlessWx.has(3),
     "no usable wind at kickoff means the stadium is absent, not present with zeros");

  // Two clubs share MetLife, and both can be at home in the same week on different
  // days. That is one stadium and one forecast, read at two different kickoff hours.
  const met = STADIUMS[19];
  const metUrl = `https://api.open-meteo.com/v1/forecast?latitude=${met.lat}&longitude=${met.lon}`
    + "&hourly=wind_speed_10m,wind_gusts_10m,precipitation_probability"
    + "&forecast_days=7&wind_speed_unit=mph&timezone=UTC";
  const sharedWeek = new Map([
    [19, { home: true,  opp: 4,  kickoff: "2026-09-27T16:00Z" }],   // Giants, Sunday early
    [4,  { home: false, opp: 19, kickoff: "2026-09-27T16:00Z" }],
    [20, { home: true,  opp: 5,  kickoff: "2026-09-27T18:00Z" }],   // Jets, same field, later
    [5,  { home: false, opp: 20, kickoff: "2026-09-27T18:00Z" }],
  ]);
  const sharedFetch = mkFetch({ [metUrl]: { hourly } });
  const sharedWx = await loadWeather(sharedWeek,
    { fetchImpl: sharedFetch, storage: mkStorage(), now: 0 });
  ok(sharedFetch.calls.length === 1,
     `two tenants of one stadium are one request (${sharedFetch.calls.length})`);
  ok(sharedWx.get(19)?.wind === 10 && sharedWx.get(20)?.wind === 30,
     "each game reads its own kickoff hour out of the single cached forecast");
  ok(sharedWx.get(4)?.wind === 10 && sharedWx.get(5)?.wind === 30,
     "each visitor gets the row for the game it is actually in");
  ok(sharedWx.get(19)?.kickoff === "2026-09-27T16:00Z"
     && sharedWx.get(20)?.kickoff === "2026-09-27T18:00Z",
     "each row carries its own kickoff, not the first one fetched");
}

/* ---- 4. environment factors ---- */
{
  ok(envGroup("D/ST") === "dst", "defences are their own group");
  ok(envGroup("K") === "k", "so are kickers");
  ok(envGroup("RB") === "rb", "so are running backs");
  ok(envGroup("QB") === "pass" && envGroup("TQB") === "pass"
     && envGroup("WR") === "pass" && envGroup("TE") === "pass",
     "quarterbacks, team quarterbacks, receivers and tight ends share a group");
  ok(envGroup("LB") === null && envGroup("P") === null && envGroup("?") === null,
     "a position with no measured effect gets no factor");

  const week = new Map([
    [12, { implied: 28, opp: 7,  oppImplied: 20, total: 48, spread: 8, home: true }],
    [7,  { implied: 20, opp: 12, oppImplied: 28, total: 48, spread: 8, home: false }],
    [9,  { implied: 22, opp: 3,  oppImplied: 18, total: 40, spread: 4, home: true }],
    [3,  { implied: 18, opp: 9,  oppImplied: 22, total: 40, spread: 4, home: false }],
  ]);
  const avg = avgImplied(week);
  ok(Math.abs(avg - 22) < 1e-9, `avgImplied is the mean over the week's teams (${avg})`);
  ok(avgImplied(new Map()) === 0 && avgImplied(undefined) === 0, "no games, no average");

  const edge = (28 - 22) / 22;
  ok(Math.abs(vegasFactor("pass", week.get(12), avg) - (1 + 0.25 * edge)) < 1e-12,
     "passers move 0.25 of the gap to the week's average");
  ok(Math.abs(vegasFactor("rb", week.get(12), avg) - (1 + 0.15 * edge)) < 1e-12,
     "running backs move 0.15");
  ok(Math.abs(vegasFactor("k", week.get(12), avg) - (1 + 0.4 * edge)) < 1e-12,
     "kickers move 0.4");
  ok(Math.abs(vegasFactor("dst", week.get(12), avg) - (1 + 0.6 * (22 - 20) / 22)) < 1e-12,
     "a defence is priced off its opponent's implied total, not its own offence's");
  ok(vegasFactor("pass", week.get(3), avg) < 1, "below the week's average is a cut");
  ok(vegasFactor("dst", week.get(7), avg) < 1, "a defence facing the best offence is cut");
  ok(vegasFactor("pass", null, avg) === 1, "no game is identity");
  ok(vegasFactor("pass", week.get(12), 0) === 1, "no average is identity");
  ok(vegasFactor(null, week.get(12), avg) === 1, "a group with no coefficient is identity");
  // Hard-coded on purpose. ENV_K is the spec's binding constant table, so comparing
  // against ENV_K.clamp here would let a widened clamp through green.
  ok(ENV_K.clamp.hi === 1.4 && ENV_K.clamp.lo === 0.6, "the clamp range is [0.6, 1.4]");
  ok(vegasFactor("dst", { implied: 5, oppImplied: 0.1 }, 1) === 1.4,
     "an absurd edge clamps high");
  ok(vegasFactor("dst", { implied: 5, oppImplied: 100 }, 1) === 0.6,
     "an absurd edge clamps low");

  ok(weatherFactor("k", { wind: 10, precipProb: 0 }) === 1, "a calm day is identity");
  ok(weatherFactor("k", { wind: 15, precipProb: 0 }) === 1, "the threshold is exclusive");
  ok(weatherFactor("k", { wind: 18, precipProb: 0 }) === 0.9, "a kicker in 18 mph");
  ok(weatherFactor("k", { wind: 30, precipProb: 0 }) === 0.8,
     "the stronger wind rule replaces the weaker one, it does not compound");
  ok(weatherFactor("k", { wind: 30, precipProb: 100 }) === 0.8, "rain does not move a kicker");
  ok(weatherFactor("pass", { wind: 22, precipProb: 0 }) === 0.95, "passing in 22 mph");
  ok(weatherFactor("pass", { wind: 10, precipProb: 70 }) === 0.95, "passing in the rain");
  ok(weatherFactor("pass", { wind: 10, precipProb: 69 }) === 1, "just under the rain threshold");
  ok(Math.abs(weatherFactor("pass", { wind: 22, precipProb: 80 }) - 0.9025) < 1e-12,
     "wind and rain do compound with each other");
  ok(weatherFactor("rb", { wind: 30, precipProb: 90 }) === 1, "running backs ignore the weather");
  ok(weatherFactor("dst", { wind: 30, precipProb: 90 }) === 1, "so do defences");
  ok(weatherFactor("pass", null) === 1, "no forecast is identity");

  /* applyEnvironment */
  const mk = () => ({ players: new Map([
    [1, { id: 1, pos: "QB",   nfl: "KC",  proj: { 4: 20, 5: 20, 6: 20 } }],
    [2, { id: 2, pos: "RB",   nfl: "KC",  proj: { 4: 12, 5: 12, 6: 12 } }],
    [3, { id: 3, pos: "K",    nfl: "GB",  proj: { 4: 8,  5: 8,  6: 8 } }],
    [4, { id: 4, pos: "D/ST", nfl: "CHI", proj: { 4: 6,  5: 6,  6: 6 } }],
    [5, { id: 5, pos: "LB",   nfl: "KC",  proj: { 4: 9,  5: 9,  6: 9 } }],
    [6, { id: 6, pos: "WR",   nfl: "SEA", proj: { 4: 11, 5: 11, 6: 11 } }],
    [7, { id: 7, pos: "WR",   nfl: "KC",  proj: { 4: 0,  5: 11, 6: 11 } }],
  ]) });
  const vegas = new Map([[4, week], [5, week]]);
  const gust = { wind: 30, gust: 40, precipProb: 90 };
  const weather = new Map([[9, gust], [3, gust]]);

  const m = mk();
  const r = applyEnvironment(m, vegas, weather, [4, 5]);
  ok(m.players.get(1).proj[6] === 20, "a week outside the window is untouched");
  ok(m.players.get(6).proj[4] === 11, "a team with no line that week is untouched");
  ok(m.players.get(5).proj[4] === 9, "a position with no group is untouched");
  ok(m.players.get(7).proj[4] === 0, "a bye - nothing projected - is left at zero");
  ok(m.players.get(1).proj[4] > 20, "a quarterback on the week's highest total goes up");
  ok((m.players.get(2).proj[4] - 12) / 12 < (m.players.get(1).proj[4] - 20) / 20,
     "a running back moves less than a quarterback on the same team");
  ok(m.players.get(3).proj[4] < m.players.get(3).proj[5],
     "wind is applied only to the week the forecast covers");
  ok(Math.abs(m.players.get(3).proj[4] - 6.4) < 1e-9,
     `a kicker at the week's average in 30 mph loses a fifth (${m.players.get(3).proj[4]})`);
  ok(r.adjusted > 0, "the count of adjusted player-weeks is reported");
  ok(r.byPlayer.get(1).vegas > 1 && r.byPlayer.get(1).factor > 1,
     "byPlayer carries the current week's factors");
  ok(r.byPlayer.get(3).weeks[4].wx.wind === 30, "byPlayer carries the forecast for the hint");
  ok(Math.abs(r.byPlayer.get(1).weeks[4].implied - 28) < 1e-9,
     "byPlayer carries the implied total for the hint");
  ok(!r.byPlayer.has(5), "a player with no group is not recorded");
  ok(!r.byPlayer.has(6), "a player with no line is not recorded");

  const off = applyEnvironment(mk(), vegas, weather, [4, 5], { enabled: false });
  ok(off.adjusted === 0 && off.byPlayer.size === 0, "toggled off is exactly identity");

  const m2 = mk();
  const none = applyEnvironment(m2, new Map(), new Map(), [4, 5]);
  ok(none.adjusted === 0 && m2.players.get(1).proj[4] === 20 && m2.players.get(3).proj[4] === 8,
     "a dead Vegas feed leaves every projection exactly as it was");

  const m3 = mk();
  const noWx = applyEnvironment(m3, vegas, new Map(), [4, 5]);
  ok(m3.players.get(3).proj[4] === 8 && noWx.byPlayer.get(3).weather === 1,
     "a dead forecast still lets the lines through");
}

/* ---- 5. streaming planner ---- */
{
  const { slots, starters } = buildSlots(F.lineupSlotCounts);
  const base = {
    weeks: F.weeks,
    settings: {
      regularSeasonWeeks: F.weeks.filter((w) => w <= 14),
      playoffWeeks: [15, 16, 17],
      playoffRoundWeeks: [[15], [16], [17]],
      playoffTeams: 6,
      playoffReseed: true,
      lineupSlotCounts: F.lineupSlotCounts,
      currentWeek: 5,
    },
    players: new Map(F.pos.map((pos, i) => [i, {
      id: i, name: `p${i}`, pos, nfl: "X", eligibleSlots: F.eligibleSlots[pos],
      bye: F.weeks.find((w) => !(F.proj[i][F.weeks.indexOf(w)] > 0)) ?? 0,
      proj: Object.fromEntries(F.weeks.map((w, k) => [w, F.proj[i][k]])),
    }])),
    teams: new Map(F.teams.map((name, ti) =>
      [ti, { id: ti, name, roster: new Set(F.rosters[name]) }])),
  };

  // Two free-agent kickers with hand-made weeks. The fixture's best rostered kicker
  // is worth under 30 across any three weeks, so these two own the window: one is
  // steady, the other is better but blank in the middle of it.
  const FA_STEADY = 1000, FA_SPIKY = 1001;
  const mkFa = (id, byeWeek, pts) => [id, {
    id, name: `fa${id}`, pos: "K", nfl: "X", eligibleSlots: F.eligibleSlots.K, bye: byeWeek,
    proj: Object.fromEntries(F.weeks.map((w) => [w, w === byeWeek ? 0 : pts])),
  }];
  base.players.set(...mkFa(FA_STEADY, 0, 30));   // 30 every week: 90 across the window
  base.players.set(...mkFa(FA_SPIKY, 6, 60));    // 60 a week but blank in week 6: 120

  const eng2 = new Engine(base, { starters },
    new Map([...base.players].map(([id, p]) => [id, seatMask(p.eligibleSlots, slots)])));
  const iSteady = eng2.index.get(FA_STEADY), iSpiky = eng2.index.get(FA_SPIKY);

  const plan = streamPlan(eng2, base, F.teams[0], { weeks: 3 });
  ok(plan.weeks.join(",") === "5,6,7", `the window is the next three weeks (${plan.weeks})`);
  ok(plan.groups.some((g) => g.slot === 17), "the kicker slot is planned");
  ok(plan.groups.some((g) => g.slot === 16), "so is D/ST");
  ok(plan.groups.some((g) => g.slot === 1), "so is TQB, the slot this league actually starts");
  ok(plan.groups.some((g) => g.slot === 6), "so is TE");
  ok(!plan.groups.some((g) => g.slot === 0),
     "a streamable slot the league does not start is not planned");

  const k = plan.groups.find((g) => g.slot === 17);
  ok(k.label === "K" && k.count === 1, "the group names its slot and how many start");
  ok(k.rows[0].i === iSpiky, "the strongest candidate over the window leads");
  ok(Math.abs(k.rows[0].total - 120) < 1e-9, `the window total skips the bye (${k.rows[0].total})`);
  ok(k.rows[0].pts.length === 3, "one number per week in the window");
  ok(k.rows[0].owner === "FA", "a free agent says so");
  ok(k.rows.some((r) => r.owner === "me"), "so do the players already on the roster");
  ok(k.rows.every((r) => r.pos === "K"), "only kickers are candidates for the kicker slot");
  ok(k.rows.find((r) => r.i === iSpiky).bye === 6, "the bye week is reported");

  ok(k.hold.i === iSpiky && Math.abs(k.holdTotal - 120) < 1e-9,
     "the best hold is the best single window total");
  ok(k.rows.filter((r) => r.hold).length === 1 && k.rows[0].hold === true,
     "exactly one row is flagged as the hold");
  ok(Math.abs(k.seqTotal - 150) < 1e-9,
     `streaming beats holding across a bye (${k.seqTotal} vs ${k.holdTotal})`);
  ok(k.sequence.map((s) => s.i).join(",") === [iSpiky, iSteady, iSpiky].join(","),
     "the sequence swaps out for the bye week and back");
  ok(k.sequence.map((s) => s.w).join(",") === "5,6,7", "the sequence names its weeks");
  ok(k.sequence[0].name === `fa${FA_SPIKY}`, "the sequence names its players");
  ok(k.adds === 2, `two roster moves inside the window (${k.adds})`);

  // A slot where one player is best every week needs no moves at all.
  const dst = plan.groups.find((g) => g.slot === 16);
  ok(dst.seqTotal >= dst.holdTotal - 1e-9, "streaming is never worse than holding");
  ok(dst.adds >= 0 && dst.adds <= 2, "a three-week window allows at most two changes");

  const long = streamPlan(eng2, base, F.teams[0], { weeks: 99 });
  ok(long.weeks.length === F.weeks.filter((w) => w >= 5).length,
     "the window never runs past the end of the season");
  const over = streamPlan(eng2,
    { ...base, settings: { ...base.settings, currentWeek: 99 } }, F.teams[0], { weeks: 3 });
  ok(over.weeks.length === 0 && over.groups.length === 0, "no weeks left, no plan");

  const noSlots = streamPlan(eng2,
    { ...base, settings: { ...base.settings, lineupSlotCounts: { 2: 2, 4: 2 } } },
    F.teams[0], { weeks: 3 });
  ok(noSlots.groups.length === 0, "a league with no streamable slots gets no groups");

  // A slot that starts more than one - true 2QB, two defences. The planner still
  // runs (dropping the group would delete the planner from those leagues), and it
  // reports `count` so the UI can say the recommendation covers one of the seats.
  const two = streamPlan(eng2,
    { ...base, settings: { ...base.settings,
      lineupSlotCounts: { ...F.lineupSlotCounts, 17: 2, 16: 2 } } },
    F.teams[0], { weeks: 3 });
  const k2 = two.groups.find((g) => g.slot === 17);
  const d2 = two.groups.find((g) => g.slot === 16);
  ok(k2 !== undefined && d2 !== undefined,
     "a slot that starts two is still planned, not silently dropped");
  ok(k2.count === 2 && d2.count === 2, `the group reports how many start (${k2?.count})`);
  ok(k2.rows.length > 0 && k2.hold !== undefined && k2.sequence.length === 3,
     "the two-seat group still carries rows, a hold and a three-week sequence");
  ok(k2.hold.i === iSpiky && Math.abs(k2.holdTotal - 120) < 1e-9,
     "the hold names the best single seat, exactly as in the one-seat case");
  ok(two.groups.find((g) => g.slot === 1).count === 1,
     "a one-seat slot in the same league still reports one");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("ENVIRONMENT OK");
