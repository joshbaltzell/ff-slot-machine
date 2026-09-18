/**
 * Trade search. Ported from ffti/search.py + ffti/swaps.py; same guarantees.
 *
 * A roster's value is the points its *starters* score, so a trade is scored as the
 * change in each team's optimal weekly lineup. Bench depth is worth nothing.
 *
 * Nothing here approximates. Three-way search is exhaustive via swap tables - an
 * earlier design pruned with marginal-value estimates and was measured at 57% recall
 * against known-good trades, so it was dropped.
 */
import { bestLineup } from "./lineup.js";
import { winProb, leverage, FALLBACK_SIGMA } from "./winprob.js";
import { mulberry32 } from "./availability.js";

/**
 * How wide an exact enumeration is allowed to get.
 *
 * Optimal lineup value is a max over assignments, so it is convex in the projections
 * and NOT linear in availability: E[L] is not L(E[proj]). Two players at 50% are not
 * one certain starter, because a bench absorbs one absence far better than two.
 * The only exact answer is to enumerate the 2^k availability outcomes and weight
 * them, which is why nothing here averages probabilities into projections.
 *
 * 2^6 = 64 lineup solves for one week is affordable; beyond that the same 64 solves
 * are spent on fixed-seed draws instead. That sampled branch is the one approximation
 * in the engine, it is reached only when seven or more players on a single roster are
 * genuinely uncertain in the same week, and it is deterministic.
 */
const ENUM_MAX = 6;
const SAMPLES = 64;

/** How many free agents per distinct seat mask enter the backfill pool. */
const POOL_PER_MASK = 3;

/**
 * Bounds are compared with slack, and the decision is then made on the exact metric.
 *
 * `mean(after) - mean(before)` and `mean(after - before)` differ in the last bit, and
 * gating on the first while reporting the second lets a handful of trades out of
 * 172,800 be published with a gain fractionally under the minimum the user asked for.
 * Measured, not theorised. Every prune below is therefore loose by GATE_EPS and every
 * accept is made on `_metrics().gain` - the number the page prints.
 */
/** The acceptance windows `findTwoTeam` has always used. Frozen: the golden set is it. */
const ACCEPT_GAIN = Object.freeze(["gain"]);

const GATE_EPS = 1e-9;

/**
 * How many (team, pair-sent) groups run between macrotask yields inside a search.
 *
 * One ordered pair of 16-man rosters is about 70 ms of arithmetic - long enough for a
 * progress bar to stutter. Yielding every 32 groups as well brings the measured chunk
 * to a 16 ms median and a 57 ms maximum, for about 0.2 s of overhead on a 7 s run.
 */
const YIELD_GROUPS = 32;

/**
 * When two lineup values count as the same number.
 *
 * Distinct from a gate on a user-facing minimum: this decides whether a removal
 * was free, i.e. whether two solves of the same optimal-lineup problem landed on
 * the same total. Float noise across a sum of eighteen weeks lives well below it.
 */
const TIE_EPS = 1e-12;

/**
 * Hand the browser a turn.
 *
 * The searches run on whichever thread calls them, and 2-for-2 is roughly fourteen
 * seconds of solid arithmetic. Without yielding, the page cannot paint its progress
 * bar or respond to a click for the whole run - it simply looks hung. A macrotask
 * (not a microtask) is required: awaiting a resolved promise would not let the
 * browser render between chunks.
 */
const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

export class Engine {
  /**
   * @param model {weeks, players:Map, teams:Map, settings}
   * @param slots from buildSlots()
   * @param masks Map playerId -> seat bitmask
   */
  constructor(model, slots, masks) {
    this.weeks = model.weeks;
    this.NW = model.weeks.length;
    this.settings = model.settings;
    this.starters = slots.starters;
    this.masks = masks;

    this.ids = [...model.players.keys()];
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.n = this.ids.length;

    // proj[i * NW + w] — flat typed array beats an array of arrays in the hot loop
    this.proj = new Float64Array(this.n * this.NW);
    this.mask = new Int32Array(this.n);
    this.bye = new Int32Array(this.n);
    for (const [id, p] of model.players) {
      const i = this.index.get(id);
      this.mask[i] = masks.get(id) ?? 0;
      this.bye[i] = p.bye ?? 0;
      for (let w = 0; w < this.NW; w++) this.proj[i * this.NW + w] = p.proj[this.weeks[w]] ?? 0;
    }

    // ESPN's positionLimits is a roster-composition rule keyed on its own
    // defaultPositionId. It is read verbatim and used only to reject rosters ESPN
    // itself would refuse - never for lineup logic, which stays on slots.
    // A value <= 0 means unlimited (ESPN sends -1; 0 appears for positions no
    // roster can hold).
    this.posId = new Int32Array(this.n);
    for (const [id, p] of model.players) this.posId[this.index.get(id)] = Math.max(0, Math.min(63, p.posId ?? 0));
    this.limits = Object.entries(this.settings.positionLimits ?? {})
      .map(([k, v]) => [Number(k), Number(v)])
      .filter(([k, v]) => k >= 0 && k <= 63 && v > 0);
    this._limitCount = new Int32Array(64);

    this._posOf = new Map();
    for (const [id, p] of model.players) this._posOf.set(this.index.get(id), p.pos);
    this.teams = [...model.teams.values()].map(t => t.name);
    this.roster = new Map();
    for (const t of model.teams.values()) {
      this.roster.set(t.name, [...t.roster].map(id => this.index.get(id)).filter(i => i !== undefined));
    }

    const reg = new Set(this.settings.regularSeasonWeeks);
    const po = new Set(this.settings.playoffWeeks);
    this.regMask = this.weeks.map(w => reg.has(w));
    this.poMask = this.weeks.map(w => po.has(w));

    // Scratch, all of it; every one of these must exist before the first weekly().
    this._vals = new Float64Array(this.n);
    this.avail = null;              // set by setAvailability(); null = everyone plays
    this._play = [];                // this week's available players, reused
    this._sub = [];                 // one enumeration outcome's player order, reused
    this._unc = new Int32Array(this.n);      // indices of the uncertain players
    this._uProb = new Float64Array(this.n);  // their probabilities
    this._isOut = new Uint8Array(this.n);    // outcome flags, cleared after each use
    this._buf = new Float64Array(this.NW);   // one shared result buffer for _wmean
    this._pool = null;                       // backfillPool(), lazy
    this._rank = null;                       // _rankVal(), lazy
    this.baseline = new Map();
    for (const t of this.teams) this.baseline.set(t, this.weekly(this.roster.get(t)));

    // thin weeks: enough of a roster on bye that it starts players it would bench
    this.thin = new Map();
    for (const t of this.teams) {
      const ids = this.roster.get(t);
      this.thin.set(t, this.weeks.map(w => ids.filter(i => this.bye[i] === w).length >= 2));
    }
  }

