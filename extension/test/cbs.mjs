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
  cbsUrl, publicUrl, parseLeagueUrl, expandEligibility, readSettings, normalizeStatus, flexSlotFor,
  teamAbbr, posOf, num, eligibleCodes, configuredCodes, extractToken, openSession, sessionFor, pageUrl,
} from "../engine/platforms/cbs.js";
import * as CBS from "../engine/platforms/cbs.js";
import { IDS_URL, IDS_KEY, trimIds, loadCrosswalk } from "../engine/sources/fantasypros.js";
import { hashRosters } from "../engine/platforms/hash.js";
import { PRO_TEAM, SLOT_LABEL } from "../engine/league.js";
import { normStatus } from "../engine/availability.js";
import { attachActuals } from "../engine/calibration.js";
import { Engine } from "../engine/search.js";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { marketView, marketCell, marketFair } from "../panel/market.js";
import { usageView } from "../panel/usage.js";

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

  // CBS states a per-position RANGE and caps the whole lineup with "Active Players".
  // The recorded league's maxima total 14 against an active max of 8, so reading the maxima
  // as seats would have the engine field six starters the manager can never set — every
  // trade would then be scored on a lineup that does not exist. The minimums are the seats
  // the manager MUST fill; the difference up to the active max is discretion, which is what
  // a flex slot is. Model the mins as dedicated slots and the remainder as the narrowest
  // ESPN flex whose eligibility covers every position with headroom.
  const dedicated = {};
  for (const row of positions) {
    const n = Number(row.min_active);
    if (n > 0) dedicated[SLOT[row.abbr]] = (dedicated[SLOT[row.abbr]] ?? 0) + n;
  }
  const want = { ...dedicated };
  want[SLOT["RB-WR-TE"]] = (want[SLOT["RB-WR-TE"]] ?? 0) + (maxOf("Active Players") - Object.values(dedicated).reduce((a, b) => a + b, 0));
  ok(same(s.lineupSlotCounts, want),
     "lineupSlotCounts seats each position's min_active and spends the rest of the Active max on the flex the headroom positions share");
  ok(s.starters === maxOf("Active Players") && s.starters === 8,
     "starters is the lineup the manager can actually field (8), not the sum of the maxima (14)");
  ok(Object.values(positions).reduce((a, p) => a + Number(p.max_active), 0) === 14,
     "...and the maxima really do total 14, so this is the flexible-lineup case, not a fixed one");
  ok(s.benchSlots === maxOf("Reserve Players") && s.benchSlots === 6, "benchSlots is the Reserve Players max");
  ok(s.irSlots === maxOf("Injured Players") && s.irSlots === 0, "irSlots is the Injured Players max");
  ok(s.rosterSize === s.starters + s.benchSlots, "rosterSize is starters plus bench, never Total Players");
  ok(s.rosterSize !== maxOf("Total Players") + s.irSlots || s.irSlots === 0,
     "...so a non-zero IR could never be counted twice");
  ok(notes.some((n) => /flexible lineup/.test(n) && /8/.test(n) && /14/.test(n)),
     "a league whose position maxima exceed its Active max says so in a note, naming both numbers");

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
     "a string max_active reads as a number, and maxima totalling exactly the Active max are the seats: nothing is discretionary");
  ok(s2.starters === 4 && s2.benchSlots === 6 && s2.irSlots === 2 && s2.rosterSize === 10,
     "string mins and maxes read as numbers; rosterSize excludes IR");

  // Headroom the offensive flexes cannot express: QB is only in the superflex.
  const superflex = { rules: { roster: {
    positions: [{ abbr: "QB", max_active: 2, min_active: 1 }, { abbr: "RB", max_active: 3, min_active: 1 },
                { abbr: "DST", max_active: 1, min_active: 1 }],
    statuses: [{ description: "Active Players", max: 4, min: 3 }, { description: "Reserve Players", max: 5, min: 0 }] } } };
  const n6 = [];
  const s6 = readSettings(superflex, {}, null, n6);
  ok(same(s6.lineupSlotCounts, { 0: 1, 2: 1, 16: 1, 7: 1 }) && s6.starters === 4,
     "QB and RB headroom resolves to the superflex (7), the narrowest ESPN slot that seats both");
  ok(flexSlotFor(new Set(["WR", "TE"])) === 5 && flexSlotFor(new Set(["RB", "WR"])) === 3
     && flexSlotFor(new Set(["RB", "WR", "TE"])) === 23 && flexSlotFor(new Set(["WR"])) === 4,
     "flexSlotFor picks the narrowest covering slot, and a lone position keeps its own");
  const n7 = [];
  ok(flexSlotFor(new Set(["QB", "DST"]), n7) === 23 && n7.some((n) => /no single lineup slot covers/.test(n)),
     "...and headroom no slot covers falls back to RB/WR/TE with a note rather than inventing one");

  // CR-02. Headroom on a position no shared flex can seat - a kicker, a defence - must keep
  // its own seats. Folding it into an RB/WR/TE flex deletes the position from the lineup
  // outright: with min_active 0 it has no dedicated seat either, so every kicker and every
  // defence becomes unstartable and their projections vanish from the solve. min_active 0 is
  // ordinary (the recorded league uses it for WR and TE).
  const kdst = { rules: { roster: {
    positions: [{ abbr: "QB", min_active: 1, max_active: 1 }, { abbr: "RB", min_active: 1, max_active: 3 },
                { abbr: "WR", min_active: 0, max_active: 4 }, { abbr: "TE", min_active: 0, max_active: 2 },
                { abbr: "K", min_active: 0, max_active: 1 }, { abbr: "DST", min_active: 0, max_active: 1 }],
    statuses: [{ description: "Active Players", max: 9, min: 4 }, { description: "Reserve Players", max: 6, min: 0 }] } } };
  const n8 = [];
  const s8 = readSettings(kdst, {}, null, n8);
  ok(s8.lineupSlotCounts[SLOT.K] === 1 && s8.lineupSlotCounts[SLOT.DST] === 1,
     "a kicker and a defence with headroom keep their own seats: no flex can seat them");
  ok(s8.lineupSlotCounts[SLOT["RB-WR-TE"]] === 5 && s8.lineupSlotCounts[SLOT.QB] === 1 && s8.lineupSlotCounts[SLOT.RB] === 1,
     "...and the seats left over still become the flex the skill positions share");
  ok(s8.starters === 9, "...with the lineup still seating exactly the Active Players cap");
  ok(!n8.some((n) => /no single lineup slot covers/.test(n)),
     "...and no give-up note is raised, because every seat was placed");

  // A fixed lineup - every position's min equals its max - keeps the exact seats and says nothing.
  const fixed = { rules: { roster: {
    positions: [{ abbr: "QB", max_active: 1, min_active: 1 }, { abbr: "RB", max_active: 2, min_active: 2 },
                { abbr: "WR", max_active: "2", min_active: "2" }, { abbr: "DST", max_active: 1, min_active: 1 }],
    statuses: [{ description: "Active Players", max: 6, min: 6 }, { description: "Reserve Players", max: "5", min: 0 }] } } };
  const n4 = [];
  const s4 = readSettings(fixed, {}, null, n4);
  ok(same(s4.lineupSlotCounts, { 0: 1, 2: 2, 4: 2, 16: 1 }) && s4.starters === 6,
     "a fixed lineup keeps its exact seats: no flex is invented when no position has headroom");
  ok(!n4.some((n) => /flexible lineup/.test(n)), "...and no flexible-lineup note is raised");

  // No Active Players row: nothing bounds the lineup, so the maxima are all there is to read.
  const noCap = { rules: { roster: {
    positions: [{ abbr: "QB", max_active: 1, min_active: 1 }, { abbr: "RB", max_active: 3, min_active: 1 }],
    statuses: [{ description: "Reserve Players", max: 4, min: 0 }] } } };
  const n5 = [];
  const s5 = readSettings(noCap, {}, null, n5);
  ok(same(s5.lineupSlotCounts, { 0: 1, 2: 3 }) && s5.starters === 4,
     "with no Active Players cap the maxima are the only reading available");
  ok(n5.some((n) => /no Active Players/.test(n)), "...and the note says the cap was missing");
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
  // The adapter may name chrome.tabs - the content-script hand-over is one of D-10's
  // four sanctioned routes - but only inside defaultHandover, behind a typeof guard,
  // and never at module evaluation: a module service worker has to be able to import
  // this file, and this test file just did, under Node, with no chrome at all.
  ok((CODE.match(/chrome\.[A-Za-z]+/g) ?? []).every((r) => r === "chrome.tabs"),
     "the only chrome.* the adapter names is chrome.tabs, in the hand-over");
  ok(/typeof chrome === "undefined"/.test(CODE),
     "...behind a typeof guard, so a module service worker can import it");
  ok(typeof globalThis.chrome === "undefined" && typeof cbs.loadLeague === "function",
     "...and this file imported the adapter under Node with no chrome defined at all");
  ok(!/storage\.set|localStorage|sessionStorage/.test(CODE),
     "the adapter writes nothing to storage: the token lives on the ref for the run and nowhere else (D-10)");
}

