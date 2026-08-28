/**
 * Tests for roster construction: replacement level, the 2-for-1 shape, drop ranking.
 *
 * `parity.mjs` is the engine's frozen contract and is never touched; this file
 * carries everything Phase 4 added. The model is built the way parity.mjs builds it -
 * deliberately copied rather than imported, so a change here can never move the
 * golden set.
 *
 * The fixture rosters all 160 of its players, so it has no waiver wire at all. One is
 * synthesised: twenty clones taken every fifth player down the projection ranking
 * starting at rank 50, each scaled to 85% of the man he was cloned from. That puts
 * them where a real waiver wire sits - below every starter, above the worst bench -
 * so the pool has something to choose between and no synthetic free agent outranks
 * the player he came from.
 *
 *   node extension/test/roster.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { Engine, dedupe } from "../engine/search.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));
const { slots, starters } = buildSlots(F.lineupSlotCounts);

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const near = (a, b, eps, what) => ok(Math.abs(a - b) < eps, `${what} (${a} vs ${b})`);

/* ---- the synthesised waiver wire ---- */
const meanOf = (r) => r.reduce((a, b) => a + b, 0) / r.length;
const byMean = F.pos.map((_, i) => i).sort((a, b) => meanOf(F.proj[b]) - meanOf(F.proj[a]));
const FA_SRC = [];
for (let k = 50; FA_SRC.length < 20 && k < byMean.length; k += 5) FA_SRC.push(byMean[k]);
const POS = F.pos.slice(), PROJ = F.proj.map((r) => r.slice());
for (const s of FA_SRC) { POS.push(F.pos[s]); PROJ.push(F.proj[s].map((x) => x * 0.85)); }
const FA_IDS = FA_SRC.map((_, k) => F.pos.length + k);
const MASKS = POS.map((p) => seatMask(F.eligibleSlots[p], slots));
const POS_ID = Object.fromEntries([...new Set(F.pos)].map((p, i) => [p, i + 1]));

/**
 * A model over `teamNames`, holding exactly those teams' players plus the synthetic
 * free agents. Sub-leagues matter: `Engine.freeAgents` is "owned by nobody", so a
 * two-team model built from the whole player list would treat the other eight teams'
 * stars as waiver fodder.
 */
function mkModel(teamNames = F.teams, limits = null) {
  const keep = new Set(FA_IDS);
  for (const t of teamNames) for (const i of F.rosters[t]) keep.add(i);
  const ids = [...keep].sort((a, b) => a - b);
  return {
    weeks: F.weeks.slice(),
    settings: {
      currentWeek: 1,
      regularSeasonWeeks: F.weeks.filter((w) => w <= 14),
      playoffWeeks: [15, 16, 17],
      playoffRoundWeeks: [[15], [16], [17]],
      playoffTeams: 6,
      playoffReseed: true,
      lineupSlotCounts: F.lineupSlotCounts,
      ...(limits ? { positionLimits: limits } : {}),
    },
    players: new Map(ids.map((i) => [i, {
      id: i, name: `p${i}`, pos: POS[i], nfl: "X", posId: POS_ID[POS[i]],
      eligibleSlots: F.eligibleSlots[POS[i]],
      bye: F.weeks.find((w) => !(PROJ[i][F.weeks.indexOf(w)] > 0)) ?? 0,
      proj: Object.fromEntries(F.weeks.map((w, k) => [w, PROJ[i][k]])),
    }])),
    teams: new Map(teamNames.map((n, ti) => [ti, { id: ti, name: n, roster: new Set(F.rosters[n]) }])),
  };
}
const mkEng = (m) =>
  new Engine(m, { starters }, new Map([...m.players.keys()].map((i) => [i, MASKS[i]])));

/** mean weekly optimal lineup, computed here rather than borrowed from the engine */
const wm = (e, ids) => {
  const a = e.weekly(ids, new Float64Array(e.NW));
  let s = 0; for (let w = 0; w < e.NW; w++) s += a[w];
  return s / e.NW;
};

const eng = mkEng(mkModel());          // all ten teams; index === id here

/* ---- 1. the backfill pool ---- */
{
  const pool = eng.backfillPool();
  const masksSeen = new Set(eng.freeAgents.map((i) => eng.mask[i]));
  ok(eng.freeAgents.length === 20, `twenty free agents (${eng.freeAgents.length})`);
  ok(pool.length <= 3 * masksSeen.size, `pool ${pool.length} <= 3 x ${masksSeen.size} masks`);
  ok(pool.length === 14, `pool is 14 on this fixture (${pool.length})`);
  ok(pool.every((i) => eng.mask[i] !== 0), "every pool member can take some seat");
  ok(pool.every((i) => eng.freeAgents.includes(i)), "every pool member is a free agent");
  ok(new Set(pool).size === pool.length, "no duplicates");
  ok(eng.backfillPool() === pool, "the pool is cached, not rebuilt");
  // structural: each mask contributes exactly its own top three
  let perMask = true;
  for (const m of masksSeen) {
    const inMask = eng.freeAgents.filter((i) => eng.mask[i] === m)
      .sort((a, b) => eng._rankVal()[b] - eng._rankVal()[a]);
    const chosen = pool.filter((i) => eng.mask[i] === m).slice().sort((a, b) => a - b);
    const want = inMask.slice(0, 3).sort((a, b) => a - b);
    if (JSON.stringify(chosen) !== JSON.stringify(want)) perMask = false;
  }
  ok(perMask, "each seat mask contributes its top three by rank value");
  // the pool is bucketed by MASK, not by position string
  ok(new Set(pool.map((i) => eng.mask[i])).size === masksSeen.size,
     "every mask present among the free agents is represented");
}

