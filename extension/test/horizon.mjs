/**
 * Tests for the injury horizon: a player who is out now and back later.
 *
 * Phase 2 gave `availability.js` one lever per player - a status string - and read
 * the whole horizon off it. That is right for ESPN, which publishes a projection for
 * every player in every week whatever his status, so the status table is the only
 * thing that knows he is hurt. It is wrong for a platform that already states, week
 * by week, whom it expects to play: CBS omits a shelved player from `league/stats`
 * for the weeks he is out and names him again, with a real number, for the weeks it
 * expects him back. Reading `INJURY_RESERVE` as zero for the whole horizon then
 * throws away the return the adapter has already fetched.
 *
 * So the model carries an optional `p.availability: {[week]: 0..1}`, and an adapter
 * that knows fills it. ESPN never sets it and its path is unchanged, character for
 * character - the first group below is what pins that.
 *
 * `parity.mjs` is the frozen contract and is not touched. The model here is built
 * the way `availability.mjs` builds it, copied rather than imported for the same
 * reason: a change here must not be able to move the golden set.
 *
 *   node extension/test/horizon.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { Engine, dedupe } from "../engine/search.js";
import { buildAvailability, restrictToRemaining } from "../engine/availability.js";
import { statusBadge, availabilityLines } from "../panel/availability.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));
const { slots, starters } = buildSlots(F.lineupSlotCounts);
const masks = F.pos.map((p) => seatMask(F.eligibleSlots[p], slots));

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const near = (a, b, eps, what) => ok(Math.abs(a - b) < eps, `${what} (${a} vs ${b})`);
const row = (av, id) => Array.from(av.avail.get(id) ?? []);

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
const own = (model) => {
  for (const t of model.teams.values()) for (const id of t.roster) model.players.get(id).teamId = t.id;
};

/* ---- 1. no `availability` anywhere: the ESPN path, unmoved ---- */
{
  const model = mkModel(5);
  own(model);
  restrictToRemaining(model);
  const P = (i) => model.players.get(i);
  P(0).injuryStatus = "INJURY_RESERVE";
  P(1).injuryStatus = "QUESTIONABLE";
  P(2).injuryStatus = "OUT";
  const av = buildAvailability(model, null, model.weeks, 5);

  ok(row(av, 0).every((q) => q === 0), "with no availability attached, IR is still zero for the horizon");
  near(row(av, 1)[0], 0.71, 1e-12, "...a Questionable player is still 0.71 this week");
  ok(row(av, 1).slice(1).every((q) => q === 1), "...and still assumed back from next week");
  ok(row(av, 2)[0] === 0 && row(av, 2).slice(1).every((q) => q === 1),
     "...and OUT is still this week only");
  ok(!av.avail.has(3), "...and a healthy player still gets no entry at all");
  ok(av.statusOf.get(0).returnWeek === null,
     "...and nothing claims a return week the platform never stated");
}

/* ---- 2. an adapter that states the weeks: out now, back later ---- */
{
  const model = mkModel(1);
  own(model);
  const weeks = model.weeks;
  const P = (i) => model.players.get(i);

  // The shape the CBS adapter produces for a six-week absence: named in no payload
  // through week 6, named with a real number from week 7.
  P(0).injuryStatus = "INJURY_RESERVE";
  P(0).availability = Object.fromEntries(weeks.map((w) => [w, w <= 6 ? 0 : 1]));

  const av = buildAvailability(model, null, weeks, 1);
  const r = row(av, 0);
  ok(r.slice(0, 6).every((q) => q === 0), "the stated out-weeks are zero");
  ok(r.slice(6).every((q) => q === 1), "the stated return-weeks are one, not the status table's zero");
  ok(av.statusOf.get(0).returnWeek === 7, "the first week he is expected back is carried for the panel");
  ok(av.summary.shelved === 1 && av.summary.returning === 1,
     "he counts as shelved now and as returning within the horizon");
}

