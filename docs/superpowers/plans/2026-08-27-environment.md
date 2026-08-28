# Phase 7 — Game Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adjust the current and next week's projections by what the betting market and the weather say about each game, and add a streaming planner that tells you which kicker, defence, quarterback or tight end to hold and which to churn over the next three weeks.

**Architecture:** Three new feed modules (`sources/stadiums.js`, `sources/vegas.js`, `sources/weather.js`) sit behind the existing `cached()` layer. `engine/environment.js` turns their output into a multiplicative factor per player-week and mutates `p.proj[w]` in `start()` immediately before the `Engine` is constructed — the same seam `calibrate.js` already uses, one step later. `engine/streaming.js` reads the resulting `Engine` and ranks slot candidates over a three-week window. `panel/environment.js` owns every line of UI so that `panel.js` gains one import, one `PHASES` entry, one `start()` block and three one-line call sites in `render()`.

**Tech Stack:** Plain ES modules, no build step, Chrome MV3 extension page. Tests are `node extension/test/run-all.mjs` (custom `ok()` assertions, no framework, no network).

**Spec:** `docs/superpowers/specs/2026-08-27-environment-design.md`
**Rules:** `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`

## Global Constraints

- **Do not modify `extension/engine/search.js`, `extension/engine/season.js` or `extension/engine/league.js`.** The wave-2 ownership table gives them to other phases. `league.js` may be *imported* (for `PRO_TEAM` and `SLOT_LABEL`) but never edited.
- **Do not modify `extension/test/parity.mjs`.** It is the engine contract and must stay green untouched. All new assertions go in `extension/test/environment.mjs`.
- **The model construction in `environment.mjs` is copied from `parity.mjs`, not imported.** `parity.mjs` exports nothing and must not start doing so.
- **`panel.js` edits are limited to** one import line, one `PHASES` entry, one block in `start()`, three one-line call sites in `render()` (roster column, roster cell, streaming section), one line inside the season-panel filter bar for the chips, one line beside `initTooltips(app)` for the chip binding, and one added key in the `KEEP` array. Keep every hunk to the smallest edit that works — other phases are editing the same file on other branches.
- **Every feature degrades.** A dead feed logs exactly one line through `say()` and the feature shows `—`. Nothing thrown from a feed may escape `start()`.
- **No host permissions.** `sports.core.api.espn.com` and `api.open-meteo.com` are CORS-open. Do not touch `manifest.json`.
- **Nothing about the league leaves the machine.** Both new feeds are requested by season/week and by latitude/longitude. No player, team or league identifier is ever put in a URL.
- **Environment factors are an input adjustment only.** They scale `p.proj[w]` before the `Engine` is built. Nothing downstream — the lineup solver, the search, the season sim — ever sees them.
- **Use the shared source layer.** Every fetch goes through `cached()` from `engine/sources/cache.js` with `{fetchImpl, storage, now}` injection so tests run offline.
- Commit messages: imperative subject, ending with the trailer block used in this repo:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
  ```

## File structure

| File | Responsibility | Status |
|---|---|---|
| `extension/engine/sources/stadiums.js` | The 32-row `STADIUMS` table (proTeamId → lat/lon/roof), `PRO_TEAM_ID` inversion, `stadiumOf`, `isOutdoor`. Pure data. | create |
| `extension/engine/sources/vegas.js` | ESPN core-API odds: `refId`, `impliedTotals`, `pickOdds`, `buildWeek`, `loadVegas`. | create |
| `extension/engine/sources/weather.js` | Open-Meteo: `atKickoff`, `loadWeather`. Reads `STADIUMS`. | create |
| `extension/engine/environment.js` | `ENV_K`, `envGroup`, `avgImplied`, `vegasFactor`, `weatherFactor`, `applyEnvironment`. Pure over the model. | create |
| `extension/engine/streaming.js` | `STREAM_SLOTS`, `streamPlan`. Reads an `Engine`, writes nothing. | create |
| `extension/panel/environment.js` | `environmentStep`, `envColumn`, `envCell`, `envChips`, `bindEnvChips`, `streamingSection`, `HINT_ENV`. Every line of Phase 7 UI. | create |
| `extension/panel.js` | Import, `PHASES` entry, `start()` block, three render call sites, chips, `KEEP` key. | modify |
| `extension/panel.css` | `.substl`, `.tagx`, `tr.hold`. | modify |
| `extension/test/environment.mjs` | All new assertions, `ok()` pattern, offline. | create |
| `CLAUDE.md` | Architecture map, one load-bearing decision, the C4 deferral. | modify |

**Test file convention.** `extension/test/environment.mjs` defines its own `ok(cond, what)`, `mkStorage()` and `mkFetch(table)` helpers copied from `sources.mjs`, and its own fixture-derived `model` copied from `parity.mjs`. Each task appends one numbered section before the final summary lines. The file's skeleton is created in Task 1 and every later task appends to it.

## Rulings made while writing this plan

These are decisions the spec left open. They are recorded here so an implementer does not have to re-derive them, and in the phase report so they can be reversed cheaply.

1. **Retractable roofs are treated as domes.** The feed never says whether the roof was shut, and teams with retractable roofs close them for bad weather far more often than not. Being wrong this way costs a missed penalty; being wrong the other way invents one.
2. **Weather applies to both teams in an outdoor game, not just the home team.** The spec says to *fetch* per home stadium, which is what makes it one request per game. A visiting quarterback throws into the same wind, so the fetched row is written under both `proTeamId`s.
3. **`TQB` joins the `pass` group.** ESPN's team-quarterback entity is a quarterback for every purpose the Vegas coefficient cares about, and the test fixture's league starts one. Without this the fixture league gets no QB adjustment at all.
4. **Sustained wind drives the thresholds, gusts are display only.** `wind_speed_10m` is the stable number; gusts are noisy and would trip the 25 mph rule on days that play normally.
5. **The two wind rules for kickers do not compound.** `>25` replaces `>15`; it does not multiply with it. Compounding would give 0.72 at 26 mph, which is past what the literature supports.
6. **`currentWeek` is used as an NFL week number.** `readSettings` returns ESPN's `currentMatchupPeriod`, which equals the NFL week in every single-week-matchup league. In a league whose current matchup spans two weeks the environment adjustment lands one week early; the cost is one week of slightly wrong input, and the alternative is deriving the mapping, which `CLAUDE.md` forbids.
7. **The streaming sequence is a per-week argmax.** With one add allowed per week and one seat to fill, the greedy optimum for a single slot *is* the best available player each week; no search is needed. The planner says so in a comment rather than pretending to solve something harder.
8. **`ffsm.environment` is added to `panel.js`'s `KEEP` array.** Without it the toggle resets on every "Refresh data", which is its own bug. This is a one-token edit to a line other wave-2 phases will also touch; the merge conflict is trivial and expected.

---

### Task 1: The stadium table

**Files:**
- Create: `extension/engine/sources/stadiums.js`
- Create: `extension/test/environment.mjs`

**Interfaces:**
- Consumes: `PRO_TEAM` from `extension/engine/league.js` (import only — never edit that file).
- Produces:
  - `STADIUMS: Object<number, {name: string, lat: number, lon: number, roof: "open"|"dome"|"retractable"}>` keyed by ESPN `proTeamId`.
  - `PRO_TEAM_ID: Object<string, number>` — team abbreviation → `proTeamId`, `FA` excluded.
  - `stadiumOf(proTeamId: number): stadium | null`
  - `isOutdoor(proTeamId: number): boolean`

- [ ] **Step 1: Create the test file skeleton and write the failing tests**

Create `extension/test/environment.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node extension/test/environment.mjs
```

Expected: it throws `Cannot find module .../engine/sources/stadiums.js`.

- [ ] **Step 3: Create `extension/engine/sources/stadiums.js`**

```js
/**
 * Where each NFL team plays, and whether the weather can reach the field.
 *
 * This lives beside the feeds rather than in `league.js` for two reasons: the
 * wave-2 file-ownership table gives `league.js` to another phase, and this is the
 * only consumer. `proTeamId` is ESPN's own team id and is the *same integer* in the
 * fantasy API (`player.proTeamId`) and in the core sports API (`.../teams/{id}`),
 * which is what lets one table key both the odds feed and the forecast.
 *
 * `roof`:
 *   open        - sky above the field; weather applies.
 *   dome        - fixed roof; weather never applies.
 *   retractable - a roof that may or may not be shut on the day. Treated exactly
 *                 like `dome`, because no feed we can reach says which, and teams
 *                 with retractable roofs close them for bad weather far more often
 *                 than not. That is wrong in the direction that does nothing, rather
 *                 than the direction that invents a wind penalty.
 *
 * Two edge cases worth naming: SoFi (LAR and LAC) has a fixed translucent roof with
 * open sides and is `dome`; Lumen (SEA) and Hard Rock (MIA) have canopies over the
 * seats only, with the field open to the sky, and are `open`.
 *
 * Coordinates are the playing surface, to four decimals (~11 m), which is far finer
 * than any weather model's grid. They only need to pick the right forecast cell.
 */
