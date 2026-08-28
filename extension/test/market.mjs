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
import { indexMarket, sideMarket, tradeFairness, pitchMarketLine, arbitrage } from "../engine/market.js";
import { MARKET_HINT, marketOrNull, marketView, marketFair, marketFairChip, marketCol,
         marketCell, marketDetail, marketPitchLine, arbitrageSection } from "../panel/market.js";

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
/* Accepts the "connection" and then never answers - the one failure `cached()` cannot
   see on its own, since `fetch` has no default timeout. */
const stuckFetch = () => { const f = () => new Promise(() => {}); f.calls = []; return f; };

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

  /* Hostile rows: trimValues must never throw, no matter what a feed sends. The
     espnId guard runs before row.value is ever read, which is what makes these safe -
     nothing currently pins that ordering. */
  ok(trimValues([null, 3, "x"]).length === 0,
     "rows that are null, a bare number, or a bare string are dropped rather than throwing");
  ok(trimValues([{ value: 10, overallRank: 1 }]).length === 0,
     "a row with no player key at all has no espnId and is dropped");
  const badValue = trimValues([{ player: { espnId: 503 }, value: "not-a-number" }]);
  ok(badValue.length === 1 && Number.isNaN(badValue[0].value),
     "a non-numeric value string is still trimmed to a row - it comes out NaN here, "
     + "not 0, because `row.value ?? 0` only replaces null/undefined");
  const dup = trimValues([
    { player: { espnId: 502, name: "first" }, value: 100 },
    { player: { espnId: 502, name: "second" }, value: 200 },
  ]);
  ok(dup.length === 2 && dup[0].espnId === 502 && dup[1].espnId === 502,
     "trimValues does not deduplicate by espnId - that happens one layer up, in "
     + "loadMarket's byEspn map");

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

