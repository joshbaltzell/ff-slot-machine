/**
 * The platform seam: the registry in engine/platforms/index.js and the normalized
 * model every adapter must emit. RED for 11-02 Task 1 — the registry does not
 * exist yet, so every assertion below is expected to fail on its own claim, not on
 * a module-load crash (the imports are dynamic and caught for that reason).
 * parity.mjs is never touched.
 */
let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };

const tryImport = async (spec) => { try { return await import(spec); } catch { return null; } };

/* registry: engine/platforms/index.js is imported before anything from league.js */
{
  const idx = await tryImport("../engine/platforms/index.js");
  ok(idx !== null, "engine/platforms/index.js imports under Node with no chrome and no DOM");
  ok(typeof idx?.detect === "function", "index.js exports detect");
  ok(typeof idx?.byId === "function", "index.js exports byId");
  ok(Array.isArray(idx?.PLATFORMS) && idx.PLATFORMS.length >= 1, "index.js exports a non-empty PLATFORMS array");
  ok(typeof idx?.hashRosters === "function", "index.js exports hashRosters");

  const r = idx?.detect?.("https://fantasy.espn.com/football/team?leagueId=7&seasonId=2026&teamId=3") ?? null;
  ok(r !== null && r.platform === "espn" && r.leagueId === 7 && r.seasonId === 2026 && r.teamId === 3,
     "detect() on an ESPN team URL returns {platform: espn, leagueId 7, seasonId 2026, teamId 3}");
  ok((idx?.detect?.("https://example.com/") ?? null) === null, "detect() on an unrelated host returns null");

  const espn = idx?.byId?.("espn") ?? null;
  ok(espn !== null && espn.id === "espn" && espn.label === "ESPN", "byId('espn') resolves the ESPN adapter");
  ok((idx?.byId?.("nope") ?? null) === null, "byId('nope') is null");
  ok(espn?.signInUrl?.({}) === "https://fantasy.espn.com", "espn.signInUrl({}) is https://fantasy.espn.com");
  ok(espn?.acceptsToken === false, "espn.acceptsToken is false");
  for (const fn of ["parseLeagueUrl", "loadLeague", "loadFreeAgents", "loadSchedule", "identify", "fingerprint"])
    ok(typeof espn?.[fn] === "function", `espn adapter has ${fn}()`);
  ok(Array.isArray(espn?.hosts) && espn.hosts.includes("https://fantasy.espn.com/*"), "espn.hosts lists fantasy.espn.com");
}

/* league.js still serves the six existing importers (D-04) */
{
  const lg = await tryImport("../engine/league.js");
  ok(lg !== null, "engine/league.js imports after index.js (the other entry order of the cycle)");
  ok(typeof lg?.loadLeague === "function", "league.js re-exports loadLeague");
  ok(typeof lg?.readSettings === "function", "league.js re-exports readSettings");
  ok(typeof lg?.measureVolatility === "function", "league.js keeps measureVolatility");
  ok(lg?.PRO_TEAM?.[28] === "WSH", "league.js keeps PRO_TEAM");
  ok(lg?.SLOT_LABEL?.[23] === "FLEX", "league.js keeps SLOT_LABEL");
  const espnMod = await tryImport("../engine/platforms/espn.js");
  ok(espnMod !== null && lg?.loadLeague === espnMod?.loadLeague, "league.js's loadLeague IS platforms/espn.js's loadLeague");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PLATFORM OK");
