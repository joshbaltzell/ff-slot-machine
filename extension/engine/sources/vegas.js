/**
 * Betting lines from ESPN's own core API: keyless, CORS-open, and already the same
 * team ids the fantasy API uses.
 *
 * Why the market at all: a projection is an average over a distribution of games,
 * and the closing line is the sharpest public estimate of the *specific* game a
 * player is about to play. A team implied for 28 points and a team implied for 16
 * do not deserve the same projection, however well-matched their season averages.
 *
 * Three requests per game, in a fixed shape:
 *   .../seasons/{yr}/types/2/weeks/{w}/events   -> { items: [{ $ref }] }
 *   {event $ref}                                -> competitions[0] with competitors
 *   {competition odds $ref}                     -> { items: [{ provider, overUnder,
 *                                                   spread, homeTeamOdds }] }
 * Everything is cached for three hours, so a page reload during a Sunday morning
 * costs nothing, and a line that moves at noon is picked up by the afternoon.
 *
 * Nothing about the league is sent: the URLs carry a season, a week and public
 * event ids.
 */
import { cached } from "./cache.js";

export const VEGAS_BASE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
const HOURS3 = 3 * 3600e3;
const CONCURRENCY = 4;

/** ESPN BET. Any priced book is usable; this one is the house default and is always there. */
export const PREFERRED_PROVIDER = 58;

/** The trailing integer of a core-API `$ref`, e.g. ".../teams/12?lang=en" -> 12. */
export function refId(ref) {
  const m = String(ref ?? "").match(/\/(\d+)(?:\?|$)/);
  return m ? Number(m[1]) : null;
}

/**
 * Split an over/under into two team totals using the spread.
 *
 * The favourite's share is half the total plus half the spread; the underdog's is
 * half the total minus half the spread. The sign of the spread is ignored here -
 * which side is the favourite is decided by the caller, from `homeTeamOdds`.
 */
export function impliedTotals(overUnder, spread) {
  const ou = Number(overUnder);
  if (!(ou > 0)) return null;
  const s = Math.abs(Number(spread) || 0);
  return { favorite: (ou + s) / 2, underdog: (ou - s) / 2 };
}

/** The odds row to trust: ESPN BET when present, else the first row that has a total. */
export function pickOdds(items) {
  const usable = (items ?? []).filter((it) => Number(it?.overUnder) > 0);
  if (!usable.length) return null;
  return usable.find((it) => Number(it?.provider?.id) === PREFERRED_PROVIDER) ?? usable[0];
}

/**
 * One week of events (each with an `odds` array attached) -> Map keyed by proTeamId.
 *
 * Pure, so the shape of ESPN's payload can be tested without a network. A game
 * without a usable line is left out entirely rather than defaulted: an absent row
 * means "no adjustment", and a zero would mean "this offence will not score".
 */
export function buildWeek(events) {
  const out = new Map();
  for (const ev of events ?? []) {
    const comp = ev?.competitions?.[0];
    if (!comp) continue;
    const home = (comp.competitors ?? []).find((c) => c.homeAway === "home");
    const away = (comp.competitors ?? []).find((c) => c.homeAway === "away");
    const homeId = refId(home?.team?.$ref) ?? (Number(home?.id) || null);
    const awayId = refId(away?.team?.$ref) ?? (Number(away?.id) || null);
    if (!homeId || !awayId) continue;

    const row = pickOdds(ev.odds);
    const split = row ? impliedTotals(row.overUnder, row.spread) : null;
    if (!split) continue;

    // Which side is favoured. The flags are authoritative when present; otherwise
    // ESPN quotes the spread from the home team's point of view, so a negative
    // number means the home team is laying points.
    const homeFav = row.homeTeamOdds?.favorite === true ? true
      : row.awayTeamOdds?.favorite === true ? false
      : Number(row.spread) <= 0;

    const homeImplied = homeFav ? split.favorite : split.underdog;
    const awayImplied = homeFav ? split.underdog : split.favorite;
    const total = Number(row.overUnder);
    const spread = Math.abs(Number(row.spread) || 0);
    const kickoff = comp.date ?? ev.date ?? null;

    out.set(homeId, { implied: homeImplied, opp: awayId, oppImplied: awayImplied,
                      total, spread, home: true, kickoff });
    out.set(awayId, { implied: awayImplied, opp: homeId, oppImplied: homeImplied,
                      total, spread, home: false, kickoff });
  }
  return out;
}

/** Events for one week, each with its odds rows attached. One dead game is skipped. */
async function fetchWeekEvents(season, week, opts) {
  const ttl = opts.ttlMs ?? HOURS3;
  const list = await cached(`src.vegas.list.${season}.${week}`,
    `${VEGAS_BASE}/seasons/${season}/types/2/weeks/${week}/events`, ttl, opts);
  const refs = (list.data?.items ?? []).map((it) => it.$ref).filter(Boolean);

  const events = [];
  for (let i = 0; i < refs.length; i += CONCURRENCY) {
    const batch = await Promise.all(refs.slice(i, i + CONCURRENCY).map(async (ref) => {
      const id = refId(ref);
      try {
        const ev = await cached(`src.vegas.ev.${id}`, ref, ttl, opts);
        const comp = ev.data?.competitions?.[0];
        if (!comp) return null;
        // No odds $ref means ESPN has not posted a line for this game at all - not
        // "fetch failed", just nothing to fetch. Guessing a URL here would mean
        // re-attempting (and re-failing) the same request every load, forever
        // outside the TTL cache, since a failed fetch is never itself cached.
        const oddsRef = comp.odds?.$ref;
        const odds = oddsRef ? await cached(`src.vegas.odds.${id}`, oddsRef, ttl, opts) : null;
        return { ...ev.data, odds: odds?.data?.items ?? [] };
      } catch {
        return null;          // one unpriced or unreachable game is not a dead week
      }
    }));
    events.push(...batch);
  }
  return events.filter(Boolean);
}

/**
 * @param season ESPN season year
 * @param weeks  NFL weeks to price, normally [currentWeek, currentWeek + 1]
 * @param opts   { fetchImpl, storage, now, ttlMs } - injected so tests stay offline
 * @returns Map<week, Map<proTeamId, Game>>. A week that cannot be fetched is an
 *          empty map, never a rejection: no lines must read as no adjustment.
 */
export async function loadVegas(season, weeks, opts = {}) {
  const byWeek = new Map();
  for (const w of weeks) {
    try {
      byWeek.set(w, buildWeek(await fetchWeekEvents(season, w, opts)));
    } catch {
      byWeek.set(w, new Map());
    }
  }
  return byWeek;
}
