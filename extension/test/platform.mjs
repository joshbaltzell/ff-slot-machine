/**
 * The normalized-model schema every platform adapter must satisfy, run against each
 * entry of PLATFORMS on recorded or synthetic raw payloads, plus the registry's own
 * contract: detect, byId, hashRosters, the storage keys and the AUTH error code. The ESPN adapter runs
 * here offline on a raw payload synthesized from fixture.json and must reproduce the
 * fixture. parity.mjs is never touched.
 *
 * Import order is part of the test: the registry first, then anything from
 * league.js. That is the other entry order of the league.js <-> platforms/espn.js
 * cycle (distributions.mjs enters through league.js), so the suite pins both.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PLATFORMS, byId, detect, hashRosters, leagueKey, migrateStorageKeys, nextLeagueRecord }
  from "../engine/platforms/index.js";
import espn, { espnUrl, readSettings, historyOf } from "../engine/platforms/espn.js";
import { PRO_TEAM, measureVolatility } from "../engine/league.js";
import { BENCH_SLOTS } from "../engine/lineup.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Clones on the way in and out, as chrome.storage.local does; get(null) returns the
// whole store so a key-migration test can see every entry it rewrote.
const mkStorage = () => { const m = new Map(); return {
  async get(k) {
    if (k == null) return Object.fromEntries([...m].map(([kk, v]) => [kk, structuredClone(v)]));
    if (Array.isArray(k)) return Object.fromEntries(k.filter((kk) => m.has(kk)).map((kk) => [kk, structuredClone(m.get(kk))]));
    return { [k]: structuredClone(m.get(k)) };
  },
  async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
  async remove(k) { for (const kk of [].concat(k)) m.delete(kk); }, _m: m }; };
// A fetch over a URL-keyed table. An Error entry throws; an httpError(status, text)
// entry answers a non-JSON error body (CBS says "User not signed in" with a 400);
// anything else is a 200 with that JSON. `calls` records URLs, `inits` the options.
const httpError = (status, text = "") => ({ __http: status, text });
const mkFetch = (table) => { const calls = [], inits = []; const f = async (url, init) => { calls.push(url); inits.push(init);
  const hit = table[url]; if (hit === undefined) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  if (hit && typeof hit.__http === "number")
    return { ok: hit.__http >= 200 && hit.__http < 300, status: hit.__http,
             json: async () => JSON.parse(hit.text), text: async () => hit.text };
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; };
  f.calls = calls; f.inits = inits; return f; };

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "manifest.json")));

/* schema */
// The contract `loadLeague` returns, key for key (RESEARCH §2). Later plans extend
// this function in place; it stays local so the schema has exactly one home.
const SETTINGS_KEYS = ["name", "pprValue", "faabBudget", "currentWeek", "lineupSlotCounts", "starters",
  "benchSlots", "irSlots", "rosterSize", "positionLimits", "regularSeasonWeeks", "playoffWeeks",
  "playoffRoundWeeks", "playoffTeams", "playoffRounds", "playoffReseed", "seedingTiebreak",
  "divisions", "divisionCount"];
const NUMERIC_SETTINGS = ["pprValue", "faabBudget", "currentWeek", "starters", "benchSlots", "irSlots",
  "rosterSize", "playoffTeams", "playoffRounds", "divisionCount"];
const NFL_OK = new Set([...Object.values(PRO_TEAM), "X", "?", "FA", ""]);   // PRO_TEAM or a PLACEHOLDER
const numArr = (a) => Array.isArray(a) && a.every((x) => typeof x === "number");
// Every key a player record may carry. The platform's raw stat rows are not among
// them: the adapter folds them into `history` and nothing downstream sees the raw shape.
const PLAYER_KEYS = new Set(["id", "name", "eligibleSlots", "pos", "posId", "injuryStatus", "injured",
  "nfl", "teamId", "proj", "history", "bye", "owned"]);
const numOrNull = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
const historyRow = (h) => h && typeof h === "object" && same(Object.keys(h).sort(), ["actual", "proj", "season", "week"])
  && Number.isInteger(h.season) && Number.isInteger(h.week) && numOrNull(h.actual) && numOrNull(h.proj);

