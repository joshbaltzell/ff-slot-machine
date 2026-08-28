/**
 * Usage: what a player is being given, as against what he has produced with it.
 *
 * Opportunity leads the box score. Snap share, target share and air yards move a
 * week or two before points do, and touchdown rate over expectation is the oldest
 * sell-high signal there is. Everything in this file is a HEURISTIC and it is
 * displayed as evidence, never consumed: nothing here is read by the lineup solver,
 * the trade search, the season simulation or the odds. If that ever changes, the
 * exactness claim in CLAUDE.md stops being true.
 *
 * The constants live in one table so they can be argued with in one place:
 *   WOPR_TGT / WOPR_AIR   1.5 and 0.7, the published Weighted Opportunity Rating
 *                         weights (Hermsmeyer). Not fitted here; taken as given.
 *   RUSH_TD / TGT_TD      Round league-average conversion rates - about 4% of carries
 *                         and 6% of targets become touchdowns. They set the zero
 *                         point for `tdOver`; a league-specific fit would be better
 *                         and is not worth the complexity for a display signal.
 *   RECENT                Four weeks. Long enough for a share to mean something,
 *                         short enough to notice a changed role.
 */
export const USAGE_K = {
  RECENT: 4,            // weeks in the "recent form" window
  RUSH_TD: 0.04,        // expected touchdowns per rush attempt
  TGT_TD: 0.06,         // expected touchdowns per target
  WOPR_TGT: 1.5,
  WOPR_AIR: 0.7,
  MIN_FIT: 3,           // players needed at a position before a fit is honest
  MIN_QUARTILE: 4,      // …and before quartiles are
  BREAKOUT_TREND: 0.15, // snap-share jump that counts as a breakout
  LOW_SNAP: 0.5,        // below this a rostered player is "low usage"
  CROWD_FLOOR: 100,     // fewer 24h adds than this is never "contested"
  CROWD_SHARE: 0.25,    // …nor is less than a quarter of the loudest add in the pool
};

/**
 * What each position is fitted against. WOPR is defined only for pass catchers; a
 * runner's opportunity is touches and a passer's is dropbacks. Any position not
 * listed (K, DST, IDP) has no honest usage denominator and gets no residual at all.
 */
export const DRIVER = { WR: "wopr", TE: "wopr", RB: "touches", QB: "dropbacks" };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Linear-interpolated quantile (R type 7) over an ASCENDING array. */
export function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Which of Sleeper's three points columns is closest to this league's scoring. */
export function ptsKeyFor(pprValue) {
  const v = Number(pprValue) || 0;
  return v >= 1 ? "pts_ppr" : v > 0 ? "pts_half_ppr" : "pts_std";
}

/** A row of zeroes is a player who dressed and did nothing; no row is a player who did not. */
const played = (r) => num(r.off_snp) > 0 || num(r.rec_tgt) > 0 || num(r.rush_att) > 0
  || num(r.pass_att) > 0;

/**
 * @param model        the league model; only `players` and `settings.pprValue` are read
 * @param stats        {byWeek: Map<week, Map<sleeperId, rec>>, bySleeper: Map<sleeperId, rec>}
 * @param currentWeek  weeks at or after this one have not been played
 * @returns {rows: Map<espnId, row>, fits: Map<pos, {a, b, n}>, weeks, recent, ptsKey}
 */
