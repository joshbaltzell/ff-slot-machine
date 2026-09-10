/**
 * The CBS adapter: a CBS Fantasy Football league -> the same normalized model the
 * ESPN adapter produces, in ESPN vocabulary (D-01, D-02).
 *
 * The engine never learns CBS exists. Everything CBS says in its own words is
 * translated here and nowhere else: `SLOT` turns a CBS position code into an ESPN
 * slot id, `POS_ID` into an ESPN position id, `TEAM_ABBR` into an ESPN pro-team
 * abbreviation, `STATUS` into the injury strings `availability.js::normStatus`
 * already knows. Position strings never decide a seat - `expandEligibility` reads
 * the league's own configured slots and the player's own eligibility list, so
 * superflex, IDP, RB/WR and split D/ST need no special case.
 *
 * Auth (D-10, D-11). No password, ever. The league-subdomain `/api` proxy accepts
 * the session cookie on its own - that is what the 11-01 capture recorded, and it is
 * the primary route. If it says "not signed in", the signed-in league page is read
 * with credentials and the access token lifted out of it; the token then rides in an
 * `Authorization` header, never in a URL and never into storage. Every request
 * carries an explicit `league_id`: the proxy does not infer it from the hostname.
 *
 * Canonical ids (D-05, D-06). A player's id is his ESPN id, resolved through the
 * DynastyProcess crosswalk `sources/fantasypros.js` already downloads. A CBS player
 * the crosswalk does not know gets `-cbsId`: a negative Number cannot collide with
 * an ESPN id, so he keeps his seat in every lineup solve and simply shows a dash in
 * the columns an external source fills. No player is ever matched by name.
 *
 * Privacy. `league/*` payloads hold other users' rosters and are never cached - only
 * the two public, league-agnostic CBS feeds go through `sources/cache.js`, and their
 * URLs carry no `league_id`. Nothing here touches `chrome.*` at module load.
 *
 * Import rule, from platforms/hash.js: adapters import `hashRosters` from ./hash.js,
 * never from ./index.js, which reads their default exports while it evaluates.
 * `SLOT_LABEL` comes from league.js and is read inside function bodies only, the way
 * the ESPN adapter reads its own league.js imports, because the two files import each
 * other and neither may read the other at module-evaluation time.
 *
 * league.js's slot-to-label helper is deliberately not used for `pos`: it names the
 * first single-position slot a player may fill, and a CBS group code (DL, DB) sits on
 * a slot ESPN calls multi-position, so `posOf` reads `SLOT_LABEL` directly instead.
 */
import { SLOT_LABEL } from "../league.js";
import { hashRosters } from "./hash.js";
import { cached } from "../sources/cache.js";
import { loadCrosswalk } from "../sources/fantasypros.js";

const PUBLIC = "https://api.cbssports.com/fantasy";
const BASE_PARAMS = { version: "3.0", SPORT: "football", response_format: "JSON" };
const SIX_HOURS = 6 * 3600e3;
const ONE_DAY = 24 * 3600e3;
const CONCURRENCY = 3;

/* ---------- the translation tables (D-12, D-02) ---------- */

/**
 * CBS position code -> ESPN slot id. The 18 codes are CBS's own public `positions`
 * feed; every target id has a `SLOT_LABEL` entry. `K` and `TK` share 17 on purpose -
 * ESPN has one kicker slot - and split `D`/`ST` take 22 and 25, the two smallest ids
 * ESPN leaves unused (`lineup.js::BENCH_SLOTS` claims 20, 21 and 24).
 */
export const SLOT = {
  QB: 0, TQB: 1, RB: 2, "RB-WR": 3, WR: 4, "WR-TE": 5, TE: 6, FLEX: 7, "RB-WR-TE": 23,
  K: 17, TK: 17, DST: 16, DL: 11, LB: 10, DB: 14, "DL-LB-DB": 15,
  DT: 8, DE: 9, CB: 12, S: 13, D: 22, ST: 25,
};
export const BENCH_SLOT = 20;      // CBS "Reserve Players"
export const IR_SLOT = 21;         // CBS "Injured Players"

/**
 * CBS position code -> ESPN position id, for `posId` and `positionLimits`.
 *
 * ESPN's own table (`POS_LABEL` in league.js) has no id for a CBS group position, so
 * `DL`, `DB`, `TQB`, `TK`, `D` and `ST` take adapter-private ids in 0..63 that
 * `POS_LABEL` does not use. That is safe because a position id is only ever compared
 * against the keys this same adapter emits into `positionLimits` (`search.js`).
 */
