/**
 * Everything the page renders about usage.
 *
 * Two rules shape this file, the same two that shape panel/market.js:
 *   - No `document`, `window` or `chrome` at module load. The tests import it under
 *     node; everything DOM-shaped is a string returned from a function.
 *   - Every export takes the usage view and must tolerate `null`. Sleeper's stats
 *     feed being down is a normal case, not an error case, and it shows a dash.
 *
 * `grid` is injected rather than imported, so this module has no dependency on
 * panel.js and the tables still get the page's sorting and hints.
 *
 * Everything here is evidence. No number computed in this file or the two engine
 * modules behind it is read by the trade search, the lineup solver, the season
 * simulation or the odds.
 */
import { defaultStorage } from "../engine/sources/cache.js";
import { loadSleeperPlayers, loadTrending } from "../engine/sources/sleeper.js";
import { loadSeasonStats } from "../engine/sources/sleeperstats.js";
import { usageTable, assetRows, breakouts, depthChanges, crowdSplit, bestOfferFor, USAGE_K }
  from "../engine/usage.js";
import { faabBids } from "../engine/faab.js";

const DEPTH_KEY = "ffsm.depth";

const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pctOrDash = (v, d = 0) => (v == null ? '<span class="zero">—</span>' : `${(v * 100).toFixed(d)}%`);
const numOrDash = (v, d = 2) => (v == null ? '<span class="zero">—</span>' : Number(v).toFixed(d));
const signCls = (n) => (n == null ? "zero" : n > 0 ? "up" : n < 0 ? "down" : "zero");

/**
 * Sort keys have to be numbers for `grid`'s numeric compare, and a null is not one.
 * `-1` is the market module's sentinel because every value it sinks is a rank or a
 * ratio; here `tdOver` and the residual are genuinely negative, so the sentinel has
 * to sit below anything real rather than below zero. Two rows both holding it compare
 * equal, which leaves `grid`'s stable fallback to order them.
 */
const SINK = -1e9;
const sortNum = (v) => (v == null || !Number.isFinite(Number(v)) ? SINK : Number(v));

