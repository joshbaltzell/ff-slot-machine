/**
 * The ESPN adapter: ESPN league -> normalized model.
 *
 * Nothing about any particular league is hardcoded. Slot layout, roster size, team
 * count, regular-season length and playoff format are all read from mSettings, and
 * player eligibility comes from each player's own `eligibleSlots`, so leagues with
 * superflex, IDP, TQB, RB/WR or two-week playoff rounds need no special handling.
 *
 * This was league.js until the platform seam and was moved, not rewritten. Three
 * deltas: `get` takes an injectable `fetchImpl` and marks a 401 with `code: "AUTH"`;
 * every loader threads `opts` into `get`; `loadLeague` returns `fingerprint` and
 * `notes` alongside the model it always returned.
 *
 * Import cycle, on purpose: league.js re-exports the loader names from this file
 * (D-04) and this file imports `positionLabel` and `PRO_TEAM` from league.js. That
 * is safe only because neither is read at module-evaluation time - every use is
 * inside a function body. Keep it that way.
 */
import { positionLabel, PRO_TEAM } from "../league.js";
import { hashRosters } from "./hash.js";

const API = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

/** The URL `get` requests, exported so an offline test can key a fetch table on it. */
export function espnUrl(season, leagueId, params) {
  return `${API}/seasons/${season}/segments/0/leagues/${leagueId}?${params}`;
}

/** leagueId / seasonId from any ESPN fantasy URL. */
export function parseLeagueUrl(url) {
  try {
    const u = new URL(url);
    if (!/fantasy\.espn\.com$/.test(u.hostname)) return null;
    const leagueId = u.searchParams.get("leagueId");
    if (!leagueId) return null;
    return {
      leagueId: Number(leagueId),
      seasonId: Number(u.searchParams.get("seasonId")) || new Date().getFullYear(),
      teamId: u.searchParams.get("teamId") ? Number(u.searchParams.get("teamId")) : null,
    };
  } catch { return null; }
}