/* loadLeague */
// The same fetch table platform.mjs builds, with the counters this section needs:
// which URLs were asked for, in what order, and how many stats requests were ever in
// flight at once. Both auth modes are keyed, so a table never decides which one the
// adapter picks - the session probe does.
const SESSIONS = [{ mode: "cookie", token: null }, { mode: "token", token: "TOKEN-VALUE" }];
const SETTINGS = readSettings(body("rules.json"), body("details.json"), body("scoring-rules.json"), []);
const WEEKS = [...SETTINGS.regularSeasonWeeks, ...SETTINGS.playoffWeeks];
const ROSTER_TEAMS = body("rosters.json").rosters.teams;
const ROSTER_IDS = ROSTER_TEAMS.flatMap((t) => t.players.map((p) => Number(p.id)));
const ROSTER_SET = new Set(ROSTER_IDS);
// The prior season arrives through the same route with a timeframe: one recorded
// attempt per parameter set, keyed by route in the fixture (README Findings).
const PRIOR = file("prior-season.json")["league/fantasy-points/weekly-scoring?timeframe=2025"].body;
const FA_ROWS = body("stats-free-agents-week1.json").league_stats.players;

// Five rostered players mapped, one given the file's NA sentinel, and the first id
// repeated with a different espn_id so "first row wins" is visible in the model.
const MAPPED = ROSTER_IDS.slice(0, 5).map((cbsId, i) => [cbsId, 900001 + i]);
const NA_ID = ROSTER_IDS[5];
const CSV = ["fantasypros_id,espn_id,cbs_id,name",
  ...MAPPED.map(([c, e], i) => `${100 + i},${e},${c},p${i}`),
  `,999999,${MAPPED[0][0]},duplicate`,
  `199,NA,${NA_ID},unmapped`].join("\n") + "\n";

function cbsTable({ crosswalk = true, injuries = true, page = PAGE, details = env("details.json"),
                    weeks = WEEKS, ref = REF, freeAgents = true, schedule = true, standings = true,
                    history = env("weekly-scoring.json"), prior = PRIOR } = {}) {
  const t = {};
  const put = (route, params, value) => { for (const s of SESSIONS) t[cbsUrl(ref, route, params, s)] = value; };
  put("league/details", {}, details);
  put("league/rules", {}, env("rules.json"));
  put("league/scoring/rules", {}, env("scoring-rules.json"));
  put("league/rosters", { team_id: "all" }, env("rosters.json"));
  for (const w of weeks) {
    put("league/stats", { stats_type: "projections", period: `week${w}`, player_status: "all" },
        env(w === 2 ? "stats-week2.json" : "stats-week1.json"));
    if (freeAgents)
      put("league/stats", { stats_type: "projections", period: `week${w}`, player_status: "free_agents" },
          env("stats-free-agents-week1.json"));
  }
  if (schedule) put("league/schedules", { period: "all" }, env("schedules.json"));
  if (standings) put("league/standings/overall", {}, env("standings.json"));
  if (history) put("league/fantasy-points/weekly-scoring", { player_status: "all" }, history);
  if (prior) put("league/fantasy-points/weekly-scoring",
                 { player_status: "all", timeframe: String(ref.seasonId - 1) }, prior);
  if (injuries) t[publicUrl("players/injuries")] = file("public/players-injuries.json");
  if (crosswalk) t[IDS_URL] = CSV;
  if (page !== null) t[pageUrl(ref)] = page;
  return t;
}
// Everything the league proxy would answer, refused the way CBS refuses it: HTTP 400
// with a text body, not a 401.
const refuseCookie = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) =>
  [k, k.includes(".football.cbssports.com/api/") ? httpError(400, "User not signed in") : v]));
const refuseAll = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) =>
  [k, /cbssports\.com\/(api|fantasy)\//.test(k) ? httpError(400, "User not signed in") : v]));

const countingFetch = (table) => {
  const calls = [], inits = []; let inflight = 0;
  const f = async (url, init) => {
    calls.push(url); inits.push(init);
    const stats = url.includes("/league/stats");
    if (stats) { inflight++; f.maxStatsInflight = Math.max(f.maxStatsInflight, inflight); }
    await Promise.resolve();
    const hit = table[url];
    if (stats) inflight--;
    if (hit === undefined) return { ok: false, status: 404 };
    if (hit instanceof Error) throw hit;
    if (hit && typeof hit.__http === "number")
      return { ok: hit.__http >= 200 && hit.__http < 300, status: hit.__http,
               json: async () => JSON.parse(hit.text), text: async () => hit.text };
    return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) };
  };
  f.maxStatsInflight = 0; f.calls = calls; f.inits = inits; return f;
};
const load = async (table, over = {}, base = REF) => {
  const fetchImpl = countingFetch(table);
  const progress = [];
  const ref = { ...base };
  const model = await cbs.loadLeague(ref, (d, t, l) => progress.push([d, t, l]),
    { fetchImpl, storage: mkStorage(), now: 0, ...over });
  return { model, fetchImpl, progress, ref };
};

