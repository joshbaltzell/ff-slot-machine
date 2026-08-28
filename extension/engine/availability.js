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
  const currentWeek = model.settings.currentWeek ?? 1;
  const all = model.weeks ?? [];
  const keep = all.filter((w) => w >= currentWeek);
  if (!keep.length) {
    return { currentWeek, played: all.length, remaining: 0, complete: true,
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