/* ---- 3. fairness: side sums, the ratio, the sentence ---- */
{
  // Engine-index keyed, which is what a trade side speaks in.
  const M = new Map([
    [IX(0), { value: 100, positionRank: 1 }],
    [IX(1), { value: 100, positionRank: 2 }],
    [IX(2), { value: 50, positionRank: 3 }],
    [IX(3), { value: 30, positionRank: 4 }],
  ]);
  const swap = (a, b) => ({ shape: "1-for-1", sides: [
    { team: "A", sent: a, received: b }, { team: "B", sent: b, received: a }] });

  const sm = sideMarket({ team: "A", sent: [IX(0), IX(2)], received: [IX(1)] }, M);
  ok(sm.sent === 150, "sent sums every outgoing value");
  ok(sm.received === 100, "received sums every incoming value");
  ok(sm.delta === -50, "delta is received minus sent");
  ok(sm.known === true, "known is true when every player is priced");
  ok(sideMarket({ team: "A", sent: [IX(0)], received: [IX(7)] }, M).known === false,
     "one unpriced player makes the side unknown");
  ok(sideMarket({ team: "A", sent: [], received: [] }, M).known === true,
     "an empty package is trivially known");

  const even = tradeFairness(swap([IX(0)], [IX(1)]), M);
  ok(even.known === true, "an all-priced trade is known");
  ok(Math.abs(even.fairness - 1) < 1e-12, "equal packages are fairness 1");
  ok(even.sides.get("A").received === 100 && even.sides.get("B").received === 100,
     "both sides are reported, keyed by team name");

  const two = tradeFairness(swap([IX(0)], [IX(2)]), M);
  ok(Math.abs(two.fairness - 0.5) < 1e-12, "a 2:1 package is fairness 0.5");

  const unknown = tradeFairness(swap([IX(0)], [IX(7)]), M);
  ok(unknown.known === false && unknown.fairness === null,
     "an unpriced player leaves fairness null, not a guess");

  const zeroes = new Map([[IX(0), { value: 0 }], [IX(1), { value: 0 }]]);
  ok(tradeFairness(swap([IX(0)], [IX(1)]), zeroes).fairness === null,
     "two worthless packages have no ratio, not a ratio of 1");

  // A hostile feed value that parses to Infinity (e.g. JSON.parse("1e999")) must not
  // turn into a visible NaN: Infinity/Infinity is NaN, and that has to become a dash.
  const hostile = new Map([[IX(0), { value: Infinity }], [IX(1), { value: Infinity }]]);
  const hostileFairness = tradeFairness(swap([IX(0)], [IX(1)]), hostile);
  ok(hostileFairness.fairness === null,
     "an Infinity value on both sides of a trade yields a dash, not NaN");

  const three = tradeFairness({ shape: "three-way", sides: [
    { team: "A", sent: [IX(0)], received: [IX(1)] },
    { team: "B", sent: [IX(1)], received: [IX(2)] },
    { team: "C", sent: [IX(2)], received: [IX(0)] }] }, M);
  ok(Math.abs(three.fairness - 0.5) < 1e-12, "three sides use the min/max of all three receipts");
  ok(three.sides.size === 3, "every side of a three-way is reported");

  /* The sentence. */
  const P = new Map([[IX(0), { value: 3880 }], [IX(1), { value: 4210 }]]);
  const t = swap([IX(0)], [IX(1)]);
  const line = pitchMarketLine(t, t.sides[0], P);
  ok(line === "By FantasyCalc's crowd values you receive 4,210 and give 3,880 — "
            + "a fair deal by the market (+9%).", `pitch sentence: ${line}`);
  const back = pitchMarketLine(t, t.sides[1], P);
  ok(back === "By FantasyCalc's crowd values you receive 3,880 and give 4,210 — "
            + "a fair deal by the market (−8%).", `pitch sentence, other side: ${back}`);

  const lop = new Map([[IX(0), { value: 100 }], [IX(1), { value: 1000 }]]);
  ok(/lopsided by the market/.test(pitchMarketLine(t, t.sides[0], lop)),
     "a fairness under 0.8 is called lopsided");
  ok(pitchMarketLine(swap([IX(0)], [IX(7)]), t.sides[0], P) === null,
     "an unpriced player omits the sentence entirely");
  ok(pitchMarketLine(t, t.sides[0], null) === null, "no market at all omits the sentence");

  const freebie = new Map([[IX(0), { value: 0 }], [IX(1), { value: 500 }]]);
  ok(pitchMarketLine(t, t.sides[0], freebie)
       === "By FantasyCalc's crowd values you receive 500 and give 0 — "
         + "a fair deal by the market.",
     "giving up nothing priced drops the percentage rather than dividing by zero");

  /* indexMarket is the only bridge from espn ids to engine indices. */
  const byEspn = new Map(trimValues(FC_PAYLOAD).map((r) => [r.espnId, r]));
  const idx = indexMarket(eng, byEspn);
  ok(idx.get(IX(0)).value === 10000, "indexMarket rekeys onto engine indices");
  ok(idx.has(IX(7)) === false, "an unpriced player has no index entry");
  ok(idx.size === 29, "every priced fixture player is bridged");
}