{
  const { model, fetchImpl, progress } = await load(cbsTable());
  const stats = fetchImpl.calls.filter((u) => u.includes("/league/stats"));
  const rosters = fetchImpl.calls.filter((u) => u.includes("/league/rosters"));

  // Cadence (D-14): one roster pull, one projection call per remaining week, three at a time.
  ok(rosters.length === 1 && rosters[0].includes("team_id=all"),
     "one league/rosters?team_id=all request for the whole league");
  ok(stats.length === WEEKS.length, `one league/stats request per remaining week (${WEEKS.length})`);
  ok(stats.every((u) => u.includes("player_status=all") && u.includes("stats_type=projections")),
     "...each one asking for projections over every player, not just free agents");
  ok(same(stats.map((u) => Number(/period=week(\d+)/.exec(u)[1])).sort((a, b) => a - b), WEEKS),
     "...exactly once for each week, with no week asked for twice");
  ok(fetchImpl.maxStatsInflight === 3, "never more than three projection requests are in flight at once");
  ok(fetchImpl.maxStatsInflight > 1, "...and more than one, so the weeks are not fetched one at a time");
  ok(same(progress[0], [0, 1, "settings"]), "onProgress opens on the settings step");
  ok(progress.length === WEEKS.length + 1 && progress.slice(1).every(([, t, l]) => t === WEEKS.length && /^week \d+$/.test(l)),
     "...then reports once per week, against the week total");
  ok(same(progress.at(-1), [WEEKS.length, WEEKS.length, `week ${progress.at(-1)[2].split(" ")[1]}`]),
     "...and ends at total of total");

  // Ids (D-05, D-06).
  const players = [...model.players.values()];
  ok(players.length === ROSTER_IDS.length, "every rostered player is in the model");
  ok(players.every((p) => typeof p.id === "number" && Number.isInteger(p.id)), "every id is an integer Number, never a string");
  ok(MAPPED.every(([, espnId]) => model.players.get(espnId)?.id === espnId), "a crosswalked player takes his ESPN id");
  ok(model.players.get(MAPPED[0][1]) !== undefined && !model.players.has(999999),
     "a duplicate cbs_id row resolves to the first espn_id, not the last");
  const mappedIds = new Set(MAPPED.map(([, e]) => e));
  const unmapped = players.filter((p) => !mappedIds.has(p.id));
  ok(unmapped.every((p) => p.id < 0), "every player the crosswalk misses has a negative id");
  ok(same(unmapped.map((p) => -p.id).sort((a, b) => a - b),
          ROSTER_IDS.filter((id) => !MAPPED.some(([c]) => c === id)).sort((a, b) => a - b)),
     "...and it is exactly -cbsId");
  ok(unmapped.some((p) => -p.id === NA_ID), "an NA in the espn_id column is not a mapping");
  ok([...model.teams.values()].every((t) => [...t.roster].every((id) => model.players.has(id))),
     "every roster holds the ids the players are keyed on, after the crosswalk renamed them");
  ok([...model.teams.values()].reduce((a, t) => a + t.roster.size, 0) === ROSTER_IDS.length,
     "...and no player was lost or duplicated in the renaming");

  // The fingerprint hashes CBS's own ids, computed here from the payload directly.
  const want = hashRosters(ROSTER_TEAMS.map((t) => ({ id: Number(t.id), ids: t.players.map((p) => Number(p.id)) })));
  ok(model.fingerprint === want, "model.fingerprint is hashRosters over the rosters payload's own CBS ids");
  const moved = ROSTER_TEAMS.map((t, i) => ({ id: Number(t.id),
    ids: t.players.map((p, j) => (i === 0 && j === 0 ? 1 : Number(p.id))) }));
  ok(hashRosters(moved) !== want, "...and a single changed roster id hashes differently");

  // Projections.
  ok(players.every((p) => WEEKS.every((w) => typeof p.proj[w] === "number" && Number.isFinite(p.proj[w]))),
     "every week carries a finite projection");
  ok(players.filter((p) => p.proj[1] > 0).length === 148,
     "the 148 rostered players the week-1 stats route scores get their FPTS");
  const maye = players.find((p) => p.name === "Drake Maye");
  ok(maye && maye.proj[1] === 16.8 && maye.proj[2] === 20.1,
     "a named player's week-1 and week-2 projections are the recorded FPTS, not TP");
  ok(maye && maye.eligibleSlots.includes(0) && maye.pos === "QB" && maye.nfl === "NE" && maye.bye === 11,
     "...and his slot, position, pro team and bye come from the roster row");

  // Statuses, from the public feed with pro_status behind it.
  ok(players.some((p) => p.injuryStatus === "QUESTIONABLE") && players.some((p) => p.injuryStatus === "OUT"),
     "the injuries feed reaches the model");
  ok(players.some((p) => p.injuryStatus === "INJURY_RESERVE"), "...and so does an IR player");
  ok(players.filter((p) => p.injuryStatus === null).length > players.length / 2,
     "most players are healthy and carry null, keeping weekly on its fast path");
  ok(players.every((p) => (p.injuryStatus === null) === (p.injured === false) || p.injuryStatus === "SUSPENSION"),
     "injured tracks the status, and a suspension is not an injury");

  // The horizon: a league in week 5 is not asked about weeks 1 to 4.
  const late = structuredClone(env("details.json"));
  late.body.league_details.current_period = "5";
  const { model: m5, fetchImpl: f5 } = await load(cbsTable({ details: late }));
  const periods = f5.calls.filter((u) => u.includes("/league/stats")).map((u) => Number(/period=week(\d+)/.exec(u)[1]));
  ok(m5.settings.currentWeek === 5, "the current period is read from the payload");
  ok(same(periods.sort((a, b) => a - b), WEEKS.filter((w) => w >= 5)),
     "only the weeks that remain are fetched");
  ok([...m5.players.values()].every((p) => [1, 2, 3, 4].every((w) => p.proj[w] === 0)),
     "a week already played projects zero rather than a number nobody can trade for");
  ok([...m5.players.values()].every((p) => WEEKS.every((w) => Number.isFinite(p.proj[w]))),
     "...and every week of the model still carries a number");
}

/* degradation: a dead optional feed costs a note, never the run */
{
  const { model } = await load(cbsTable({ crosswalk: false }));
  ok(model.players.size === ROSTER_IDS.length, "a crosswalk that will not load still loads the league");
  ok([...model.players.values()].every((p) => p.id < 0), "...with every player on his -cbsId");
  ok(model.notes.some((n) => /^CBS: id crosswalk unavailable/.test(n)),
     "...and a note that says which columns will show a dash");
  ok(model.notes.every((n) => n.startsWith("CBS: ")), "every note names the platform");

  const { model: m2 } = await load(cbsTable({ injuries: false }));
  ok(m2.players.size === ROSTER_IDS.length && m2.notes.some((n) => /injury feed is unavailable/.test(n)),
     "a dead injury feed costs a note, not the run");
  ok([...m2.players.values()].some((p) => p.injuryStatus === "INJURY_RESERVE"),
     "...and pro_status still flags the players CBS marks IR");

  const withCrosswalk = await load(cbsTable());
  ok(withCrosswalk.model.notes.some((n) => /^CBS: id crosswalk maps 5 of 168 rostered players/.test(n)),
     "a working crosswalk reports how many of the roster it mapped");
  // The recorded weekly-scoring capture defaulted to free agents, so it names none of
  // this league's 168 rostered players (README Findings). The adapter asks for
  // player_status=all, gets those same rows back from the fixture, and says outright
  // that nobody was matched rather than showing an empty history in silence.
  ok(withCrosswalk.model.notes.some((n) => /^CBS: weekly scoring for this season named none/.test(n)),
     "a weekly-scoring feed that names no rostered player says so");
  ok([...withCrosswalk.model.players.values()].every((p) => Array.isArray(p.history) && p.history.length === 0),
     "...and every history is empty, because that is what the recorded feed carries");
}

