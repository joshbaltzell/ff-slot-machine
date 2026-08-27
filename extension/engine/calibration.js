/**
 * The calibration log: this league's own projection error, measured over time.
 *
 * `CALIBRATION_K` in `calibrate.js` holds slopes measured across other people's
 * leagues over twelve seasons. They are the best available prior, but they are not
 * this league's numbers: the slope of actual on projected depends on the scoring
 * rules, and this league has its own. Nobody else can measure it either — it needs
 * the projection as it stood *before* the week alongside the points the league
 * actually awarded, and only something running here each week has both.
 *
 * So each run appends one row per player for the current week — every source's
 * number and the aggregate — and each later run joins ESPN's own actuals to the
 * weeks that have since been played. Once six weeks carry actuals the fitted slopes
 * replace the constants.
 *
 * This is the only league-specific model in the extension, and it lives entirely in
 * `chrome.storage.local` under `ffsm.calib.{leagueId}.{seasonId}`. It is never sent
 * anywhere; there is nowhere to send it.
 *
 * `pos` groups the regressions because the slope genuinely differs by position (a
 * quarterback's projection is tighter than a tight end's). It is not lineup logic.
 *
 * Storage is injected as `{storage}`, like the source layer, so tests use a Map.
 */
import { CALIBRATION_K } from "./calibrate.js";

export const FIT_POS = ["QB", "RB", "WR", "TE"];
export const MIN_WEEKS = 6;          // fewer, and the fit is noise
export const MIN_N = 20;             // per position
export const SLOPE_CLAMP = [0.3, 1.2];
const SOURCES = ["espn", "sleeper", "fp", "agg"];

export const logKey = (leagueId, seasonId) => `ffsm.calib.${leagueId}.${seasonId}`;

/**
 * Append (or replace) one week. `rows` are `{id, pos, espn, sleeper, fp, agg}`.
 * `id` and `pos` are not decoration: without `id` the actuals cannot be joined, and
 * without `pos` nothing can be grouped.
 */
export async function logWeek({ storage, leagueId, seasonId, week, rows, now = Date.now() }) {
  const key = logKey(leagueId, seasonId);
  const log = (await storage.get(key))[key] ?? { weeks: {} };
  if (!log.weeks) log.weeks = {};
  log.weeks[String(week)] = { at: now, rows: rows ?? [] };
  await storage.set({ [key]: log });
  return log;
}

export async function loadLog({ storage, leagueId, seasonId }) {
  const key = logKey(leagueId, seasonId);
  const log = (await storage.get(key))[key];
  return log && log.weeks ? log : { weeks: {} };
}

export const weeksStored = (log) => Object.keys(log?.weeks ?? {}).length;

export const weeksWithActuals = (log) => Object.values(log?.weeks ?? {})
  .filter((e) => (e.rows ?? []).some((r) => Number.isFinite(r.actual))).length;

/**
 * Fill `actual` on every logged row from ESPN's own weekly scores.
 *
 * `statSourceId: 0` is the actual, `1` is the projection, and ESPN returns the prior
 * season's rows for the same scoring period in the same payload — so `seasonId` is
 * part of the match, not an optional extra. Matching without it reads last season.
 *
 * @param players Map<id, {rawStats}> or an iterable of player records
 * @returns {{log, filled}} — mutates the rows in `log`
 */
export function attachActuals(log, players, seasonId) {
  const byId = players instanceof Map
    ? players
    : new Map([...(players ?? [])].map((p) => [p.id, p]));
  let filled = 0;
  for (const [wk, entry] of Object.entries(log?.weeks ?? {})) {
    const w = Number(wk);
    for (const r of entry.rows ?? []) {
      if (Number.isFinite(r.actual)) { filled++; continue; }
      const p = byId.get(r.id);
      if (!p) continue;
      const st = (p.rawStats ?? []).find((x) => x.statSourceId === 0 && x.statSplitTypeId === 1
        && x.seasonId === seasonId && x.scoringPeriodId === w);
      if (st && Number.isFinite(st.appliedTotal)) {
        r.actual = Math.round(st.appliedTotal * 100) / 100;
        filled++;
      }
    }
  }
  return { log, filled };
}

