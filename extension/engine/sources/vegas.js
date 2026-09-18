/**
 * Betting lines from ESPN's own core API: keyless, CORS-open, and already the same
 * team ids the fantasy API uses.
 *
 * Why the market at all: a projection is an average over a distribution of games,
 * and the closing line is the sharpest public estimate of the *specific* game a
 * player is about to play. A team implied for 28 points and a team implied for 16
 * do not deserve the same projection, however well-matched their season averages.
 *
 * One request per week, in a fixed shape:
 *   .../scoreboard?week={w}&seasontype=2  -> { events: [{ competitions: [{ date,
 *                                              competitors: [{ homeAway, id, team }],
 *                                              odds: [{ provider, overUnder, spread,
 *                                                       homeTeamOdds }] }] }] }
 *
 * This used to be three requests per game against the core API - a week index, then
 * an event body, then an odds body reachable only through a `$ref` inside that body,
 * so fifteen games cost thirty-one requests and roughly eight serial round trips.
 * The scoreboard route carries every game's line inline, which is the same data in
 * one request: measured 16 events, 15 priced. That was 63% of the whole run's request
 * count, spent on a clamped [0.6, 1.4] multiplier over two weeks.
 *
 * `buildWeek` did not have to change for it. It already read a competitor's id as
 * `refId(team.$ref) ?? Number(id)`, and on this route `competitor.id` is the pro-team
 * id - so the fallback that existed for robustness turned out to be the whole adapter.
 *
 * One difference worth knowing: the core API quoted several books and this route
 * quotes one (DraftKings, provider 100), so `PREFERRED_PROVIDER` no longer matches
 * and `pickOdds` takes its documented fallback - the first row carrying a total.
 *
 * Everything is cached for three hours, so a page reload during a Sunday morning
 * costs nothing, and a line that moves at noon is picked up by the afternoon.
 *
 * Nothing about the league is sent: the URLs carry a season, a week and public
 * event ids.
 */
import { cached } from "./cache.js";

export const VEGAS_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const HOURS3 = 3 * 3600e3;

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

/**
 * One week of games, each with its odds array hoisted to where `buildWeek` looks for
 * it. A single request; a week ESPN has not priced yet simply yields no usable rows.
 */
async function fetchWeekEvents(season, week, opts) {
  const ttl = opts.ttlMs ?? HOURS3;
  const url = `${VEGAS_BASE}/scoreboard?week=${week}&seasontype=2&dates=${season}`;
  const board = await cached(`src.vegas.board.${season}.${week}`, url, ttl, opts);
  // `odds` lives on the competition here rather than behind a $ref. Hoisting it onto
  // the event is the whole translation: buildWeek reads `ev.odds` and `ev.competitions`.
  return (board.data?.events ?? []).map((ev) => ({
    ...ev, odds: ev.competitions?.[0]?.odds ?? [],
  }));
}

/**
 * @param season ESPN season year
 * @param weeks  NFL weeks to price, normally [currentWeek, currentWeek + 1]
 * @param opts   { fetchImpl, storage, now, ttlMs } - injected so tests stay offline
 * @returns Map<week, Map<proTeamId, Game>>. A week that cannot be fetched is an
 *          empty map, never a rejection: no lines must read as no adjustment.
 *
 * The weeks are fetched concurrently and written back in `weeks` order, so the Map's
 * iteration order is the caller's order however the network resolves.
 */
export async function loadVegas(season, weeks, opts = {}) {
  const built = await Promise.all((weeks ?? []).map(async (w) => {
    try {
      return buildWeek(await fetchWeekEvents(season, w, opts));
    } catch {
      return new Map();
    }
  }));
  const byWeek = new Map();
  (weeks ?? []).forEach((w, i) => byWeek.set(w, built[i]));
  return byWeek;
}