export const POS_ID = {
  QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DST: 16, DT: 9, DE: 10, LB: 11, CB: 12, S: 13,
  DL: 40, DB: 41, TQB: 42, TK: 43, D: 44, ST: 45,
};

/**
 * Which player codes a configured slot accepts, from CBS's own descriptions:
 * "DB = CB + S", "DL = DE + DT + NT", "DST = Def Team + Spec Teams". Each group also
 * accepts its own name, because an IDP league may spell a player's eligibility
 * either way (`DL` or `DE`) and 11-01's league had no IDP to settle it - so both
 * vocabularies are accepted rather than guessed at. Any code not listed accepts
 * exactly itself.
 */
export const MEMBERS = {
  "RB-WR": ["RB", "WR"],
  "WR-TE": ["WR", "TE"],
  "RB-WR-TE": ["RB", "WR", "TE"],
  FLEX: ["QB", "RB", "WR", "TE"],
  DB: ["DB", "CB", "S"],
  LB: ["LB"],
  DL: ["DL", "DE", "DT"],
  "DL-LB-DB": ["DL", "LB", "DB", "DE", "DT", "CB", "S"],
  DST: ["DST", "D", "ST"],
  D: ["D", "DST"],
  ST: ["ST", "DST"],
};

/** The codes a slot accepts; anything unlisted accepts only itself. */
export const membersOf = (code) => MEMBERS[code] ?? [code];

/**
 * CBS pro-team abbreviation -> ESPN's. Two differ (`JAC`/`JAX`, `WAS`/`WSH`) and the
 * other 30 are identical. `FA`, `DRF` and anything unrecognised land on `"FA"`, which
 * `distribution.js::isRealTeam` treats as a placeholder: two draft-only players must
 * never correlate as team-mates.
 */
export const TEAM_ABBR = {
  ARI: "ARI", ATL: "ATL", BAL: "BAL", BUF: "BUF", CAR: "CAR", CHI: "CHI", CIN: "CIN",
  CLE: "CLE", DAL: "DAL", DEN: "DEN", DET: "DET", GB: "GB", HOU: "HOU", IND: "IND",
  JAC: "JAX", KC: "KC", LAC: "LAC", LAR: "LAR", LV: "LV", MIA: "MIA", MIN: "MIN",
  NE: "NE", NO: "NO", NYG: "NYG", NYJ: "NYJ", PHI: "PHI", PIT: "PIT", SEA: "SEA",
  SF: "SF", TB: "TB", TEN: "TEN", WAS: "WSH",
};

/**
 * CBS injury string -> the canonical status `normStatus` knows.
 *
 * `reserve-cel` is the one CBS word nothing else uses: the Commissioner Exempt List.
 * `normStatus` would resolve it to ACTIVE and price the player as playing, so it is
 * mapped here, to INJURY_RESERVE rather than OUT because an exempt-list stint runs
 * multiple weeks. Anything not in the table is healthy, and a healthy player carries
 * `injuryStatus: null` so `buildAvailability` gives him no entry at all and `weekly`
 * stays on its no-availability fast path.
 */
export const STATUS = {
  OUT: "OUT",
  QUESTIONABLE: "QUESTIONABLE",
  DOUBTFUL: "DOUBTFUL",
  IR: "INJURY_RESERVE",
  SUSPENDED: "SUSPENSION",
  RESERVE_CEL: "INJURY_RESERVE",
  PUP: "PUP",
  INACTIVE: "OUT",              // in the live injuries feed beside the seven above
};

/** A roster row's `pro_status`, which is set even when the injuries feed is silent. */
export const PRO_STATUS = { IR: "INJURY_RESERVE", PUP: "PUP" };

/** A CBS league lives on its own subdomain; `www` is the lobby, not a league. */
export const CBS_HOST_RE = /^([a-z0-9-]+)\.football\.cbssports\.com$/i;

/* ---------- pure helpers ---------- */

const keyOf = (v) => (v == null ? "" : String(v).trim().toUpperCase().replace(/[\s.-]+/g, "_"));

/** A finite number, or null. `""`, `"No Limit"` and `"NA"` are all null, never 0. */
export function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** ESPN's abbreviation for a CBS pro team; a placeholder for anything else. */
export function teamAbbr(code) {
  return TEAM_ABBR[keyOf(code)] ?? "FA";
}