async function get(season, leagueId, params, filter, opts = {}) {
  const url = espnUrl(season, leagueId, params);
  const headers = { Accept: "application/json" };
  if (filter) headers["x-fantasy-filter"] = JSON.stringify(filter);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(url, { credentials: "include", headers });
  // The code, not the message, is what the panel switches on: the message is ours to
  // word and another platform's may say something else entirely.
  if (res.status === 401)
    throw Object.assign(new Error("Not signed in to ESPN, or no access to this league."), { code: "AUTH" });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

/** Compare SWIDs without caring about braces, case, or URL encoding. */
export function sameSwid(a, b) {
  const norm = (v) => {
    if (!v) return "";
    let s = String(v);
    try { s = decodeURIComponent(s); } catch { /* already decoded */ }
    return s.replace(/[{}]/g, "").trim().toLowerCase();
  };
  const x = norm(a);
  return x !== "" && x === norm(b);
}

/** The signed-in user's SWID. The cookie lives on .espn.com, so try both hosts. */
export async function mySwid() {
  for (const url of ["https://fantasy.espn.com", "https://www.espn.com"]) {
    try {
      const c = await chrome.cookies.get({ url, name: "SWID" });
      if (c?.value) return c.value;
    } catch { /* permission or host unavailable; try the next */ }
  }
  return null;
}

/**
 * Which team belongs to this viewer.
 *
 * Returns {team, how} so the caller can tell a confident match from a guess -
 * silently defaulting to whichever team ESPN happened to return first is worse
 * than admitting we do not know.
 */
export function identifyTeam(model, { swid, teamId }) {
  if (teamId != null && model.teams.has(teamId))
    return { team: model.teams.get(teamId).name, how: "the team page you came from" };
  if (swid) {
    for (const t of model.teams.values())
      if ((t.owners ?? []).some((o) => sameSwid(o, swid)))
        return { team: t.name, how: "your ESPN sign-in" };
  }
  return { team: null, how: null };
}

/** The adapter form of identifyTeam: read the SWID cookie, then match on it or the team page. */
export async function identify(ref, model, opts = {}) {   // eslint-disable-line no-unused-vars
  const swid = await mySwid();
  return identifyTeam(model, { swid, teamId: ref.teamId });
}

/**
 * Everything the engine needs, read rather than assumed.
 *
 * ESPN's schedule settings are richer than they first appear, and guessing at them
 * produces wrong playoff odds rather than obviously broken ones:
 *  - `matchupPeriods` maps a matchup to the scoring weeks it spans, so a two-week
 *    final is `{"16": [16, 17]}`. Deriving weeks arithmetically instead gets those
 *    leagues wrong.
 *  - `playoffMatchupPeriodLength` can be 0 when lengths vary by round, in which case
 *    `playoffMatchupPeriodLengthByRound` is the real answer.
 *  - `playoffReseed` decides whether the bracket re-sorts between rounds.
 *  - a league with no divisions still reports one, named "League Standings".
 */
export function readSettings(raw) {
  const s = raw.settings ?? {};
  const roster = s.rosterSettings ?? {};
  const sched = s.scheduleSettings ?? {};

  const counts = {};
  let bench = 0, ir = 0;
  for (const [id, n] of Object.entries(roster.lineupSlotCounts ?? {})) {
    const slot = Number(id);
    if (!(n > 0)) continue;
    if (slot === 20) bench = n;
    else if (slot === 21 || slot === 24) ir += n;
    else counts[slot] = n;
  }
  const starters = Object.values(counts).reduce((a, b) => a + b, 0);

  const regCount = sched.matchupPeriodCount ?? 14;
  const periods = sched.matchupPeriods ?? {};
  const weeksOf = (period) => {
    const w = periods[String(period)];
    return Array.isArray(w) && w.length ? w.map(Number) : [Number(period)];
  };

  const regularSeasonWeeks = [];
  for (let m = 1; m <= regCount; m++) regularSeasonWeeks.push(...weeksOf(m));

  const playoffTeams = sched.playoffTeamCount ?? 6;
  const bracket = 2 ** Math.ceil(Math.log2(Math.max(playoffTeams, 2)));
  const rounds = Math.max(1, Math.log2(bracket));
  const byRound = sched.playoffMatchupPeriodLengthByRound ?? null;
  const flat = sched.playoffMatchupPeriodLength || 0;

  // Weeks belonging to each playoff round, in order.
  // One matchup period per round. When `matchupPeriods` is present it already
  // expands a multi-week round (a two-week final is {"16": [16, 17]}), so the
  // round length must not be applied a second time.
  const playoffRoundWeeks = [];
  let period = regCount + 1;
  for (let r = 1; r <= rounds; r++) {
    const mapped = periods[String(period)];
    if (Array.isArray(mapped) && mapped.length) {
      playoffRoundWeeks.push(mapped.map(Number));
      period++;
    } else {
      const len = byRound?.[String(r)] ?? (flat || 1);
      const weeks = [];
      for (let k = 0; k < len; k++) weeks.push(period++);
      playoffRoundWeeks.push(weeks);
    }
  }
  const playoffWeeks = [...new Set(playoffRoundWeeks.flat())];

  const divisions = (sched.divisions ?? []).filter((d) => (d?.size ?? 0) > 0);

  // Points per reception (statId 53) tells external sources which of their
  // PPR / half / standard columns is closest to this league. 0 when absent.
  const items = s.scoringSettings?.scoringItems ?? [];
  const rec = items.find((it) => it.statId === 53);
  const pprValue = rec ? Number(rec.points ?? 0) : 0;
  // The free-agent acquisition budget. 0 means the league does not bid at all and
  // runs on waiver priority instead. Read, never derived.
  const faabBudget = Number(s.acquisitionSettings?.acquisitionBudget) || 0;
  // The week ESPN considers current. Weeks before it have been played; the engine
  // must not count them toward a trade's value, and the season sim must start from
  // the standings as they are. `status` rides along with every league view.
  const currentWeek = raw.status?.currentMatchupPeriod ?? raw.scoringPeriodId ?? 1;
  return {
    name: s.name ?? "League",
    pprValue,
    faabBudget,
    currentWeek,
    lineupSlotCounts: counts,
    starters,
    benchSlots: bench,
    irSlots: ir,
    rosterSize: starters + bench,
    positionLimits: roster.positionLimits ?? null,
    regularSeasonWeeks,
    playoffWeeks,
    playoffRoundWeeks,
    playoffTeams,
    playoffRounds: rounds,
    playoffReseed: sched.playoffReseed !== false,
    seedingTiebreak: sched.playoffSeedingRule ?? "TOTAL_POINTS_SCORED",
    divisions,
    divisionCount: divisions.length > 1 ? divisions.length : 0,
  };
}

/**
 * Regular-season matchups: week -> [[teamNameA, teamNameB], ...].
 *
 * With a real schedule the projection is a real record. Without one it falls back
 * to an all-play share, which measures strength but not the opponents actually
 * faced - so it is worth asking for.
 */
export async function loadSchedule(ref, teamsById, opts = {}) {
  const { leagueId, seasonId } = ref;
  const blob = await get(seasonId, leagueId, "view=mSchedule", undefined, opts);
  const byWeek = new Map();
  for (const m of blob.schedule ?? []) {
    const wk = m.matchupPeriodId;
    const home = teamsById.get(m.home?.teamId)?.name;
    const away = teamsById.get(m.away?.teamId)?.name;
    if (!wk || !home || !away) continue;          // byes and playoff placeholders
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push([home, away]);
  }
  return byWeek;
}

/**
 * A player's weekly history in the platform-neutral shape the engine reads:
 * `[{ season, week, actual, proj }]`, one row per (season, week) ESPN reports,
 * `actual` and `proj` `number|null`, in the order the rows were first seen.
 *
 * The builder rule is the two readers it replaced: keep only one-week splits
 * (`statSplitTypeId === 1`), group by (seasonId, scoringPeriodId), and take
 * `statSourceId 0` as the actual and `1` as the projection; any other source is
 * ignored. Nothing is rounded here - `measureVolatility` always used the raw value
 * and `attachActuals` rounds on read, and moving the rounding would move numbers.
 * Every row keeps its season on purpose: ESPN returns last season's rows for the
 * same scoring period alongside this season's, and a reader that keys on week
 * alone measures ~15% low. Both readers filter on `season`.
 */
export function historyOf(stats) {
  const by = new Map();
  for (const st of stats ?? []) {
    if (st.statSplitTypeId !== 1) continue;
    if (st.statSourceId !== 0 && st.statSourceId !== 1) continue;   // an ignored source leaves no row
    const k = `${st.seasonId}:${st.scoringPeriodId}`;
    const row = by.get(k) ?? { season: st.seasonId, week: st.scoringPeriodId, actual: null, proj: null };
    if (st.statSourceId === 0) row.actual = st.appliedTotal;
    else if (st.statSourceId === 1) row.proj = st.appliedTotal;
    by.set(k, row);
  }
  return [...by.values()];
}

/**
 * The unrostered pool, scored under this league's own settings.
 *
 * One request, not one per week: a player's `stats` array already carries every
 * scoring period. Only players who could actually start are worth returning, so
 * anyone eligible for no starting slot is dropped by the caller.
 */
export async function loadFreeAgents(ref, weeks, opts = {}) {
  const { leagueId, seasonId } = ref;
  const limit = opts.limit ?? 400;
  const filter = {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      limit,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
    },
  };
  const blob = await get(seasonId, leagueId, "view=kona_player_info", filter, opts);
  const out = [];
  for (const entry of blob.players ?? []) {
    const p = entry.player ?? entry;
    const proj = {};
    for (const st of p.stats ?? []) {
      if (st.statSourceId === 1 && st.statSplitTypeId === 1 && st.seasonId === seasonId)
        proj[st.scoringPeriodId] = Math.round((st.appliedTotal ?? 0) * 100) / 100;
    }
    if (!weeks.some((w) => proj[w] > 0)) continue;      // nothing projected at all
    out.push({
      id: p.id, name: p.fullName, eligibleSlots: p.eligibleSlots ?? [],
      pos: positionLabel(p), posId: p.defaultPositionId ?? 0,
      injuryStatus: p.injuryStatus ?? null,
      injured: p.injured === true,
      nfl: PRO_TEAM[p.proTeamId] ?? "?",
      teamId: null, proj, history: historyOf(p.stats),
      owned: Math.round((p.ownership?.percentOwned ?? 0) * 10) / 10,
    });
  }
  return out;
}

