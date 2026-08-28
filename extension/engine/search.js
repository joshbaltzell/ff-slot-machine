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

  sideMetrics(team, out, inn) {
    const now = this.weekly(this.swap(this.roster.get(team), out, inn));
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
      team, sent: out, received: inn, weekly: d,
      gain: avg(d), reg: avg(d, this.regMask), playoff: avg(d, this.poMask),
      bye: avg(d, thin), full: avg(d, thin.map(x => !x)), win: 0, winWeekly: null,
    };
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

  /** Symmetric two-team search, `depth` players per side. Yields between pairs. */
  async findTwoTeam(depth, minGain = 0.05, onProgress = () => {}) {
    const out = [];
    const pairs = [];
    for (let i = 0; i < this.teams.length; i++)
      for (let j = i + 1; j < this.teams.length; j++) pairs.push([this.teams[i], this.teams[j]]);
    for (let n = 0; n < pairs.length; n++) {
      const [A, B] = pairs[n];
      for (const sa of combos(this.roster.get(A), depth))
        for (const sb of combos(this.roster.get(B), depth)) {
          const t = this.score([[A, B, sa], [B, A, sb]], `${depth}-for-${depth}`);
          if (t && t.sides.every(s => s.gain >= minGain)) out.push(t);
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
    const av = this.avail;
    for (let w = 0; w < this.NW; w++) {
      let v = 0;
      for (const [i, m] of mask)
        if (m[w]) v += (av ? av[i * this.NW + w] : 1) * this.sigmaOf[i] ** 2;
      out[w] = Math.sqrt(v);
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
        const ids = this.swap(this.roster.get(s.team), s.sent, s.received);
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
      const after = this.starterMask(this.swap(ids, side.sent, side.received));
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
