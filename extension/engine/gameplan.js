/**
 * Which lineup is most likely to beat THIS opponent, this week.
 *
 * Every other number in this project maximises expected points. On Sunday morning
 * that is the wrong objective: an underdog does not want the highest mean, he wants
 * the fattest right tail, and a heavy favourite wants the opposite. P(win) is
 * Phi((mu - mu_opp) / sqrt(sigma^2 + sigma_opp^2)), and it is not monotone in mu -
 * so the lineup that maximises it is often not the lineup the rest of the engine
 * would field.
 *
 * This is a LOCAL SEARCH, and it is the only search in the project that is not
 * exhaustive. The trade search enumerates because the answer has to be trustworthy
 * and the space is a few million rosters; the lineup space is C(roster, starters)
 * over a full bench and then a matroid feasibility test on each, which is a
 * different order of problem for an answer a manager will eyeball anyway. Repeated
 * best single swaps from the mean-optimal lineup converge in a handful of rounds,
 * every step is a strict improvement, and the starting point is already the answer
 * to the question everyone else asks. Say so on screen; do not present it as exact.
 */
import { bestLineupSeats } from "./lineup.js";
import { winProb, FALLBACK_SIGMA } from "./winprob.js";
import { Z90 } from "./distribution.js";

/**
 * The mean and spread of one GIVEN lineup in one week.
 *
 * This repeats `rosterSigma`'s arithmetic on purpose. `rosterSigma` re-solves the
 * optimal lineup for whatever roster it is handed, which is the wrong question here:
 * the whole point is to price lineups the optimiser would not pick. The test suite
 * asserts the two agree on the mean-optimal lineup, so they cannot drift apart
 * unnoticed.
 */
export function lineupStats(eng, starters, w) {
  const av = eng.avail, NW = eng.NW;
  let mu = 0, v = 0;
  const sd = [];
  for (const i of starters) {
    const p = av ? av[i * NW + w] : 1;
    const s = eng.sigmaOf?.[i] ?? 0;
    mu += p * eng.proj[i * NW + w];
    v += p * s * s;
    if (eng.rhoOf) sd.push(i, Math.sqrt(p) * s);
  }
  if (eng.rhoOf) {
    for (let x = 0; x < sd.length; x += 2) {
      for (let y = x + 2; y < sd.length; y += 2) {
        const r = eng.rhoOf(sd[x], sd[y], w);
        if (r) v += 2 * r * sd[x + 1] * sd[y + 1];
      }
    }
  }
  return { mu, sigma: Math.sqrt(Math.max(0, v)) };
}

/**
 * Can all of these players be seated at once?
 *
 * The same transversal matroid the lineup solver uses. Kuhn's augmenting path
 * returns a MAXIMUM matching regardless of the order it is fed, so "every player got
 * a seat" is a sound feasibility test and does not depend on the sort.
 */
export function feasible(eng, starters) {
  if (starters.length > eng.starters) return false;
  const vals = new Float64Array(eng.n);
  for (const i of starters) vals[i] = 1;
  const seatOf = bestLineupSeats(starters.slice(), vals, eng.mask, eng.starters);
  let filled = 0;
  for (const s of seatOf) if (s >= 0) filled++;
  return filled === starters.length;
}

const sig = (s) => (s > 0 ? s : FALLBACK_SIGMA);

/**
 * The week's plan: the mean-optimal lineup, the P(win)-optimal one, and the swaps
 * between them.
 *
 * @param w engine week index
 * @returns null when volatility is unmeasured or nobody is scheduled that week
 */
export function gameplan(eng, team, w, { maxRounds = 24, minDelta = 1e-9 } = {}) {
  if (!eng.sigmaOf) return null;
  const opponent = eng.opp?.get(team)?.[w];
  if (!opponent) return null;

  const ids = eng.roster.get(team) ?? [];
  const av = eng.avail, NW = eng.NW;
  // Anyone who might play at all. A man at 40% is discounted inside `mu` already;
  // ruling him out here would exclude exactly the dart an underdog is looking for.
  const pool = ids.filter((i) => eng.mask[i] && (av ? av[i * NW + w] > 0 : true));

  // The mean-optimal seed, solved here rather than read from starterMask so that the
  // baseline and every candidate are priced by the same function.
  const vals = new Float64Array(eng.n);
  for (const i of pool) vals[i] = (av ? av[i * NW + w] : 1) * eng.proj[i * NW + w];
  const order = pool.slice().sort((a, b) => vals[b] - vals[a]);
  const seatOf = bestLineupSeats(order, vals, eng.mask, eng.starters);
  const lineupMean = [...seatOf].filter((p) => p >= 0).sort((a, b) => a - b);

  const them = {
    mu: eng.baseline.get(opponent)?.[w] ?? 0,
    sigma: sig(eng.teamSigma(opponent)?.[w] ?? 0),
  };
  const pOf = (line) => {
    const st = lineupStats(eng, line, w);
    return winProb(st.mu, sig(st.sigma), them.mu, them.sigma);
  };

  const pWinMean = pOf(lineupMean);
  let cur = lineupMean.slice();
  let best = pWinMean;
  const swaps = [];

  // Repeated best single swap. Each accepted move strictly increases P(win) and the
  // set of lineups is finite, so this terminates; maxRounds is a belt against a
  // future change that makes the objective non-strict.
  for (let round = 0; round < maxRounds; round++) {
    let pick = null;
    const bench = pool.filter((i) => !cur.includes(i));
    for (let k = 0; k < cur.length; k++) {
      for (const b of bench) {
        const cand = cur.slice();
        cand[k] = b;
        if (!feasible(eng, cand)) continue;
        const p = pOf(cand);
        if (p > best + minDelta && p > (pick?.p ?? -Infinity)) {
          pick = { p, out: cur[k], in: b, cand };
        }
      }
    }
    if (!pick) break;
    swaps.push({ out: pick.out, in: pick.in, dP: pick.p - best });
    best = pick.p;
    cur = pick.cand.sort((a, b) => a - b);
  }

  return {
    opponent, week: eng.weeks[w],
    pWinMean, pWinBest: best,
    lineupMean, lineupBest: cur,
    swaps,
    me: rangeOf(eng, cur, w),
    them: {
      floor: Math.max(0, them.mu - Z90 * them.sigma),
      median: them.mu,
      ceiling: them.mu + Z90 * them.sigma,
    },
  };
}

/** The chosen lineup's own range - lineupRange re-solves, so price this one directly. */
function rangeOf(eng, line, w) {
  const st = lineupStats(eng, line, w);
  const s = sig(st.sigma);
  return { floor: Math.max(0, st.mu - Z90 * s), median: st.mu, ceiling: st.mu + Z90 * s };
}