export const STADIUMS = {
  1:  { name: "Mercedes-Benz Stadium",   lat: 33.7554, lon: -84.4008, roof: "retractable" },
  2:  { name: "Highmark Stadium",        lat: 42.7738, lon: -78.7870, roof: "open" },
  3:  { name: "Soldier Field",           lat: 41.8623, lon: -87.6167, roof: "open" },
  4:  { name: "Paycor Stadium",          lat: 39.0955, lon: -84.5161, roof: "open" },
  5:  { name: "Huntington Bank Field",   lat: 41.5061, lon: -81.6995, roof: "open" },
  6:  { name: "AT&T Stadium",            lat: 32.7473, lon: -97.0945, roof: "retractable" },
  7:  { name: "Empower Field",           lat: 39.7439, lon: -105.0201, roof: "open" },
  8:  { name: "Ford Field",              lat: 42.3400, lon: -83.0456, roof: "dome" },
  9:  { name: "Lambeau Field",           lat: 44.5013, lon: -88.0622, roof: "open" },
  10: { name: "Nissan Stadium",          lat: 36.1665, lon: -86.7713, roof: "open" },
  11: { name: "Lucas Oil Stadium",       lat: 39.7601, lon: -86.1639, roof: "retractable" },
  12: { name: "Arrowhead Stadium",       lat: 39.0489, lon: -94.4839, roof: "open" },
  13: { name: "Allegiant Stadium",       lat: 36.0909, lon: -115.1833, roof: "dome" },
  14: { name: "SoFi Stadium",            lat: 33.9535, lon: -118.3392, roof: "dome" },
  15: { name: "Hard Rock Stadium",       lat: 25.9580, lon: -80.2389, roof: "open" },
  16: { name: "U.S. Bank Stadium",       lat: 44.9736, lon: -93.2575, roof: "dome" },
  17: { name: "Gillette Stadium",        lat: 42.0909, lon: -71.2643, roof: "open" },
  18: { name: "Caesars Superdome",       lat: 29.9511, lon: -90.0812, roof: "dome" },
  19: { name: "MetLife Stadium",         lat: 40.8135, lon: -74.0745, roof: "open" },
  20: { name: "MetLife Stadium",         lat: 40.8135, lon: -74.0745, roof: "open" },
  21: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, roof: "open" },
  22: { name: "State Farm Stadium",      lat: 33.5276, lon: -112.2626, roof: "retractable" },
  23: { name: "Acrisure Stadium",        lat: 40.4468, lon: -80.0158, roof: "open" },
  24: { name: "SoFi Stadium",            lat: 33.9535, lon: -118.3392, roof: "dome" },
  25: { name: "Levi's Stadium",          lat: 37.4033, lon: -121.9694, roof: "open" },
  26: { name: "Lumen Field",             lat: 47.5952, lon: -122.3316, roof: "open" },
  27: { name: "Raymond James Stadium",   lat: 27.9759, lon: -82.5033, roof: "open" },
  28: { name: "Northwest Stadium",       lat: 38.9077, lon: -76.8645, roof: "open" },
  29: { name: "Bank of America Stadium", lat: 35.2258, lon: -80.8528, roof: "open" },
  30: { name: "EverBank Stadium",        lat: 30.3239, lon: -81.6373, roof: "open" },
  33: { name: "M&T Bank Stadium",        lat: 39.2780, lon: -76.6227, roof: "open" },
  34: { name: "NRG Stadium",             lat: 29.6847, lon: -95.4107, roof: "retractable" },
};

/**
 * Abbreviation -> proTeamId, inverted from the one table that already has it.
 *
 * Player records carry `nfl` (the abbreviation) rather than `proTeamId`, and both
 * feeds key on the id, so something has to bridge them. Inverting is safer than a
 * second hand-written list: it cannot drift.
 */
export const PRO_TEAM_ID = Object.fromEntries(
  Object.entries(PRO_TEAM).filter(([id]) => Number(id) !== 0).map(([id, abbr]) => [abbr, Number(id)]));

export function stadiumOf(proTeamId) {
  return STADIUMS[proTeamId] ?? null;
}

/** True only when the sky is above the field. Retractable counts as covered. */
export function isOutdoor(proTeamId) {
  return STADIUMS[proTeamId]?.roof === "open";
}
```

Add the import at the top of the file, above `STADIUMS`:

```js
import { PRO_TEAM } from "../league.js";
```

- [ ] **Step 4: Run the tests**

```bash
node extension/test/environment.mjs
node extension/test/run-all.mjs
```

Expected: `0 failures`, `ENVIRONMENT OK`, and `run-all.mjs` reports `3 files, 0 failing`.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/sources/stadiums.js extension/test/environment.mjs
git commit -m "Add the stadium table: where each NFL team plays, and its roof

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 2: Vegas lines (`sources/vegas.js`)

**Files:**
- Create: `extension/engine/sources/vegas.js`
- Modify: `extension/test/environment.mjs` (append section 2)

**Interfaces:**
- Consumes: `cached()` from `./cache.js`.
- Produces:
  - `VEGAS_BASE: string` — `"https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"`.
  - `PREFERRED_PROVIDER: number` — `58` (ESPN BET).
  - `refId(ref: string): number | null`
  - `impliedTotals(overUnder: number, spread: number): {favorite: number, underdog: number} | null`
  - `pickOdds(items: object[]): object | null`
  - `buildWeek(events: object[]): Map<number, Game>` where
    `Game = {implied, opp, oppImplied, total, spread, home, kickoff}`
  - `loadVegas(season: number, weeks: number[], opts): Promise<Map<number, Map<number, Game>>>`

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/environment.mjs`, immediately before the line
``console.log(`\n${checks} assertions, ${failures} failures`);``:

```js
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
```

Add to the import block at the top of `environment.mjs`:

```js
import { VEGAS_BASE, refId, impliedTotals, pickOdds, buildWeek, loadVegas }
  from "../engine/sources/vegas.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node extension/test/environment.mjs
```

Expected: it throws `Cannot find module .../engine/sources/vegas.js`.

- [ ] **Step 3: Create `extension/engine/sources/vegas.js`**