/* auth */
{
  // Cookie refused, no token in the page: there is nothing left to try.
  let err = null;
  try { await load(refuseCookie(cbsTable({ page: "<html>no token here</html>" }))); } catch (e) { err = e; }
  ok(err instanceof Error && err.code === "AUTH", "a refused cookie and a page with no token reject with code AUTH");
  ok(/CBS/.test(err?.message ?? ""), "...and the message names the platform, so the panel links CBS's sign-in");

  // Cookie refused, token in the page: the adapter switches hosts and carries on.
  const table = refuseCookie(cbsTable());
  const { model, fetchImpl } = await load(table);
  ok(model.players.size === ROSTER_IDS.length, "a refused cookie falls back to the page token and the league still loads");
  const isLeague = (u) => u.startsWith("https://api.cbssports.com/fantasy/league/");
  const api = fetchImpl.calls.filter(isLeague);
  ok(api.length > 3, "...with every league request going to the public API host");
  ok(api.every((u) => !u.includes("access_token") && !u.includes("token=")),
     "...and no token in any URL");
  ok(fetchImpl.calls.every((u, k) => !isLeague(u) || Boolean(fetchImpl.inits[k]?.headers?.Authorization)),
     "the token rides in an Authorization header on every league request");
  ok(fetchImpl.calls.every((u, k) => isLeague(u) || !fetchImpl.inits[k]?.headers?.Authorization),
     "...and on nothing else: not the crosswalk, and not CBS's own public feeds");
  ok(fetchImpl.calls.some((u) => u.startsWith("https://api.cbssports.com/fantasy/players/")),
     "...even though a public CBS feed is fetched from the very same host");

  // Cookie refused and the token refused too.
  err = null;
  try { await load(refuseAll(cbsTable())); } catch (e) { err = e; }
  ok(err?.code === "AUTH", "a refused token is an AUTH failure too, not a broken-token error");

  // A real server error is not an auth problem and must not show the sign-in screen.
  const broken = cbsTable();
  for (const s of SESSIONS) broken[cbsUrl(REF, "league/rules", {}, s)] = httpError(500, "boom");
  err = null;
  try { await load(broken); } catch (e) { err = e; }
  ok(err instanceof Error && err.code === undefined && /500/.test(err.message),
     "a 500 rejects with a plain Error carrying the status, and no AUTH code");

  // A 200 whose envelope disagrees with it.
  const lying = cbsTable();
  for (const s of SESSIONS)
    lying[cbsUrl(REF, "league/details", {}, s)] = { statusCode: 401, statusMessage: "User not signed in", body: {} };
  err = null;
  try { await load(lying); } catch (e) { err = e; }
  ok(err?.code === "AUTH", "an envelope that says not-signed-in inside a 200 is still an auth failure");

  // The session is opened once and held in memory for the run.
  const ref = { ...REF };
  const cookieFetch = countingFetch(cbsTable());
  await cbs.loadLeague(ref, () => {}, { fetchImpl: cookieFetch, storage: mkStorage(), now: 0 });
  ok(sessionFor(ref)?.mode === "cookie" && sessionFor(ref).token === null,
     "the recorded league authenticates on the session cookie alone: no token is read at all");
  ok(cookieFetch.calls.filter((u) => u.includes("league/details")).length === 2,
     "one probe to open the session and one read for the settings");
  ok(!cookieFetch.calls.some((u) => u === `https://${REF.leagueId}.football.cbssports.com/`),
     "...and the league page is never fetched when the cookie works");
  ok(cookieFetch.inits.filter((i) => i?.headers?.Authorization).length === 0,
     "...and no Authorization header is sent when there is no token");

  // CR-01. The daily worker hands `val.ref` — an object it is about to write straight back
  // into chrome.storage.local — to platform.fingerprint. If openSession parks the session on
  // that object, the live token is persisted, which D-10 and the Platforms section both
  // forbid. The session is per-run state, not part of the ref.
  {
    const ref = { platform: "cbs", leagueId: "myleague", seasonId: 2026 };
    const before = JSON.stringify(ref);
    const sess = await openSession(ref, { session: { mode: "token", token: "LIVE-TOKEN-0123456789" }, fetchImpl: deadFetch() });
    ok(sess.token === "LIVE-TOKEN-0123456789", "an explicitly passed session is used");
    ok(JSON.stringify(ref) === before, "...and openSession leaves the caller's ref untouched: no session, no token on it");
    ok(!JSON.stringify(ref).includes("LIVE-TOKEN"), "...so a ref serialized to storage cannot carry the token");
    const again = await openSession(ref, { fetchImpl: deadFetch() });
    ok(again && again.token === "LIVE-TOKEN-0123456789", "the session is remembered for this ref without living on it");
  }
  {
    // A ref that arrives carrying a session (how a pasted token is handed in) is still read.
    const ref = { platform: "cbs", leagueId: "myleague", seasonId: 2026, session: { mode: "token", token: "PASTED" } };
    const sess = await openSession(ref, { fetchImpl: deadFetch() });
    ok(sess.token === "PASTED", "a session already on the ref is honoured, as the paste path needs");
  }
  const opened = await openSession({ ...REF }, { session: { mode: "token", token: "T" }, fetchImpl: deadFetch() });
  ok(opened.mode === "token" && opened.token === "T", "a session handed in is used as it is, with no probe");
}

/* session: the four sanctioned routes, in order, and no fifth (D-10, D-11) */
// The scrubbed page carries `REDACTED` where its token was, so a test token is a
// string the fixture can never contain: substitute it in and the page is "tokened",
// substitute nothing and the page is a signed-in page with no token in it.
const TESTTOKEN = "TESTTOKEN-xyz-123";
const TOKENED = PAGE.replace(/REDACTED/g, TESTTOKEN);
const TOKENLESS = PAGE.replace(/REDACTED/g, "");
const isApiLeague = (u) => u.startsWith("https://api.cbssports.com/fantasy/league/");
// A load that is expected to succeed, reported as a failed assertion rather than a
// stack trace when it does not: this suite's contract is "N assertions, M failures".
const tryLoad = async (...args) => {
  try { return await load(...args); }
  catch (e) { return { model: null, error: e, ref: {}, progress: [], fetchImpl: { calls: [], inits: [] } }; }
};
const isProxy = (u) => u.includes(".football.cbssports.com/api/");
const authOf = (f, k) => f.inits[k]?.headers?.Authorization;
{
  ok(extractToken(TOKENED)?.token === TESTTOKEN && extractToken(TOKENLESS) === null,
     "the tokened page carries the test token and the tokenless one carries none");

  // Route 2 (the README's primary): the cookie answers, so nothing else is tried.
  const { fetchImpl: f1, ref: r1 } = await load(cbsTable({ page: TOKENED }));
  ok(sessionFor(r1)?.mode === "cookie" && sessionFor(r1).token === null, "the cookie route opens a token-free session");
  ok(!f1.calls.includes(pageUrl(REF)), "...the league page is never read");
  ok(f1.inits.every((i) => !i?.headers?.Authorization), "...and no request carries an Authorization header");

  // Route 3: the cookie is refused, the page carries a token.
  const { model: m2, fetchImpl: f2, ref: r2 } = await load(refuseCookie(cbsTable({ page: TOKENED })));
  ok(m2.players.size === ROSTER_IDS.length, "a refused cookie falls back to the page token and the league still loads");
  ok(sessionFor(r2)?.mode === "token" && sessionFor(r2).token === TESTTOKEN,
     "...the session holds that token, in memory for this run and never on the ref itself");
  ok(!("session" in r2) && !JSON.stringify(r2).includes(TESTTOKEN),
     "...so the ref the worker round-trips through storage carries no token (CR-01)");
  ok(f2.calls.filter(isApiLeague).length > 3 && f2.calls.every((u, k) => !isApiLeague(u) || authOf(f2, k) === TESTTOKEN),
     "...every league request carries exactly it in an Authorization header");
  ok(f2.calls.every((u, k) => isApiLeague(u) || !authOf(f2, k)),
     "...and nothing else does: not the crosswalk, not CBS's own public feeds, not the page");
  ok(sessionFor(r2).teamHint === 16, "...and the page read on the way past yields the viewer's team id");
  ok(f2.calls.filter((u) => u === pageUrl(REF)).length === 1, "...from one page read, not one per request");

  // Route 4: no token in the page, a content script answers instead (11-07 replies).
  const { model: m3, fetchImpl: f3, ref: r3 } =
    await tryLoad(refuseCookie(cbsTable({ page: TOKENLESS })), { handover: async () => "TESTTOKEN-h" });
  ok(m3?.players.size === ROSTER_IDS.length && sessionFor(r3)?.token === "TESTTOKEN-h",
     "a hand-over token opens the session when the page has none");
  ok(f3.calls.every((u, k) => !isApiLeague(u) || authOf(f3, k) === "TESTTOKEN-h"),
     "...and rides the same header on every league request");

  // Route 5 does not exist: nothing left is an AUTH error, not a password prompt
  // (probe NO-PASSWORD/empty).
  let err = null;
  try { await load(refuseCookie(cbsTable({ page: TOKENLESS })), { handover: async () => null }); } catch (e) { err = e; }
  ok(err instanceof Error && err.code === "AUTH",
     "a refused cookie, a tokenless page and a silent hand-over reject with code AUTH");
  ok(/CBS/.test(err?.message ?? "") && !/password/i.test(err?.message ?? ""),
     "...naming the platform and never asking for a password");
  err = null;
  try { await load(refuseCookie(cbsTable({ page: null })), { handover: async () => { throw new Error("no listener"); } }); } catch (e) { err = e; }
  ok(err?.code === "AUTH", "a hand-over that rejects (a tab with no listener) is a null answer, not a crash");

  // A hand-over token CBS then refuses is still an AUTH failure: every non-cookie
  // route re-probes league/details before its session is accepted.
  err = null;
  try { await load(refuseAll(cbsTable({ page: TOKENLESS })), { handover: async () => "TESTTOKEN-stale" }); } catch (e) { err = e; }
  ok(err?.code === "AUTH", "a stale hand-over token is re-probed and refused, not trusted");

  // Route 1: a token the user pasted arrives on the ref (11-07 sets it).
  const pasted = { mode: "token", token: "TESTTOKEN-p", teamHint: null };
  const { model: m4, fetchImpl: f4 } =
    await load(refuseCookie(cbsTable({ page: TOKENED })), {}, { ...REF, session: pasted });
  ok(m4.players.size === ROSTER_IDS.length, "a pasted token loads the league");
  ok(!f4.calls.includes(pageUrl(REF)), "...with no page read");
  ok(!f4.calls.some(isProxy), "...and no probe of the cookie route");
  ok(f4.calls.every((u, k) => !isApiLeague(u) || authOf(f4, k) === "TESTTOKEN-p"), "...only that token, in the header");

  // The order of the extraction table is fixed: the first pattern that matches wins,
  // wherever in the page the matches sit (the NO-PASSWORD/ordering backstop item).
  const both = `<script>var cfg = {'access_token': 'SECOND-P2'};\nCBSi.token = "FIRST-P1";</script>`;
  ok(extractToken(both)?.token === "FIRST-P1" && extractToken(both)?.pattern === "P1",
     "a P2 match ahead of a P1 match still returns the P1 match: order is the table's, not the page's");
  ok(extractToken('CBSi.token = "A";\nCBSi.token = "B";')?.token === "A",
     "...and the first match of the winning pattern is the one taken");

  // The viewer hint (D-16), read from the same page and nothing else.
  ok(typeof CBS.viewerHint === "function", "viewerHint is exported");
  ok(CBS.viewerHint?.(PAGE) === 16, "viewerHint reads the viewer's team id from the league page");
  ok(CBS.viewerHint?.(PAGE) === Number(/myTeamId\s*=\s*(\d+)/.exec(PAGE_META.viewerHints[0].context)[1]),
     "...the same id the capture recorded in page-meta");
  ok(ROSTER_TEAMS.some((t) => Number(t.id) === CBS.viewerHint?.(PAGE)),
     "...and it is a real team in the rosters payload");
  ok(CBS.viewerHint?.("<html>nothing</html>") === null && CBS.viewerHint?.(null) === null
     && CBS.viewerHint?.("") === null, "a page with no hint is null, not a guess");
}