function assertModel(model, label) {
  const s = model.settings;
  ok(s && typeof s === "object", `${label}: settings is an object`);
  ok(same(Object.keys(s).sort(), [...SETTINGS_KEYS].sort()),
     `${label}: settings has exactly the ${SETTINGS_KEYS.length} contract keys`);
  ok(typeof s.name === "string" && s.name.length > 0, `${label}: settings.name is a non-empty string`);
  ok(NUMERIC_SETTINGS.every((k) => typeof s[k] === "number" && Number.isFinite(s[k])),
     `${label}: the numeric settings fields are finite numbers`);
  ok(typeof s.playoffReseed === "boolean", `${label}: playoffReseed is a boolean`);
  ok(typeof s.seedingTiebreak === "string", `${label}: seedingTiebreak is a string`);
  ok(s.positionLimits === null || typeof s.positionLimits === "object", `${label}: positionLimits is an object or null`);
  ok(Array.isArray(s.divisions), `${label}: divisions is an array`);
  ok(Object.keys(s.lineupSlotCounts).every((k) => Number.isInteger(Number(k)) && !BENCH_SLOTS.has(Number(k)))
     && Object.values(s.lineupSlotCounts).every((n) => typeof n === "number" && n > 0),
     `${label}: lineupSlotCounts has integer slot ids, none of them bench or IR, every count positive`);
  ok(numArr(s.regularSeasonWeeks) && numArr(s.playoffWeeks)
     && Array.isArray(s.playoffRoundWeeks) && s.playoffRoundWeeks.every(numArr),
     `${label}: the week arrays are arrays of numbers`);
  ok(s.starters === Object.values(s.lineupSlotCounts).reduce((a, b) => a + b, 0)
     && s.rosterSize === s.starters + s.benchSlots,
     `${label}: starters sums the slot counts and rosterSize is starters plus bench`);
  ok(same(model.weeks, [...s.regularSeasonWeeks, ...s.playoffWeeks]), `${label}: weeks is the regular season then the playoffs`);

  ok(model.players instanceof Map && model.players.size > 0, `${label}: players is a non-empty Map`);
  ok(model.teams instanceof Map && model.teams.size > 0, `${label}: teams is a non-empty Map`);
  const teamKeys = new Set(model.teams.keys());
  const players = [...model.players.values()];
  ok(players.every((p) => typeof p.id === "number" && model.players.get(p.id) === p), `${label}: every player has a numeric id and is keyed on it`);
  ok(players.every((p) => typeof p.name === "string"), `${label}: every player has a string name`);
  ok(players.every((p) => Array.isArray(p.eligibleSlots) && p.eligibleSlots.every(Number.isInteger)),
     `${label}: eligibleSlots is an array of integer slot ids`);
  ok(players.every((p) => typeof p.pos === "string"), `${label}: pos is a string`);
  ok(players.every((p) => typeof p.posId === "number"), `${label}: posId is a number`);
  ok(players.every((p) => p.injuryStatus === null || typeof p.injuryStatus === "string"), `${label}: injuryStatus is a string or null`);
  ok(players.every((p) => typeof p.injured === "boolean"), `${label}: injured is a boolean`);
  ok(players.every((p) => NFL_OK.has(p.nfl)), `${label}: nfl is a PRO_TEAM abbreviation or a placeholder`);
  ok(players.every((p) => p.teamId === null || teamKeys.has(p.teamId)), `${label}: teamId is a team key or null`);
  ok(players.every((p) => p.proj && typeof p.proj === "object" && Object.values(p.proj).every((v) => typeof v === "number")),
     `${label}: proj is an object of numbers`);
  ok(players.every((p) => typeof p.bye === "number"), `${label}: bye is a number`);
  ok(players.every((p) => Array.isArray(p.history) && p.history.every(historyRow)),
     `${label}: history is an array of {season, week, actual, proj} rows - integer season and week, number-or-null values`);
  ok(players.every((p) => Object.keys(p).every((k) => PLAYER_KEYS.has(k))),
     `${label}: no player carries a key outside the contract - the platform's raw stat rows never reach the model`);

  const teams = [...model.teams.values()];
  ok(teams.every((t) => typeof t.id === "number" && model.teams.get(t.id) === t), `${label}: every team has a numeric id and is keyed on it`);
  ok(teams.every((t) => typeof t.name === "string" && t.name.length > 0), `${label}: every team has a non-empty name`);
  ok(teams.every((t) => t.roster instanceof Set && [...t.roster].every((id) => model.players.has(id))),
     `${label}: roster is a Set of player keys`);
  ok(teams.every((t) => Array.isArray(t.owners)), `${label}: owners is an array`);
  ok(teams.every((t) => typeof t.divisionId === "number"), `${label}: divisionId is a number`);
  ok(teams.every((t) => t.record === undefined
       || ["wins", "losses", "ties", "pointsFor"].every((k) => typeof t.record[k] === "number")),
     `${label}: record is absent or {wins, losses, ties, pointsFor} numbers`);
  ok(teams.every((t) => typeof t.faabSpent === "number"), `${label}: faabSpent is a number`);
  ok(model.fingerprint === null || typeof model.fingerprint === "string", `${label}: fingerprint is a string or null`);
  ok(Array.isArray(model.notes) && model.notes.every((n) => typeof n === "string"), `${label}: notes is an array of strings`);
}

