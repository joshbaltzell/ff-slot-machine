/**
 * FantasyPros ECR, through DynastyProcess's public mirror on raw.githubusercontent
 * (CORS-open, no key, no scraping). Two files:
 *
 *  - `fp_latest_weekly.csv`  this week's consensus. The column we want is `r2p_pts`,
 *    FantasyPros' rank-to-points conversion: a rank is not a projection, and the
 *    conversion is the only thing in the file that can be averaged with points. When
 *    the column is absent the source is skipped rather than approximated.
 *  - `db_playerids.csv`      `fantasypros_id` -> `espn_id`, cached a week because
 *    ids do not move.
 *
 * Two files, three readers: the id file also carries `cbs_id`, which the CBS adapter
 * needs to turn a CBS roster into canonical ESPN ids (D-05). It reads it through
 * `loadCrosswalk` from this same download rather than fetching the file twice, so
 * `trimIds` keeps both columns and the cache key was bumped to `src.fp.ids.v2` - a
 * week-fresh copy of the old bare array would otherwise be read as the new object.
 *
 * Current week only: the file carries one week, and a weekly consensus does not
 * extrapolate. Nothing but the two file paths goes over the wire.
 *
 * ASSUMPTION, verified at runtime rather than trusted: the FantasyPros id column is
 * one of `fantasypros_id` / `fp_id` / `id`. The header is probed and the source
 * reports itself unavailable when no candidate matches, so a renamed column costs a
 * log line instead of wrong numbers.
 */
import { cached } from "./cache.js";
import { parseCsvObjects } from "./csv.js";

const RAW = "https://raw.githubusercontent.com/dynastyprocess/data/master/files";
export const WEEKLY_URL = `${RAW}/fp_latest_weekly.csv`;
export const IDS_URL = `${RAW}/db_playerids.csv`;
/** Cache key for the id file. v2: the stored value is {fp, cbs}, not a bare array. */
export const IDS_KEY = "src.fp.ids.v2";
const SIX_HOURS = 6 * 3600e3;
const SEVEN_DAYS = 7 * 24 * 3600e3;
const ID_KEYS = ["fantasypros_id", "fp_id", "id"];

/** @returns {{rows, idKey, hasPts}} — trimmed to what we read, before caching. */
export function trimWeekly(text) {
  const raw = parseCsvObjects(text);
  if (!raw.length) return { rows: [], idKey: null, hasPts: false };
  const header = Object.keys(raw[0]);
  const idKey = ID_KEYS.find((k) => header.includes(k)) ?? null;
  const hasPts = header.includes("r2p_pts");
  const rows = [];
  if (idKey && hasPts) {
    for (const r of raw) {
      const id = r[idKey];
      // Number("") is 0, not NaN — an empty cell would sail through as a real
      // projection of zero and drag the positional mean down.
      const cell = String(r.r2p_pts ?? "").trim();
      const pts = cell === "" ? NaN : Number(cell);
      if (!id || !Number.isFinite(pts)) continue;
      const wk = Number(r.week);
      rows.push({ fp: String(id), pts, week: Number.isFinite(wk) ? wk : null,
                  pos: String(r.pos ?? r.position ?? "") });
    }
  }
  return { rows, idKey, hasPts };
}

/**
 * @returns {{fp: [string, number][], cbs: [number, number][]}} — arrays, so the
 *   stored copy survives JSON. `fp` is `[fantasypros_id, espn_id]` as it always was;
 *   `cbs` is `[cbs_id, espn_id]` for the CBS adapter. Both drop the file's `NA`
 *   sentinel by way of `Number("NA")` being NaN. A `cbs_id` appears once - the file
 *   has 15 duplicates and the first row wins, the same rule `loadFantasyProsWeek`
 *   uses below, so which espn_id a CBS player becomes never depends on row order
 *   further down the file.
 */
export function trimIds(text) {
  const fp = [], cbs = [], seen = new Set();
  for (const r of parseCsvObjects(text)) {
    const cell = String(r.espn_id ?? "").trim();      // Number("") is 0, not NaN
    const espn = cell === "" ? NaN : Number(cell);
    if (!Number.isFinite(espn)) continue;
    if (r.fantasypros_id) fp.push([String(r.fantasypros_id), espn]);
    const cbsCell = String(r.cbs_id ?? "").trim();
    const cbsId = cbsCell === "" ? NaN : Number(cbsCell);
    if (Number.isFinite(cbsId) && !seen.has(cbsId)) { seen.add(cbsId); cbs.push([cbsId, espn]); }
  }
  return { fp, cbs };
}