```js
/**
 * Betting lines from ESPN's own core API: keyless, CORS-open, and already the same
 * team ids the fantasy API uses.
 *
 * Why the market at all: a projection is an average over a distribution of games,
 * and the closing line is the sharpest public estimate of the *specific* game a
 * player is about to play. A team implied for 28 points and a team implied for 16
 * do not deserve the same projection, however well-matched their season averages.
 *
 * Three requests per game, in a fixed shape:
 *   .../seasons/{yr}/types/2/weeks/{w}/events   -> { items: [{ $ref }] }
 *   {event $ref}                                -> competitions[0] with competitors
 *   {competition odds $ref}                     -> { items: [{ provider, overUnder,
 *                                                   spread, homeTeamOdds }] }
 * Everything is cached for three hours, so a page reload during a Sunday morning
 * costs nothing, and a line that moves at noon is picked up by the afternoon.
 *
 * Nothing about the league is sent: the URLs carry a season, a week and public
 * event ids.
 */
import { cached } from "./cache.js";

export const VEGAS_BASE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
const HOURS3 = 3 * 3600e3;
const CONCURRENCY = 4;

/** ESPN BET. Any priced book is usable; this one is the house default and is always there. */
export const PREFERRED_PROVIDER = 58;

/** The trailing integer of a core-API `$ref`, e.g. ".../teams/12?lang=en" -> 12. */
export function refId(ref) {
  const m = String(ref ?? "").match(/\/(\d+)(?:\?|$)/);
  return m ? Number(m[1]) : null;
}

/**
 * Split an over/under into two team totals using the spread.
 *
 * The favourite's share is half the total plus half the spread; the underdog's is
 * half the total minus half the spread. The sign of the spread is ignored here -
 * which side is the favourite is decided by the caller, from `homeTeamOdds`.
 */
export function impliedTotals(overUnder, spread) {
  const ou = Number(overUnder);
  if (!(ou > 0)) return null;
  const s = Math.abs(Number(spread) || 0);
  return { favorite: (ou + s) / 2, underdog: (ou - s) / 2 };
}

/** The odds row to trust: ESPN BET when present, else the first row that has a total. */
export function pickOdds(items) {
  const usable = (items ?? []).filter((it) => Number(it?.overUnder) > 0);
  if (!usable.length) return null;
  return usable.find((it) => Number(it?.provider?.id) === PREFERRED_PROVIDER) ?? usable[0];
}

/**
 * One week of events (each with an `odds` array attached) -> Map keyed by proTeamId.
 *
 * Pure, so the shape of ESPN's payload can be tested without a network. A game
 * without a usable line is left out entirely rather than defaulted: an absent row
 * means "no adjustment", and a zero would mean "this offence will not score".
 */
export function buildWeek(events) {
  const out = new Map();
  for (const ev of events ?? []) {
    const comp = ev?.competitions?.[0];
    if (!comp) continue;
    const home = (comp.competitors ?? []).find((c) => c.homeAway === "home");
    const away = (comp.competitors ?? []).find((c) => c.homeAway === "away");
    const homeId = refId(home?.team?.$ref) ?? (Number(home?.id) || null);
    const awayId = refId(away?.team?.$ref) ?? (Number(away?.id) || null);
    if (!homeId || !awayId) continue;

    const row = pickOdds(ev.odds);
    const split = row ? impliedTotals(row.overUnder, row.spread) : null;
    if (!split) continue;

    // Which side is favoured. The flags are authoritative when present; otherwise
    // ESPN quotes the spread from the home team's point of view, so a negative
    // number means the home team is laying points.
    const homeFav = row.homeTeamOdds?.favorite === true ? true
      : row.awayTeamOdds?.favorite === true ? false
      : Number(row.spread) <= 0;

    const homeImplied = homeFav ? split.favorite : split.underdog;
    const awayImplied = homeFav ? split.underdog : split.favorite;
    const total = Number(row.overUnder);
    const spread = Math.abs(Number(row.spread) || 0);
    const kickoff = comp.date ?? ev.date ?? null;

    out.set(homeId, { implied: homeImplied, opp: awayId, oppImplied: awayImplied,
                      total, spread, home: true, kickoff });
    out.set(awayId, { implied: awayImplied, opp: homeId, oppImplied: homeImplied,
                      total, spread, home: false, kickoff });
  }
  return out;
}

/** Events for one week, each with its odds rows attached. One dead game is skipped. */
async function fetchWeekEvents(season, week, opts) {
  const ttl = opts.ttlMs ?? HOURS3;
  const list = await cached(`src.vegas.list.${season}.${week}`,
    `${VEGAS_BASE}/seasons/${season}/types/2/weeks/${week}/events`, ttl, opts);
  const refs = (list.data?.items ?? []).map((it) => it.$ref).filter(Boolean);

  const events = [];
  for (let i = 0; i < refs.length; i += CONCURRENCY) {
    const batch = await Promise.all(refs.slice(i, i + CONCURRENCY).map(async (ref) => {
      const id = refId(ref);
      try {
        const ev = await cached(`src.vegas.ev.${id}`, ref, ttl, opts);
        const comp = ev.data?.competitions?.[0];
        if (!comp) return null;
        const oddsRef = comp.odds?.$ref
          ?? `${VEGAS_BASE}/events/${id}/competitions/${comp.id}/odds`;
        const odds = await cached(`src.vegas.odds.${id}`, oddsRef, ttl, opts);
        return { ...ev.data, odds: odds.data?.items ?? [] };
      } catch {
        return null;          // one unpriced or unreachable game is not a dead week
      }
    }));
    events.push(...batch);
  }
  return events.filter(Boolean);
}

/**
 * @param season ESPN season year
 * @param weeks  NFL weeks to price, normally [currentWeek, currentWeek + 1]
 * @param opts   { fetchImpl, storage, now, ttlMs } - injected so tests stay offline
 * @returns Map<week, Map<proTeamId, Game>>. A week that cannot be fetched is an
 *          empty map, never a rejection: no lines must read as no adjustment.
 */
export async function loadVegas(season, weeks, opts = {}) {
  const byWeek = new Map();
  for (const w of weeks) {
    try {
      byWeek.set(w, buildWeek(await fetchWeekEvents(season, w, opts)));
    } catch {
      byWeek.set(w, new Map());
    }
  }
  return byWeek;
}
```

- [ ] **Step 4: Run the tests**

```bash
node extension/test/environment.mjs
node extension/test/run-all.mjs
```

Expected: `0 failures` in both.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/sources/vegas.js extension/test/environment.mjs
git commit -m "Read Vegas totals and spreads from ESPN's core API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 3: Weather (`sources/weather.js`)

**Files:**
- Create: `extension/engine/sources/weather.js`
- Modify: `extension/test/environment.mjs` (append section 3)

**Interfaces:**
- Consumes: `cached()` from `./cache.js`; `STADIUMS` from `./stadiums.js`; the `Game` rows produced by `buildWeek` in Task 2 (`{home, opp, kickoff}` are the fields it reads).
- Produces:
  - `atKickoff(hourly: object, kickoffIso: string): {wind, gust, precipProb} | null`
  - `loadWeather(weekMap: Map<number, Game>, opts): Promise<Map<number, {wind, gust, precipProb, kickoff, stadium}>>`

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/environment.mjs` before the summary lines:

```js
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
}
```

Add to the import block:

```js
import { atKickoff, loadWeather } from "../engine/sources/weather.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node extension/test/environment.mjs
```

Expected: it throws `Cannot find module .../engine/sources/weather.js`.

- [ ] **Step 3: Create `extension/engine/sources/weather.js`**

```js
/**
 * Kickoff conditions from Open-Meteo: keyless, CORS-open, no attribution header.
 *
 * Only outdoor games are fetched, and only one request per stadium: the visitors
 * play in the same wind as the hosts, so the row is written under both team ids.
 * Domes and retractable roofs are skipped entirely - see `stadiums.js` for why a
 * retractable roof counts as covered.
 *
 * `forecast_days=7` is the shortest window that always reaches next Sunday from a
 * Monday, and `timezone=UTC` makes the hourly timestamps comparable to the ISO
 * kickoff string ESPN returns without any local-time reasoning.
 *
 * Nothing about the league is sent: the URL carries a latitude and a longitude.
 */
