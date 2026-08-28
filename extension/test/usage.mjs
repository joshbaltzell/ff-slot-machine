/**
 * Tests for Phase 6 (usage): the Sleeper weekly stats feed, the usage arithmetic,
 * the sell-high / buy-low selection, breakouts, the crowd split, FAAB bids and the
 * panel helpers - all offline, with fetch, storage and the clock injected.
 *
 *   node extension/test/usage.mjs
 */
import { weekUrl, trimStats, loadWeekStats, loadSeasonStats, STAT_FIELDS }
  from "../engine/sources/sleeperstats.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const near = (a, b, e = 1e-9) => a != null && Math.abs(a - b) <= e;

/* Injection helpers, same shape as sources.mjs and market.mjs. */
const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; }, async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const mkFetch = (table) => { const calls = []; const f = async (url) => { calls.push(url);
  const hit = table[url]; if (!hit) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; }; f.calls = calls; return f; };
const deadFetch = () => { const f = async () => { throw new Error("network down"); }; f.calls = []; return f; };
const stuckFetch = () => { const f = () => new Promise(() => {}); f.calls = []; return f; };

/* ---- 1. the Sleeper weekly stats feed ---- */
{
  const url = weekUrl(2026, 3);
  ok(url === "https://api.sleeper.app/stats/nfl/2026/3?season_type=regular"
     + "&position[]=QB&position[]=RB&position[]=WR&position[]=TE",
     "the week URL is built exactly as the spec names it");

  const arrForm = [
    { player_id: "s1", team: "AAA",
      stats: { off_snp: 54, tm_off_snp: 60, rec_tgt: 16, pts_ppr: 20, junk: 9 } },
    { player: { player_id: "s2", team: "BBB" }, stats: { off_snp: 30, tm_off_snp: 60 } },
    { player_id: "s3", stats: {} },
  ];
  const a = trimStats(arrForm);
  ok(a.length === 2, "an entry with no usable stat is dropped");
  ok(a[0].player_id === "s1" && a[0].off_snp === 54 && a[0].team === "AAA",
     "the array shape is read, with the team carried");
  ok(!("junk" in a[0]), "unknown fields are trimmed away");
  ok(a[1].player_id === "s2" && a[1].team === "BBB",
     "a nested player object supplies the id and the team");

  const mapForm = { s1: { off_snp: 54, tm_off_snp: 60, rec_tgt: 16, junk: 1 },
                    s2: { stats: { off_snp: 30 }, team: "BBB" } };
  const b = trimStats(mapForm);
  ok(b.length === 2 && b[0].player_id === "s1" && b[0].rec_tgt === 16,
     "the object-map shape reads the same, so a feed reshape does not empty the table");
  ok(b[1].team === "BBB" && b[1].off_snp === 30,
     "…including when the map's value nests its stats");
  ok(trimStats(null).length === 0 && trimStats(undefined).length === 0,
     "a null payload trims to nothing rather than throwing");
  ok(STAT_FIELDS.includes("off_snp") && STAT_FIELDS.includes("tm_off_snp")
     && STAT_FIELDS.includes("rec_air_yd") && STAT_FIELDS.includes("pass_att"),
     "the trimmed field list carries everything the usage math reads");

  const table = {};
  for (let w = 1; w <= 4; w++) table[weekUrl(2026, w)] = arrForm;
  delete table[weekUrl(2026, 3)];                       // week 3 is a 404
  const fetchImpl = mkFetch(table);
  const storage = mkStorage();
  const s = await loadSeasonStats(2026, 5, { fetchImpl, storage, now: 0 });
  ok(JSON.stringify(s.weeks) === "[1,2,4]", "every played week before the current one is fetched");
  ok(JSON.stringify(s.failed) === "[3]", "a week that fails is reported, not thrown");
  ok(s.byWeek.get(1).get("s1").off_snp === 54, "rows come back keyed by sleeper id");
  ok(fetchImpl.calls.length === 4, "one call per played week");

  // The most recent played week gets a six-hour TTL; older weeks are done and get a
  // week. Same cache key either way, so the TTL is the only thing that changes.
  const st2 = mkStorage();
  const f2 = mkFetch(table);
  await loadSeasonStats(2026, 5, { fetchImpl: f2, storage: st2, now: 0 });
  ok(f2.calls.length === 4, "the cold run makes one call per played week");
  const again = await loadSeasonStats(2026, 5, { fetchImpl: f2, storage: st2, now: 12 * 3600e3 });
  ok(again.byWeek.has(1) && again.byWeek.has(4), "both weeks still resolve half a day later");
  ok(f2.calls.length === 6,
     "…and half a day later only two calls go out: the six-hour week 4, and week 3, "
     + "which failed and so has no cache to be fresh");
  ok(!f2.calls.slice(4).includes(weekUrl(2026, 1)),
     "a finished week is not refetched inside its seven-day life");

  const s0 = await loadSeasonStats(2026, 1, { fetchImpl: mkFetch({}), storage: mkStorage(), now: 0 });
  ok(s0.weeks.length === 0 && s0.failed.length === 0,
     "before week 2 there is nothing played, and nothing is fetched");

  const dead = deadFetch();
  const sd = await loadSeasonStats(2026, 5, { fetchImpl: dead, storage: mkStorage(), now: 0 });
  ok(sd.byWeek.size === 0 && sd.failed.length === 4,
     "a dead feed yields an empty table and four reported failures, never a throw");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("USAGE OK");
