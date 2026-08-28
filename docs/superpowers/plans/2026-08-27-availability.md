# Phase 2 — Availability core and the in-season horizon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop pretending every rostered player suits up and every week still counts — record ESPN/Sleeper injury status, price a lineup under uncertainty inside `Engine.weekly`, trim the engine's weeks to the ones still to be played, and start the season simulation from the real standings.

**Architecture:** One new pure engine module (`extension/engine/availability.js`) turns injury strings into a per-player, per-week probability of playing and trims the week list. `Engine` gains `setAvailability`; `weekly` splits each week's roster into certain and uncertain players and returns the probability-weighted mean of the *optimal* lineup over the uncertain outcomes — lineup value is not linear in availability, so blending probabilities into projections would be wrong. `projectSeason` gains `records` so each simulated season starts from the games already won. All UI string-building lives in `extension/panel/availability.js`; `panel.js` gains one import, one `PHASES` entry, one block in `start()` and three small hunks in `render()`.

**Tech Stack:** Plain ES modules, no build step, Chrome MV3 extension page. Tests are `node extension/test/run-all.mjs` (custom `ok()` assertions, no framework). No browser is available to the implementers — every panel task ends with a written browser-verification checklist instead.

**Spec:** `docs/superpowers/specs/2026-08-27-availability-design.md`
**Parallel-build rules (binding):** `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`

## Global Constraints

