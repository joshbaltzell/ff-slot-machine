/** Tests for the source layer: cache semantics and the Sleeper client, offline. */
import { cached } from "../engine/sources/cache.js";
import { loadSleeperPlayers, loadTrending, trimPlayers } from "../engine/sources/sleeper.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };

const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; }, async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const mkFetch = (table) => { const calls = []; const f = async (url) => { calls.push(url);
  const hit = table[url]; if (!hit) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; }; f.calls = calls; return f; };

/* cache */
{
  const storage = mkStorage();
  const fetchImpl = mkFetch({ "u": { a: 1 } });
  const r1 = await cached("k", "u", 1000, { fetchImpl, storage, now: 0 });
  ok(r1.data.a === 1 && r1.fromCache === false, "cold cache fetches");
  const r2 = await cached("k", "u", 1000, { fetchImpl, storage, now: 500 });
  ok(r2.fromCache === true && fetchImpl.calls.length === 1, "fresh cache does not refetch");
  const r3 = await cached("k", "u", 1000, { fetchImpl, storage, now: 1500 });
  ok(r3.fromCache === false && fetchImpl.calls.length === 2, "stale cache refetches");
  const dead = mkFetch({});
  const r4 = await cached("k", "u", 1000, { fetchImpl: dead, storage, now: 3000 });
  ok(r4.stale === true && r4.data.a === 1, "failed refetch returns the stale copy, flagged");
  let threw = false;
  try { await cached("none", "u", 1000, { fetchImpl: dead, storage: mkStorage(), now: 0 }); } catch { threw = true; }
  ok(threw, "failed fetch with no cache throws");
  const t = await cached("t", "u", 1000, { fetchImpl, storage, now: 0, transform: (x) => x.a + 1 });
  ok(t.data === 2, "transform is applied before caching");
  const txt = await cached("x", "u", 1000, { fetchImpl: mkFetch({ u: "a,b" }), storage, now: 0, parse: "text" });
  ok(txt.data === "a,b", "text parse");
}

/* sleeper */
{
  const raw = {
    "1": { player_id: "1", espn_id: "3139477", full_name: "A", position: "QB", team: "KC", injury_status: "Questionable",
           practice_participation: "LP", useless: "x" },
    "2": { player_id: "2", full_name: "no espn id" },
    "3": { player_id: "3", espn_id: 4242335, full_name: "B", position: "RB", team: "SF", injury_status: null },
  };
  const trimmed = trimPlayers(raw);
  ok(trimmed.length === 2, "players without an espn id are dropped");
  ok(!("useless" in trimmed[0]), "unknown fields are trimmed");
  ok(trimmed[0].espn_id === 3139477, "espn_id is numeric");
  const storage = mkStorage();
  const fetchImpl = mkFetch({ "https://api.sleeper.app/v1/players/nfl": raw,
    "https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50": [{ player_id: "1", count: 900 }] });
  const s = await loadSleeperPlayers({ fetchImpl, storage, now: 0 });
  ok(s.byEspn.get(3139477)?.injury_status === "Questionable", "lookup by espn id");
  ok(s.bySleeper.get("3")?.espn_id === 4242335, "lookup by sleeper id");
  ok(JSON.stringify(storage._m.get("src.sleeper.players").data).length < JSON.stringify(raw).length, "cached copy is trimmed");
  const tr = await loadTrending("add", { fetchImpl, storage, now: 0 });
  ok(tr[0].count === 900, "trending adds");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("SOURCES OK");