/**
 * `cbs_id -> espn_id` from the same weekly download (D-05).
 *
 * Never throws: a dead feed, a renamed column or an empty file comes back
 * `available: false` with a reason the adapter turns into one note line and a roster
 * of `-cbsId` players. That is the whole degradation - the league still loads, and
 * only the external columns show a dash (D-06).
 *
 * @returns {{toEspn: Map<number, number>, available, reason, fromCache, stale}}
 */
export async function loadCrosswalk(opts = {}) {
  let file;
  try {
    file = await cached(IDS_KEY, IDS_URL, opts.idTtlMs ?? SEVEN_DAYS,
      { ...opts, parse: "text", transform: trimIds });
  } catch (err) {
    return { toEspn: new Map(), available: false, reason: String(err.message ?? err),
             fromCache: false, stale: false };
  }
  // A pre-v2 cached copy is a bare array; it carries no cbs column at all.
  const data = file.data;
  const toEspn = new Map(Array.isArray(data) ? [] : (data?.cbs ?? []));
  return { toEspn, available: toEspn.size > 0,
           reason: toEspn.size ? "" : "no cbs_id rows in the crosswalk",
           fromCache: file.fromCache === true, stale: file.stale === true };
}

/**
 * @param week  the current scoring week; rows carrying a different week are dropped.
 * @returns { byEspn: Map<espnId, points>, week, available, reason }
 *          Never throws: a dead or renamed feed comes back `available: false` with a
 *          reason the panel can log in one line.
 */
export async function loadFantasyProsWeek({ week = null, ...opts } = {}) {
  // Two independent files on the same host. They used to be awaited one after the
  // other, which cost a round trip for nothing. `allSettled` rather than `all` so an
  // early return below cannot leave the other promise rejecting into the void - and
  // the error precedence stays exactly what it was, because both results are in hand
  // before anything is decided.
  //
  // The one thing this trades away: on a day the weekly feed is broken, the crosswalk
  // is now requested anyway, where before the early return skipped it. That is one
  // wasted request on a bad day against one saved round trip on every good one, and
  // the crosswalk's seven-day TTL means it is usually not a request at all.
  const [weeklyRes, idRes] = await Promise.allSettled([
    cached("src.fp.weekly", WEEKLY_URL, opts.ttlMs ?? SIX_HOURS,
      { ...opts, parse: "text", transform: trimWeekly }),
    cached(IDS_KEY, IDS_URL, opts.idTtlMs ?? SEVEN_DAYS,
      { ...opts, parse: "text", transform: trimIds }),
  ]);

  if (weeklyRes.status === "rejected") {
    const err = weeklyRes.reason;
    return { byEspn: new Map(), week, available: false, reason: String(err?.message ?? err) };
  }
  const w = weeklyRes.value.data ?? { rows: [], idKey: null, hasPts: false };
  if (!w.hasPts) return { byEspn: new Map(), week, available: false, reason: "no r2p_pts column" };
  if (!w.idKey) return { byEspn: new Map(), week, available: false, reason: "no fantasypros id column" };

  if (idRes.status === "rejected") {
    const err = idRes.reason;
    return { byEspn: new Map(), week, available: false, reason: `crosswalk ${err?.message ?? err}` };
  }
  const idFile = idRes.value;

  // Tolerate either shape: a bare array is a pre-v2 copy, {fp, cbs} is this build.
  const toEspn = new Map(Array.isArray(idFile.data) ? idFile.data : idFile.data?.fp ?? []);
  const byEspn = new Map();
  for (const r of w.rows) {
    // Fail open on week: a row with no parseable week (no `week` column at all, or a
    // cell that doesn't parse as a number) is kept for every requested week rather than
    // dropped. `fp_latest_weekly.csv` is *by definition* the latest week and may carry
    // no week column whatsoever — failing closed would set every row's week to null and
    // drop the entire file, silently disabling the source. One stray row entering a
    // positional mean that gets refetched every six hours is the far cheaper mistake.
    if (r.week != null && week != null && r.week !== Number(week)) continue;
    const espn = toEspn.get(r.fp);
    if (espn == null || !(r.pts > 0)) continue;
    if (!byEspn.has(espn)) byEspn.set(espn, r.pts);      // first row wins; ids are unique in practice
  }
  return { byEspn, week, available: byEspn.size > 0, reason: byEspn.size ? "" : "no rows matched" };
}