/**
 * One light request - the same `view=mRoster&view=mTeam` call the daily check in
 * background.js makes - hashed over ESPN's own player ids. `loadLeague` calls this
 * too, so the panel and the service worker hash the same payload with the same
 * function; CLAUDE.md's "must stay in step" rule used to rest on two hand-kept
 * copies that did not agree on sort order. Null on any failure, including not being
 * signed in: a fingerprint is a nicety and must never cost the run.
 */
export async function fingerprint(ref, opts = {}) {
  try {
    const blob = await get(ref.seasonId, ref.leagueId, "view=mRoster&view=mTeam", undefined, opts);
    return hashRosters((blob.teams ?? []).map((t) => ({
      id: t.id,
      ids: (t.roster?.entries ?? []).map((e) => e.playerPoolEntry?.id ?? e.playerId),
    })));
  } catch { return null; }
}

/**
 * Pull a whole league. `onProgress(done, total, label)` drives the panel's status.
 * Weeks are fetched a few at a time - this is a signed-in user reading their own
 * league, and it should stay gentle enough to look like one.
 */
export async function loadLeague(ref, onProgress = () => {}, opts = {}) {
  const { leagueId, seasonId } = ref;
  const settingsRaw = await get(seasonId, leagueId, "view=mSettings", undefined, opts);
  // After the await, not before it. This used to fire first, so the panel flipped
  // "League settings" to done and "Rosters" to running before the settings request
  // had even been issued.
  onProgress(0, 1, "settings");
  const settings = readSettings(settingsRaw);
  const weeks = [...settings.regularSeasonWeeks, ...settings.playoffWeeks];

  const players = new Map();      // espn player id -> record
  const teams = new Map();        // team id -> {id, name, roster:Set}

  const readTeam = (t) => {
    const name = t.name || `${t.location ?? ""} ${t.nickname ?? ""}`.trim() || `Team ${t.id}`;
    const rec = teams.get(t.id) ?? {
      id: t.id, name, roster: new Set(), owners: t.owners ?? [],
      divisionId: t.divisionId ?? 0,
    };
    rec.name = name;
    rec.divisionId = t.divisionId ?? rec.divisionId ?? 0;
    // Games already played are decided; the season projection starts from them
    // rather than from 0-0. ESPN sends this with every mTeam view.
    if (t.record?.overall) rec.record = {
      wins: t.record.overall.wins ?? 0,
      losses: t.record.overall.losses ?? 0,
      ties: t.record.overall.ties ?? 0,
      pointsFor: t.record.overall.pointsFor ?? 0,
    };
    // What this team has already spent of that budget. ESPN sends it with mTeam.
    rec.faabSpent = t.transactionCounter?.acquisitionBudgetSpent ?? rec.faabSpent ?? 0;
    teams.set(t.id, rec);
    return rec;
  };

  // Every projection this player's payload happens to carry, for the weeks we want.
  // `seasonId` matters: ESPN returns the prior season's projection for the same
  // week alongside this one, and taking the first match can silently use it.
  const readProj = (p, pl, want) => {
    for (const st of p.stats ?? []) {
      if (st.statSourceId !== 1 || st.statSplitTypeId !== 1 || st.seasonId !== seasonId) continue;
      if (!want.has(st.scoringPeriodId)) continue;
      pl.proj[st.scoringPeriodId] = Math.round((st.appliedTotal ?? 0) * 100) / 100;
    }
  };

  const readPlayer = (p, rec, want) => {
    rec.roster.add(p.id);
    const pl = players.get(p.id) ?? {
      id: p.id, name: p.fullName,
      eligibleSlots: p.eligibleSlots ?? [],
      pos: positionLabel(p),
      posId: p.defaultPositionId ?? 0,
      // ESPN's own words, passed through rather than mapped: availability.js
      // owns the vocabulary, and an unknown string there means "playing".
      injuryStatus: p.injuryStatus ?? null,
      injured: p.injured === true,
      nfl: PRO_TEAM[p.proTeamId] ?? "?",
      teamId: rec.id, proj: {}, history: historyOf(p.stats),
    };
    pl.teamId = rec.id;
    if (p.injuryStatus != null) pl.injuryStatus = p.injuryStatus;
    if (p.injured != null) pl.injured = p.injured === true;
    readProj(p, pl, want);
    players.set(p.id, pl);
    return pl;
  };

  // Only the weeks that remain. The played ones were fetched and then thrown away by
  // `restrictToRemaining` before anything read them - and worse than wasted, because
  // rosters were unioned across every fetched week, so a man dropped in September was
  // still on his old team in November and the engine would trade him away. A season
  // already over keeps every week, the same rule `restrictToRemaining` uses.
  const cw = settings.currentWeek ?? 1;
  const remaining = weeks.filter((w) => w >= cw);
  const want = new Set(remaining.length ? remaining : weeks);

  // The authoritative roster: `view=mRoster&view=mTeam` with no `scoringPeriodId` is
  // the league as it stands right now, and it is the same payload the daily check
  // hashes. It used to be fetched separately at the end purely for the hash; reading
  // the league out of it instead makes the roster exact and the hash free.
  //
  // It must not become load-bearing, though: this request can fail on its own (a
  // rate limit, a flaky hop) and a fingerprint is a nicety. When it does, the week
  // payloads below build the league exactly as they always did and the hash is null,
  // which the daily check already reads as "adopt the first hash you compute".
  let fp = null;
  try {
    const rosterRaw = await get(seasonId, leagueId, "view=mRoster&view=mTeam", undefined, opts);
    for (const t of rosterRaw.teams ?? []) {
      const rec = readTeam(t);
      for (const e of t.roster?.entries ?? []) readPlayer(e.playerPoolEntry.player, rec, want);
    }
    fp = hashRosters((rosterRaw.teams ?? []).map((t) => ({
      id: t.id,
      ids: (t.roster?.entries ?? []).map((e) => e.playerPoolEntry?.id ?? e.playerId),
    })));
  } catch { /* fall through to the week payloads, with no hash */ }

  // A player's `stats` array often carries several scoring periods at once, so the
  // payload above may already have answered for weeks nobody has asked about yet.
  // Fetch only what is still missing - on a league whose payload carries the whole
  // remaining season that is nothing at all.
  const missing = players.size
    ? [...want].filter((w) => [...players.values()].some((pl) => pl.proj[w] == null))
    : [...want];
  let done = 0;
  const CONCURRENCY = 3;

  const fetchWeek = async (wk) => {
    const blob = await get(seasonId, leagueId,
      `view=mRoster&view=mTeam&scoringPeriodId=${wk}`, undefined, opts);
    const one = new Set([wk]);
    for (const t of blob.teams ?? []) {
      const rec = readTeam(t);
      for (const e of t.roster?.entries ?? []) readPlayer(e.playerPoolEntry.player, rec, one);
    }
    onProgress(++done, missing.length, `week ${wk}`);
  };

  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    await Promise.all(missing.slice(i, i + CONCURRENCY).map(fetchWeek));
  }
  if (!missing.length) onProgress(1, 1, "rosters");

  // A bye is a property of the NFL team, not the player: one player can project zero
  // for many reasons, but a whole pro roster only goes quiet together. Counted over
  // the weeks actually fetched - an unfetched week is silent for everybody, and an
  // argmax over silence would hand every player a bye he has already taken.
  const counted = [...want];
  const zeros = new Map();
  for (const p of players.values()) {
    const m = zeros.get(p.nfl) ?? new Map();
    for (const wk of counted) if (!(p.proj[wk] > 0)) m.set(wk, (m.get(wk) ?? 0) + 1);
    zeros.set(p.nfl, m);
  }
  const byeOf = new Map();
  for (const [nfl, m] of zeros) {
    let best = 0, bestN = 0;
    for (const [wk, n] of m) if (n > bestN) { best = wk; bestN = n; }
    byeOf.set(nfl, best);
  }
  for (const p of players.values()) p.bye = byeOf.get(p.nfl) ?? 0;

  return { settings, weeks, players, teams, fingerprint: fp, notes: [] };
}

/** The adapter object platforms/index.js registers (D-03). */
export default {
  id: "espn",
  label: "ESPN",
  hosts: ["https://lm-api-reads.fantasy.espn.com/*", "https://fantasy.espn.com/*"],
  acceptsToken: false,
  signInUrl: () => "https://fantasy.espn.com",
  parseLeagueUrl,
  loadLeague,
  loadFreeAgents,
  loadSchedule,
  identify,
  fingerprint,
};