  /**
   * Attach a per-player, per-week probability of playing.
   *
   * The default is 1 everywhere, so an engine that is never handed availability
   * behaves exactly as it did before - which is what keeps the frozen golden set a
   * valid contract. Baselines and every cache derived from them are rebuilt here,
   * because the constructor computed them while assuming everyone plays.
   *
   * @param avail Map<playerId, Float64Array(NW)>; missing players are fully available
   */
  setAvailability(avail) {
    const NW = this.NW;
    const a = new Float64Array(this.n * NW).fill(1);
    for (const [id, row] of avail ?? []) {
      const i = this.index.get(id);
      if (i === undefined) continue;
      for (let w = 0; w < NW; w++) {
        const p = row?.[w];
        a[i * NW + w] = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 1;
      }
    }
    this.avail = a;
    this._swaps = null;
    this._teamSigma = null;
    this._baseWins = null;
    this._pool = null;      // pool membership is availability-weighted
    this._rank = null;
    this.baseline = new Map();
    for (const t of this.teams) this.baseline.set(t, this.weekly(this.roster.get(t)));
  }

  /**
   * Best started points per week for a roster - in expectation, once anybody's
   * availability is in doubt.
   *
   * With no availability attached this is the original path, character for
   * character: one sort and one matroid solve per week. That matters twice over -
   * the frozen golden set depends on it, and 2-for-2 calls this function millions of
   * times, so the common case must not pay for the uncommon one.
   *
   * With availability attached, a player who cannot play is REMOVED from the pool
   * rather than valued at zero. Those are not the same thing: bestLineup seats
   * players in the order it is handed and never unseats one, so a high-projection
   * player zeroed in place still sits early in that order, still takes a seat, and
   * can block a lower-but-positive player who would otherwise have started.
   * Filtering him out of the order is the only correct move.
   *
   * The genuinely uncertain players are enumerated (see ENUM_MAX). Only the current
   * week can hold any - a Questionable tag is about this Sunday, not November - so
   * the extra solves are confined to one week out of the horizon.
   */
  weekly(ids, out) {
    const res = out ?? new Float64Array(this.NW);
    const vals = this._vals;
    const av = this.avail;
    const NW = this.NW;
    if (!av) {
      for (let w = 0; w < NW; w++) {
        for (const i of ids) vals[i] = this.proj[i * NW + w];
        const order = ids.slice().sort((a, b) => vals[b] - vals[a]);
        res[w] = bestLineup(order, vals, this.mask, this.starters);
      }
      return res;
    }
    const play = this._play;
    const unc = this._unc;
    for (let w = 0; w < NW; w++) {
      play.length = 0;
      let k = 0;
      for (const i of ids) {
        const p = av[i * NW + w];
        if (p <= 0) continue;                       // cannot play: not in the pool
        vals[i] = this.proj[i * NW + w];
        play.push(i);
        if (p < 1) unc[k++] = i;
      }
      const order = play.slice().sort((a, b) => vals[b] - vals[a]);
      if (k === 0) { res[w] = bestLineup(order, vals, this.mask, this.starters); continue; }
      res[w] = k <= ENUM_MAX
        ? this._enumerate(order, unc, k, av, w)
        : this._sample(order, unc, k, av, w);
    }
    return res;
  }

  /** Exact expectation over the 2^k availability outcomes of one week. */
  _enumerate(order, unc, k, av, w) {
    const NW = this.NW, isOut = this._isOut, sub = this._sub, prob = this._uProb;
    for (let j = 0; j < k; j++) prob[j] = av[unc[j] * NW + w];
    let total = 0;
    for (let m = 0; m < (1 << k); m++) {
      let wt = 1;
      for (let j = 0; j < k; j++) {
        const inn = (m >> j) & 1;
        isOut[unc[j]] = inn ? 0 : 1;
        wt *= inn ? prob[j] : 1 - prob[j];
      }
      if (wt > 0) {
        sub.length = 0;
        for (let x = 0; x < order.length; x++) if (!isOut[order[x]]) sub.push(order[x]);
        total += wt * bestLineup(sub, this._vals, this.mask, this.starters);
      }
    }
    for (let j = 0; j < k; j++) isOut[unc[j]] = 0;
    return total;
  }

  /**
   * SAMPLES fixed-seed draws, for the rare week where enumeration would be too wide.
   * The generator is created fresh from a seed that depends only on the week, so two
   * calls with the same roster return the identical number - a search whose answer
   * moved between passes would be worse than one that is slightly wrong.
   */
  _sample(order, unc, k, av, w) {
    const NW = this.NW, isOut = this._isOut, sub = this._sub, prob = this._uProb;
    for (let j = 0; j < k; j++) prob[j] = av[unc[j] * NW + w];
    const rand = mulberry32(0x0A11AB1E ^ Math.imul(w, 0x9E3779B1));
    let total = 0;
    for (let s = 0; s < SAMPLES; s++) {
      for (let j = 0; j < k; j++) isOut[unc[j]] = rand() < prob[j] ? 0 : 1;
      sub.length = 0;
      for (let x = 0; x < order.length; x++) if (!isOut[order[x]]) sub.push(order[x]);
      total += bestLineup(sub, this._vals, this.mask, this.starters);
    }
    for (let j = 0; j < k; j++) isOut[unc[j]] = 0;
    return total / SAMPLES;
  }

