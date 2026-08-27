/**
 * Everything the page renders about market values.
 *
 * It lives here rather than in panel.js so that adding a market column, a filter, a
 * detail line, a pitch sentence and a whole new section costs panel.js one import and
 * eight one-line call sites.
 *
 * Two rules shape this file:
 *   - No `document`, `window` or `chrome` at module load. The tests import it under
 *     node; everything DOM-shaped is a string returned from a function.
 *   - Every export takes the market view and must tolerate `null`. FantasyCalc being
 *     down is the normal case, not an error case, and it shows a dash.
 *
 * `grid` is injected into `arbitrageSection` rather than imported, so this module has
 * no dependency on panel.js and the tables still get the page's sorting and hints.
 */
import { loadMarket } from "../engine/sources/fantasycalc.js";
import { indexMarket, sideMarket, tradeFairness, pitchMarketLine, arbitrage }
  from "../engine/market.js";

const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
const signCls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "zero");
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

export const MARKET_HINT = {
  market: "How even this trade looks on FantasyCalc's crowd values: the smaller side's "
    + "haul divided by the larger, so 100% is a dead-even deal. Those values come from "
    + "real completed trades in thousands of leagues, which makes this the closest thing "
    + "to what the manager on the other side is thinking. It is not our lineup math and "
    + "never feeds the search. A dash means somebody in the deal is unpriced.",
  owner: "Who holds him today. Free agents are in the pool too.",
  arbppg: "Average projection in the weeks left that he actually plays. Byes are "
    + "excluded rather than counted as zero.",
  modelrank: "His rank at his position among every priced player in this league, by "
    + "that projection.",
  marketrank: "FantasyCalc's own published rank at his position, across all of fantasy "
    + "football - shown as they publish it.",
  edge: "How far apart the two rankings are over this league's own pool: his market "
    + "rank here minus his projection rank here. Positive means the crowd rates him "
    + "below what his projection says, so he is the one to ask for. This compares "
    + "RANKS, not value above the player who would otherwise fill the slot.",
  value: "FantasyCalc's trade value for him in this league's shape.",
  trend: "How his value has moved over thirty days. A falling value with a steady "
    + "projection is the cheapest moment to buy.",
};

/**
 * Load the market, or return null. This is the function that keeps a dead feed from
 * costing the user their trade search: it logs one line and gives up.
 */
export async function marketOrNull(settings, teamCount, say = () => {}, opts = {}) {
  try {
    const m = await loadMarket(settings, teamCount, opts);
    const p = m.params;
    say(`FantasyCalc: ${m.byEspn.size} players priced `
      + `(${p.numQbs}QB, ${p.numTeams} teams, ${p.ppr} PPR)`, "ok");
    if (m.stale) say("  FantasyCalc did not answer - using the last cached copy", "");
    return m;
  } catch (err) {
    say(`market values unavailable (${err.message ?? err})`, "err");
    return null;
  }
}

/** Bridge the feed onto engine indices once, at load, rather than per render. */
export function marketView(eng, loaded) {
  if (!loaded) return null;
  return {
    byIndex: indexMarket(eng, loaded.byEspn),
    params: loaded.params,
    priced: loaded.byEspn.size,
  };
}

/** @returns the fairness ratio, or null when the feed is dead or anyone is unpriced. */
export function marketFair(trade, mkt) {
  if (!mkt) return null;
  const f = tradeFairness(trade, mkt.byIndex);
  return f.known ? f.fairness : null;
}

/** A `tradeCols` descriptor. -1 keeps every dash below every real fairness. */
export function marketCol(mkt) {
  return {
    key: "market", label: "Market", num: true, hint: MARKET_HINT.market,
    value: (r) => marketFair(r.t, mkt) ?? -1,
  };
}

/** Exactly one `<td>` either way, so a dead feed never shifts the column count. */
export function marketCell(trade, mkt) {
  const v = marketFair(trade, mkt);
  if (v == null) return '<td class="num"><span class="zero">—</span></td>';
  const p = (v * 100).toFixed(0);
  return `<td><div class="bal"><div class="track"><i style="width:${p}%"></i></div>`
    + `<span class="balpct">${p}%</span></div></td>`;
}

/** One line under a side's point numbers in the expanded detail. */
export function marketDetail(side, mkt) {
  if (!mkt) return "";
  const s = sideMarket(side, mkt.byIndex);
  if (!s.known) return '<span>market <b class="zero">—</b></span>';
  return `<span>market: sends <b>${money(s.sent)}</b> · receives `
    + `<b class="${signCls(s.delta)}">${money(s.received)}</b></span>`;
}

export function marketPitchLine(trade, other, mkt) {
  return mkt ? pitchMarketLine(trade, other, mkt.byIndex) : null;
}

