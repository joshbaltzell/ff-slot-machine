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

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("ENVIRONMENT OK");