/** The display label and position id for a CBS code. */
export function posOf(code) {
  const c = String(code ?? "").trim();
  return { pos: SLOT_LABEL[SLOT[c]] ?? (c || "?"), posId: POS_ID[c] ?? 0 };
}

/**
 * The canonical injury status for a player, or null when he is healthy.
 * @param status    the injuries feed's word for him, if it had one
 * @param proStatus the roster row's `pro_status`
 */
export function normalizeStatus(status, proStatus = null) {
  return STATUS[keyOf(status)] ?? PRO_STATUS[keyOf(proStatus)] ?? null;
}

/**
 * Every slot this player may be seated in (D-13).
 *
 * A configured slot accepts him when its member set contains one of his own codes;
 * bench and IR always follow. The result keeps the league's configured order and
 * never repeats a slot - `K` and `TK` both being slot 17 is the case that needs it.
 *
 * @param codes            the player's CBS eligibility codes
 * @param configuredCodes  the league's slot codes, in the order the rules list them
 */
export function expandEligibility(codes, configuredCodes) {
  const mine = new Set((codes ?? []).map((c) => String(c).trim()).filter(Boolean));
  const out = [];
  for (const code of configuredCodes ?? []) {
    const slot = SLOT[String(code).trim()];
    if (slot === undefined || out.includes(slot)) continue;
    if (membersOf(String(code).trim()).some((m) => mine.has(m))) out.push(slot);
  }
  out.push(BENCH_SLOT, IR_SLOT);
  return out;
}

/** The eligibility codes on a roster row (comma-separated) or a weekly-scoring row (an array). */
export function eligibleCodes(p) {
  if (Array.isArray(p?.eligible_positions)) return p.eligible_positions.map(String);
  if (typeof p?.eligible === "string" && p.eligible.trim())
    return p.eligible.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(p?.eligible)) return p.eligible.map(String);
  const one = p?.position ?? p?.eligible_positions_display ?? p?.roster_pos;
  return one ? [String(one).trim()] : [];
}

/** The league's configured slot codes, in the order `league/rules` lists them. */
export function configuredCodes(rules) {
  const r = rules?.rules ?? rules ?? {};
  return (r.roster?.positions ?? [])
    .filter((row) => (num(row?.max_active) ?? 0) > 0)
    .map((row) => String(row.abbr ?? "").trim())
    .filter(Boolean);
}

/* ---------- URLs and the session ---------- */

const qs = (params) => {
  const q = new URLSearchParams();
  for (const k of Object.keys(params).sort()) if (params[k] != null) q.set(k, String(params[k]));
  return q.toString();
};

/** A public, league-agnostic CBS feed. No `league_id` is ever sent to one. */
export function publicUrl(route, params = {}) {
  return `${PUBLIC}/${route}?${qs({ ...BASE_PARAMS, ...params })}`;
}

/**
 * The URL for a league route.
 *
 * Cookie mode goes through the league subdomain's `/api` proxy, which authenticates
 * on the session cookie; token mode goes to the public API host with the token in an
 * `Authorization` header. Both carry an explicit `league_id` - the proxy answers 400
 * `Missing league_id` without one, whatever the hostname says. The token itself never
 * appears in a URL (D-10).
 */
export function cbsUrl(ref, route, params = {}, session = null) {
  const slug = String(ref?.leagueId ?? "");
  const base = session?.mode === "token"
    ? `${PUBLIC}/${route}`
    : `https://${slug}.football.cbssports.com/api/${route}`;
  return `${base}?${qs({ ...BASE_PARAMS, league_id: slug, ...params })}`;
}

/** The signed-in league page - the one HTML read, and only for the token fallback. */
export const pageUrl = (ref) => `https://${ref.leagueId}.football.cbssports.com/`;

const NOT_SIGNED_IN = /not signed in|not logged in|no access/i;
const authError = () =>
  Object.assign(new Error("Not signed in to CBS, or no access to this league."), { code: "AUTH" });

/**
 * One league request, returning the envelope's `body`.
 *
 * CBS reports "not signed in" as HTTP 400 with a text body, not a 401, and sometimes
 * as a 200 whose envelope `statusCode` says otherwise - so both are checked and both
 * become the same `code: "AUTH"` error the panel switches on.
 */
