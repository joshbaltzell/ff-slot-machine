/**
 * Projected season, from current rosters.
 *
 * Points are the wrong unit for a decision - leagues are won on record - so this
 * turns weekly projections into a distribution of outcomes.
 *
 * Two things make it honest rather than theatre:
 *
 * 1. Scores are not deterministic. A weekly fantasy score scatters around its
 *    projection by roughly 25 points, so each week is drawn as Normal(proj, sigma).
 *    Declaring the higher projection the winner every week would turn a half-point
 *    edge into a certain win and produce absurdly confident records.
 * 2. Rosters are frozen. No waiver moves, no injuries, no trades. It answers
 *    "if today's rosters played the season out", which is a real question but not
 *    a forecast of what will happen.
 */

import { FALLBACK_SIGMA } from "./winprob.js";

/** Deterministic PRNG, so the same data always yields the same projection. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, one value per call (the spare is cheap enough to discard). */
function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param eng      Engine (for baselines and week list)
 * @param schedule Map week -> [[teamNameA, teamNameB], ...]; empty falls back to all-play
 * @param settings league settings (playoff shape)
 */
export function projectSeason(eng, schedule, settings,
    { sims = 20000, sigma = FALLBACK_SIGMA, divisionSeeding = false, divisionOf = null,
      override = null, batches = 1, records = null } = {}) {
  // Prefer measured volatility. The sum of independent normals is normal with the
  // summed variance, so one draw per team-week is exact - no need to draw each
  // player separately - while still letting roster composition set the spread.
  // `override` swaps in a post-trade (mu, sigma) for some teams; everything else,
  // including the draw order, is unchanged, so two runs share their noise and the
  // difference between them is a paired estimate (common random numbers).
  const teamSig = eng.teams.map((t) => override?.get(t)?.sigma ?? eng.teamSigma?.(t) ?? null);
  const sigFor = (i, w) => {
    const v = teamSig[i];
    if (!v) return sigma;
    const k = eng.weeks.indexOf(w);
    return k >= 0 && v[k] > 0 ? v[k] : sigma;
  };
  const teams = eng.teams;
  const T = teams.length;
  const idx = new Map(teams.map((t, i) => [t, i]));
  const weeks = eng.weeks;
  const reg = settings.regularSeasonWeeks.filter((w) => weeks.includes(w));
  // Round-by-round weeks come from the league settings, so a two-week final or a
  // round of a different length than its neighbours is handled without special
  // casing. Reseeding is likewise a league setting, not an assumption.
  const roundWeeks = (settings.playoffRoundWeeks ?? [])
    .map((ws) => ws.filter((w) => weeks.includes(w)))
    .filter((ws) => ws.length);
  const reseed = settings.playoffReseed !== false;
  const nPlayoff = Math.min(settings.playoffTeams ?? 6, T);
  const bracket = 2 ** Math.ceil(Math.log2(Math.max(nPlayoff, 2)));
  const byes = bracket - nPlayoff;

  // team name -> division id, inverted to division -> member indices
  const divisions = new Map();
  if (divisionOf) {
    teams.forEach((t, i) => {
      const d = divisionOf.get(t);
      if (d == null) return;
      if (!divisions.has(d)) divisions.set(d, []);
      divisions.get(d).push(i);
    });
  }

  const mu = teams.map((t) => {
    const b = override?.get(t)?.mu ?? eng.baseline.get(t);
    const m = new Map();
    weeks.forEach((w, k) => m.set(w, b[k]));
    return m;
  });

  const rand = mulberry32(0x5EED);
  const acc = teams.map(() => ({ wins: 0, pf: 0, playoff: 0, bye: 0, title: 0, final: 0, seed: 0 }));
  const nb = Math.max(1, Math.floor(batches));
  const per = teams.map(() => Array.from({ length: nb }, () => ({ wins: 0, playoff: 0, bye: 0, title: 0 })));
  const batchOf = (s) => Math.min(nb - 1, Math.floor(s * nb / sims));
  const score = new Float64Array(T);

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

  for (let s = 0; s < sims; s++) {
    const wins = new Float64Array(T);
    const pf = new Float64Array(T);
    for (let i = 0; i < T; i++) { wins[i] = startWins[i]; pf[i] = startPf[i]; }

    for (const w of reg) {
      for (let i = 0; i < T; i++) score[i] = mu[i].get(w) + gauss(rand) * sigFor(i, w);
      for (let i = 0; i < T; i++) pf[i] += score[i];
      const games = schedule.get(w);
      if (games && games.length) {
        for (const [a, b] of games) {
          const ia = idx.get(a), ib = idx.get(b);
          if (ia === undefined || ib === undefined) continue;
          if (score[ia] > score[ib]) wins[ia]++; else if (score[ib] > score[ia]) wins[ib]++;
          else { wins[ia] += 0.5; wins[ib] += 0.5; }
        }
      } else {
        // No schedule: credit the share of the league each team would have beaten.
        for (let i = 0; i < T; i++) {
          let beat = 0;
          for (let j = 0; j < T; j++) if (j !== i && score[i] > score[j]) beat++;
          wins[i] += beat / (T - 1);
        }
      }
    }

    // Seed on record, then points scored - the near-universal ESPN tiebreak. Where
    // a league seeds division winners first, they take the top slots regardless of
    // overall record, which is exactly where the first-round byes are.
    let order = [...Array(T).keys()].sort((a, b) => wins[b] - wins[a] || pf[b] - pf[a]);
    if (divisionSeeding && divisions.size > 1) {
      const champs = [];
      for (const members of divisions.values()) {
        let best = null;
        for (const i of members)
          if (best === null || wins[i] > wins[best] || (wins[i] === wins[best] && pf[i] > pf[best]))
            best = i;
        if (best !== null) champs.push(best);
      }
      champs.sort((a, b) => wins[b] - wins[a] || pf[b] - pf[a]);
      const rest = order.filter((i) => !champs.includes(i));
      order = [...champs, ...rest];
    }
    const bi = batchOf(s);
    for (let k = 0; k < T; k++) {
      const i = order[k];
      acc[i].wins += wins[i]; acc[i].pf += pf[i]; acc[i].seed += k + 1;
      per[i][bi].wins += wins[i];
      if (k < nPlayoff) { acc[i].playoff++; per[i][bi].playoff++; }
      if (k < byes) { acc[i].bye++; per[i][bi].bye++; }
    }

    if (roundWeeks.length) {
      // A round's score sums every week it spans, so two-week rounds work.
      const roundScore = (i, r) => {
        let tot = 0;
        for (const w of roundWeeks[Math.min(r, roundWeeks.length - 1)])
          tot += mu[i].get(w) + gauss(rand) * sigFor(i, w);
        return tot;
      };
      let alive = order.slice(0, nPlayoff);            // in seed order
      let round = 0;
      if (byes > 0) {
        const seatIn = alive.slice(0, byes);
        let playing = alive.slice(byes);
        const next = [];
        for (let i = 0; i < playing.length / 2; i++) {
          const hi = playing[i], lo = playing[playing.length - 1 - i];
          next.push(roundScore(hi, round) >= roundScore(lo, round) ? hi : lo);
        }
        alive = [...seatIn, ...next];
        if (reseed) alive.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        round++;
      }
      while (alive.length > 1) {
        const next = [];
        for (let i = 0; i < alive.length / 2; i++) {
          const hi = alive[i], lo = alive[alive.length - 1 - i];
          next.push(roundScore(hi, round) >= roundScore(lo, round) ? hi : lo);
        }
        alive = next;
        if (reseed) alive.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        round++;
        if (alive.length === 2) for (const i of alive) acc[i].final++;
      }
      acc[alive[0]].title++;
      per[alive[0]][bi].title++;
    }
  }

  const games = played + reg.length;
  return teams.map((t, i) => ({
    team: t,
    wins: acc[i].wins / sims,
    losses: games - acc[i].wins / sims,
    pointsFor: acc[i].pf / sims,
    avgSeed: acc[i].seed / sims,
    playoffPct: acc[i].playoff / sims,
    byePct: acc[i].bye / sims,
    finalPct: acc[i].final / sims,
    titlePct: acc[i].title / sims,
    games,
    // Monte Carlo error on a proportion; used to avoid over-reporting precision.
    mcError: Math.sqrt(0.25 / sims),
    sigma: teamSig[teams.indexOf(t)]
      ? teamSig[teams.indexOf(t)].reduce((a, b) => a + b, 0) / weeks.length : sigma,
    batches: nb > 1 ? per[i].map((x) => {
      const n = sims / nb;
      return { wins: x.wins / n, playoffPct: x.playoff / n, byePct: x.bye / n, titlePct: x.title / n };
    }) : undefined,
  })).sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
}
