/**
 * Tests for the CBS adapter: the translation tables, eligibility expansion, the
 * settings reader, the status and pro-team maps, the id crosswalk and the URL
 * builder - all against the payloads 11-01 recorded from a real league, offline.
 *
 * The fixtures are the contract (extension/test/fixtures/cbs/README.md `## Findings`),
 * so what is pinned here is what CBS actually returned, not what it might return:
 * this league is offence + DST with no IDP, so the IDP vocabulary is exercised
 * through `expandEligibility` on synthetic configurations rather than pretended to
 * be recorded.
 *
 *   node extension/test/cbs.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cbs, {
  SLOT, BENCH_SLOT, IR_SLOT, POS_ID, MEMBERS, TEAM_ABBR, STATUS, CBS_HOST_RE,
  cbsUrl, publicUrl, parseLeagueUrl, expandEligibility, readSettings, normalizeStatus,
  teamAbbr, posOf, num, eligibleCodes, configuredCodes, extractToken,
} from "../engine/platforms/cbs.js";
import { IDS_URL, IDS_KEY, trimIds, loadCrosswalk } from "../engine/sources/fantasypros.js";
import { PRO_TEAM, SLOT_LABEL } from "../engine/league.js";
import { normStatus } from "../engine/availability.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => [...a].sort((x, y) => x - y);

/* Injection helpers, same shape as sources.mjs, plus the {status, text} entry the
   CBS 400 needs: "not signed in" arrives as a text body, not a status code. */
const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; }, async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const httpError = (status, text = "") => ({ __http: status, text });
const mkFetch = (table) => { const calls = [], inits = []; const f = async (url, init) => { calls.push(url); inits.push(init);
  const hit = table[url]; if (hit === undefined) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  if (hit && typeof hit.__http === "number")
    return { ok: hit.__http >= 200 && hit.__http < 300, status: hit.__http,
             json: async () => JSON.parse(hit.text), text: async () => hit.text };
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; };
  f.calls = calls; f.inits = inits; return f; };
const deadFetch = () => { const f = async () => { throw new Error("network down"); }; f.calls = []; return f; };

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, "fixtures", "cbs");
const file = (n) => JSON.parse(fs.readFileSync(path.join(DIR, n)));
const env = (n) => file(n).body;              // the CBS envelope, what a fetch answers
const body = (n) => env(n).body;              // envelope.body, what get() returns
const PAGE = fs.readFileSync(path.join(DIR, "page.html"), "utf8");
const PAGE_META = file("page-meta.json");
const REF = { platform: "cbs", leagueId: "redacted-league", seasonId: 2026 };

/* tables */
{
  const codes = file("public/positions.json").body.positions.map((p) => p.abbr);
  ok(codes.length === 18, "CBS publishes 18 position codes");
  ok(codes.every((c) => SLOT[c] !== undefined), "every published code has a slot id");
  ok(SLOT.D === 22 && SLOT.ST === 25, "split D and ST take the two unused ESPN ids");
  ok(SLOT_LABEL[22] === "D" && SLOT_LABEL[25] === "ST", "...and SLOT_LABEL names them");
  ok(SLOT.K === 17 && SLOT.TK === 17, "a team kicker seats in the one kicker slot");
  ok(SLOT.FLEX === 7 && SLOT["RB-WR-TE"] === 23 && SLOT["DL-LB-DB"] === 15,
     "superflex is 7, RB/WR/TE is 23, the IDP flex is 15");
  ok(SLOT.QB === 0 && SLOT.RB === 2 && SLOT.WR === 4 && SLOT.TE === 6 && SLOT.DST === 16,
     "the offence codes take ESPN's own ids");
  ok(SLOT.DL === 11 && SLOT.LB === 10 && SLOT.DB === 14 && SLOT.DT === 8 && SLOT.DE === 9
     && SLOT.CB === 12 && SLOT.S === 13, "the IDP codes take ESPN's own ids");
  ok(BENCH_SLOT === 20 && IR_SLOT === 21, "Reserve Players is the bench and Injured Players is IR");
  ok(new Set(Object.values(SLOT)).size === Object.keys(SLOT).length - 1,
     "no two codes share a slot id except K and TK");
  ok(Object.values(SLOT).every((s) => SLOT_LABEL[s] !== undefined),
     "every slot id the adapter can emit has a display label");

  ok(Object.values(POS_ID).every((id) => Number.isInteger(id) && id >= 0 && id < 64),
     "every position id is an integer in 0..63");
  ok(new Set(Object.values(POS_ID)).size === Object.keys(POS_ID).length, "position ids are distinct");
  ok(POS_ID.QB === 1 && POS_ID.RB === 2 && POS_ID.WR === 3 && POS_ID.TE === 4 && POS_ID.K === 5
     && POS_ID.DST === 16, "the offence position ids are ESPN's");
  ok([POS_ID.DL, POS_ID.DB, POS_ID.TQB, POS_ID.TK, POS_ID.D, POS_ID.ST].every((id) => id >= 40),
     "the group positions ESPN has no id for take adapter-private ids");

  ok(same(MEMBERS["RB-WR-TE"], ["RB", "WR", "TE"]) && same(MEMBERS.FLEX, ["QB", "RB", "WR", "TE"]),
     "the flex member sets are CBS's own descriptions");
  ok(MEMBERS.DB.includes("CB") && MEMBERS.DB.includes("S") && MEMBERS.DL.includes("DE")
     && MEMBERS.DL.includes("DT"), "DB is CB + S and DL is DE + DT, as the positions feed says");
}