async function get(ref, route, params = {}, opts = {}) {
  const session = opts.session ?? ref.session ?? null;
  const url = cbsUrl(ref, route, params, session);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const headers = { Accept: "application/json" };
  if (session?.mode === "token" && session.token) headers.Authorization = session.token;
  const res = await fetchImpl(url, { credentials: "include", headers });
  if (!res.ok) {
    let text = "";
    if (typeof res.text === "function") { try { text = await res.text(); } catch { /* no body */ } }
    if ([400, 401, 403].includes(res.status) && NOT_SIGNED_IN.test(text)) throw authError();
    throw new Error(`CBS returned ${res.status}`);
  }
  const env = await res.json();
  const code = num(env?.statusCode);
  if (code != null && code >= 400) {
    if (NOT_SIGNED_IN.test(String(env?.statusMessage ?? ""))) throw authError();
    throw new Error(`CBS returned ${code}`);
  }
  return env?.body ?? env;
}

/**
 * The access token in a signed-in league page, if it carries one.
 *
 * The same table, in the same order, as the capture kit's (`fixtures/cbs/capture.js`)
 * and the scrubber's, so a recorded page and a live one are read the same way. P1 is
 * what a 2026 league page actually carries; P4 is the 2017 form the design doc named.
 */
const TOKEN_PATTERNS = [
  ["P1", /CBSi\.token\s*=\s*"([^"]+)"/],
  ["P2", /['"]access_token['"]\s*:\s*['"]([^'"]+)['"]/],
  ["P3", /"token"\s*:\s*"([^"]+)"/],
  ["P4", /var token\s*=\s*"([^"]+)"/],
  ["P5", /access_token=([A-Za-z0-9._~%-]+)/],
];
export function extractToken(html) {
  for (const [pattern, re] of TOKEN_PATTERNS) {
    const m = re.exec(String(html ?? ""));
    if (m && m[1]) return { token: m[1], pattern };
  }
  return null;
}

/** `var myTeamId = N` in the league page, when we have already read the page anyway. */
const teamHintOf = (html) => num((/var myTeamId\s*=\s*(\d+)/.exec(String(html ?? "")) ?? [])[1]);

/**
 * Open a session for this league, cookie first, page token second.
 *
 * Held in memory on the ref for the run and never persisted (D-10). Nothing here
 * asks for a password, and no password endpoint is referenced anywhere in this file
 * (D-11): when neither route works, that is an AUTH error and the panel offers the
 * sign-in link.
 */
export async function openSession(ref, opts = {}) {
  if (ref.session) return ref.session;
  if (opts.session) { ref.session = opts.session; return ref.session; }

  const cookie = { mode: "cookie", token: null, teamHint: null };
  try {
    await get(ref, "league/details", {}, { ...opts, session: cookie });
    ref.session = cookie;
    return cookie;
  } catch (err) {
    if (err.code !== "AUTH") throw err;
  }

  let html = null;
  try {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const res = await fetchImpl(pageUrl(ref), { credentials: "include" });
    if (res?.ok && typeof res.text === "function") html = await res.text();
  } catch { /* no page, no token: the AUTH error below is the honest answer */ }

  const found = html ? extractToken(html) : null;
  if (found) {
    const token = { mode: "token", token: found.token, teamHint: teamHintOf(html) };
    try {
      await get(ref, "league/details", {}, { ...opts, session: token });
      ref.session = token;
      return token;
    } catch (err) {
      if (err.code !== "AUTH") throw err;
    }
  }
  throw authError();
}

/* ---------- settings ---------- */

/**
 * The 19-key settings contract, read from `league/rules` and `league/details`.
 *
 * Read, never derived: the period counts, the current period and the playoff team
 * count are structured fields. CBS's display prose is not parsed - `playoffs_last`
 * says "3 Weeks" beside a `playoff_periods: "3"` that means it, and `max_total` says
 * "No Limit" where a number would go, so an unlimited position is simply omitted from
 * `positionLimits`. Numbers arrive as a mix of strings and numbers throughout, so
 * every one goes through `num()`. Anything genuinely absent takes ESPN's default and
 * pushes a note naming the assumption rather than passing a guess off as a reading.
 *
 * @param notes  appended to, so the caller can print what was assumed
 */
/** The narrowest ESPN slot whose membership covers every code in `need`. Ordered narrowest
 * first so a WR/TE headroom becomes WR/TE (5), not the superflex. Falls back to the widest
 * offensive flex with a note rather than inventing a slot the engine does not know. */
export function flexSlotFor(need, notes = []) {
  const want = [...need];
  if (want.length === 1 && SLOT[want[0]] !== undefined) return SLOT[want[0]];
  for (const abbr of ["RB-WR", "WR-TE", "RB-WR-TE", "DL-LB-DB", "FLEX"]) {
    const members = MEMBERS[abbr] ?? [];
    if (want.every((code) => members.includes(code))) return SLOT[abbr];
  }
  notes.push(`CBS: no single lineup slot covers ${want.sort().join("/")} - the flex seats are modelled as RB/WR/TE`);
  return SLOT["RB-WR-TE"];
}

