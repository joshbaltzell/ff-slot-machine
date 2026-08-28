/**
 * What to bid on a waiver add.
 *
 * This is a HEURISTIC, not an auction model. It knows nothing about what anyone else
 * will bid, and it is displayed as a suggestion beside the engine's own gain figure.
 * Nothing in the search or the season projection reads it.
 *
 * The shape of the suggestion: your share of a fixed pot. An add's gain as a fraction
 * of the top five adds' gains, times what is left in your budget, times an urgency
 * multiplier that runs from 1 (nobody else wants him) to 2 (the whole of Sleeper is
 * adding him). Rounded to a figure ending in 1 or 6, which is exactly 5k+1, so a tie
 * against a manager who bid a round number is one you win.
 *
 * Beside it, a "most it is worth": the bid at which this add's remaining-season points
 * per dollar falls to the median of the top five's. That number can land BELOW the
 * suggestion, and it is deliberately not clamped up to it - `max < bid` is the useful
 * statement that the crowd, not the points, is what is setting the price.
 */
export const FAAB_K = {
  TOP: 5,             // how many adds share the pot the suggestion is a slice of
  URGENCY_AT: 500,    // 24h adds at which urgency reaches its cap of 2x
  STEP: 5,            // bids land on 5k + OFFSET …
  OFFSET: 1,          // … i.e. they end in 1 or 6
};

/**
 * The nearest bid ending in 1 or 6, never below 1.
 *
 * `K` is guarded rather than merely defaulted because this function is exactly the
 * shape somebody passes to `.map`, and `.map` hands the callback an index in the
 * second position. `K.STEP` on a number is undefined and the whole bid silently
 * becomes NaN. Measured while writing this file's plan.
 */
export function offRound(x, K) {
  const k = (K && typeof K === "object") ? K : FAAB_K;
  if (!Number.isFinite(x)) return k.OFFSET;
  return Math.max(k.OFFSET, k.STEP * Math.round((x - k.OFFSET) / k.STEP) + k.OFFSET);
}

function median(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  if (n === 1) return s[0];
  const h = (n - 1) * 0.5;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

/**
 * @param upgrades  [{fa, gain, ...}] from Engine.freeAgentUpgrades - `gain` is points
 *                  per week added to the best startable lineup
 * @param opts      {budget, myRemaining, weeksLeft, crowdOf(u) -> adds, K}
 * @returns {mode, bids: Map<fa, {bid, max, crowd}>, top, perDollar}
 */
export function faabBids(upgrades, opts = {}) {
  const K = { ...FAAB_K, ...(opts.K ?? {}) };
  const budget = Number(opts.budget) || 0;
  const remaining = Math.max(0, Number(opts.myRemaining) || 0);
  const weeksLeft = Math.max(1, Number(opts.weeksLeft) || 1);
  const crowdOf = opts.crowdOf ?? (() => 0);
  const bids = new Map();
  // ESPN's priority number is not on any record league.js builds today, and adding it
  // means widening a hunk in a file another phase owns. A no-FAAB league says so and
  // shows no bid rather than showing a wrong one.
  if (!(budget > 0)) return { mode: "priority", bids, top: [], perDollar: null };
  if (!upgrades?.length) return { mode: "faab", bids, top: [], perDollar: null };

  const ranked = upgrades.slice().sort((a, b) => b.gain - a.gain);
  const top = ranked.slice(0, K.TOP);
  const denom = top.reduce((a, u) => a + Math.max(0, u.gain), 0);

  const suggest = (u) => {
    if (!(denom > 0) || !(remaining > 0)) return 0;
    const shareOfGain = Math.max(0, u.gain) / denom;
    const urgency = 1 + Math.min(1, (Number(crowdOf(u)) || 0) / K.URGENCY_AT);
    return Math.min(remaining, offRound(shareOfGain * remaining * urgency, K));
  };
  const seasonGain = (u) => u.gain * weeksLeft;

  // Measured at the SUGGESTED bids, not at the base ones. The base bid is proportional
  // to gain, so points-per-dollar would be identical for every player and the maximum
  // would collapse onto the suggestion.
  const rate = median(top.map((u) => {
    const b = suggest(u);
    return b > 0 ? seasonGain(u) / b : NaN;
  }));

  for (const u of upgrades) {
    const max = rate != null && rate > 0
      ? Math.min(remaining, Math.max(1, Math.floor(seasonGain(u) / rate))) : null;
    bids.set(u.fa, { bid: suggest(u), max, crowd: Number(crowdOf(u)) || 0 });
  }
  return { mode: "faab", bids, top, perDollar: rate };
}
