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
 *     fingerprint(ref, opts = {}) -> string|null,   // one light READ (a session probe may cost more); hashRosters over platform-native ids; null on any failure
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
import cbs from "./cbs.js";
export { hashRosters } from "./hash.js";

/** Every adapter, in detection order. */
export const PLATFORMS = [espn, cbs];

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

/* ---------- storage keys (D-08) ---------- */

/**
 * The key a league's record lives under: five segments, the platform first. That
 * segment is what keeps ESPN league 1234 and a CBS league whose slug happens to be
 * "1234" apart. Built from the triple alone - a session or a team id never reaches it.
 */
export const leagueKey = (ref) => `ffsm.league.${ref.platform}.${ref.leagueId}.${ref.seasonId}`;

/** A pre-11-04 key: exactly four segments, a dotless id and a four-digit season. */
const LEGACY_KEY = /^ffsm\.(league|calib)\.([^.]+)\.(\d{4})$/;

/**
 * Rewrite the legacy four-segment keys as five-segment espn keys, once.
 *
 * `storage` is chrome.storage.local or the tests' Map: get(null) for everything,
 * set(obj), remove(key). A league record is rewritten with `rosterHash: null` and
 * `changed: false` and gains its `ref`, so the daily check adopts the first hash it
 * computes instead of comparing against one a different function produced - the
 * upgrade must never light the badge on an unchanged roster. A calibration log moves
 * as it is. When the new key already exists (the panel ran first) its value wins.
 * Idempotent: a five-segment key never matches, so a second call migrates 0.
 *
 * @returns {{migrated: number}} legacy keys retired
 */
export const migrateStorageKeys = async (storage) => {
  const all = (await storage.get(null)) ?? {};
  let migrated = 0;
  for (const [key, old] of Object.entries(all)) {
    const m = LEGACY_KEY.exec(key);
    if (!m) continue;
    const [, kind, id, season] = m;
    const newKey = `ffsm.${kind}.espn.${id}.${season}`;
    if (!(newKey in all)) {
      const value = kind === "league"
        ? { ...old, rosterHash: null, changed: false,
            ref: { platform: "espn", leagueId: Number(id), seasonId: Number(season) } }
        : old;
      await storage.set({ [newKey]: value });
    }
    await storage.remove(key);
    migrated++;
  }
  return { migrated };
};

/**
 * The league record after one daily check, given the hash the adapter just computed.
 * Pure, so the service worker's one decision can be tested without a worker.
 *
 *   hash null        -> the request failed; the record is returned untouched
 *   no rosterHash    -> adopt: this is the first hash the record has seen (a migrated
 *                       record, or a run whose own fingerprint request failed)
 *   otherwise        -> compare: `changed` is whether the roster moved since the
 *                       panel stored its hash, which stays what the panel wrote
 */
/** A ref as it may be stored: the address only. A session — and the live token inside it —
 * is per-run state that must never reach `chrome.storage` (D-10). `openSession` keeps
 * sessions off the ref; this is the second lock on the one write path that persists one. */
export function storableRef(ref) {
  if (!ref || typeof ref !== "object") return ref;
  const { session, token, ...rest } = ref;
  return rest;
}

export function nextLeagueRecord(val, hash, now) {
  if (hash == null) return val;
  if (val?.ref) val = { ...val, ref: storableRef(val.ref) };
  if (val.rosterHash == null)
    return { ...val, rosterHash: hash, latestHash: hash, changed: false, checkedAt: now };
  return { ...val, latestHash: hash, changed: hash !== val.rosterHash, checkedAt: now };
}