/* espn: synthetic raw payload from fixture.json */
// fixture.json is a normalized snapshot; this rebuilds the raw ESPN shapes readSettings
// and loadLeague read so the adapter can be driven offline and asked to give the
// fixture back. Team id is the index in F.teams; player ids are the fixture's.
const PRIOR_WEEKS = [1, 2, 3, 4, 5, 6, 7, 8];
const PRIOR_RES = [2, -2, 4, -4, 1, -1, 10, -10];       // actual minus projection, mean zero
const priorProj = (id) => 10 + (id % 3);
function mkEspnRaw(F, seasonId) {
  const settingsRaw = {
    settings: {
      name: "Fixture League",
      rosterSettings: { lineupSlotCounts: { ...F.lineupSlotCounts, 20: 7 } },
      scheduleSettings: { matchupPeriodCount: 15, playoffTeamCount: 6, playoffMatchupPeriodLength: 1 },
      scoringSettings: { scoringItems: [{ statId: 53, points: 1 }] },
      acquisitionSettings: { acquisitionBudget: 100 },
    },
    status: { currentMatchupPeriod: 1 },
  };
  const rows = (id) => [
    // Prior-season rows first: a reader that ignores seasonId takes these. Weeks 1-8
    // carry a projection and an actual each, so the history the adapter builds can
    // feed measureVolatility; the residuals are fixed so the test can name them.
    ...PRIOR_WEEKS.flatMap((wk, k) => [
      { statSourceId: 1, statSplitTypeId: 1, seasonId: seasonId - 1, scoringPeriodId: wk, appliedTotal: priorProj(id) },
      { statSourceId: 0, statSplitTypeId: 1, seasonId: seasonId - 1, scoringPeriodId: wk, appliedTotal: priorProj(id) + PRIOR_RES[k] },
    ]),
    // Two decoys historyOf must drop: a season total (split 0) and an unknown source
    // at a week no other row reports, so a builder that kept either would show a row.
    { statSourceId: 0, statSplitTypeId: 0, seasonId: seasonId - 1, scoringPeriodId: 0, appliedTotal: 555 },
    { statSourceId: 2, statSplitTypeId: 1, seasonId: seasonId - 1, scoringPeriodId: 9, appliedTotal: 444 },
    ...F.weeks.map((wk, k) => ({ statSourceId: 1, statSplitTypeId: 1, seasonId, scoringPeriodId: wk, appliedTotal: F.proj[id][k] })),
  ];
  const team = (name, id) => ({
    id, name,
    roster: { entries: F.rosters[name].map((pid) => ({ playerPoolEntry: { id: pid, player: {
      id: pid, fullName: "p" + pid, eligibleSlots: [...F.eligibleSlots[F.pos[pid]]], defaultPositionId: 0,
      proTeamId: 0, injuryStatus: "ACTIVE", injured: false, stats: rows(pid) } } })) },
  });
  const teamsRaw = () => ({ teams: F.teams.map((name, id) => team(name, id)) });
  return { settingsRaw, weekRaw: () => teamsRaw(), currentRaw: teamsRaw() };
}
function fetchTable(ref, raw) {
  const t = {
    [espnUrl(ref.seasonId, ref.leagueId, "view=mSettings")]: raw.settingsRaw,
    [espnUrl(ref.seasonId, ref.leagueId, "view=mRoster&view=mTeam")]: raw.currentRaw,
  };
  for (const wk of F.weeks)
    t[espnUrl(ref.seasonId, ref.leagueId, `view=mRoster&view=mTeam&scoringPeriodId=${wk}`)] = raw.weekRaw(wk);
  return t;
}
// The panel's fingerprint as it was written before the seam, kept here so the shared
// hash is pinned to the value every stored `rosterHash` already carries.
const legacyFingerprint = (model) => {
  const parts = [...model.teams.values()]
    .map((t) => `${t.id}:${[...t.roster].sort((a, b) => a - b).join(",")}`).sort();
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
};

const REF = { platform: "espn", leagueId: 1, seasonId: 2026 };
const RAW = mkEspnRaw(F, REF.seasonId);
// One offline drive per adapter. 11-05 adds cbs on its recorded payloads; an adapter
// with no entry here fails the suite rather than silently skipping the schema.
const DRIVES = {
  espn: () => ({ ref: REF, fetchImpl: mkFetch(fetchTable(REF, RAW)) }),
};

