/**
 * What a trade does to a team's season odds.
 *
 * Two runs of the season simulation - rosters as they are, rosters after the trade -
 * with the same seed. projectSeason draws a fixed number of normals per simulation
 * regardless of who wins, so the two worlds see identical noise and their
 * difference is a paired estimate whose error is far below either run's own. The
 * error is measured, not assumed: the sims are split into batches and the standard
 * error of the batch deltas is reported alongside each delta. The UI shows a dash
 * for any delta smaller than twice its error.
 */
import { projectSeason } from "./season.js";

const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

function postWorld(eng, trade) {
  const override = new Map();
  for (const s of trade.sides) {
    // `final` is set by shapes whose roster does not follow from (sent, received) -
    // a 2-for-1 finishes with a waiver add or a drop. See Engine.findTwoForOne.
    const ids = s.final ?? eng.swap(eng.roster.get(s.team), s.sent, s.received);
    override.set(s.team, { mu: eng.weekly(ids, new Float64Array(eng.NW)), sigma: eng.rosterSigma(ids) });
  }
  return override;
}

function deltas(base, post, team) {
  const b = base.find((r) => r.team === team), p = post.find((r) => r.team === team);
  const d = (k) => p[k] - b[k];
  // A single-batch run has no batch spread to measure, so report zero error rather
  // than throwing: the caller still gets its deltas, just without a dash rule.
  if (!p.batches || !b.batches)
    return {
      title: d("titlePct"), bye: d("byePct"), playoff: d("playoffPct"), wins: d("wins"),
      se: { title: 0, bye: 0, playoff: 0 },
    };
  const se = (k) => {
    const ds = p.batches.map((x, i) => x[k] - b.batches[i][k]);
    const m = ds.reduce((a, c) => a + c, 0) / ds.length;
    const v = ds.reduce((a, c) => a + (c - m) ** 2, 0) / Math.max(1, ds.length - 1);
    return Math.sqrt(v / ds.length);
  };
  return {
    title: d("titlePct"), bye: d("byePct"), playoff: d("playoffPct"), wins: d("wins"),
    se: { title: se("titlePct"), bye: se("byePct"), playoff: se("playoffPct") },
  };
}

/** The delta when it clears twice its own Monte Carlo error, else null. */
export function significant(odds, key) {
  if (!odds || !Number.isFinite(odds[key])) return null;
  const se = odds.se?.[key] ?? 0;
  return Math.abs(odds[key]) >= 2 * se ? odds[key] : null;
}

// `records` rides along so that both worlds of a paired run know the standings: a
// trade's change in title odds depends on the record it is being added to.
const simOpts = ({ sims = 5000, batches = 10, divisionSeeding = false, divisionOf = null,
                   records = null } = {}) =>
  ({ sims, batches: Math.max(2, batches), divisionSeeding, divisionOf, records });

/** Δ odds for `team` from one trade. Runs the baseline itself; use attachOdds for many. */
export function tradeOdds(eng, schedule, settings, trade, team, opts) {
  const o = simOpts(opts);
  const base = projectSeason(eng, schedule, settings, o);
  const post = projectSeason(eng, schedule, settings, { ...o, override: postWorld(eng, trade) });
  return deltas(base, post, team);
}

/**
 * Set `t.odds` on every trade for `team`. The baseline world is simulated once.
 * Yields to the browser every few trades so the loading screen keeps moving.
 */
export async function attachOdds(eng, schedule, settings, trades, team, opts, onProgress = () => {}) {
  const o = simOpts(opts);
  const t0 = Date.now();
  const base = projectSeason(eng, schedule, settings, o);
  for (let n = 0; n < trades.length; n++) {
    const t = trades[n];
    const post = projectSeason(eng, schedule, settings, { ...o, override: postWorld(eng, t) });
    t.odds = deltas(base, post, team);
    if (n % 5 === 4) { onProgress(n + 1, trades.length); await yieldToBrowser(); }
  }
  if (trades.length) onProgress(trades.length, trades.length);
  return { ms: Date.now() - t0 };
}