export function readSettings(rules, details, scoring, notes = []) {
  const r = rules?.rules ?? rules ?? {};
  const d = details?.league_details ?? details ?? {};
  const sc = scoring?.scoring_rules ?? scoring ?? {};

  // Slots. CBS states a per-position RANGE (min_active..max_active) and caps the whole
  // lineup with the "Active Players" status. Reading the maxima as seats is wrong whenever
  // they exceed that cap - the recorded league's maxima total 14 against a cap of 8, and a
  // 14-seat lineup is one the manager can never set, so every trade would be scored against
  // a team that does not exist. The minimums are the seats the manager MUST fill; the
  // remainder up to the cap is discretion, which is exactly what a flex slot models. So:
  // dedicated slots for the minimums, then the leftover seats as the narrowest ESPN flex
  // whose eligibility covers every position that still has headroom.
  const statusMax = (description) => {
    const row = (r.roster?.statuses ?? []).find((s) => String(s?.description ?? "").trim() === description);
    return num(row?.max);
  };
  const benchSlots = statusMax("Reserve Players") ?? 0;
  const irSlots = statusMax("Injured Players") ?? 0;
  const activeMax = statusMax("Active Players");

  const rows = [];
  for (const row of r.roster?.positions ?? []) {
    const abbr = String(row?.abbr ?? "").trim();
    const max = num(row?.max_active) ?? 0;
    if (max <= 0) continue;
    if (SLOT[abbr] === undefined) { notes.push(`CBS: unknown roster position "${abbr}" - its ${max} seat(s) are not modelled`); continue; }
    rows.push({ abbr, slot: SLOT[abbr], max, min: Math.min(num(row?.min_active) ?? 0, max) });
  }
  const sumMax = rows.reduce((a, x) => a + x.max, 0);
  const sumMin = rows.reduce((a, x) => a + x.min, 0);

  const counts = {};
  const seat = (slot, n) => { if (n > 0) counts[slot] = (counts[slot] ?? 0) + n; };
  if (activeMax == null) {
    // Nothing bounds the lineup, so the maxima are the only reading available.
    for (const x of rows) seat(x.slot, x.max);
    if (sumMax !== sumMin) notes.push("CBS: no Active Players cap in the rules - the engine models each position's maximum");
  } else if (sumMax <= activeMax) {
    // A fixed lineup (or one the cap does not bind): the maxima ARE the seats.
    for (const x of rows) seat(x.slot, x.max);
  } else {
    for (const x of rows) seat(x.slot, x.min);
    const spare = activeMax - sumMin;
    if (spare > 0) {
      // Every position that can still take another starter, expanded through the same
      // membership table eligibility uses, then the narrowest slot that covers them all.
      const headroom = new Set();
      for (const x of rows) if (x.max > x.min) for (const code of MEMBERS[x.abbr] ?? [x.abbr]) headroom.add(code);
      seat(flexSlotFor(headroom, notes), spare);
    }
    notes.push(`CBS: the lineup allows ${activeMax} starters but the position maxima total ${sumMax}; ` +
               `this is a flexible lineup - the engine seats each position's minimum and models the rest as flex`);
    if (spare < 0) notes.push(`CBS: the position minimums total ${sumMin}, more than the ${activeMax} the lineup allows - the minimums are used`);
  }
  const starters = Object.values(counts).reduce((a, b) => a + b, 0);

  // "No Limit" is a string where a number would go: an unlimited position is omitted
  // rather than read as NaN, and a league with no limits at all reports null, as ESPN's does.
  const limits = {};
  for (const row of r.roster?.positions ?? []) {
    const abbr = String(row?.abbr ?? "").trim();
    const max = num(row?.max_total);
    const posId = POS_ID[abbr];
    if (max == null || posId === undefined) continue;
    limits[posId] = max;
  }

  const currentWeek = num(d.current_period) ?? num(d.effective_period) ?? 1;
  let regCount = num(d.regular_season_periods);
  if (regCount == null) { regCount = 14; notes.push("CBS: no regular-season period count in league details - assuming 14"); }
  let poCount = num(d.playoff_periods);
  if (poCount == null) { poCount = 3; notes.push("CBS: no playoff period count in league details - assuming 3"); }
  const regularSeasonWeeks = [];
  for (let w = 1; w <= regCount; w++) regularSeasonWeeks.push(w);
  const playoffRoundWeeks = [];
  for (let w = regCount + 1; w <= regCount + poCount; w++) playoffRoundWeeks.push([w]);
  const playoffWeeks = playoffRoundWeeks.flat();

  let playoffTeams = num(r.schedule?.num_playoff_teams?.value);
  if (playoffTeams == null) { playoffTeams = 6; notes.push("CBS: no playoff team count in the rules - assuming 6"); }

  // A Yes/No field, not prose: read it, and only fall back when it is neither.
  const reseedRaw = keyOf(r.schedule?.reseed?.value);
  let playoffReseed;
  if (reseedRaw === "YES") playoffReseed = true;
  else if (reseedRaw === "NO") playoffReseed = false;
  else { playoffReseed = true; notes.push("CBS: no reseed setting in the rules - assuming the bracket reseeds"); }

  // CBS states its tiebreaker only in a sentence, and a sentence is not a setting.
  notes.push("CBS: the standings tiebreaker is published as prose only - the season simulation uses total points scored");
  const seedingTiebreak = "TOTAL_POINTS_SCORED";

  // Points per reception, from the league's own scoring rules: the `Recpt` category
  // carries it as a per-1 range rather than a flat value.
  const rec = (sc.categories ?? []).find((c) => String(c?.name ?? "").trim() === "Recpt");
  let pprValue = num(rec?.points) ?? num(rec?.ranges?.[0]?.points);
  if (pprValue == null) {
    pprValue = 0;
    if (!rec) notes.push("CBS: no reception scoring rule was read - points per reception is taken as 0");
  }

  // "$100" is a formatted number, not a sentence; anything that is not one reads 0.
  const budget = String(r.transactions?.add_drop_faab_starting_budget?.value ?? "").trim();
  const faabBudget = /^\$?\d+(\.\d+)?$/.test(budget) ? Number(budget.replace("$", "")) : 0;
  if (budget && !faabBudget) notes.push(`CBS: the waiver budget reads "${budget}" - treating it as no budget`);

  return {
    name: String(d.name ?? "").trim() || "League",
    pprValue,
    faabBudget,
    currentWeek,
    lineupSlotCounts: counts,
    starters,
    benchSlots,
    irSlots,
    rosterSize: starters + benchSlots,
    positionLimits: Object.keys(limits).length ? limits : null,
    regularSeasonWeeks,
    playoffWeeks,
    playoffRoundWeeks,
    playoffTeams,
    playoffRounds: playoffRoundWeeks.length,
    playoffReseed,
    seedingTiebreak,
    divisions: [],          // a per-team string; loadLeague fills it from the rosters
    divisionCount: 0,
  };
}