  /**
   * The roster as the single most likely outcome has it: everyone at p >= 0.5.
   *
   * Usage strips and explanations have to name actual players, so they show the
   * modal lineup rather than a probability-weighted blur - a row that says a man
   * starts 0.71 of a week is not readable. Returns `ids` itself when no availability
   * is attached, so the untouched path allocates nothing.
   */
  _likely(ids, w) {
    const av = this.avail;
    if (!av) return ids;
    const out = [];
    for (const i of ids) if (av[i * this.NW + w] >= 0.5) out.push(i);
    return out;
  }

  /**
   * Availability-weighted mean projection over the horizon, per player.
   *
   * Ranking only: it decides which free agents are worth trying and which rostered
   * player to test dropping first. Never a value - every value in this engine comes
   * from `weekly`, because a projection is not worth what it says until somebody
   * seats it. Weighting by availability keeps a season-ending IR case off the waiver
   * shortlist, where his raw projection would otherwise hold a slot he cannot use.
   */
  _rankVal() {
    if (this._rank) return this._rank;
    const NW = this.NW, av = this.avail;
    const r = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      let s = 0;
      for (let w = 0; w < NW; w++) s += this.proj[i * NW + w] * (av ? av[i * NW + w] : 1);
      r[i] = s / NW;
    }
    this._rank = r;
    return r;
  }

  /**
   * Mean weekly optimal lineup for a roster, over the horizon.
   *
   * Writes through one shared buffer, so a caller that needs to keep the per-week
   * array must copy it before calling again. Everything in this section works in
   * means, and a mean is all the comparisons need.
   */
  _wmean(ids) {
    const a = this.weekly(ids, this._buf);
    let s = 0;
    for (let w = 0; w < this.NW; w++) s += a[w];
    return s / this.NW;
  }

  swap(ids, out, inn) {
    const drop = new Set(out);
    const kept = ids.filter(i => !drop.has(i));
    return kept.concat(inn);
  }

  /** Would ESPN allow this roster? False when any limited position exceeds its cap. */
  legal(ids) {
    if (!this.limits.length) return true;
    const c = this._limitCount;
    c.fill(0);
    for (const i of ids) c[this.posId[i]]++;
    for (const [pid, max] of this.limits) if (c[pid] > max) return false;
    return true;
  }

  /**
   * The waiver candidates worth trying: the top few free agents in every distinct
   * seat mask, ranked by availability-weighted projection.
   *
   * This is the engine's one bounded candidate set, and what it bounds is the WAIVER
   * step, not the trade search. `backfill` is exact *within* this pool; the pool
   * itself is the approximation. Ranking is by mean projection over the horizon, but
   * an add's marginal value is a max over assignments, so week shape can invert that
   * order: a free agent whose points are concentrated in the weeks a roster is thin
   * (an IR stash about to return, a rookie about to be handed a job, a streamer with
   * a favourable late schedule) can be worth more than three higher-mean men of the
   * same eligibility and still be ranked out of the top three. The loss is
   * one-directional - a missed better add understates the consolidating side's gain,
   * so the bound costs recall and can never manufacture a trade that is not there.
   *
   * Buckets are seat MASKS, not position strings. Two players with the same mask are
   * interchangeable to the lineup solver, which is what makes this correct in
   * superflex, IDP, TQB and RB/WR leagues where "position" and "eligibility" part
   * company. Nothing here reads `p.pos`.
   */
  backfillPool() {
    if (this._pool) return this._pool;
    const rank = this._rankVal();
    const byMask = new Map();
    for (const i of this.freeAgents) {
      if (!this.mask[i]) continue;                 // cannot take any seat: never useful
      if (!byMask.has(this.mask[i])) byMask.set(this.mask[i], []);
      byMask.get(this.mask[i]).push(i);
    }
    const out = [];
    for (const b of byMask.values()) {
      b.sort((x, y) => rank[y] - rank[x]);
      out.push(...b.slice(0, POOL_PER_MASK));
    }
    this._pool = out.sort((a, b) => rank[b] - rank[a]);
    return this._pool;
  }

  /**
   * The pool member whose addition raises this roster's mean lineup the most.
   *
   * A team that has just sent two men for one has an empty seat, and the honest
   * comparison fills it: the alternative to consolidating is not playing a man short.
   * The seat is filled with the best legal candidate even when his marginal value is
   * zero, because the seat exists either way and a roster of 16 has to be compared
   * with a roster of 16.
   *
   * Exact over `backfillPool()`. Returns `fa: null` only when the pool is empty or
   * nothing in it is legal here - an open seat is a real outcome, not an error.
   */
  backfill(ids) {
    const base = this._wmean(ids);
    let fa = null, best = -Infinity;
    for (const c of this.backfillPool()) {
      if (ids.includes(c)) continue;
      const after = ids.concat([c]);
      if (!this.legal(after)) continue;
      const v = this._wmean(after);
      if (v > best) { best = v; fa = c; }
    }
    return { ids: fa === null ? ids : ids.concat([fa]), fa,
             gain: fa === null ? 0 : best - base };
  }

  /**
   * `backfill` again, bounded by the parent roster's marginals.
   *
   * `marg` is `[candidate, marginal value on the PARENT roster]`, sorted descending.
   * Optimal lineup value is a weighted matroid rank function and therefore
   * submodular, so a man is worth no more on a larger roster than on a smaller one:
   * with `parent` a subset of `ids`, `base + marg[j]` is an upper bound on what
   * candidate j can reach here. The list is sorted by that bound, so once the best
   * found beats it, nothing later can win.
   *
   * Same answer as `backfill`. Measured at roughly a fifth of the lineup solves,
   * which is what makes the exhaustive 2-for-1 search affordable.
   */
  _backfillFrom(ids, base, marg) {
    let fa = null, best = -Infinity;
    for (const [c, m] of marg) {
      if (fa !== null && best >= base + m - TIE_EPS) break;
      if (ids.includes(c)) continue;
      const after = ids.concat([c]);
      if (!this.legal(after)) continue;
      const v = this._wmean(after);
      if (v > best) { best = v; fa = c; }
    }
    return { ids: fa === null ? ids : ids.concat([fa]), fa,
             gain: fa === null ? 0 : best - base, val: fa === null ? base : best };
  }

  /**
   * The rostered player whose removal costs least. Exact.
   *
   * The scan runs in ascending rank order and stops the moment a removal costs
   * nothing, because nothing can cost less than nothing: a man the optimal lineup
   * leaves out every week is free to drop, and most rosters carry one. That is an
   * early exit from an exhaustive scan, not a heuristic - eight of the fixture's ten
   * teams take it and the two that do not fall through to the full scan and get the
   * same answer a brute force does.
   *
   * `exclude` keeps the players who have just arrived in a trade out of the drop set.
   * "Receive A and B, then drop B" is a 1-for-1 wearing a costume.
   *
   * When no single legal removal exists - a receiver two men over a position cap, say
   * - it returns `drop: null` and the roster unchanged; callers must check for that
   * rather than trusting `ids` to have shrunk.
   */
  trim(ids, exclude = null, base = null) {
    const b = base ?? this._wmean(ids);
    const rank = this._rankVal();
    let drop = null, best = -Infinity;
    const cand = ids.filter((i) => !exclude?.includes(i)).sort((x, y) => rank[x] - rank[y]);
    for (const d of cand) {
      const after = ids.filter((z) => z !== d);
      if (!this.legal(after)) continue;
      const v = this._wmean(after);
      if (v > best) { best = v; drop = d; }
      if (best >= b - TIE_EPS) break;
    }
    return { ids: drop === null ? ids : ids.filter((z) => z !== drop), drop,
             cost: drop === null ? 0 : b - best, val: drop === null ? b : best };
  }

  /** Per-team swap table: value after (out -> in). Makes three-way a lookup. */
  async buildSwapTable() {
    if (this._swaps) return this._swaps;
    const tab = new Map();
    // Only rostered players can be traded, so free agents must not enter this
    // table - they would quadruple it for combinations that can never occur.
    const rostered = new Set();
    for (const t of this.teams) for (const i of this.roster.get(t)) rostered.add(i);
    for (const t of this.teams) {
      const ids = this.roster.get(t);
      const own = new Set(ids);
      const incoming = [];
      for (const i of rostered) if (!own.has(i)) incoming.push(i);
      const m = new Map();
      for (const o of ids) {
        const kept = ids.filter(x => x !== o);
        const row = new Map();
        for (const p of incoming) row.set(p, Float64Array.from(this.weekly(kept.concat([p]))));
        m.set(o, row);
      }
      tab.set(t, m);
      await yieldToBrowser();
    }
    this._swaps = tab;
    return tab;
  }

  /**
   * A side's window means, given the roster it actually ends up with.
   *
   * Separated from `sideMetrics` because a 2-for-1 side finishes at the waiver wire:
   * the roster to score is not `swap(roster, sent, received)`. Key order is the order
   * `sideMetrics` has always produced.
   */
  _metrics(team, final, out) {
    const now = this.weekly(final, out);
    const base = this.baseline.get(team);
    const d = [];
    for (let w = 0; w < this.NW; w++) d.push(now[w] - base[w]);
    const avg = (arr, m) => {
      let s = 0, n = 0;
      for (let w = 0; w < this.NW; w++) if (!m || m[w]) { s += arr[w]; n++; }
      return n ? s / n : 0;
    };
    const thin = this.thin.get(team);
    return {
      team, sent: [], received: [], weekly: d,
      gain: avg(d), reg: avg(d, this.regMask), playoff: avg(d, this.poMask),
      bye: avg(d, thin), full: avg(d, thin.map(x => !x)), win: 0, winWeekly: null,
    };
  }

  sideMetrics(team, out, inn) {
    const s = this._metrics(team, this.swap(this.roster.get(team), out, inn));
    s.sent = out;
    s.received = inn;
    return s;
  }

  score(moves, shape) {
    const sent = new Map(), recv = new Map();
    for (const [src, dst, players] of moves) {
      if (!sent.has(src)) sent.set(src, []); if (!recv.has(src)) recv.set(src, []);
      if (!sent.has(dst)) sent.set(dst, []); if (!recv.has(dst)) recv.set(dst, []);
      sent.get(src).push(...players);
      recv.get(dst).push(...players);
    }
    // Legality first: it is cheap, and an illegal roster has no lineup worth solving.
    for (const t of sent.keys())
      if (!this.legal(this.swap(this.roster.get(t), sent.get(t), recv.get(t)))) return null;
    const sides = [...sent.keys()].map(t => this.sideMetrics(t, sent.get(t), recv.get(t)));
    return { shape, sides, total: sides.reduce((a, s) => a + s.gain, 0),
             balance: Math.min(...sides.map(s => s.gain)) / Math.max(...sides.map(s => s.gain)) };
  }

  /**
   * Symmetric two-team search, `depth` players per side. Yields between pairs.
   *
   * `accept` names the window metrics a side may qualify on, and a side qualifies if
   * ANY of them clears `minGain`. It defaults to `gain` alone, which is the predicate
   * this search has always applied - `golden_1for1.json` is a frozen set produced
   * under it, so the default can never move.
   *
   * Passing `["gain", "playoff"]` is what lets a buy-low on an injury out of the
   * search at all. Such a trade is negative on the season average by construction: a
   * side takes six weeks of nothing to buy eleven weeks of a starter, so `gain` is the
   * one window that is guaranteed to disagree with the reason for making it. The
   * windows already disagree on purpose (see `_metrics`); this is the gate catching up
   * with that. The asymmetry is the product, not a side effect - the man selling still
   * qualifies on `gain`, which is exactly why he would say yes.
   *
   * Only this search takes the option. `findThreeWay` and `findTwoForOne` carry prune
   * bounds keyed on `minGain` whose correctness proofs assume the gate is `gain`;
   * widening those is a separate change with its own reference test, not a flag.
   */
  async findTwoTeam(depth, minGain = 0.05, onProgress = () => {}, { accept = ACCEPT_GAIN } = {}) {
    const out = [];
    const pairs = [];
    // Hoisted so the default path stays one property compare per candidate: 2-for-2
    // evaluates this a few hundred thousand times and it is already a 14-second search.
    const qualifies = accept.length === 1 && accept[0] === "gain"
      ? (s) => s.gain >= minGain
      : (s) => accept.some((k) => s[k] >= minGain);
    for (let i = 0; i < this.teams.length; i++)
      for (let j = i + 1; j < this.teams.length; j++) pairs.push([this.teams[i], this.teams[j]]);
    for (let n = 0; n < pairs.length; n++) {
      const [A, B] = pairs[n];
      for (const sa of combos(this.roster.get(A), depth))
        for (const sb of combos(this.roster.get(B), depth)) {
          const t = this.score([[A, B, sa], [B, A, sb]], `${depth}-for-${depth}`);
          if (t && t.sides.every(qualifies)) out.push(t);
        }
      onProgress(n + 1, pairs.length, out.length);
      await yieldToBrowser();
    }
    return out.sort((a, b) => b.total - a.total);
  }

  /** Exhaustive one-player-each cycles, both directions. Yields between triples. */
  async findThreeWay(minGain = 0.05, onProgress = () => {}) {
    const tab = await this.buildSwapTable();
    const out = [];
    const T = this.teams;
    const triples = [];
    for (let i = 0; i < T.length; i++)
      for (let j = i + 1; j < T.length; j++)
        for (let k = j + 1; k < T.length; k++) triples.push([T[i], T[j], T[k]]);

    const mean = (arr, base) => {
      let s = 0; for (let w = 0; w < this.NW; w++) s += arr[w] - base[w];
      return s / this.NW;
    };
    for (let n = 0; n < triples.length; n++) {
      const tri = triples[n];
      for (const [A, B, C] of [[tri[0], tri[1], tri[2]], [tri[0], tri[2], tri[1]]]) {
        for (const pa of this.roster.get(A)) {
          const gb = [];
          for (const pb of this.roster.get(B)) {
            const v = tab.get(B).get(pb)?.get(pa);
            if (v && mean(v, this.baseline.get(B)) >= minGain) gb.push(pb);
          }
          if (!gb.length) continue;
          for (const pb of gb) for (const pc of this.roster.get(C)) {
            const vc = tab.get(C).get(pc)?.get(pb);
            if (!vc || mean(vc, this.baseline.get(C)) < minGain) continue;
            const va = tab.get(A).get(pa)?.get(pc);
            if (!va || mean(va, this.baseline.get(A)) < minGain) continue;
            const t = this.score([[A, B, [pa]], [B, C, [pb]], [C, A, [pc]]], "three-way");
            if (t) out.push(t);
          }
        }
      }
      onProgress(n + 1, triples.length, out.length);
      if (n % 4 === 3) await yieldToBrowser();     // triples are quick; yield less often
    }
    return out.sort((a, b) => b.total - a.total);
  }

  /**
   * Two players for one, priced all the way to the roster limit.
   *
   * A consolidation is the most common winning trade in a real league and every other
   * tool grades it with a haircut, because the two sides do not end with the rosters
   * the trade names: the side sending two has an empty seat and fills it from
   * waivers, and the side receiving two is over the limit and drops somebody. Both
   * are lineup solves, so both are inside the score. `sideMetrics` cannot express
   * that - hence `_metrics` on a final roster, and `side.final` for the passes that
   * run afterwards.
   *
   * The search is exhaustive over every ordered pair, every pair of players the
   * sender could send, and every player the receiver could send back. It is made
   * affordable by two upper bounds, both exact:
   *
   *   - the receiver has not yet paid for his drop, and a removal never raises the
   *     optimal lineup, so his pre-trim gain is an upper bound on his final one;
   *   - the sender's best waiver add is worth no more than the pool's best marginal
   *     on the roster BEFORE the incoming player joined it (submodularity again).
   *
   * Both bounds are exact for a certain roster; when a week holds seven or more
   * uncertain players `weekly` falls through to `_sample`, whose draws shift with
   * `k`, so the bounds hold only up to that sampling noise - except when the removal
   * is of a certain player, which leaves `k` and the `unc` order untouched and keeps
   * monotonicity exact. See `CLAUDE.md`.
   *
   * Both bounds, and `trim`'s exactness, also assume per-week projections stay ≥ 0:
   * `bestLineup` seats every player it can and adds his value unconditionally, so a
   * negative projection would let a removal raise the lineup and break the bounds as
   * upper bounds. Every transform on this branch (shrinkage, the environment factor,
   * the calibration slope) keeps projections non-negative; a future signed adjustment
   * must reckon with this before it ships.
   *
   * Measured on the fixture: 7.3 s against 72.2 s unpruned, and the reference test
   * proves the two answer sets are identical - 0 missing, 0 extra, 0 value mismatch.
   * There is no recall trade here; do not add one.
   */
  async findTwoForOne(minGain = 0.05, onProgress = () => {}) {
    const out = [];
    const pairs = [];
    for (const A of this.teams) for (const B of this.teams) if (A !== B) pairs.push([A, B]);
    // marginals depend on (sender, pair sent) only, so they are shared across the
    // nine partners that sender faces.
    const margOf = new Map();
    let groups = 0;
    for (let n = 0; n < pairs.length; n++) {
      const [A, B] = pairs[n];
      const ra = this.roster.get(A), rb = this.roster.get(B);
      const bA = this._wmean(ra), bB = this._wmean(rb);
      for (let x = 0; x < ra.length; x++) for (let y = x + 1; y < ra.length; y++) {
        const two = [ra[x], ra[y]];
        if (++groups % YIELD_GROUPS === 0) await yieldToBrowser();
        const kept = ra.filter((i) => i !== two[0] && i !== two[1]);
        const ck = `${A}\0${two[0]}\0${two[1]}`;
        let marg = margOf.get(ck);
        if (!marg) {
          const v0 = this._wmean(kept);
          marg = this.backfillPool()
            .map((c) => [c, this._wmean(kept.concat([c])) - v0])
            .sort((p, q) => q[1] - p[1]);
          margOf.set(ck, marg);
        }
        const mMax = marg.length ? marg[0][1] : 0;
        for (const one of rb) {
          const withOne = kept.concat([one]);
          const aBase = this._wmean(withOne);
          if (aBase + mMax - bA < minGain - GATE_EPS) continue;
          const recv = rb.filter((i) => i !== one).concat(two);
          const bUp = this._wmean(recv);
          if (bUp - bB < minGain - GATE_EPS) continue;
          const bf = this._backfillFrom(withOne, aBase, marg);
          if (!this.legal(bf.ids)) continue;
          const sa = this._metrics(A, bf.ids);
          if (sa.gain < minGain) continue;
          const tr = this.trim(recv, two, bUp);
          // A receiver two men over a position cap has no single legal drop: every
          // removal still leaves him one over, so trim hands the roster back whole.
          if (tr.drop === null || !this.legal(tr.ids)) continue;
          if (tr.val - bB < minGain - GATE_EPS) continue;
          const sb = this._metrics(B, tr.ids);
          if (sb.gain < minGain) continue;
          sa.sent = two; sa.received = [one];
          sa.backfill = bf.fa; sa.drop = null; sa.final = bf.ids;
          sb.sent = [one]; sb.received = two;
          sb.backfill = null; sb.drop = tr.drop; sb.final = tr.ids;
          out.push({
            shape: "2-for-1", sides: [sa, sb], total: sa.gain + sb.gain,
            balance: Math.min(sa.gain, sb.gain) / Math.max(sa.gain, sb.gain),
          });
        }
      }
      onProgress(n + 1, pairs.length, out.length);
      await yieldToBrowser();
    }
    return out.sort((a, b) => b.total - a.total);
  }

  /**
   * What every man on a roster is worth to keep, and what the wire would replace him
   * with.
   *
   * `cost` is what the optimal lineup loses if he goes - zero for anyone the lineup
   * never seats, which is most of a bench and is exactly the point. Ascending, so the
   * first row is the safest cut. `net` is what the whole move is worth: the add minus
   * the cost, which is the number that decides whether to make it.
   */
  dropCandidates(team) {
    const ids = this.roster.get(team);
    const base = this.baseline.get(team);
    const rows = [];
    for (const i of ids) {
      const without = ids.filter((x) => x !== i);
      // copy: `backfill` writes through the same shared buffer `weekly` just filled
      const w = Float64Array.from(this.weekly(without, this._buf));
      const avg = (m) => {
        let s = 0, n = 0;
        for (let x = 0; x < this.NW; x++) if (!m || m[x]) { s += base[x] - w[x]; n++; }
        return n ? s / n : 0;
      };
      const cost = avg(null);
      const bf = this.backfill(without);
      rows.push({ i, cost, reg: avg(this.regMask), playoff: avg(this.poMask),
                  add: bf.fa, addGain: bf.gain, net: bf.gain - cost });
    }
    return rows.sort((a, b) => a.cost - b.cost);
  }

  /**
   * Attach measured per-player volatility. Sigma for a team-week is the root of the
   * summed variance of that week's STARTERS, so a roster of steady players is less
   * swingy than a boom-or-bust one - which a single league-wide constant cannot say.
   */
  setVolatility(vol) {
    this.sigmaOf = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const id = this.ids[i];
      const pos = this._posOf?.get(i);
      this.sigmaOf[i] = vol.bySigma.get(id)
        ?? vol.byPos.get(pos)
        ?? vol.global;
    }
    this._teamSigma = null;
    this.volatility = vol;
  }

  /** (n_weeks,) sigma for a team, from the players it would actually start. */
  teamSigma(team) {
    if (!this.sigmaOf) return null;
    this._teamSigma ??= new Map();
    if (!this._teamSigma.has(team)) this._teamSigma.set(team, this.rosterSigma(this.roster.get(team)));
    return this._teamSigma.get(team);
  }

  /** Same, for any roster - a trade changes who starts, so it changes the spread. */
  rosterSigma(ids) {
    if (!this.sigmaOf) return null;
    const mask = this.starterMask(ids);
    const out = new Float64Array(this.NW);
    // A man who may not play contributes his variance in proportion to his chance of
    // playing, so an OUT starter adds none - the spread has to follow availability
    // as well as roster composition, or a shelved team looks as swingy as a whole one.
    //
    // Teammates do not score independently, so when `rhoOf` has been attached (see
    // distribution.js) the pairwise covariances are added too:
    //   sigma^2 = sum(p_i sigma_i^2) + 2 sum_{i<j} rho_ij sqrt(p_i p_j) sigma_i sigma_j
    // Each player's effective deviation that week is sqrt(p_i) * sigma_i, and the
    // covariance term uses the same one, so availability and correlation compose
    // without either having to know about the other. With no `rhoOf` attached this
    // is character for character the arithmetic it has always been.
    const av = this.avail;
    const sd = [];
    for (let w = 0; w < this.NW; w++) {
      let v = 0;
      sd.length = 0;
      for (const [i, m] of mask) {
        if (!m[w]) continue;
        const p = av ? av[i * this.NW + w] : 1;
        v += p * this.sigmaOf[i] ** 2;
        if (this.rhoOf) sd.push(i, Math.sqrt(p) * this.sigmaOf[i]);
      }
      if (this.rhoOf) {
        for (let x = 0; x < sd.length; x += 2) {
          for (let y = x + 2; y < sd.length; y += 2) {
            const r = this.rhoOf(sd[x], sd[y], w);
            if (r) v += 2 * r * sd[x + 1] * sd[y + 1];
          }
        }
      }
      out[w] = Math.sqrt(Math.max(0, v));
    }
    return out;
  }

  /**
   * Who each team plays each week. `schedule` is week -> [[a, b], ...] from
   * loadSchedule; weeks without a game (playoffs, or no schedule at all) are null and
   * fall back to all-play in weekWins.
   */
  setSchedule(schedule) {
    this.opp = new Map(this.teams.map(t => [t, new Array(this.NW).fill(null)]));
    for (let w = 0; w < this.NW; w++) {
      for (const [a, b] of schedule.get(this.weeks[w]) ?? []) {
        if (this.opp.has(a) && this.opp.has(b)) { this.opp.get(a)[w] = b; this.opp.get(b)[w] = a; }
      }
    }
    this._baseWins = null;
  }

  _state(team, world) {
    const o = world.get(team);
    return {
      mu: o?.mu ?? this.baseline.get(team),
      sigma: o?.sigma ?? this.teamSigma(team),
    };
  }
  _sig(st, w) { const v = st.sigma?.[w]; return v > 0 ? v : FALLBACK_SIGMA; }

  /**
   * P(win) per week for each team in `teams`, with `world` overriding any team's
   * (mu, sigma) - the post-trade rosters. Both teams in a game read from `world`, so
   * two trading partners who meet are both evaluated after the trade.
   */
  weekWins(teams, world) {
    const out = new Map();
    for (const t of teams) {
      const me = this._state(t, world);
      const p = new Float64Array(this.NW);
      for (let w = 0; w < this.NW; w++) {
        const o = this.opp?.get(t)?.[w];
        if (o) {
          const them = this._state(o, world);
          p[w] = winProb(me.mu[w], this._sig(me, w), them.mu[w], this._sig(them, w));
        } else {
          let s = 0, n = 0;
          for (const u of this.teams) {
            if (u === t) continue;
            const them = this._state(u, world);
            s += winProb(me.mu[w], this._sig(me, w), them.mu[w], this._sig(them, w)); n++;
          }
          p[w] = n ? s / n : NaN;
        }
      }
      out.set(t, p);
    }
    return out;
  }

  /** dP(win)/dPoint per week for a team's current roster. */
  weekLeverage(team) {
    const me = this._state(team, new Map());
    const out = new Float64Array(this.NW);
    for (let w = 0; w < this.NW; w++) {
      const o = this.opp?.get(team)?.[w];
      if (o) {
        const them = this._state(o, new Map());
        out[w] = leverage(me.mu[w], this._sig(me, w), them.mu[w], this._sig(them, w));
      } else {
        let s = 0, n = 0;
        for (const u of this.teams) {
          if (u === team) continue;
          const them = this._state(u, new Map());
          s += leverage(me.mu[w], this._sig(me, w), them.mu[w], this._sig(them, w)); n++;
        }
        out[w] = n ? s / n : 0;
      }
    }
    return out;
  }

  /**
   * Fill `win` and `winWeekly` on every side. Runs on the survivors of the exact
   * search, never inside it: each side costs one extra lineup solve for its sigma.
   * Yields to the browser between groups like the searches do.
   */
  async enrich(trades, onProgress = () => {}) {
    if (!this.opp) this.setSchedule(new Map());
    this._baseWins ??= this.weekWins(this.teams, new Map());
    for (let n = 0; n < trades.length; n++) {
      const t = trades[n];
      if (!t) continue;
      const world = new Map();
      for (const s of t.sides) {
        // A 2-for-1 side ends at the waiver wire, so its final roster is not the one
        // (sent, received) describes. Every other shape has no `final` and is unchanged.
        const ids = s.final ?? this.swap(this.roster.get(s.team), s.sent, s.received);
        world.set(s.team, { mu: this.weekly(ids, new Float64Array(this.NW)), sigma: this.rosterSigma(ids) });
      }
      const after = this.weekWins(t.sides.map(s => s.team), world);
      for (const s of t.sides) {
        const a = after.get(s.team), b = this._baseWins.get(s.team);
        s.winWeekly = [];
        let win = 0;
        for (let w = 0; w < this.NW; w++) {
          const d = (a[w] || 0) - (b[w] || 0);
          s.winWeekly.push(d);
          if (this.regMask[w]) win += d;
        }
        s.win = win;
      }
      if (n % 25 === 24) { onProgress(n + 1, trades.length); await yieldToBrowser(); }
    }
    if (trades.length) onProgress(trades.length, trades.length);
  }

  /** Roster indices belonging to no team - i.e. the free agents. */
  get freeAgents() {
    if (!this._fa) {
      const owned = new Set();
      for (const t of this.teams) for (const i of this.roster.get(t)) owned.add(i);
      this._fa = [];
      for (let i = 0; i < this.n; i++) if (!owned.has(i) && this.mask[i]) this._fa.push(i);
    }
    return this._fa;
  }

  /**
   * Free agents who would improve a roster.
   *
   * A roster is full, so a pickup is really a swap: the value of adding someone is
   * what he is worth *after* dropping the player he makes redundant. Reporting the
   * raw projection instead would recommend a kicker nobody would ever start.
   */
  freeAgentUpgrades(team, { minGain = 0.05, limit = 30 } = {}) {
    const ids = this.roster.get(team);
    const base = this.baseline.get(team);
    const thin = this.thin.get(team);
    const mean = (arr, m) => {
      let s = 0, n = 0;
      for (let w = 0; w < this.NW; w++) if (!m || m[w]) { s += arr[w] - base[w]; n++; }
      return n ? s / n : 0;
    };
    const out = [];
    for (const fa of this.freeAgents) {
      let best = null;
      for (const drop of ids) {
        const after = this.swap(ids, [drop], [fa]);
        if (!this.legal(after)) continue;
        const w = this.weekly(after);
        const g = mean(w);
        if (!best || g > best.gain) best = { drop, gain: g, after: Float64Array.from(w) };
      }
      if (best && best.gain >= minGain) {
        const d = [];
        for (let w = 0; w < this.NW; w++) d.push(best.after[w] - base[w]);
        out.push({
          fa, drop: best.drop, gain: best.gain,
          reg: mean(best.after, this.regMask), playoff: mean(best.after, this.poMask),
          bye: mean(best.after, thin), weekly: d,
        });
      }
    }
    return out.sort((a, b) => b.gain - a.gain).slice(0, limit);
  }

  /** Per-week start mask for a roster: playerIdx -> Uint8Array(NW). */
  starterMask(ids) {
    const vals = this._vals;
    const out = new Map(ids.map(i => [i, new Uint8Array(this.NW)]));
    for (let w = 0; w < this.NW; w++) {
      const use = this._likely(ids, w);
      for (const i of use) vals[i] = this.proj[i * this.NW + w];
      const order = use.slice().sort((a, b) => vals[b] - vals[a]);
      for (const p of seatsOf(order, vals, this.mask, this.starters))
        if (p >= 0) out.get(p)[w] = 1;
    }
    return out;
  }

  /**
   * Why a trade works, per side. Answers the question the point delta cannot:
   * does the incoming player actually crack this lineup, and who does he push out?
   */
  explain(trade) {
    const detail = {};
    for (const side of trade.sides) {
      const ids = this.roster.get(side.team);
      const before = this.starterMask(ids);
      const after = this.starterMask(side.final ?? this.swap(ids, side.sent, side.received));
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const cnt = (m, i) => (m.get(i) ? sum([...m.get(i)]) : 0);

      const moved = [];
      for (const i of ids) {
        if (side.sent.includes(i)) continue;
        const d = cnt(after, i) - cnt(before, i);
        if (d !== 0) moved.push({ i, delta: d });
      }
      moved.sort((a, b) => a.delta - b.delta);

      detail[side.team] = {
        acquired: side.received.map(i => ({
          i,
          startsHere: cnt(after, i),
          // how often he starts on the roster that owns him today
          startsThere: cnt(this.starterMask(this.roster.get(this.ownerOf(i))), i),
          now: [...(this.starterMask(this.roster.get(this.ownerOf(i))).get(i) ?? [])]
                 .map((v, w) => (this.bye[i] === this.weeks[w] ? -1 : v)),
          after: [...(after.get(i) ?? [])]
                 .map((v, w) => (this.bye[i] === this.weeks[w] ? -1 : v)),
          proj: Array.from({ length: this.NW }, (_, w) => this.proj[i * this.NW + w]),
        })),
        // Outgoing players need their usage strip too: a partner cannot judge a
        // trade from what arrives alone, they have to see what leaves.
        sent: side.sent.map(i => ({
          i,
          wasStarting: cnt(before, i),
          now: [...(before.get(i) ?? [])]
                 .map((v, w) => (this.bye[i] === this.weeks[w] ? -1 : v)),
          proj: Array.from({ length: this.NW }, (_, w) => this.proj[i * this.NW + w]),
        })),
        displaced: moved.filter(m => m.delta < 0).slice(0, 3),
        promoted: moved.filter(m => m.delta > 0).slice(-3).reverse(),
        thin: this.thin.get(side.team),
      };

      // The waiver add and the drop are part of the trade's arithmetic, so the panel
      // has to be able to name them and say how often each one plays.
      if (side.backfill != null)
        detail[side.team].backfill = { i: side.backfill, startsHere: cnt(after, side.backfill) };
      if (side.drop != null)
        detail[side.team].dropped = { i: side.drop, wasStarting: cnt(before, side.drop) };
    }
    return detail;
  }

  ownerOf(i) {
    if (!this._owner) {
      this._owner = new Map();
      for (const t of this.teams) for (const j of this.roster.get(t)) this._owner.set(j, t);
    }
    return this._owner.get(i);
  }

  /** Fraction of weeks each player starts on the team that owns him. */
  startRates() {
    const rates = new Map();
    for (const t of this.teams) {
      const ids = this.roster.get(t);
      const vals = this._vals;
      const count = new Map(ids.map(i => [i, 0]));
      for (let w = 0; w < this.NW; w++) {
        const use = this._likely(ids, w);
        for (const i of use) vals[i] = this.proj[i * this.NW + w];
        const order = use.slice().sort((a, b) => vals[b] - vals[a]);
        const seats = seatsOf(order, vals, this.mask, this.starters);
        for (const p of seats) if (p >= 0) count.set(p, count.get(p) + 1);
      }
      for (const [i, c] of count) rates.set(i, c / this.NW);
    }
    return rates;
  }
}

