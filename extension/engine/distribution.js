/**
 * Measured distributions and the correlation between teammates.
 *
 * A sigma is a symmetric number and a fantasy week is not. Residuals are
 * right-skewed with a floor near zero - a receiver's bad week is bounded below by
 * nothing and his good week is not bounded above - so "projection plus or minus a
 * sigma" invents a floor that cannot happen and misses the ceiling that decides
 * games. The residuals `measureVolatility` already computes are the real shape, and
 * their 10th, 50th and 90th percentiles are what this module publishes.
 *
 * The second half of the file is correlation. Two players on the same NFL team do
 * not score independently: a quarterback's good day is his receivers' good day, so
 * a stacked lineup's spread is wider than the root of the summed variances. The
 * constants live in ONE table, `CORR`, and they apply only when both players have a
 * real pro team - never for the fixture's placeholder "X", an unresolved "?" or a
 * free agent's "FA". That guard is load-bearing: it is what keeps parity.mjs green.
 */

/**
 * The whole correlation model. One table, one place.
 *
 * Values are the middle of the range the public work reports for full-PPR scoring;
 * they are deliberately conservative, because being wrong about a correlation costs
 * a mis-stated spread on every downstream number.
 */
export const CORR = {
  qbToPass: 0.25,   // same NFL team, QB with a WR or TE
  sameTeam: 0.10,   // same NFL team, neither of them a QB
  rb: 0,            // a RB with anyone: his carries are not the passing game
  sameGame: -0.05,  // opponents in the same NFL game: one offence's yards are the other's absence
};

/** z for the 10th/90th percentile of a normal. */
export const Z90 = 1.2815515655446004;

/** Teams that are not teams. Correlation is off for every one of them. */
const PLACEHOLDER = new Set(["X", "?", "FA", "", null, undefined]);

export function isRealTeam(nfl) {
  return typeof nfl === "string" && nfl.length > 0 && !PLACEHOLDER.has(nfl);
}

/**
 * The correlation family a display position belongs to.
 *
 * This is the one place the engine reads a position string for anything but
 * display, and it reads it only to pick a correlation - never to seat a player.
 * `TQB` is this league's team-quarterback entity and behaves as a quarterback.
 */
export function posFamily(pos) {
  if (pos === "QB" || pos === "TQB") return "QB";
  if (pos === "RB") return "RB";
  if (pos === "WR" || pos === "TE") return "PASS";
  return "OTHER";
}

/**
 * Correlation between two players' weekly scores.
 *
 * @param a {{pos: string, nfl: string}}
 * @param b {{pos: string, nfl: string}}
 * @param opts.sameGame true when the two pro teams meet each other that week
 */
export function rho(a, b, { sameGame = false } = {}) {
  if (!a || !b) return 0;
  if (!isRealTeam(a.nfl) || !isRealTeam(b.nfl)) return 0;
  if (a.nfl !== b.nfl) return sameGame ? CORR.sameGame : 0;
  const fa = posFamily(a.pos), fb = posFamily(b.pos);
  if (fa === "RB" || fb === "RB") return CORR.rb;
  if (fa === "QB" && fb === "QB") return 0;
  if (fa === "QB" || fb === "QB") {
    const other = fa === "QB" ? fb : fa;
    return other === "PASS" ? CORR.qbToPass : 0;
  }
  return CORR.sameTeam;
}