/* ---- 2. backfill is exact within the pool ---- */
{
  let bad = 0, grew = 0;
  for (const t of eng.teams) {
    const ids = eng.roster.get(t);
    for (const sample of [ids, ids.slice(0, 14), ids.slice(0, 10)]) {
      const got = eng.backfill(sample);
      const base = wm(eng, sample);
      let bestV = -Infinity;
      for (const c of eng.backfillPool()) {
        if (sample.includes(c)) continue;
        if (!eng.legal(sample.concat([c]))) continue;
        bestV = Math.max(bestV, wm(eng, sample.concat([c])));
      }
      if (Math.abs(got.gain - (bestV - base)) > 1e-9) bad++;
      if (got.ids.length !== sample.length + 1) grew++;
    }
    if (eng.backfill(ids).gain < -1e-12) bad++;
  }
  ok(bad === 0, `backfill matches a whole-pool brute force on 30 rosters (${bad} bad)`);
  ok(grew === 0, "backfill grows the roster by exactly one");
  near(eng.backfill(eng.roster.get(F.teams[0])).gain, 0.2929, 5e-4, "Team A backfill gain");
  ok(eng.teams.every((t) => eng.backfill(eng.roster.get(t)).gain >= 0),
     "adding a player never lowers the optimal lineup");
  ok(eng.teams.every((t) => eng.backfill(eng.roster.get(t)).fa !== null),
     "with a non-empty pool the seat is always filled");
}

/* ---- 3. trim is exact, and honours legality and `exclude` ---- */
{
  let bad = 0, shrank = 0, zero = 0, costly = 0;
  for (const t of eng.teams) {
    const ids = eng.roster.get(t);
    const got = eng.trim(ids);
    let bestV = -Infinity;
    for (const d of ids) {
      const after = ids.filter((z) => z !== d);
      if (!eng.legal(after)) continue;
      bestV = Math.max(bestV, wm(eng, after));
    }
    if (Math.abs(got.cost - (wm(eng, ids) - bestV)) > 1e-9) bad++;
    if (got.ids.length !== ids.length - 1) shrank++;
    if (got.cost < 1e-12) zero++; else costly++;
    if (got.cost < -1e-12) bad++;
  }
  ok(bad === 0, `trim matches a brute force on cost for all ten teams (${bad} bad)`);
  ok(shrank === 0, "trim shrinks the roster by exactly one");
  ok(zero === 8 && costly === 2,
     `eight teams have a free drop, two do not (${zero}/${costly})`);
  const t0 = F.teams[0];
  const ex = eng.roster.get(t0).slice(0, 3);
  ok(!ex.includes(eng.trim(eng.roster.get(t0), ex).drop), "exclude keeps players off the drop list");
  ok(eng.trim(eng.roster.get(t0), eng.roster.get(t0)).drop === null,
     "excluding everybody drops nobody rather than throwing");
  // the early exit is an early exit from an exhaustive scan, not a different answer
  const withBase = eng.trim(eng.roster.get(t0), null, wm(eng, eng.roster.get(t0)));
  near(withBase.cost, eng.trim(eng.roster.get(t0)).cost, 1e-12,
       "passing a precomputed base changes nothing");
}

/* ---- 4. positionLimits binds both primitives ---- */
{
  const t0 = F.teams[0];
  const teCount = F.rosters[t0].filter((i) => F.pos[i] === "TE").length;
  const capped = mkEng(mkModel(F.teams, { [POS_ID.TE]: teCount }));
  const free = mkEng(mkModel());
  const a = free.backfill(free.roster.get(t0));
  const b = capped.backfill(capped.roster.get(t0));
  ok(capped.legal(capped.roster.get(t0)), "a roster at the cap is legal");
  ok(POS[a.fa] === "TE" && POS[b.fa] !== "TE", "the cap pushes the pick off the capped position");
  ok(a.fa !== b.fa, "the cap changes which free agent is added");
  ok(capped.legal(b.ids), "backfill never returns a roster ESPN would refuse");
  ok(b.gain <= a.gain + 1e-12, "a constrained pick is never worth more than a free one");
  near(a.gain, 0.2929, 5e-4, "uncapped gain");
  near(b.gain, 0.1962, 5e-4, "capped gain");
  ok(capped.backfillPool().filter((i) => POS[i] === "TE").length > 0,
     "the pool still holds the capped position - the cap binds at add time, not at pool time");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("ROSTER OK");
