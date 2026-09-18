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

/**
 * Three callers want this file in one run - panel.js for availability, the projection
 * step for its crosswalk, the usage step for its own. Only the first is ever a
 * request; the other two were re-reading a five-megabyte blob out of storage and
 * rebuilding two twelve-thousand-entry Maps, twice, for an answer that had not moved.
 *
 * The memo is keyed on `r.at`, not on mere existence, so a TTL refresh mid-run is
 * still honoured. It is bypassed entirely whenever storage or fetch is injected,
 * because that is a test: a module-level cache that survived between cases would let
 * one test's feed answer another's.
 *
 * @returns { byEspn: Map<espnId, rec>, bySleeper: Map<sleeperId, rec>, at, fromCache }
 */
const MEMO_MS = 5 * 60e3;
let playersMemo = null;   // { madeAt, value }

export async function loadSleeperPlayers(opts = {}) {
  const injected = opts.storage != null || opts.fetchImpl != null;
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  // Short-circuit *before* cached(), not after: the expensive part is the storage read
  // that deserializes the trimmed blob, and returning the same Maps after paying for it
  // again would have saved almost nothing. Five minutes is far longer than a run and
  // far shorter than the file's one-day TTL, so nothing can go stale inside it.
  if (!injected && playersMemo && now - playersMemo.madeAt < MEMO_MS) return playersMemo.value;

  const r = await cached("src.sleeper.players", `${BASE}/players/nfl`, opts.ttlMs ?? DAY,
    { ...opts, transform: trimPlayers });
  const byEspn = new Map(), bySleeper = new Map();
  for (const rec of r.data) { byEspn.set(rec.espn_id, rec); bySleeper.set(rec.player_id, rec); }
  const value = { byEspn, bySleeper, at: r.at, fromCache: r.fromCache, stale: r.stale ?? false };
  if (!injected) playersMemo = { madeAt: now, value };
  return value;
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