/* ---- 3. the merge rule, week by week ---- */
{
  const model = mkModel(4);
  own(model);
  restrictToRemaining(model);
  const weeks = model.weeks;
  const P = (i) => model.players.get(i);

  // Current week: the platform says he plays, the wire says Questionable. A weekly
  // include/exclude flag is binary and a Questionable Sunday is not, so this week
  // takes the more pessimistic of the two and the status table keeps its 0.71.
  P(0).injuryStatus = "QUESTIONABLE";
  P(0).availability = Object.fromEntries(weeks.map((w) => [w, 1]));

  // Current week: the platform says he does not play, nothing else knows. Explicit
  // still wins downward.
  P(1).injuryStatus = null;
  P(1).availability = { 4: 0 };

  // A week the adapter said nothing about falls through to the status table.
  P(2).injuryStatus = "INJURY_RESERVE";
  P(2).availability = { 9: 1 };

  const av = buildAvailability(model, null, weeks, 4);
  const k = (w) => weeks.indexOf(w);
  near(row(av, 0)[k(4)], 0.71, 1e-12, "this week takes the pessimistic of stated and status");
  ok(row(av, 0)[k(5)] === 1, "...and a later week takes the platform's word");
  ok(row(av, 1)[k(4)] === 0, "a stated zero wins this week even with no status at all");
  ok(row(av, 1)[k(5)] === 1, "...and an unstated later week is not invented");
  ok(row(av, 2)[k(5)] === 0 && row(av, 2)[k(9)] === 1,
     "an unstated week falls through to the status table, a stated one does not");
}

/* ---- 4. what the engine does with it ---- */
{
  const model = mkModel(1);
  own(model);
  restrictToRemaining(model);
  const weeks = model.weeks;

  // Pick a real starter so the absence costs something, then shelve him for six weeks.
  const team = F.teams[0];
  const ids = [...model.teams.get(0).roster];
  const eng0 = mkEngine(model);
  const base = eng0.weekly(ids, new Float64Array(eng0.NW)).slice();

  const star = ids.reduce((a, b) =>
    (eng0._rankVal()[eng0.index.get(a)] > eng0._rankVal()[eng0.index.get(b)] ? a : b));
  model.players.get(star).injuryStatus = "INJURY_RESERVE";
  model.players.get(star).availability = Object.fromEntries(weeks.map((w) => [w, w <= 6 ? 0 : 1]));

  const av = buildAvailability(model, null, weeks, 1);
  const eng = mkEngine(model);
  eng.setAvailability(av.avail);
  const after = eng.weekly(ids, new Float64Array(eng.NW));

  const k6 = weeks.findIndex((w) => w === 6);
  const k7 = weeks.findIndex((w) => w === 7);
  ok(after[k6] < base[k6] - 1e-9, "the roster is worse in a week he is out");
  near(after[k7], base[k7], 1e-9, "...and exactly itself again in the week he is back");
  ok(eng.avail !== null, "availability is attached");
}

/* ---- 5. the search gate: a trade that is worse now and better later ---- */
{
  const model = mkModel(1);
  own(model);
  restrictToRemaining(model);
  const weeks = model.weeks;

  // Shelve the best player on team 0 for the first six weeks. His own team now gains
  // by sending him (he is worth nothing to them until week 7) and whoever takes him
  // loses on the season average and wins in the playoff weeks. That is the trade the
  // gate has always thrown away.
  const eng0 = mkEngine(model);
  const ids = [...model.teams.get(0).roster];
  const star = ids.reduce((a, b) =>
    (eng0._rankVal()[eng0.index.get(a)] > eng0._rankVal()[eng0.index.get(b)] ? a : b));
  model.players.get(star).injuryStatus = "INJURY_RESERVE";
  model.players.get(star).availability = Object.fromEntries(weeks.map((w) => [w, w <= 6 ? 0 : 1]));

  const av = buildAvailability(model, null, weeks, 1);
  const eng = mkEngine(model);
  eng.setAvailability(av.avail);

  const plain = await eng.findTwoTeam(1, 0.05);
  ok(plain.every((t) => t.sides.every((s) => s.gain >= 0.05)),
     "the default gate still admits nothing that loses on the season average");

  const stash = await eng.findTwoTeam(1, 0.05, () => {}, { accept: ["gain", "playoff"] });
  ok(stash.length >= plain.length, "widening the windows can only add trades, never remove them");
  ok(plain.every((t) => stash.some((u) => JSON.stringify(u.sides) === JSON.stringify(t.sides))),
     "...and every trade the default gate found is still there");

  const bought = stash.filter((t) => t.sides.some((s) => s.received.includes(star)));
  ok(bought.length > 0, "the shelved man is now tradeable at all");
  const later = bought.filter((t) => {
    const s = t.sides.find((x) => x.received.includes(star));
    return s.gain < 0 && s.playoff >= 0.05;
  });
  ok(later.length > 0,
     "at least one side takes a loss on the season average to gain in the playoff weeks");
  ok(later.every((t) => t.sides.find((x) => x.sent.includes(star)).gain >= 0.05),
     "...and the man selling him gains now, which is what makes the offer sellable");
}

