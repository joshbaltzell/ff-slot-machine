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

/* ---- 5. drop candidates ---- */
{
  const t0 = F.teams[0];
  const dc = eng.dropCandidates(t0);
  const rates = eng.startRates();
  ok(dc.length === eng.roster.get(t0).length, "one row per rostered player");
  ok(dc.every((r, k) => k === 0 || dc[k - 1].cost <= r.cost + 1e-12), "ascending by cost");
  ok(dc.every((r) => r.cost >= -1e-12), "a drop never costs less than nothing");
  ok(dc.filter((r) => (rates.get(r.i) ?? 0) === 0).every((r) => r.cost < 1e-12),
     "a player who never starts costs nothing to drop");
  ok(dc.filter((r) => r.cost < 1e-12).length === 1, "exactly one free drop on Team A");
  near(dc[0].cost, 0, 1e-12, "the first row is the free one");
  near(dc[0].addGain, 0.2929, 5e-4, "and names what the wire would put in his place");
  near(dc[0].net, dc[0].addGain - dc[0].cost, 1e-12, "net is add minus cost");
  ok(dc.every((r) => r.add === null || eng.backfillPool().includes(r.add)),
     "the best add always comes from the pool");
  // cost is measured against the same baseline sideMetrics uses
  const worst = dc.at(-1);
  const without = eng.roster.get(t0).filter((x) => x !== worst.i);
  near(worst.cost, wm(eng, eng.roster.get(t0)) - wm(eng, without), 1e-9,
       "cost equals the drop in the mean optimal lineup");
  ok(dc.every((r) => Number.isFinite(r.reg) && Number.isFinite(r.playoff)),
     "the reg and playoff windows are computed too");
}

/* ---- 6. findTwoForOne is exactly a brute force, on a two-team sub-league ---- */
{
  const D = F.teams[3], J = F.teams[9];
  const sub = mkEng(mkModel([D, J]));
  ok(sub.freeAgents.length === 20, "a sub-league keeps its own waiver wire only");

  let pairsSeen = 0;
  const res = await sub.findTwoForOne(0.05, () => pairsSeen++);
  ok(pairsSeen === 2, `progress fires once per ordered pair (${pairsSeen})`);

  // brute force: no bounds anywhere, full pool scan, full removal scan
  const brute = new Map();
  for (const A of sub.teams) for (const B of sub.teams) {
    if (A === B) continue;
    const ra = sub.roster.get(A), rb = sub.roster.get(B);
    for (let x = 0; x < ra.length; x++) for (let y = x + 1; y < ra.length; y++) {
      const two = [ra[x], ra[y]];
      const kept = ra.filter((i) => i !== two[0] && i !== two[1]);
      for (const one of rb) {
        const withOne = kept.concat([one]);
        let addIds = withOne, av = -Infinity;
        for (const c of sub.backfillPool()) {
          if (withOne.includes(c)) continue;
          const after = withOne.concat([c]);
          if (!sub.legal(after)) continue;
          const v = wm(sub, after);
          if (v > av) { av = v; addIds = after; }
        }
        const ga = sub._metrics(A, addIds).gain;
        if (ga < 0.05) continue;
        const recv = rb.filter((i) => i !== one).concat(two);
        let cutIds = null, tv = -Infinity;
        for (const d of recv) {
          if (two.includes(d)) continue;
          const after = recv.filter((z) => z !== d);
          if (!sub.legal(after)) continue;
          const v = wm(sub, after);
          if (v > tv) { tv = v; cutIds = after; }
        }
        const gb = sub._metrics(B, cutIds).gain;
        if (gb < 0.05) continue;
        brute.set(`${A}>${B}|${two[0]},${two[1]}|${one}`, [ga, gb]);
      }
    }
  }
  const got = new Map(res.map((t) => [
    `${t.sides[0].team}>${t.sides[1].team}|${t.sides[0].sent[0]},${t.sides[0].sent[1]}|${t.sides[0].received[0]}`,
    [t.sides[0].gain, t.sides[1].gain]]));
  let miss = 0, extra = 0, mism = 0;
  for (const [k, v] of brute) {
    const p = got.get(k);
    if (!p) { miss++; continue; }
    if (Math.abs(p[0] - v[0]) > 1e-9 || Math.abs(p[1] - v[1]) > 1e-9) mism++;
  }
  for (const k of got.keys()) if (!brute.has(k)) extra++;
  ok(brute.size === 829, `the brute force finds 829 trades (${brute.size})`);
  ok(res.length === brute.size, `the search finds the same number (${res.length})`);
  ok(miss === 0, `the pruning drops nothing (${miss} missing)`);
  ok(extra === 0, `the pruning invents nothing (${extra} extra)`);
  ok(mism === 0, `every gain matches to 1e-9 (${mism} mismatched)`);

  /* invariants */
  ok(res.every((t) => t.shape === "2-for-1"), "every trade is labelled 2-for-1");
  ok(res.every((t) => t.sides.length === 2), "two sides");
  ok(res.every((t) => t.sides.every((s) => s.gain >= 0.05)), "every side clears minGain exactly");
  ok(res.every((t) => t.sides[0].sent.length === 2 && t.sides[0].received.length === 1),
     "the consolidating side sends two and receives one");
  ok(res.every((t) => t.sides[1].sent.length === 1 && t.sides[1].received.length === 2),
     "the other side is its mirror");
  ok(res.every((t) => t.sides.every((s) => s.final.length === 16)),
     "both rosters end the trade the size they started");
  ok(res.every((t) => t.sides[0].backfill !== null && t.sides[0].drop === null),
     "only the consolidating side adds from waivers");
  ok(res.every((t) => t.sides[1].drop !== null && t.sides[1].backfill === null),
     "only the receiving side drops");
  ok(res.every((t) => !t.sides[0].sent.includes(t.sides[1].drop)),
     "nobody drops a player he just traded for");
  ok(res.every((t) => sub.legal(t.sides[0].final) && sub.legal(t.sides[1].final)),
     "both final rosters are legal");
  ok(res.every((t) => t.sides[0].final.includes(t.sides[0].backfill)),
     "the named backfill is on the final roster");
  ok(res.every((t) => !t.sides[1].final.includes(t.sides[1].drop)),
     "the named drop is not");
  ok(res.every((t, k) => k === 0 || res[k - 1].total >= t.total - 1e-12),
     "sorted by combined gain");
  ok(dedupe(res, 3).length <= 3, "dedupe caps a single unordered pair at three");

  /* the hand-built trade: Team D consolidates two men into Team J's best */
  const ix = (id) => sub.index.get(id);
  const key = `${D}>${J}|${ix(57)},${ix(58)}|${ix(152)}`;
  ok(got.has(key), "the hand-built 2-for-1 (D sends 57+58 for 152) is reported");
  const hand = got.get(key);
  ok(hand[0] > 2.3 && hand[1] > 1.2, `and it is a large win for both (${hand})`);
  near(hand[0], brute.get(key)[0], 1e-9, "hand-built: D's gain matches the brute force");
  near(hand[1], brute.get(key)[1], 1e-9, "hand-built: J's gain matches the brute force");

  /* it scores the same in the full ten-team league: nothing leaks across teams */
  const kept = eng.roster.get(D).filter((i) => i !== 57 && i !== 58).concat([152]);
  const bf = eng.backfill(kept);
  const recv = eng.roster.get(J).filter((i) => i !== 152).concat([57, 58]);
  const tr = eng.trim(recv, [57, 58]);
  near(eng._metrics(D, bf.ids).gain, hand[0], 1e-9, "same trade, ten-team league: D");
  near(eng._metrics(J, tr.ids).gain, hand[1], 1e-9, "same trade, ten-team league: J");
}