/** Signed percentage points, for a difference of two shares. */
const signPctOrDash = (v) => (v == null ? '<span class="zero">—</span>'
  : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(0)}`);

export const USAGE_HINT = {
  snap: "Share of his own team's offensive snaps over the last four weeks he played. "
    + "Snaps arrive before points do: a share that is climbing is a role being handed over.",
  tgt: "Share of his team's targets over the same weeks - his slice of the passing game.",
  wopr: "Weighted Opportunity Rating: 1.5 x target share + 0.7 x air-yard share. One "
    + "number for how much of the passing offence runs through him, weighted the way "
    + "the published measure weights it. Runners are measured on carries plus targets "
    + "instead, and passers on dropbacks.",
  tdover: "Touchdowns scored minus touchdowns expected from his carries and targets at "
    + "league-average rates. A big positive number is the oldest sell-high signal there "
    + "is: touchdown rate regresses and opportunity does not. Passers have no figure "
    + "here - this feed carries no passing touchdowns.",
  resid: "Points per game minus what a straight line through everyone at his position "
    + "predicts from his usage. Positive means he is doing more with the ball than the "
    + "field does; negative means the usage is there and the points have not arrived.",
  offer: "The best deal the search already found that moves him, and what it does to "
    + "your lineup. This joins to the trade list; it never changes it.",
  trend: "Snap share over the last two weeks minus the two before. Above 15 points is "
    + "a role changing rather than a game script.",
  depth: "Where Sleeper's depth chart has him, and how far he has moved since the last "
    + "time this page saw the file. Blank until it has seen the file twice.",
  crowd: "How many Sleeper leagues added him in the last 24 hours. High means you will "
    + "not be the only claim; low means he is free.",
  bid: "A suggested FAAB bid: this add's share of the top five adds' gains, times what "
    + "is left of your budget, times an urgency multiplier from the crowd - rounded to "
    + "end in 1 or 6 so a tie against a round number goes your way. The second figure "
    + "is the most it is worth, where his remaining-season points per dollar meet the "
    + "field's rate. A HEURISTIC, not an auction model, and never part of the search.",
};

/**
 * Load usage, or return null. Bounded by a timeout for the same reason marketOrNull
 * is: `cached()` passes no AbortSignal and `fetch` has no default timeout, so a host
 * that accepts the connection and stalls would hold start() until the socket gave up.
 * This step makes up to seventeen requests rather than one, hence 15s.
 */
export async function usageOrNull(model, seasonId, say = () => {}, opts = {}) {
  const currentWeek = Number(model?.settings?.currentWeek) || 1;
  if (currentWeek <= 1) {
    say("no games played yet - usage signals need a week of snaps", "");
    return null;
  }
  let timer;
  const timeout = (ms) => new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`no answer in ${ms / 1000}s`)), ms);
  });
  try {
    const work = (async () => {
      // The players file is already cached from the injury step; this second call
      // costs a storage read, not a request, and keeps panel.js from having to thread
      // the crosswalk through a block another phase owns.
      const players = await loadSleeperPlayers(opts);
      const stats = await loadSeasonStats(seasonId, currentWeek, opts);
      if (!stats.byWeek.size) throw new Error("no weekly stats");
      // The crowd is the least important of the three and must not take the rest down.
      // It is also the one failure the single `live` flag downstream cannot express:
      // by the time the view is built, "trending answered with nothing" and "trending
      // did not answer" look identical, and they are different claims. So the outcome
      // is recorded here, where it is still known.
      let trending = [], crowdLive = true;
      try { trending = await loadTrending("add", opts); }
      catch (e) {
        crowdLive = false;
        say(`  crowd adds unavailable (${e.message ?? e})`, "");
      }
      return { players, stats, trending, crowdLive };
    })();
    const got = await Promise.race([work, timeout(opts.timeoutMs ?? 15000)]);
    clearTimeout(timer);
    say(`usage: ${got.stats.weeks.length} played weeks of snaps and targets`
      + `${got.stats.failed.length ? `, ${got.stats.failed.length} week(s) missing` : ""}`, "ok");
    return got;
  } catch (err) {
    clearTimeout(timer);
    say(`usage signals unavailable (${err.message ?? err})`, "err");
    return null;
  }
}

/** Pure: everything the sections read, with no storage in sight. */
export function usageView(model, loaded, currentWeek, memo = null) {
  if (!loaded) return null;
  const { players, stats, trending } = loaded;
  const table = usageTable(model, { byWeek: stats.byWeek, bySleeper: players.bySleeper },
                           currentWeek);
  const crowdByEspn = new Map();
  for (const t of trending ?? []) {
    const p = players.bySleeper.get(String(t.player_id));
    if (p?.espn_id != null) crowdByEspn.set(Number(p.espn_id), Number(t.count) || 0);
  }
  const d = depthChanges(players.bySleeper, players.at, memo);
  // Absent means "nobody said otherwise", which is the right default for a caller
  // handing in a payload it assembled itself rather than one `usageOrNull` produced.
  return { table, crowdByEspn, depth: d.delta, memo: d.memo,
           weeks: stats.weeks, failed: stats.failed, at: players.at,
           crowdLive: loaded.crowdLive ?? true };
}

/** The same view, with the depth-chart memo read and written. */
export async function usageViewStored(model, loaded, currentWeek, say = () => {}, opts = {}) {
  if (!loaded) return null;
  const storage = opts.storage ?? defaultStorage();
  let memo = null;
  try { memo = (await storage.get(DEPTH_KEY))[DEPTH_KEY] ?? null; } catch { memo = null; }
  const view = usageView(model, loaded, currentWeek, memo);
  try { await storage.set({ [DEPTH_KEY]: view.memo }); } catch { /* a memo is a nicety */ }
  say(`  usage measured for ${view.table.rows.size} players`
    + `${view.depth.size ? `, ${view.depth.size} depth-chart moves` : ""}`, "ok");
  return view;
}

/** espnId -> team name, straight off the engine's rosters. Absent means free agent. */
export function ownersOf(eng) {
  const m = new Map();
  for (const t of eng.teams) for (const i of eng.roster.get(t)) m.set(eng.ids[i], t);
  return m;
}

/* ---------------------------------------------------------------- assets and targets */

/**
 * Fresh column objects per grid: `grid()` keeps sort state per id, not per column.
 *
 * The sell grid carries no owner column because every row in it is mine - a column
 * with one repeated value is a column that costs width and says nothing.
 */
const assetCols = (kind) => [
  { key: "name", label: "Player", value: (r) => r.name },
  { key: "pos", label: "Pos", value: (r) => r.pos },
  ...(kind === "buy"
    ? [{ key: "owner", label: "Owner", value: (r) => r.owner ?? "" }]
    : []),
  { key: "snap", label: "Snap%", num: true, hint: USAGE_HINT.snap,
    value: (r) => sortNum(r.snapShare) },
  { key: "tgt", label: "Tgt%", num: true, hint: USAGE_HINT.tgt,
    value: (r) => sortNum(r.targetShare) },
  { key: "wopr", label: "WOPR", num: true, hint: USAGE_HINT.wopr,
    value: (r) => sortNum(r.wopr) },
  { key: "tdover", label: "TD ±", num: true, hint: USAGE_HINT.tdover,
    value: (r) => sortNum(r.tdOver) },
  { key: "resid", label: "Pts vs usage", num: true, hint: USAGE_HINT.resid,
    value: (r) => sortNum(r.ppgOverUsage) },
  { key: "offer", label: "Best offer", num: true, hint: USAGE_HINT.offer,
    value: (r) => sortNum(r.offer?.gain) },
];

/** `+0.42 · 1-for-1`, or a dash. A row with no `offer` field at all is the dash case. */
const offerCell = (o) => (o == null || o.gain == null
  ? '<span class="zero">—</span>'
  : `<b class="${signCls(o.gain)}">${o.gain >= 0 ? "+" : "−"}${
      Math.abs(o.gain).toFixed(2)}</b> <span style="color:var(--faint)">${
      esc(o.dir === "send" ? "send" : "get")} · ${esc(o.shape ?? "")}</span>`);

/**
 * One `<tr>`. It has to survive a bare usage row: no `offer` field, and every share,
 * WOPR, tdOver and residual the usage table is allowed to leave null.
 */
function assetRow(r, kind = "sell") {
  return `<tr>
  <td style="font-weight:600">${esc(r.name)}</td>
  <td><span class="pos" data-p="${esc(r.pos)}">${esc(r.pos)}</span></td>
  ${kind === "buy" ? `<td style="color:var(--dim)">${esc(r.owner ?? "free agent")}</td>` : ""}
  <td class="num">${pctOrDash(r.snapShare)}</td>
  <td class="num">${pctOrDash(r.targetShare)}</td>
  <td class="num">${numOrDash(r.wopr)}</td>
  <td class="num ${signCls(r.tdOver)}">${numOrDash(r.tdOver)}</td>
  <td class="num ${signCls(r.ppgOverUsage)}">${numOrDash(r.ppgOverUsage)}</td>
  <td class="num">${offerCell(r.offer ?? null)}</td>