/* every adapter satisfies the contract and the schema */
const MODELS = {};
for (const p of PLATFORMS) {
  ok(typeof p.id === "string" && typeof p.label === "string", `${p.id}: has string id and label`);
  ok(Array.isArray(p.hosts) && p.hosts.length > 0 && p.hosts.every((h) => /^https:\/\/.+\/\*$/.test(h)),
     `${p.id}: hosts are https match patterns`);
  ok(typeof p.acceptsToken === "boolean", `${p.id}: acceptsToken is a boolean`);
  ok(typeof p.signInUrl === "function" && /^https:\/\//.test(p.signInUrl({ leagueId: 1, seasonId: 2026 })),
     `${p.id}: signInUrl(ref) is an https URL`);
  ok(["parseLeagueUrl", "loadLeague", "loadFreeAgents", "loadSchedule", "identify", "fingerprint"]
       .every((fn) => typeof p[fn] === "function"), `${p.id}: implements the six loader functions`);
  ok(byId(p.id) === p, `${p.id}: byId resolves to the registered adapter`);
  const drive = DRIVES[p.id];
  ok(typeof drive === "function", `${p.id}: has an offline payload to drive the schema test`);
  if (!drive) continue;
  const { ref, fetchImpl } = drive();
  const progress = [];
  MODELS[p.id] = await p.loadLeague(ref, (d, t, l) => progress.push([d, t, l]), { fetchImpl });
  assertModel(MODELS[p.id], p.id);
  ok(same(progress[0], [0, 1, "settings"]) && progress.at(-1)[0] === progress.at(-1)[1] && progress.at(-1)[1] > 0,
     `${p.id}: onProgress starts at settings and ends at total/total`);
}
ok(PLATFORMS.includes(espn) && PLATFORMS[0] === espn, "the ESPN adapter is registered first");
ok(same(byId("espn"), espn) && byId("nope") === null && byId(undefined) === null, "byId: espn resolves, unknown and missing are null");
ok(manifest.host_permissions && PLATFORMS.flatMap((p) => p.hosts).every((h) => manifest.host_permissions.includes(h)),
   "manifest host_permissions cover every adapter's hosts");

/* espn reproduces the fixture */
{
  const model = MODELS.espn;
  const s = model.settings;
  ok(same(s.lineupSlotCounts, F.lineupSlotCounts), "lineupSlotCounts equals the fixture's (bench excluded)");
  ok(same(model.weeks, F.weeks), "weeks equals the fixture's 18 weeks");
  ok(same(s.regularSeasonWeeks, F.weeks.slice(0, 15)) && same(s.playoffWeeks, [16, 17, 18])
     && same(s.playoffRoundWeeks, [[16], [17], [18]]), "15 regular-season weeks then three one-week playoff rounds");
  ok(s.benchSlots === 7 && s.rosterSize === 16 && s.irSlots === 0 && s.starters === 9,
     "benchSlots 7, rosterSize 16, no IR, nine starters");
  ok(s.faabBudget === 100 && s.pprValue === 1 && s.playoffTeams === 6 && s.playoffRounds === 3,
     "faabBudget 100, pprValue 1, six playoff teams in three rounds");
  ok(s.currentWeek === 1 && s.name === "Fixture League" && s.positionLimits === null, "currentWeek, name and positionLimits are read, not derived");
  ok(model.players.size === F.pos.length && model.teams.size === F.teams.length, "160 players on ten teams");
  const ps = [...model.players.values()];
  ok(ps.every((p) => same(p.eligibleSlots, F.eligibleSlots[F.pos[p.id]])), "every player's eligibleSlots equals the fixture's for his label");
  ok(ps.every((p) => p.pos === F.pos[p.id]), "every player's pos is derived from eligibleSlots and equals the fixture label");
  ok(ps.every((p) => F.weeks.every((wk, k) => p.proj[wk] === Math.round(F.proj[p.id][k] * 100) / 100)),
     "every proj[w] equals the fixture projection rounded to cents; the prior-season decoy is ignored");
  ok(ps.every((p) => p.nfl === "FA" && p.posId === 0 && p.injuryStatus === "ACTIVE" && p.injured === false),
     "proTeamId 0 is FA, posId and injury fields pass through");
  ok(F.teams.every((name, id) => model.teams.get(id).name === name
       && same([...model.teams.get(id).roster].sort((a, b) => a - b), F.rosters[name])),
     "each team's roster equals the fixture roster set");
  ok(ps.every((p) => p.teamId != null && model.teams.get(p.teamId).roster.has(p.id)), "every player's teamId points at the team that rosters him");
  ok(ps.every((p) => Array.isArray(p.history)), "every player carries a history array");
  ok(same(model.notes, []), "the ESPN adapter emits no notes");
}

