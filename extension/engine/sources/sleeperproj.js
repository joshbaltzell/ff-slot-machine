/**
 * Sleeper's weekly projections (RotoWire's numbers), free and CORS-open.
 *
 * One call per remaining week, which is why they are cached for six hours and
 * fetched three at a time: this is a public feed being read on someone's behalf and
 * it should stay gentle enough to look like it. The response is trimmed to the three
 * scoring columns before it is cached — the raw payload is ~600 rows of full player
 * objects per week.
 *
 * Points come out keyed by ESPN player id, joined through the crosswalk in
 * `sleeper.js` (`loadSleeperPlayers().bySleeper`), because ESPN ids are what the
 * model is keyed on. Nothing but the season and the week goes over the wire.
 */
import { cached } from "./cache.js";

const BASE = "https://api.sleeper.app/projections/nfl";     // note: no /v1 here
const SIX_HOURS = 6 * 3600e3;
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const COLUMNS = ["pts_ppr", "pts_half_ppr", "pts_std"];

export function weekUrl(season, week) {
  const pos = POSITIONS.map((p) => `position[]=${p}`).join("&");
  return `${BASE}/${season}/${week}?season_type=regular&${pos}&order_by=pts_ppr`;
}

/**
 * Which of Sleeper's three scoring columns is closest to this league, from the
 * league's own points-per-reception setting. Nearest of 1 / 0.5 / 0.
 */
export function pprColumn(pprValue) {
  const v = Number(pprValue ?? 0);
  const options = [[1, "pts_ppr"], [0.5, "pts_half_ppr"], [0, "pts_std"]];
  let best = "pts_std", bestGap = Infinity;
  for (const [value, name] of options) {
    const gap = Math.abs((Number.isFinite(v) ? v : 0) - value);
    if (gap < bestGap) { bestGap = gap; best = name; }
  }
  return best;
}

/** Keep the id and the three scoring columns; drop everything else before caching. */
export function trimWeek(raw) {
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const id = row?.player_id ?? row?.player?.player_id;
    const stats = row?.stats;
    if (id == null || !stats) continue;
    const rec = { player_id: String(id) };
    let any = false;
    for (const c of COLUMNS) if (Number.isFinite(stats[c])) { rec[c] = stats[c]; any = true; }
    if (any) out.push(rec);
  }
  return out;
}

/**
 * @param weeks       the remaining weeks, one request each
 * @param bySleeper   Map<sleeperId, {espn_id}> from loadSleeperPlayers()
 * @param onProgress  (done, total, label)
 * @returns { byWeek: Map<week, Map<espnId, points>>, weeks, covered, failed }
 *          A week whose fetch fails is absent from `byWeek` and listed in `failed`;
 *          nothing throws, because a missing week must not cost the whole feature.
 */
export async function loadSleeperProjections({ season, weeks = [], pprValue = 0, bySleeper,
                                               onProgress = () => {}, concurrency = 3, ...opts } = {}) {
  const column = pprColumn(pprValue);
  const byWeek = new Map();
  const failed = [];
  const list = [...weeks];
  let done = 0;

  const one = async (wk) => {
    try {
      const r = await cached(`src.sleeperproj.${season}.${wk}`, weekUrl(season, wk),
        opts.ttlMs ?? SIX_HOURS, { ...opts, transform: trimWeek });
      const m = new Map();
      for (const row of r.data ?? []) {
        const espn = bySleeper?.get(row.player_id)?.espn_id;
        if (espn == null) continue;
        // The chosen column first. Sleeper always publishes all three for offence,
        // but a defence or kicker row can carry only one; a slightly different
        // reception weight beats dropping the player out of the average entirely.
        let pts = row[column];
        if (!Number.isFinite(pts)) for (const c of COLUMNS) if (Number.isFinite(row[c])) { pts = row[c]; break; }
        if (!(pts > 0)) continue;
        m.set(espn, pts);
      }
      byWeek.set(wk, m);
    } catch {
      failed.push(wk);
    }
    onProgress(++done, list.length, `week ${wk}`);
  };

  for (let i = 0; i < list.length; i += Math.max(1, concurrency))
    await Promise.all(list.slice(i, i + Math.max(1, concurrency)).map(one));

  const covered = new Set();
  for (const m of byWeek.values()) for (const id of m.keys()) covered.add(id);
  return { byWeek, weeks: [...byWeek.keys()].sort((a, b) => a - b), covered: covered.size, failed };
}
