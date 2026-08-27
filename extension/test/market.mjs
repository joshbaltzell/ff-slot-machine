/**
 * Tests for Phase 3 (market): the FantasyCalc feed, fairness math, the arbitrage
 * ranking, and the panel helpers - all offline, with fetch and storage injected.
 *
 *   node extension/test/market.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { Engine } from "../engine/search.js";
import { marketParams, marketUrl, trimValues, loadMarket } from "../engine/sources/fantasycalc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };

/* Injection helpers, same shape as sources.mjs. */
const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; }, async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const mkFetch = (table) => { const calls = []; const f = async (url) => { calls.push(url);
  const hit = table[url]; if (!hit) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; }; f.calls = calls; return f; };
const deadFetch = () => { const f = async () => { throw new Error("network down"); }; f.calls = []; return f; };

/* ---- the model, built the way parity.mjs builds it (copied, not imported:
        parity.mjs is the frozen engine contract and runs 605 assertions) ---- */
const { slots, starters } = buildSlots(F.lineupSlotCounts);
const masks = new Map(F.pos.map((p, i) => [i, seatMask(F.eligibleSlots[p], slots)]));
const SETTINGS = {
  name: "Fixture",
  pprValue: 0.5,
  currentWeek: 1,
  regularSeasonWeeks: F.weeks.filter((w) => w <= 14),
  playoffWeeks: [15, 16, 17],
  playoffRoundWeeks: [[15], [16], [17]],
  playoffTeams: 6,
  playoffReseed: true,
  lineupSlotCounts: F.lineupSlotCounts,
};
const model = {
  weeks: F.weeks,
  settings: SETTINGS,
  players: new Map(F.pos.map((pos, i) => [i, {
    id: i, name: `p${i}`, pos, nfl: "X", eligibleSlots: F.eligibleSlots[pos],
    bye: F.weeks.find((w) => !(F.proj[i][F.weeks.indexOf(w)] > 0)) ?? 0,
    proj: Object.fromEntries(F.weeks.map((w, k) => [w, F.proj[i][k]])),
  }])),
  teams: new Map(F.teams.map((name, ti) => [ti, { id: ti, name, roster: new Set(F.rosters[name]) }])),
};
const eng = new Engine(model, { starters }, masks);
const IX = (id) => eng.index.get(id);          // player id -> engine index

/* A synthetic FantasyCalc payload for fixture players 0..29. Value falls with the
   id so the ranks are predictable; player 7 is deliberately left unpriced. */
const FC_PAYLOAD = [];
{
  const posRank = new Map();
  for (let id = 0; id <= 29; id++) {
    if (id === 7) continue;                    // unpriced on purpose
    const pos = F.pos[id];
    const pr = (posRank.get(pos) ?? 0) + 1;
    posRank.set(pos, pr);
    FC_PAYLOAD.push({
      player: { id: 9000 + id, name: `fc${id}`, position: pos, espnId: id },
      value: 10000 - id * 100,
      overallRank: id + 1,
      positionRank: pr,
      trend30Day: id % 2 ? -10 * id : 10 * id,
      maybeTier: 1 + Math.floor(id / 10),
      redraftValue: 1, combinedValue: 1, maybeOwner: null, starter: true,
    });
  }
  FC_PAYLOAD.push({ player: { id: 1, name: "no espn id", position: "WR" }, value: 5000,
                    overallRank: 999, positionRank: 99, trend30Day: 0 });
}
const FC_URL = "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=10&ppr=0.5";