/* ---------- optional public feeds ---------- */

/** `[cbsId, status]` pairs, small enough to cache. Public and league-agnostic. */
export const trimInjuries = (raw) =>
  (raw?.body?.injuries ?? raw?.injuries ?? [])
    .map((row) => [Number(row?.player_id), row?.status ?? row?.status_full ?? null])
    .filter(([id, st]) => Number.isFinite(id) && st != null);

/**
 * The public injuries feed, or an empty map and a reason. A dead feed costs a dash
 * (every player reads healthy from `pro_status` alone), never the run.
 */
export async function loadInjuries(opts = {}) {
  try {
    const file = await cached("src.cbs.injuries", publicUrl("players/injuries"),
      opts.injuryTtlMs ?? SIX_HOURS, { ...opts, transform: trimInjuries });
    return { byId: new Map(file.data ?? []), available: true, reason: "" };
  } catch (err) {
    return { byId: new Map(), available: false, reason: String(err.message ?? err) };
  }
}

/** The public player list, read only when a roster row is missing its bye or team. */
export const trimPlayers = (raw) =>
  (raw?.body?.players ?? raw?.players ?? [])
    .map((p) => [Number(p?.id), { nfl: p?.pro_team ?? null, bye: Number(p?.bye_week) || 0 }])
    .filter(([id]) => Number.isFinite(id));

export async function loadPlayerList(opts = {}) {
  try {
    const file = await cached("src.cbs.players", publicUrl("players/list"),
      opts.playerTtlMs ?? ONE_DAY, { ...opts, transform: trimPlayers });
    return { byId: new Map(file.data ?? []), available: true, reason: "" };
  } catch (err) {
    return { byId: new Map(), available: false, reason: String(err.message ?? err) };
  }
}

