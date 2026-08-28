/**
 * Sleeper's weekly box score - the opportunity numbers the ESPN league API does not
 * carry. Snaps, targets, air yards, carries and dropbacks lead the box score by a
 * week or two, which is why this feed exists: it is what the projection has not
 * caught up with yet.
 *
 * One request per PLAYED week. A finished week never changes, so it is cached for a
 * week; the most recently played week is still being corrected, so it gets six hours.
 * Sleeper is CORS-open, keyless and asks only that you do not hammer it, so the weeks
 * go out four at a time.
 *
 * Sleeper has served this endpoint in two shapes over its life: an array of
 * `{player_id, team, stats}` entries, and a bare object keyed by player id. There is
 * no way to check from here which one is live, and reading the wrong one produces a
 * silently empty usage table. `trimStats` accepts both; it costs six lines.
 */
import { cached } from "./cache.js";

const BASE = "https://api.sleeper.app";
const DAY = 24 * 3600e3;
const FRESH = 6 * 3600e3;

export const POS = ["QB", "RB", "WR", "TE"];

/** Everything the usage math reads, and nothing else. The raw rows carry ~90 fields. */
export const STAT_FIELDS = ["off_snp", "tm_off_snp", "rec_tgt", "rec_air_yd", "rush_att",
  "pass_att", "rec", "rec_td", "rush_td", "pts_ppr", "pts_half_ppr", "pts_std"];

export function weekUrl(season, week) {
  return `${BASE}/stats/nfl/${season}/${week}?season_type=regular&`
    + POS.map((p) => `position[]=${p}`).join("&");
}

/** @returns [{player_id, team?, ...STAT_FIELDS}] - rows with no usable stat are dropped. */
export function trimStats(raw) {
  const out = [];
  const push = (sid, stats, team) => {
    if (sid == null || !stats || typeof stats !== "object") return;
    const rec = { player_id: String(sid) };
    let any = false;
    for (const f of STAT_FIELDS) {
      if (stats[f] == null) continue;
      const v = Number(stats[f]);
      if (Number.isFinite(v)) { rec[f] = v; any = true; }
    }
    if (!any) return;
    if (team) rec.team = String(team);
    out.push(rec);
  };
  if (Array.isArray(raw)) {
    for (const e of raw) {
      push(e?.player_id ?? e?.player?.player_id, e?.stats ?? e,
           e?.team ?? e?.player?.team ?? null);
    }
  } else {
    for (const [sid, v] of Object.entries(raw ?? {})) push(sid, v?.stats ?? v, v?.team ?? null);
  }
  return out;
}

/** One played week. `fresh` shortens the TTL for the week that is still being corrected. */
export async function loadWeekStats(season, week, { fresh = false, ...opts } = {}) {
  const r = await cached(`src.sleeper.stats.${season}.${week}`, weekUrl(season, week),
    opts.ttlMs ?? (fresh ? FRESH : 7 * DAY), { ...opts, transform: trimStats });
  return { week, rows: r.data, at: r.at, fromCache: r.fromCache, stale: r.stale ?? false };
}

/**
 * Every week already played. A week that fails is reported in `failed` and simply
 * missing from `byWeek`: one bad week costs a little precision, not the feature.
 */
export async function loadSeasonStats(season, currentWeek, opts = {}) {
  const now = Number(currentWeek) || 1;
  const weeks = [];
  for (let w = 1; w < now; w++) weeks.push(w);
  const byWeek = new Map(), failed = [];
  let at = 0;
  const N = opts.concurrency ?? 4;
  for (let i = 0; i < weeks.length; i += N) {
    const batch = weeks.slice(i, i + N);
    const res = await Promise.allSettled(batch.map((w) =>
      loadWeekStats(season, w, { ...opts, fresh: w >= now - 1 })));
    res.forEach((r, k) => {
      if (r.status === "fulfilled") {
        byWeek.set(batch[k], new Map(r.value.rows.map((x) => [x.player_id, x])));
        at = Math.max(at, r.value.at ?? 0);
      } else failed.push(batch[k]);
    });
  }
  return { byWeek, weeks: [...byWeek.keys()], failed, at };
}