/* fingerprint: one shared hash */
{
  const model = MODELS.espn;
  const fromRaw = hashRosters(RAW.currentRaw.teams.map((t) => ({
    id: t.id, ids: t.roster.entries.map((e) => e.playerPoolEntry.id) })));
  ok(typeof model.fingerprint === "string" && model.fingerprint === fromRaw,
     "model.fingerprint is hashRosters over the no-period roster payload");
  ok(model.fingerprint === legacyFingerprint(model), "…and equals the panel's legacy 31-hash for the same rosters");
  const f = mkFetch(fetchTable(REF, RAW));
  ok(await espn.fingerprint(REF, { fetchImpl: f }) === model.fingerprint && f.calls.length === 1,
     "fingerprint(ref) is one request and hashes to the same value");
  ok(await espn.fingerprint(REF, { fetchImpl: mkFetch({}) }) === null, "fingerprint is null when the request fails");
  ok(await espn.fingerprint(REF, { fetchImpl: async () => ({ ok: false, status: 401 }) }) === null,
     "fingerprint is null when not signed in, never a throw");
  // Drop only the no-period entry from a fresh table: the league must still load.
  const table = fetchTable(REF, RAW); delete table[espnUrl(REF.seasonId, REF.leagueId, "view=mRoster&view=mTeam")];
  const partial = await espn.loadLeague(REF, () => {}, { fetchImpl: mkFetch(table) });
  ok(partial.fingerprint === null && partial.players.size === F.pos.length,
     "a failed fingerprint request costs a null, not the league");

  const teams = [{ id: 2, ids: [30, 10, 20] }, { id: 1, ids: [3, 1, 2] }];
  const shuffled = [{ id: 1, ids: [2, 3, 1] }, { id: 2, ids: [20, 30, 10] }];
  ok(hashRosters(teams) === hashRosters(shuffled), "hashRosters is independent of team and id order");
  ok(hashRosters(teams) !== hashRosters([{ id: 2, ids: [30, 10, 21] }, { id: 1, ids: [3, 1, 2] }]),
     "a one-id difference hashes differently");
  ok(hashRosters([{ id: 1, ids: ["10", "9"] }]) === hashRosters([{ id: 1, ids: [9, 10] }]),
     "ids sort numerically whether they arrive as strings or numbers");
  ok(hashRosters([]) === "0" && hashRosters([{ id: 1, ids: [] }]) === hashRosters([{ id: 1, ids: [] }]),
     "empty inputs hash deterministically");
}

/* the AUTH contract */
{
  let err = null;
  try { await espn.loadLeague(REF, () => {}, { fetchImpl: async () => ({ ok: false, status: 401 }) }); } catch (e) { err = e; }
  ok(err instanceof Error && err.code === "AUTH", "a 401 rejects loadLeague with code AUTH");
  ok(/ESPN/.test(err?.message ?? ""), "…and the message names the platform");
  err = null;
  try { await espn.loadLeague(REF, () => {}, { fetchImpl: async () => ({ ok: false, status: 500 }) }); } catch (e) { err = e; }
  ok(err instanceof Error && err.code === undefined && /500/.test(err.message), "a 500 rejects with a plain Error and no code");
  err = null;
  try { await espn.loadFreeAgents(REF, F.weeks, { fetchImpl: async () => ({ ok: false, status: 401 }) }); } catch (e) { err = e; }
  ok(err?.code === "AUTH", "loadFreeAgents carries the same code");
  err = null;
  try { await espn.loadSchedule(REF, MODELS.espn.teams, { fetchImpl: async () => ({ ok: false, status: 401 }) }); } catch (e) { err = e; }
  ok(err?.code === "AUTH", "loadSchedule carries the same code");
  const body = mkFetch({ u: httpError(400, "User not signed in") });
  const r = await body("u");
  ok(r.ok === false && r.status === 400 && (await r.text()) === "User not signed in", "mkFetch answers a non-JSON error body for the CBS case");
}