/** OLS slope of y on x, with an intercept. null when x has no spread. */
function slopeOf(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (const [x, y] of pairs) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  return sxx > 0 ? sxy / sxx : null;
}

function pairsFor(log, column, pos) {
  const out = [];
  for (const entry of Object.values(log?.weeks ?? {}))
    for (const r of entry.rows ?? []) {
      if (pos != null && (r.pos ?? "") !== pos) continue;
      if (!Number.isFinite(r.actual)) continue;
      const x = r[column];
      // The `x > 0` test conditions on the REGRESSOR, which does not bias an OLS
      // slope. It drops byes and inactives, whose (0, 0) pairs would otherwise pile
      // a mass point on the origin and drag the fitted slope toward 1.
      if (!Number.isFinite(x) || !(x > 0)) continue;
      out.push([x, r.actual]);
    }
  return out;
}

/**
 * One row per source × position: how wrong it has been, which way, and by how much
 * it is over-spread. `slope` is null when the projections in that cell do not vary.
 *
 * `bias` is `mean(actual - projected)`, so a POSITIVE bias means the source projects
 * LOW. The UI renders this number; an inverted label is easy to introduce and hard
 * to notice, so the convention is written down rather than inferred.
 */
export function summary(log) {
  const rows = [];
  const positions = new Set();
  for (const entry of Object.values(log?.weeks ?? {}))
    for (const r of entry.rows ?? []) if (Number.isFinite(r.actual)) positions.add(r.pos ?? "?");
  for (const source of SOURCES)
    for (const pos of [...positions].sort()) {
      const pairs = pairsFor(log, source, pos);
      if (!pairs.length) continue;
      const n = pairs.length;
      const mae = pairs.reduce((a, [x, y]) => a + Math.abs(y - x), 0) / n;
      const bias = pairs.reduce((a, [x, y]) => a + (y - x), 0) / n;
      const slope = slopeOf(pairs);
      rows.push({ source, pos, n,
        mae: Math.round(mae * 100) / 100,
        bias: Math.round(bias * 100) / 100,
        slope: slope == null ? null : Math.round(slope * 1000) / 1000 });
    }
  return rows;
}

/**
 * The shrinkage slopes this league has actually earned.
 *
 * Fitted on the `agg` column, because that is the number `shrinkProjections` will
 * shrink. With the aggregate off, `agg` equals `espn`, so the column is always the
 * right one.
 *
 * @returns {{QB,RB,WR,TE}} with a number or null per position, or null overall when
 *          fewer than `minWeeks` weeks carry actuals. Slopes are clamped: a fit
 *          outside [0.3, 1.2] is measurement noise or a scoring change, not a real
 *          slope, and applying it would be worse than the literature constant.
 *
 * Only the slope is applied; the intercept is fitted and then deliberately thrown
 * away, because `shrinkProjections` re-centres on the projected positional mean —
 * which is what `CALIBRATION_K` means. A level bias is measured and displayed by
 * `summary`, but applying it here would double-count the re-centring. That is a
 * decision, not an oversight.
 */
export function fitSlopes(log, { column = "agg", minWeeks = MIN_WEEKS, minN = MIN_N } = {}) {
  if (weeksWithActuals(log) < minWeeks) return null;
  const out = {};
  for (const pos of FIT_POS) {
    const pairs = pairsFor(log, column, pos);
    const b = pairs.length >= minN ? slopeOf(pairs) : null;
    out[pos] = b == null ? null
      : Math.round(Math.min(SLOPE_CLAMP[1], Math.max(SLOPE_CLAMP[0], b)) * 1000) / 1000;
  }
  return out;
}

/** Fitted where measured, literature where not. The map `shrinkProjections` wants. */
export function mergeSlopes(fitted) {
  const k = { ...CALIBRATION_K };
  if (!fitted) return { k, fitted: false, positions: [] };
  const positions = [];
  for (const pos of FIT_POS) if (Number.isFinite(fitted[pos])) { k[pos] = fitted[pos]; positions.push(pos); }
  return { k, fitted: positions.length > 0, positions };
}
