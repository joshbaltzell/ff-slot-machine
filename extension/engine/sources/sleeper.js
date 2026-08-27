/**
 * Sleeper's public API: free, keyless, CORS-open. Two things matter here:
 *
 *  - `/players/nfl` carries injury status, body part, practice participation and
 *    the ESPN id for every player, which makes it the crosswalk for every other
 *    feed as well as the injury source. It is ~5 MB, so it is trimmed to the
 *    fields we use before it is cached, and cached for a day (Sleeper's request).
 *  - `/players/nfl/trending/add|drop` is what the crowd is doing right now.
 */
import { cached } from "./cache.js";

const BASE = "https://api.sleeper.app/v1";
const DAY = 24 * 3600e3;

const FIELDS = ["player_id", "espn_id", "full_name", "position", "team", "status",
  "injury_status", "injury_body_part", "injury_notes", "injury_start_date",
  "practice_participation", "practice_description", "news_updated",
  "depth_chart_position", "depth_chart_order", "age", "years_exp"];

export function trimPlayers(raw) {
  const out = [];
  for (const p of Object.values(raw ?? {})) {
    if (!p || !p.espn_id) continue;
    const rec = {};
    for (const f of FIELDS) if (p[f] != null) rec[f] = p[f];
    rec.espn_id = Number(p.espn_id);
    out.push(rec);
  }
  return out;
}

/** @returns { byEspn: Map<espnId, rec>, bySleeper: Map<sleeperId, rec>, at, fromCache } */
export async function loadSleeperPlayers(opts = {}) {
  const r = await cached("src.sleeper.players", `${BASE}/players/nfl`, opts.ttlMs ?? DAY,
    { ...opts, transform: trimPlayers });
  const byEspn = new Map(), bySleeper = new Map();
  for (const rec of r.data) { byEspn.set(rec.espn_id, rec); bySleeper.set(rec.player_id, rec); }
  return { byEspn, bySleeper, at: r.at, fromCache: r.fromCache, stale: r.stale ?? false };
}

/** Crowd adds or drops across all Sleeper leagues. @returns [{player_id, count}] */
export async function loadTrending(kind = "add", { hours = 24, limit = 50, ...opts } = {}) {
  const r = await cached(`src.sleeper.trending.${kind}.${hours}`,
    `${BASE}/players/nfl/trending/${kind}?lookback_hours=${hours}&limit=${limit}`, opts.ttlMs ?? 3600e3, opts);
  return r.data;
}

/** Current NFL week/season as Sleeper sees it. */
export async function loadNflState(opts = {}) {
  const r = await cached("src.sleeper.state", `${BASE}/state/nfl`, opts.ttlMs ?? 3600e3, opts);
  return r.data;
}