export function usageTable(model, stats, currentWeek, opts = {}) {
  const K = { ...USAGE_K, ...(opts.K ?? {}) };
  const byWeek = stats?.byWeek ?? new Map();
  const bySleeper = stats?.bySleeper ?? new Map();
  const ptsKey = ptsKeyFor(model?.settings?.pprValue);
  const weeks = [...byWeek.keys()].map(Number)
    .filter((w) => w < Number(currentWeek)).sort((a, b) => a - b);
  const recent = weeks.slice(-Math.min(K.RECENT, weeks.length));

  // A player's NFL team comes from the stat row when the feed carries it, because a
  // player traded in October belonged to his old team in September's numbers. The
  // players file is the fallback and is only ever "today".
  const teamOf = (sid, rec) => rec?.team ?? bySleeper.get(sid)?.team ?? "?";

  // Team totals are taken over the players the payload actually carries, which is
  // what makes a share out of a raw count.
  const teamTot = new Map();
  for (const w of weeks) {
    const t = new Map();
    for (const [sid, rec] of byWeek.get(w) ?? []) {
      const tm = teamOf(sid, rec);
      const cur = t.get(tm) ?? { tgt: 0, air: 0 };
      cur.tgt += num(rec.rec_tgt); cur.air += num(rec.rec_air_yd);
      t.set(tm, cur);
    }
    teamTot.set(w, t);
  }

  // A ratio of sums, not a mean of ratios - and the denominator only counts the weeks
  // the player has a row in. A man who missed week two must not carry his team's
  // week-two targets in his own denominator.
  const share = (sid, wks, pick) => {
    let top = 0, bot = 0, any = false;
    for (const w of wks) {
      const rec = byWeek.get(w)?.get(sid);
      if (!rec) continue;
      const [a, b] = pick(rec, teamTot.get(w)?.get(teamOf(sid, rec)) ?? { tgt: 0, air: 0 });
      if (!(b > 0)) continue;
      top += a; bot += b; any = true;
    }
    return any ? top / bot : null;
  };
  const snapOf = (sid, wks) => share(sid, wks, (r) => [num(r.off_snp), num(r.tm_off_snp)]);

  const rows = new Map();
  for (const [sid, pl] of bySleeper) {
    const espnId = Number(pl.espn_id);
    const p = model?.players?.get(espnId);
    if (!p) continue;
    let games = 0, pts = 0, tgt = 0, air = 0, att = 0, patt = 0, td = 0;
    for (const w of recent) {
      const rec = byWeek.get(w)?.get(sid);
      if (!rec || !played(rec)) continue;
      games++;
      pts += num(rec[ptsKey]);
      tgt += num(rec.rec_tgt); air += num(rec.rec_air_yd);
      att += num(rec.rush_att); patt += num(rec.pass_att);
      td += num(rec.rec_td) + num(rec.rush_td);
    }
    if (!games) continue;

    const snapShare = snapOf(sid, recent);
    const targetShare = share(sid, recent, (r, t) => [num(r.rec_tgt), t.tgt]);
    const airShare = share(sid, recent, (r, t) => [num(r.rec_air_yd), t.air]);
    const wopr = targetShare == null || airShare == null ? null
      : K.WOPR_TGT * targetShare + K.WOPR_AIR * airShare;
    const touches = (att + tgt) / games;
    const dropbacks = (patt + att) / games;
    const driverKey = DRIVER[p.pos] ?? null;
    const driver = driverKey === "wopr" ? wopr
      : driverKey === "touches" ? touches
      : driverKey === "dropbacks" ? dropbacks : null;

    // A passer's touchdowns are overwhelmingly thrown, and these stat fields carry no
    // passing touchdowns at all. Reporting `rec_td + rush_td` against an expectation
    // built from carries would be a rushing-only number wearing a regression label.
    const tdOver = p.pos === "QB" ? null : td - (K.RUSH_TD * att + K.TGT_TD * tgt);

    // The last two played weeks against the two before them. A player with no row in
    // the earlier pair played no snaps - that is a snap share of zero, and it is what
    // a mid-season promotion looks like. Fewer than four played weeks in the season
    // is missing data, and reports nothing.
    let trend = null;
    if (weeks.length >= 4) {
      const a = snapOf(sid, weeks.slice(-2));
      const b = snapOf(sid, weeks.slice(-4, -2));
      if (a != null) trend = a - (b ?? 0);
    }

    rows.set(espnId, {
      espnId, sleeperId: sid, name: p.name, pos: p.pos, nfl: p.nfl,
      games, snapShare, targetShare, airShare, wopr, touches, dropbacks,
      driver, driverKey, ppg: pts / games, tdOver, ppgOverUsage: null, trend,
      depthOrder: pl.depth_chart_order ?? null, depthPos: pl.depth_chart_position ?? null,
    });
  }

  // One ordinary least-squares line of points per game on usage, per position. The
  // residual is the number this whole file exists to produce: producing above or
  // below what the opportunity says. Too few players, or no spread in the driver,
  // means there is no line - and then the residual is NULL, never 0. Zero would say
  // "exactly on the fit", which is a claim, and a false one.
  const byPos = new Map();
  for (const r of rows.values()) {
    if (r.driver == null || !Number.isFinite(r.driver)) continue;
    if (!byPos.has(r.pos)) byPos.set(r.pos, []);
    byPos.get(r.pos).push(r);
  }
  const fits = new Map();
  for (const [pos, list] of byPos) {
    if (list.length < K.MIN_FIT) continue;
    const n = list.length;
    const mx = list.reduce((a, r) => a + r.driver, 0) / n;
    const my = list.reduce((a, r) => a + r.ppg, 0) / n;
    let sxx = 0, sxy = 0;
    for (const r of list) { sxx += (r.driver - mx) ** 2; sxy += (r.driver - mx) * (r.ppg - my); }
    if (!(sxx > 1e-9)) continue;
    const b = sxy / sxx, a = my - b * mx;
    fits.set(pos, { a, b, n });
    for (const r of list) r.ppgOverUsage = r.ppg - (a + b * r.driver);
  }

  return { rows, fits, weeks, recent, ptsKey };
}