/** Linear-interpolated sample quantile. Returns null for an empty sample. */
function q(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const i = p * (n - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * The 10th, 50th and 90th percentiles of a residual sample, shrunk toward a prior.
 *
 * A six-week sample's 90th percentile is one observation, so it is shrunk toward the
 * position's pooled quantiles with weight n/(n+n0). n0 = 10 makes a full prior season
 * count for about 63% of its own quantile and a two-week sample for 17%.
 */
export function quantiles(residuals, shrinkTo, n0 = 10) {
  const to = shrinkTo ?? { p10: 0, p50: 0, p90: 0 };
  const n = residuals?.length ?? 0;
  if (!n) return { p10: to.p10, p50: to.p50, p90: to.p90, n: 0 };
  const s = [...residuals].sort((x, y) => x - y);
  const w = n / (n + n0);
  return {
    p10: w * q(s, 0.10) + (1 - w) * to.p10,
    p50: w * q(s, 0.50) + (1 - w) * to.p50,
    p90: w * q(s, 0.90) + (1 - w) * to.p90,
    n,
  };
}

/** Mean projection over the weeks he is actually projected to play. */
function meanProj(player) {
  const v = Object.values(player?.proj ?? {}).filter((x) => x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * Everything the panel and the gameplan need, computed once.
 *
 * Three tiers, each the fallback for the one above: the player's own shrunk
 * quantiles, his position's pooled ones, and the league's. A player ESPN has never
 * projected before still gets a range rather than a dash.
 */
export function buildDistribution(vol, players, n0 = 10) {
  const pooled = [];
  for (const r of (vol?.byPosResiduals ?? new Map()).values()) pooled.push(...r);
  const global = quantiles(pooled, { p10: -(vol?.global ?? 6) * Z90, p50: 0,
                                     p90: (vol?.global ?? 6) * Z90 }, n0);

  const byPos = new Map();
  for (const [pos, res] of vol?.byPosResiduals ?? new Map())
    byPos.set(pos, quantiles(res, global, n0));

  const of = new Map();
  for (const [id, res] of vol?.residuals ?? new Map()) {
    const p = players?.get?.(id);
    of.set(id, quantiles(res, byPos.get(p?.pos) ?? global, n0));
  }

  // The coefficient of variation is a sticky trait - a boom-or-bust player stays
  // one - so it is worth reporting per player rather than per position, shrunk the
  // same way the quantiles are.
  const rawCv = new Map(), posCv = new Map();
  for (const [id, sd] of vol?.bySigma ?? new Map()) {
    const p = players?.get?.(id);
    const m = meanProj(p);
    if (!(m > 0)) continue;
    rawCv.set(id, sd / m);
    if (!posCv.has(p.pos)) posCv.set(p.pos, []);
    posCv.get(p.pos).push(sd / m);
  }
  const byPosCv = new Map([...posCv].map(([k, v]) => [k, median(v)]));
  const cvOf = new Map();
  for (const [id, res] of vol?.residuals ?? new Map()) {
    const p = players?.get?.(id);
    const prior = byPosCv.get(p?.pos) ?? 0;
    const m = meanProj(p);
    const own = rawCv.get(id) ?? (m > 0 && res.length > 1
      ? Math.sqrt(res.reduce((a, b) => a + b * b, 0) / (res.length - 1)) / m : null);
    if (own == null) { cvOf.set(id, prior); continue; }
    const w = res.length / (res.length + n0);
    cvOf.set(id, w * own + (1 - w) * prior);
  }

  return { of, byPos, global, cvOf, byPosCv, n0 };
}

/**
 * A player's floor, median and ceiling for one week.
 *
 * `w` is the ESPN week number - the key of `player.proj`, not an engine week index.
 * The floor is clamped at zero: a fantasy score cannot be negative in any scoring
 * setting this engine supports, and a p10 of -14 on an 8-point projection means
 * "he busts", not "he loses you six points".
 */
export function playerRange(player, w, dist) {
  const proj = player?.proj?.[w] ?? 0;
  const qs = dist?.of?.get(player?.id)
    ?? dist?.byPos?.get(player?.pos)
    ?? dist?.global
    ?? { p10: 0, p50: 0, p90: 0 };
  return {
    floor: Math.max(0, proj + qs.p10),
    median: Math.max(0, proj + qs.p50),
    ceiling: Math.max(0, proj + qs.p90),
  };
}

/** Sigma over mean projection, shrunk toward the position's. See buildDistribution. */
export function cv(player, dist) {
  return dist?.cvOf?.get(player?.id) ?? dist?.byPosCv?.get(player?.pos) ?? 0;
}

/**
 * Teach an Engine about correlation, from outside.
 *
 * The parallel-build rules give this phase exactly one method of `search.js` -
 * `rosterSigma` - so the correlation cannot arrive as an import there. It arrives as
 * an attached function instead: `rosterSigma` adds a covariance term if and only if
 * `eng.rhoOf` exists, so an engine nobody attaches to behaves exactly as it did
 * before. That is also the mechanism that keeps `parity.mjs` green, twice over: it
 * never calls this, and every fixture player is on "X" anyway.
 *
 * @param players Map<playerId, {pos, nfl}> - the model's player map
 * @param gameOf  optional (nflAbbrev, weekNumber) -> game key, for the cross-game
 *   term. Phase 7 publishes `gameOf(proTeamId, week)`; the call site adapts the id
 *   to the abbreviation. Absent, the cross-game term is skipped entirely.
 */
export function attachCovariance(eng, players, { gameOf = null } = {}) {
  const meta = new Map();
  for (let i = 0; i < eng.n; i++) {
    const p = players?.get?.(eng.ids[i]);
    meta.set(i, { pos: p?.pos ?? "?", nfl: p?.nfl ?? "?" });
  }
  eng.corrMeta = meta;
  eng.rhoOf = (i, j, w) => {
    const a = meta.get(i), b = meta.get(j);
    if (!a || !b) return 0;
    if (a.nfl === b.nfl) return rho(a, b);
    if (!gameOf || !isRealTeam(a.nfl) || !isRealTeam(b.nfl)) return 0;
    const week = eng.weeks[w];
    const ga = gameOf(a.nfl, week);
    return ga != null && ga === gameOf(b.nfl, week) ? rho(a, b, { sameGame: true }) : 0;
  };
  eng.stacks = (ids, w = 0) => stacks(eng, ids, w);
  // teamSigma memoises, and it memoised the uncorrelated answer.
  eng._teamSigma = null;
  return eng;
}

/**
 * The correlated pairs among a roster's starters in one week, each listed once.
 *
 * `w` is an engine week index. Bench players are excluded: a stack you are not
 * starting is not a stack, it is depth.
 */
export function stacks(eng, ids, w = 0) {
  if (!eng.corrMeta) return [];
  const mask = eng.starterMask(ids);
  const on = [...mask].filter(([, m]) => m[w]).map(([i]) => i).sort((a, b) => a - b);
  const out = [];
  for (let x = 0; x < on.length; x++) {
    for (let y = x + 1; y < on.length; y++) {
      const r = eng.rhoOf(on[x], on[y], w);
      if (!r) continue;
      const a = eng.corrMeta.get(on[x]), b = eng.corrMeta.get(on[y]);
      const fam = (p) => (posFamily(p.pos) === "QB" ? "QB" : p.pos);
      out.push({ a: on[x], b: on[y], rho: r, nfl: a.nfl === b.nfl ? a.nfl : null,
                 label: `${fam(a)}+${fam(b)}` });
    }
  }
  return out;
}

/**
 * A team's floor, median and ceiling for one week, as a normal.
 *
 * A single player's score is not normal - it is a mixture of a bust and a big game,
 * bounded below at zero and long-tailed above - which is why `playerRange` uses his
 * measured quantiles instead. A lineup total is a sum of nine such scores of
 * comparable size and mostly modest correlation, and that is precisely the situation
 * the central limit theorem describes: the sum is far closer to symmetric than any
 * of its terms, so `mean +/- z * sigma_team` is the honest shape here even though it
 * would be the wrong one one level down.
 *
 * `w` is an engine week index. `sigma_team` comes from `rosterSigma`, so it already
 * carries both the availability weighting and the covariance. There is deliberately
 * no `dist` argument: nothing here reads a per-player quantile.
 */
export function lineupRange(eng, ids, w) {
  const mask = eng.starterMask(ids);
  const av = eng.avail, NW = eng.NW;
  let mu = 0;
  for (const [i, m] of mask)
    if (m[w]) mu += (av ? av[i * NW + w] : 1) * eng.proj[i * NW + w];
  const sig = eng.rosterSigma(ids)?.[w] ?? 0;
  return { floor: Math.max(0, mu - Z90 * sig), median: mu, ceiling: mu + Z90 * sig };
}