/* ---------- the loader ---------- */

/**
 * Pull a whole league. `onProgress(done, total, label)` drives the panel's status.
 *
 * Cadence (D-14): one `league/rosters?team_id=all` for every roster, then one
 * `league/stats?stats_type=projections&period=weekN&player_status=all` per remaining
 * week, three at a time - the same gentleness as the ESPN adapter, for the same
 * reason: this is a signed-in user reading their own league.
 */
export async function loadLeague(ref, onProgress = () => {}, opts = {}) {
  const notes = [];
  await openSession(ref, opts);
  onProgress(0, 1, "settings");

  const rules = await get(ref, "league/rules", {}, opts);
  const details = await get(ref, "league/details", {}, opts);
  let scoring = null;
  try {
    scoring = await get(ref, "league/scoring/rules", {}, opts);
  } catch (err) {
    notes.push(`CBS: scoring rules unavailable (${err.message ?? err}) - points per reception reads 0`);
  }
  const settings = readSettings(rules, details, scoring, notes);
  const weeks = [...settings.regularSeasonWeeks, ...settings.playoffWeeks];
  const codes = configuredCodes(rules);

  // Injury words are a public feed; a dead one leaves `pro_status` to speak.
  const injuries = await loadInjuries(opts);
  if (!injuries.available)
    notes.push(`CBS: the injury feed is unavailable (${injuries.reason}) - only players CBS marks IR or PUP are flagged`);

  // One request for every roster in the league: league/rosters?team_id=all (D-14).
  const rosters = await get(ref, "league/rosters", { team_id: "all" }, opts);
  const teams = new Map();
  const byCbs = new Map();            // cbsId -> record, until the crosswalk renames them
  const rosterIds = [];               // what the fingerprint hashes: CBS's own ids
  const divisions = new Map();
  let missingBye = 0;

  for (const t of rosters?.rosters?.teams ?? []) {
    const id = num(t?.id);
    if (id == null) continue;
    const division = String(t?.division ?? "").trim();
    if (division) divisions.set(division, (divisions.get(division) ?? 0) + 1);
    const rec = {
      id,
      name: String(t?.name ?? "").trim() || `Team ${id}`,
      roster: new Set(),
      // CBS returns no owner object on any recorded route; the array stays empty
      // rather than inventing a name, and identify() has the page hint instead.
      owners: [],
      divisionId: 0,
      faabSpent: 0,
      _division: division,
    };
    teams.set(id, rec);
    const ids = [];
    for (const p of t?.players ?? []) {
      const cbsId = num(p?.id);
      if (cbsId == null || byCbs.has(cbsId)) continue;
      ids.push(cbsId);
      const codesOf = eligibleCodes(p);
      const { pos, posId } = posOf(codesOf[0] ?? p?.position);
      const status = normalizeStatus(injuries.byId.get(cbsId) ?? null, p?.pro_status);
      const bye = num(p?.bye_week);
      if (bye == null) missingBye++;
      byCbs.set(cbsId, {
        id: -cbsId,                                   // until the crosswalk says otherwise
        name: String(p?.fullname ?? `${p?.firstname ?? ""} ${p?.lastname ?? ""}`).trim() || `Player ${cbsId}`,
        eligibleSlots: expandEligibility(codesOf, codes),
        pos, posId,
        injuryStatus: status,
        injured: status != null && status !== "SUSPENSION",
        nfl: teamAbbr(p?.pro_team),
        teamId: id,
        proj: Object.fromEntries(weeks.map((w) => [w, 0])),
        // CBS publishes weekly actuals through fantasy-points/weekly-scoring, which
        // defaults to free agents only; reading a rostered player's history needs
        // player_status=all and is 11-06's work.
        history: [],
        bye: bye ?? 0,
      });
      rec.roster.add(cbsId);
    }
    rosterIds.push({ id, ids });
  }
  const fingerprint = hashRosters(rosterIds);
  notes.push("CBS: no weekly history or standings are read yet - volatility falls back to the positional prior " +
             "and the season projection starts every team at 0-0");

  // Divisions are a per-team string, so they are read from the rosters rather than
  // from a settings field CBS does not publish.
  if (divisions.size > 1) {
    settings.divisions = [...divisions].map(([name, size], i) => ({ id: i, name, size }));
    settings.divisionCount = settings.divisions.length;
    for (const t of teams.values())
      t.divisionId = settings.divisions.findIndex((dv) => dv.name === t._division);
  }
  for (const t of teams.values()) delete t._division;

  // A roster row without a bye or a pro team is the only reason to read the public
  // player list, and this league needed none of it.
  if (missingBye) {
    const list = await loadPlayerList(opts);
    if (list.available) {
      for (const [cbsId, pl] of byCbs) {
        const extra = list.byId.get(cbsId);
        if (!extra) continue;
        if (!pl.bye) pl.bye = extra.bye;
        if (pl.nfl === "FA" && extra.nfl) pl.nfl = teamAbbr(extra.nfl);
      }
    } else {
      notes.push(`CBS: the player list is unavailable (${list.reason}) - ${missingBye} player(s) have no bye week`);
    }
  }

  // Canonical ids (D-05, D-06). The crosswalk is the only thing that can turn a CBS
  // id into an id every other source in this extension already speaks.
  const crosswalk = await loadCrosswalk(opts);
  const players = new Map();
  let mapped = 0;
  for (const [cbsId, pl] of byCbs) {
    const espnId = crosswalk.toEspn.get(cbsId);
    // A crosswalk row that would collide with a player already seated keeps the
    // negative id instead: two players sharing a key would lose one of them.
    if (Number.isFinite(espnId) && !players.has(espnId)) { pl.id = espnId; mapped++; }
    players.set(pl.id, pl);
  }
  for (const t of teams.values()) {
    const ids = [...t.roster].map((cbsId) => byCbs.get(cbsId).id);
    t.roster = new Set(ids);
  }
  const total = byCbs.size;
  notes.push(crosswalk.available
    ? `CBS: id crosswalk maps ${mapped} of ${total} rostered players to canonical ids; ` +
      `${total - mapped} unmapped will show dashes from Sleeper, FantasyPros and FantasyCalc`
    : `CBS: id crosswalk unavailable (${crosswalk.reason}) - every player is unmapped; ` +
      "external sources will show dashes");

  // Projections: one call per remaining week, three at a time (D-14). Weeks already
  // played keep their zero - the horizon is the weeks that remain, and nothing in a
  // finished week can be traded for.
  const remaining = weeks.filter((w) => w >= settings.currentWeek);
  let done = 0;
  const fetchWeek = async (w) => {
    const body = await get(ref, "league/stats",
      { stats_type: "projections", period: `week${w}`, player_status: "all" }, opts);
    for (const row of body?.league_stats?.players ?? []) {
      const pl = byCbs.get(num(row?.id));
      if (!pl) continue;
      // FPTS is the league-scored figure and equals the roster row's projected_points;
      // TP is a different number on every row and must not be used.
      const pts = num(row?.FPTS) ?? 0;
      pl.proj[w] = Math.round(pts * 100) / 100;
    }
    onProgress(++done, remaining.length, `week ${w}`);
  };
  for (let i = 0; i < remaining.length; i += CONCURRENCY)
    await Promise.all(remaining.slice(i, i + CONCURRENCY).map(fetchWeek));
  if (!remaining.length) onProgress(1, 1, "no weeks remain");

  return { settings, weeks, players, teams, fingerprint, notes };
}