/* token hygiene: the token reaches a header and nothing else (D-10, T-11-06-01/02/04) */
{
  const st = mkStorage();
  const fetchImpl = countingFetch(refuseCookie(cbsTable({ page: TOKENED })));
  const ref = { ...REF };
  const model = await cbs.loadLeague(ref, () => {}, { fetchImpl, storage: st, now: 0 });
  ok(fetchImpl.calls.every((u) => !u.includes("TESTTOKEN")), "no URL the adapter requested carries the token");
  ok(fetchImpl.calls.every((u) => !u.includes("access_token")), "...and none carries an access_token parameter at all");
  ok(!JSON.stringify([...st._m.entries()]).includes("TESTTOKEN"),
     "nothing the adapter wrote to storage contains the token");
  ok(!model.notes.join("\n").includes("TESTTOKEN"), "no note carries the token");
  ok(sessionFor(ref).token === TESTTOKEN, "...it lives in memory for this run, and there only");
  ok(!("session" in ref), "...never on the ref, which is what the daily worker writes back to storage (CR-01)");

  // Two runs at once, on two refs, with two different tokens (probe NO-PASSWORD/concurrency).
  const REF_A = { platform: "cbs", leagueId: "league-a", seasonId: 2026 };
  const REF_B = { platform: "cbs", leagueId: "league-b", seasonId: 2026 };
  const TOKEN_A = "TESTTOKEN-a", TOKEN_B = "TESTTOKEN-b";
  const both = { ...refuseCookie(cbsTable({ ref: REF_A, page: PAGE.replace(/REDACTED/g, TOKEN_A) })),
                 ...refuseCookie(cbsTable({ ref: REF_B, page: PAGE.replace(/REDACTED/g, TOKEN_B) })) };
  const f = countingFetch(both);
  const refA = { ...REF_A }, refB = { ...REF_B };
  const [mA, mB] = await Promise.all([
    cbs.loadLeague(refA, () => {}, { fetchImpl: f, storage: mkStorage(), now: 0 }),
    cbs.loadLeague(refB, () => {}, { fetchImpl: f, storage: mkStorage(), now: 0 }),
  ]);
  ok(mA.players.size === ROSTER_IDS.length && mB.players.size === ROSTER_IDS.length, "both leagues load");
  ok(sessionFor(refA).token === TOKEN_A && sessionFor(refB).token === TOKEN_B, "each run holds its own token");
  ok(!("session" in refA) && !("session" in refB), "...and neither ref carries one");
  const wrong = f.calls.filter((u, k) => isApiLeague(u)
    && authOf(f, k) !== (u.includes("league_id=league-a") ? TOKEN_A : TOKEN_B));
  ok(wrong.length === 0 && f.calls.filter(isApiLeague).length > 6,
     "every league request carries the token of its own league, never the other run's");
}

/* fingerprint: one rosters request, the same hash, null on anything else (decision 4) */
{
  const { model } = await load(cbsTable());
  const f = countingFetch(cbsTable());
  let fp = "unset";
  try { fp = await cbs.fingerprint({ ...REF }, { fetchImpl: f, storage: mkStorage(), now: 0 }); }
  catch (e) { fp = `threw: ${e.message}`; }
  ok(fp === model.fingerprint, "fingerprint(ref) is the string loadLeague put in model.fingerprint");
  ok(f.calls.filter((u) => u.includes("league/rosters")).length === 1, "...from one league/rosters request");
  ok(!f.calls.some((u) => u.includes("league/stats")), "...and no projection call: this is the daily check, not a league pull");

  let dead = "unset";
  try { dead = await cbs.fingerprint({ ...REF }, { fetchImpl: deadFetch(), storage: mkStorage(), now: 0 }); }
  catch (e) { dead = `threw: ${e.message}`; }
  ok(dead === null, "a dead feed is a null fingerprint, never a throw");
  let refused = "unset";
  try { refused = await cbs.fingerprint({ ...REF }, { fetchImpl: countingFetch(refuseAll(cbsTable())), storage: mkStorage(), now: 0 }); }
  catch (e) { refused = `threw: ${e.message}`; }
  ok(refused === null, "...and so is a refused session");

  let asked = 0;
  const handover = async () => { asked++; return "TESTTOKEN-h"; };
  let viaHandover = "unset";
  try { viaHandover = await cbs.fingerprint({ ...REF }, { fetchImpl: countingFetch(refuseAll(cbsTable({ page: TOKENLESS }))), storage: mkStorage(), now: 0, handover }); }
  catch (e) { viaHandover = `threw: ${e.message}`; }
  ok(asked === 0 && viaHandover === null,
     "the fingerprint never asks a content script for a token: the service worker has no tab to ask");
}