import { cached } from "./cache.js";
import { STADIUMS } from "./stadiums.js";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const HOURS3 = 3 * 3600e3;
const CONCURRENCY = 4;
/** Beyond this, the nearest hourly sample is not describing the same game. */
const MAX_OFFSET = 3 * 3600e3;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Open-Meteo omits the zone when `timezone=UTC`; treat a bare timestamp as UTC. */
const parseHour = (t) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(t) ? t : `${t}Z`);

/**
 * The hourly sample nearest kickoff, or null when the forecast does not reach it.
 * @param hourly     Open-Meteo's `hourly` object: parallel arrays keyed by `time`
 * @param kickoffIso ISO timestamp from the ESPN event
 */
export function atKickoff(hourly, kickoffIso) {
  const times = hourly?.time ?? [];
  const t = Date.parse(kickoffIso);
  if (!times.length || !Number.isFinite(t)) return null;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(parseHour(times[i]) - t);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0 || bestD > MAX_OFFSET) return null;
  return {
    wind: num(hourly.wind_speed_10m?.[best]),
    gust: num(hourly.wind_gusts_10m?.[best]),
    precipProb: num(hourly.precipitation_probability?.[best]),
  };
}

/**
 * @param weekMap one week from `loadVegas`: Map<proTeamId, {home, opp, kickoff}>
 * @param opts    { fetchImpl, storage, now, ttlMs } - injected so tests stay offline
 * @returns Map<proTeamId, {wind, gust, precipProb, kickoff, stadium}>. Both teams in
 *          an outdoor game share one row. A stadium that cannot be fetched is simply
 *          absent, which reads downstream as "no weather adjustment".
 */
export async function loadWeather(weekMap, opts = {}) {
  const ttl = opts.ttlMs ?? HOURS3;
  const jobs = [];
  for (const [teamId, g] of weekMap ?? new Map()) {
    if (!g?.home) continue;                       // one fetch per stadium, not per team
    const st = STADIUMS[teamId];
    if (!st || st.roof !== "open") continue;      // dome or retractable: no weather
    if (!g.kickoff) continue;                     // without a time there is no hour to read
    jobs.push({ teamId, opp: g.opp, st, kickoff: g.kickoff });
  }

  const out = new Map();
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (j) => {
      const url = `${OPEN_METEO}?latitude=${j.st.lat}&longitude=${j.st.lon}`
        + "&hourly=wind_speed_10m,wind_gusts_10m,precipitation_probability"
        + "&forecast_days=7&wind_speed_unit=mph&timezone=UTC";
      try {
        const r = await cached(`src.weather.${j.teamId}`, url, ttl, opts);
        const at = atKickoff(r.data?.hourly, j.kickoff);
        if (!at) return;
        const row = { ...at, kickoff: j.kickoff, stadium: j.st.name };
        out.set(j.teamId, row);
        if (j.opp) out.set(j.opp, row);           // the visitor throws into the same wind
      } catch {
        /* one unreachable stadium is a missing row, not a failed week */
      }
    }));
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

```bash
node extension/test/environment.mjs
node extension/test/run-all.mjs
```

Expected: `0 failures` in both.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/sources/weather.js extension/test/environment.mjs
git commit -m "Read kickoff wind and rain from Open-Meteo for open-roof games

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 4: The adjustment (`engine/environment.js`)

**Files:**
- Create: `extension/engine/environment.js`
- Modify: `extension/test/environment.mjs` (append section 4)

