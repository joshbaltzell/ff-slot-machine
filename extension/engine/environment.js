/**
 * The game a projection is for, not just the player it is about.
 *
 * A weekly projection is an average over the distribution of games a player might
 * play. The betting market prices the *specific* game: a team implied for 28 points
 * and a team implied for 16 do not deserve the same projection however similar their
 * season averages, and a kicker in a 30 mph crosswind is not the kicker his
 * projection describes.
 *
 * Applied as one multiplicative factor per player-week, to `p.proj[w]`, in place -
 * the same seam `calibrate.js` uses, one step later. Order matters and is
 * deliberate: shrinkage is about how far a projection should be from its positional
 * mean, this is about which game it is for, and the two compose.
 *
 * The coefficients are deliberately small. The market is far better at predicting a
 * *game* than a *player*: most of an implied-total edge is already inside a
 * projection ESPN built from the same information. These numbers move the projection
 * by the part that is not, and they clamp hard, because the failure mode that
 * matters is turning a plausible starter into an unstartable one on a bad line read.
 *
 * Scope: the current week and the next. A line does not exist past that, and a
 * season-long trade evaluation must not be tilted by two weeks of weather - which is
 * why the factors never touch any other week.
 *
 * What "input adjustment" does and does not mean. The factor is folded into `proj`
 * BEFORE the Engine is built, so everything downstream reads the adjusted number:
 * the lineup solver, `sideMetrics`, `projectSeason`, `attachOdds`, the leverage
 * strip. That is the entire point of this seam. What nothing downstream carries is a
 * *separate* environment term, and no slot decision keys on one - the solver still
 * runs on `eligibleSlots` alone, and sees only a number that is already correct.
 *
 * The blast radius is bounded by the averaging on the other side. `sideMetrics`
 * (search.js) reports `gain` as the mean over every week in the model - 17 in a full
 * season - and `reg` as the mean over the regular-season weeks alone, normally 14. So
 * moving two weeks shifts a season-long trade metric by at most 2/17 of the per-week
 * swing; the short-horizon views - this week's lineup, the streaming planner - are
 * where it is meant to be felt.
 */
import { PRO_TEAM_ID } from "./sources/stadiums.js";

/** Every constant in this file, in one table, so they can be read in one place. */
export const ENV_K = {
  /** No factor may ever leave this range, whatever the inputs say. */
  clamp: { lo: 0.6, hi: 1.4 },
  /** Sensitivity to the gap between a team's implied total and the week's average. */
  vegas: { dst: 0.6, k: 0.4, pass: 0.25, rb: 0.15 },
  /**
   * Sustained wind in mph -> multiplier, thresholds descending. The FIRST match
   * wins and the rest are skipped: a 30 mph wind is a 0.80, not a 0.80 x 0.90.
   */
  wind: { k: [[25, 0.80], [15, 0.90]], pass: [[20, 0.95]] },
  /** Precipitation probability in percent (inclusive) -> multiplier. */
  precip: { pass: [70, 0.95] },
};

/**
 * Position label -> factor group.
 *
 * `pos` is display-only for lineup purposes: the solver decides who starts entirely
 * from `eligibleSlots`, never from this string. But `pos` already picks coefficients
 * elsewhere - `calibrate.js`'s shrinkage slope, the positional-median volatility
 * fallback in `league.js` and `search.js` - and this function is another one of
 * those, not a new kind of exception. It is acceptable because it only ever chooses
 * a multiplier, never a slot. If this ever grows into a lineup decision, move it
 * onto slots first.
 *
 * There is a stronger justification than "it only picks a coefficient", and it is
 * worth writing down: `positionLabel` in `league.js` derives `pos` FROM
 * `eligibleSlots` in the first place - it is the first single-position slot a player
 * may start in, with `defaultPositionId` only as a last-resort fallback. So
 * `envGroup(p.pos)` is transitively slot-keyed. It is not a second source of truth
 * about what a player is; it is the slot table read through one indirection.
 *
 * TQB is ESPN's team-quarterback entity and belongs with the quarterbacks: it is
 * scored on the same plays, so the same implied-total sensitivity applies.
 */
export function envGroup(pos) {
  switch (pos) {
    case "D/ST": return "dst";
    case "K":    return "k";
    case "QB": case "TQB": case "WR": case "TE": return "pass";
    case "RB":   return "rb";
    default:     return null;    // punters, coaches, IDP: no factor, no guessing
  }
}