/* ---------- not yet built (11-06) ---------- */

const later = (what) => { throw new Error(`CBS ${what} is not implemented until 11-06`); };
export const loadFreeAgents = async () => later("free agents");
export const loadSchedule = async () => later("the schedule");
export const identify = async () => later("team identification");
export const fingerprint = async () => later("the daily fingerprint");

/* ---------- the adapter ---------- */

/** leagueId (the subdomain slug) from any CBS league URL. */
export function parseLeagueUrl(url) {
  try {
    const u = new URL(url);
    const m = CBS_HOST_RE.exec(u.hostname);
    if (!m) return null;
    const slug = m[1].toLowerCase();
    if (slug === "www") return null;                 // the lobby, not a league
    return { leagueId: slug, seasonId: new Date().getFullYear(), teamId: null };
  } catch { return null; }
}

/** The adapter object platforms/index.js registers (D-03). */
export default {
  id: "cbs",
  label: "CBS",
  hosts: ["https://*.cbssports.com/*", "https://*.football.cbssports.com/*"],
  acceptsToken: true,
  signInUrl: (ref) => "https://www.cbssports.com/login?product_abbrev=mgmt&xurl="
    + encodeURIComponent(`https://${ref?.leagueId ?? "www"}.football.cbssports.com/`)
    + "&master_product=41403",
  parseLeagueUrl,
  loadLeague,
  loadFreeAgents,
  loadSchedule,
  identify,
  fingerprint,
};
