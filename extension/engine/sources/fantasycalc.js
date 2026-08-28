/**
 * FantasyCalc: values derived from real completed trades across thousands of
 * leagues, published as open, keyless, CORS-open JSON and - the part that matters -
 * keyed on `espnId`, so it joins straight onto our player map with no name matching.
 *
 * This is the only feed here whose numbers are NOT ours: they are what the humans on
 * the other side of a trade have in their heads. They are display and ranking only
 * and must never reach the search.
 *
 * The request carries three integers describing the league's shape and nothing else -
 * no league id, no team, no roster. There is nothing here to leak.
 */
import { cached } from "./cache.js";

const BASE = "https://api.fantasycalc.com/values/current";
const HALF_DAY = 12 * 3600e3;

/**
 * Snap to the nearest offered value. A tie keeps the incumbent, so ties resolve
 * DOWNWARD: a 9-team league is priced as an 8-team one. That is the conservative
 * direction - a shallower league undervalues depth rather than overvaluing it.
 */
const nearest = (v, offered) =>
  offered.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

const TEAM_COUNTS = [8, 10, 12, 14];
const PPR = [0, 0.5, 1];

/**
 * FantasyCalc publishes one table per (numQbs, numTeams, ppr) combination. Pick the
 * closest one to this league.
 *
 * numQbs is 2 when a lineup can start two quarterbacks: either two dedicated QB
 * slots (ESPN slot 0) or an OP/superflex slot (slot 7). Slot 1 is TQB - a team
 * quarterback, one per lineup - so a TQB league is a 1QB market.
 */
export function marketParams(settings, teamCount) {
  const counts = settings?.lineupSlotCounts ?? {};
  const numQbs = (counts[0] ?? 0) >= 2 || (counts[7] ?? 0) > 0 ? 2 : 1;
  return {
    numQbs,
    numTeams: nearest(Number(teamCount) || 10, TEAM_COUNTS),
    ppr: nearest(Number(settings?.pprValue) || 0, PPR),
  };
}

export function marketUrl(settings, teamCount) {
  const p = marketParams(settings, teamCount);
  return `${BASE}?isDynasty=false&numQbs=${p.numQbs}&numTeams=${p.numTeams}&ppr=${p.ppr}`;
}

/**
 * Keep the seven fields we use. FantasyCalc nests identity under `player` and
 * prefixes optional fields with `maybe`; a row with no `player.espnId` cannot be
 * joined to anything of ours, so it is dropped - the same rule `trimPlayers` applies
 * to Sleeper rows with no `espn_id`.
 */
export function trimValues(raw) {
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const p = row?.player ?? {};
    const espnId = Number(p.espnId ?? p.espn_id);
    if (!Number.isFinite(espnId)) continue;
    out.push({
      espnId,
      value: Number(row.value ?? 0),
      overallRank: Number(row.overallRank) || null,
      positionRank: Number(row.positionRank) || null,
      trend30Day: Number(row.trend30Day) || 0,
      tier: row.maybeTier ?? row.tier ?? null,
      name: String(p.name ?? ""),
      pos: String(p.position ?? ""),
    });
  }
  return out;
}

/**
 * @returns { byEspn: Map<espnId, entry>, params, at, fromCache, stale }
 *          Throws when the feed fails and no cached copy exists - the caller
 *          (`marketOrNull` in panel/market.js) is what turns that into a dash.
 */
export async function loadMarket(settings, teamCount, opts = {}) {
  const params = marketParams(settings, teamCount);
  // The parameters are part of the key: a 12-team full-PPR table must not be served
  // from a 10-team half-PPR cache entry.
  const key = `src.fantasycalc.${params.numQbs}q.${params.numTeams}t.${params.ppr}p`;
  const r = await cached(key, marketUrl(settings, teamCount), opts.ttlMs ?? HALF_DAY,
    { ...opts, transform: trimValues });
  const byEspn = new Map();
  // Last-wins on a duplicate espnId. FantasyCalc has not been observed to publish
  // one player twice in a table; if it ever does, this silently keeps the last
  // entry rather than failing loudly.
  for (const rec of r.data ?? []) byEspn.set(rec.espnId, rec);
  return { byEspn, params, at: r.at, fromCache: r.fromCache, stale: r.stale ?? false };
}
