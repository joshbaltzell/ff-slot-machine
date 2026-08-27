/**
 * Calibrate ESPN projections before the engine sees them.
 *
 * Projections are over-spread: regressing actual points on projected points gives
 * slopes below one (season-level, Fantasy Football Analytics, 12 seasons: QB 0.67,
 * TE 0.72, RB 0.79, WR 0.85). The gap between a position's #1 and #5 is smaller in
 * reality than on paper. Shrinking each projection toward its positional mean by the
 * measured slope is the cheapest accuracy available.
 *
 * Applied per week, which is an assumption - the slopes were measured on seasons.
 * Phase 5's calibration log replaces these constants with league-measured ones, so
 * `k` is a plain map and nothing else here knows where the numbers came from.
 *
 * Order within a position is preserved, so no within-position lineup choice changes.
 * Flex competition across positions and every trade value do, which is the point.
 */
export const CALIBRATION_K = { QB: 0.67, RB: 0.79, WR: 0.85, TE: 0.72 };

/**
 * Mutates `proj` on every player whose `pos` is in `k`. The positional mean for a
 * week is taken over players with a non-zero projection, so byes do not drag it.
 * @returns {{changed:number, k:object}}
 */
export function shrinkProjections(players, weeks, k = CALIBRATION_K) {
  const groups = new Map();
  for (const p of players.values()) {
    if (!(p.pos in k)) continue;
    if (!groups.has(p.pos)) groups.set(p.pos, []);
    groups.get(p.pos).push(p);
  }
  let changed = 0;
  for (const [pos, list] of groups) {
    const slope = k[pos];
    if (!(slope >= 0) || slope === 1) continue;
    for (const w of weeks) {
      const live = list.filter((p) => p.proj[w] > 0);
      if (live.length < 2) continue;
      const mean = live.reduce((a, p) => a + p.proj[w], 0) / live.length;
      for (const p of live) p.proj[w] = Math.round((mean + slope * (p.proj[w] - mean)) * 100) / 100;
    }
    changed += list.length;
  }
  return { changed, k };
}