/** Fresh column objects per grid: `grid()` keeps sort state per id, not per column. */
const arbCols = () => [
  { key: "name", label: "Player", value: (r) => r.name },
  { key: "pos", label: "Pos", value: (r) => r.pos },
  { key: "owner", label: "Owner", value: (r) => r.owner, hint: MARKET_HINT.owner },
  { key: "ppg", label: "Proj/wk", num: true, value: (r) => r.ppg, hint: MARKET_HINT.arbppg },
  { key: "modelrank", label: "Model", num: true, value: (r) => r.modelRank, hint: MARKET_HINT.modelrank },
  { key: "marketrank", label: "Market", num: true, value: (r) => r.marketRank, hint: MARKET_HINT.marketrank },
  { key: "edge", label: "Edge", num: true, value: (r) => r.edge, hint: MARKET_HINT.edge },
  { key: "value", label: "Value", num: true, value: (r) => r.value, hint: MARKET_HINT.value },
  { key: "trend", label: "30d", num: true, value: (r) => r.trend30Day, hint: MARKET_HINT.trend },
];

const arbRow = (r) => `<tr>
  <td style="font-weight:600">${esc(r.name)}</td>
  <td><span class="pos" data-p="${esc(r.pos)}">${esc(r.pos)}</span></td>
  <td style="color:var(--dim)">${esc(r.owner)}</td>
  <td class="num">${r.ppg.toFixed(1)}</td>
  <td class="num">${r.modelRank}</td>
  <td class="num">${r.marketRank}</td>
  <td class="num ${signCls(r.edge)}">${signed(r.edge)}</td>
  <td class="num">${money(r.value)}</td>
  <td class="num ${signCls(r.trend30Day)}">${signed(Math.round(r.trend30Day))}</td>
</tr>`;

/** The weeks that are still ahead. Settings are read, never derived. */
function remainingOf(eng, model) {
  const from = Number(model?.settings?.currentWeek) || 1;
  const left = eng.weeks.filter((w) => w >= from);
  return left.length ? left : eng.weeks;
}

/**
 * The buy low / sell high section. Rendered even when the feed is dead - a section
 * that silently disappears is harder to understand than one that says why it is empty.
 */
export function arbitrageSection(eng, model, mkt, opts = {}) {
  const { myTeam = null, grid, limit = 15 } = opts;
  const weeks = opts.remainingWeeks ?? remainingOf(eng, model);
  const res = mkt
    ? arbitrage(eng, model, mkt.byIndex, { myTeam, remainingWeeks: weeks, limit })
    : { buy: [], sell: [] };

  const dead = '<div class="empty"><b>Market values unavailable</b>FantasyCalc did not '
    + 'answer, so there is nothing to compare the projections against.</div>';
  const mk = (id, rows, empty) => grid(id, arbCols(), rows,
    { sort: "edge", dir: id === "arbBuy" ? -1 : 1, empty: mkt ? empty : dead, row: arbRow });

  const buyGrid = mk("arbBuy", res.buy,
    '<div class="empty"><b>Nobody to buy</b>The crowd and the projections agree on every '
    + 'priced player outside your roster.</div>');
  const sellGrid = mk("arbSell", res.sell,
    '<div class="empty"><b>Nobody to sell</b>The market does not rate anyone on your '
    + 'roster above what his projection says.</div>');

  const caption = mkt
    ? `FantasyCalc ${mkt.params.numQbs}QB · ${mkt.params.numTeams} teams · `
      + `${mkt.params.ppr} PPR · ${mkt.priced} players priced`
    : "FantasyCalc unavailable";
  const window = weeks.length === eng.weeks.length
    ? "the whole season" : `weeks ${weeks[0]}–${weeks.at(-1)}`;

  return `<section>
    <h2 class="secttl">Buy low / sell high (market vs projection)</h2>
    <p class="sectsub">Two rankings of the same players: ours, by projected points per
      week over ${esc(window)}, and FantasyCalc's, from real completed trades. Where they
      disagree is where a deal is available. This compares <b>ranks</b>, not value above
      the player who would otherwise fill the slot — a bench player the crowd underrates
      is still a bench player.</p>
    <div class="panel">
      <div class="bar"><div class="fld"><label>Buy low</label></div>
        <span class="readout" style="color:var(--faint)">Not yours · the market ranks
          them below your projections</span></div>
      ${buyGrid}
    </div>
    <div class="panel" style="margin-top:14px">
      <div class="bar"><div class="fld"><label>Sell high</label></div>
        <span class="readout" style="color:var(--faint)">Yours · the market ranks them
          above your projections. ${esc(caption)}</span></div>
      ${sellGrid}
    </div>
  </section>`;
}
