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
  mulberry32,
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
  ok(ho.played === NW && ho.remaining === 0,
     `a finished season has played every week and none remain (${ho.played}/${ho.remaining})`);
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
    // 3% is where 64 draws happen to land on this fixture with this seed. Retune it
    // if SAMPLES, the seed or the fixture moves; a change here is not a regression.
    ok(Math.abs(a - exact) / exact < 0.03,
       `64 draws land within 3% of the enumerated value (${a} vs ${exact})`);
    console.log(`  sampling error at k=7: ${(100 * Math.abs(a - exact) / exact).toFixed(2)}%`);
  }

  /* the ENUM_MAX boundary: six uncertain players are exact, seven are not */
  {
    // Hand-enumeration of the 2^k outcomes, weighted, built from the plain engine so
    // that it shares no code with weekly()'s own loop. Bit set means the man plays.
    const handEnum = (who, p) => {
      let total = 0;
      for (let m = 0; m < (1 << who.length); m++) {
        let wt = 1;
        const drop = [];
        for (let j = 0; j < who.length; j++) {
          if ((m >> j) & 1) wt *= p; else { wt *= 1 - p; drop.push(who[j]); }
        }
        total += wt * base.weekly(roster.filter((i) => !drop.includes(i)))[0];
      }
      return total;
    };
    const P = 0.4;
    const uncertain = (n) => withAvail((m) => {
      for (const i of byProj.slice(0, n)) m.get(idOf(i))[0] = P;
    }).weekly(roster)[0];

    near(uncertain(6), handEnum(byProj.slice(0, 6), P), 1e-9,
         "k = 6 is the exact expectation over all 64 outcomes");
    // The half that pins the boundary: were ENUM_MAX 7, this would match exactly.
    const got7 = uncertain(7), exact7 = handEnum(byProj.slice(0, 7), P);
    ok(Math.abs(got7 - exact7) > 1e-9,
       `k = 7 falls through to sampling and does not (${got7} vs ${exact7})`);
    console.log(`  k=7 sampling gap: ${(100 * Math.abs(got7 - exact7) / exact7).toFixed(2)}%`);
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

  // Drift guard for the deliberate duplication of mulberry32 in season.js: the five
  // expected values were produced by running season.js's own copy with its own seed.
  {
    const r = mulberry32(0x5EED);
    const want = [0.7100320369936526, 0.286336648510769, 0.9519026265479624,
                  0.10175976227037609, 0.3784139291383326];
    ok(want.every((v) => r() === v), "mulberry32 has not drifted from season.js's copy");
  }
}

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
    applied: true,
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
  ok(/2 shelved/.test(seasonNote(AV)), "and names the players out for the horizon");
  // The other branch: a finished season, or a league with nobody hurt, priced no
  // availability at all, so the note must not describe arithmetic that never ran.
  ok(/frozen/.test(seasonNote({ ...AV, applied: false }))
     && !/Questionable/.test(seasonNote({ ...AV, applied: false })),
     "an unapplied table gets the frozen-roster sentence instead");
  ok(seasonNote({ ...AV, applied: undefined }) === seasonNote({ ...AV, applied: false }),
     "an absent flag reads as not applied");
  ok(seasonNote(null).length > 0, "the note works with no context");
  ok(seasonNote(null) === seasonNote({ ...AV, applied: false }),
     "and says the same thing render() says before start() finishes");
  ok(AVAIL_HINT.status.length > 40, "the column has a real hint");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("AVAILABILITY OK");
