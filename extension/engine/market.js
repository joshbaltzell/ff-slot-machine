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
  const add = (ids) => {
    let total = 0;
    for (const i of ids ?? []) {
      const hit = market?.get(i);
      if (!hit) { known = false; continue; }
      total += Number(hit.value) || 0;
    }
    return total;
  };
  sent = add(side.sent);
  received = add(side.received);
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
  // ratio to take, and reporting 1 ("perfectly even") would be a lie. A non-finite
  // feed value (e.g. a huge or malformed number JSON parses as Infinity) can make
  // `hi` non-finite too, and Infinity/Infinity is NaN - guard it to a dash instead.
  const ratio = known && hi > 0 ? lo / hi : null;
  const fairness = Number.isFinite(ratio) ? ratio : null;
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

/**
 * Where the crowd and the projection disagree.
 *
 * Two rankings over ONE population: every rostered player plus the usable free-agent
 * pool, restricted to the ones FantasyCalc has priced. Within each position label,
 * `modelRank` orders that pool by projected points per game over the weeks that are
 * left; `poolRank` orders the same pool by FantasyCalc value. The difference is the
 * disagreement.
 *
 * Why not FantasyCalc's own `positionRank` in the subtraction: it ranks every
 * fantasy-relevant player in football, while the model ranks only the couple of
 * hundred in this league. Subtracting one from the other measures position depth,
 * not disagreement - every player would carry a large positive number. `marketRank`
 * carries the published rank for display; `poolRank` is what the arithmetic uses.
 *
 * This is a RANKING comparison, not a value comparison. It says nothing about how
 * much a player is worth above the replacement the slot would otherwise hold - that
 * is Phase 4. The hint in the panel says so.
 */
export function arbitrage(eng, model, market, opts = {}) {
  const { myTeam = null, limit = 15 } = opts;
  const asked = opts.remainingWeeks;
  const fallback = eng.weeks;
  const weeks = (Array.isArray(asked) && asked.length) ? asked : fallback;
  // Column offsets into eng.proj for the weeks we care about, skipping any week the
  // caller named that this engine does not carry.
  const cols = weeks.map((w) => eng.weeks.indexOf(w)).filter((k) => k >= 0);
  const use = cols.length ? cols : eng.weeks.map((_, k) => k);

  const ppg = (i) => {
    let s = 0, n = 0;
    for (const k of use) {
      const v = eng.proj[i * eng.NW + k];
      if (v > 0) { s += v; n++; }             // a bye is not a bad game, it is no game
    }
    return n ? s / n : 0;
  };

  const ownerOf = new Map();
  for (const t of eng.teams) for (const i of eng.roster.get(t)) ownerOf.set(i, t);

  const rows = [];
  const seen = new Set();
  const consider = (i) => {
    if (seen.has(i)) return;
    seen.add(i);
    const hit = market?.get(i);
    // No price, or no positional rank, means no market opinion to disagree with.
    if (!hit || !(Number(hit.positionRank) > 0)) return;
    const p = model.players.get(eng.ids[i]);
    if (!p) return;
    rows.push({
      i, name: p.name, pos: p.pos, owner: ownerOf.get(i) ?? "free agent",
      ppg: ppg(i), modelRank: 0, poolRank: 0, edge: 0,
      marketRank: Number(hit.positionRank),
      value: Number(hit.value) || 0,
      trend30Day: Number(hit.trend30Day) || 0,
    });
  };
  for (const t of eng.teams) for (const i of eng.roster.get(t)) consider(i);
  for (const i of eng.freeAgents) consider(i);

  const byPos = new Map();
  for (const r of rows) {
    if (!byPos.has(r.pos)) byPos.set(r.pos, []);
    byPos.get(r.pos).push(r);
  }
  for (const list of byPos.values()) {
    // Ties break by name so two runs on the same data give the same list.
    list.slice().sort((a, b) => b.ppg - a.ppg || a.name.localeCompare(b.name))
      .forEach((r, k) => { r.modelRank = k + 1; });
    list.slice().sort((a, b) => a.marketRank - b.marketRank || a.name.localeCompare(b.name))
      .forEach((r, k) => { r.poolRank = k + 1; });
  }
  for (const r of rows) r.edge = r.poolRank - r.modelRank;

  const buy = rows.filter((r) => r.owner !== myTeam)
    .sort((a, b) => b.edge - a.edge || b.ppg - a.ppg || a.name.localeCompare(b.name))
    .slice(0, limit);
  const sell = rows.filter((r) => r.owner === myTeam)
    .sort((a, b) => a.edge - b.edge || b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { buy, sell };
}
