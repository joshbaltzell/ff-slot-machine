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

/** The signed-in user's SWID, used to find which team is theirs. */
export async function mySwid() {
  try {
    const c = await chrome.cookies.get({ url: "https://fantasy.espn.com", name: "SWID" });
    return c?.value ?? null;
  } catch { return null; }
}

/** Everything the engine needs, read rather than assumed. */
export function readSettings(raw) {
  const s = raw.settings ?? {};
  const roster = s.rosterSettings ?? {};
  const sched = s.scheduleSettings ?? {};
  // Split starting seats from bench/IR. Everything downstream treats
  // lineupSlotCounts as the starting lineup, so it must not contain either.
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
  const regWeeks = sched.matchupPeriodCount ?? 14;
  const roundLen = sched.playoffMatchupPeriodLength ?? 1;
  const playoffTeams = sched.playoffTeamCount ?? 6;
  const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(playoffTeams, 2))));
  const playoffWeeks = [];
  for (let i = 0; i < rounds * roundLen; i++) playoffWeeks.push(regWeeks + 1 + i);
  return {
    name: s.name ?? "League",
    lineupSlotCounts: counts,
    starters,
    benchSlots: bench,
    irSlots: ir,
    rosterSize: starters + bench,
    positionLimits: roster.positionLimits ?? null,
    regularSeasonWeeks: Array.from({ length: regWeeks }, (_, i) => i + 1),
    playoffWeeks,
    playoffTeams,
    playoffRoundLength: roundLen,
    playoffRounds: rounds,
    divisions: (s.scheduleSettings?.divisions ?? []).length,
  };
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
      const rec = teams.get(t.id) ?? { id: t.id, name, roster: new Set(), owners: t.owners ?? [] };
      rec.name = name;
      teams.set(t.id, rec);
      for (const e of t.roster?.entries ?? []) {
        const p = e.playerPoolEntry.player;
        rec.roster.add(p.id);
        const pl = players.get(p.id) ?? {
          id: p.id, name: p.fullName,
          eligibleSlots: p.eligibleSlots ?? [],
          pos: positionLabel(p),
          nfl: PRO_TEAM[p.proTeamId] ?? "?",
          teamId: t.id, proj: {},
        };
        pl.teamId = t.id;
        const stat = (p.stats ?? []).find(st =>
          st.statSourceId === 1 && st.statSplitTypeId === 1 && st.scoringPeriodId === wk);
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
