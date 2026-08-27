/**
 * Kickoff conditions from Open-Meteo: keyless, CORS-open, no attribution header.
 *
 * Only outdoor games are fetched, and only one request per stadium: the visitors
 * play in the same wind as the hosts, so the row is written under both team ids.
 * Domes and retractable roofs are skipped entirely - see `stadiums.js` for why a
 * retractable roof counts as covered.
 *
 * `forecast_days=7` is the shortest window that always reaches next Sunday from a
 * Monday, and `timezone=UTC` makes the hourly timestamps comparable to the ISO
 * kickoff string ESPN returns without any local-time reasoning.
 *
 * Nothing about the league is sent: the URL carries a latitude and a longitude.
 */
import { cached } from "./cache.js";
import { STADIUMS } from "./stadiums.js";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const HOURS3 = 3 * 3600e3;
const CONCURRENCY = 4;
/** Beyond this, the nearest hourly sample is not describing the same game. */
const MAX_OFFSET = 3 * 3600e3;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Open-Meteo omits the zone when `timezone=UTC`; treat a bare timestamp as UTC. */
const parseHour = (t) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(t) ? t : `${t}Z`);

/**
 * The hourly sample nearest kickoff, or null when the forecast does not reach it.
 * @param hourly     Open-Meteo's `hourly` object: parallel arrays keyed by `time`
 * @param kickoffIso ISO timestamp from the ESPN event
 */
export function atKickoff(hourly, kickoffIso) {
  const times = hourly?.time ?? [];
  const t = Date.parse(kickoffIso);
  if (!times.length || !Number.isFinite(t)) return null;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(parseHour(times[i]) - t);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0 || bestD > MAX_OFFSET) return null;
  // Wind is the field every threshold downstream keys on, so a missing wind
  // reading (an hourly array shorter than `time`) makes the whole row unusable -
  // a null here reads downstream as "no weather applied", not "calm and dry".
  // Gust is display-only and precipitation defaults safely to "no rain penalty",
  // so only wind gates the return; num() still zero-fills the other two.
  const wind = hourly.wind_speed_10m?.[best];
  if (!Number.isFinite(Number(wind))) return null;
  return {
    wind: num(wind),
    gust: num(hourly.wind_gusts_10m?.[best]),
    precipProb: num(hourly.precipitation_probability?.[best]),
  };
}

/**
 * @param weekMap one week from `loadVegas`: Map<proTeamId, {home, opp, kickoff}>
 * @param opts    { fetchImpl, storage, now, ttlMs } - injected so tests stay offline
 * @returns Map<proTeamId, {wind, gust, precipProb, kickoff, stadium}>. Both teams in
 *          an outdoor game share one row. A stadium that cannot be fetched is simply
 *          absent, which reads downstream as "no weather adjustment".
 */
export async function loadWeather(weekMap, opts = {}) {
  const ttl = opts.ttlMs ?? HOURS3;
  const jobs = [];
  for (const [teamId, g] of weekMap ?? new Map()) {
    if (!g?.home) continue;                       // one fetch per stadium, not per team
    const st = STADIUMS[teamId];
    if (!st || st.roof !== "open") continue;      // dome or retractable: no weather
    if (!g.kickoff) continue;                     // without a time there is no hour to read
    jobs.push({ teamId, opp: g.opp, st, kickoff: g.kickoff });
  }

  const out = new Map();
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (j) => {
      const url = `${OPEN_METEO}?latitude=${j.st.lat}&longitude=${j.st.lon}`
        + "&hourly=wind_speed_10m,wind_gusts_10m,precipitation_probability"
        + "&forecast_days=7&wind_speed_unit=mph&timezone=UTC";
      try {
        const r = await cached(`src.weather.${j.teamId}`, url, ttl, opts);
        const at = atKickoff(r.data?.hourly, j.kickoff);
        if (!at) return;
        const row = { ...at, kickoff: j.kickoff, stadium: j.st.name };
        out.set(j.teamId, row);
        if (j.opp) out.set(j.opp, row);           // the visitor throws into the same wind
      } catch {
        /* one unreachable stadium is a missing row, not a failed week */
      }
    }));
  }
  return out;
}