/* free agents (D-14): the unrostered pool, scored under this league's own settings */
// The recorded free-agent route answers one week; the table serves it for every week,
// so what is pinned here is the record shape and the cadence, not week-to-week numbers.
const FA_KEEP = FA_ROWS.filter((r) => Number(r.FPTS) > 0).length;
const attempt = async (fn) => { try { return await fn(); } catch (e) { return { __error: String(e.message ?? e) }; } };
{
  const f = countingFetch(cbsTable());
  const fas = await attempt(() => cbs.loadFreeAgents({ ...REF }, WEEKS, { fetchImpl: f, storage: mkStorage(), now: 0 }));
  const list = Array.isArray(fas) ? fas : [];
  ok(Array.isArray(fas), `loadFreeAgents returns an array (${fas?.__error ?? "ok"})`);
  ok(list.length === FA_KEEP && FA_KEEP < FA_ROWS.length,
     `every free agent CBS projects is returned (${FA_KEEP} of ${FA_ROWS.length}) and the rest are dropped`);
  ok(list.every((p) => p.teamId === null), "a free agent belongs to no team");
  ok(list.every((p) => typeof p.id === "number" && Number.isInteger(p.id)), "every id is an integer Number");
  ok(list.every((p) => !ROSTER_SET.has(-p.id)), "...and no rostered player is in the pool");
  ok(list.every((p) => typeof p.owned === "number" && Number.isFinite(p.owned)), "owned is a number");
  ok(list.every((p) => Array.isArray(p.history) && p.history.length === 0),
     "a free agent carries an empty history: weekly scoring is read for the roster, not the pool");
  ok(list.every((p) => WEEKS.every((w) => typeof p.proj[w] === "number" && Number.isFinite(p.proj[w]))),
     "every requested week carries a finite projection");
  ok(list.every((p) => WEEKS.some((w) => p.proj[w] > 0)), "...and every player kept projects something somewhere");
  ok(list.every((p) => typeof p.bye === "number" && typeof p.nfl === "string" && typeof p.pos === "string"),
     "the rest of the record is the shape the model already speaks");
  const ward = list.find((p) => p.name === "Cam Ward");
  ok(ward && ward.proj[1] === 19.6 && ward.pos === "QB" && ward.nfl === "TEN",
     "a named free agent carries his recorded FPTS, position and pro team");
  ok(ward && ward.eligibleSlots.includes(0) && ward.eligibleSlots.includes(20) && ward.eligibleSlots.includes(21),
     "...and seats where the league's own slots let him, plus bench and IR");

  const fa = f.calls.filter((u) => u.includes("player_status=free_agents"));
  ok(fa.length === WEEKS.length, `one free-agent request per week (${WEEKS.length})`);
  ok(fa.every((u) => u.includes("stats_type=projections")), "...each asking for projections");
  ok(f.maxStatsInflight === 3, "never more than three in flight at once");
  ok(!f.calls.some((u) => u.includes("player_status=all")), "...and the rostered pool is not fetched again");

  // The horizon: a league in week 5 is asked about weeks 5 onward and no earlier.
  const late = structuredClone(env("details.json"));
  late.body.league_details.current_period = "5";
  const f5 = countingFetch(cbsTable({ details: late }));
  await attempt(() => cbs.loadFreeAgents({ ...REF }, WEEKS, { fetchImpl: f5, storage: mkStorage(), now: 0 }));
  const asked = f5.calls.filter((u) => u.includes("player_status=free_agents"))
    .map((u) => Number(/period=week(\d+)/.exec(u)[1])).sort((a, b) => a - b);
  ok(same(asked, WEEKS.filter((w) => w >= 5)), "only the weeks that remain are asked for");

  const dead = await attempt(() => cbs.loadFreeAgents({ ...REF }, WEEKS, { fetchImpl: countingFetch({}), storage: mkStorage(), now: 0 }));
  ok(!Array.isArray(dead) && typeof dead.__error === "string",
     "a dead free-agent route throws: the panel's own catch turns it into one line and no pool");
}

/* schedule: real matchups, by week, keyed on the names the Engine keys on */
{
  const { model } = await load(cbsTable());
  const f = countingFetch(cbsTable());
  const byWeek = await attempt(() => cbs.loadSchedule({ ...REF }, model.teams, { fetchImpl: f, storage: mkStorage(), now: 0 }));
  const map = byWeek instanceof Map ? byWeek : new Map();
  ok(byWeek instanceof Map, `loadSchedule returns a Map (${byWeek?.__error ?? "ok"})`);
  ok(map.size === 14, "one entry per period that has matchups: the 14 regular-season weeks");
  ok([...map.keys()].every((w) => Number.isInteger(w)), "...keyed on the period number, as a number");
  ok([...map.values()].every((ms) => ms.length === 6), "six matchups a week in a twelve-team league");
  const names = new Set([...model.teams.values()].map((t) => t.name));
  ok([...map.values()].flat().every(([h, a]) => names.has(h) && names.has(a)),
     "every pair is [homeName, awayName], resolved through teamsById to the names the Engine keys on");
  const week1 = body("schedules.json").schedule.periods[0].matchups[0];
  ok(same(map.get(1)?.[0], [model.teams.get(Number(week1.home_team.id)).name,
                            model.teams.get(Number(week1.away_team.id)).name]),
     "...home first, away second, as the payload orders them");
  ok(f.calls.filter((u) => u.includes("league/schedules")).length === 1
     && f.calls.some((u) => u.includes("period=all")), "one league/schedules?period=all request");

  // An entry with a side missing is a bye or a placeholder, and is skipped.
  const holed = structuredClone(env("schedules.json"));
  delete holed.body.schedule.periods[0].matchups[0].away_team;
  holed.body.schedule.periods[0].matchups[1].home_team.id = "999";
  const partial = await attempt(() => cbs.loadSchedule({ ...REF }, model.teams,
    { fetchImpl: countingFetch(cbsTable({ schedule: false, ref: REF })), storage: mkStorage(), now: 0 }));
  ok(!(partial instanceof Map) && typeof partial.__error === "string",
     "a failing schedules route rejects, which is what the panel's catch reads as all-play");
  const holedTable = { ...cbsTable() };
  for (const s of SESSIONS) holedTable[cbsUrl(REF, "league/schedules", { period: "all" }, s)] = holed;
  const skipped = await attempt(() => cbs.loadSchedule({ ...REF }, model.teams,
    { fetchImpl: countingFetch(holedTable), storage: mkStorage(), now: 0 }));
  ok(skipped instanceof Map && skipped.get(1)?.length === 4,
     "a matchup with no away side and one naming a team that is not in the league are both skipped");
}