/* free agents and the schedule, offline */
{
  const fa = (id, proTeamId, proj) => ({ player: {
    id, fullName: `fa${id}`, eligibleSlots: [2, 23, 20], defaultPositionId: 2, proTeamId,
    injuryStatus: "QUESTIONABLE", injured: false, ownership: { percentOwned: 12.34 },
    stats: Object.entries(proj).map(([wk, pts]) => ({ statSourceId: 1, statSplitTypeId: 1, seasonId: REF.seasonId, scoringPeriodId: Number(wk), appliedTotal: pts }))
      .concat([{ statSourceId: 1, statSplitTypeId: 1, seasonId: REF.seasonId - 1, scoringPeriodId: 1, appliedTotal: 50 }]) } });
  const table = { [espnUrl(REF.seasonId, REF.leagueId, "view=kona_player_info")]:
    { players: [fa(9001, 12, { 1: 8.123, 2: 9 }), fa(9002, 25, {})] } };
  const f = mkFetch(table);
  const out = await espn.loadFreeAgents(REF, F.weeks, { fetchImpl: f });
  ok(out.length === 1 && out[0].id === 9001, "a free agent with no projection anywhere is dropped");
  ok(out[0].nfl === "KC" && out[0].pos === "RB" && out[0].teamId === null && out[0].owned === 12.3,
     "free-agent record: nfl from PRO_TEAM, pos from eligibleSlots, teamId null, owned to a tenth");
  ok(out[0].proj[1] === 8.12 && out[0].proj[2] === 9 && !(1 in out[0].proj && out[0].proj[1] === 50),
     "free-agent proj is rounded to cents and filtered on seasonId");
  ok(JSON.parse(f.inits[0].headers["x-fantasy-filter"]).players.limit === 400, "the default limit is 400");
  await espn.loadFreeAgents(REF, F.weeks, { fetchImpl: f, limit: 25 });
  ok(JSON.parse(f.inits[1].headers["x-fantasy-filter"]).players.limit === 25, "opts.limit reaches the filter");
  ok(f.inits[0].credentials === "include", "the session cookie rides along");

  const sched = { [espnUrl(REF.seasonId, REF.leagueId, "view=mSchedule")]: { schedule: [
    { matchupPeriodId: 1, home: { teamId: 0 }, away: { teamId: 1 } },
    { matchupPeriodId: 1, home: { teamId: 2 } },                       // a bye: skipped
    { matchupPeriodId: 16, home: { teamId: 0 }, away: { teamId: 9 } },
    { matchupPeriodId: 17, home: { teamId: 99 }, away: { teamId: 1 } }, // unknown team: skipped
  ] } };
  const byWeek = await espn.loadSchedule(REF, MODELS.espn.teams, { fetchImpl: mkFetch(sched) });
  ok(byWeek instanceof Map && byWeek.size === 2, "schedule keeps only complete matchups, keyed by week");
  ok(same(byWeek.get(1), [["Team A", "Team B"]]) && same(byWeek.get(16), [["Team A", "Team J"]]),
     "matchups are pairs of team names");
}

/* identify: the team page wins, then the cookie, then honesty */
{
  // mySwid reaches for chrome.cookies and swallows the ReferenceError under Node,
  // so identify runs here with no cookie at all.
  const model = MODELS.espn;
  ok(same(await espn.identify({ ...REF, teamId: 3 }, model), { team: "Team D", how: "the team page you came from" }),
     "identify prefers the team page the user came from");
  ok(same(await espn.identify({ ...REF, teamId: 0 }, model), { team: "Team A", how: "the team page you came from" }),
     "team id 0 is a team, not a missing value");
  ok(same(await espn.identify(REF, model), { team: null, how: null }), "with no page and no cookie it says so rather than guessing");
}

/* detect */
{
  const year = new Date().getFullYear();
  const table = [
    ["https://fantasy.espn.com/football/team?leagueId=7&seasonId=2026&teamId=3", { platform: "espn", leagueId: 7, seasonId: 2026, teamId: 3 }],
    ["https://fantasy.espn.com/football/league?leagueId=7&seasonId=2025", { platform: "espn", leagueId: 7, seasonId: 2025, teamId: null }],
    ["https://fantasy.espn.com/football/league?leagueId=42", { platform: "espn", leagueId: 42, seasonId: year, teamId: null }],
    ["https://fantasy.espn.com/football/players/add", null],
    ["https://www.example.com/football/team?leagueId=7&seasonId=2026", null],
    ["not a url", null],
  ];
  for (const [url, want] of table) {
    const got = detect(url);
    const eq = want === null ? got === null
      : got !== null && Object.keys(want).every((k) => got[k] === want[k]) && Object.keys(got).length === Object.keys(want).length;
    ok(eq, `detect(${url}) -> ${JSON.stringify(want)}`);
  }
  ok(detect("https://fantasy.espn.com/football/team?leagueId=7").platform === "espn", "detect stamps the adapter id");
  ok(espn.parseLeagueUrl("https://fantasy.espn.com/football/team?leagueId=7").platform === undefined,
     "parseLeagueUrl itself does not know its platform; detect adds it");
}

/* readSettings on an empty payload (probe ESPN-UNCHANGED/empty) */
{
  for (const [raw, label] of [[{ settings: {} }, "{settings: {}}"], [{}, "{}"]]) {
    const s = readSettings(raw);
    ok(same(Object.keys(s).sort(), [...SETTINGS_KEYS].sort()), `readSettings(${label}) returns every contract key`);
    ok(same(s.lineupSlotCounts, {}) && s.starters === 0 && s.benchSlots === 0 && s.irSlots === 0 && s.rosterSize === 0,
       `readSettings(${label}): no slots, no starters, no roster`);
    ok(s.positionLimits === null && s.regularSeasonWeeks.length === 14 && same(s.playoffWeeks, [15, 16, 17]),
       `readSettings(${label}): positionLimits null, 14 regular-season weeks, playoffs 15-17 by default`);
    ok(s.currentWeek === 1 && s.name === "League" && s.pprValue === 0 && s.faabBudget === 0
       && s.playoffTeams === 6 && s.playoffRounds === 3 && s.playoffReseed === true
       && s.seedingTiebreak === "TOTAL_POINTS_SCORED" && same(s.divisions, []) && s.divisionCount === 0,
       `readSettings(${label}): every default is the documented one`);
  }
}

