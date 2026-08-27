/**
 * Win probability from two normal score distributions.
 *
 * A week is won by the higher score. With team scores Normal(m, s) and independent,
 * the difference is Normal(mA - mB, sqrt(sA^2 + sB^2)), so
 *
 *   P(A beats B) = Phi((mA - mB) / sqrt(sA^2 + sB^2))
 *
 * and the value of one more point for A that week is the density at that z divided
 * by the same spread - the "leverage" of the week. Both are exact under the model
 * the season simulation already uses, so they agree with it up to Monte Carlo error.
 */

/** Used when no volatility has been measured; matches season.js's default. */
export const FALLBACK_SIGMA = 25;

/** Standard normal CDF. Abramowitz & Stegun 7.1.26; absolute error < 7.5e-8. */
export function Phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
              + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Standard normal PDF. */
export function phi(z) {
  return Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
}

export function winProb(mA, sA, mB, sB) {
  const s = Math.sqrt(sA * sA + sB * sB);
  if (s === 0) return mA > mB ? 1 : mA < mB ? 0 : 0.5;
  return Phi((mA - mB) / s);
}

/** dP(A wins)/d(mA): how much one extra point is worth to A this week. */
export function leverage(mA, sA, mB, sB) {
  const s = Math.sqrt(sA * sA + sB * sB);
  return s === 0 ? 0 : phi((mA - mB) / s) / s;
}