</tr>`;
}

/**
 * Sell high / buy low on usage rather than on the market. Rendered even when the feed
 * is dead - a section that silently disappears is harder to understand than one that
 * says why it is empty.
 *
 * `myTeam` is the fixed team the search runs for, not the page's "who" selector, for
 * the same reason `arbitrageSection` fixes it: "sell high" is a statement about your
 * own roster and means nothing pointed at somebody else's.
 */
export function assetsSection(eng, model, view, opts = {}) {
  const { myTeam = null, grid, trades = [], limit = 15 } = opts;
  const ownerOf = ownersOf(eng);
  const res = view ? assetRows(view.table, ownerOf, myTeam) : { sell: [], buy: [], cut: new Map() };

  // The join to the search's own output. Read-only in both directions: the offer is
  // hung on a copy of the row, and nothing here is ever handed back to the search.
  const withOffer = (rows) => rows.slice(0, limit).map((r) => ({
    ...r, offer: bestOfferFor(eng.index.get(r.espnId), trades, myTeam),
  }));

  const deadState = '<div class="empty"><b>Usage signals unavailable</b>Sleeper\'s weekly '
    + 'snap and target feed did not answer, so there is nothing to measure output '
    + 'against opportunity with.</div>';
  const mk = (id, kind, rows, dir, empty) => grid(id, assetCols(kind), rows,
    { sort: "resid", dir, empty: view ? empty : deadState, row: (r) => assetRow(r, kind) });

  const sellGrid = mk("usageSell", "sell", withOffer(res.sell), -1,
    '<div class="empty"><b>Nobody to sell</b>Nobody on your roster is both producing '
    + 'above his usage and scoring above even that.</div>');
  const buyGrid = mk("usageBuy", "buy", withOffer(res.buy), 1,
    '<div class="empty"><b>Nobody to buy</b>Everybody being given the ball elsewhere is '
    + 'already cashing it.</div>');

  const weeks = view?.table?.recent ?? [];
  const span = weeks.length
    ? (weeks.length === 1 ? `week ${weeks[0]}` : `weeks ${weeks[0]}–${weeks.at(-1)}`)
    : "the weeks played so far";

  return `<section>
    <h2 class="secttl">Assets and targets (usage)</h2>
    <p class="sectsub">What each player is being <b>given</b> over ${esc(span)}, against
      what he has done with it. Every figure here is a <b>heuristic shown as evidence</b>:
      opportunity leads the box score, and touchdown rate regresses while opportunity
      does not. None of it is read by the trade search, the lineup solver or the odds —
      it is here to tell you <i>why</i> a name is on one of these lists.</p>
    <div class="panel">
      <div class="bar"><div class="fld"><label>Sell high</label></div>
        <span class="readout" style="color:var(--faint)">Yours · producing above their
          usage, and scoring above even that</span></div>
      ${sellGrid}
    </div>
    <div class="panel" style="margin-top:14px">
      <div class="bar"><div class="fld"><label>Buy low</label></div>
        <span class="readout" style="color:var(--faint)">Theirs · getting the ball at or
          above the median for the position, and the points have not arrived</span></div>
      ${buyGrid}
    </div>
  </section>`;
}

/* ------------------------------------------------------------------- breakout watch */

const breakCols = (crowdLive = true) => [
  { key: "name", label: "Player", value: (r) => r.name },
  { key: "pos", label: "Pos", value: (r) => r.pos },
  { key: "nfl", label: "Team", value: (r) => r.nfl ?? "" },
  { key: "owner", label: "Owner", value: (r) => r.owner ?? "" },
  { key: "snap", label: "Snap%", num: true, hint: USAGE_HINT.snap,
    value: (r) => sortNum(r.snapShare) },
  { key: "trend", label: "Trend", num: true, hint: USAGE_HINT.trend,
    value: (r) => sortNum(r.trend) },
  { key: "depth", label: "Depth", num: true, hint: USAGE_HINT.depth,
    value: (r) => sortNum(r.depthDelta) },
  { key: "crowd", label: "Crowd 24h", num: true, hint: USAGE_HINT.crowd,
    value: (r) => (crowdLive ? sortNum(r.crowd) : SINK) },
];

/** "RB2 +1", or the half of that which is known, or a dash. */
const depthCell = (r) => {
  const at = r.depthPos != null && r.depthOrder != null
    ? `${esc(r.depthPos)}${esc(r.depthOrder)}` : null;
  const d = Number(r.depthDelta) || 0;
  if (at == null && !d) return '<span class="zero">—</span>';
  return `${at ?? '<span class="zero">—</span>'}${d
    ? ` <b class="${signCls(d)}">${d > 0 ? "+" : "−"}${Math.abs(d)}</b>` : ""}`;
};

function breakoutRow(r, myTeam = null, crowdLive = true) {
  const owner = r.owner == null ? "free agent" : r.owner === myTeam ? "you" : r.owner;
  return `<tr>
  <td style="font-weight:600">${esc(r.name)}</td>
  <td><span class="pos" data-p="${esc(r.pos)}">${esc(r.pos)}</span></td>
  <td style="color:var(--dim)">${esc(r.nfl ?? "—")}</td>
  <td style="color:var(--dim)">${esc(owner)}</td>
  <td class="num">${pctOrDash(r.snapShare)}</td>
  <td class="num ${signCls(r.trend)}">${signPctOrDash(r.trend)}</td>
  <td class="num">${depthCell(r)}</td>
  <td class="num">${crowdLive
    ? Number(r.crowd ?? 0).toLocaleString("en-US") : '<span class="zero">—</span>'}</td>