/* standings and history: the season starts from the record, not from 0-0 */
{
  const { model } = await load(cbsTable());
  const rows = body("standings.json").overall_standings.teams;
  const teams = [...model.teams.values()];
  ok(teams.length === rows.length && teams.every((t) => t.record !== undefined),
     "every team carries a record when the standings answer for every team");
  ok(teams.every((t) => ["wins", "losses", "ties", "pointsFor"].every((k) => typeof t.record?.[k] === "number")),
     "...each of them {wins, losses, ties, pointsFor} numbers");
  const first = rows[0];
  const mine = model.teams.get(Number(first.id));
  ok(mine?.record?.wins === Number(first.wins) && mine?.record?.losses === Number(first.losses)
     && mine?.record?.ties === Number(first.ties) && mine?.record?.pointsFor === Number(first.points_scored),
     "...read from the standings row for that team, points scored included");
  ok(!model.notes.some((n) => /standings unavailable/.test(n)), "a working standings route raises no note");

  const { model: noStand } = await load(cbsTable({ standings: false }));
  ok([...noStand.teams.values()].every((t) => t.record === undefined),
     "a dead standings route leaves every team with no record at all, never a fabricated 0-0");
  ok(noStand.notes.filter((n) => /^CBS: standings unavailable/.test(n)).length === 1,
     "...and says so in exactly one note (panel.js then projects from 0-0 and prints it)");
  ok(noStand.players.size === ROSTER_IDS.length, "...and the league still loads");

  // The builder, on the rows the recorded feed actually holds: free agents only, so
  // the rostered path is exercised with a synthetic row of the same shape (README
  // Findings weekly_scoring_shape - player_status defaults to free_agents).
  const hist = typeof CBS.historyFromWeeklyScoring === "function"
    ? CBS.historyFromWeeklyScoring(body("weekly-scoring.json"), 2026) : new Map();
  ok(hist instanceof Map && hist.size === body("weekly-scoring.json").weekly_scoring.players.length,
     "historyFromWeeklyScoring returns one entry per player the feed carries");
  ok(same(hist.get(26698879), [{ season: 2026, week: 1, actual: 1.1, proj: null }]),
     "...each a {season, week, actual, proj: null} row per period played, keyed on the CBS id");
  ok([...hist.values()].flat().every((h) => h.proj === null && Number.isInteger(h.season)
     && Number.isInteger(h.week) && typeof h.actual === "number"),
     "...CBS publishes no historical projection, so proj is null on every row, never 0");
  const priorHist = typeof CBS.historyFromWeeklyScoring === "function"
    ? CBS.historyFromWeeklyScoring(PRIOR.body, 2025) : new Map();
  ok(priorHist.get(2260977)?.length === 22 && priorHist.get(2260977)?.[0].season === 2025,
     "the prior season reads the same way through timeframe, 22 periods of it");
  ok(same(CBS.historyFromWeeklyScoring?.(null, 2026), new Map())
     || (CBS.historyFromWeeklyScoring?.(null, 2026)?.size === 0),
     "an empty body is an empty map, not a throw");

  // The wiring: a rostered player's rows reach his record, and the calibration log
  // can then fill an actual from them.
  const ROSTERED = ROSTER_IDS[0];
  const spliced = structuredClone(env("weekly-scoring.json"));
  spliced.body.weekly_scoring.player_status = "all";
  spliced.body.weekly_scoring.players.push({
    id: String(ROSTERED), total: "20.5", avg: "20.5",
    player: { id: String(ROSTERED), name: "rostered", position: "RB", pro_team: "KC",
              eligible_positions: ["RB", "RB-WR-TE"], free_agent: 0 },
    periods: [{ period: "1", score: "20.5" }],
  });
  const { model: withHist } = await load(cbsTable({ history: spliced }));
  const him = withHist.players.get(MAPPED.find(([c]) => c === ROSTERED)?.[1] ?? -ROSTERED);
  ok(him && same(him.history, [{ season: 2026, week: 1, actual: 20.5, proj: null }]),
     "a rostered player's weekly scoring reaches his history, on the id the crosswalk gave him");
  ok([...withHist.players.values()].filter((p) => p.history.length).length === 1,
     "...and only the players the feed names: the other 167 keep an empty history");
  const log = { weeks: { 1: { rows: [{ id: him?.id, pos: "RB", espn: 18.2, actual: null }] } } };
  const filled = attachActuals(log, withHist.players, 2026);
  ok(filled.filled === 1 && log.weeks[1].rows[0].actual === 20.5,
     "attachActuals fills the calibration log's actual from that history, unchanged in shape");

  const { model: noHist } = await load(cbsTable({ history: null, prior: null }));
  ok([...noHist.players.values()].every((p) => p.history.length === 0),
     "a dead weekly-scoring route leaves every history empty");
  ok(noHist.notes.filter((n) => /^CBS: weekly scoring/.test(n)).length >= 1,
     "...and says so, rather than showing an empty history in silence");
  ok(noHist.players.size === ROSTER_IDS.length, "...and the league still loads");
  ok(!model.notes.some((n) => /no weekly history/.test(n)),
     "the 11-05 placeholder note is gone: history and standings are read now");
}

/* identify (D-16): the team page, then the page hint, then honesty */
{
  const { model } = await load(cbsTable());
  const HINT = 16;
  const named = model.teams.get(HINT)?.name;
  const fromPage = await attempt(() => cbs.identify({ ...REF, teamId: HINT }, model, { fetchImpl: deadFetch() }));
  ok(same(fromPage, { team: named, how: "the team page you came from" }),
     "the team page the user came from wins");
  const fromHint = await attempt(() => cbs.identify(
    { ...REF, session: { mode: "token", token: "TESTTOKEN-x", teamHint: HINT } }, model, { fetchImpl: deadFetch() }));
  ok(same(fromHint, { team: named, how: "your CBS league page" }),
     "...then the id the league page embeds");
  const neither = await attempt(() => cbs.identify(
    { ...REF, session: { mode: "cookie", token: null, teamHint: null } }, model, { fetchImpl: deadFetch() }));
  ok(same(neither, { team: null, how: null }),
     "with neither, it says so rather than guessing: pickTeam asks");
  const unknown = await attempt(() => cbs.identify({ ...REF, teamId: 4242 }, model, { fetchImpl: deadFetch() }));
  ok(same(unknown, { team: null, how: null }), "a team id no team has is not a match");

  // The cookie route never reads the page, so the hint is only there to be had if
  // identify goes and gets it - one credentialed read of the same page openSession
  // would have read, and nothing else.
  const f = countingFetch(cbsTable());
  const cookieRef = { ...REF, session: { mode: "cookie", token: null, teamHint: null } };
  const fetched = await attempt(() => cbs.identify(cookieRef, model, { fetchImpl: f, storage: mkStorage(), now: 0 }));
  ok(same(fetched, { team: named, how: "your CBS league page" }),
     "on the cookie route identify reads the league page for the hint");
  ok(f.calls.length === 1 && f.calls[0] === pageUrl(REF), "...one page read, and nothing else");
  ok(cookieRef.session.teamHint === HINT, "...remembered on the ref for the rest of the run");
}