/* history: the builder, and the synthetic model feeding measureVolatility through it */
{
  const one = historyOf([
    { statSplitTypeId: 1, seasonId: 2025, statSourceId: 1, scoringPeriodId: 5, appliedTotal: 10 },
    { statSplitTypeId: 1, seasonId: 2025, statSourceId: 0, scoringPeriodId: 5, appliedTotal: 13.456 },
  ]);
  ok(same(one, [{ season: 2025, week: 5, actual: 13.456, proj: 10 }]),
     "historyOf folds the projection and the actual for one (season, week) into one row, unrounded");
  ok(same(historyOf(undefined), []) && same(historyOf([]), []), "historyOf of nothing is an empty history");
  const decoys = historyOf([
    { statSplitTypeId: 0, seasonId: 2025, statSourceId: 0, scoringPeriodId: 0, appliedTotal: 300 },   // season total
    { statSplitTypeId: 1, seasonId: 2025, statSourceId: 2, scoringPeriodId: 9, appliedTotal: 44 },    // unknown source
    { statSplitTypeId: 1, seasonId: 2025, statSourceId: 1, scoringPeriodId: 1, appliedTotal: 8 },
    { statSplitTypeId: 1, seasonId: 2024, statSourceId: 1, scoringPeriodId: 1, appliedTotal: 7 },
    { statSplitTypeId: 1, seasonId: 2024, statSourceId: 0, scoringPeriodId: 1, appliedTotal: 9 },
  ]);
  ok(!decoys.some((h) => h.week === 0 || h.actual === 300), "a statSplitTypeId 0 season total is ignored");
  ok(!decoys.some((h) => h.week === 9), "a statSourceId 2 row leaves no history row, not even an empty one");
  ok(same(decoys, [{ season: 2025, week: 1, actual: null, proj: 8 }, { season: 2024, week: 1, actual: 9, proj: 7 }]),
     "two seasons give two rows with distinct season, in first-seen order, a missing side null");
  ok(decoys.every(historyRow), "every row is exactly {season, week, actual, proj}");

  const model = MODELS.espn;
  const prior = REF.seasonId - 1;
  const ps = [...model.players.values()];
  ok(ps.every((p) => p.history.filter((h) => h.season === prior).length === PRIOR_WEEKS.length
       && p.history.filter((h) => h.season === REF.seasonId).length === F.weeks.length
       && p.history.length === PRIOR_WEEKS.length + F.weeks.length),
     "the synthetic model's history holds eight prior-season rows and one current-season row per week, nothing for the decoys");
  ok(ps.every((p) => PRIOR_WEEKS.every((wk, k) => {
       const h = p.history.find((x) => x.season === prior && x.week === wk);
       return h && h.proj === priorProj(p.id) && h.actual === priorProj(p.id) + PRIOR_RES[k];
     })), "each prior-season row carries that week's projection and actual");
  ok(ps.every((p) => F.weeks.every((wk, k) => {
       const h = p.history.find((x) => x.season === REF.seasonId && x.week === wk);
       return h && h.actual === null && h.proj === F.proj[p.id][k];
     })), "each current-season row carries the unrounded projection and no actual");

  const vol = measureVolatility(ps, prior);
  ok(vol.measured === ps.length && vol.bySigma.size === ps.length,
     "measureVolatility measures every player from the eight prior-season weeks of history");
  ok(ps.every((p) => same(vol.residuals.get(p.id), PRIOR_RES)), "residuals are actual minus projection per week, read from history");
  const sd = Math.sqrt(PRIOR_RES.reduce((a, r) => a + r * r, 0) / (PRIOR_RES.length - 1));
  ok(Math.abs(vol.global - sd) < 1e-9 && ps.every((p) => Math.abs(vol.bySigma.get(p.id) - sd) < 1e-9),
     "sigma is the sample standard deviation of those residuals");
  ok(measureVolatility(ps, REF.seasonId).measured === 0,
     "the current season, projections without actuals, measures nothing: the season filter and the null check both hold");
}