/* eligibility (D-13) */
{
  // Pin 1: a WR in a league that configures every flex he can reach.
  const flexLeague = ["QB", "RB", "WR", "TE", "RB-WR", "WR-TE", "RB-WR-TE", "FLEX"];
  ok(same(sorted(expandEligibility(["WR"], ["WR", "RB-WR", "WR-TE", "RB-WR-TE", "FLEX"])),
          sorted([4, 3, 5, 23, 7, 20, 21])),
     "a WR reaches WR, RB/WR, WR/TE, RB/WR/TE and superflex, plus bench and IR");
  ok(same(expandEligibility(["WR"], ["WR", "RB-WR", "WR-TE", "RB-WR-TE", "FLEX"]), [4, 3, 5, 23, 7, 20, 21]),
     "...in the order the league configures its slots");

  // Pin 2: a QB in a league with no superflex reaches exactly one starting slot.
  ok(same(expandEligibility(["QB"], ["QB", "RB", "WR", "TE", "RB-WR-TE", "DST"]), [0, 20, 21]),
     "a QB in a non-superflex league starts at QB only");
  ok(same(expandEligibility(["QB"], flexLeague), [0, 7, 20, 21]),
     "...and reaches the superflex slot when the league has one");

  // Pin 3: an IDP league, in both of the vocabularies CBS might use - this league had
  // no IDP, so which one a per-player `eligible` spells is unrecorded (README Findings).
  ok(same(sorted(expandEligibility(["DB"], ["DL", "LB", "DB", "DL-LB-DB"])), sorted([14, 15, 20, 21])),
     "a DB reaches the DB slot and the IDP flex");
  ok(same(sorted(expandEligibility(["CB"], ["DL", "LB", "DB", "DL-LB-DB"])), sorted([14, 15, 20, 21])),
     "...and so does a player CBS spells CB");
  ok(expandEligibility(["DE"], ["DL", "LB", "DB"]).includes(11),
     "a DE seats in a DL slot: the group accepts the specific code");
  ok(expandEligibility(["DL"], ["DL", "LB", "DB"]).includes(11),
     "...and so does a player already spelled DL");
  ok(same(expandEligibility(["DE"], ["DL", "LB", "DB"]), expandEligibility(["DL"], ["DL", "LB", "DB"])),
     "both IDP vocabularies expand to the same slots");

  // Pin 4: a split D/ST league, and the ordinary DST one beside it.
  ok(same(sorted(expandEligibility(["DST"], ["D", "ST"])), sorted([22, 25, 20, 21])),
     "a team defence reaches both halves of a split D/ST league");
  ok(same(expandEligibility(["DST"], ["QB", "RB", "WR", "TE", "RB-WR-TE", "DST"]), [16, 20, 21]),
     "...and the one D/ST slot when the league does not split it");

  ok(same(expandEligibility(["WR"], ["QB", "RB", "TE"]), [20, 21]),
     "a player no configured slot accepts still sits on the bench and on IR");
  ok(same(expandEligibility(["K"], ["K", "TK"]), [17, 20, 21]),
     "K and TK share slot 17 and the slot is never repeated");
  ok(same(expandEligibility(["WR"], ["WR", "WR", "RB-WR-TE"]), [4, 23, 20, 21]),
     "a slot configured twice appears once");
  ok(same(expandEligibility([], ["WR", "RB"]), [20, 21]) && same(expandEligibility(null, ["WR"]), [20, 21]),
     "no eligibility at all is bench and IR, not a throw");
  ok(same(expandEligibility(["WR"], ["WR", "NOT-A-CODE"]), [4, 20, 21]),
     "a code the table does not know adds nothing");
  ok(same(expandEligibility(["RB", "RB-WR-TE"], ["QB", "RB", "WR", "TE", "RB-WR-TE", "DST"]), [2, 23, 20, 21]),
     "the recorded multi-code eligibility of a rostered RB expands to RB and the flex");

  // The eligibility list itself arrives in two shapes (README Findings).
  ok(same(eligibleCodes({ eligible: "RB,RB-WR-TE" }), ["RB", "RB-WR-TE"]),
     "a roster row's `eligible` is a comma-separated string");
  ok(same(eligibleCodes({ eligible_positions: ["WR", "RB-WR-TE"] }), ["WR", "RB-WR-TE"]),
     "a weekly-scoring row's `eligible_positions` is an array");
  ok(same(eligibleCodes({ position: "QB" }), ["QB"]), "a row with neither falls back to its display position");
  ok(same(eligibleCodes({}), []), "a row with nothing at all yields no codes");
}

