/**
 * Average several projection sources into ESPN's own scoring.
 *
 * Averaging sources beats any single source — Fantasy Football Analytics measured
 * the plain average of a set of projections beating the individual members 69% of
 * the time over twelve seasons, and accuracy-weighting the average added nothing.
 * ESPN is one source. Sleeper (RotoWire) and FantasyPros are two more.
 *
 * The catch is that raw points from different sources are not the same unit. ESPN's
 * numbers are scored under *this league's* rules — its reception value, its bonuses,
 * its defensive scoring. Sleeper's `pts_half_ppr` and FantasyPros' `r2p_pts` are
 * scored under theirs. Averaging them directly would silently re-score the league,
 * and the error is not small: it is whatever the two rule sets disagree about.
 *
 * So nothing is averaged in points. Each source is converted to a dimensionless
 * positional fraction — a player's value as a multiple of his position's mean in
 * that source, for that week — the fractions are averaged, and the result is
 * multiplied back by *ESPN's* positional mean. Only the shape of a source's opinion
 * crosses over; the units stay ESPN's throughout. A source at twice the scale is the
 * same source, and that is the property that makes this legitimate.
 *
 * The spread of the fractions is a second, free output: how much the sources
 * disagree about a player, in points. That is the `±` the panel shows.
 *
 * One consequence worth naming, because it looks like a bug and is not. Coverage is
 * uneven: Sleeper publishes every remaining week, FantasyPros only the current one.
 * So in the current week a player both sources cover is averaged over three opinions
 * and pulled twice as far from ESPN as a player only Sleeper covers, who is averaged
 * over two. That follows directly from the spec's rule that a player a source does
 * not cover uses the sources that do; the alternatives — dropping FantasyPros, or
 * dropping every player it misses — are both worse than an uneven pull toward the
 * consensus. It is a documented property of the design, not a defect.
 *
 * `pos` is used here only as the grouping for a statistical normalization. It is
 * never used for lineup logic — the engine models slots, not positions.
 *
 * Mutates `p.proj` in place, the way `shrinkProjections` does, and runs before it:
 * aggregate first, then calibrate the aggregate.
 */

/**
 * @param model    { players: Map<id, {id, pos, proj}> } — `proj` keyed by week number
 * @param sources  [{ name, byWeek: Map<week, Map<espnId, points>> }]
 * @param weeks    the weeks to aggregate, usually the remaining ones
 * @returns {{touched, coverage: Record<string, number>, band: Map<id, Float64Array>, weeks}}
 *          `touched` is how many players the aggregate wrote to — not how many moved,
 *          since a source that agrees exactly still writes the same number back.
 *          `band.get(id)[i]` is the disagreement for `weeks[i]`, in points.
 */
export function aggregateProjections(model, sources = [], weeks = model.weeks ?? []) {
  const W = [...weeks];
  const NW = W.length;
  const band = new Map();
  const covered = new Map(sources.map((s) => [s.name, new Set()]));

  const groups = new Map();
  for (const p of model.players.values()) {
    if (!groups.has(p.pos)) groups.set(p.pos, []);
    groups.get(p.pos).push(p);
  }

  // Staged, because every fraction below must be read from ESPN's ORIGINAL numbers.
  // Writing as we go would let week 5's new value feed week 6's positional mean.
  const staged = new Map();          // id -> Float64Array, NaN where untouched

  for (const members of groups.values()) {
    for (let wi = 0; wi < NW; wi++) {
      const w = W[wi];
      const live = members.filter((p) => p.proj[w] > 0);
      if (live.length < 2) continue;                       // no mean worth taking
      const mE = live.reduce((a, p) => a + p.proj[w], 0) / live.length;
      if (!(mE > 0)) continue;

      // One fraction map per source that covers at least two of this week's players.
      const fracs = [];
      for (const s of sources) {
        const feed = s.byWeek?.get(w);
        if (!feed) continue;
        const shared = [];
        for (const p of live) {
          const v = feed.get(p.id);
          if (Number.isFinite(v) && v > 0) shared.push([p, v]);
        }
        if (shared.length < 2) continue;
        const mS = shared.reduce((a, x) => a + x[1], 0) / shared.length;
        if (!(mS > 0)) continue;
        // ESPN's own mean fraction on the players this source covers. Multiplying by
        // it compares the source with ESPN on the same set, so covering a skewed
        // subset (say, only the starters) cannot shift that subset's level. With
        // full coverage this is exactly 1.
        const kS = (shared.reduce((a, x) => a + x[0].proj[w], 0) / shared.length) / mE;
        const f = new Map();
        for (const [p, v] of shared) { f.set(p.id, (v / mS) * kS); covered.get(s.name).add(p.id); }
        fracs.push(f);
      }
      if (!fracs.length) continue;

      for (const p of live) {
        const vals = [p.proj[w] / mE];                     // ESPN is a source too
        for (const f of fracs) { const v = f.get(p.id); if (v != null) vals.push(v); }
        if (vals.length < 2) continue;                     // only ESPN: leave him alone
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        // Population sd: with two or three sources the sample sd overstates, and this
        // is a spread to display, not an estimate to do inference with.
        const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;

        let arr = staged.get(p.id);
        if (!arr) { arr = new Float64Array(NW).fill(NaN); staged.set(p.id, arr); }
        arr[wi] = Math.round(mE * mean * 100) / 100;

        let b = band.get(p.id);
        if (!b) { b = new Float64Array(NW); band.set(p.id, b); }
        b[wi] = mE * Math.sqrt(varr);
      }
    }
  }

  // `touched`, not `changed`: a source that agrees with ESPN exactly still writes
  // every value back, identical. This counts players the aggregate reached, which is
  // the useful number and the honest name for it.
  let touched = 0;
  for (const [id, arr] of staged) {
    const p = model.players.get(id);
    if (!p) continue;
    let any = false;
    for (let wi = 0; wi < NW; wi++) if (Number.isFinite(arr[wi])) { p.proj[W[wi]] = arr[wi]; any = true; }
    if (any) touched++;
  }

  const coverage = {};
  for (const s of sources) coverage[s.name] = covered.get(s.name).size;
  return { touched, coverage, band, weeks: W };
}