</tr>`;
}

/**
 * Who is being handed a bigger job than he had a fortnight ago. Free agents and
 * low-usage rostered players only: a man already taking most of the snaps has nothing
 * left to break out into.
 */
export function breakoutSection(eng, model, view, opts = {}) {
  const { myTeam = null, grid, limit = 15 } = opts;
  const ownerOf = ownersOf(eng);
  const rows = view
    ? breakouts(view.table, ownerOf, view.crowdByEspn, view.depth).slice(0, limit)
    : [];
  // `breakouts` fills a missing count with 0, which is a claim - "nobody else wants
  // him" - and not one a silent endpoint has earned. A half-dead feed dashes instead.
  const crowdLive = !!view && (view.crowdLive ?? true);

  const deadState = '<div class="empty"><b>Usage signals unavailable</b>Sleeper\'s weekly '
    + 'snap feed did not answer, so there are no snap shares to watch move.</div>';
  const html = grid("usageBreak", breakCols(crowdLive), rows, {
    sort: "trend", dir: -1, row: (r) => breakoutRow(r, myTeam, crowdLive),
    empty: view
      ? '<div class="empty"><b>Nobody moving</b>No snap share has jumped by '
        + `${Math.round(USAGE_K.BREAKOUT_TREND * 100)} points and no depth chart has `
        + 'changed since this page last saw it.</div>'
      : deadState,
  });

  return `<section>
    <h2 class="secttl">Breakout watch</h2>
    <p class="sectsub">Snap share is the earliest thing a changed role shows up in, and it
      moves a week or two before the points do. These are free agents and lightly-used
      rostered players whose share has jumped by at least
      ${Math.round(USAGE_K.BREAKOUT_TREND * 100)} points, or who have moved up Sleeper's
      depth chart. Evidence only — the search never reads it.</p>
    <div class="panel">
      <div class="bar"><div class="fld"><label>Rising</label></div>
        <span class="readout" style="color:var(--faint)">Last two weeks against the two
          before</span></div>
      ${html}
    </div>
  </section>`;
}

/* -------------------------------------------------------- the two free-agent columns */

export function waiverView(upgrades, view, eng, opts = {}) {
  const crowdOf = (u) => view?.crowdByEspn.get(eng.ids[u.fa]) ?? 0;
  const { split, threshold } = crowdSplit(upgrades ?? [], crowdOf);
  const plan = faabBids(upgrades ?? [], {
    budget: opts.budget, myRemaining: opts.myRemaining,
    weeksLeft: opts.weeksLeft, crowdOf,
  });
  // Two flags, not one. `live` is "there is a usage view at all", which is what the
  // sections key their empty states on; `crowdLive` is "the trending endpoint
  // answered", which is the only thing the crowd column may be rendered from. They
  // differ on exactly the path `usageOrNull` was written to survive: stats up, crowd
  // down.
  return { split, threshold, mode: plan.mode, bids: plan.bids,
           live: !!view, crowdLive: !!view && (view.crowdLive ?? true) };
}

/** Two `tradeCols`-style descriptors for the free-agent grid. -1 sinks every dash. */
export function faCrowdCols(wv) {
  return [
    { key: "crowd", label: "Crowd 24h", num: true, hint: USAGE_HINT.crowd,
      value: (u) => (wv?.crowdLive ? (wv.split.get(u.fa)?.crowd ?? 0) : -1) },
    { key: "bid", label: "Bid", num: true, hint: USAGE_HINT.bid,
      value: (u) => (wv?.mode === "faab" ? (wv.bids.get(u.fa)?.bid ?? 0) : -1) },
  ];
}

/** Exactly two `<td>` on every path, so a dead feed never shifts the column count. */
export function faCrowdCells(u, wv) {
  const dash = '<td class="num"><span class="zero">—</span></td>';
  const c = wv?.crowdLive ? wv.split.get(u.fa) : null;
  const crowd = c
    ? `<td class="num ${c.contested ? "down" : "up"}">${c.crowd.toLocaleString("en-US")}</td>`
    : dash;
  const b = wv?.mode === "faab" ? wv.bids.get(u.fa) : null;
  const bid = b && b.bid > 0
    ? `<td class="num">$${b.bid}${b.max != null
        ? ` <span style="color:var(--faint)">/${b.max}</span>` : ""}</td>`
    : dash;
  return crowd + bid;
}
