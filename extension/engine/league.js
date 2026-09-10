/**
 * Platform-neutral vocabulary and the volatility measurement.
 *
 * The slot and position labels, the pro-team table and `measureVolatility` are what
 * every platform shares. The ESPN loader that used to live here is now the ESPN
 * adapter in platforms/espn.js, and which platform a league comes from is decided
 * by platforms/index.js. The loader names are re-exported at the bottom of this
 * file so its existing importers keep working (D-04).
 *
 * Nothing about any particular league is hardcoded: slot layout, roster size, team
 * count, regular-season length and playoff format are all read from the platform's
 * settings, and player eligibility comes from each player's own `eligibleSlots`.
 */

/** Slot ids -> display labels. Cosmetic only; the engine matches on ids. */
export const SLOT_LABEL = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP",
  16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BE", 21: "IR", 23: "FLEX", 24: "ER",
  // 22 and 25 are the two smallest ids ESPN leaves unused and BENCH_SLOTS does not
  // claim. CBS leagues can split D/ST into a defence and a special-teams slot, and
  // the engine needs an id per starting seat; these are theirs (D-12).
  22: "D", 25: "ST",
};
const POS_LABEL = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 7: "P",
                    9: "DT", 10: "DE", 11: "LB", 12: "CB", 13: "S", 16: "D/ST" };

/** Slots that accept several positions, so they never name one. */
const MULTI_SLOTS = new Set([3, 5, 7, 11, 14, 15, 23]);   // RB/WR, WR/TE, OP, DL, DB, DP, FLEX

/**
 * A player's display position, derived from the slots he may fill.
 *
 * `defaultPositionId` is unreliable - this league's team-QB entities do not carry
 * one that maps to anything, which showed up as "?" in the UI. Eligibility is the
 * authoritative signal and it is what the engine already uses, so the label should
 * come from the same place: the first single-position slot he is allowed to start
 * in. That yields TQB for team quarterbacks, and works for IDP and superflex too.
 */
export function positionLabel(player) {
  const elig = (player.eligibleSlots ?? []).filter(
    (s) => !MULTI_SLOTS.has(s) && s !== 20 && s !== 21 && s !== 24);
  for (const slot of elig.sort((a, b) => a - b)) {
    if (SLOT_LABEL[slot]) return SLOT_LABEL[slot];
  }
  return POS_LABEL[player.defaultPositionId] ?? "?";
}
export const PRO_TEAM = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
  22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH",
  29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

/**
 * Per-player weekly volatility, measured from last season rather than assumed.
 *
 * Each player carries `history: [{season, week, actual, proj}]`, built by the
 * platform adapter from whatever the platform reports. Where a prior season carries
 * both the projection and the points actually scored, the residual between them is
 * a real, league-scored measurement of how far a player lands from his projection.
 * No external data source is needed, and none would be better: this one is already
 * scored under the league's own rules. Rows are filtered on `season` - the same
 * scoring period exists in every season, and reading the wrong one measures low.
 *
 * Returns {bySigma: Map(playerId -> sigma), byPos: Map(pos -> sigma), global,
 * measured, residuals, byPosResiduals, mode, counts}. Players without enough
 * history fall back to their position, then to the global. `mode` is
 * "projection-residuals", "actuals-only" (the D-15 fallback below) or "none", and
 * `counts` says how many players each branch measured - the panel prints which,
 * because a sigma measured against a forecast and a sigma measured against a mean
 * are not the same claim and the user should not have to guess which he was shown.
 */