const clamp = (v) => Math.min(ENV_K.clamp.hi, Math.max(ENV_K.clamp.lo, v));

/** Mean implied team total over a week's priced games. 0 when nothing is priced. */
export function avgImplied(weekMap) {
  let s = 0, n = 0;
  for (const g of (weekMap ?? new Map()).values()) if (g?.implied > 0) { s += g.implied; n++; }
  return n ? s / n : 0;
}

/**
 * @param group one of ENV_K.vegas's keys, or null
 * @param game  a row from `loadVegas`
 * @param avg   `avgImplied` for the same week
 */
export function vegasFactor(group, game, avg) {
  const k = ENV_K.vegas[group];
  if (!k || !game || !(avg > 0)) return 1;
  // A defence's edge is its opponent's total, inverted: the fewer points the other
  // side is expected to score, the better the defence's week.
  const edge = group === "dst"
    ? (avg - game.oppImplied) / avg
    : (game.implied - avg) / avg;
  return clamp(1 + k * edge);
}

/** @param wx a row from `loadWeather`, or null when the roof is shut or the feed is dead. */
export function weatherFactor(group, wx) {
  if (!wx) return 1;
  let f = 1;
  for (const [mph, mult] of ENV_K.wind[group] ?? []) {
    if (wx.wind > mph) { f *= mult; break; }     // descending; the first match is the answer
  }
  const p = ENV_K.precip[group];
  if (p && wx.precipProb >= p[0]) f *= p[1];
  return clamp(f);
}

/**
 * Scale `p.proj[w]` by the week's environment factor, in place.
 *
 * Only the weeks passed in are touched, and only where a line exists. A week with no
 * priced games leaves every projection exactly as it was, which is what makes a dead
 * feed a no-op rather than a distortion.
 *
 * @param model   {players: Map} from `loadLeague`
 * @param vegas   Map<week, Map<proTeamId, Game>> from `loadVegas`
 * @param weather Map<proTeamId, wx> from `loadWeather`, for ONE week
 * @param weeks   the weeks to adjust, normally [currentWeek, currentWeek + 1]
 * @param opts    { enabled = true, weatherWeek = weeks[0] }
 * @returns {{adjusted: number, byPlayer: Map}} - `byPlayer` is what the UI shows.
 *          A `byPlayer` entry records a player-week that had a GROUP and a LINE, not
 *          one that was changed: a factor of exactly 1 is recorded too, and so is a
 *          player whose `proj` was zero. `adjusted` is the narrower count - the
 *          player-weeks whose number actually moved.
 */
export function applyEnvironment(model, vegas, weather, weeks, opts = {}) {
  const byPlayer = new Map();
  if (opts.enabled === false) return { adjusted: 0, byPlayer };

  const weatherWeek = opts.weatherWeek ?? weeks[0];
  const avg = new Map(weeks.map((w) => [w, avgImplied(vegas?.get(w))]));
  let adjusted = 0;

  for (const p of model.players.values()) {
    const group = envGroup(p.pos);
    if (!group) continue;
    const teamId = PRO_TEAM_ID[p.nfl];
    if (!teamId) continue;

    for (const w of weeks) {
      const game = vegas?.get(w)?.get(teamId);
      if (!game) continue;                       // bye, or this week is not priced
      const wx = w === weatherWeek ? (weather?.get(teamId) ?? null) : null;
      const v = vegasFactor(group, game, avg.get(w));
      const x = weatherFactor(group, wx);
      const f = clamp(v * x);

      if (p.proj[w] > 0 && f !== 1) {
        p.proj[w] = Math.round(p.proj[w] * f * 100) / 100;
        adjusted++;
      }
      const rec = byPlayer.get(p.id) ?? { vegas: 1, weather: 1, factor: 1, weeks: {} };
      rec.weeks[w] = { vegas: v, weather: x, factor: f, implied: game.implied,
                       oppImplied: game.oppImplied, total: game.total, wx };
      if (w === weeks[0]) { rec.vegas = v; rec.weather = x; rec.factor = f; }
      byPlayer.set(p.id, rec);
    }
  }
  return { adjusted, byPlayer };
}