/* degradation matrix: each feed removed on its own (HONEST-DEGRADATION) */
// One row per feed COVERAGE.md lists. An optional feed costs exactly one note and
// the league still loads; a required one fails loudly, and not as an auth error -
// the panel shows the sign-in screen only for AUTH.
{
  const drop = (t, route, params = {}) => {
    for (const s of SESSIONS) delete t[cbsUrl(REF, route, params, s)];
    return t;
  };
  // A roster row with no bye week is the only thing that makes the adapter read the
  // public player list at all, so the row that exercises it needs one.
  const noBye = () => {
    const e = structuredClone(env("rosters.json"));
    delete e.body.rosters.teams[0].players[0].bye_week;
    return e;
  };
  const withRosters = (t, rosters) => {
    for (const s of SESSIONS) t[cbsUrl(REF, "league/rosters", { team_id: "all" }, s)] = rosters;
    return t;
  };

  const OPTIONAL = [
    ["scoring rules", () => drop(cbsTable(), "league/scoring/rules"), /^CBS: scoring rules unavailable/],
    ["standings", () => cbsTable({ standings: false }), /^CBS: standings unavailable/],
    ["weekly scoring", () => cbsTable({ history: null }), /^CBS: weekly scoring for this season is unavailable/],
    ["prior-season scoring", () => cbsTable({ prior: null }), /^CBS: weekly scoring for 2025 is unavailable/],
    ["the injuries feed", () => cbsTable({ injuries: false }), /^CBS: the injury feed is unavailable/],
    ["the id crosswalk", () => cbsTable({ crosswalk: false }), /^CBS: id crosswalk unavailable/],
    ["the public player list", () => withRosters(cbsTable(), noBye()), /^CBS: the player list is unavailable/],
  ];
  for (const [label, build, re] of OPTIONAL) {
    const { model } = await load(build());
    ok(model.players.size === ROSTER_IDS.length && model.teams.size === ROSTER_TEAMS.length
       && model.weeks.length === WEEKS.length,
       `${label}: the league still loads, with every player, team and week`);
    ok(model.notes.filter((n) => re.test(n)).length === 1, `${label}: exactly one note names it`);
    ok(model.notes.every((n) => n.startsWith("CBS: ")), `${label}: every note still names the platform`);
    ok(model.notes.every((n) => !n.includes("TESTTOKEN") && !n.includes("redacted-league")),
       `${label}: no note carries a token or the league's own slug`);
  }
  // The same public list, present: the bye it fills is the whole reason to read it.
  const listed = withRosters(cbsTable(), noBye());
  listed[publicUrl("players/list")] = file("public/players-list.json");
  const { model: filled } = await load(listed);
  ok(!filled.notes.some((n) => /player list is unavailable/.test(n)),
     "a live player list raises no note");

  const REQUIRED = [
    ["league/rules", () => drop(cbsTable(), "league/rules")],
    ["league/details", () => drop(cbsTable(), "league/details")],
    ["league/rosters", () => drop(cbsTable(), "league/rosters", { team_id: "all" })],
    ["a projections week", () => drop(cbsTable(), "league/stats",
      { stats_type: "projections", period: "week1", player_status: "all" })],
  ];
  for (const [label, build] of REQUIRED) {
    let err = null;
    try { await load(build()); } catch (e) { err = e; }
    ok(err instanceof Error, `${label} failing costs the run: there is no model without it`);
    ok(err?.code !== "AUTH",
       `...and it is not reported as an auth failure, so the panel shows the error rather than the sign-in screen`);
  }

  // A projections week that answers 200 with no rows at all (assumption A-11-06-1):
  // zeros for that week and a note, not a throw and not a silent gap.
  const empty = cbsTable();
  for (const s of SESSIONS)
    empty[cbsUrl(REF, "league/stats", { stats_type: "projections", period: "week3", player_status: "all" }, s)] =
      { statusCode: 200, statusMessage: "OK", body: { league_stats: { players: [] } } };
  const { model: hollow } = await load(empty);
  ok(hollow.players.size === ROSTER_IDS.length, "a projections week with no rows still loads the league");
  ok([...hollow.players.values()].every((p) => p.proj[3] === 0),
     "...that week projects zero for everyone");
  ok([...hollow.players.values()].some((p) => p.proj[1] > 0), "...and the other weeks are untouched");
  ok(hollow.notes.filter((n) => /^CBS: the week 3 projection/.test(n)).length === 1,
     "...and exactly one note says which week went quiet");
}

/* degradation: unmapped players (D-06)

   The engine is the point of the whole seam, so it is built here on the CBS model
   exactly as panel.js builds it on the ESPN one - and an unmapped player, who has no
   ESPN id for any external feed to join on, has to cost a dash in one column rather
   than a crash, a zero or a missing seat. `-cbsId` keeps him in the lineup solve; the
   crosswalk is what he is missing, not a roster spot. */
{
  const { model } = await load(cbsTable());
  const { slots, starters } = buildSlots(model.settings.lineupSlotCounts);
  const masks = new Map([...model.players].map(([id, p]) => [id, seatMask(p.eligibleSlots, slots)]));
  const eng = new Engine(model, { starters }, masks);

  ok(eng.teams.length === model.teams.size,
     "the Engine constructs on the CBS model, with every team in it");
  ok(eng.teams.every((t) => {
       const b = eng.baseline.get(t);
       return b && b.length === model.weeks.length && [...b].every(Number.isFinite);
     }), "every team's baseline lineup value is finite in every week");
  ok(eng.teams.every((t) => [...eng.baseline.get(t)].some((v) => v > 0)),
     "...and not simply zero, so the slot masks really seat CBS players");
  ok(Array.isArray(eng.freeAgents), "eng.freeAgents is an array");
  ok([...model.players.values()].filter((p) => p.id < 0).length > 0,
     "the fixture really does hold unmapped players, or the rest of this proves nothing");

  // A market feed that prices every crosswalked player and, necessarily, none of the
  // rest: FantasyCalc is keyed on the ESPN id an unmapped player does not have.
  const priced = new Map(MAPPED.map(([, espnId]) => [espnId, { value: 1000, overall: 1 }]));
  const mkt = marketView(eng, { byEspn: priced, params: { ppr: 0.5 }, stale: false });
  ok(mkt && mkt.priced === MAPPED.length && mkt.byIndex.size === MAPPED.length,
     "marketView bridges the crosswalked players onto engine indices and no one else");

  const idx = (id) => eng.index.get(id);
  const mappedA = MAPPED[0][1], mappedB = MAPPED[1][1];
  const unmapped = [...model.players.values()].find((p) => p.id < 0).id;
  const teamOf = (id) => eng.teams.find((t) => eng.roster.get(t).includes(idx(id))) ?? eng.teams[0];

  const bothPriced = { sides: [{ team: teamOf(mappedA), sent: [idx(mappedA)], received: [idx(mappedB)] }] };
  const withUnmapped = { sides: [{ team: teamOf(mappedA), sent: [idx(unmapped)], received: [idx(mappedA)] }] };

  ok(typeof marketFair(bothPriced, mkt) === "number",
     "a trade between two crosswalked players has a real fairness number");
  ok(!marketCell(bothPriced, mkt).includes("—"),
     "...so its market cell is a bar, not a dash");
  ok(marketFair(withUnmapped, mkt) === null,
     "one unmapped player in the deal is enough to have no fairness at all");
  ok(marketCell(withUnmapped, mkt).includes("—"),
     "...and his market cell is a dash");
  ok(marketCell(withUnmapped, mkt).split("<td").length === 2,
     "...still exactly one cell, so a dash never shifts the column count");

  ok(marketView(eng, null) === null, "a dead market feed is a null view, not a throw");
  ok(marketCell(bothPriced, null).includes("—"),
     "...and then every cell is a dash, including one both of whose players are mapped");
  const emptyFeed = marketView(eng, { byEspn: new Map(), params: {}, stale: false });
  ok(emptyFeed && emptyFeed.priced === 0 && marketCell(bothPriced, emptyFeed).includes("—"),
     "a feed that answered with nothing priced reads the same as a dead one");

  // Usage joins through Sleeper, which is keyed on the ESPN id too.
  ok(usageView(model, null, model.settings.currentWeek) === null,
     "a dead usage feed is a null view, not a throw");
  const sleeperRow = { player_id: "4001", espn_id: String(mappedA), team: "KC",
                       depth_chart_order: 1, depth_chart_position: "RB" };
  const rec = { off_snp: 40, tm_off_snp: 60, rec_tgt: 8, rec_air_yd: 90, rush_att: 4,
                pass_att: 0, rec_td: 1, rush_td: 0, pts_half_ppr: 18, pts_ppr: 20, pts_std: 15, team: "KC" };
  const loadedUsage = {
    players: { bySleeper: new Map([["4001", sleeperRow]]), at: 0 },
    stats: { byWeek: new Map([[1, new Map([["4001", rec]])], [2, new Map([["4001", rec]])]]),
             weeks: [1, 2], failed: [] },
    trending: [],
  };
  const view = usageView(model, loadedUsage, 3);
  ok(view && view.table.rows.get(mappedA), "a crosswalked player joins the usage table");
  ok([...view.table.rows.keys()].every((id) => id > 0),
     "no unmapped player is ever in it: a negative id is one no external feed can key on");
  ok(view.table.rows.size === 1 && model.players.size > 1,
     "...so 1 of the league's players has usage and the rest simply show nothing");

  ok(model.notes.some((n) => /^CBS: id crosswalk/.test(n)),
     "and the panel is told: one note says how many players the crosswalk mapped");
  ok(/\bdashes\b/.test(model.notes.find((n) => /^CBS: id crosswalk/.test(n))),
     "...in the words the user needs - the unmapped ones will show dashes");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("CBS OK");
