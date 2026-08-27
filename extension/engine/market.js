/**
 * Market fairness: what FantasyCalc's crowd values say about a trade.
 *
 * These numbers are NOT the engine's. The engine scores a trade by the exact change
 * in a team's best possible starting lineup; this file scores the same trade the way
 * the manager on the other side will - by a trade-value chart. The two disagree, and
 * that disagreement is the whole point: it is the edge. Nothing here may be read by
 * the search. It is display and ranking only.
 *
 * `market` throughout is keyed by ENGINE INDEX, not by ESPN player id, because that
 * is what a trade side's `sent` and `received` arrays hold. `indexMarket` is the
 * single bridge, and the only function here that knows what an Engine is.
 */

/** @param byEspn Map<espnId, entry> from `loadMarket`. @returns Map<engineIndex, entry> */
export function indexMarket(eng, byEspn) {
  const m = new Map();
  if (!byEspn) return m;
  for (let i = 0; i < eng.ids.length; i++) {
    const hit = byEspn.get(eng.ids[i]);
    if (hit) m.set(i, hit);
  }
  return m;
}

/**
 * What one side of a trade sends and receives at market.
 *
 * `known` goes false the moment any single player is unpriced. A ratio computed from
 * a partial package is worse than no ratio at all: it silently flatters whichever
 * side the missing player was on.
 */
export function sideMarket(side, market) {
  let sent = 0, received = 0, known = true;
  const add = (ids, onto) => {
    let total = 0;
    for (const i of ids ?? []) {
      const hit = market?.get(i);
      if (!hit) { known = false; continue; }
      total += Number(hit.value) || 0;
    }
    return onto + total;
  };
  sent = add(side.sent, sent);
  received = add(side.received, received);
  return { sent, received, delta: received - sent, known };
}

/**
 * 1 is an even deal. The ratio is the smallest receipt over the largest, so it works
 * unchanged for two sides or three.
 */
export function tradeFairness(trade, market) {
  const sides = new Map();
  let known = true;
  for (const sd of trade.sides) {
    const s = sideMarket(sd, market);
    sides.set(sd.team, s);
    if (!s.known) known = false;
  }
  const recv = [...sides.values()].map((s) => s.received);
  const hi = recv.length ? Math.max(...recv) : 0;
  const lo = recv.length ? Math.min(...recv) : 0;
  // hi === 0 means every priced player in the deal is worth nothing. There is no
  // ratio to take, and reporting 1 ("perfectly even") would be a lie.
  const fairness = known && hi > 0 ? lo / hi : null;
  return { fairness, known, sides };
}

const money = (v) => Math.round(v).toLocaleString("en-US");

/**
 * One sentence for the pitch, written from `other`'s point of view - the manager who
 * has to say yes. Returns null whenever any player in the deal is unpriced, because
 * a half-priced claim about fairness is worse than saying nothing.
 */
export function pitchMarketLine(trade, other, market) {
  if (!market) return null;
  const f = tradeFairness(trade, market);
  if (!f.known || f.fairness == null) return null;
  const s = f.sides.get(other.team);
  if (!s) return null;
  // Giving up nothing priced can never be lopsided against you - there is nothing
  // of yours on the scale to be short-changed on.
  const verdict = !(s.sent > 0) || f.fairness >= 0.8
    ? "a fair deal by the market"
    : "lopsided by the market";
  const head = `By FantasyCalc's crowd values you receive ${money(s.received)} `
    + `and give ${money(s.sent)} — ${verdict}`;
  if (!(s.sent > 0)) return `${head}.`;      // nothing priced going out: no percentage
  const pct = Math.round((s.received / s.sent - 1) * 100);
  return `${head} (${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%).`;
}