/* ---- 5b. the thinning step must not starve the class the gate just admitted ----
 *
 * `dedupe` keeps at most three trades per team pair, taken from a list ordered by
 * combined gain. A trade whose value is in the playoff weeks has a low combined gain by
 * construction, so within any pair that also has ordinary trades it is the first cut.
 * On this fixture the class largely survives one undifferentiated pile - the assertion
 * below is that the split keeps strictly more, not that the pile keeps none - because
 * most pairs here have no competing ordinary trade. That is luck, not a property: the
 * pair holding a shelved star is the one most likely to have good ordinary trades as
 * well, which is exactly where the cut would land. The split makes the allocation
 * reserved instead.
 */
{
  const model = mkModel(1);
  own(model);
  restrictToRemaining(model);
  const weeks = model.weeks;
  const eng0 = mkEngine(model);
  const ids = [...model.teams.get(0).roster];
  const star = ids.reduce((a, b) =>
    (eng0._rankVal()[eng0.index.get(a)] > eng0._rankVal()[eng0.index.get(b)] ? a : b));
  model.players.get(star).injuryStatus = "INJURY_RESERVE";
  model.players.get(star).availability = Object.fromEntries(weeks.map((w) => [w, w <= 6 ? 0 : 1]));
  const eng = mkEngine(model);
  eng.setAvailability(buildAvailability(model, null, weeks, 1).avail);

  const all = await eng.findTwoTeam(1, 0.05, () => {}, { accept: ["gain", "playoff"] });
  const stashy = (t) => t.sides.some((s) => s.gain < 0.05 && s.playoff >= 0.05);
  ok(all.some(stashy), "the search does return later-not-now trades");

  const naive = dedupe(all, 3).filter(stashy);
  const now = [], later = [];
  for (const t of all) (stashy(t) ? later : now).push(t);
  const split = [...dedupe(now, 3), ...dedupe(later, 2)].filter(stashy);
  ok(split.length > naive.length,
     "thinning the two classes separately keeps later-not-now trades that one pile loses");
  ok(split.length > 0, "...and keeps at least one, which is the whole point of the split");
}

/* ---- 6. what the panel says about a man who is coming back ---- */
{
  const esc = (x) => String(x);
  const gone = { statusOf: new Map([[1, { status: "INJURY_RESERVE", now: 0, returnWeek: null }]]) };
  const back = { statusOf: new Map([[1, { status: "INJURY_RESERVE", now: 0, returnWeek: 7 }]]) };

  const a = statusBadge(gone, 1, esc), b = statusBadge(back, 1, esc);
  ok(/IR/.test(a) && !/wk/.test(a), "a man with no stated return still reads as a bare IR badge");
  ok(/IR/.test(b) && /wk 7/.test(b), "...and a man with one says which week he is back in the badge itself");
  ok(/gone/.test(a) && /warn/.test(b),
     "...and they are not styled alike: gone is gone, coming back is a warning");
  ok(/rest of the horizon/.test(a) && /expects him back in week 7/.test(b),
     "...and the tooltip says which of the two claims is being made");

  const lines = availabilityLines({ out: 1, questionable: 2, shelved: 3, uncertain: 0, returning: 2 });
  ok(lines.some((l) => /2 of them are/.test(l) && /expected back/.test(l)),
     "the loading log counts the ones who come back inside the horizon");
  ok(!availabilityLines({ out: 1, questionable: 0, shelved: 0, returning: 0 })
       .some((l) => /expected back/.test(l)),
     "...and says nothing about returns when there are none, rather than printing a zero");
}

console.log(`\n${checks} assertions, ${failures} failures`);
console.log(failures ? "HORIZON FAILED" : "HORIZON OK");
process.exit(failures ? 1 : 0);