function seatsOf(order, values, masks, nSeats) {
  const seatOf = new Int32Array(nSeats).fill(-1);
  const seen = new Uint8Array(nSeats);
  const assign = (p) => {
    for (let s = 0; s < nSeats; s++) {
      if (!(masks[p] & (1 << s)) || seen[s]) continue;
      seen[s] = 1;
      if (seatOf[s] === -1 || assign(seatOf[s])) { seatOf[s] = p; return true; }
    }
    return false;
  };
  let filled = 0;
  for (const p of order) {
    if (filled >= nSeats) break;
    if (!masks[p]) continue;
    seen.fill(0);
    if (assign(p)) filled++;
  }
  return seatOf;
}

export function dedupe(trades, perGroup = 3) {
  const seen = new Map(), out = [];
  for (const t of trades) {
    const key = t.sides.map(s => s.team).sort().join("|");
    const kept = seen.get(key) ?? [];
    if (kept.length >= perGroup) continue;
    const pkg = new Set(t.sides.flatMap(s => s.sent));
    const overlap = kept.some(prev => [...pkg].filter(p => prev.has(p)).length >= Math.max(1, Math.floor(pkg.size / 2)));
    if (overlap) continue;
    kept.push(pkg); seen.set(key, kept); out.push(t);
  }
  return out;
}

function* combos(arr, k) {
  if (k === 1) { for (const a of arr) yield [a]; return; }
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) yield [arr[i], arr[j]];
}