/* storage keys (D-08): five segments, a one-time migration, adopt-on-first-sight */
{
  ok(leagueKey({ platform: "espn", leagueId: 7, seasonId: 2026 }) === "ffsm.league.espn.7.2026",
     "leagueKey is five segments: platform, league, season");
  ok(leagueKey({ platform: "cbs", leagueId: "1234", seasonId: 2026 }) !== leagueKey({ platform: "espn", leagueId: 1234, seasonId: 2026 }),
     "an ESPN league and a CBS league with the same-looking id never share a key (NO-PASSWORD/adjacency)");
  ok(leagueKey({ platform: "espn", leagueId: 1234, seasonId: 2026, teamId: 3, session: "secret" }) === "ffsm.league.espn.1234.2026",
     "the key is built from the triple alone; a team id or a session never reaches it");

  // The legacy four-segment keys as a pre-11-04 run left them, beside a key that is
  // not league-scoped at all.
  const legacyLeague = { at: 1, offers: 2, team: "T", rosterHash: "abc", changed: true };
  const st = mkStorage();
  await st.set({ "ffsm.league.7.2026": legacyLeague, "ffsm.calib.7.2026": { weeks: {} }, "ffsm.myTeam": "T" });
  ok(same(await migrateStorageKeys(st), { migrated: 2 }), "two legacy keys migrate");
  const all = await st.get(null);
  const moved = all["ffsm.league.espn.7.2026"];
  ok(moved && moved.at === 1 && moved.offers === 2 && moved.team === "T",
     "the league record keeps what the panel wrote (at, offers, team)");
  ok(moved && moved.rosterHash === null && moved.changed === false,
     "...with the hash reset to null and changed cleared, so the worker adopts rather than compares");
  ok(moved && same(moved.ref, { platform: "espn", leagueId: 7, seasonId: 2026 }),
     "...and carries ref: a legacy key is read once as espn, with numeric league and season");
  ok(same(all["ffsm.calib.espn.7.2026"], { weeks: {} }), "the calibration log moves under the five-segment key unchanged");
  ok(!("ffsm.league.7.2026" in all) && !("ffsm.calib.7.2026" in all), "both legacy keys are removed");
  ok(all["ffsm.myTeam"] === "T" && Object.keys(all).length === 3, "an unrelated key is left alone and nothing else appears");
  ok(same(await migrateStorageKeys(st), { migrated: 0 }), "a second call migrates 0");
  ok(same(await st.get(null), all), "...and rewrites nothing: five-segment keys are never mistaken for legacy ones");

  // Both keys present: the panel already wrote the new record; the legacy one still goes.
  const st2 = mkStorage();
  const fresh = { at: 9, offers: 0, team: "T", rosterHash: "new", changed: false, ref: { platform: "espn", leagueId: 7, seasonId: 2026 } };
  await st2.set({ "ffsm.league.7.2026": legacyLeague, "ffsm.league.espn.7.2026": fresh, "ffsm.dismissed.7": 5 });
  ok(same(await migrateStorageKeys(st2), { migrated: 1 }), "a legacy key beside its migrated twin still counts once");
  const all2 = await st2.get(null);
  ok(same(all2["ffsm.league.espn.7.2026"], fresh) && !("ffsm.league.7.2026" in all2),
     "when the new key already exists the existing new value wins and the legacy key is removed");
  ok(all2["ffsm.dismissed.7"] === 5, "a three-segment dismissal key is not a league key and is untouched");

  // The worker's next record, pure.
  const adopted = nextLeagueRecord({ rosterHash: null, at: 1 }, "h1", 5);
  ok(adopted.rosterHash === "h1" && adopted.latestHash === "h1" && adopted.changed === false && adopted.checkedAt === 5 && adopted.at === 1,
     "a record with no hash adopts the first one it sees: rosterHash and latestHash set, changed false");
  ok(nextLeagueRecord({ at: 1 }, "h1", 5).rosterHash === "h1", "an absent rosterHash adopts too");
  const flagged = nextLeagueRecord({ rosterHash: "h1" }, "h2", 5);
  ok(flagged.changed === true && flagged.rosterHash === "h1" && flagged.latestHash === "h2" && flagged.checkedAt === 5,
     "a different hash is flagged; the stored hash stays what the panel wrote");
  ok(nextLeagueRecord({ rosterHash: "h1" }, "h1", 5).changed === false, "an equal hash is not flagged");
  const untouched = { rosterHash: "h1", changed: true };
  ok(nextLeagueRecord(untouched, null, 5) === untouched, "a null hash (the request failed) leaves the record exactly as it was");
  ok(nextLeagueRecord(moved, "h9", 5).changed === false,
     "so a record migrated from a legacy key is never flagged on its first check - the upgrade produces no spurious notice");
}

/* the helpers this suite lends to later plans */
{
  const st = mkStorage();
  await st.set({ a: { x: 1 }, b: 2 });
  const all = await st.get(null);
  ok(same(all, { a: { x: 1 }, b: 2 }), "mkStorage.get(null) returns every entry");
  all.a.x = 99;
  ok((await st.get("a")).a.x === 1, "mkStorage hands out clones, as chrome.storage.local does");
  ok(same(await st.get(["a", "zzz"]), { a: { x: 1 } }), "mkStorage.get([keys]) returns only the keys present");
  await st.remove("a");
  ok(same(await st.get(null), { b: 2 }), "mkStorage.remove deletes");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PLATFORM OK");