/* settings */
{
  const notes = [];
  const s = readSettings(body("rules.json"), body("details.json"), body("scoring-rules.json"), notes);
  const positions = body("rules.json").rules.roster.positions;
  const statuses = body("rules.json").rules.roster.statuses;
  const maxOf = (d) => Number(statuses.find((x) => x.description === d).max);

  const want = {};
  for (const row of positions) want[SLOT[row.abbr]] = (want[SLOT[row.abbr]] ?? 0) + Number(row.max_active);
  ok(same(s.lineupSlotCounts, want), "lineupSlotCounts is each position's max_active under its slot id");
  ok(s.starters === Object.values(want).reduce((a, b) => a + b, 0), "starters sums the slot counts");
  ok(s.benchSlots === maxOf("Reserve Players") && s.benchSlots === 6, "benchSlots is the Reserve Players max");
  ok(s.irSlots === maxOf("Injured Players") && s.irSlots === 0, "irSlots is the Injured Players max");
  ok(s.rosterSize === s.starters + s.benchSlots, "rosterSize is starters plus bench, never Total Players");
  ok(s.rosterSize !== maxOf("Total Players") + s.irSlots || s.irSlots === 0,
     "...so a non-zero IR could never be counted twice");
  ok(notes.some((n) => /flexible lineup/.test(n)),
     "a league whose position maxima exceed its Active max says so in a note rather than silently");

  ok(positions.every((p) => p.max_total === "No Limit"), "the recorded league limits no position");
  ok(s.positionLimits === null, "...so positionLimits is null, as ESPN's is for an unlimited league");
  ok(s.currentWeek === 1 && s.currentWeek === Number(body("details.json").league_details.current_period),
     "currentWeek is read from league_details.current_period");
  ok(s.regularSeasonWeeks.length === 14 && s.regularSeasonWeeks[0] === 1 && s.regularSeasonWeeks.at(-1) === 14,
     "14 regular-season periods, read from league_details");
  ok(same(s.playoffWeeks, [15, 16, 17]) && same(s.playoffRoundWeeks, [[15], [16], [17]]) && s.playoffRounds === 3,
     "three playoff periods follow them, one round each");
  ok(s.playoffTeams === 7, "the playoff team count is read (7), not assumed");
  ok(s.playoffReseed === false, "reseed is read as No, not defaulted to true");
  ok(s.seedingTiebreak === "TOTAL_POINTS_SCORED" && notes.some((n) => /tiebreaker is published as prose/.test(n)),
     "the tiebreaker sentence is not parsed: the default is used and the note says so");
  ok(s.pprValue === 1, "points per reception comes from the league's own Recpt rule");
  ok(s.faabBudget === 100, "the waiver budget is read from the $100 the rules state");
  ok(s.name === "Redacted League", "the league name is read from league_details");
  ok(same(s.divisions, []) && s.divisionCount === 0, "this league has no divisions");
  ok(notes.every((n) => n.startsWith("CBS: ")), "every note names the platform");

  // Mixed types throughout: "3" beside 14, and "No Limit" where a number would go.
  const synthetic = { rules: { roster: {
    positions: [{ abbr: "QB", max_active: "2", min_active: 1, max_total: "3" },
                { abbr: "RB", max_active: 2, min_active: "1", max_total: "No Limit" },
                { abbr: "ZZ", max_active: "1", min_active: 0, max_total: "1" }],
    statuses: [{ description: "Active Players", max: "4", min: 2 },
               { description: "Reserve Players", max: "6", min: "0" },
               { description: "Injured Players", max: 2, min: "0" },
               { description: "Total Players", max: "12", min: "0" }] } } };
  const n2 = [];
  const s2 = readSettings(synthetic, { league_details: { regular_season_periods: "13", playoff_periods: 2 } }, null, n2);
  ok(s2.lineupSlotCounts[0] === 2 && s2.lineupSlotCounts[2] === 2,
     "a string max_active reads as a number");
  ok(s2.starters === 4 && s2.benchSlots === 6 && s2.irSlots === 2 && s2.rosterSize === 10,
     "string mins and maxes read as numbers; rosterSize excludes IR");
  ok(same(s2.positionLimits, { [POS_ID.QB]: 3 }),
     "a numeric max_total becomes a position limit and No Limit is omitted");
  ok(n2.some((n) => /ZZ/.test(n)), "an unknown position code is skipped with a note, not dropped in silence");
  ok(s2.regularSeasonWeeks.length === 13 && same(s2.playoffWeeks, [14, 15]),
     "a string period count reads as a number and the playoffs follow the regular season");
  ok(s2.playoffTeams === 6 && s2.playoffReseed === true && n2.some((n) => /assuming 6/.test(n)),
     "absent playoff settings take ESPN's defaults and each assumption is noted");
  ok(s2.pprValue === 0 && s2.faabBudget === 0, "no scoring rules and no budget field read as zero");

  const n3 = [];
  const s3 = readSettings({}, {}, {}, n3);
  ok(same(Object.keys(s3).sort(), Object.keys(s).sort()), "readSettings on empty payloads still returns every contract key");
  ok(s3.name === "League" && s3.starters === 0 && s3.rosterSize === 0 && s3.regularSeasonWeeks.length === 14,
     "...with the documented defaults");

  ok(same(configuredCodes(body("rules.json")), positions.map((p) => p.abbr)),
     "the configured slot codes keep the order the rules list them in");
  ok(num("No Limit") === null && num("") === null && num(null) === null && num("6") === 6 && num(0) === 0,
     "num() reads a number or null - never 0 for a word or an empty cell");
}