/**
 * The two lists this phase exists for.
 *
 * Sell high: MY players in the top quartile of their position on BOTH the residual
 * and touchdowns over expectation - producing above their usage, and scoring above
 * even that. Buy low: SOMEBODY ELSE'S players at or above the median usage for their
 * position and in the bottom quartile of the residual - being given the ball and not
 * yet cashing it.
 *
 * Free agents are deliberately absent from buy low: there is nothing to trade for,
 * and the free-agent grid already covers them. Sell high follows `myTeam` rather than
 * the page's "who" selector for the same reason `arbitrageSection` does - "sell high"
 * is a statement about your own roster.
 *
 * @param ownerOf Map<espnId, teamName>; absent means free agent
 */
export function assetRows(usage, ownerOf, myTeam, opts = {}) {
  const K = { ...USAGE_K, ...(opts.K ?? {}) };
  const pop = new Map();
  for (const r of usage.rows.values()) {
    if (r.ppgOverUsage == null) continue;
    if (!pop.has(r.pos)) pop.set(r.pos, []);
    pop.get(r.pos).push(r);
  }
  const cut = new Map();
  for (const [pos, list] of pop) {
    if (list.length < K.MIN_QUARTILE) continue;
    const asc = (f) => list.map(f).filter((v) => v != null).sort((a, b) => a - b);
    cut.set(pos, {
      resQ1: quantile(asc((r) => r.ppgOverUsage), 0.25),
      resQ3: quantile(asc((r) => r.ppgOverUsage), 0.75),
      tdQ3: quantile(asc((r) => r.tdOver), 0.75),
      drvMed: quantile(asc((r) => r.driver), 0.5),
    });
  }
  const sell = [], buy = [];
  for (const [pos, list] of pop) {
    const c = cut.get(pos);
    if (!c) continue;
    for (const r of list) {
      const owner = ownerOf?.get(r.espnId) ?? null;
      const row = { ...r, owner };
      if (owner === myTeam) {
        if (c.resQ3 != null && c.tdQ3 != null && r.tdOver != null
            && r.ppgOverUsage >= c.resQ3 && r.tdOver >= c.tdQ3) sell.push(row);
      } else if (owner != null) {
        if (c.drvMed != null && c.resQ1 != null && r.driver != null
            && r.driver >= c.drvMed && r.ppgOverUsage <= c.resQ1) buy.push(row);
      }
    }
  }
  // Names break every tie so two runs on the same data give the same list.
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  sell.sort((a, b) => b.ppgOverUsage - a.ppgOverUsage || b.tdOver - a.tdOver || byName(a, b));
  buy.sort((a, b) => a.ppgOverUsage - b.ppgOverUsage || b.driver - a.driver || byName(a, b));
  return { sell, buy, cut };
}