export function measureVolatility(players, priorSeason, minWeeks = 6) {
  const bySigma = new Map();
  const posSamples = new Map();
  const residuals = new Map();
  const posResiduals = new Map();
  const all = [];
  // Players measured through the D-15 fallback, and the position each was measured
  // in. Their sigmas are re-shrunk after the loop, once the priors exist.
  const actualsOnly = new Map();
  // Players the main loop found actuals for and no projection. Held, not measured:
  // the fallback is decided for the league after the loop, never per player.
  const pending = [];
  let nProjection = 0;

  /**
   * D-15: a platform that publishes what a player actually scored but never what it
   * projected him for still supports a measurement - just a weaker one. CBS reads
   * its history out of a points feed, so every CBS row carries `proj: null`; the
   * spread of a player's weekly scores around his own prior-season mean is then the
   * only volatility there is to measure.
   *
   * The decision is made for the *league*, not for a player. A per-player gate fired
   * on ESPN too - for any player ESPN scored last season but never published a
   * prior-season projection for, which is an ordinary rookie or late add - and pushed
   * a sigma measured around his own mean into the same posSamples and all that build
   * byPos and global. Those are the priors distribution.js's quantiles, rosterSigma,
   * P(win) and the season odds all inherit, so two different quantities were being
   * pooled into one number and ESPN's answers moved. The frozen fixture always carries
   * both sides of every history row, so no test could see it. The branch now runs only
   * when the league published no prior-season projection at all, which is the D-15 case
   * it was written for; an ESPN league with even one projected player takes the
   * original path, character for character.
   *
   * Two things differ from the projection branch. A zero week is dropped, because
   * with no projection beside it a zero and a bye are the same row and counting byes
   * measures availability rather than volatility - the projection branch does the
   * same job with its `proj > 1` gate. And the sigma is shrunk toward the positional
   * prior after the loop, where the projection branch shrinks a sigma not at all: a
   * spread taken around a mean estimated from the same seven numbers is a softer
   * claim than a spread around an independent forecast, and the season odds rest on
   * this number. The quantiles in distribution.js are shrunk by n/(n+10) either way;
   * this is the same weight applied to sigma, and only for the fallback.
   */
  const measureFromActuals = (p, act) => {
    const weeks = [...act.keys()].filter(w => act.get(w) > 0);
    if (!weeks.length) return;
    const vals = weeks.map(w => act.get(w));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const res = vals.map(v => v - mean);
    residuals.set(p.id, res);
    actualsOnly.set(p.id, p.pos);
    if (weeks.length >= minWeeks) {
      const sd = Math.sqrt(res.reduce((a, b) => a + b * b, 0) / (res.length - 1));
      bySigma.set(p.id, sd);
      all.push(sd);
      if (!posSamples.has(p.pos)) posSamples.set(p.pos, []);
      posSamples.get(p.pos).push(sd);
      if (!posResiduals.has(p.pos)) posResiduals.set(p.pos, []);
      posResiduals.get(p.pos).push(...res);
    }
  };

  for (const p of players) {
    const act = new Map(), prj = new Map();
    for (const h of p.history ?? []) {
      if (h.season !== priorSeason) continue;
      if (h.actual != null) act.set(h.week, h.actual);
      if (h.proj != null) prj.set(h.week, h.proj);
    }
    // Only weeks he was expected to play: a projection near zero means he was not
    // in the plan, and counting those measures roster churn rather than volatility.
    const weeks = [...act.keys()].filter(w => prj.has(w) && prj.get(w) > 1
      && act.get(w) != null && prj.get(w) != null);
    if (!weeks.length) {
      // Nothing to measure against a projection. Hold him: if the platform turns out
      // to have published no projection for anybody this season, the D-15 fallback
      // measures what it did publish. If it published projections and his were all at
      // or under a point, he was not in the plan and there is nothing here either way.
      if (prj.size === 0) pending.push([p, act]);
      continue;
    }
    nProjection++;
    const res = weeks.map(w => act.get(w) - prj.get(w));
    // Every player with any history keeps his residuals, even below minWeeks: the
    // quantiles are shrunk toward the positional prior by n/(n+n0), so a two-week
    // sample contributes almost nothing rather than nothing at all. Sigma keeps the
    // stricter gate, because a two-week standard deviation is noise, not a number.
    residuals.set(p.id, res);
    if (weeks.length >= minWeeks) {
      const mean = res.reduce((a, b) => a + b, 0) / res.length;
      const sd = Math.sqrt(res.reduce((a, b) => a + (b - mean) ** 2, 0) / (res.length - 1));
      bySigma.set(p.id, sd);
      all.push(sd);
      if (!posSamples.has(p.pos)) posSamples.set(p.pos, []);
      posSamples.get(p.pos).push(sd);
      // The prior a small sample is shrunk toward must not itself be made of small
      // samples, so the pooled positional residuals take only these players.
      if (!posResiduals.has(p.pos)) posResiduals.set(p.pos, []);
      posResiduals.get(p.pos).push(...res);
    }
  }
  // D-15, decided for the league: only a season with no projection anywhere in it
  // takes the fallback. Run before the medians, because these sigmas are part of the
  // prior in a league that has no other kind.
  if (nProjection === 0) for (const [p, act] of pending) measureFromActuals(p, act);
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const byPos = new Map([...posSamples].map(([k, v]) => [k, median(v)]));
  const global = median(all) ?? 6;
  // The D-15 shrink, applied here because it needs the priors the loop just built.
  // byPos and global stay the raw measurements: they are what everything else is
  // shrunk toward, and shrinking the prior toward itself would be circular.
  const N0 = 10;
  for (const [id, pos] of actualsOnly) {
    const sd = bySigma.get(id);
    if (sd == null) continue;
    const n = residuals.get(id).length;
    bySigma.set(id, (n * sd + N0 * (byPos.get(pos) ?? global)) / (n + N0));
  }
  const mode = nProjection ? "projection-residuals"
             : actualsOnly.size ? "actuals-only" : "none";
  return { bySigma, byPos, global, measured: bySigma.size,
           residuals, byPosResiduals: posResiduals,
           mode, counts: { projection: nProjection, actualsOnly: actualsOnly.size } };
}

// The ESPN loader, re-exported so panel.js, streaming.js, sources/stadiums.js and the
// tests that import these names from here keep working (D-04). platforms/espn.js
// imports positionLabel and PRO_TEAM back from this file - an import cycle that is
// safe only while espn.js reads no binding of this module at evaluation time.
export { parseLeagueUrl, sameSwid, mySwid, identifyTeam, readSettings,
         loadSchedule, loadFreeAgents, loadLeague } from "./platforms/espn.js";