/* teams and statuses */
{
  ok(teamAbbr("JAC") === "JAX", "JAC is ESPN's JAX");
  ok(teamAbbr("WAS") === "WSH", "WAS is ESPN's WSH");
  ok(teamAbbr("KC") === "KC" && teamAbbr("GB") === "GB" && teamAbbr("LV") === "LV",
     "the other codes pass through unchanged");
  ok(teamAbbr("FA") === "FA" && teamAbbr("DRF") === "FA" && teamAbbr(null) === "FA"
     && teamAbbr(undefined) === "FA" && teamAbbr("") === "FA" && teamAbbr("ZZZ") === "FA",
     "every placeholder and anything unknown lands on FA, so no two of them ever correlate");
  const real = new Set(Object.values(PRO_TEAM));
  const abbrs = file("public/pro-teams.json").body.pro_teams.map((t) => t.abbr);
  ok(abbrs.length === 32, "CBS publishes 32 pro teams");
  ok(abbrs.every((a) => real.has(teamAbbr(a))), "every one of them maps to a team ESPN names");
  ok(abbrs.filter((a) => teamAbbr(a) !== a).length === 2, "exactly two codes differ from ESPN's");
  ok(Object.keys(TEAM_ABBR).length === 32, "the table covers every CBS team and nothing else");

  // The seven statuses the live feeds carry, each landing on a word normStatus knows.
  const wanted = { Out: "OUT", Questionable: "QUESTIONABLE", Doubtful: "DOUBTFUL", IR: "INJURY_RESERVE",
                   Suspended: "SUSPENSION", "reserve-cel": "INJURY_RESERVE", PUP: "PUP" };
  for (const [raw, canon] of Object.entries(wanted)) {
    ok(normalizeStatus(raw) === canon, `CBS "${raw}" reads as ${canon}`);
    ok(normStatus(normalizeStatus(raw)) === canon, `...and normStatus keeps it there, not ACTIVE`);
  }
  ok(normStatus("reserve-cel") === "ACTIVE" && normalizeStatus("reserve-cel") === "INJURY_RESERVE",
     "the exempt list is the one word the engine's own table would price as playing");
  ok(normalizeStatus("Inactive") === "OUT", "the injuries feed's eighth word, Inactive, is not playing either");
  ok(normalizeStatus(null, "A") === null && normalizeStatus("Active") === null && normalizeStatus(null, null) === null,
     "a healthy player carries null, which keeps weekly on its no-availability path");
  ok(normalizeStatus(null, "IR") === "INJURY_RESERVE" && normalizeStatus(null, "PUP") === "PUP",
     "pro_status speaks when the injuries feed is silent");
  ok(normalizeStatus("Questionable", "IR") === "QUESTIONABLE", "the injuries feed wins when both speak");
  ok(Object.values(STATUS).every((v) => normStatus(v) === v), "every value in the table is already canonical");

  const feed = file("public/players-injuries.json").body.injuries;
  const live = [...new Set(feed.map((r) => r.status).filter(Boolean))];
  ok(live.every((st) => normalizeStatus(st) !== null),
     `every status the recorded feed carries is mapped (${live.length} of them)`);

  ok(posOf("DST").pos === "D/ST" && posOf("DST").posId === 16, "DST displays as D/ST");
  ok(posOf("TK").pos === "K" && posOf("TK").posId === POS_ID.TK, "a team kicker displays as K but keeps its own position id");
  ok(same(posOf("DL"), { pos: "DL", posId: 40 }), "a DL keeps its group label and an adapter-private id");
  ok(posOf("QB").posId === 1 && posOf("QB").pos === "QB", "a QB is ESPN's QB");
  ok(posOf("D").pos === "D" && posOf("ST").pos === "ST", "the split defence halves have labels of their own");
  ok(posOf("nonsense").pos === "nonsense" && posOf("nonsense").posId === 0,
     "an unknown code displays itself rather than a question mark, with position id 0");
}