/* ---- 6b. positionLimits filters the search too, and `legal` is not vacuous ---- */
{
  // Section 6's `sub` has no limits at all, so its `legal()` returns true without ever
  // looking at a roster - the legality invariants above are the right shape but they
  // assert nothing there. A cap makes them bite. Both teams hold exactly `cap` tight
  // ends, so both start legal and either is one incoming TE away from being over.
  const D = F.teams[3], J = F.teams[9];
  const cap = Math.max(...[D, J].map((t) => F.rosters[t].filter((i) => F.pos[i] === "TE").length));
  const capped = mkEng(mkModel([D, J], { [POS_ID.TE]: cap }));
  ok(capped.limits.length > 0, "the capped engine really has a limit to enforce");
  ok(capped.teams.every((t) => capped.legal(capped.roster.get(t))), "both rosters start legal");

  // The mechanism the search has to guard against: a receiver two men over a cap has
  // no single legal drop at all, and `trim` says so by returning the roster whole.
  const rj = capped.roster.get(J), rd = capped.roster.get(D);
  const twoTE = rd.filter((i) => POS[i] === "TE").slice(0, 2);
  const back = rj.find((i) => POS[i] !== "TE");
  ok(twoTE.length === 2 && back !== undefined, "the fixture can build an over-cap roster");
  const over = rj.filter((i) => i !== back).concat(twoTE);
  ok(!capped.legal(over), "two over the cap is illegal - so `legal` is doing work here");
  const stuck = capped.trim(over, twoTE);
  ok(stuck.drop === null && stuck.ids.length === over.length,
     "trim finds no legal single drop and hands the roster back unchanged");

  // Not the section-6 brute force: its `cutIds` starts null and it never checks
  // legality, so on a capped league it would hand null to `_metrics` and throw.
  const res = await capped.findTwoForOne(0.05);
  ok(res.length > 0, `the capped search still finds trades (${res.length})`);
  ok(res.every((t) => t.sides[1].drop !== null), "every receiving side names a real drop");
  ok(res.every((t) => t.sides.every((s) => s.final.length === 16)),
     "no final roster is oversized");
  ok(res.every((t) => t.sides.every((s) => capped.legal(s.final))),
     "no final roster is one ESPN would refuse");
}

