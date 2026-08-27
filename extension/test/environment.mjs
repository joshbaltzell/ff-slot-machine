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

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("ENVIRONMENT OK");
