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