**Interfaces:**
- Consumes: `PRO_TEAM_ID` from `./sources/stadiums.js`; the `Game` shape from Task 2; the weather row shape from Task 3.
- Produces:
  - `ENV_K` — the whole constant table, in one export.
  - `envGroup(pos: string): "dst"|"k"|"pass"|"rb"|null`
  - `avgImplied(weekMap: Map<number, Game>): number`
  - `vegasFactor(group, game, avg): number`
  - `weatherFactor(group, wx): number`
  - `applyEnvironment(model, vegas, weather, weeks, opts): {adjusted: number, byPlayer: Map<playerId, Rec>}`
    where `Rec = {vegas, weather, factor, weeks: {[week]: {vegas, weather, factor, implied, oppImplied, total, wx}}}`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/environment.mjs` before the summary lines:

```js
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
  ok(vegasFactor("dst", { implied: 5, oppImplied: 0.1 }, 1) === ENV_K.clamp.hi,
     "an absurd edge clamps high");
  ok(vegasFactor("dst", { implied: 5, oppImplied: 100 }, 1) === ENV_K.clamp.lo,
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
```

Add to the import block:

```js
import { ENV_K, envGroup, avgImplied, vegasFactor, weatherFactor, applyEnvironment }
  from "../engine/environment.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node extension/test/environment.mjs
```

Expected: it throws `Cannot find module .../engine/environment.js`.

- [ ] **Step 3: Create `extension/engine/environment.js`**

```js
/**
 * The game a projection is for, not just the player it is about.
 *
 * A weekly projection is an average over the distribution of games a player might
 * play. The betting market prices the *specific* game: a team implied for 28 points
 * and a team implied for 16 do not deserve the same projection however similar their
 * season averages, and a kicker in a 30 mph crosswind is not the kicker his
 * projection describes.
 *
 * Applied as one multiplicative factor per player-week, to `p.proj[w]`, in place -
 * the same seam `calibrate.js` uses, one step later. Order matters and is
 * deliberate: shrinkage is about how far a projection should be from its positional
 * mean, this is about which game it is for, and the two compose.
 *
 * The coefficients are deliberately small. The market is far better at predicting a
 * *game* than a *player*: most of an implied-total edge is already inside a
 * projection ESPN built from the same information. These numbers move the projection
 * by the part that is not, and they clamp hard, because the failure mode that
 * matters is turning a plausible starter into an unstartable one on a bad line read.
 *
 * Scope: the current week and the next. A line does not exist past that, and a
 * season-long trade evaluation must not be tilted by two weeks of weather - which is
 * why the factors never touch any other week, and never enter lineup logic at all.
 */
import { PRO_TEAM_ID } from "./sources/stadiums.js";

/** Every constant in this file, in one table, so they can be read in one place. */
export const ENV_K = {
  /** No factor may ever leave this range, whatever the inputs say. */
  clamp: { lo: 0.6, hi: 1.4 },
  /** Sensitivity to the gap between a team's implied total and the week's average. */
  vegas: { dst: 0.6, k: 0.4, pass: 0.25, rb: 0.15 },
  /**
   * Sustained wind in mph -> multiplier, thresholds descending. The FIRST match
   * wins and the rest are skipped: a 30 mph wind is a 0.80, not a 0.80 x 0.90.
   */
  wind: { k: [[25, 0.80], [15, 0.90]], pass: [[20, 0.95]] },
  /** Precipitation probability in percent (inclusive) -> multiplier. */
  precip: { pass: [70, 0.95] },
};

/**
 * Position label -> factor group.
 *
 * `pos` is a display-only string everywhere else in this codebase and keying logic
 * on it is normally forbidden. It is acceptable HERE and only here: an environment
 * factor adjusts a projection *input*, it never decides which slot a player fills,
 * and the lineup solver still runs entirely on `eligibleSlots`. If this ever grows
 * into a lineup decision, move it onto slots first.
 *
 * TQB is ESPN's team-quarterback entity and belongs with the quarterbacks: it is
 * scored on the same plays, so the same implied-total sensitivity applies.
 */
export function envGroup(pos) {
  switch (pos) {
    case "D/ST": return "dst";
    case "K":    return "k";
    case "QB": case "TQB": case "WR": case "TE": return "pass";
    case "RB":   return "rb";
    default:     return null;    // punters, coaches, IDP: no factor, no guessing
  }
}

const clamp = (v) => Math.min(ENV_K.clamp.hi, Math.max(ENV_K.clamp.lo, v));

/** Mean implied team total over a week's priced games. 0 when nothing is priced. */
export function avgImplied(weekMap) {
  let s = 0, n = 0;
  for (const g of (weekMap ?? new Map()).values()) if (g?.implied > 0) { s += g.implied; n++; }
  return n ? s / n : 0;
}

/**
 * @param group one of ENV_K.vegas's keys, or null
 * @param game  a row from `loadVegas`
 * @param avg   `avgImplied` for the same week
 */
export function vegasFactor(group, game, avg) {
  const k = ENV_K.vegas[group];
  if (!k || !game || !(avg > 0)) return 1;
  // A defence's edge is its opponent's total, inverted: the fewer points the other
  // side is expected to score, the better the defence's week.
  const edge = group === "dst"
    ? (avg - game.oppImplied) / avg
    : (game.implied - avg) / avg;
  return clamp(1 + k * edge);
}

/** @param wx a row from `loadWeather`, or null when the roof is shut or the feed is dead. */
export function weatherFactor(group, wx) {
  if (!wx) return 1;
  let f = 1;
  for (const [mph, mult] of ENV_K.wind[group] ?? []) {
    if (wx.wind > mph) { f *= mult; break; }     // descending; the first match is the answer
  }
  const p = ENV_K.precip[group];
  if (p && wx.precipProb >= p[0]) f *= p[1];
  return clamp(f);
}

/**
 * Scale `p.proj[w]` by the week's environment factor, in place.
 *
 * Only the weeks passed in are touched, and only where a line exists. A week with no
 * priced games leaves every projection exactly as it was, which is what makes a dead
 * feed a no-op rather than a distortion.
 *
 * @param model   {players: Map} from `loadLeague`
 * @param vegas   Map<week, Map<proTeamId, Game>> from `loadVegas`
 * @param weather Map<proTeamId, wx> from `loadWeather`, for ONE week
 * @param weeks   the weeks to adjust, normally [currentWeek, currentWeek + 1]
 * @param opts    { enabled = true, weatherWeek = weeks[0] }
 * @returns {{adjusted: number, byPlayer: Map}} - `byPlayer` is what the UI shows.
 */
export function applyEnvironment(model, vegas, weather, weeks, opts = {}) {
  const byPlayer = new Map();
  if (opts.enabled === false) return { adjusted: 0, byPlayer };

  const weatherWeek = opts.weatherWeek ?? weeks[0];
  const avg = new Map(weeks.map((w) => [w, avgImplied(vegas?.get(w))]));
  let adjusted = 0;

  for (const p of model.players.values()) {
    const group = envGroup(p.pos);
    if (!group) continue;
    const teamId = PRO_TEAM_ID[p.nfl];
    if (!teamId) continue;

    for (const w of weeks) {
      const game = vegas?.get(w)?.get(teamId);
      if (!game) continue;                       // bye, or this week is not priced
      const wx = w === weatherWeek ? (weather?.get(teamId) ?? null) : null;
      const v = vegasFactor(group, game, avg.get(w));
      const x = weatherFactor(group, wx);
      const f = clamp(v * x);

      if (p.proj[w] > 0 && f !== 1) {
        p.proj[w] = Math.round(p.proj[w] * f * 100) / 100;
        adjusted++;
      }
      const rec = byPlayer.get(p.id) ?? { vegas: 1, weather: 1, factor: 1, weeks: {} };
      rec.weeks[w] = { vegas: v, weather: x, factor: f, implied: game.implied,
                       oppImplied: game.oppImplied, total: game.total, wx };
      if (w === weeks[0]) { rec.vegas = v; rec.weather = x; rec.factor = f; }
      byPlayer.set(p.id, rec);
    }
  }
  return { adjusted, byPlayer };
}
```

- [ ] **Step 4: Run the tests**

```bash
node extension/test/environment.mjs
node extension/test/run-all.mjs
```

Expected: `0 failures` in both. `parity.mjs` must still print its own unchanged count.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/environment.js extension/test/environment.mjs
git commit -m "Turn lines and weather into a per-player-week projection factor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 5: The streaming planner (`engine/streaming.js`)

**Files:**
- Create: `extension/engine/streaming.js`
- Modify: `extension/test/environment.mjs` (append section 5)

**Interfaces:**
- Consumes: an `Engine` (`eng.weeks`, `eng.NW`, `eng.proj`, `eng.bye`, `eng.ids`, `eng.index`, `eng.roster`, `eng.freeAgents`), the `model` it was built from (`model.players`, `model.settings.lineupSlotCounts`, `model.settings.currentWeek`), and `SLOT_LABEL` from `../engine/league.js`.
- Produces:
  - `STREAM_SLOTS: number[]` — `[0, 1, 6, 16, 17]` (QB, TQB, TE, D/ST, K).
  - `streamPlan(eng, model, team, opts): Plan` where
    ```
    Plan  = { weeks: number[], groups: Group[] }
    Group = { slot, label, count, rows: Row[], hold: Row|null, holdTotal,
              sequence: {w, i, name, pts}[], seqTotal, adds }
    Row   = { i, id, name, pos, nfl, owner: "me"|"FA", bye, pts: number[],
              total, hold: boolean }
    ```

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/environment.mjs` before the summary lines:

```js
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
}
```

Add to the import block:

```js
import { buildSlots, seatMask } from "../engine/lineup.js";
import { Engine } from "../engine/search.js";
import { streamPlan } from "../engine/streaming.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node extension/test/environment.mjs
```

Expected: it throws `Cannot find module .../engine/streaming.js`.

- [ ] **Step 3: Create `extension/engine/streaming.js`**

```js
/**
 * Which kicker, defence, quarterback or tight end to hold, and which to churn.
 *
 * These are the slots where the waiver wire is genuinely competitive with what you
 * roster: the gap between the best available kicker in a given week and the twelfth
 * is a matchup, not a talent, and the same is largely true of team defences. So the
 * question is not "who is better" but "who is better *this week*, and is that worth
 * a roster move".
 *
 * Candidates are chosen by SLOT, never by position: a player is a candidate for slot
 * S when his `eligibleSlots` contains S. That is the same rule the lineup solver
 * uses, so a league with TQB, or with no kicker at all, gets the right answer with
 * no special case. `pos` appears only in the output, for display.
 *
 * Values come straight out of the engine's `proj`, so if the environment adjustment
 * ran, this planner is already reading environment-adjusted numbers - which is the
 * whole point of the pairing: streaming decisions are exactly the short-horizon,
 * matchup-driven calls a Vegas total should move.
 *
 * The sequence is a per-week argmax and that is not a shortcut. With one seat to
 * fill and one add allowed per week, the best reachable plan IS the best available
 * player in each week: there is no future cost to taking this week's best, because
 * next week's add is still available. A DP here would return the same answer more
 * slowly. If the rules ever change - a weekly add limit shared across slots, an FAAB
 * budget - this becomes a real optimisation and the comment stops being true.
 */
import { SLOT_LABEL } from "./league.js";

/** Slots worth planning, in the order they are shown. QB, TQB, TE, D/ST, K. */
export const STREAM_SLOTS = [0, 1, 6, 16, 17];

/**
 * @param eng   an Engine, built from `model`
 * @param model the same model (for `eligibleSlots`, `pos` and `lineupSlotCounts`)
 * @param team  team name, as in `eng.roster`
 * @param opts  { weeks = 3, limit = 12 }
 * @returns {{weeks: number[], groups: object[]}}
 */
export function streamPlan(eng, model, team, { weeks = 3, limit = 12 } = {}) {
  const from = model.settings?.currentWeek ?? eng.weeks[0];
  const window = eng.weeks.filter((w) => w >= from).slice(0, weeks);
  if (!window.length) return { weeks: [], groups: [] };
  const wIdx = window.map((w) => eng.weeks.indexOf(w));

  const counts = model.settings?.lineupSlotCounts ?? {};
  const mine = new Set(eng.roster.get(team) ?? []);
  const pool = [...mine, ...eng.freeAgents];

  const groups = [];
  for (const slot of STREAM_SLOTS) {
    const count = Number(counts[slot] ?? counts[String(slot)] ?? 0);
    if (!(count > 0)) continue;

    const rows = [];
    for (const i of pool) {
      const p = model.players.get(eng.ids[i]);
      if (!p || !(p.eligibleSlots ?? []).includes(slot)) continue;
      const pts = wIdx.map((k) => eng.proj[i * eng.NW + k]);
      rows.push({
        i, id: p.id, name: p.name, pos: p.pos, nfl: p.nfl,
        owner: mine.has(i) ? "me" : "FA",
        bye: eng.bye[i] || 0,
        pts,
        total: pts.reduce((a, b) => a + b, 0),
        hold: false,
      });
    }
    if (!rows.length) continue;
    rows.sort((a, b) => b.total - a.total);

    // Best single hold: whoever is worth the most across the whole window.
    const hold = rows[0];
    hold.hold = true;
    const holdTotal = hold.total;

    // Best sequence: the best available player each week. See the header for why
    // greedy is optimal under "one add per week, one seat".
    const sequence = window.map((w, k) => {
      let best = rows[0];
      for (const r of rows) if (r.pts[k] > best.pts[k]) best = r;
      return { w, i: best.i, name: best.name, pts: best.pts[k] };
    });
    const seqTotal = sequence.reduce((a, s) => a + s.pts, 0);
    let adds = 0;
    for (let k = 1; k < sequence.length; k++) if (sequence[k].i !== sequence[k - 1].i) adds++;

    groups.push({
      slot, label: SLOT_LABEL[slot] ?? String(slot), count,
      rows: rows.slice(0, limit),
      hold, holdTotal, sequence, seqTotal, adds,
    });
  }
  return { weeks: window, groups };
}
```

- [ ] **Step 4: Run the tests**

```bash
node extension/test/environment.mjs
node extension/test/run-all.mjs
```

Expected: `0 failures` in both.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/streaming.js extension/test/environment.mjs
git commit -m "Plan three weeks of streaming at the slots worth churning

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 6: The panel

**Files:**
- Create: `extension/panel/environment.js`
- Modify: `extension/panel.js` (import block; `PHASES`; `start()`; `render()` — roster column, roster cell, chips, streaming section, chip binding; `KEEP`)
- Modify: `extension/panel.css` (append)

**Interfaces:**
- Consumes: `loadVegas` (Task 2), `loadWeather` (Task 3), `applyEnvironment` / `avgImplied` (Task 4), `streamPlan` (Task 5). From `panel.js` at the call sites: `grid(id, cols, rows, opts)` and `esc(v)` are passed in as arguments because `panel.js` exports nothing and must not start to.
- Produces (all from `extension/panel/environment.js`):
  - `environmentStep(model, seasonId, say): Promise<Env>` where
    `Env = {on, weeks, byPlayer: Map, vegas: Map, weather: Map, games: number, note: string, state: "done"|"warn"|"skip"}`
  - `envColumn(env): object` — a `grid()` column descriptor
  - `envCell(env, player): string` — one `<td>`
  - `envChips(env): string` — one `<div class="fld">`
  - `bindEnvChips(root): void`
  - `streamingSection({eng, model, team, env, grid, esc}): string` — one `<section>`, or `""`

- [ ] **Step 1: Create `extension/panel/environment.js`**

```js
/**
 * Every line of Phase 7's UI, kept out of panel.js so the merge stays mechanical.
 *
 * `panel.js` gets one import, one PHASES entry, one block in start() and three
 * one-line call sites in render(). `grid` and `esc` are handed in at the call site
 * rather than imported: panel.js exports nothing and has a top-level init, so
 * importing from it would run the page twice.
 */
import { loadVegas } from "../engine/sources/vegas.js";
import { loadWeather } from "../engine/sources/weather.js";
import { applyEnvironment, avgImplied } from "../engine/environment.js";
import { streamPlan } from "../engine/streaming.js";

const esc0 = (v) => String(v).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const HINT_ENV = {
  env: "What the betting market and the forecast say about this week's game, as a "
     + "multiplier on the projection. Implied team totals come from the spread and "
     + "the over/under; wind and rain apply only to open-roof stadiums. Only this "
     + "week and next are moved - no line exists past that.",
  chip: "On, each projection for this week and next is scaled by its game's implied "
      + "team total and, outdoors, by the wind and rain at kickoff. Defences are "
      + "priced off the opponent's total. Off leaves projections exactly as they "
      + "arrived. Nothing here touches any other week or any lineup decision.",
  window: "Projected points across the whole planning window. A player on bye "
        + "inside the window is scored zero for that week, which is the honest "
        + "comparison against someone who plays all three.",
  owner: "Whether this player is already on your roster or sitting in the free-agent "
       + "pool.",
};

/* ============ loading ============ */

/**
 * Load the lines and the forecast and apply them, or degrade to identity.
 *
 * Nothing thrown in here escapes: the trade search is the product, and a dead odds
 * feed must cost a log line, not the run.
 */
export async function environmentStep(model, seasonId, say) {
  const env = { on: true, weeks: [], byPlayer: new Map(), vegas: new Map(),
                weather: new Map(), games: 0, note: "", state: "skip" };
  try {
    env.on = (await chrome.storage.local.get("ffsm.environment"))["ffsm.environment"] ?? true;
  } catch { /* storage unavailable; default on */ }

  const w0 = model.settings.currentWeek ?? model.weeks[0];
  env.weeks = [w0, w0 + 1].filter((w) => model.weeks.includes(w));

  if (!env.on) {
    say("game environment off - projections used as they arrived", "");
    env.note = "off";
    return env;
  }
  if (!env.weeks.length) {
    say("no weeks left to adjust - game environment skipped", "");
    env.note = "no weeks";
    return env;
  }

  try {
    env.vegas = await loadVegas(seasonId, env.weeks);
    const now = env.vegas.get(env.weeks[0]) ?? new Map();
    env.games = now.size / 2;
    if (!env.games) throw new Error("no games priced");
    const avg = avgImplied(now);
    say(`Vegas: ${env.games} games priced for week ${env.weeks[0]} `
      + `(avg total ${(avg * 2).toFixed(1)})`, "ok");
  } catch (e) {
    say(`Vegas lines unavailable (${e.message ?? e}) - projections unchanged`, "err");
    env.note = "no lines";
    env.state = "warn";
    return env;
  }

  try {
    env.weather = await loadWeather(env.vegas.get(env.weeks[0]) ?? new Map());
    const stadiums = [...new Set(env.weather.values())];
    const worst = stadiums.reduce((m, r) => Math.max(m, r.wind ?? 0), 0);
    say(`weather: ${stadiums.length} open-roof games, worst wind ${worst.toFixed(0)} mph`, "ok");
  } catch (e) {
    say(`weather unavailable (${e.message ?? e}) - wind and rain ignored`, "err");
  }

  const r = applyEnvironment(model, env.vegas, env.weather, env.weeks);
  env.byPlayer = r.byPlayer;
  env.note = `${env.games} games`;
  env.state = "done";
  say(`environment applied to ${r.adjusted} player-weeks `
    + `across weeks ${env.weeks.join(" and ")}`, "ok");
  return env;
}

/* ============ roster grid ============ */

export function envColumn(env) {
  return {
    key: "env", label: "Env", num: true, hint: HINT_ENV.env,
    value: (r) => env?.byPlayer?.get(r.p.id)?.factor ?? 1,
  };
}

export function envCell(env, player) {
  const rec = env?.byPlayer?.get(player.id);
  if (!rec) return '<td class="num" style="color:var(--faint)">—</td>';
  const f = rec.factor ?? 1;
  const wk = rec.weeks?.[env.weeks[0]];
  const bits = [];
  if (wk) {
    bits.push(`week ${env.weeks[0]}: implied ${wk.implied.toFixed(1)} `
      + `of a ${wk.total.toFixed(1)} game, opponent ${wk.oppImplied.toFixed(1)}`);
    bits.push(wk.wx
      ? `${Math.round(wk.wx.wind)} mph wind (gusts ${Math.round(wk.wx.gust)}), `
        + `${Math.round(wk.wx.precipProb)}% chance of rain`
      : "no weather applied - roof, or no forecast for kickoff");
  }
  const c = f > 1.005 ? "up" : f < 0.995 ? "down" : "zero";
  return `<td class="num ${c}" data-hint="${esc0(bits.join(" · "))}">×${f.toFixed(2)}</td>`;
}

/* ============ chips ============ */

export function envChips(env) {
  const on = env?.on !== false;
  return `<div class="fld">
    <label data-hint="${esc0(HINT_ENV.chip)}"><span class="hint">Environment</span></label>
    <div class="chips" id="envtog">
      <button data-v="1" aria-pressed="${on}">Vegas + weather</button>
      <button data-v="0" aria-pressed="${!on}">Off</button>
    </div></div>`;
}

export function bindEnvChips(root) {
  root.querySelectorAll("#envtog button").forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.v === "1";
      if (on === (window.__env?.on !== false)) return;
      await chrome.storage.local.set({ "ffsm.environment": on });
      location.reload();     // projections feed everything; a rebuild is the honest path
    };
  });
}

/* ============ streaming section ============ */

export function streamingSection({ eng, model, team, env, grid, esc }) {
  let plan;
  try {
    plan = streamPlan(eng, model, team, { weeks: 3 });
  } catch {
    return "";                 // the planner is a bonus; it must never cost the page
  }
  if (!plan.groups.length) return "";
  const wk = plan.weeks;

  const body = plan.groups.map((g) => {
    const table = grid(`stream${g.slot}`, [
      { key: "name", label: "Player", value: (r) => r.name },
      { key: "owner", label: "Owner", value: (r) => r.owner, hint: HINT_ENV.owner },
      { key: "nfl", label: "NFL", value: (r) => r.nfl },
      { key: "bye", label: "Bye", num: true, value: (r) => r.bye || 99 },
      ...wk.map((w, k) => ({ key: `w${w}`, label: `Wk ${w}`, num: true, value: (r) => r.pts[k] })),
      { key: "total", label: "Window", num: true, value: (r) => r.total, hint: HINT_ENV.window },
    ], g.rows, {
      sort: "total", dir: -1,
      row: (r) => `<tr class="${r.hold ? "hold" : ""}">
        <td style="font-weight:600">${esc(r.name)}${
          r.hold ? ' <span class="tagx">hold</span>' : ""}</td>
        <td>${r.owner === "me" ? "yours" : "free agent"}</td>
        <td class="nfl">${esc(r.nfl)}</td>
        <td class="num" style="color:var(--faint)">${r.bye || "—"}</td>
        ${r.pts.map((v, k) => `<td class="num${wk[k] === r.bye ? " zero" : ""}">${
          wk[k] === r.bye ? "bye" : v.toFixed(1)}</td>`).join("")}
        <td class="num" style="font-weight:600">${r.total.toFixed(1)}</td>
      </tr>`,
      empty: '<div class="empty"><b>Nobody eligible</b>No rostered player or free agent '
           + 'can fill this slot.</div>',
    });

    const seq = g.sequence.map((s) => `wk ${s.w} ${esc(s.name)}`).join(" → ");
    const edge = g.seqTotal - g.holdTotal;
    return `<h3 class="substl">${esc(g.label)}</h3>
      <div class="panel">${table}
        <div class="note"><b>Hold</b> ${esc(g.hold?.name ?? "—")} for
          ${g.holdTotal.toFixed(1)} points across the window.
          <b>Stream</b> ${seq} for ${g.seqTotal.toFixed(1)} — ${edge > 0.05
            ? `${edge.toFixed(1)} more, at the cost of ${g.adds} roster move${
                g.adds === 1 ? "" : "s"}`
            : "no better than holding, so hold"}.</div>
      </div>`;
  }).join("");

  const envNote = env?.on !== false && env?.byPlayer?.size
    ? " Weeks with a betting line are already adjusted for the game environment."
    : "";
  return `<section>
    <h2 class="secttl">Streaming planner</h2>
    <p class="sectsub">Weeks ${wk[0]}–${wk.at(-1)} at the slots where the wire is
      genuinely competitive with your bench. Candidates are everyone eligible for the
      slot — yours and free agents — ranked by what they are worth across the whole
      window rather than in one week.${envNote}</p>
    ${body}
  </section>`;
}
```

- [ ] **Step 2: Wire `panel.js` — import and `PHASES`**

Add one import, immediately after the `calibrate.js` import line:

```js
import { environmentStep, envColumn, envCell, envChips, bindEnvChips, streamingSection }
  from "./panel/environment.js";
```

In `PHASES`, insert one entry immediately after the `["agents", "Free-agent pool"]` line:

```js
  ["env",      "Game environment"],
```

- [ ] **Step 3: Wire `panel.js` — the `start()` block**

In `start()`, insert immediately before the line `say("building engine…");` — that is, after the calibration `if/else` block:

```js
    // Game environment. After shrinkage on purpose: shrinkage is about how far a
    // projection sits from its positional mean, this is about which game it is for,
    // and the two compose. Before the Engine, because the Engine snapshots proj.
    Steps.set("env", "run");
    window.__env = await environmentStep(model, ref.seasonId, say);
    Steps.set("env", window.__env.state, window.__env.note);

```

- [ ] **Step 4: Wire `panel.js` — the roster column and cell**

In `render()`, in the `rosterGrid` column list, insert one line immediately before
`{ key: "bar", label: "", sortable: false },`:

```js
    envColumn(window.__env),
```

In the same grid's `row:` template, insert one line immediately before the
`<td><div class="meter">…` line:

```js
      ${envCell(window.__env, r.p)}
```

- [ ] **Step 5: Wire `panel.js` — the chips**

In the season section's filter bar, immediately after the closing `</div>` of the
`#calib` field (the line reading `            </div></div>`), insert:

```js
          ${envChips(window.__env)}
```

And beside the existing bindings, immediately after `initTooltips(app);`, insert:

```js
  bindEnvChips(app);
```

- [ ] **Step 6: Wire `panel.js` — the streaming section and `KEEP`**

Immediately after the closing `</section>` of the "Your least-used players" section
and before the `<section>` that opens "Free agents worth adding", insert:

```js
    ${streamingSection({ eng, model, team: mineOnly ? viewing : myTeam,
                         env: window.__env, grid, esc })}
```

In the `#refresh` handler, add the toggle's key to `KEEP`:

```js
    const KEEP = ["ffsm.myTeam", "ffsm.objective", "ffsm.calibrate", "ffsm.divSeed",
                  "ffsm.environment"];
```

- [ ] **Step 7: Styles**

Append to `extension/panel.css`:

```css
/* streaming planner */
.substl{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--faint);margin:22px 0 8px}
.substl:first-of-type{margin-top:4px}
tr.hold td{background:var(--accent-soft)}
.tagx{display:inline-block;font-family:var(--mono);font-size:9px;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;color:var(--accent);
  border:1px solid var(--accent-line);border-radius:2px;padding:1px 4px;
  margin-left:6px;vertical-align:1px}
```

- [ ] **Step 8: Check the syntax and run the tests**

```bash
node --check extension/panel.js
node --check extension/panel/environment.js
node --check extension/engine/environment.js
node --check extension/engine/streaming.js
node extension/test/run-all.mjs
```

Expected: no output from `--check`, `0 failing` from `run-all.mjs`.

- [ ] **Step 9: Browser verification (pending — record it, do not claim it)**

Chrome is not available to this worker. Record this checklist verbatim in the task
report under the heading **browser verification pending**; do not mark any of it done.

1. Reload the unpacked extension and open a live league. The checklist shows
   **Game environment** between "Free-agent pool" and "Schedule", and it completes.
2. The log shows `Vegas: N games priced for week W (avg total T)` with a plausible T
   (NFL game totals are 35–55), then `weather: K open-roof games, worst wind X mph`,
   then `environment applied to N player-weeks across weeks W and W+1`.
3. The roster table has an **Env** column showing values like `×1.06`; hovering one
   names the implied total and either the wind or "no weather applied".
4. A player whose team is on bye this week shows `—` in Env.
5. The **Streaming planner** section appears below "Your least-used players" with one
   sub-table per streamable slot the league starts. One row per table carries the
   `hold` tag; the note under each table reads as a sentence.
6. The season panel's filter bar shows **Environment / Vegas + weather / Off** beside
   **Projections**. Clicking **Off** reloads and the log then reads
   `game environment off - projections used as they arrived`; the Env column shows
   `—` throughout and the toggle still reads Off after **Refresh data**.
7. Disconnect the network after the league loads (DevTools → Network → Offline) and
   reload: the log shows one `Vegas lines unavailable (…)` line, the step shows a
   warning, the Env column is all `—`, and the trade tables are otherwise unchanged.

- [ ] **Step 10: Commit**

```bash
git add extension/panel/environment.js extension/panel.js extension/panel.css
git commit -m "Show the game environment and a three-week streaming plan

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the assertion count printed by `node extension/test/environment.mjs`.
- Produces: nothing code depends on.

- [ ] **Step 1: Update the architecture map**

In the `Architecture` code block, add after the `calibrate.js` line:

```
    environment.js   Vegas + weather -> a factor on this week's and next week's proj
    streaming.js     three-week hold-or-churn plan for K, D/ST, QB and TE slots
```

Change the `sources/` line to name the new feeds:

```
    sources/         one module per external feed (cache, sleeper, vegas, weather, stadiums)
```

Add after the `test/parity.mjs` line, with the real number from the test run:

```
  panel/environment.js  the environment column, chips and streaming section
  test/environment.mjs  N assertions for lines, weather, factors and streaming
```

- [ ] **Step 2: Add the load-bearing decision**

Add after the "Projections are calibrated before the engine sees them." paragraph:

```
**Game environment is an input adjustment, and only ever to this week and next.**
`environment.js` scales `p.proj[w]` by an implied-total and weather factor for
`currentWeek` and `currentWeek + 1`, in `start()`, after shrinkage and before the
`Engine` is constructed. It composes with shrinkage on purpose: shrinkage is about
how far a projection sits from its positional mean, this is about which game it is
for. Three rules keep it safe. It never enters lineup logic — the solver still runs
entirely on `eligibleSlots`, and the position strings `envGroup` reads are the one
sanctioned exception in the codebase, because they choose a coefficient and nothing
else. It never touches a week without a line, so a dead feed is identity rather than
a distortion. And it never reaches past next week, because a season-long trade
evaluation must not be tilted by two weeks of weather. Factors clamp to
[0.6, 1.4]; retractable roofs count as covered, since no feed says whether the roof
was shut and closing it is the common case.
```

- [ ] **Step 3: Record the deferral**

Add at the end of the "Load-bearing decisions" section:

```
**Defence-versus-position is deferred, deliberately.** Ranking playoff-week matchups
by how each defence performs against a position needs nflverse release assets, which
are not CORS-open and would need either a host permission for a redirecting CDN or a
copy of the data in the repo. The measured effect is also small next to the implied
total, which the environment factor already carries. Revisit only with a CORS-open
source.
```

- [ ] **Step 4: Verify the counts are real**

```bash
node extension/test/run-all.mjs 2>&1 | grep -E "assertions|OK|failing"
```

Replace `N` in the architecture map with the number `environment.mjs` actually
printed, and confirm the `parity.mjs` count in `CLAUDE.md` still matches what that
file prints. Do not adjust `parity.mjs`'s number by hand — if it moved, the engine
changed and that is a bug in this branch.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "Record where the game environment sits in the pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| `sources/vegas.js` (not `odds.js`), ESPN core API, provider 58 preference, implied totals, team keys from `team.$ref`, concurrency ≤ 4, 3 h cache, `loadVegas` signature | 2 |
| `sources/weather.js`, Open-Meteo URL and parameters, current-week home team only, open roofs only, kickoff from the ESPN event `date`, `{wind, gust, precipProb}`, 3 h cache | 3 |
| `sources/stadiums.js`, 32 rows, proTeamId → lat/lon/roof | 1 |
| `environment.js`, `ENV_K` as one exported table, the four factor rows, clamp [0.6, 1.4], `avgImplied` over the week, `applyEnvironment` signature, position groups from `pos` with the comment saying why that is allowed | 4 |
| Toggle `ffsm.environment`, default on, applied after aggregation and shrinkage | 4 (`opts.enabled`), 6 (storage, chips, `start()` placement) |
| `streaming.js`, `streamPlan(eng, model, team, {weeks: 3})`, slot groups present in `lineupSlotCounts`, rostered + free-agent candidates, window sums, bye marks, best hold, greedy sequence, row shape | 5 |
| `panel/environment.js`: chips beside Projections, the three log lines and their degrade forms, roster **Env** column with hint, **Streaming planner** section with one grid per streamable slot | 6 |
| Tests: implied totals both ways, provider preference, each factor group, clamp, `avgImplied`, untouched weeks, toggle-off identity, weather thresholds, dome, window sums, bye marked, sequence beats hold across a bye, injected fetches, dead feed → identity and a flag | 1–5 |
| C4 deferral recorded | 7 |

**Placeholder scan.** Every code step carries the code. The one intentional
"pending" is the browser checklist in Task 6 Step 9, which is unavoidable — Chrome is
not reachable from this worktree — and it is written as an explicit unchecked
checklist to be carried into the report rather than a vague "verify it works".

**Type consistency.**
- `Game = {implied, opp, oppImplied, total, spread, home, kickoff}` is produced by
  `buildWeek` (Task 2) and read by `loadWeather` (`home`, `opp`, `kickoff` — Task 3),
  `avgImplied` / `vegasFactor` (`implied`, `oppImplied` — Task 4) and `envCell`
  (`implied`, `oppImplied`, `total` — Task 6).
- The weather row `{wind, gust, precipProb, kickoff, stadium}` is produced in Task 3
  and read by `weatherFactor` (`wind`, `precipProb` — Task 4) and `envCell` (`wind`,
  `gust`, `precipProb` — Task 6).
- `applyEnvironment`'s `byPlayer` record `{vegas, weather, factor, weeks}` is written
  in Task 4 and read by `envColumn` / `envCell` in Task 6.
- `Env` (`{on, weeks, byPlayer, vegas, weather, games, note, state}`) is produced by
  `environmentStep` and consumed by `envColumn`, `envCell`, `envChips`,
  `streamingSection` and the `Steps.set("env", …)` call — `state` is exactly one of
  `"done" | "warn" | "skip"`, which are the states `Steps.set` already understands.
- `Group.hold` is a `Row`, so `g.hold.name` and `k.hold.i` agree between Tasks 5 and 6.
- `window.__env` is assigned in `start()` before `render()` runs, matching how
  `window.__calibrate` and `window.__divSeed` are already handled.

**Known gap, deliberate.** The panel has no automated tests; the repo has none for
the UI and adding a DOM harness is out of scope for this phase. Task 6 carries a
browser checklist instead, and `node --check` catches the syntax class of error.

**Known risk, accepted.** Ruling 6 (`currentWeek` used as an NFL week) is the one
assumption that could be silently wrong, in leagues whose current matchup period
spans two scoring periods. The blast radius is one week of environment factors landing
on the wrong week; the search, the season sim and every other week are untouched.
