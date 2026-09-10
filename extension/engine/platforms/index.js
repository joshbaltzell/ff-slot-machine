/**
 * The platform registry. Which site a league lives on is decided here and nowhere
 * downstream: an adapter turns a platform's own API into the normalized model the
 * engine has always consumed, and the engine never learns a second platform exists.
 *
 * No fetch, no chrome.*, no DOM at module load - panel.js, background.js (as a
 * module service worker) and the Node tests all import this file.
 *
 * The adapter contract (D-03), implemented by every entry in PLATFORMS:
 *
 *   adapter = {
 *     id: "espn" | "cbs",
 *     label: "ESPN" | "CBS",
 *     hosts: string[],                       // manifest host_permissions this adapter needs
 *     acceptsToken: boolean,                 // true when a user-pasted API token is a sanctioned fallback (CBS only)
 *     signInUrl(ref) -> string,              // where the sign-in error links; ESPN returns "https://fantasy.espn.com"
 *     parseLeagueUrl(url) -> { leagueId, seasonId, teamId } | null,   // detect() stamps platform
 *     loadLeague(ref, onProgress = () => {}, opts = {}) -> model,
 *     loadFreeAgents(ref, weeks, opts = {}) -> player[],
 *     loadSchedule(ref, teamsById, opts = {}) -> Map<week, [[homeName, awayName]]>,
 *     identify(ref, model, opts = {}) -> { team: string|null, how: string|null },
 *     fingerprint(ref, opts = {}) -> string|null,   // ONE light request; hashRosters over platform-native ids; null on any failure
 *   }
 *   opts   = { fetchImpl = globalThis.fetch, storage, now, ... }   // injection for offline tests (cache.js idiom)
 *   ref    = { platform, leagueId, seasonId, teamId?, session? }  // session is in-memory only and is never written to storage
 *   model  = { settings, weeks, players: Map<id, player>, teams: Map<id, team>, fingerprint: string|null, notes: string[] }
 *            // settings/players/teams keys exactly as the ESPN adapter emits them; notes are adapter log lines the panel prints verbatim
 *   Errors: "not signed in / no access" -> throw Object.assign(new Error(message), { code: "AUTH" }); anything else throws a plain Error.
 *
 * Adapters must not import from this file: it reads their default exports while it
 * evaluates. The one thing they share, hashRosters, lives in ./hash.js for that
 * reason and is re-exported here for everyone else.
 */
import espn from "./espn.js";
export { hashRosters } from "./hash.js";

/** Every adapter, in detection order. 11-05 appends cbs. */
export const PLATFORMS = [espn];

/** The adapter with this id, or null. */
export const byId = (id) => PLATFORMS.find((p) => p.id === id) ?? null;

/** The ref for a league URL with `platform` stamped, or null when no adapter claims it. */
export function detect(url) {
  for (const p of PLATFORMS) {
    const ref = p.parseLeagueUrl(url);
    if (ref) return { ...ref, platform: p.id };
  }
  return null;
}
