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

/** @returns [[fantasypros_id, espn_id]] — an array so it survives JSON in storage. */
export function trimIds(text) {
  const out = [];
  for (const r of parseCsvObjects(text)) {
    const fp = r.fantasypros_id;
    const cell = String(r.espn_id ?? "").trim();      // Number("") is 0, not NaN
    const espn = cell === "" ? NaN : Number(cell);
    if (!fp || !Number.isFinite(espn)) continue;
    out.push([String(fp), espn]);
  }
  return out;
}

/**
 * @param week  the current scoring week; rows carrying a different week are dropped.
 * @returns { byEspn: Map<espnId, points>, week, available, reason }
 *          Never throws: a dead or renamed feed comes back `available: false` with a
 *          reason the panel can log in one line.
 */
export async function loadFantasyProsWeek({ week = null, ...opts } = {}) {
  let weekly;
  try {
    weekly = await cached("src.fp.weekly", WEEKLY_URL, opts.ttlMs ?? SIX_HOURS,
      { ...opts, parse: "text", transform: trimWeekly });
  } catch (err) {
    return { byEspn: new Map(), week, available: false, reason: String(err.message ?? err) };
  }
  const w = weekly.data ?? { rows: [], idKey: null, hasPts: false };
  if (!w.hasPts) return { byEspn: new Map(), week, available: false, reason: "no r2p_pts column" };
  if (!w.idKey) return { byEspn: new Map(), week, available: false, reason: "no fantasypros id column" };

  let idFile;
  try {
    idFile = await cached("src.fp.ids", IDS_URL, opts.idTtlMs ?? SEVEN_DAYS,
      { ...opts, parse: "text", transform: trimIds });
  } catch (err) {
    return { byEspn: new Map(), week, available: false, reason: `crosswalk ${err.message ?? err}` };
  }

  const toEspn = new Map(idFile.data ?? []);
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
