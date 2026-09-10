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
 * ESPN returns the prior season's ACTUAL weekly scores (statSourceId 0) in the same
 * response as its projections (statSourceId 1), so the residual between them is a
 * real, league-scored measurement of how far a player lands from his projection.
 * No external data source is needed, and none would be better: this one is already
 * scored under the league's own rules.
 *
 * Returns {bySigma: Map(playerId -> sigma), byPos: Map(pos -> sigma), global}.
 * Players without enough history fall back to their position, then to the global.
 */
export function measureVolatility(players, priorSeason, minWeeks = 6) {
  const bySigma = new Map();
  const posSamples = new Map();
  const residuals = new Map();
  const posResiduals = new Map();
  const all = [];

  for (const p of players) {
    const act = new Map(), prj = new Map();
    for (const st of p.rawStats ?? []) {
      if (st.statSplitTypeId !== 1 || st.seasonId !== priorSeason) continue;
      if (st.statSourceId === 0) act.set(st.scoringPeriodId, st.appliedTotal);
      else if (st.statSourceId === 1) prj.set(st.scoringPeriodId, st.appliedTotal);
    }
    // Only weeks he was expected to play: a projection near zero means he was not
    // in the plan, and counting those measures roster churn rather than volatility.
    const weeks = [...act.keys()].filter(w => prj.has(w) && prj.get(w) > 1
      && act.get(w) != null && prj.get(w) != null);
    if (!weeks.length) continue;
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
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const byPos = new Map([...posSamples].map(([k, v]) => [k, median(v)]));
  return { bySigma, byPos, global: median(all) ?? 6, measured: bySigma.size,
           residuals, byPosResiduals: posResiduals };
}

// The ESPN loader, re-exported so panel.js, streaming.js, sources/stadiums.js and the
// tests that import these names from here keep working (D-04). platforms/espn.js
// imports positionLabel and PRO_TEAM back from this file - an import cycle that is
// safe only while espn.js reads no binding of this module at evaluation time.
export { parseLeagueUrl, sameSwid, mySwid, identifyTeam, readSettings,
         loadSchedule, loadFreeAgents, loadLeague } from "./platforms/espn.js";