/* ---- 1. parameters and URL ---- */
{
  const p = marketParams(SETTINGS, 10);
  ok(p.numQbs === 1 && p.numTeams === 10 && p.ppr === 0.5, "fixture snaps to 1QB / 10 teams / 0.5 ppr");
  ok(marketUrl(SETTINGS, 10) === FC_URL, "url is built from the snapped parameters");

  const twoQb = { ...SETTINGS, lineupSlotCounts: { ...F.lineupSlotCounts, 0: 2 } };
  ok(marketParams(twoQb, 10).numQbs === 2, "two dedicated QB slots is a 2QB market");
  const oneQb = { ...SETTINGS, lineupSlotCounts: { ...F.lineupSlotCounts, 0: 1 } };
  ok(marketParams(oneQb, 10).numQbs === 1, "one dedicated QB slot is a 1QB market");
  const superflex = { ...SETTINGS, lineupSlotCounts: { ...F.lineupSlotCounts, 0: 1, 7: 1 } };
  ok(marketParams(superflex, 10).numQbs === 2, "an OP/superflex slot is a 2QB market");
  ok(marketParams(SETTINGS, 10).numQbs === 1, "a TQB league with no slot 0 or 7 is 1QB");

  ok(marketParams(SETTINGS, 6).numTeams === 8, "6 teams snaps up to 8");
  ok(marketParams(SETTINGS, 9).numTeams === 8, "9 teams ties and snaps down to 8");
  ok(marketParams(SETTINGS, 11).numTeams === 10, "11 teams ties and snaps down to 10");
  ok(marketParams(SETTINGS, 12).numTeams === 12, "12 teams is exact");
  ok(marketParams(SETTINGS, 13).numTeams === 12, "13 teams ties and snaps down to 12");
  ok(marketParams(SETTINGS, 20).numTeams === 14, "20 teams snaps to the deepest offered");

  ok(marketParams({ ...SETTINGS, pprValue: 0 }, 10).ppr === 0, "0 ppr is standard");
  ok(marketParams({ ...SETTINGS, pprValue: 0.4 }, 10).ppr === 0.5, "0.4 ppr snaps to half");
  ok(marketParams({ ...SETTINGS, pprValue: 1 }, 10).ppr === 1, "1 ppr is full");
  ok(marketParams({ ...SETTINGS, pprValue: 1.5 }, 10).ppr === 1, "1.5 ppr snaps to full");
  ok(marketParams({ ...SETTINGS, pprValue: undefined }, 10).ppr === 0, "a missing pprValue is standard");
}

/* ---- 2. trimming and loading ---- */
{
  const trimmed = trimValues(FC_PAYLOAD);
  ok(trimmed.length === 29, `rows without an espnId are dropped (${trimmed.length} of ${FC_PAYLOAD.length})`);
  ok(trimmed.every((r) => typeof r.espnId === "number"), "espnId is numeric");
  ok(!("redraftValue" in trimmed[0]), "unused fields are trimmed away");
  ok(trimmed[0].tier === 1, "maybeTier is read as tier");
  ok(trimmed[0].pos === F.pos[0] && trimmed[0].name === "fc0", "name and position come from the nested player");
  ok(trimValues(null).length === 0 && trimValues({}).length === 0, "a non-array payload trims to nothing");

  const storage = mkStorage();
  const fetchImpl = mkFetch({ [FC_URL]: FC_PAYLOAD });
  const m = await loadMarket(SETTINGS, 10, { fetchImpl, storage, now: 0 });
  ok(m.byEspn.size === 29, "every priced player is keyed by espn id");
  ok(m.byEspn.get(0).value === 10000, "value round-trips");
  ok(!m.byEspn.has(7), "the unpriced player is absent");
  ok(m.params.numTeams === 10, "the snapped parameters ride along for the log line");
  ok(m.fromCache === false, "the first call is a live fetch");

  const m2 = await loadMarket(SETTINGS, 10, { fetchImpl, storage, now: 3600e3 });
  ok(m2.fromCache === true && fetchImpl.calls.length === 1, "a second call inside 12h uses the cache");
  const m3 = await loadMarket(SETTINGS, 10, { fetchImpl, storage, now: 13 * 3600e3 });
  ok(m3.fromCache === false && fetchImpl.calls.length === 2, "past 12h it refetches");
  ok([...storage._m.keys()].some((k) => k.startsWith("src.fantasycalc.")),
     "the cache key is namespaced under src.fantasycalc.");
  const other = await loadMarket({ ...SETTINGS, pprValue: 1 }, 12,
    { fetchImpl: mkFetch({ "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1": FC_PAYLOAD }),
      storage, now: 0 });
  ok(other.byEspn.size === 29, "a different league shape is a different cache entry, not a stale hit");

  let threw = false;
  try { await loadMarket(SETTINGS, 10, { fetchImpl: deadFetch(), storage: mkStorage(), now: 0 }); }
  catch { threw = true; }
  ok(threw, "a dead feed with no cache throws out of loadMarket");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("MARKET OK");