/**
 * Who is being handed a bigger job than he had a fortnight ago: free agents, and
 * rostered players still below `LOW_SNAP` whose share is climbing. A depth-chart
 * promotion qualifies on its own - the snaps have not arrived yet, which is the
 * point of watching for it.
 */
export function breakouts(usage, ownerOf, crowdByEspn, depthDelta, opts = {}) {
  const K = { ...USAGE_K, ...(opts.K ?? {}) };
  const out = [];
  for (const r of usage.rows.values()) {
    const owner = ownerOf?.get(r.espnId) ?? null;
    const lowUse = r.snapShare == null || r.snapShare < K.LOW_SNAP;
    if (owner != null && !lowUse) continue;
    const dd = depthDelta?.get(r.sleeperId) ?? 0;
    const jump = r.trend != null && r.trend >= K.BREAKOUT_TREND;
    if (!jump && !(dd > 0)) continue;
    out.push({ ...r, owner, depthDelta: dd, crowd: crowdByEspn?.get(r.espnId) ?? 0 });
  }
  out.sort((a, b) => (b.trend ?? 0) - (a.trend ?? 0) || b.crowd - a.crowd
    || String(a.name).localeCompare(String(b.name)));
  return out;
}

/**
 * Depth-chart movement, which needs a before and an after. Sleeper's players file
 * carries only "now", so two snapshots are kept locally and diffed. A snapshot rolls
 * forward only when the file's own fetch timestamp changes; without that guard, the
 * first render inside a cache day would consume the delta and every later render
 * would show nothing.
 *
 * @param at    the players file's fetch timestamp
 * @param memo  the stored {at, order, prevOrder}, or null on a first run
 * @returns {delta: Map<sleeperId, number>, memo}   positive delta = moved UP the chart
 */
export function depthChanges(bySleeper, at, memo) {
  const order = {};
  for (const [sid, p] of bySleeper ?? []) {
    const v = Number(p?.depth_chart_order);
    if (p?.depth_chart_order != null && Number.isFinite(v)) order[sid] = v;
  }
  const next = memo && memo.at === at
    ? { at, order, prevOrder: memo.prevOrder ?? {} }
    : { at, order, prevOrder: memo?.order ?? {} };
  const delta = new Map();
  for (const [sid, o] of Object.entries(next.order)) {
    const was = next.prevOrder[sid];
    if (was == null || was === o) continue;
    delta.set(sid, was - o);
  }
  return { delta, memo: next };
}

/**
 * Quiet against contested: is the engine's pickup one nobody else has noticed, or one
 * the whole of Sleeper is adding this morning?
 *
 * The line is relative with a floor. Trending counts swing by an order of magnitude
 * between a quiet Tuesday and the Wednesday after a starter goes down, so an absolute
 * cut-off means nothing; the floor stops the loudest of six near-zero counts from
 * being announced as contested.
 *
 * @param crowdOf (upgrade) -> 24h add count
 * @returns {split: Map<upgrade.fa, {crowd, contested}>, threshold, max}
 */
export function crowdSplit(upgrades, crowdOf, opts = {}) {
  const K = { ...USAGE_K, ...(opts.K ?? {}) };
  let max = 0;
  for (const u of upgrades ?? []) max = Math.max(max, Number(crowdOf(u)) || 0);
  const threshold = Math.max(K.CROWD_FLOOR, K.CROWD_SHARE * max);
  const split = new Map();
  for (const u of upgrades ?? []) {
    const c = Number(crowdOf(u)) || 0;
    split.set(u.fa, { crowd: c, contested: c >= threshold });
  }
  return { split, threshold, max };
}

/**
 * The best deal the search already found that moves this player, from my side's point
 * of view. Strictly read-only over the search's own output: this joins to it, it never
 * feeds it.
 */
export function bestOfferFor(index, trades, myTeam) {
  let best = null;
  for (const t of trades ?? []) {
    const mine = t.sides?.find((s) => s.team === myTeam);
    if (!mine) continue;
    const dir = mine.sent?.includes(index) ? "send"
      : mine.received?.includes(index) ? "get" : null;
    if (!dir) continue;
    if (!best || mine.gain > best.gain)
      best = { gain: mine.gain, shape: t.shape, dir, trade: t };
  }
  return best;
}