/* crosswalk */
{
  const csv = "fantasypros_id,espn_id,cbs_id,name\n" +
              "1,101,5001,a\n" +
              "2,102,5001,duplicate\n" +
              "3,NA,5003,unmapped\n" +
              "4,104,,no cbs id\n" +
              "5,,5005,no espn id\n";
  const ids = trimIds(csv);
  ok(same(ids.cbs, [[5001, 101]]), "a duplicate cbs_id keeps the first espn_id, and NA rows are dropped");
  ok(same(ids.fp, [["1", 101], ["2", 102], ["4", 104]]), "the fp column keeps every row with both ids, duplicates included");
  ok(ids.cbs.every(([c, e]) => typeof c === "number" && typeof e === "number"), "both crosswalk columns are numbers");

  const dead = await loadCrosswalk({ fetchImpl: deadFetch(), storage: mkStorage(), now: 0 });
  ok(dead.available === false && dead.toEspn instanceof Map && dead.toEspn.size === 0,
     "a dead crosswalk feed is an empty map, not a throw");
  ok(typeof dead.reason === "string" && dead.reason.length > 0, "...with a reason the adapter can print");

  const live = await loadCrosswalk({ fetchImpl: mkFetch({ [IDS_URL]: csv }), storage: mkStorage(), now: 0 });
  ok(live.available === true && live.toEspn.get(5001) === 101 && live.toEspn.size === 1,
     "a live feed gives cbs_id -> espn_id");
  const st = mkStorage();
  await loadCrosswalk({ fetchImpl: mkFetch({ [IDS_URL]: csv }), storage: st, now: 0 });
  ok(st._m.has(IDS_KEY) && !st._m.has("src.fp.ids"),
     "it caches under the bumped key, so a week-fresh copy of the old array is never read as the new shape");
  const stale = await loadCrosswalk({ fetchImpl: deadFetch(), storage: st, now: 0 });
  ok(stale.toEspn.get(5001) === 101, "a cached copy answers when the feed is down");

  const empty = await loadCrosswalk({ fetchImpl: mkFetch({ [IDS_URL]: "fantasypros_id,espn_id\n1,101\n" }),
                                      storage: mkStorage(), now: 0 });
  ok(empty.available === false && /no cbs_id/.test(empty.reason),
     "a file with no cbs_id column reports itself unavailable rather than mapping nothing in silence");
}

