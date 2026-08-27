/**
 * ESPN league -> normalized model. Replaces the spreadsheet entirely.
 *
 * Nothing about any particular league is hardcoded. Slot layout, roster size, team
 * count, regular-season length and playoff format are all read from mSettings, and
 * player eligibility comes from each player's own `eligibleSlots`, so leagues with
 * superflex, IDP, TQB, RB/WR or two-week playoff rounds need no special handling.
 */

const API = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

/** Slot ids -> display labels. Cosmetic only; the engine matches on ids. */
export const SLOT_LABEL = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP",
  16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BE", 21: "IR", 23: "FLEX", 24: "ER",
};
const POS_LABEL = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 7: "P",
                    9: "DT", 10: "DE", 11: "LB", 12: "CB", 13: "S", 16: "D/ST" };

/** Slots that accept several positions, so they never name one. */
const MULTI_SLOTS = new Set([3, 5, 7, 11, 14, 15, 23]);   // RB/WR, WR/TE, OP, DL, DB, DP, FLEX

/**
 * A player's display position, derived from the slots he may fill.
 *
 * `defaultPositionId` is unreliable - this league's team-QB entities do not carry
 * one that maps to anything, which showed up as "?" in the UI. Eligibility is the
 * authoritative signal and it is what the engine already uses, so the label should
 * come from the same place: the first single-position slot he is allowed to start
 * in. That yields TQB for team quarterbacks, and works for IDP and superflex too.
 */
export function positionLabel(player) {
  const elig = (player.eligibleSlots ?? []).filter(
    (s) => !MULTI_SLOTS.has(s) && s !== 20 && s !== 21 && s !== 24);
  for (const slot of elig.sort((a, b) => a - b)) {
    if (SLOT_LABEL[slot]) return SLOT_LABEL[slot];
  }
  return POS_LABEL[player.defaultPositionId] ?? "?";
}
export const PRO_TEAM = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
  22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH",
  29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

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

async function get(season, leagueId, params, filter) {
  const url = `${API}/seasons/${season}/segments/0/leagues/${leagueId}?${params}`;
  const headers = { Accept: "application/json" };
  if (filter) headers["x-fantasy-filter"] = JSON.stringify(filter);
  const res = await fetch(url, { credentials: "include", headers });
  if (res.status === 401) throw new Error("Not signed in to ESPN, or no access to this league.");
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
  // The week ESPN considers current. Weeks before it have been played; the engine
  // must not count them toward a trade's value, and the season sim must start from
  // the standings as they are. `status` rides along with every league view.
  const currentWeek = raw.status?.currentMatchupPeriod ?? raw.scoringPeriodId ?? 1;
  return {
    name: s.name ?? "League",
    pprValue,
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
 * Per-player weekly volatility, measured from last season rather than assumed.
 *
 * ESPN returns the prior season's ACTUAL weekly scores (statSourceId 0) in the same
 * response as its projections (statSourceId 1), so the residual between them is a
 * real, league-scored measurement of how far a player lands from his projection.
 * No external data source is needed, and none would be better: this one is already
 * scored under the league's own rules.
 *
 * Returns {bySigma: Map(playerId -> sigma), byPos: Map(pos -> sigma), global}.
 * Players without enough history fall back to their position, then to the global.
 */
export function measureVolatility(players, priorSeason, minWeeks = 6) {
  const bySigma = new Map();
  const posSamples = new Map();
  const all = [];

  for (const p of players) {
    const act = new Map(), prj = new Map();
    for (const st of p.rawStats ?? []) {
      if (st.statSplitTypeId !== 1 || st.seasonId !== priorSeason) continue;
      if (st.statSourceId === 0) act.set(st.scoringPeriodId, st.appliedTotal);
      else if (st.statSourceId === 1) prj.set(st.scoringPeriodId, st.appliedTotal);
    }
    // Only weeks he was expected to play: a projection near zero means he was not
    // in the plan, and counting those measures roster churn rather than volatility.
    const weeks = [...act.keys()].filter(w => prj.has(w) && prj.get(w) > 1
      && act.get(w) != null && prj.get(w) != null);
    if (weeks.length >= minWeeks) {
      const res = weeks.map(w => act.get(w) - prj.get(w));
      const mean = res.reduce((a, b) => a + b, 0) / res.length;
      const sd = Math.sqrt(res.reduce((a, b) => a + (b - mean) ** 2, 0) / (res.length - 1));
      bySigma.set(p.id, sd);
      all.push(sd);
      if (!posSamples.has(p.pos)) posSamples.set(p.pos, []);
      posSamples.get(p.pos).push(sd);
    }
  }
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const byPos = new Map([...posSamples].map(([k, v]) => [k, median(v)]));
  return { bySigma, byPos, global: median(all) ?? 6, measured: bySigma.size };
}

/**
 * Regular-season matchups: week -> [[teamNameA, teamNameB], ...].
 *
 * With a real schedule the projection is a real record. Without one it falls back
 * to an all-play share, which measures strength but not the opponents actually
 * faced - so it is worth asking for.
 */
export async function loadSchedule({ leagueId, seasonId }, teamsById) {
  const blob = await get(seasonId, leagueId, "view=mSchedule");
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
 * The unrostered pool, scored under this league's own settings.
 *
 * One request, not one per week: a player's `stats` array already carries every
 * scoring period. Only players who could actually start are worth returning, so
 * anyone eligible for no starting slot is dropped by the caller.
 */
export async function loadFreeAgents({ leagueId, seasonId }, weeks, limit = 400) {
  const filter = {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      limit,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
    },
  };
  const blob = await get(seasonId, leagueId, "view=kona_player_info", filter);
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
      nfl: PRO_TEAM[p.proTeamId] ?? "?",
      teamId: null, proj, rawStats: p.stats ?? [],
      owned: Math.round((p.ownership?.percentOwned ?? 0) * 10) / 10,
    });
  }
  return out;
}