/* ---- 7. `final` reaches the passes that run after the search ---- */
{
  const D = F.teams[3], J = F.teams[9];
  const sub = mkEng(mkModel([D, J]));
  const res = await sub.findTwoForOne(0.05);
  const t = res[0];

  // explain names the waiver move and the drop, with their start counts
  const ex = sub.explain(t);
  ok(ex[t.sides[0].team].backfill?.i === t.sides[0].backfill, "explain names the backfill");
  ok(Number.isInteger(ex[t.sides[0].team].backfill?.startsHere), "with a start count");
  ok(ex[t.sides[1].team].dropped?.i === t.sides[1].drop, "explain names the drop");
  ok(Number.isInteger(ex[t.sides[1].team].dropped?.wasStarting), "with the starts it costs");
  ok(ex[t.sides[0].team].dropped === undefined, "a side with no drop has no drop line");

  // enrich scores the FINAL roster, not the mid-trade one
  const sched = new Map();
  for (const w of sub.settings.regularSeasonWeeks) sched.set(w, [[D, J]]);
  sub.setSchedule(sched);
  await sub.enrich([t]);
  ok(t.sides.every((s) => Array.isArray(s.winWeekly) && s.winWeekly.length === sub.NW),
     "enrich fills winWeekly for a 2-for-1");
  ok(Math.sign(t.sides[0].win) === Math.sign(t.sides[0].reg),
     "the win delta agrees in sign with the points gain");
  // a side whose `final` is deleted must fall back to swap() and score differently -
  // that is the proof enrich is reading `final` rather than ignoring it
  const clone = { ...t, sides: t.sides.map((s) => ({ ...s, win: 0, winWeekly: null })) };
  delete clone.sides[0].final;
  delete clone.sides[1].final;
  sub._baseWins = null;
  await sub.enrich([clone]);
  ok(Math.abs(clone.sides[0].win - t.sides[0].win) > 1e-9,
     "without `final`, enrich scores a different roster - so it was using it");
}

/* ---- 8. `weekly`'s fast path is untouched by any of this ---- */
{
  const fresh = mkEng(mkModel());
  for (const t of F.teams) {
    const js = fresh.weekly(fresh.roster.get(t));
    for (let w = 0; w < F.weeks.length; w++)
      ok(Math.abs(js[w] - F.baseline[t][w]) < 1e-6, `${t} wk${F.weeks[w]} still matches the fixture`);
  }
}

/* ---- 9. the panel strings ---- */
{
  const { ROSTER_HINT, moveNote, moveLines, dropSection } =
    await import("../panel/roster.js");
  const D = F.teams[3], J = F.teams[9];
  const sub = mkEng(mkModel([D, J]));
  const model = mkModel([D, J]);
  const res = await sub.findTwoForOne(0.05);
  const t = res[0];
  const nm = (i) => model.players.get(sub.ids[i]).name;

  ok(typeof ROSTER_HINT.cost === "string" && ROSTER_HINT.cost.length > 40,
     "every new column has a hint written for a human");
  ok(["bestadd", "addgain", "net", "shape21"].every((k) => typeof ROSTER_HINT[k] === "string"),
     "all five hints exist");

  const addNote = moveNote(t.sides[0], nm);
  const cutNote = moveNote(t.sides[1], nm);
  ok(addNote.includes(nm(t.sides[0].backfill)) && addNote.includes("waivers"),
     "the consolidating side's note names the free agent and says where he comes from");
  ok(cutNote.includes(nm(t.sides[1].drop)) && cutNote.includes("drop"),
     "the other side's note names the drop");
  ok(moveNote({ backfill: null, drop: null }, nm) === "",
     "a side with no waiver move renders nothing at all");
  ok(!moveNote({ backfill: 0, drop: null }, () => '<img src=x onerror=1>').includes("<img"),
     "names are escaped");

  const ex = sub.explain(t);
  const lines = moveLines(ex[t.sides[0].team], nm) + moveLines(ex[t.sides[1].team], nm);
  ok(lines.includes(nm(t.sides[0].backfill)) && lines.includes(nm(t.sides[1].drop)),
     "the detail lines name both moves");
  ok(/\d/.test(lines), "and give their start counts");
  ok(moveLines({}, nm) === "", "a shape with no waiver move contributes no lines");

  const html = dropSection(sub, model, { team: D, grid: (id, cols, rows, o) =>
    `<table id="${id}">${rows.length ? rows.map(o.row).join("") : o.empty}</table>` });
  ok(html.includes("Drop candidates"), "the section is titled");
  ok(html.includes('id="dropGrid"'), "and carries a sortable grid");
  ok(sub.roster.get(D).every((i) => html.includes(nm(i))), "every rostered player appears");
  ok(dropSection(sub, model, { team: D, grid: () => "" }).length > 0,
     "an empty grid still renders the section");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("ROSTER OK");