/* urls */
{
  const cookie = cbsUrl(REF, "league/details", {}, { mode: "cookie", token: null });
  const token = cbsUrl(REF, "league/details", {}, { mode: "token", token: "SECRET-TOKEN" });
  ok(cookie.startsWith("https://redacted-league.football.cbssports.com/api/league/details?"),
     "cookie mode goes through the league subdomain's proxy");
  ok(cookie.includes("version=3.0") && cookie.includes("SPORT=football") && cookie.includes("response_format=JSON"),
     "...with the three parameters every CBS route needs");
  ok(cookie.includes("league_id=redacted-league"),
     "...and an explicit league_id: the proxy does not infer it from the hostname");
  ok(token.startsWith("https://api.cbssports.com/fantasy/league/details?"), "token mode goes to the public API host");
  ok(token.includes("league_id=redacted-league"), "...also with an explicit league_id");
  ok(!cookie.includes("SECRET-TOKEN") && !token.includes("SECRET-TOKEN") && !token.includes("access_token"),
     "neither URL carries the token: it rides in a header (D-10)");
  const stats = cbsUrl(REF, "league/stats", { period: "week3", stats_type: "projections", player_status: "all" });
  ok(stats.includes("period=week3") && stats.includes("player_status=all") && stats.includes("stats_type=projections"),
     "a stats URL carries the week, the projection type and player_status=all");
  ok(stats === cbsUrl(REF, "league/stats", { stats_type: "projections", player_status: "all", period: "week3" }),
     "the same parameters in any order build the same URL");
  ok(publicUrl("players/injuries").startsWith("https://api.cbssports.com/fantasy/players/injuries?")
     && !publicUrl("players/injuries").includes("league_id"),
     "a public feed is asked without a league id: nothing about this league is sent to it");

  ok(parseLeagueUrl("https://myleague.football.cbssports.com/teams")?.leagueId === "myleague",
     "the slug is the first label of the hostname");
  ok(parseLeagueUrl("https://myleague.football.cbssports.com/")?.teamId === null
     && parseLeagueUrl("https://myleague.football.cbssports.com/")?.seasonId === new Date().getFullYear(),
     "...with no team and the current season");
  ok(parseLeagueUrl("https://www.football.cbssports.com/") === null, "www is the lobby, not a league");
  ok(parseLeagueUrl("https://www.cbssports.com/fantasy/football/") === null, "so is the fantasy front page");
  ok(parseLeagueUrl("https://fantasy.espn.com/football/team?leagueId=7") === null, "and another platform is not a CBS league");
  ok(parseLeagueUrl("not a url") === null, "a non-URL is null, not a throw");
  ok(typeof CBS_HOST_RE.source === "string" && CBS_HOST_RE.test("x.football.cbssports.com"),
     "CBS_HOST_RE is a regex content.js can be pinned against in 11-07");

  ok(cbs.id === "cbs" && cbs.label === "CBS" && cbs.acceptsToken === true, "the adapter names itself and accepts a token");
  ok(cbs.signInUrl(REF).startsWith("https://www.cbssports.com/login?")
     && cbs.signInUrl(REF).includes(encodeURIComponent("https://redacted-league.football.cbssports.com/")),
     "the sign-in URL returns the user to their own league");
  ok(cbs.hosts.every((h) => /^https:\/\/.+\/\*$/.test(h)) && cbs.hosts.length === 2,
     "the adapter declares the two CBS host patterns");
}

/* the token in the page */
{
  const found = extractToken(PAGE);
  ok(found !== null && typeof found.token === "string" && found.token.length > 0,
     "the recorded league page carries a token where the adapter looks for one");
  ok(found.pattern === PAGE_META.token.pattern,
     `the pattern that matches is the one the capture recorded (${PAGE_META.token.pattern})`);
  ok(extractToken('var token = "abc";').token === "abc", "the 2017 form still matches");
  ok(extractToken('"access_token": "xyz"').token === "xyz", "so does an access_token pair");
  ok(extractToken("nothing here") === null && extractToken(null) === null && extractToken("") === null,
     "a page with no token is null, not a guess");
  const SRC = fs.readFileSync(path.join(here, "..", "engine", "platforms", "cbs.js"), "utf8");
  ok(!/oauth/i.test(SRC), "the adapter references no oauth endpoint (D-11)");
  ok(!/password\s*[:=]/i.test(SRC), "...and never reads, sends or stores a password field");
  // Comments say what the code must do; these two assertions read the code itself.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/chrome\./.test(CODE), "no chrome.* anywhere in the adapter, so a module service worker can import it");
  ok(!/storage\.set|localStorage|sessionStorage/.test(CODE),
     "the adapter writes nothing to storage: the token lives on the ref for the run and nowhere else (D-10)");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("CBS OK");