/**
 * Pull a whole league. `onProgress(done, total, label)` drives the panel's status.
 * Weeks are fetched a few at a time - this is a signed-in user reading their own
 * league, and it should stay gentle enough to look like one.
 */
export async function loadLeague({ leagueId, seasonId }, onProgress = () => {}) {
  onProgress(0, 1, "settings");
  const settingsRaw = await get(seasonId, leagueId, "view=mSettings");
  const settings = readSettings(settingsRaw);
  const weeks = [...settings.regularSeasonWeeks, ...settings.playoffWeeks];

  const players = new Map();      // espn player id -> record
  const teams = new Map();        // team id -> {id, name, roster:Set}
  let done = 0;
  const CONCURRENCY = 3;

  const fetchWeek = async (wk) => {
    const blob = await get(seasonId, leagueId,
      `view=mRoster&view=mTeam&scoringPeriodId=${wk}`);
    for (const t of blob.teams ?? []) {
      const name = t.name || `${t.location ?? ""} ${t.nickname ?? ""}`.trim() || `Team ${t.id}`;
      const rec = teams.get(t.id) ?? {
        id: t.id, name, roster: new Set(), owners: t.owners ?? [],
        divisionId: t.divisionId ?? 0,
      };
      rec.name = name;
      rec.divisionId = t.divisionId ?? rec.divisionId ?? 0;
      teams.set(t.id, rec);
      for (const e of t.roster?.entries ?? []) {
        const p = e.playerPoolEntry.player;
        rec.roster.add(p.id);
        const pl = players.get(p.id) ?? {
          id: p.id, name: p.fullName,
          eligibleSlots: p.eligibleSlots ?? [],
          pos: positionLabel(p),
          posId: p.defaultPositionId ?? 0,
          nfl: PRO_TEAM[p.proTeamId] ?? "?",
          teamId: t.id, proj: {}, rawStats: p.stats ?? [],
        };
        pl.teamId = t.id;
        // seasonId matters: ESPN returns the prior season's projection for the same
        // week alongside this one, and taking the first match can silently use it.
        const stat = (p.stats ?? []).find(st =>
          st.statSourceId === 1 && st.statSplitTypeId === 1
          && st.scoringPeriodId === wk && st.seasonId === seasonId);
        pl.proj[wk] = Math.round((stat?.appliedTotal ?? 0) * 100) / 100;
        players.set(p.id, pl);
      }
    }
    onProgress(++done, weeks.length, `week ${wk}`);
  };

  for (let i = 0; i < weeks.length; i += CONCURRENCY) {
    await Promise.all(weeks.slice(i, i + CONCURRENCY).map(fetchWeek));
  }

  // A bye is a property of the NFL team, not the player: one player can project zero
  // for many reasons, but a whole pro roster only goes quiet together.
  const zeros = new Map();
  for (const p of players.values()) {
    const m = zeros.get(p.nfl) ?? new Map();
    for (const wk of weeks) if (!(p.proj[wk] > 0)) m.set(wk, (m.get(wk) ?? 0) + 1);
    zeros.set(p.nfl, m);
  }
  const byeOf = new Map();
  for (const [nfl, m] of zeros) {
    let best = 0, bestN = 0;
    for (const [wk, n] of m) if (n > bestN) { best = wk; bestN = n; }
    byeOf.set(nfl, best);
  }
  for (const p of players.values()) p.bye = byeOf.get(p.nfl) ?? 0;

  return { settings, weeks, players, teams };
}