/* ---- 4. arbitrage: model rank vs market rank over one common pool ---- */
{
  // A deliberately small pool: four fixture RBs, two on each of the first two teams,
  // plus two WRs so there is more than one position group. Nothing else is priced,
  // so the candidate pool is exactly these six.
  const RBS = [2, 3, 18, 19];
  const WRS = [6, 22];
  const ppgOf = (id, weeks) => {
    const v = weeks.map((w) => F.proj[id][F.weeks.indexOf(w)]).filter((x) => x > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const byPpg = RBS.slice().sort((a, b) => ppgOf(b, F.weeks) - ppgOf(a, F.weeks));

  // Price the RBs in EXACTLY the reverse of the model's order, and give them
  // FantasyCalc positionRanks 11..14 so that poolRank (1..4) is visibly not the
  // same number as marketRank.
  const M = new Map();
  byPpg.forEach((id, k) => {
    // Reversed against the model: the best projection gets the LEAST market value and
    // the WORST market rank, so the top-projected RB carries the largest possible edge
    // and the bottom-projected one the most negative.
    M.set(IX(id), { value: (k + 1) * 100, positionRank: 10 + (byPpg.length - k),
                    trend30Day: 5, name: `fc${id}`, pos: "RB" });
  });
  WRS.forEach((id, k) => M.set(IX(id), { value: 900 - k * 100, positionRank: 3 + k,
                                         trend30Day: -3, name: `fc${id}`, pos: "WR" }));

  const A = F.teams[0], B = F.teams[1];
  const res = arbitrage(eng, model, M, { myTeam: A, remainingWeeks: F.weeks });

  const all = [...res.buy, ...res.sell];
  ok(all.length === 6, `only priced players are candidates (${all.length} of 160)`);
  ok(all.every((r) => r.owner === A || r.owner === B), "owner is the team that holds him");
  ok(res.sell.every((r) => r.owner === A), "sell only contains my players");
  ok(res.buy.every((r) => r.owner !== A), "buy never contains my players");
  ok(res.buy.length + res.sell.length === 6, "every candidate lands in exactly one list");

  const rb = new Map(all.filter((r) => r.pos === "RB").map((r) => [r.i, r]));
  ok(rb.size === 4, "the RB pool is the four priced RBs");
  ok([...rb.values()].every((r) => r.marketRank >= 11 && r.marketRank <= 14),
     "marketRank passes FantasyCalc's own positionRank through untouched");
  ok([...rb.values()].map((r) => r.poolRank).sort().join(",") === "1,2,3,4",
     "poolRank is dense within the league's own pool");
  ok([...rb.values()].every((r) => r.edge === r.poolRank - r.modelRank),
     "edge is poolRank minus modelRank");

  const best = rb.get(IX(byPpg[0]));
  ok(best.modelRank === 1, "the highest projected RB in the pool is modelRank 1");
  ok(best.poolRank === 4, "…and was priced last, so his poolRank is 4");
  ok(best.edge === 3, "…giving him the largest possible edge in a four-player pool");
  const worst = rb.get(IX(byPpg[3]));
  ok(worst.modelRank === 4 && worst.poolRank === 1 && worst.edge === -3,
     "the lowest projected RB was priced first, giving him the most negative edge");

  const notMine = all.filter((r) => r.owner !== A);
  const mine = all.filter((r) => r.owner === A);
  ok(res.buy[0].edge === Math.max(...notMine.map((r) => r.edge)),
     "buy leads with the most undervalued player who is not mine");
  ok(res.sell[0].edge === Math.min(...mine.map((r) => r.edge)),
     "sell leads with the player the market rates highest against his projection");
  ok(res.buy.every((r, k) => k === 0 || res.buy[k - 1].edge >= r.edge),
     "buy is sorted by descending edge");
  ok(res.sell.every((r, k) => k === 0 || res.sell[k - 1].edge <= r.edge),
     "sell is sorted by ascending edge");

  ok(Math.abs(rb.get(IX(byPpg[0])).ppg - ppgOf(byPpg[0], F.weeks)) < 1e-9,
     "ppg is the mean of the positive weekly projections");
  const late = arbitrage(eng, model, M, { myTeam: A, remainingWeeks: [15, 16, 17] });
  const lateBest = [...late.buy, ...late.sell].find((r) => r.i === IX(byPpg[0]));
  ok(Math.abs(lateBest.ppg - ppgOf(byPpg[0], [15, 16, 17])) < 1e-9,
     "remainingWeeks narrows the window ppg is measured over");

  const capped = arbitrage(eng, model, M, { myTeam: A, remainingWeeks: F.weeks, limit: 2 });
  ok(capped.buy.length <= 2 && capped.sell.length <= 2, "limit caps each list");

  const empty = arbitrage(eng, model, new Map(), { myTeam: A });
  ok(empty.buy.length === 0 && empty.sell.length === 0,
     "an empty market produces empty lists rather than throwing");
  const noWeeks = arbitrage(eng, model, M, { myTeam: A, remainingWeeks: [] });
  ok(noWeeks.buy.length + noWeeks.sell.length === 6,
     "an empty remainingWeeks falls back to the whole season rather than dividing by zero");
  ok([...res.buy, ...res.sell].every((r) => typeof r.trend30Day === "number"),
     "trend30Day rides along for the table");
}

/* ---- 5. the panel module: HTML strings, and a dash for everything on failure ---- */
{
  const storage = mkStorage();
  const fetchImpl = mkFetch({ [FC_URL]: FC_PAYLOAD });
  const logged = [];
  const say = (text, cls = "") => { logged.push({ text, cls }); };

  const loaded = await marketOrNull(SETTINGS, 10, say, { fetchImpl, storage, now: 0 });
  ok(loaded && loaded.byEspn.size === 29, "marketOrNull returns the feed when it answers");
  ok(logged.some((l) => l.text === "FantasyCalc: 29 players priced (1QB, 10 teams, 0.5 PPR)"),
     `the log line names the table that was used: ${JSON.stringify(logged.map((l) => l.text))}`);

  logged.length = 0;
  const dead = await marketOrNull(SETTINGS, 10, say,
    { fetchImpl: deadFetch(), storage: mkStorage(), now: 0 });
  ok(dead === null, "marketOrNull swallows a dead feed and returns null");
  ok(logged.length === 1 && /market values unavailable/.test(logged[0].text),
     "a dead feed logs exactly one line");
  ok(logged[0].cls === "err", "…and logs it as an error");

  /* A feed that accepts the connection and then stalls must not hold up start() -
     marketOrNull has to time out on its own rather than waiting on fetch. */
  logged.length = 0;
  const t0 = Date.now();
  const stuck = await marketOrNull(SETTINGS, 10, say,
    { fetchImpl: stuckFetch(), storage: mkStorage(), now: 0, timeoutMs: 20 });
  const elapsed = Date.now() - t0;
  ok(stuck === null, "a stalled feed resolves to null rather than hanging forever");
  ok(elapsed < 2000, `the timeout actually bounds the wait (took ${elapsed}ms for a 20ms budget)`);
  ok(logged.length === 1 && /market values unavailable/.test(logged[0].text),
     "a timeout is logged the same way any other failed load is");
  ok(logged[0].cls === "err", "…as an error, same as a hard failure");

  /* An empty payload (or one where nothing carries an espnId) is a feed that
     answered with nothing, not a feed that is down - the two must be distinguishable. */
  logged.length = 0;
  const empty = await marketOrNull(SETTINGS, 10, say,
    { fetchImpl: mkFetch({ [FC_URL]: [] }), storage: mkStorage(), now: 0 });
  ok(empty && empty.byEspn.size === 0, "an empty payload is still a successful load");
  ok(logged.some((l) => l.cls === "warn" && /0 players priced/.test(l.text)),
     "…but it is logged as a warning, not a green ok, since nothing was priced");

  /* The stale-cache branch: a live load primes the cache, then the feed goes down
     past the TTL and the caller should get the old data back, flagged stale. */
  const staleStorage = mkStorage();
  await marketOrNull(SETTINGS, 10, () => {},
    { fetchImpl: mkFetch({ [FC_URL]: FC_PAYLOAD }), storage: staleStorage, now: 0 });
  logged.length = 0;
  const stale = await marketOrNull(SETTINGS, 10, say,
    { fetchImpl: deadFetch(), storage: staleStorage, now: 13 * 3600e3 });
  ok(stale && stale.fromCache === true && stale.stale === true,
     "a dead feed past the TTL still returns the last cached copy, marked stale");
  ok(logged.some((l) => /using the last cached copy/.test(l.text)),
     "…and says so, distinct from the normal priced-count line");

  ok(marketView(eng, null) === null, "no feed means no view");
  const mkt = marketView(eng, loaded);
  ok(mkt.byIndex.size === 29 && mkt.priced === 29, "the view carries the index-keyed map");
  ok(mkt.params.numTeams === 10, "…and the parameters, for the section caption");

  const t = { shape: "1-for-1", sides: [
    { team: F.teams[0], sent: [IX(0)], received: [IX(1)] },
    { team: F.teams[1], sent: [IX(1)], received: [IX(0)] }] };
  const unpriced = { shape: "1-for-1", sides: [
    { team: F.teams[0], sent: [IX(0)], received: [IX(7)] },
    { team: F.teams[1], sent: [IX(7)], received: [IX(0)] }] };

  ok(marketFair(t, null) === null, "no feed means no fairness");
  ok(marketFair(unpriced, mkt) === null, "an unpriced player means no fairness");
  ok(marketFair(t, mkt) > 0 && marketFair(t, mkt) <= 1, "fairness is a ratio in (0, 1]");

  ok(/—/.test(marketCell(t, null)), "with no feed the cell is a dash");
  ok(/—/.test(marketCell(unpriced, mkt)), "with an unpriced player the cell is a dash");
  ok(/class="bal"/.test(marketCell(t, mkt)) && /%/.test(marketCell(t, mkt)),
     "a known fairness renders the bar and a percentage");
  ok((marketCell(t, mkt).match(/<td/g) ?? []).length === 1
     && (marketCell(t, null).match(/<td/g) ?? []).length === 1,
     "the cell is exactly one td either way, so the column count never shifts");

  ok(marketCol(null).key === "market" && marketCol(mkt).key === "market", "the column key is stable");
  ok(marketCol(null).value({ t }) === -1, "a dash sorts below every real fairness");
  ok(marketCol(mkt).value({ t }) === marketFair(t, mkt), "the column sorts on the fairness itself");
  ok(typeof marketCol(mkt).hint === "string" && marketCol(mkt).hint.length > 40,
     "the column carries a hint explaining where the numbers come from");

  /* The Market-fair filter chip must not be offered when it cannot work. */
  ok(marketFairChip(null, false) === "", "with no feed the chip renders nothing at all");
  ok(marketFairChip(null, true) === "", "…even if the filter was left pressed from an earlier, healthy run");
  const chip = marketFairChip(mkt, true);
  ok(/data-v="mktfair"/.test(chip), "with a feed the chip keeps its data-v hook");
  ok(/aria-pressed="true"/.test(chip), "…and reflects the pressed state");
  ok(/aria-pressed="false"/.test(marketFairChip(mkt, false)), "…in both directions");

  ok(marketDetail(t.sides[0], null) === "", "no feed adds nothing to the detail panel");
  const det = marketDetail(t.sides[0], mkt);
  ok(/market/.test(det) && /sends/.test(det) && /receives/.test(det),
     `the detail line names both directions: ${det}`);
  ok(/—/.test(marketDetail(unpriced.sides[0], mkt)),
     "an unpriced side shows a dash rather than a partial sum");

  // The color must land on the number whose sign it describes (the delta), not on
  // the always-positive received figure.
  const upSide = { team: F.teams[0], sent: [IX(0)], received: [IX(1)] }; // 10000 -> 9900, a losing delta
  const detUp = marketDetail(upSide, mkt);
  const receivedTag = detUp.match(/receives <b>[\d,]+<\/b>/)?.[0] ?? "";
  ok(receivedTag && !/class=/.test(receivedTag),
     `the received figure itself carries no sign class: ${detUp}`);
  ok(/<b class="(up|down|zero)">/.test(detUp), "…the sign class instead sits on the delta figure");

  ok(marketPitchLine(t, t.sides[0], null) === null, "no feed omits the pitch sentence");
  ok(/FantasyCalc/.test(marketPitchLine(t, t.sides[0], mkt)), "the pitch sentence names the source");

  /* The arbitrage section. `grid` is injected, so the test can see what it is asked
     to render without a DOM. */
  const gridCalls = [];
  const fakeGrid = (id, cols, rows, o) => { gridCalls.push({ id, cols, rows, o }); return `[${id}:${rows.length}]`; };

  const html = arbitrageSection(eng, model, mkt, { myTeam: F.teams[0], grid: fakeGrid });
  ok(html.startsWith("<section") && html.trimEnd().endsWith("</section>"), "the section is one element");
  ok(/Buy low/.test(html) && /sell high/i.test(html), "the section is titled from the spec");
  ok(/ranking/i.test(html), "the hint says it is a ranking comparison, not a value one");
  ok(gridCalls.length === 2 && gridCalls[0].id === "arbBuy" && gridCalls[1].id === "arbSell",
     "two grids, with stable ids so sort state survives a re-render");
  ok(gridCalls[0].cols.length === gridCalls[1].cols.length, "both grids share a column set");
  ok(gridCalls[0].cols.some((c) => c.key === "edge"), "edge is a column");
  ok(gridCalls[0].rows.every((r) => r.owner !== F.teams[0]), "the buy grid holds nobody of mine");
  ok(gridCalls[1].rows.every((r) => r.owner === F.teams[0]), "the sell grid holds only mine");

  /* The row renderer is injected into `grid` as `o.row`. Call it directly with a
     hostile player/owner name - `esc()` is the only thing standing between a
     league's own names and innerHTML. Uses its own fresh grid call rather than
     reusing `gridCalls[0]` from the assertions above: those already asserted other
     things about that same array entry, and depending on that ordering is exactly
     how this would go silently vacuous if the earlier assertions were reshuffled. */
  const escCalls = [];
  const escGrid = (id, cols, rows, o) => { escCalls.push({ id, cols, rows, o }); return `[${id}:${rows.length}]`; };
  arbitrageSection(eng, model, mkt, { myTeam: F.teams[0], grid: escGrid });
  const rowHtml = escCalls[0].o.row({
    i: 0, name: "<script>x</script>", pos: 'RB"><img src=x>', owner: '"><img src=x>',
    ppg: 1.25, modelRank: 1, marketRank: 2, poolRank: 1, edge: 3, value: 1234, trend30Day: -5,
  });
  ok(!/<script>/.test(rowHtml), "a player name cannot inject a tag into the arbitrage row");
  ok(/&lt;script&gt;/.test(rowHtml), "…it is escaped instead");
  ok(!/"><img/.test(rowHtml), "an owner or position name cannot break out of an attribute");
  ok(/&quot;/.test(rowHtml), "…the quote is escaped");
  ok(/data-p="RB&quot;&gt;&lt;img src=x&gt;"/.test(rowHtml),
     "the position lands in data-p, escaped, including inside the attribute value");

  // An explicitly empty remainingWeeks is a real value, not "unset" - `??` would let
  // it through and print "weeks undefined–undefined" in the subtitle.
  const emptyWeeksHtml = arbitrageSection(eng, model, mkt,
    { myTeam: F.teams[0], grid: fakeGrid, remainingWeeks: [] });
  ok(!/undefined/.test(emptyWeeksHtml),
     "an empty remainingWeeks falls back to the full season caption instead of printing undefined");
  ok(/the whole season/.test(emptyWeeksHtml),
     "…specifically, it reads as the whole season");

  gridCalls.length = 0;
  const noFeed = arbitrageSection(eng, model, null, { myTeam: F.teams[0], grid: fakeGrid });
  ok(typeof noFeed === "string" && noFeed.startsWith("<section"),
     "with no feed the section still renders rather than vanishing");
  ok(gridCalls.length === 2 && gridCalls.every((g) => g.rows.length === 0),
     "…with two empty grids");
  ok(gridCalls.every((g) => /unavailable/i.test(g.o.empty)),
     "…and an empty state that says the market is unavailable");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("MARKET OK");
