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

    this.teams = [...model.teams.values()].map(t => t.name);
    this.roster = new Map();
    for (const t of model.teams.values()) {
      this.roster.set(t.name, [...t.roster].map(id => this.index.get(id)).filter(i => i !== undefined));
    }

    const reg = new Set(this.settings.regularSeasonWeeks);
    const po = new Set(this.settings.playoffWeeks);
    this.regMask = this.weeks.map(w => reg.has(w));
    this.poMask = this.weeks.map(w => po.has(w));

    this._vals = new Float64Array(this.n);   // scratch; must exist before weekly()
    this.baseline = new Map();
    for (const t of this.teams) this.baseline.set(t, this.weekly(this.roster.get(t)));

    // thin weeks: enough of a roster on bye that it starts players it would bench
    this.thin = new Map();
    for (const t of this.teams) {
      const ids = this.roster.get(t);
      this.thin.set(t, this.weeks.map(w => ids.filter(i => this.bye[i] === w).length >= 2));
    }
  }

  /** Best started points per week for a roster. */
  weekly(ids, out) {
    const res = out ?? new Float64Array(this.NW);
    const vals = this._vals;
    for (let w = 0; w < this.NW; w++) {
      for (const i of ids) vals[i] = this.proj[i * this.NW + w];
      const order = ids.slice().sort((a, b) => vals[b] - vals[a]);
      res[w] = bestLineup(order, vals, this.mask, this.starters);
    }
    return res;
  }

  swap(ids, out, inn) {
    const drop = new Set(out);
    const kept = ids.filter(i => !drop.has(i));
    return kept.concat(inn);
  }

  /** Per-team swap table: value after (out -> in). Makes three-way a lookup. */
  buildSwapTable() {
    if (this._swaps) return this._swaps;
    const tab = new Map();
    for (const t of this.teams) {
      const ids = this.roster.get(t);
      const own = new Set(ids);
      const incoming = [];
      for (let i = 0; i < this.n; i++) if (!own.has(i)) incoming.push(i);
      const m = new Map();
      for (const o of ids) {
        const kept = ids.filter(x => x !== o);
        const row = new Map();
        for (const p of incoming) row.set(p, Float64Array.from(this.weekly(kept.concat([p]))));
        m.set(o, row);
      }
      tab.set(t, m);
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
      bye: avg(d, thin), full: avg(d, thin.map(x => !x)), win: 0,
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
    const sides = [...sent.keys()].map(t => this.sideMetrics(t, sent.get(t), recv.get(t)));
    return { shape, sides, total: sides.reduce((a, s) => a + s.gain, 0),
             balance: Math.min(...sides.map(s => s.gain)) / Math.max(...sides.map(s => s.gain)) };
  }

  /** Symmetric two-team search, `depth` players per side. */
  findTwoTeam(depth, minGain = 0.05, onProgress = () => {}) {
    const out = [];
    const pairs = [];
    for (let i = 0; i < this.teams.length; i++)
      for (let j = i + 1; j < this.teams.length; j++) pairs.push([this.teams[i], this.teams[j]]);
    pairs.forEach(([A, B], n) => {
      for (const sa of combos(this.roster.get(A), depth))
        for (const sb of combos(this.roster.get(B), depth)) {
          const t = this.score([[A, B, sa], [B, A, sb]], `${depth}-for-${depth}`);
          if (t.sides.every(s => s.gain >= minGain)) out.push(t);
        }
      onProgress(n + 1, pairs.length, out.length);
    });
    return out.sort((a, b) => b.total - a.total);
  }

  /** Exhaustive one-player-each cycles, both directions. */
  findThreeWay(minGain = 0.05, onProgress = () => {}) {
    const tab = this.buildSwapTable();
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
    triples.forEach((tri, n) => {
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
            out.push(this.score([[A, B, [pa]], [B, C, [pb]], [C, A, [pc]]], "three-way"));
          }
        }
      }
      onProgress(n + 1, triples.length, out.length);
    });
    return out.sort((a, b) => b.total - a.total);
  }

  /** Fraction of weeks each player starts on the team that owns him. */
  startRates() {
    const rates = new Map();
    for (const t of this.teams) {
      const ids = this.roster.get(t);
      const vals = this._vals;
      const count = new Map(ids.map(i => [i, 0]));
      for (let w = 0; w < this.NW; w++) {
        for (const i of ids) vals[i] = this.proj[i * this.NW + w];
        const order = ids.slice().sort((a, b) => vals[b] - vals[a]);
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