- **The engine models slots, not positions.** Availability is a per-player scalar; it never touches `eligibleSlots`, `masks`, or `positionLimits`. Position strings stay display-only.
- **`extension/test/parity.mjs` must not be edited and must stay green.** It builds its model without `currentWeek`, never calls `restrictToRemaining` and never calls `setAvailability`, so the 605 frozen assertions must reproduce byte for byte. New tests go in `extension/test/availability.mjs` only, using the `ok()` pattern from `extension/test/sources.mjs`.
- **`Engine.weekly` must be unchanged when no availability is attached.** When `this.avail` is null the function takes the original code path verbatim: one `ids.slice().sort()` and one `bestLineup` per week, no extra allocation, no extra branch inside the per-player loop.
- **Nothing in the search is approximated.** Enumeration over `2^k` outcomes is exact for `k <= 6`; only `k > 6` samples, with a fixed seed, and that branch must be documented as the one approximation in the engine.
- **The searches stay async with real macrotask yields.** `findTwoTeam`, `findThreeWay`, `buildSwapTable` and `enrich` keep `await yieldToBrowser()` exactly where they have it. Do not add or remove a yield.
- **`projectSeason` must keep its draw order fixed.** Common random numbers in `odds.js` depend on it: seeding `wins[i]` from a record must not add, remove, or reorder a single call to `gauss(rand)`.
- **Time windows stay separate.** `gain` / `reg` / `playoff` / `bye` / `full` are never collapsed. The horizon changes *which* weeks exist, never how the windows are averaged.
- **Read settings, never derive them.** `currentWeek` comes from `readSettings` (already exposed); team records come from ESPN's `t.record.overall`. Do not compute a current week from a date.
- **Logic lives in new files.** Engine code in `extension/engine/availability.js`; panel code in `extension/panel/availability.js`. `panel.js` edits are limited to: one import line, one `PHASES` entry, one block in `start()`, and one call site in `render()` per new column/section. Keep every hunk minimal.
- **No new host permissions.** Sleeper is CORS-open and goes through the existing `engine/sources/cache.js` + `engine/sources/sleeper.js`, with `{fetchImpl, storage, now}` injection so tests run offline.
- **Every feature degrades.** A dead Sleeper feed logs one line via `say()` and falls back to ESPN status only. Nothing new may throw out of `start()`.
- **Privacy.** No new network destination beyond `api.sleeper.app`, no analytics, nothing about the league leaves the machine.
- Run `node extension/test/run-all.mjs` before every commit. It must print `2 files, 0 failing` (3 files once `availability.mjs` exists) with `0 failures` in each.
- Commit messages: imperative subject, blank line, then the trailer block used throughout this repo:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
  ```

## File structure

| File | Responsibility | Status |
|---|---|---|
| `extension/engine/availability.js` | `PLAY_PROB`, `normStatus`, `playProb`, `buildAvailability`, `restrictToRemaining`, `mulberry32`. Pure; no DOM, no fetch, no engine knowledge. | create |
| `extension/engine/league.js` | Records `injuryStatus` / `injured` on every player (rostered and free agent) and `record` on every team. Three field additions, nothing else. | modify |
| `extension/engine/search.js` | `Engine.setAvailability`, availability-aware `weekly` / `starterMask` / `startRates` / `rosterSigma`, `_likely`, `_enumerate`, `_sample`. | modify |
| `extension/engine/season.js` | `projectSeason` gains the `records` option; `games` becomes played + remaining. | modify |
| `extension/engine/odds.js` | `simOpts` passes `records` through so per-trade odds run against the real standings. Two lines. | modify |
| `extension/panel/availability.js` | Every string the UI needs: status codes, cells, badges, sort rank, log lines, the season-panel note. Pure functions over a context object. | create |
| `extension/panel.js` | One import, one `PHASES` entry, one block in `start()`, three hunks in `render()`. | modify |
| `extension/panel.css` | `.avail` badge styling, appended at the end of the file. | modify |
| `extension/test/availability.mjs` | Every new assertion. `ok()` pattern from `sources.mjs`; model built the way `parity.mjs` builds it. | create |
| `CLAUDE.md` | Architecture map, the commands line, and three new load-bearing decisions. | modify |

**Test-file conventions.** `extension/test/availability.mjs` defines its own `ok(cond, what)`, loads `fixture.json`, and builds its own `model` / `eng` — it must **not** import `parity.mjs`. Reference copy of the construction block is given verbatim in Task 1, Step 1; later tasks reuse it by name (`F`, `NW`, `masks`, `starters`, `mkModel`, `mkEngine`).

**Vocabulary used across tasks.** A *resolved status* is one of the canonical strings `ACTIVE`, `QUESTIONABLE`, `DOUBTFUL`, `OUT`, `INJURY_RESERVE`, `PUP`, `SUSPENSION`. A player is *certain* in a week when his play probability is exactly 0 or exactly 1, and *uncertain* when it is strictly between. *Shelved* means `INJURY_RESERVE`, `PUP` or `SUSPENSION` — zero for every week in the horizon.

---

### Task 1: `availability.js` — play probability, the horizon, and the ESPN fields

**Files:**
- Create: `extension/engine/availability.js`
- Create: `extension/test/availability.mjs`
- Modify: `extension/engine/league.js` (the `const pl = players.get(p.id) ?? {` literal in `loadLeague`; the `const rec = teams.get(t.id) ?? {` literal in `loadLeague`; the `out.push({` literal in `loadFreeAgents`)

**Interfaces:**
- Consumes: `model.players` records with optional `injuryStatus` (string|null) and `injured` (bool); Sleeper's `byEspn: Map<number, rec>` from `loadSleeperPlayers`, where `rec` may carry `injury_status`, `practice_participation`, `practice_description`, `injury_body_part`; `model.settings.currentWeek` from `readSettings`.
- Produces:
  - `PLAY_PROB: { now: Record<string, number>, later: Record<string, number>, practice: Record<string, number> }`
  - `normStatus(s: string|null|undefined): string` — a resolved status; `"ACTIVE"` for null/empty/unknown-but-blank.
  - `playProb(status: string|null, practice: string|null, weekIndexOffset: number): number` in `[0, 1]`.
  - `buildAvailability(model, byEspn: Map|null, weeks: number[], currentWeek: number): { avail: Map<playerId, Float64Array>, statusOf: Map<playerId, {status, practice, note, now}>, summary: {out, questionable, shelved, uncertain, matched, total} }` — `avail` holds an entry **only** for players who are not fully available in every week of `weeks`.
  - `restrictToRemaining(model): { currentWeek, played, remaining, complete, weeks, from, to }` — mutates `model.weeks` and `model.settings.{regularSeasonWeeks, playoffWeeks, playoffRoundWeeks}` in place.
  - `mulberry32(seed: number): () => number`.
- Later tasks rely on: Task 2 imports `mulberry32`; Task 3 needs nothing from here; Task 4 imports `statusOf`/`summary` shapes; Task 5 imports `restrictToRemaining` and `buildAvailability`.

Assumptions, each stated in a comment in the code:
1. An unrecognised status string means "playing". A new ESPN enum value must never silently zero a roster.
2. Sleeper's status is consulted **only** when ESPN says `ACTIVE` — ESPN lags the wire, but where ESPN has committed to a status it is the league's own source of truth.
3. `SUSPENSION` is zero for every remaining week. Suspension length is not in either feed; the conservative reading is flagged in the UI rather than guessed at.
4. `mulberry32` is duplicated here rather than imported from `season.js`. `season.js`'s copy drives common random numbers for `odds.js`; coupling the lineup solver to the season simulator so that a change to one silently reseeds the other is worse than eight duplicated lines.

- [ ] **Step 1: Write the failing tests**

Create `extension/test/availability.mjs` with exactly this content:

```js
/**
 * Tests for availability, the remaining-weeks horizon, and record-seeded seasons.
 *
 * `parity.mjs` is the engine's frozen contract and is never touched; this file
 * carries everything Phase 2 added. The model is built the way parity.mjs builds
 * it - deliberately copied rather than imported, so that a change here can never
 * move the golden set.
 *
 *   node extension/test/availability.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { Engine } from "../engine/search.js";
import { projectSeason } from "../engine/season.js";
import {
  PLAY_PROB, normStatus, playProb, buildAvailability, restrictToRemaining,
} from "../engine/availability.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));
const NW = F.weeks.length;
const { slots, starters } = buildSlots(F.lineupSlotCounts);
const masks = F.pos.map((p) => seatMask(F.eligibleSlots[p], slots));

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const near = (a, b, eps, what) => ok(Math.abs(a - b) < eps, `${what} (${a} vs ${b})`);

/** A fresh model, shaped like parity.mjs's, with an optional currentWeek. */
function mkModel(currentWeek = 1) {
  return {
    weeks: F.weeks.slice(),
    settings: {
      currentWeek,
      regularSeasonWeeks: F.weeks.filter((w) => w <= 14),
      playoffWeeks: [15, 16, 17],
      playoffRoundWeeks: [[15], [16], [17]],
      playoffTeams: 6,
      playoffReseed: true,
      lineupSlotCounts: F.lineupSlotCounts,
    },
    players: new Map(F.pos.map((pos, i) => [i, {
      id: i, name: `p${i}`, pos, nfl: "X", eligibleSlots: F.eligibleSlots[pos],
      bye: F.weeks.find((w) => !(F.proj[i][F.weeks.indexOf(w)] > 0)) ?? 0,
      proj: Object.fromEntries(F.weeks.map((w, k) => [w, F.proj[i][k]])),
    }])),
    teams: new Map(F.teams.map((name, ti) =>
      [ti, { id: ti, name, roster: new Set(F.rosters[name]) }])),
  };
}
const mkEngine = (model) =>
  new Engine(model, { starters }, new Map(F.pos.map((p, i) => [i, masks[i]])));

/* ---- 1. playProb: every row of the spec's table ---- */
{
  ok(playProb("ACTIVE", null, 0) === 1, "ACTIVE plays this week");
  ok(playProb(null, null, 0) === 1, "no status plays this week");
  ok(playProb("ACTIVE", null, 3) === 1, "ACTIVE plays later");
  near(playProb("QUESTIONABLE", null, 0), 0.71, 1e-12, "Q this week");
  near(playProb("QUESTIONABLE", "FP", 0), 0.90, 1e-12, "Q full practice");
  near(playProb("QUESTIONABLE", "LP", 0), 0.70, 1e-12, "Q limited practice");
  near(playProb("QUESTIONABLE", "DNP", 0), 0.35, 1e-12, "Q did not practise");
  ok(playProb("QUESTIONABLE", "DNP", 1) === 1, "Q is assumed back next week");
  near(playProb("DOUBTFUL", null, 0), 0.06, 1e-12, "D this week");
  ok(playProb("DOUBTFUL", null, 1) === 1, "D is assumed back next week");
  ok(playProb("OUT", null, 0) === 0, "OUT scores nothing this week");
  ok(playProb("OUT", null, 1) === 1, "OUT is assumed back next week");
  ok(playProb("INJURY_RESERVE", null, 0) === 0 && playProb("INJURY_RESERVE", null, 9) === 0,
     "IR is out for the horizon");
  ok(playProb("IR", null, 4) === 0, "Sleeper's IR spelling is the same status");
  ok(playProb("PUP", null, 4) === 0, "PUP is out for the horizon");
  ok(playProb("SUSPENSION", null, 0) === 0 && playProb("SUSPENSION", null, 9) === 0,
     "suspension is out for the horizon");
  ok(playProb("Sus", null, 2) === 0, "Sleeper's Sus spelling is a suspension");
  ok(playProb("SOME_NEW_ESPN_ENUM", null, 0) === 1,
     "an unknown status is treated as playing");
  ok(normStatus("Questionable") === "QUESTIONABLE" && normStatus("injury reserve") === "INJURY_RESERVE",
     "statuses normalise across feeds");
  ok(PLAY_PROB.now.QUESTIONABLE === 0.71 && PLAY_PROB.practice.DNP === 0.35,
     "the constants live in one replaceable table");
}

/* ---- 2. buildAvailability ---- */
{
  const model = mkModel(5);
  const P = (i) => model.players.get(i);
  P(0).injuryStatus = "OUT";
  P(1).injuryStatus = "QUESTIONABLE";
  P(2).injuryStatus = "INJURY_RESERVE";
  P(3).injuryStatus = "ACTIVE";                 // Sleeper knows better
  P(4).injuryStatus = "ACTIVE";                 // and agrees
  for (const t of model.teams.values()) for (const id of t.roster) P(id).teamId = 1;
  for (let i = 0; i < 5; i++) P(i).teamId = 0;
  const byEspn = new Map([
    [1, { espn_id: 1, injury_status: "Questionable", practice_participation: "DNP" }],
    [3, { espn_id: 3, injury_status: "Out" }],
    [4, { espn_id: 4, injury_status: null }],
  ]);
  const weeks = model.weeks.filter((w) => w >= 5);
  const { avail, statusOf, summary } = buildAvailability(model, byEspn, weeks, 5);

  ok(avail.get(0)[0] === 0 && avail.get(0)[1] === 1, "ESPN OUT: this week only");
  near(avail.get(1)[0], 0.35, 1e-12, "Sleeper's practice report sharpens ESPN's Q");
  ok([...avail.get(2)].every((p) => p === 0), "IR is zero for every remaining week");
  ok(avail.get(3)[0] === 0, "Sleeper overrides ESPN when ESPN says ACTIVE");
  ok(!avail.has(4), "a fully available player gets no entry at all");
  ok(avail.get(0).length === weeks.length, "one probability per remaining week");
  ok(statusOf.get(1).status === "QUESTIONABLE" && statusOf.get(1).practice === "DNP",
     "statusOf carries what the UI has to show");
  ok(!statusOf.has(4), "statusOf skips available players");
  // Two are out this week: player 0 by ESPN, player 3 by Sleeper's override.
  ok(summary.out === 2 && summary.questionable === 1 && summary.shelved === 1,
     `summary counts (out ${summary.out}, q ${summary.questionable}, shelved ${summary.shelved})`);
  ok(summary.total === 4, "only rostered players are counted");
  ok(summary.uncertain === 1, "one genuinely uncertain player");
  ok(summary.matched === 3, "Sleeper match count is reported");

  const none = buildAvailability(mkModel(1), null, F.weeks, 1);
  ok(none.avail.size === 0 && none.summary.matched === 0,
     "no injuries and no Sleeper: an empty availability map");
}

/* ---- 3. restrictToRemaining ---- */
{
  const model = mkModel(9);
  const h = restrictToRemaining(model);
  ok(model.weeks[0] === 9 && model.weeks.at(-1) === 18, "weeks start at the current one");
  ok(model.weeks.length === 10, `10 weeks remain (got ${model.weeks.length})`);
  ok(model.settings.regularSeasonWeeks.every((w) => w >= 9), "regular-season weeks filtered");
  ok(model.settings.regularSeasonWeeks.length === 6, "six regular-season weeks left");
  ok(model.settings.playoffWeeks.join() === "15,16,17", "playoff weeks survive");
  ok(model.settings.playoffRoundWeeks.length === 3, "playoff rounds survive");
  ok(h.played === 8 && h.remaining === 10 && h.from === 9 && h.to === 18 && !h.complete,
     "the horizon is reported for the log line");

  const late = mkModel(17);
  restrictToRemaining(late);
  ok(late.settings.regularSeasonWeeks.length === 0, "no regular season left in week 17");
  ok(late.settings.playoffRoundWeeks.length === 1
     && late.settings.playoffRoundWeeks[0].join() === "17",
     "empty playoff rounds are dropped, the live one kept");

  const over = mkModel(99);
  const ho = restrictToRemaining(over);
  ok(ho.complete === true, "a finished season reports complete");
  ok(over.weeks.length === NW, "a finished season keeps every week rather than none");
  ok(over.settings.regularSeasonWeeks.length === 14, "and keeps its settings arrays");

  const one = mkModel(1);
  const h1 = restrictToRemaining(one);
  ok(one.weeks.length === NW && h1.played === 0, "week 1 is a no-op");
  const engine = mkEngine(one);
  for (const t of F.teams)
    for (let w = 0; w < NW; w++)
      ok(Math.abs(engine.baseline.get(t)[w] - F.baseline[t][w]) < 1e-6,
         `a week-1 horizon leaves the baseline alone ${t}`);
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("AVAILABILITY OK");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/availability.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `Cannot find module .../engine/availability.js`.

- [ ] **Step 3: Write `extension/engine/availability.js`**

Create the file with exactly this content:

```js
/**
 * Who is actually going to play.
 *
 * ESPN puts `injuryStatus` on every player record we already fetch and we have been
 * throwing it away: a man on IR has been projecting like a starter, and a
 * Questionable one like a certainty. Sleeper's free player file adds the practice
 * report, which is the only public signal separating a Questionable who practised in
 * full from one who did not practise at all - and the difference between those two is
 * larger than the difference between most trades.
 *
 * The constants below are league-average conversion rates. They live in one exported
 * table so that Phase 9 can replace them with measured, team-specific ones without
 * touching anything that reads them.
 */

/**
 * Deterministic PRNG, for the sampled branch of the lineup solve.
 *
 * Duplicated from season.js on purpose. season.js's copy is what makes the season
 * simulation's common random numbers work, and coupling the lineup solver to it so
 * that a change in one silently reseeds the other is worse than eight repeated lines.
 */
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Play probability by resolved status.
 *
 * `now` is the week in progress - the only week a Questionable tag is about. `later`
 * is every week after it: a tag for this Sunday says nothing about November, so a
 * Questionable, Doubtful or Out player is assumed back, while IR, PUP and a
 * suspension keep him at zero for the whole horizon.
 *
 * `practice` refines Questionable only, and only for the current week. Full
 * participation on Friday is close to a lock; a player who did not practise at all
 * and is still listed Questionable is closer to a coin flip against him.
 */
export const PLAY_PROB = {
  now: {
    ACTIVE: 1,
    QUESTIONABLE: 0.71,
    DOUBTFUL: 0.06,
    OUT: 0,
    INJURY_RESERVE: 0,
    PUP: 0,
    SUSPENSION: 0,
  },
  later: {
    ACTIVE: 1,
    QUESTIONABLE: 1,
    DOUBTFUL: 1,
    OUT: 1,
    INJURY_RESERVE: 0,
    PUP: 0,
    // Suspension length is in neither feed. Zero for the horizon is the conservative
    // reading; the UI flags it as an assumption rather than a measurement.
    SUSPENSION: 0,
  },
  practice: { FP: 0.90, LP: 0.70, DNP: 0.35 },
};

/** ESPN and Sleeper spell the same status several ways; canonicalise them. */
const ALIAS = {
  ACTIVE: "ACTIVE", NORMAL: "ACTIVE", HEALTHY: "ACTIVE",
  Q: "QUESTIONABLE", QUESTIONABLE: "QUESTIONABLE",
  D: "DOUBTFUL", DOUBTFUL: "DOUBTFUL",
  O: "OUT", OUT: "OUT",
  IR: "INJURY_RESERVE", INJURY_RESERVE: "INJURY_RESERVE",
  PUP: "PUP", PHYSICALLY_UNABLE_TO_PERFORM: "PUP",
  NFI: "PUP", NON_FOOTBALL_INJURY: "PUP", NON_FOOTBALL_ILLNESS: "PUP",
  SUS: "SUSPENSION", SUSPENSION: "SUSPENSION", SUSPENDED: "SUSPENSION",
};

/**
 * A feed's status string as one of the canonical ones.
 *
 * An unrecognised value resolves to ACTIVE, and that is deliberate: ESPN adds enum
 * values, and a new one must never silently zero out somebody's roster.
 */
export function normStatus(s) {
  if (s == null) return "ACTIVE";
  const k = String(s).trim().toUpperCase().replace(/[\s.-]+/g, "_");
  if (!k) return "ACTIVE";
  return ALIAS[k] ?? "ACTIVE";
}

/**
 * @param status   ESPN or Sleeper injury status string, or null
 * @param practice Sleeper `practice_participation`: "FP" | "LP" | "DNP" | null
 * @param weekIndexOffset 0 for the current week, >= 1 for a future one
 * @returns probability of playing, in [0, 1]
 */
export function playProb(status, practice, weekIndexOffset = 0) {
  const key = normStatus(status);
  const table = weekIndexOffset > 0 ? PLAY_PROB.later : PLAY_PROB.now;
  const base = table[key];
  if (base === undefined) return 1;
  if (weekIndexOffset <= 0 && key === "QUESTIONABLE" && practice != null) {
    const p = PLAY_PROB.practice[String(practice).trim().toUpperCase()];
    if (p !== undefined) return p;
  }
  return base;
}

/**
 * A probability of playing for every player, in every week of the horizon.
 *
 * ESPN's status wins wherever ESPN has committed to one; Sleeper is consulted only
 * when ESPN still says ACTIVE, because ESPN lags the wire by hours on a Friday but
 * is the league's own source of truth once it has moved.
 *
 * Players who are fully available in every week get no entry at all - the engine
 * defaults to 1 - which keeps the map tiny and the fast path fast.
 *
 * @param model      the loaded league; players may carry injuryStatus / injured
 * @param byEspn     Sleeper's Map<espnId, rec>, or null when the feed is unavailable
 * @param weeks      the engine's week list (already restricted to the remaining ones)
 * @param currentWeek settings.currentWeek
 */
export function buildAvailability(model, byEspn, weeks, currentWeek) {
  const avail = new Map();
  const statusOf = new Map();
  const summary = { out: 0, questionable: 0, shelved: 0, uncertain: 0, matched: 0, total: 0 };

  for (const p of model.players.values()) {
    const sl = byEspn?.get(Number(p.id)) ?? null;
    if (sl) summary.matched++;

    const espn = normStatus(p.injuryStatus);
    const wire = normStatus(sl?.injury_status);
    const status = espn === "ACTIVE" && wire !== "ACTIVE" ? wire : espn;
    const practice = sl?.practice_participation ?? null;

    const row = new Float64Array(weeks.length);
    let doubt = false;
    for (let w = 0; w < weeks.length; w++) {
      const q = playProb(status, practice, weeks[w] - currentWeek);
      row[w] = q;
      if (q < 1) doubt = true;
    }
    if (!doubt) continue;

    avail.set(p.id, row);
    statusOf.set(p.id, {
      status, practice,
      note: sl?.practice_description ?? sl?.injury_body_part ?? null,
      now: row[0],
    });

    // Only rostered players are counted. The free-agent pool is hundreds deep and
    // full of shelved players; folding it in would make the log line meaningless.
    if (p.teamId == null) continue;
    summary.total++;
    if (status === "INJURY_RESERVE" || status === "PUP" || status === "SUSPENSION") summary.shelved++;
    else if (row[0] === 0) summary.out++;
    else summary.questionable++;
    if (row[0] > 0 && row[0] < 1) summary.uncertain++;
  }
  return { avail, statusOf, summary };
}

/**
 * Drop the weeks that have already been played.
 *
 * Every number downstream - baselines, the searches, the season simulation - runs
 * over `model.weeks`, so trimming it here is the whole fix: a trade proposed in week
 * nine is scored on weeks nine onward rather than averaged with eight weeks nobody
 * can change. A trade that looks mildly positive across the whole season is often
 * strongly positive across the part of it that is left, and occasionally the reverse.
 *
 * Mutates `model` in place: `Engine` and `panel.js` both hold the same object.
 * A season already over keeps every week - showing nothing at all is worse than
 * showing a retrospective, and the caller is told so it can say which it is.
 */
export function restrictToRemaining(model) {
  const currentWeek = model.settings?.currentWeek ?? 1;
  const all = model.weeks ?? [];
  const keep = all.filter((w) => w >= currentWeek);
  if (!keep.length) {
    return { currentWeek, played: 0, remaining: all.length, complete: true,
             weeks: all, from: all[0] ?? 0, to: all.at(-1) ?? 0 };
  }
  const live = new Set(keep);
  const f = (a) => (a ?? []).filter((w) => live.has(w));
  const s = model.settings;
  model.weeks = keep;
  s.regularSeasonWeeks = f(s.regularSeasonWeeks);
  s.playoffWeeks = f(s.playoffWeeks);
  s.playoffRoundWeeks = (s.playoffRoundWeeks ?? []).map(f).filter((ws) => ws.length);
  return { currentWeek, played: all.length - keep.length, remaining: keep.length,
           complete: false, weeks: keep, from: keep[0], to: keep.at(-1) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node extension/test/availability.mjs`
Expected: `AVAILABILITY OK` with `0 failures`.

- [ ] **Step 5: Record the ESPN fields in `league.js`**

Three additions, no other change.

In `loadLeague`, the team record literal currently reads:

```js
      const rec = teams.get(t.id) ?? {
        id: t.id, name, roster: new Set(), owners: t.owners ?? [],
        divisionId: t.divisionId ?? 0,
      };
      rec.name = name;
      rec.divisionId = t.divisionId ?? rec.divisionId ?? 0;
```

Add one line after the `rec.divisionId = ...` line:

```js
      // Games already played are decided; the season projection starts from them
      // rather than from 0-0. ESPN sends this with every mTeam view.
      if (t.record?.overall) rec.record = {
        wins: t.record.overall.wins ?? 0,
        losses: t.record.overall.losses ?? 0,
        ties: t.record.overall.ties ?? 0,
        pointsFor: t.record.overall.pointsFor ?? 0,
      };
```

In `loadLeague`, the player literal currently reads:

```js
        const pl = players.get(p.id) ?? {
          id: p.id, name: p.fullName,
          eligibleSlots: p.eligibleSlots ?? [],
          pos: positionLabel(p),
          posId: p.defaultPositionId ?? 0,
          nfl: PRO_TEAM[p.proTeamId] ?? "?",
          teamId: t.id, proj: {}, rawStats: p.stats ?? [],
        };
        pl.teamId = t.id;
```

Insert one field after `posId: ...` and refresh it on every week's pass (the last
week fetched carries the freshest status), so that block becomes:

```js
        const pl = players.get(p.id) ?? {
          id: p.id, name: p.fullName,
          eligibleSlots: p.eligibleSlots ?? [],
          pos: positionLabel(p),
          posId: p.defaultPositionId ?? 0,
          // ESPN's own words, passed through rather than mapped: availability.js
          // owns the vocabulary, and an unknown string there means "playing".
          injuryStatus: p.injuryStatus ?? null,
          injured: p.injured === true,
          nfl: PRO_TEAM[p.proTeamId] ?? "?",
          teamId: t.id, proj: {}, rawStats: p.stats ?? [],
        };
        pl.teamId = t.id;
        if (p.injuryStatus != null) pl.injuryStatus = p.injuryStatus;
        if (p.injured != null) pl.injured = p.injured === true;
```

In `loadFreeAgents`, the `out.push({ ... })` literal gains the same two fields after
`posId: p.defaultPositionId ?? 0,`:

```js
      injuryStatus: p.injuryStatus ?? null,
      injured: p.injured === true,
```

- [ ] **Step 6: Run the whole suite**

Run: `node extension/test/run-all.mjs`
Expected: three files, `0 failing`; `parity.mjs` still prints `605 assertions, 0 failures`.

- [ ] **Step 7: Check the panel still parses**

Run: `node --check extension/panel.js && node --check extension/engine/league.js && node --check extension/engine/availability.js`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add extension/engine/availability.js extension/engine/league.js extension/test/availability.mjs
git commit -m "Read injury status, and price the chance a player suits up

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 2: `Engine` — expected lineup value under uncertainty

**Files:**
- Modify: `extension/engine/search.js` (imports; constructor scratch arrays; `weekly`; `starterMask`; `startRates`; `rosterSigma`; three new methods)
- Modify: `extension/test/availability.mjs` (append section 4 before the summary lines)

**Interfaces:**
- Consumes: `mulberry32` from `extension/engine/availability.js`; `bestLineup` from `extension/engine/lineup.js` (unchanged).
- Produces:
  - `Engine.avail: Float64Array(n * NW) | null` — `null` until `setAvailability` is called.
  - `Engine.setAvailability(avail: Map<playerId, Float64Array>): void` — fills the default of 1, clamps to `[0, 1]`, treats a non-finite value as 1, then rebuilds `baseline` and clears `_swaps`, `_teamSigma`, `_baseWins`.
  - `Engine.weekly(ids, out?)` — unchanged signature, now returning the *expected* optimal lineup value per week.
  - `Engine.ENUM_MAX = 6`, `Engine.SAMPLES = 64` as module constants `ENUM_MAX` / `SAMPLES` (not exported; referenced only inside `search.js`).
  - `Engine._likely(ids, w): number[]` — the roster under the most likely outcome; returns the **same array instance** `ids` when no availability is attached.
- Later tasks rely on: nothing new. Task 5 calls `setAvailability`.

**The correctness argument that must appear as a comment.** An unavailable player is *removed from the pool*, not given a value of zero. Zeroing looks equivalent and is not: `bestLineup` seats players in the order handed to it, and once a player is seated he is never unseated (`assign` only reshuffles seats). A high-projection player zeroed in place still sits early in that order, takes a seat, and can block a lower-but-positive player who would otherwise have started. Filtering him out of the order is the only correct move, and it is why `weekly` builds a `play` list rather than writing zeros into `_vals`.

**Why enumeration rather than a weighted projection.** Optimal lineup value is a max over assignments, so it is convex in the projections and not linear in availability: `E[L]` is not `L(E[proj])`. Two players at 50% are not one certain starter — the bench absorbs one absence far better than two. Enumerating `2^k` outcomes and weighting by their probabilities is exact.

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/availability.mjs`, immediately before the line
``console.log(`\n${checks} assertions, ${failures} failures`);``:

```js
/* ---- 4. weekly() under uncertainty ---- */
{
  const base = mkEngine(mkModel(1));
  const team = F.teams[0];
  const roster = base.roster.get(team);

  // The engine indexes players by their own id here, so index === player id.
  const idOf = (i) => base.ids[i];
  const byProj = roster.slice().sort((a, b) =>
    base.proj[b * NW] - base.proj[a * NW]);
  const star = byProj[0], second = byProj[1];

  const allOnes = () => {
    const m = new Map();
    for (const i of roster) m.set(idOf(i), new Float64Array(NW).fill(1));
    return m;
  };
  const withAvail = (edit) => {
    const e = mkEngine(mkModel(1));
    const m = allOnes();
    edit(m, e);
    e.setAvailability(m);
    return e;
  };

  /* all ones reproduces the frozen contract exactly */
  {
    const e = withAvail(() => {});
    for (const t of F.teams)
      for (let w = 0; w < NW; w++)
        ok(Math.abs(e.baseline.get(t)[w] - F.baseline[t][w]) < 1e-9,
           `all-available baseline ${t} wk${F.weeks[w]}`);
  }

  /* one OUT starter this week === the roster without him */
  {
    const e = withAvail((m) => { m.get(idOf(star))[0] = 0; });
    const without = base.weekly(roster.filter((i) => i !== star));
    near(e.weekly(roster)[0], without[0], 1e-9, "an OUT starter is simply not there");
    near(e.weekly(roster)[1], base.baseline.get(team)[1], 1e-9,
         "and next week he is back");
  }

  /* one Questionable === the probability-weighted mean of the two lineups */
  {
    const e = withAvail((m) => { m.get(idOf(star))[0] = 0.71; });
    const with_ = base.baseline.get(team)[0];
    const without = base.weekly(roster.filter((i) => i !== star))[0];
    near(e.weekly(roster)[0], 0.71 * with_ + 0.29 * without, 1e-9,
         "Q is weighted between playing and not");
    ok(e.weekly(roster)[0] < with_ && e.weekly(roster)[0] > without,
       "and lands strictly between the two");
  }

  /* two uncertain players: all four outcomes, exactly */
  {
    const e = withAvail((m) => {
      m.get(idOf(star))[0] = 0.6;
      m.get(idOf(second))[0] = 0.4;
    });
    const L = (drop) => base.weekly(roster.filter((i) => !drop.includes(i)))[0];
    const want = 0.6 * 0.4 * L([])
               + 0.6 * 0.6 * L([second])
               + 0.4 * 0.4 * L([star])
               + 0.4 * 0.6 * L([star, second]);
    near(e.weekly(roster)[0], want, 1e-9, "k = 2 enumerates all four outcomes");
  }

  /* k = 6 is enumerated; k = 7 is sampled, deterministic, and close */
  {
    const six = byProj.slice(0, 6), seventh = byProj[6];
    const enumerated = withAvail((m) => {
      for (const i of six) m.get(idOf(i))[0] = 0.4;
      m.get(idOf(seventh))[0] = 1;
    });
    const sampled = withAvail((m) => {
      for (const i of six) m.get(idOf(i))[0] = 0.4;
      m.get(idOf(seventh))[0] = 0.999;
    });
    const a = sampled.weekly(roster)[0];
    const b = sampled.weekly(roster)[0];
    ok(a === b, "the sampled branch is deterministic across calls");
    const exact = enumerated.weekly(roster)[0];
    ok(Math.abs(a - exact) / exact < 0.03,
       `64 draws land within 3% of the enumerated value (${a} vs ${exact})`);
    console.log(`  sampling error at k=7: ${(100 * Math.abs(a - exact) / exact).toFixed(2)}%`);
  }

  /* the modal lineup drives the usage strips and the spread */
  {
    const e = withAvail((m) => {
      m.get(idOf(star))[0] = 0.2;         // most likely: out
      m.get(idOf(second))[0] = 0.8;       // most likely: in
    });
    ok(e.starterMask(roster).get(star)[0] === 0,
       "a player more likely out than in does not appear in the strip");
    ok(e.starterMask(roster).get(star)[1] === 1,
       "and appears again once he is healthy");
    ok(e.starterMask(roster).get(second)[0] === 1,
       "a player more likely in than out still starts");
    ok(e.startRates().get(star) < 1, "start rates follow the modal lineup too");
  }

  /* sigma scales with the chance of playing */
  {
    const vol = { bySigma: new Map(roster.map((i) => [idOf(i), 10])), byPos: new Map(), global: 10 };
    const full = mkEngine(mkModel(1));
    full.setVolatility(vol);
    const half = withAvail((m) => { for (const i of roster) m.get(idOf(i))[0] = 0.5; });
    half.setVolatility(vol);
    const a = full.rosterSigma(roster)[0], b = half.rosterSigma(roster)[0];
    near(b, a / Math.SQRT2, 1e-9, "p = 0.5 halves the variance, not the sigma");
  }

  /* the searches still run, still yield, and still find the same shapes */
  {
    const e = withAvail((m) => { m.get(idOf(star))[0] = 0.5; });
    const found = await e.findTwoTeam(1, 0.05);
    ok(Array.isArray(found) && found.every((t) => t.sides.length === 2),
       "1-for-1 still returns two-sided trades with availability attached");
    ok(found.every((t) => t.sides.every((s) => s.gain >= 0.05)),
       "and still only mutually beneficial ones");
  }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/availability.mjs`
Expected: `TypeError: e.setAvailability is not a function`.

- [ ] **Step 3: Import `mulberry32` and add the module constants**

In `extension/engine/search.js`, the import block currently reads:

```js
import { bestLineup } from "./lineup.js";
import { winProb, leverage, FALLBACK_SIGMA } from "./winprob.js";
```

Add one import and two constants directly after it:

```js
import { bestLineup } from "./lineup.js";
import { winProb, leverage, FALLBACK_SIGMA } from "./winprob.js";
import { mulberry32 } from "./availability.js";

/**
 * How wide an exact enumeration is allowed to get.
 *
 * Optimal lineup value is a max over assignments, so it is convex in the projections
 * and NOT linear in availability: E[L] is not L(E[proj]). Two players at 50% are not
 * one certain starter, because a bench absorbs one absence far better than two.
 * The only exact answer is to enumerate the 2^k availability outcomes and weight
 * them, which is why nothing here averages probabilities into projections.
 *
 * 2^6 = 64 lineup solves for one week is affordable; beyond that the same 64 solves
 * are spent on fixed-seed draws instead. That sampled branch is the one approximation
 * in the engine, it is reached only when seven or more players on a single roster are
 * genuinely uncertain in the same week, and it is deterministic.
 */
const ENUM_MAX = 6;
const SAMPLES = 64;
```

- [ ] **Step 4: Add the scratch arrays to the constructor**

In the constructor, the line

```js
    this._vals = new Float64Array(this.n);   // scratch; must exist before weekly()
```

becomes:

```js
    // Scratch, all of it; every one of these must exist before the first weekly().
    this._vals = new Float64Array(this.n);
    this.avail = null;              // set by setAvailability(); null = everyone plays
    this._play = [];                // this week's available players, reused
    this._sub = [];                 // one enumeration outcome's player order, reused
    this._unc = new Int32Array(this.n);      // indices of the uncertain players
    this._uProb = new Float64Array(this.n);  // their probabilities
    this._isOut = new Uint8Array(this.n);    // outcome flags, cleared after each use
```

- [ ] **Step 5: Add `setAvailability`**

Insert this method immediately after the constructor's closing brace, before
`/** Best started points per week for a roster. */`:

```js
  /**
   * Attach a per-player, per-week probability of playing.
   *
   * The default is 1 everywhere, so an engine that is never handed availability
   * behaves exactly as it did before - which is what keeps the frozen golden set a
   * valid contract. Baselines and every cache derived from them are rebuilt here,
   * because the constructor computed them while assuming everyone plays.
   *
   * @param avail Map<playerId, Float64Array(NW)>; missing players are fully available
   */
  setAvailability(avail) {
    const NW = this.NW;
    const a = new Float64Array(this.n * NW).fill(1);
    for (const [id, row] of avail ?? []) {
      const i = this.index.get(id);
      if (i === undefined) continue;
      for (let w = 0; w < NW; w++) {
        const p = row?.[w];
        a[i * NW + w] = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 1;
      }
    }
    this.avail = a;
    this._swaps = null;
    this._teamSigma = null;
    this._baseWins = null;
    this.baseline = new Map();
    for (const t of this.teams) this.baseline.set(t, this.weekly(this.roster.get(t)));
  }
```

- [ ] **Step 6: Make `weekly` availability-aware**

Replace the whole `weekly` method:

```js
  /** Best started points per week for a roster. */
  weekly(ids, out) {
    const res = out ?? new Float64Array(this.NW);
    const vals = this._vals;
    for (let w = 0; w < this.NW; w++) {
      for (const i of ids) vals[i] = this.proj[i * this.NW + w];
      const order = ids.slice().sort((a, b) => vals[b] - vals[a]);
      res[w] = bestLineup(order, vals, this.mask, this.starters);
    }
    return res;
  }
```

with:

```js
  /**
   * Best started points per week for a roster - in expectation, once anybody's
   * availability is in doubt.
   *
   * With no availability attached this is the original path, character for
   * character: one sort and one matroid solve per week. That matters twice over -
   * the frozen golden set depends on it, and 2-for-2 calls this function millions of
   * times, so the common case must not pay for the uncommon one.
   *
   * With availability attached, a player who cannot play is REMOVED from the pool
   * rather than valued at zero. Those are not the same thing: bestLineup seats
   * players in the order it is handed and never unseats one, so a high-projection
   * player zeroed in place still sits early in that order, still takes a seat, and
   * can block a lower-but-positive player who would otherwise have started.
   * Filtering him out of the order is the only correct move.
   *
   * The genuinely uncertain players are enumerated (see ENUM_MAX). Only the current
   * week can hold any - a Questionable tag is about this Sunday, not November - so
   * the extra solves are confined to one week out of the horizon.
   */
  weekly(ids, out) {
    const res = out ?? new Float64Array(this.NW);
    const vals = this._vals;
    const av = this.avail;
    const NW = this.NW;
    if (!av) {
      for (let w = 0; w < NW; w++) {
        for (const i of ids) vals[i] = this.proj[i * NW + w];
        const order = ids.slice().sort((a, b) => vals[b] - vals[a]);
        res[w] = bestLineup(order, vals, this.mask, this.starters);
      }
      return res;
    }
    const play = this._play;
    const unc = this._unc;
    for (let w = 0; w < NW; w++) {
      play.length = 0;
      let k = 0;
      for (const i of ids) {
        const p = av[i * NW + w];
        if (p <= 0) continue;                       // cannot play: not in the pool
        vals[i] = this.proj[i * NW + w];
        play.push(i);
        if (p < 1) unc[k++] = i;
      }
      const order = play.slice().sort((a, b) => vals[b] - vals[a]);
      if (k === 0) { res[w] = bestLineup(order, vals, this.mask, this.starters); continue; }
      res[w] = k <= ENUM_MAX
        ? this._enumerate(order, unc, k, av, w)
        : this._sample(order, unc, k, av, w);
    }
    return res;
  }

  /** Exact expectation over the 2^k availability outcomes of one week. */
  _enumerate(order, unc, k, av, w) {
    const NW = this.NW, isOut = this._isOut, sub = this._sub, prob = this._uProb;
    for (let j = 0; j < k; j++) prob[j] = av[unc[j] * NW + w];
    let total = 0;
    for (let m = 0; m < (1 << k); m++) {
      let wt = 1;
      for (let j = 0; j < k; j++) {
        const inn = (m >> j) & 1;
        isOut[unc[j]] = inn ? 0 : 1;
        wt *= inn ? prob[j] : 1 - prob[j];
      }
      if (wt > 0) {
        sub.length = 0;
        for (let x = 0; x < order.length; x++) if (!isOut[order[x]]) sub.push(order[x]);
        total += wt * bestLineup(sub, this._vals, this.mask, this.starters);
      }
    }
    for (let j = 0; j < k; j++) isOut[unc[j]] = 0;
    return total;
  }

  /**
   * SAMPLES fixed-seed draws, for the rare week where enumeration would be too wide.
   * The generator is created fresh from a seed that depends only on the week, so two
   * calls with the same roster return the identical number - a search whose answer
   * moved between passes would be worse than one that is slightly wrong.
   */
  _sample(order, unc, k, av, w) {
    const NW = this.NW, isOut = this._isOut, sub = this._sub, prob = this._uProb;
    for (let j = 0; j < k; j++) prob[j] = av[unc[j] * NW + w];
    const rand = mulberry32(0x0A11AB1E ^ Math.imul(w, 0x9E3779B1));
    let total = 0;
    for (let s = 0; s < SAMPLES; s++) {
      for (let j = 0; j < k; j++) isOut[unc[j]] = rand() < prob[j] ? 0 : 1;
      sub.length = 0;
      for (let x = 0; x < order.length; x++) if (!isOut[order[x]]) sub.push(order[x]);
      total += bestLineup(sub, this._vals, this.mask, this.starters);
    }
    for (let j = 0; j < k; j++) isOut[unc[j]] = 0;
    return total / SAMPLES;
  }

  /**
   * The roster as the single most likely outcome has it: everyone at p >= 0.5.
   *
   * Usage strips and explanations have to name actual players, so they show the
   * modal lineup rather than a probability-weighted blur - a row that says a man
   * starts 0.71 of a week is not readable. Returns `ids` itself when no availability
   * is attached, so the untouched path allocates nothing.
   */
  _likely(ids, w) {
    const av = this.avail;
    if (!av) return ids;
    const out = [];
    for (const i of ids) if (av[i * this.NW + w] >= 0.5) out.push(i);
    return out;
  }
```

- [ ] **Step 7: Route `starterMask`, `startRates` and `rosterSigma` through the modal lineup**

In `starterMask`, the per-week body

```js
    for (let w = 0; w < this.NW; w++) {
      for (const i of ids) vals[i] = this.proj[i * this.NW + w];
      const order = ids.slice().sort((a, b) => vals[b] - vals[a]);
      for (const p of seatsOf(order, vals, this.mask, this.starters))
        if (p >= 0) out.get(p)[w] = 1;
    }
```

becomes:

```js
    for (let w = 0; w < this.NW; w++) {
      const use = this._likely(ids, w);
      for (const i of use) vals[i] = this.proj[i * this.NW + w];
      const order = use.slice().sort((a, b) => vals[b] - vals[a]);
      for (const p of seatsOf(order, vals, this.mask, this.starters))
        if (p >= 0) out.get(p)[w] = 1;
    }
```

In `startRates`, the per-week body

```js
      for (let w = 0; w < this.NW; w++) {
        for (const i of ids) vals[i] = this.proj[i * this.NW + w];
        const order = ids.slice().sort((a, b) => vals[b] - vals[a]);
        const seats = seatsOf(order, vals, this.mask, this.starters);
        for (const p of seats) if (p >= 0) count.set(p, count.get(p) + 1);
      }
```

becomes:

```js
      for (let w = 0; w < this.NW; w++) {
        const use = this._likely(ids, w);
        for (const i of use) vals[i] = this.proj[i * this.NW + w];
        const order = use.slice().sort((a, b) => vals[b] - vals[a]);
        const seats = seatsOf(order, vals, this.mask, this.starters);
        for (const p of seats) if (p >= 0) count.set(p, count.get(p) + 1);
      }
```

In `rosterSigma`, the accumulation loop

```js
    for (let w = 0; w < this.NW; w++) {
      let v = 0;
      for (const [i, m] of mask) if (m[w]) v += this.sigmaOf[i] ** 2;
      out[w] = Math.sqrt(v);
    }
```

becomes:

```js
    // A man who may not play contributes his variance in proportion to his chance of
    // playing, so an OUT starter adds none - the spread has to follow availability
    // as well as roster composition, or a shelved team looks as swingy as a whole one.
    const av = this.avail;
    for (let w = 0; w < this.NW; w++) {
      let v = 0;
      for (const [i, m] of mask)
        if (m[w]) v += (av ? av[i * this.NW + w] : 1) * this.sigmaOf[i] ** 2;
      out[w] = Math.sqrt(v);
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node extension/test/availability.mjs`
Expected: `AVAILABILITY OK`, `0 failures`, plus a printed `sampling error at k=7: …%` under 3.00%.

- [ ] **Step 9: Confirm the frozen contract has not moved**

Run: `node extension/test/run-all.mjs`
Expected: `parity.mjs` prints `605 assertions, 0 failures` and `ENGINE OK — reproduces the verified baseline exactly`; overall `0 failing`.

If `parity.mjs` fails, the fast path was changed. Do not regenerate any fixture: re-read Step 6 and restore the `if (!av)` branch to the original code verbatim.

- [ ] **Step 10: Commit**

```bash
git add extension/engine/search.js extension/test/availability.mjs
git commit -m "Solve the lineup for who is actually going to play

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 3: The season simulation starts from the real standings

**Files:**
- Modify: `extension/engine/season.js` (the options destructure; the pre-loop setup; the per-sim initialisation; `games`)
- Modify: `extension/engine/odds.js` (`simOpts`)
- Modify: `extension/test/availability.mjs` (append section 5)

**Interfaces:**
- Consumes: `records: Map<teamName, {wins, losses, ties, pointsFor}> | null` — the shape `loadLeague` now puts on each team as `t.record` (Task 1, Step 5), keyed by team *name* because `projectSeason` works in names.
- Produces:
  - `projectSeason(eng, schedule, settings, { …, records })` — each simulated season starts each team at its real wins (a tie counting half a win, matching how the simulation scores one) and real points-for; `games` in every result row becomes played + remaining.
  - `simOpts` in `odds.js` accepts and forwards `records`, so `tradeOdds` / `attachOdds` compare two worlds that both know the standings.
- Later tasks rely on: Task 5 passes `records` into `attachOdds` and into `render`'s `projectSeason` call.

**The constraint that governs this task.** `odds.js` gets its precision from common random numbers: two runs of `projectSeason` with the same seed see identical noise, so their difference is a paired estimate. That holds only while the *draw order* is untouched. Seeding `wins[i]` and `pf[i]` from a record adds no call to `gauss(rand)` and moves none, so CRN survives — and the test below asserts it.

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/availability.mjs`, immediately before the summary
`console.log` lines:

```js
/* ---- 5. the season starts from the games already played ---- */
{
  const model = mkModel(9);
  const h = restrictToRemaining(model);
  const eng = mkEngine(model);
  const opts = { sims: 4000 };
  const remaining = model.settings.regularSeasonWeeks.length;
  ok(remaining === 6, `six regular-season weeks remain (got ${remaining})`);

  const cold = projectSeason(eng, new Map(), model.settings, opts);
  ok(cold[0].games === remaining, "with no records, games are the remaining weeks");

  // Seed the WEAKEST roster 5-0. A strong one can already be a near-lock for the
  // playoffs at 0-0, which would leave the "a record is worth something" assertion
  // comparing 100% with 100%.
  const total = (t) => F.baseline[t].reduce((a, b) => a + b, 0);
  const t0 = F.teams.slice().sort((a, b) => total(a) - total(b))[0];
  const records = new Map(F.teams.map((t) => [t, { wins: 0, losses: 5, ties: 0, pointsFor: 400 }]));
  records.set(t0, { wins: 5, losses: 0, ties: 0, pointsFor: 700 });
  const warm = projectSeason(eng, new Map(), model.settings, { ...opts, records });
  const row = (res, t) => res.find((r) => r.team === t);

  ok(warm[0].games === 5 + remaining, `games are played + remaining (${warm[0].games})`);
  ok(row(warm, t0).wins >= 5, `a 5-0 team never falls below five wins (${row(warm, t0).wins})`);
  ok(row(warm, t0).wins <= 5 + remaining, "and never exceeds five plus what is left");
  near(row(warm, t0).wins - 5, row(cold, t0).wins, 1e-9,
       "the record is added to, not mixed into, the simulated wins");
  near(row(warm, t0).pointsFor - 700, row(cold, t0).pointsFor, 1e-9,
       "points-for carries the real total forward");
  ok(row(warm, t0).losses <= remaining + 1e-9, "losses count only games that can be lost");
  ok(row(warm, t0).playoffPct > row(cold, t0).playoffPct,
     "5-0 is worth more than 0-0 for a playoff spot");
  near(warm.reduce((s, r) => s + r.titlePct, 0), 1, 1e-9, "still one champion per season");

  // A tie is half a win, exactly as the simulation scores one.
  const tied = new Map([[t0, { wins: 2, losses: 2, ties: 2, pointsFor: 500 }]]);
  const t = projectSeason(eng, new Map(), model.settings, { ...opts, records: tied });
  near(row(t, t0).wins - 3, row(cold, t0).wins, 1e-9, "two ties are one win");
  ok(row(t, t0).games === 6 + remaining, "and both count as games played");

  // Common random numbers must survive: same records, bit-identical output.
  const again = projectSeason(eng, new Map(), model.settings, { ...opts, records });
  ok(JSON.stringify(warm) === JSON.stringify(again), "records keep the draw deterministic");
  const noRec = projectSeason(eng, new Map(), model.settings, { ...opts, records: null });
  ok(JSON.stringify(noRec) === JSON.stringify(cold),
     "records: null is the same run as no records at all");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/availability.mjs`
Expected: FAIL lines for `games are played + remaining` and `a 5-0 team never falls below five wins` (the option is ignored today).

- [ ] **Step 3: Accept the option and precompute the starting point**

In `extension/engine/season.js`, the signature

```js
export function projectSeason(eng, schedule, settings,
    { sims = 20000, sigma = FALLBACK_SIGMA, divisionSeeding = false, divisionOf = null,
      override = null, batches = 1 } = {}) {
```

becomes:

```js
export function projectSeason(eng, schedule, settings,
    { sims = 20000, sigma = FALLBACK_SIGMA, divisionSeeding = false, divisionOf = null,
      override = null, batches = 1, records = null } = {}) {
```

Then, directly after the `const score = new Float64Array(T);` line and before the
`for (let s = 0; s < sims; s++) {` loop, add:

```js
  /**
   * Games already played are decided, so every simulation starts from them.
   *
   * Without this, a mid-season projection is a projection of the weeks that are
   * left, presented as a projection of the season: a 5-0 team is shown fighting for
   * a bye from 0-0, and the playoff odds are wrong for everybody, not only for it.
   * A tie counts half a win, matching how the simulation itself scores one, and no
   * call to gauss(rand) is added or moved - the paired runs in odds.js depend on the
   * draw order being untouched.
   */
  const rec = (t) => records?.get(t) ?? null;
  const startWins = teams.map((t) => {
    const r = rec(t);
    return r ? (r.wins ?? 0) + 0.5 * (r.ties ?? 0) : 0;
  });
  const startPf = teams.map((t) => rec(t)?.pointsFor ?? 0);
  const played = records
    ? teams.reduce((most, t) => {
        const r = rec(t);
        if (!r) return most;
        return Math.max(most, (r.wins ?? 0) + (r.losses ?? 0) + (r.ties ?? 0));
      }, 0)
    : 0;
```

- [ ] **Step 4: Seed each simulation and widen `games`**

Inside the simulation loop, the two initialisations

```js
    const wins = new Float64Array(T);
    const pf = new Float64Array(T);
```

become:

```js
    const wins = new Float64Array(T);
    const pf = new Float64Array(T);
    for (let i = 0; i < T; i++) { wins[i] = startWins[i]; pf[i] = startPf[i]; }
```

And after the loop, the line

```js
  const games = reg.length;
```

becomes:

```js
  const games = played + reg.length;
```

- [ ] **Step 5: Let `odds.js` forward the records**

In `extension/engine/odds.js`, `simOpts`

```js
const simOpts = ({ sims = 5000, batches = 10, divisionSeeding = false, divisionOf = null } = {}) =>
  ({ sims, batches: Math.max(2, batches), divisionSeeding, divisionOf });
```

becomes:

```js
// `records` rides along so that both worlds of a paired run know the standings: a
// trade's change in title odds depends on the record it is being added to.
const simOpts = ({ sims = 5000, batches = 10, divisionSeeding = false, divisionOf = null,
                   records = null } = {}) =>
  ({ sims, batches: Math.max(2, batches), divisionSeeding, divisionOf, records });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node extension/test/availability.mjs`
Expected: `AVAILABILITY OK`, `0 failures`.

- [ ] **Step 7: Run the whole suite**

Run: `node extension/test/run-all.mjs`
Expected: `605 assertions, 0 failures` in `parity.mjs` (it passes no `records`, so
`played` is 0 and `games` is `reg.length` exactly as before); `0 failing` overall.

- [ ] **Step 8: Commit**

```bash
git add extension/engine/season.js extension/engine/odds.js extension/test/availability.mjs
git commit -m "Start each simulated season from the real standings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 4: `panel/availability.js` — every string the UI needs

**Files:**
- Create: `extension/panel/availability.js`
- Modify: `extension/test/availability.mjs` (append section 6)

**Interfaces:**
- Consumes: the `statusOf` / `summary` shapes from `buildAvailability` and the horizon object from `restrictToRemaining` (both Task 1), wrapped by `panel.js` into one context object:
  ```js
  AV = { statusOf: Map<playerId, {status, practice, note, now}>,
         summary: {out, questionable, shelved, uncertain, matched, total},
         horizon: {currentWeek, played, remaining, complete, from, to},
         feed: "sleeper" | "espn" }      // "espn" when the practice feed was dead
  ```
  `panel.js` passes its own `esc` in, so this module never needs the DOM.
- Produces:
  - `AVAIL_HINT: { status: string }` — the column hint, in the voice of `panel.js`'s `HINT`.
  - `statusCode(status: string): string` — `"Q"`, `"D"`, `"OUT"`, `"IR"`, `"PUP"`, `"SUS"`, or `""`.
  - `badgeCode(status: string): string` — the one-or-two-character form for a trade package: `"Q"`, `"D"`, `"O"`, `"IR"`, `"PUP"`, `"SUS"`, or `""`.
  - `statusRank(AV, playerId): number` — 0 available, 1 Questionable, 2 Doubtful, 3 Out, 4 shelved. The roster grid's sort key.
  - `statusCell(AV, playerId, esc): string` — the `<span>` for the Status column, or `""`.
  - `statusBadge(AV, playerId, esc): string` — the badge after a name in a trade package, or `""`.
  - `availabilityLines(summary): string[]` — zero, one or two `say()` lines.
  - `horizonLine(horizon): string` — one `say()` line.
  - `seasonNote(AV): string` — the replacement for the season panel's frozen-rosters sentence.
- Later tasks rely on: Task 5 imports `restrictToRemaining`-derived `horizonLine` / `availabilityLines`; Task 6 imports `AVAIL_HINT`, `statusRank`, `statusCell`, `statusBadge`, `seasonNote`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/availability.mjs`, immediately before the summary
`console.log` lines:

```js
/* ---- 6. the strings the page shows ---- */
{
  const {
    AVAIL_HINT, statusCode, badgeCode, statusRank, statusCell, statusBadge,
    availabilityLines, horizonLine, seasonNote,
  } = await import("../panel/availability.js");
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  ok(statusCode("QUESTIONABLE") === "Q" && statusCode("INJURY_RESERVE") === "IR"
     && statusCode("SUSPENSION") === "SUS" && statusCode("ACTIVE") === "",
     "status codes fit a table cell");
  ok(badgeCode("OUT") === "O" && badgeCode("DOUBTFUL") === "D" && badgeCode("ACTIVE") === "",
     "badge codes fit beside a name");

  const AV = {
    statusOf: new Map([
      [1, { status: "QUESTIONABLE", practice: "LP", note: "Hamstring", now: 0.70 }],
      [2, { status: "OUT", practice: null, note: null, now: 0 }],
      [3, { status: "INJURY_RESERVE", practice: null, note: null, now: 0 }],
      [4, { status: "SUSPENSION", practice: null, note: null, now: 0 }],
    ]),
    summary: { out: 1, questionable: 1, shelved: 2, uncertain: 1, matched: 900, total: 4 },
    horizon: { currentWeek: 9, played: 8, remaining: 10, complete: false, from: 9, to: 18 },
    feed: "sleeper",
  };

  ok(statusRank(AV, 9) === 0 && statusRank(AV, 1) === 1 && statusRank(AV, 2) === 3
     && statusRank(AV, 3) === 4, "the sort rank orders by how bad the news is");
  ok(statusRank(null, 1) === 0, "no availability context ranks everybody available");

  const cell = statusCell(AV, 1, esc);
  ok(cell.includes("Q") && cell.includes("LP"), "a Questionable cell shows the practice report");
  ok(cell.includes("Hamstring"), "and the body part, in the tooltip");
  ok(statusCell(AV, 9, esc) === "", "an available player gets an empty cell");
  ok(statusCell(null, 1, esc) === "", "and so does everybody with no context");
  ok(statusCell(AV, 4, esc).includes("SUS") && /assum/i.test(statusCell(AV, 4, esc)),
     "a suspension says its length is assumed");
  ok(!/</.test(statusCell({ statusOf: new Map([[5, { status: "OUT", practice: "<b>x</b>",
       note: "<img>", now: 0 }]]) }, 5, esc).replace(/<\/?span[^>]*>/g, "")),
     "feed text is escaped");

  ok(statusBadge(AV, 2, esc).includes("O"), "an OUT player is badged in a package");
  ok(statusBadge(AV, 9, esc) === "", "an available one is not");

  const lines = availabilityLines(AV.summary);
  ok(lines.length >= 1 && lines[0].includes("1 out") && lines[0].includes("1 questionable")
     && lines[0].includes("2 on IR"), `the log line names the counts (${lines[0]})`);
  ok(availabilityLines({ out: 0, questionable: 0, shelved: 0, uncertain: 0, matched: 0, total: 0 })
       .length === 1, "a clean league still gets one line saying so");

  const hl = horizonLine(AV.horizon);
  ok(hl.includes("9") && hl.includes("18") && hl.includes("8"),
     `the horizon line names the window and what is behind it (${hl})`);
  ok(horizonLine({ currentWeek: 1, played: 0, remaining: 18, complete: false, from: 1, to: 18 })
       .includes("whole season"), "week one says the whole season");
  ok(horizonLine({ complete: true, played: 0, remaining: 18, from: 1, to: 18, currentWeek: 99 })
       .toLowerCase().includes("complete"), "a finished season says so");

  ok(/injur/i.test(seasonNote(AV)) && /Questionable/.test(seasonNote(AV)),
     "the season note says what is and is not frozen");
  ok(!/no waivers, injuries or trades/.test(seasonNote(AV)),
     "and no longer claims injuries are ignored");
  ok(seasonNote(null).length > 0, "the note works with no context");
  ok(AVAIL_HINT.status.length > 40, "the column has a real hint");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/availability.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `Cannot find module .../panel/availability.js`.

- [ ] **Step 3: Write `extension/panel/availability.js`**

Create the file with exactly this content:

```js
/**
 * How the page says who is playing.
 *
 * Every string lives here rather than in panel.js, so that panel.js's diff for this
 * phase stays four small hunks and the merge with the phases built alongside it is
 * mechanical. Nothing here touches the DOM: panel.js hands in its own escaper and
 * gets HTML strings back.
 */

export const AVAIL_HINT = {
  status: "Whether this player is expected to suit up. Q/D is ESPN's game-status tag "
        + "with Sleeper's practice report beside it (FP full, LP limited, DNP none); "
        + "OUT scores nothing this week; IR, PUP and SUS score nothing for the rest "
        + "of the horizon. A blank cell means nothing is being reported.",
};

const CODE = {
  QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "OUT",
  INJURY_RESERVE: "IR", PUP: "PUP", SUSPENSION: "SUS",
};
const BADGE = {
  QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O",
  INJURY_RESERVE: "IR", PUP: "PUP", SUSPENSION: "SUS",
};
const RANK = {
  QUESTIONABLE: 1, DOUBTFUL: 2, OUT: 3,
  INJURY_RESERVE: 4, PUP: 4, SUSPENSION: 4,
};
const PRACTICE = { FP: "full practice", LP: "limited practice", DNP: "did not practise" };

/** Short code for a resolved status: what fits in a table cell. */
export function statusCode(status) { return CODE[status] ?? ""; }

/** The same, compressed to fit beside a name inside a trade package. */
export function badgeCode(status) { return BADGE[status] ?? ""; }

/** Sort key for the roster grid: worse news sorts higher. */
export function statusRank(av, id) {
  const s = av?.statusOf?.get(id);
  return s ? (RANK[s.status] ?? 0) : 0;
}

/** What the tooltip says. The number is the honest part - the code is shorthand. */
function tip(s) {
  const pct = `${Math.round(s.now * 100)}% chance of playing this week`;
  const bits = [];
  if (s.status === "QUESTIONABLE" || s.status === "DOUBTFUL") {
    bits.push(`${s.status === "DOUBTFUL" ? "Doubtful" : "Questionable"} - ${pct}`);
    if (s.practice && PRACTICE[s.practice]) bits.push(PRACTICE[s.practice]);
  } else if (s.status === "OUT") {
    bits.push("Out this week; assumed back after it");
  } else if (s.status === "SUSPENSION") {
    bits.push("Suspended. Neither feed publishes the length, so this is assumed to "
            + "run to the end of the horizon");
  } else if (s.status === "PUP") {
    bits.push("On the PUP list; scores nothing for the rest of the horizon");
  } else {
    bits.push("On injured reserve; scores nothing for the rest of the horizon");
  }
  if (s.note) bits.push(String(s.note));
  return bits.join(". ");
}

/** The Status cell for the roster grid, or an empty string. */
export function statusCell(av, id, esc) {
  const s = av?.statusOf?.get(id);
  if (!s) return "";
  const code = statusCode(s.status);
  if (!code) return "";
  const prac = s.status === "QUESTIONABLE" && s.practice && PRACTICE[s.practice]
    ? ` · ${s.practice}` : "";
  return `<span class="avail ${s.now > 0 ? "warn" : "gone"}" title="${esc(tip(s))}"`
       + `>${esc(code + prac)}</span>`;
}

/** The badge after a player's name inside a trade package, or an empty string. */
export function statusBadge(av, id, esc) {
  const s = av?.statusOf?.get(id);
  if (!s) return "";
  const code = badgeCode(s.status);
  if (!code) return "";
  return ` <span class="avail sm ${s.now > 0 ? "warn" : "gone"}"`
       + ` title="${esc(tip(s))}">${esc(code)}</span>`;
}

/** One or two lines for the loading log. */
export function availabilityLines(summary) {
  const s = summary ?? { out: 0, questionable: 0, shelved: 0, uncertain: 0, matched: 0 };
  const n = (s.out ?? 0) + (s.questionable ?? 0) + (s.shelved ?? 0);
  if (!n) return ["availability: nobody on a roster is listed with an injury"];
  const lines = [`availability: ${s.out ?? 0} out this week, `
    + `${s.questionable ?? 0} questionable, ${s.shelved ?? 0} on IR or suspended`];
  if (s.uncertain) lines.push(`  ${s.uncertain} lineup${s.uncertain === 1 ? "" : "s"}`
    + ` priced across both outcomes rather than guessed either way`);
  return lines;
}

/** One line for the loading log, naming the window the whole report is about. */
export function horizonLine(h) {
  if (!h) return "horizon: the whole season";
  if (h.complete)
    return "horizon: the season is complete - showing every week, as a retrospective";
  if (!h.played) return `horizon: weeks ${h.from}–${h.to}, the whole season`;
  return `horizon: weeks ${h.from}–${h.to} (${h.played} already played and excluded)`;
}

/** The season panel's "what this is not" sentence. */
export function seasonNote(av) {
  const shelved = av?.summary?.shelved ?? 0;
  return "Rosters are frozen except for current injury status: OUT and IR players "
       + "score nothing, and Questionable ones are weighted by their chance to play. "
       + "No waivers, no trades, and no return dates"
       + (shelved ? ` — the ${shelved} shelved player${shelved === 1 ? "" : "s"} `
                  + "stay out for every remaining week." : ".");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node extension/test/availability.mjs`
Expected: `AVAILABILITY OK`, `0 failures`.

- [ ] **Step 5: Run the whole suite and the syntax check**

Run: `node extension/test/run-all.mjs && node --check extension/panel/availability.js`
Expected: `0 failing`, no output from `node --check`.

- [ ] **Step 6: Commit**

```bash
git add extension/panel/availability.js extension/test/availability.mjs
git commit -m "Add the availability strings the panel shows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 5: `panel.js` — the horizon, the injury feed, and the records

**Files:**
- Modify: `extension/panel.js` (imports; `PHASES`; one block in `start()`; the `oddsOpts` literal)

**Interfaces:**
- Consumes: `restrictToRemaining`, `buildAvailability` from `extension/engine/availability.js`; `loadSleeperPlayers` from `extension/engine/sources/sleeper.js`; `horizonLine`, `availabilityLines` from `extension/panel/availability.js`; `Engine.setAvailability` (Task 2); `records` support in `attachOdds` (Task 3).
- Produces: `window.__avail` (the `AV` context object defined in Task 4) and `window.__records` (`Map<teamName, record> | null`), both set before `render()` is called and both read by `render()` in Task 6.

**No automated test.** The repo has no DOM harness and adding one is out of scope; the strings and the maths this block assembles are covered by Tasks 1–4. The deliverable is verified by `node --check`, by re-running the suite, and by the browser checklist in Step 7 — which a human must run, because no browser is available to the implementer.

- [ ] **Step 1: Add the imports**

The import block at the top of `extension/panel.js` currently ends:

```js
import { shrinkProjections, CALIBRATION_K } from "./engine/calibrate.js";
```

Add three lines after it:

```js
import { shrinkProjections, CALIBRATION_K } from "./engine/calibrate.js";
import { restrictToRemaining, buildAvailability } from "./engine/availability.js";
import { loadSleeperPlayers } from "./engine/sources/sleeper.js";
import { AVAIL_HINT, statusRank, statusCell, statusBadge, seasonNote,
         availabilityLines, horizonLine } from "./panel/availability.js";
```

(`AVAIL_HINT`, `statusRank`, `statusCell`, `statusBadge` and `seasonNote` are used by
Task 6. Importing them now keeps the import hunk to one edit.)

- [ ] **Step 2: Add the loading step**

In `PHASES`, the entry

```js
  ["agents",   "Free-agent pool"],
```

becomes:

```js
  ["agents",   "Free-agent pool"],
  ["injuries", "Injury reports"],
```

- [ ] **Step 3: Trim the horizon, immediately after the league loads**

In `start()`, the line

```js
    Steps.set("rosters", "done", `${model.players.size} players`);
```

is followed by `const s = model.settings;`. Insert the horizon block between them:

```js
    Steps.set("rosters", "done", `${model.players.size} players`);

    // Weeks already played cannot be changed by a trade, and averaging them into a
    // trade's value scores games nobody can affect. Everything downstream reads
    // model.weeks, so trimming it here is the whole fix. Must happen before the
    // settings are read below, and before anything builds the engine.
    const horizon = restrictToRemaining(model);
    say(horizonLine(horizon), horizon.complete ? "err" : "ok");

    const s = model.settings;
```

- [ ] **Step 4: Load the injury reports and attach availability**

The free-agent `try`/`catch` in `start()` ends:

```js
    } catch (e) {
      say(`  free agents unavailable (${e.message})`, "err");
      Steps.set("agents", "warn", "unavailable");
    }
```

Insert the injury block directly after that closing brace, before
`const { slots, starters } = buildSlots(s.lineupSlotCounts);`:

```js
    // Injury reports. ESPN's own injuryStatus rides along with every player record
    // we already fetched; Sleeper adds the practice report, which is the only public
    // signal separating a Questionable who practised in full from one who did not
    // practise at all. Sleeper is CORS-open and keyless, cached for a day by
    // engine/sources/cache.js, and entirely optional: a dead feed costs the practice
    // detail and nothing else.
    let sleeperByEspn = null;
    Steps.set("injuries", "run");
    try {
      const sl = await loadSleeperPlayers();
      sleeperByEspn = sl.byEspn;
      say(`  injury reports for ${sl.byEspn.size} players`
        + `${sl.fromCache ? " (cached)" : ""}${sl.stale ? ", stale" : ""}`, "ok");
      Steps.set("injuries", "done", `${sl.byEspn.size}`);
    } catch (e) {
      say(`  practice reports unavailable (${e.message}) - using ESPN status only`, "err");
      Steps.set("injuries", "warn", "ESPN only");
    }
    const av = buildAvailability(model, sleeperByEspn, model.weeks, s.currentWeek);
    for (const line of availabilityLines(av.summary)) say(line, "ok");
    window.__avail = { statusOf: av.statusOf, summary: av.summary, horizon,
                       feed: sleeperByEspn ? "sleeper" : "espn" };
```

- [ ] **Step 5: Hand the availability to the engine, and the records to the sims**

The line

```js
    const eng = new Engine(model, { starters }, masks);
```

becomes:

```js
    const eng = new Engine(model, { starters }, masks);
    // Only when somebody's availability is actually in doubt: an engine with an
    // all-ones table takes a slower path through weekly() for no benefit, and
    // 2-for-2 calls it millions of times.
    if (av.avail.size) {
      eng.setAvailability(av.avail);
      say(`availability applied to ${av.avail.size} players`, "ok");
    }
    // The standings so far. Every simulated season starts from them rather than 0-0.
    const records = new Map([...model.teams.values()]
      .filter((t) => t.record).map((t) => [t.name, t.record]));
    window.__records = records.size ? records : null;
    if (records.size) say(`standings seeded from ${records.size} team records`, "ok");
```

- [ ] **Step 6: Let the per-trade odds see the standings**

The `oddsOpts` literal

```js
    const oddsOpts = { batches: 10, divisionOf,
      divisionSeeding: divSeedSaved && (model.settings.divisionCount ?? 0) > 1 };
```

becomes:

```js
    const oddsOpts = { batches: 10, divisionOf, records: window.__records,
      divisionSeeding: divSeedSaved && (model.settings.divisionCount ?? 0) > 1 };
```

- [ ] **Step 7: Verify what can be verified here**

Run: `node --check extension/panel.js && node extension/test/run-all.mjs`
Expected: no output from `node --check`; `0 failing`.

Then write this **browser verification pending** checklist into the task report
verbatim — no browser exists in this environment, so it cannot be ticked here:

```
browser verification pending (Task 5)
[ ] chrome://extensions -> reload -> open a league mid-season
[ ] the loading checklist shows "Injury reports" and it ticks green
[ ] the log shows one "horizon: weeks A-B (N already played and excluded)" line
[ ] the log shows one "availability: N out this week, M questionable, K on IR or suspended" line
[ ] the log shows "injury reports for ~11000 players" on the first run and
    "(cached)" on a reload within the day
[ ] block the Sleeper host in devtools and reload: the step goes amber with
    "ESPN only", the log says "practice reports unavailable", and the report
    still finishes
[ ] the season panel's regular-season week count is the remaining count, not 14
[ ] the projected-season Record column shows fractional wins ABOVE the team's
    real win total (a 5-0 team never shows fewer than 5.0)
[ ] a league in week 1 behaves exactly as before: "the whole season", 14 weeks
```

- [ ] **Step 8: Commit**

```bash
git add extension/panel.js
git commit -m "Load injury reports and score only the weeks that remain

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 6: `panel.js` — the Status column, the package badges, the note

**Files:**
- Modify: `extension/panel.js` (`render()`: one context line, `pkg`, the roster grid's columns and row, the `projectSeason` call, the season note)
- Modify: `extension/panel.css` (append the `.avail` block)

**Interfaces:**
- Consumes: `window.__avail` and `window.__records` from Task 5; `AVAIL_HINT`, `statusRank`, `statusCell`, `statusBadge`, `seasonNote` from Task 4 (already imported in Task 5, Step 1).
- Produces: no new exports. `render()` stays re-entrant — it is called again by `rerender` on every filter change, and it reads the context from `window`, so nothing is captured at load time.

**No automated test**, for the reason given in Task 5. The checklist in Step 7 is the deliverable's verification and must be reproduced in the task report.

- [ ] **Step 1: Read the context at the top of `render()`**

The opening of `render()`

```js
function render(eng, model, trades, myTeam, schedule = window.__schedule ?? new Map()) {
  const W = eng.weeks;
  const rates = eng.startRates();
```

becomes:

```js
function render(eng, model, trades, myTeam, schedule = window.__schedule ?? new Map()) {
  const W = eng.weeks;
  const AV = window.__avail ?? null;
  const rates = eng.startRates();
```

- [ ] **Step 2: Badge the players inside a trade package**

The line

```js
  const pkg = (ids) => ids.map((i) => `${esc(nm(i))} ${tag(i)}`).join('<span class="plus">+</span>');
```

becomes:

```js
  // A package that hands you a man on IR has to say so where the names are, not
  // three sections further down.
  const pkg = (ids) => ids
    .map((i) => `${esc(nm(i))} ${tag(i)}${statusBadge(AV, eng.ids[i], esc)}`)
    .join('<span class="plus">+</span>');
```

- [ ] **Step 3: Add the Status column to the roster grid**

The column list

```js
  const rosterGrid = grid("rosterGrid", [
    { key: "name", label: "Player", value: (r) => r.p.name },
    { key: "pos", label: "Pos", value: (r) => r.p.pos },
    { key: "nfl", label: "NFL", value: (r) => r.p.nfl },
    { key: "bye", label: "Bye", num: true, value: (r) => r.p.bye || 99, hint: HINT.bye },
```

becomes:

```js
  const rosterGrid = grid("rosterGrid", [
    { key: "name", label: "Player", value: (r) => r.p.name },
    { key: "pos", label: "Pos", value: (r) => r.p.pos },
    { key: "nfl", label: "NFL", value: (r) => r.p.nfl },
    { key: "status", label: "Status", num: true,
      value: (r) => statusRank(AV, r.p.id), hint: AVAIL_HINT.status },
    { key: "bye", label: "Bye", num: true, value: (r) => r.p.bye || 99, hint: HINT.bye },
```

and the matching row template

```js
    row: (r) => `<tr>
      <td style="font-weight:600">${esc(r.p.name)}</td>
      <td>${tag(r.i)}</td>
      <td class="nfl">${esc(r.p.nfl)}</td>
      <td class="num" style="color:var(--faint)">${r.p.bye || "—"}</td>
```

becomes:

```js
    row: (r) => `<tr>
      <td style="font-weight:600">${esc(r.p.name)}</td>
      <td>${tag(r.i)}</td>
      <td class="nfl">${esc(r.p.nfl)}</td>
      <td class="num">${statusCell(AV, r.p.id, esc)}</td>
      <td class="num" style="color:var(--faint)">${r.p.bye || "—"}</td>
```

- [ ] **Step 4: Let the on-page season projection see the standings**

The call

```js
  const proj = projectSeason(eng, schedule, model.settings,
    { sims: SIMS, sigma: SIGMA, divisionSeeding: divSeed, divisionOf });
```

becomes:

```js
  const proj = projectSeason(eng, schedule, model.settings,
    { sims: SIMS, sigma: SIGMA, divisionSeeding: divSeed, divisionOf,
      records: window.__records ?? null });
```

- [ ] **Step 5: Replace the frozen-rosters sentence**

The note

```js
        <div class="note"><b>What this is not.</b> Rosters are frozen: no waivers,
          injuries or trades. ${measured >= 20
```

becomes:

```js
        <div class="note"><b>What this is not.</b> ${seasonNote(AV)} ${measured >= 20
```

- [ ] **Step 6: Style the badge**

Append to `extension/panel.css`:

```css
/* availability badges: roster Status cell and trade-package flags */
.avail{display:inline-block;font-family:var(--mono);font-size:10px;font-weight:700;
  letter-spacing:.06em;padding:2px 5px;border-radius:3px;border:1px solid transparent;
  cursor:help;white-space:nowrap}
.avail.warn{background:var(--danger-soft);color:var(--danger);
  border-color:rgba(255,111,111,.32)}
.avail.gone{background:var(--raised);color:var(--faint);border-color:var(--line-hi)}
.avail.sm{font-size:9px;padding:1px 4px;margin-left:2px;vertical-align:1px}
```

- [ ] **Step 7: Verify what can be verified here**

Run: `node --check extension/panel.js && node extension/test/run-all.mjs`
Expected: no output from `node --check`; `0 failing`.

Reproduce this **browser verification pending** checklist in the task report verbatim:

```
browser verification pending (Task 6)
[ ] chrome://extensions -> reload -> open a league mid-season
[ ] "Your roster" has a Status column between NFL and Bye
[ ] a Questionable player reads "Q · LP" and a hover explains the percentage
[ ] an IR player reads "IR", a suspended one "SUS" with the assumed-length note
[ ] a healthy player's Status cell is blank, not a dash or a zero
[ ] clicking the Status header sorts the worst news to the top and back
[ ] a trade package containing an injured player shows a small badge after his name
[ ] the badge survives a filter change (render is re-entrant)
[ ] the season panel's "What this is not" note names injury status
[ ] both light and dark theme: the badge is legible against .panel and .raised
[ ] a league with nobody injured shows no badges and an unchanged roster grid
```

- [ ] **Step 8: Commit**

```bash
git add extension/panel.js extension/panel.css
git commit -m "Show who is playing on the roster and in every package

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 7: Record the decisions in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (the Commands block, the architecture map, three new load-bearing decisions, the Testing paragraph)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing executable. This task exists because the next person to touch `weekly()` will otherwise reintroduce the bug the comment in Task 2 argues against.

- [ ] **Step 1: Fix the Commands block**

```bash
node extension/test/run-all.mjs     # the whole test suite, ~4s
```

replaces

```bash
node extension/test/parity.mjs     # the whole test suite, ~2s
```

- [ ] **Step 2: Update the architecture map**

The `engine/` and `test/` portion of the map becomes:

```
  engine/
    league.js        ESPN API -> normalized model; settings; volatility; injury status
    lineup.js        optimal lineup for any slot configuration
    swaps.js         precomputed (out, in) values
    search.js        shapes, N-sided trades, three-way, free agents
    season.js        Monte Carlo season projection
    availability.js  injury status -> play probability; the remaining-weeks horizon
    winprob.js       normal CDF, P(win), per-week leverage
    calibrate.js     positional shrinkage of ESPN projections
    odds.js          paired season sims: a trade's change in playoff/bye/title odds
    sources/
      cache.js       TTL-cached fetch for external feeds, storage-injectable
      sleeper.js     Sleeper players, trending, NFL state
  panel/
    availability.js  status codes, cells, badges, log lines, the season note
  test/
    parity.mjs       605 assertions against a frozen league — the engine contract
    availability.mjs availability, the horizon, record-seeded seasons, UI strings
    sources.mjs      cache semantics and the Sleeper client, offline
    run-all.mjs      runs every *.mjs in the directory
```

- [ ] **Step 3: Add the three load-bearing decisions**

Insert after the "Time windows stay separate" paragraph:

```
**Availability lives inside `weekly`, and it enumerates.** Optimal lineup value is a
max over assignments, so it is convex in the projections and not linear in
availability: `E[L]` is not `L(E[proj])`. Two players at 50% are not one certain
starter — a bench absorbs one absence far better than two — so blending a probability
into a projection understates the damage. `weekly` splits each week into certain and
uncertain players, enumerates the `2^k` outcomes for `k ≤ 6` and weights them, and
falls back to 64 fixed-seed draws above that. Only the current week can hold
uncertain players, so the cost is confined to one week per solve. Two rules protect
it: when no availability is attached the function takes the original path
character-for-character, because 2-for-2 calls it millions of times and the golden
set depends on it; and an unavailable player is *removed from the pool*, never valued
at zero — `bestLineup` seats players in the order it is given and never unseats one,
so a zeroed star still takes a seat and blocks the man who would have started.
`starterMask`, `startRates` and `explain` show the *modal* lineup (everyone at
`p ≥ 0.5`) instead, because a usage strip has to name actual players.

**The horizon is the weeks that remain.** `restrictToRemaining` trims `model.weeks`
and the settings week arrays to `w >= settings.currentWeek` before the engine is
built. A trade proposed in week nine used to be scored partly on eight weeks nobody
could change, which is not a small distortion: a deal that is mildly positive across
a whole season is often strongly positive across the part of it that is left, and
occasionally the reverse. A season already over keeps every week and says so.

**Records seed the season simulation.** `projectSeason` takes
`records: Map<team, {wins, losses, ties, pointsFor}>` from ESPN's `t.record.overall`
and starts every simulated season there rather than at 0-0, counting a tie as half a
win exactly as the simulation scores one; `games` becomes played + remaining. Adding
a starting value adds no call to `gauss(rand)` and moves none, so the common random
numbers `odds.js` depends on are unaffected — keep it that way.
```

- [ ] **Step 4: Update the Testing paragraph**

The Testing section keeps its first paragraph and gains a second:

```
`parity.mjs` is the contract and is never edited by a feature branch. Everything a
new phase adds goes in its own `extension/test/<name>.mjs` using the `ok()` pattern,
and `run-all.mjs` runs them all. Phase 2's file also asserts the contract from the
other side: an engine given an all-ones availability table must reproduce
`fixture.json`'s baseline exactly.
```

- [ ] **Step 5: Verify**

Run: `node extension/test/run-all.mjs && node --check extension/panel.js`
Expected: `0 failing`; no output from `node --check`. Confirm the assertion count
written into the map matches what `parity.mjs` actually printed.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "Record how availability and the horizon work

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

## Self-review

**Spec coverage.**

| Spec item | Task |
|---|---|
| H1 — ESPN `injuryStatus` / `injured` on rostered players and free agents | 1 (Step 5) |
| H1 — per-team `record` from `t.record.overall` | 1 (Step 5) |
| H1 — Sleeper players loaded as their own step "Injury reports", degrading to ESPN | 5 (Steps 2, 4) |
| B1 — `playProb(status, practice, weekIndexOffset)` and the whole table | 1 |
| B1 — `PLAY_PROB` as one replaceable exported table | 1 |
| B1 — Sleeper used only when ESPN says ACTIVE | 1 |
| B1 — `buildAvailability(model, sleeperByEspn, weeks, currentWeek)` | 1 |
| B1 — `Engine.setAvailability`, default 1 | 2 |
| B1 — certain/uncertain split, `2^k` enumeration to `k = 6`, 64 fixed-seed draws above | 2 |
| B1 — `starterMask` / `explain` use the most likely outcome, noted in a comment | 2 |
| B1 — `rosterSigma` treats variance as `p·σ²` | 2 |
| Horizon — `restrictToRemaining`, settings arrays filtered, season-over case | 1 (code + tests), 5 (call site) |
| Horizon — `projectSeason` gains `records`; `games` = played + remaining | 3 |
| Horizon — `panel.js` passes `records` | 5 (odds), 6 (render) |
| Fingerprint unchanged | untouched by every task; `rosterFingerprint` and `rosterHash` are not edited |
| UI — roster grid Status column with a hint | 4, 6 |
| UI — package badges | 4, 6 |
| UI — availability and horizon log lines | 4, 5 |
| UI — season panel note replaced | 4, 6 |
| Tests — `playProb` table, Sleeper override | 1 |
| Tests — `restrictToRemaining` including season-over | 1 |
| Tests — OUT starter equals the roster without him | 2 |
| Tests — Q at 0.71 equals the weighted mean to 1e-9 | 2 |
| Tests — `k = 7` deterministic and within 3% of the enumerated `k = 6` case | 2 |
| Tests — all-ones engine reproduces `F.baseline` | 2 |
| Tests — 5-0 team's simulated wins bounded below by 5 and above by 5 + remaining | 3 |

**Placeholder scan.** No `TBD`, no "add error handling", no "similar to Task N", no
step without its code. The only steps without an automated test are Tasks 5 and 6,
which say so explicitly and carry written browser checklists instead — the same
deliberate gap Phase 1's plan recorded.

**Type consistency.**
- `avail` is `Map<playerId, Float64Array(weeks.length)>` from `buildAvailability` (Task 1) and consumed with that exact shape by `setAvailability` (Task 2) and by the test's hand-built maps.
- `statusOf` entries are `{status, practice, note, now}` — produced in Task 1, consumed by `statusRank` / `statusCell` / `statusBadge` in Task 4, wrapped as `AV.statusOf` in Task 5, read in Task 6.
- `summary` is `{out, questionable, shelved, uncertain, matched, total}` — Task 1 produces it, `availabilityLines` (Task 4) and `seasonNote` (Task 4) read it.
- the horizon object is `{currentWeek, played, remaining, complete, weeks, from, to}` — Task 1 produces it, `horizonLine` (Task 4) reads `complete`, `played`, `from`, `to`.
- `records` is `Map<teamName, {wins, losses, ties, pointsFor}>` — Task 1 puts that shape on `t.record`, Task 5 keys it by name, Task 3 reads exactly those four fields in `projectSeason` and forwards it through `simOpts`.
- `mulberry32` is defined in `availability.js` (Task 1) and imported by `search.js` (Task 2). `season.js` keeps its own copy untouched, and Task 1's comment says why.
- `Engine.ids[i]` maps an engine index to a player id; Task 6 uses it in `pkg` (which receives engine indices) while the roster grid uses `r.p.id` (already a player id). These are not interchangeable — do not swap them.

**Known risks, recorded rather than designed away.**
- Sleeper's `espn_id` coverage is thin for rookies and D/ST. Those players fall back to ESPN status, which is the correct degradation and is what the `!sl` path does.
- A roster with six genuinely uncertain players in the current week costs 64 lineup solves for that one week — roughly a `(NW - 1 + 64) / NW` multiplier on 2-for-2. On a ten-week horizon that is about 7×, and 2-for-2 is already the slowest step. It is bounded and it only bites in the rare week when half a roster is Questionable; if it becomes a real complaint, the fix is to lower `ENUM_MAX`, not to blend probabilities into projections. Task 2's test prints the sampled branch's error so the trade-off stays visible.
- `restrictToRemaining` shortens the settings week arrays, so the loading log's
  "regular season N wks" line now reports what is left rather than the league's
  length. Task 5 adds the horizon line immediately above it so the two read together.
