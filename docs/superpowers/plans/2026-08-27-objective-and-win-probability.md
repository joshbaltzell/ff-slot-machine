# Phase 1 — Objective and Win Probability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank trades by what they do to wins, byes and title odds instead of points; reject rosters ESPN would not allow; calibrate ESPN projections before the engine sees them.

**Architecture:** Three small new engine modules (`calibrate.js`, `winprob.js`, `odds.js`) feed the existing `Engine` and `projectSeason`. The exact search is untouched; win metrics are attached in an `enrich` pass over its survivors, and season-odds deltas come from paired (common-random-number) runs of the already-deterministic Monte Carlo. The panel gains an objective select, three columns, a leverage strip and a calibration toggle.

**Tech Stack:** Plain ES modules, no build step, Chrome MV3 extension page. Tests are `node extension/test/parity.mjs` (custom `ok()` assertions, no framework).

**Spec:** `docs/superpowers/specs/2026-08-27-objective-and-win-probability-design.md`

## Global Constraints

- The engine models slots, not positions. `positionLimits` is an ESPN *setting* keyed on ESPN's `defaultPositionId`; read it, never derive it, never use position for lineup logic.
- Nothing in the search approximates. Legality is a filter on `score()` output; win/odds metrics run only on survivors.
- Searches and any loop over hundreds of trades must yield a macrotask (`setTimeout(r, 0)`) between groups — a microtask is not enough for the browser to paint.
- The 371 existing assertions in `extension/test/parity.mjs` must keep passing unchanged. Run with shrinkage off (the fixture has no `positionLimits`).
- Time windows stay separate: the objective toggle changes the sort and headline, never removes a column.
- No new network calls, no backend, nothing leaves the machine.
- Commit messages: imperative subject, end with the trailer block used in this repo:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
  ```

## File structure

| File | Responsibility | Status |
|---|---|---|
| `extension/engine/league.js` | ESPN → model. Adds `posId` to player records. | modify |
| `extension/engine/calibrate.js` | `shrinkProjections` and the literature slopes. Pure function over the players map. | create |
| `extension/engine/winprob.js` | Normal CDF/PDF, `winProb`, `leverage`. No engine knowledge. | create |
| `extension/engine/search.js` | `Engine`: `posId`, `legal()`, `rosterSigma()`, `setSchedule()`, `weekWins()`, `weekLeverage()`, `enrich()`. `score()` returns `null` when illegal. | modify |
| `extension/engine/season.js` | `projectSeason` gains `override` and `batches` options. | modify |
| `extension/engine/odds.js` | `tradeOdds` and `attachOdds`: paired season sims per trade with batch standard errors. | create |
| `extension/panel.js` | Objective select, new columns, odds loading step, leverage strip, calibration toggle, hints. | modify |
| `extension/panel.css` | Styles for the leverage strip. | modify |
| `extension/test/parity.mjs` | New sections 4–8 appended after the season invariants. | modify |
| `CLAUDE.md` | Architecture map and one new load-bearing decision. | modify |

Test helper convention: the file already defines `ok(cond, what)`, `F` (fixture), `model`, `eng`, `masks`, `starters`, `NW`. New sections use them and are appended before the final `console.log` summary lines.

---

### Task 1: Enforce `positionLimits`

**Files:**
- Modify: `extension/engine/league.js` (player records in `loadLeague` ~line 316 and `loadFreeAgents` ~line 289)
- Modify: `extension/engine/search.js` (constructor, `score`, `findTwoTeam`, `findThreeWay`, `freeAgentUpgrades`)
- Test: `extension/test/parity.mjs`

**Interfaces:**
- Consumes: `model.settings.positionLimits` (object `{ "<defaultPositionId>": max }` or `null`), already returned by `readSettings`.
- Produces: player records carry `posId: number`; `Engine.posId: Int32Array`; `Engine.legal(ids: number[]): boolean`; `Engine.score(...)` returns `null` for an illegal trade.

Assumption (state it in a comment): a limit value `<= 0` means unlimited. ESPN uses `-1` for unlimited and `0` for positions no roster contains.

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/parity.mjs` immediately before the line `console.log(\`\n${checks} assertions, ${failures} failures\`);`:

```js
/* ---- 4. positionLimits: an ESPN setting, applied as a filter on results ---- */
{
  // Give every fixture position an integer id, the way ESPN's defaultPositionId works.
  const POS_ID = Object.fromEntries([...new Set(F.pos)].map((p, i) => [p, i + 1]));
  const withIds = (limits) => ({
    ...model,
    settings: { ...model.settings, positionLimits: limits },
    players: new Map([...model.players].map(([id, p]) => [id, { ...p, posId: POS_ID[p.pos] }])),
  });
  const mk = (limits) => new Engine(withIds(limits), { starters },
    new Map(F.pos.map((p, i) => [i, masks[i]])));

  const free = mk(null);
  ok(free.legal(free.roster.get(F.teams[0])), "no limits: every roster is legal");

  // Cap RBs at exactly what the first team carries today. Any trade that hands
  // them one more RB without taking one away must vanish; nothing else may change.
  const team0 = F.teams[0];
  const rbCount = F.rosters[team0].filter((i) => F.pos[i] === "RB").length;
  const capped = mk({ [POS_ID.RB]: rbCount });
  ok(capped.legal(capped.roster.get(team0)), "a roster at the cap is legal");
  const rbIdx = F.rosters[team0].find((i) => F.pos[i] === "RB");
  const wrIdx = F.rosters[team0].find((i) => F.pos[i] === "WR");
  const extraRb = F.rosters[F.teams[1]].find((i) => F.pos[i] === "RB");
  ok(!capped.legal(capped.swap(capped.roster.get(team0), [wrIdx], [extraRb])),
     "WR out, RB in over the cap is illegal");
  ok(capped.legal(capped.swap(capped.roster.get(team0), [rbIdx], [extraRb])),
     "RB out, RB in stays legal");
  ok(capped.score([[team0, F.teams[1], [wrIdx]], [F.teams[1], team0, [extraRb]]], "1-for-1") === null,
     "score() returns null for an illegal trade");
  ok(capped.score([[team0, F.teams[1], [rbIdx]], [F.teams[1], team0, [extraRb]]], "1-for-1") !== null,
     "score() still scores a legal trade");

  const allFree = await free.findTwoTeam(1, 0.05);
  const allCapped = await capped.findTwoTeam(1, 0.05);
  ok(allFree.length === GOLDEN.length, "posId on players does not change the golden set");
  ok(allCapped.length < allFree.length, "the cap removes at least one trade");
  ok(allCapped.every((t) => t.sides.every((s) =>
       capped.legal(capped.swap(capped.roster.get(s.team), s.sent, s.received)))),
     "every surviving trade is legal for every side");
  const keyOf = (t) => JSON.stringify(t.sides.map((s) => [s.team, s.sent, s.received]));
  const kept = new Set(allCapped.map(keyOf));
  ok(allFree.filter((t) => !kept.has(keyOf(t))).every((t) => t.sides.some((s) =>
       !capped.legal(capped.swap(capped.roster.get(s.team), s.sent, s.received)))),
     "every removed trade was illegal for some side");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/parity.mjs`
Expected: `TypeError: free.legal is not a function` (the earlier 371 assertions still print no FAIL lines before it).

- [ ] **Step 3: Record `posId` on player records in `league.js`**

In `loadLeague`, the object literal starting `const pl = players.get(p.id) ?? {` gains one field after `pos: positionLabel(p),`:

```js
          posId: p.defaultPositionId ?? 0,
```

In `loadFreeAgents`, the `out.push({ ... })` literal gains the same field after `pos: positionLabel(p),`:

```js
      posId: p.defaultPositionId ?? 0,
```

- [ ] **Step 4: Add `posId`, `limits` and `legal()` to the engine**

In `extension/engine/search.js`, in the constructor directly after the loop that fills `this.proj` (after `for (const [id, p] of model.players) { ... }`), add:

```js
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
```

Add the method after `swap(ids, out, inn) { ... }`:

```js
  /** Would ESPN allow this roster? False when any limited position exceeds its cap. */
  legal(ids) {
    if (!this.limits.length) return true;
    const c = this._limitCount;
    c.fill(0);
    for (const i of ids) c[this.posId[i]]++;
    for (const [pid, max] of this.limits) if (c[pid] > max) return false;
    return true;
  }
```

- [ ] **Step 5: Make `score()` return `null` for illegal trades and skip nulls in the searches**

Replace the body of `score(moves, shape)` with:

```js
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
```

In `findTwoTeam`, change

```js
          if (t.sides.every(s => s.gain >= minGain)) out.push(t);
```
to
```js
          if (t && t.sides.every(s => s.gain >= minGain)) out.push(t);
```

In `findThreeWay`, change

```js
            out.push(this.score([[A, B, [pa]], [B, C, [pb]], [C, A, [pc]]], "three-way"));
```
to
```js
            const t = this.score([[A, B, [pa]], [B, C, [pb]], [C, A, [pc]]], "three-way");
            if (t) out.push(t);
```

In `freeAgentUpgrades`, inside `for (const drop of ids) {`, replace

```js
        const w = this.weekly(this.swap(ids, [drop], [fa]));
```
with
```js
        const after = this.swap(ids, [drop], [fa]);
        if (!this.legal(after)) continue;
        const w = this.weekly(after);
```

- [ ] **Step 6: Run the tests**

Run: `node extension/test/parity.mjs`
Expected: last lines `… assertions, 0 failures` and `ENGINE OK`. The count is now 371 + 11 = 382.

- [ ] **Step 7: Commit**

```bash
git add extension/engine/league.js extension/engine/search.js extension/test/parity.mjs
git commit -m "Reject trades that break ESPN's positionLimits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 2: Projection shrinkage (`calibrate.js`)

**Files:**
- Create: `extension/engine/calibrate.js`
- Test: `extension/test/parity.mjs`

**Interfaces:**
- Consumes: the model's `players: Map<id, {pos, proj: {week: number}}>` and `weeks: number[]`.
- Produces: `CALIBRATION_K` (object pos → slope) and `shrinkProjections(players, weeks, k = CALIBRATION_K): { changed: number, k }`. Mutates `proj` in place; a player whose `pos` is absent from `k` is untouched.

- [ ] **Step 1: Write the failing tests**

Add the import at the top of `extension/test/parity.mjs` after the `projectSeason` import:

```js
import { shrinkProjections, CALIBRATION_K } from "../engine/calibrate.js";
```

Append before the summary lines:

```js
/* ---- 5. shrinkage: pull projections toward the positional mean ---- */
{
  const clone = () => new Map([...model.players].map(([id, p]) => [id, { ...p, proj: { ...p.proj } }]));
  const flat = (m) => [...m.values()].map((p) => F.weeks.map((w) => p.proj[w]));

  const same = clone();
  shrinkProjections(same, F.weeks, { RB: 1, WR: 1, TE: 1, QB: 1, TQB: 1 });
  ok(JSON.stringify(flat(same)) === JSON.stringify(flat(model.players)), "k = 1 is the identity");

  const half = clone();
  const r = shrinkProjections(half, F.weeks, { RB: 0.5 });
  ok(r.changed > 0, "reports how many players changed");
  const rbs = [...model.players.values()].filter((p) => p.pos === "RB");
  for (const w of F.weeks.slice(0, 3)) {
    const live = rbs.filter((p) => p.proj[w] > 0);
    const mean = live.reduce((a, p) => a + p.proj[w], 0) / live.length;
    for (const p of live) {
      const before = p.proj[w] - mean, after = half.get(p.id).proj[w] - mean;
      ok(Math.abs(after - before / 2) < 0.011, `RB deviation halved wk${w} p${p.id}`);
    }
    // order within the position is preserved
    const orderA = live.map((p) => p.id).sort((a, b) => model.players.get(b).proj[w] - model.players.get(a).proj[w]);
    const orderB = live.map((p) => p.id).sort((a, b) => half.get(b).proj[w] - half.get(a).proj[w]);
    ok(orderA.join() === orderB.join(), `RB order preserved wk${w}`);
    ok(rbs.filter((p) => !(p.proj[w] > 0)).every((p) => half.get(p.id).proj[w] === p.proj[w]),
       `bye zeros untouched wk${w}`);
  }
  const wr = [...model.players.values()].find((p) => p.pos === "WR");
  ok(half.get(wr.id).proj[F.weeks[0]] === wr.proj[F.weeks[0]], "positions absent from k are untouched");
  ok(CALIBRATION_K.QB === 0.67 && CALIBRATION_K.RB === 0.79 && CALIBRATION_K.WR === 0.85 && CALIBRATION_K.TE === 0.72,
     "literature slopes are the defaults");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/parity.mjs`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../engine/calibrate.js'`.

- [ ] **Step 3: Create `calibrate.js`**

```js
/**
 * Calibrate ESPN projections before the engine sees them.
 *
 * Projections are over-spread: regressing actual points on projected points gives
 * slopes below one (season-level, Fantasy Football Analytics, 12 seasons: QB 0.67,
 * TE 0.72, RB 0.79, WR 0.85). The gap between a position's #1 and #5 is smaller in
 * reality than on paper. Shrinking each projection toward its positional mean by the
 * measured slope is the cheapest accuracy available.
 *
 * Applied per week, which is an assumption - the slopes were measured on seasons.
 * Phase 5's calibration log replaces these constants with league-measured ones, so
 * `k` is a plain map and nothing else here knows where the numbers came from.
 *
 * Order within a position is preserved, so no within-position lineup choice changes.
 * Flex competition across positions and every trade value do, which is the point.
 */
export const CALIBRATION_K = { QB: 0.67, RB: 0.79, WR: 0.85, TE: 0.72 };

/**
 * Mutates `proj` on every player whose `pos` is in `k`. The positional mean for a
 * week is taken over players with a non-zero projection, so byes do not drag it.
 * @returns {{changed:number, k:object}}
 */
export function shrinkProjections(players, weeks, k = CALIBRATION_K) {
  const groups = new Map();
  for (const p of players.values()) {
    if (!(p.pos in k)) continue;
    if (!groups.has(p.pos)) groups.set(p.pos, []);
    groups.get(p.pos).push(p);
  }
  let changed = 0;
  for (const [pos, list] of groups) {
    const slope = k[pos];
    if (!(slope >= 0) || slope === 1) continue;
    for (const w of weeks) {
      const live = list.filter((p) => p.proj[w] > 0);
      if (live.length < 2) continue;
      const mean = live.reduce((a, p) => a + p.proj[w], 0) / live.length;
      for (const p of live) p.proj[w] = Math.round((mean + slope * (p.proj[w] - mean)) * 100) / 100;
    }
    changed += list.length;
  }
  return { changed, k };
}
```

- [ ] **Step 4: Run the tests**

Run: `node extension/test/parity.mjs`
Expected: `0 failures`, `ENGINE OK`.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/calibrate.js extension/test/parity.mjs
git commit -m "Add positional shrinkage for ESPN projections

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 3: Analytic win probability (`winprob.js`, `Engine.enrich`)

**Files:**
- Create: `extension/engine/winprob.js`
- Modify: `extension/engine/search.js` (`teamSigma`, new `rosterSigma`, `setSchedule`, `weekWins`, `weekLeverage`, `enrich`; `sideMetrics` gains `winWeekly`)
- Test: `extension/test/parity.mjs`

**Interfaces:**
- Consumes: `Engine.baseline`, `Engine.teamSigma`, `Engine.starterMask`, schedule `Map<week, [[teamA, teamB], ...]>` from `loadSchedule`.
- Produces:
  - `winprob.js`: `Phi(z)`, `phi(z)`, `winProb(mA, sA, mB, sB)`, `leverage(mA, sA, mB, sB)`, `FALLBACK_SIGMA = 25`.
  - `Engine.rosterSigma(ids): Float64Array(NW) | null`
  - `Engine.setSchedule(schedule)` → `Engine.opp: Map<team, (string|null)[]>` indexed by week position.
  - `Engine.weekWins(teams: string[], world: Map<team, {mu: Float64Array, sigma: Float64Array|null}>): Map<team, Float64Array(NW)>` — P(win) per week; `NaN` for weeks with no opponent and no other teams.
  - `Engine.weekLeverage(team): Float64Array(NW)` — dP(win)/dPoint per week, baseline rosters.
  - `Engine.enrich(trades, onProgress): Promise<void>` — fills `side.win` (Δ expected regular-season wins) and `side.winWeekly` (Δ P per week) on every side of every trade.

- [ ] **Step 1: Write the failing tests**

Add the import in `parity.mjs`:

```js
import { Phi, phi, winProb, leverage } from "../engine/winprob.js";
```

Append before the summary lines:

```js
/* ---- 6. win probability ---- */
{
  ok(Math.abs(Phi(0) - 0.5) < 1e-7, "Phi(0) = 0.5");
  ok(Math.abs(Phi(1.96) - 0.9750021) < 1e-5, "Phi(1.96)");
  ok(Math.abs(Phi(-1.96) - 0.0249979) < 1e-5, "Phi(-1.96)");
  ok(Math.abs(phi(0) - 0.3989423) < 1e-6, "phi(0)");
  ok(Math.abs(winProb(100, 20, 90, 20) + winProb(90, 20, 100, 20) - 1) < 1e-9, "winProb is symmetric");
  ok(winProb(100, 0, 90, 0) === 1 && winProb(90, 0, 100, 0) === 0 && winProb(90, 0, 90, 0) === 0.5,
     "zero sigma degenerates to a comparison");
  ok(leverage(100, 20, 100, 20) > leverage(130, 20, 100, 20), "a point is worth more in a close game");

  // Analytic P matches a Monte Carlo of the same normals.
  let seed = 12345;
  const lcg = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const g = () => { let u = 0, v = 0; while (!u) u = lcg(); while (!v) v = lcg();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  let wins = 0; const N = 200000;
  for (let i = 0; i < N; i++) if (105 + 22 * g() > 100 + 18 * g()) wins++;
  ok(Math.abs(wins / N - winProb(105, 22, 100, 18)) < 0.01, "analytic P matches Monte Carlo");

  // Schedule: pair teams 0-1, 2-3, ... every regular-season week.
  const sched = new Map();
  for (const w of model.settings.regularSeasonWeeks) {
    const games = [];
    for (let i = 0; i + 1 < F.teams.length; i += 2) games.push([F.teams[i], F.teams[i + 1]]);
    sched.set(w, games);
  }
  eng.setSchedule(sched);
  ok(eng.opp.get(F.teams[0])[0] === F.teams[1], "opponent lookup follows the schedule");
  const p = eng.weekWins([F.teams[0]], new Map()).get(F.teams[0]);
  const a = eng.baseline.get(F.teams[0])[0], b = eng.baseline.get(F.teams[1])[0];
  ok(Math.abs(p[0] - Phi((a - b) / (25 * Math.SQRT2))) < 1e-9,
     "without measured volatility, P uses the ±25 fallback for both sides");
  const q = eng.weekWins([F.teams[1]], new Map()).get(F.teams[1]);
  ok(Math.abs(p[0] + q[0] - 1) < 1e-9, "the two sides of a game sum to one");
  const lev = eng.weekLeverage(F.teams[0]);
  ok(lev.length === NW && lev[0] > 0 && lev[0] <= 1, "leverage is a positive density per point");

  // Playoff weeks have no scheduled game: all-play fallback, still a probability.
  ok(p[NW - 1] >= 0 && p[NW - 1] <= 1, "unscheduled week falls back to all-play");

  // enrich: a trade that moves nobody changes nothing.
  const nothing = eng.score([[F.teams[0], F.teams[1], []], [F.teams[1], F.teams[0], []]], "1-for-1");
  await eng.enrich([nothing]);
  ok(nothing.sides.every((s) => s.win === 0 && s.winWeekly.every((x) => x === 0)),
     "null trade has zero win delta");

  // enrich a real trade: win deltas exist, are bounded, and match the weekly sum.
  const real = (await eng.findTwoTeam(1, 0.05)).slice(0, 5);
  await eng.enrich(real);
  for (const t of real) for (const s of t.sides) {
    const regSum = s.winWeekly.reduce((acc, x, w) => acc + (eng.regMask[w] ? x : 0), 0);
    ok(Math.abs(s.win - regSum) < 1e-9, "win is the regular-season sum of winWeekly");
    ok(Math.abs(s.win) < model.settings.regularSeasonWeeks.length, "win delta is bounded by games");
  }
  eng.setSchedule(new Map());   // leave the shared engine as other sections expect
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/parity.mjs`
Expected: `ERR_MODULE_NOT_FOUND` for `winprob.js`.

- [ ] **Step 3: Create `winprob.js`**

```js
/**
 * Win probability from two normal score distributions.
 *
 * A week is won by the higher score. With team scores Normal(m, s) and independent,
 * the difference is Normal(mA - mB, sqrt(sA^2 + sB^2)), so
 *
 *   P(A beats B) = Phi((mA - mB) / sqrt(sA^2 + sB^2))
 *
 * and the value of one more point for A that week is the density at that z divided
 * by the same spread - the "leverage" of the week. Both are exact under the model
 * the season simulation already uses, so they agree with it up to Monte Carlo error.
 */

/** Used when no volatility has been measured; matches season.js's default. */
export const FALLBACK_SIGMA = 25;

/** Standard normal CDF. Abramowitz & Stegun 7.1.26; absolute error < 7.5e-8. */
export function Phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
              + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Standard normal PDF. */
export function phi(z) {
  return Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
}

export function winProb(mA, sA, mB, sB) {
  const s = Math.sqrt(sA * sA + sB * sB);
  if (s === 0) return mA > mB ? 1 : mA < mB ? 0 : 0.5;
  return Phi((mA - mB) / s);
}

/** dP(A wins)/d(mA): how much one extra point is worth to A this week. */
export function leverage(mA, sA, mB, sB) {
  const s = Math.sqrt(sA * sA + sB * sB);
  return s === 0 ? 0 : phi((mA - mB) / s) / s;
}
```

- [ ] **Step 4: Add `rosterSigma`, `setSchedule`, `weekWins`, `weekLeverage`, `enrich` to the engine**

At the top of `search.js` add:

```js
import { winProb, leverage, FALLBACK_SIGMA } from "./winprob.js";
```

Replace `teamSigma(team) { ... }` with:

```js
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
    for (let w = 0; w < this.NW; w++) {
      let v = 0;
      for (const [i, m] of mask) if (m[w]) v += this.sigmaOf[i] ** 2;
      out[w] = Math.sqrt(v);
    }
    return out;
  }
```

After `rosterSigma`, add:

```js
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
    onProgress(trades.length, trades.length);
  }
```

In `sideMetrics`, change `win: 0,` to `win: 0, winWeekly: null,` so the field exists before `enrich` runs.

- [ ] **Step 5: Run the tests**

Run: `node extension/test/parity.mjs`
Expected: `0 failures`, `ENGINE OK`.

- [ ] **Step 6: Commit**

```bash
git add extension/engine/winprob.js extension/engine/search.js extension/test/parity.mjs
git commit -m "Score trades by expected wins, not only points

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 4: `projectSeason` overrides and batches (common random numbers)

**Files:**
- Modify: `extension/engine/season.js`
- Test: `extension/test/parity.mjs`

**Interfaces:**
- Consumes: existing `projectSeason(eng, schedule, settings, opts)`.
- Produces: two new options — `override: Map<team, {mu: Float64Array(NW), sigma: Float64Array(NW)|null}>` and `batches: number` (default 1). When `batches > 1` each result row gains `batches: [{wins, playoffPct, byePct, titlePct}]` of length `batches`. Draw order is unchanged, so two runs with the same seed share noise.

- [ ] **Step 1: Write the failing tests**

Append before the summary lines:

```js
/* ---- 7. season: common random numbers, overrides, batches ---- */
{
  const opts = { sims: 4000 };
  const a = projectSeason(eng, new Map(), model.settings, opts);
  const b = projectSeason(eng, new Map(), model.settings, opts);
  ok(JSON.stringify(a) === JSON.stringify(b), "same inputs, bit-identical output");

  const t0 = F.teams[0];
  const mu = Float64Array.from(eng.baseline.get(t0), (x) => x + 5);
  const c = projectSeason(eng, new Map(), model.settings, { ...opts, override: new Map([[t0, { mu, sigma: null }]]) });
  const row = (res, t) => res.find((r) => r.team === t);
  ok(row(c, t0).wins > row(a, t0).wins, "+5 a week raises expected wins");
  ok(row(c, t0).titlePct >= row(a, t0).titlePct, "+5 a week does not lower title odds");
  ok(F.teams.slice(1).every((t) => row(c, t).wins <= row(a, t).wins + 1e-9),
     "nobody else gains from another team's boost");
  ok(Math.abs(c.reduce((s, r) => s + r.titlePct, 0) - 1) < 1e-9, "still one champion per season");

  const d = projectSeason(eng, new Map(), model.settings, { ...opts, batches: 10 });
  ok(d.every((r) => r.batches?.length === 10), "ten batches per team");
  for (const r of d) {
    const avg = (k) => r.batches.reduce((s, x) => s + x[k], 0) / 10;
    ok(Math.abs(avg("titlePct") - r.titlePct) < 1e-9, `batch title odds average to the whole ${r.team}`);
    ok(Math.abs(avg("wins") - r.wins) < 1e-9, `batch wins average to the whole ${r.team}`);
  }
  ok(JSON.stringify(d.map((r) => [r.team, r.wins, r.titlePct])) ===
     JSON.stringify(a.map((r) => [r.team, r.wins, r.titlePct])), "batching does not change the totals");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/parity.mjs`
Expected: FAIL lines `+5 a week raises expected wins` (override ignored) and `ten batches per team`.

- [ ] **Step 3: Implement `override` and `batches`**

In `season.js`, change the signature:

```js
export function projectSeason(eng, schedule, settings,
    { sims = 20000, sigma = 25, divisionSeeding = false, divisionOf = null,
      override = null, batches = 1 } = {}) {
```

Replace the `teamSig` / `sigFor` block with:

```js
  // Prefer measured volatility. The sum of independent normals is normal with the
  // summed variance, so one draw per team-week is exact - no need to draw each
  // player separately - while still letting roster composition set the spread.
  // `override` swaps in a post-trade (mu, sigma) for some teams; everything else,
  // including the draw order, is unchanged, so two runs share their noise and the
  // difference between them is a paired estimate (common random numbers).
  const teamSig = eng.teams.map((t) => override?.get(t)?.sigma ?? eng.teamSigma?.(t) ?? null);
```

Replace the `mu` construction with:

```js
  const mu = teams.map((t) => {
    const b = override?.get(t)?.mu ?? eng.baseline.get(t);
    const m = new Map();
    weeks.forEach((w, k) => m.set(w, b[k]));
    return m;
  });
```

After `const acc = teams.map(() => ({ ... }));` add:

```js
  const nb = Math.max(1, Math.floor(batches));
  const per = teams.map(() => Array.from({ length: nb }, () => ({ wins: 0, playoff: 0, bye: 0, title: 0 })));
  const batchOf = (s) => Math.min(nb - 1, Math.floor(s * nb / sims));
```

In the per-sim seeding loop, change

```js
    for (let k = 0; k < T; k++) {
      const i = order[k];
      acc[i].wins += wins[i]; acc[i].pf += pf[i]; acc[i].seed += k + 1;
      if (k < nPlayoff) acc[i].playoff++;
      if (k < byes) acc[i].bye++;
    }
```
to
```js
    const bi = batchOf(s);
    for (let k = 0; k < T; k++) {
      const i = order[k];
      acc[i].wins += wins[i]; acc[i].pf += pf[i]; acc[i].seed += k + 1;
      per[i][bi].wins += wins[i];
      if (k < nPlayoff) { acc[i].playoff++; per[i][bi].playoff++; }
      if (k < byes) { acc[i].bye++; per[i][bi].bye++; }
    }
```

Change `acc[alive[0]].title++;` to

```js
      acc[alive[0]].title++;
      per[alive[0]][bi].title++;
```

In the returned row object, after `sigma: ...,` add:

```js
    batches: nb > 1 ? per[i].map((x) => {
      const n = sims / nb;
      return { wins: x.wins / n, playoffPct: x.playoff / n, byePct: x.bye / n, titlePct: x.title / n };
    }) : undefined,
```

(`i` is in scope: the map callback is `(t, i) =>`.)

- [ ] **Step 4: Run the tests**

Run: `node extension/test/parity.mjs`
Expected: `0 failures`, `ENGINE OK`. The three existing season-invariant assertions still pass.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/season.js extension/test/parity.mjs
git commit -m "Let the season sim take post-trade rosters and report batches

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 5: Per-trade season odds (`odds.js`)

**Files:**
- Create: `extension/engine/odds.js`
- Test: `extension/test/parity.mjs`

**Interfaces:**
- Consumes: `projectSeason` with `override`/`batches`; `Engine.swap`, `Engine.weekly`, `Engine.rosterSigma`.
- Produces:
  - `tradeOdds(eng, schedule, settings, trade, team, opts): { title, bye, playoff, wins, se: {title, bye, playoff} }` — deltas for `team`.
  - `attachOdds(eng, schedule, settings, trades, team, opts, onProgress): Promise<{ms:number}>` — sets `t.odds` on each trade in `trades`; computes the baseline once; yields every 5 trades. `opts` = `{ sims = 5000, batches = 10, divisionSeeding, divisionOf }`.

- [ ] **Step 1: Write the failing tests**

Add the import:

```js
import { tradeOdds, attachOdds } from "../engine/odds.js";
```

Append before the summary lines:

```js
/* ---- 8. per-trade season odds ---- */
{
  const t0 = F.teams[0], t1 = F.teams[1];
  const nothing = eng.score([[t0, t1, []], [t1, t0, []]], "1-for-1");
  const z = tradeOdds(eng, new Map(), model.settings, nothing, t0, { sims: 2000, batches: 5 });
  ok(z.title === 0 && z.bye === 0 && z.playoff === 0 && z.wins === 0, "null trade: exactly zero deltas");
  ok(z.se.title === 0 && z.se.bye === 0, "null trade: zero standard error");

  // A trade that hands team 0 the best player in the league for its worst must help.
  const best = [...eng.roster.get(t1)].sort((a, b) =>
    eng.proj.subarray(b * NW, b * NW + NW).reduce((x, y) => x + y, 0) -
    eng.proj.subarray(a * NW, a * NW + NW).reduce((x, y) => x + y, 0))[0];
  const worst = [...eng.roster.get(t0)].sort((a, b) =>
    eng.proj.subarray(a * NW, a * NW + NW).reduce((x, y) => x + y, 0) -
    eng.proj.subarray(b * NW, b * NW + NW).reduce((x, y) => x + y, 0))[0];
  const heist = { shape: "1-for-1", sides: [
    { team: t0, sent: [worst], received: [best] }, { team: t1, sent: [best], received: [worst] }] };
  const h = tradeOdds(eng, new Map(), model.settings, heist, t0, { sims: 4000, batches: 10 });
  ok(h.wins > 0, "a heist raises expected wins");
  ok(h.playoff >= 0 && h.title >= 0, "a heist never lowers playoff or title odds");
  ok(h.se.title >= 0 && Number.isFinite(h.se.title), "standard error is a finite non-negative number");

  const list = [nothing, heist];
  let calls = 0;
  const { ms } = await attachOdds(eng, new Map(), model.settings, list, t0, { sims: 2000, batches: 5 }, () => calls++);
  ok(list.every((t) => t.odds && "title" in t.odds && "se" in t.odds), "attachOdds sets t.odds on every trade");
  ok(list[0].odds.title === 0, "attachOdds agrees with tradeOdds on the null trade");
  ok(calls >= 1 && ms >= 0, "reports progress and elapsed time");
  console.log(`  per-trade odds: ${(ms / list.length).toFixed(0)} ms per trade at 2000 sims`);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node extension/test/parity.mjs`
Expected: `ERR_MODULE_NOT_FOUND` for `odds.js`.

- [ ] **Step 3: Create `odds.js`**

```js
/**
 * What a trade does to a team's season odds.
 *
 * Two runs of the season simulation - rosters as they are, rosters after the trade -
 * with the same seed. projectSeason draws a fixed number of normals per simulation
 * regardless of who wins, so the two worlds see identical noise and their
 * difference is a paired estimate whose error is far below either run's own. The
 * error is measured, not assumed: the sims are split into batches and the standard
 * error of the batch deltas is reported alongside each delta. The UI shows a dash
 * for any delta smaller than twice its error.
 */
import { projectSeason } from "./season.js";

const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

function postWorld(eng, trade) {
  const override = new Map();
  for (const s of trade.sides) {
    const ids = eng.swap(eng.roster.get(s.team), s.sent, s.received);
    override.set(s.team, { mu: eng.weekly(ids, new Float64Array(eng.NW)), sigma: eng.rosterSigma(ids) });
  }
  return override;
}

function deltas(base, post, team) {
  const b = base.find((r) => r.team === team), p = post.find((r) => r.team === team);
  const d = (k) => p[k] - b[k];
  const se = (k) => {
    const ds = p.batches.map((x, i) => x[k] - b.batches[i][k]);
    const m = ds.reduce((a, c) => a + c, 0) / ds.length;
    const v = ds.reduce((a, c) => a + (c - m) ** 2, 0) / Math.max(1, ds.length - 1);
    return Math.sqrt(v / ds.length);
  };
  return {
    title: d("titlePct"), bye: d("byePct"), playoff: d("playoffPct"), wins: d("wins"),
    se: { title: se("titlePct"), bye: se("byePct"), playoff: se("playoffPct") },
  };
}

const simOpts = ({ sims = 5000, batches = 10, divisionSeeding = false, divisionOf = null } = {}) =>
  ({ sims, batches: Math.max(2, batches), divisionSeeding, divisionOf });

/** Δ odds for `team` from one trade. Runs the baseline itself; use attachOdds for many. */
export function tradeOdds(eng, schedule, settings, trade, team, opts) {
  const o = simOpts(opts);
  const base = projectSeason(eng, schedule, settings, o);
  const post = projectSeason(eng, schedule, settings, { ...o, override: postWorld(eng, trade) });
  return deltas(base, post, team);
}

/**
 * Set `t.odds` on every trade for `team`. The baseline world is simulated once.
 * Yields to the browser every few trades so the loading screen keeps moving.
 */
export async function attachOdds(eng, schedule, settings, trades, team, opts, onProgress = () => {}) {
  const o = simOpts(opts);
  const t0 = Date.now();
  const base = projectSeason(eng, schedule, settings, o);
  for (let n = 0; n < trades.length; n++) {
    const t = trades[n];
    const post = projectSeason(eng, schedule, settings, { ...o, override: postWorld(eng, t) });
    t.odds = deltas(base, post, team);
    if (n % 5 === 4) { onProgress(n + 1, trades.length); await yieldToBrowser(); }
  }
  onProgress(trades.length, trades.length);
  return { ms: Date.now() - t0 };
}
```

- [ ] **Step 4: Run the tests and read the timing line**

Run: `node extension/test/parity.mjs`
Expected: `0 failures`, `ENGINE OK`, and a line like `per-trade odds: NN ms per trade at 2000 sims`.

Scale the printed number by 2.5 for 5000 sims. If 200 trades × that exceeds 10 s (i.e. more than 50 ms per trade at 5000 sims), set the panel cap in Task 6 to 100 trades instead of 200 and note the measured figure in the commit message.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/odds.js extension/test/parity.mjs
git commit -m "Compute each trade's change in playoff, bye and title odds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 6: Panel — objective toggle, win and odds columns, loading steps

**Files:**
- Modify: `extension/panel.js`

**Interfaces:**
- Consumes: `Engine.setSchedule`, `Engine.enrich`, `attachOdds`, `side.win`, `t.odds`.
- Produces: `window.__objective` in `{"title","wins","gain"}`, persisted at `chrome.storage.local["ffsm.objective"]`; helper `objSort(objective)` returns the grid sort key; columns `dwins`, `dtitle`, `dbye`.

No automated tests cover the panel; verification is by loading the extension. The steps say what to look for.

- [ ] **Step 1: Import and add the loading phases**

In `panel.js`, change the imports:

```js
import { Engine, dedupe } from "./engine/search.js";
import { projectSeason } from "./engine/season.js";
import { attachOdds } from "./engine/odds.js";
```

In `PHASES`, insert two entries before `["build", "Building the report"]`:

```js
  ["win",      "Win probability"],
  ["odds",     "Season odds per trade"],
```

- [ ] **Step 2: Run enrich and attachOdds after the searches**

In `start()`, replace

```js
    const trades = [...dedupe(one, 3), ...dedupe(two, 3), ...dedupe(three, 3)]
      .sort((a, b) => b.total - a.total);
    Steps.set("s3", "done", `${three.length}`);
```
with
```js
    const trades = [...dedupe(one, 3), ...dedupe(two, 3), ...dedupe(three, 3)]
      .sort((a, b) => b.total - a.total);
    Steps.set("s3", "done", `${three.length}`);

    // Wins, not points, decide a season. The exact search is done; these passes only
    // re-score its survivors, so recall is unaffected.
    Steps.set("win", "run");
    eng.setSchedule(schedule);
    await eng.enrich(trades, (n, tot) => progress(n / tot));
    Steps.set("win", "done", `${trades.length} trades`);

    Steps.set("odds", "run");
    const mine = trades.filter((t) => t.sides.some((s) => s.team === myTeam))
      .sort((a, b) => b.sides.find((s) => s.team === myTeam).win - a.sides.find((s) => s.team === myTeam).win)
      .slice(0, ODDS_CAP);
    const divisionOf = new Map([...model.teams.values()].map((t) => [t.name, t.divisionId]));
    const divSeedSaved = (await chrome.storage.local.get("ffsm.divSeed"))["ffsm.divSeed"] ?? false;
    window.__divSeed = divSeedSaved;
    const { ms } = await attachOdds(eng, schedule, model.settings, mine, myTeam,
      { sims: ODDS_SIMS, batches: 10, divisionSeeding: divSeedSaved && (model.settings.divisionCount ?? 0) > 1, divisionOf },
      (n, tot) => progress(n / tot));
    say(`season odds for ${mine.length} trades in ${(ms / 1000).toFixed(1)}s`, "ok");
    Steps.set("odds", "done", `${mine.length} trades`);
```

Near the top of the file, after `const CACHE_HOURS = 12;`, add:

```js
/* Per-trade season odds run two 5000-sim worlds per trade. Capped so the loading
   screen stays under about ten seconds; the cap is measured in the test output. */
const ODDS_CAP = 200;
const ODDS_SIMS = 5000;
```

Also persist the division-seeding toggle so the odds step and the season table agree. In the `#divseed` click handler replace

```js
    b.onclick = () => { window.__divSeed = b.dataset.v === "1"; rerender(); };
```
with
```js
    b.onclick = () => {
      window.__divSeed = b.dataset.v === "1";
      chrome.storage.local.set({ "ffsm.divSeed": window.__divSeed });
      rerender();
    };
```

- [ ] **Step 3: Load and persist the objective**

Just before `render(eng, model, trades, myTeam, schedule);` in `start()`, add:

```js
    window.__objective = (await chrome.storage.local.get("ffsm.objective"))["ffsm.objective"] ?? "title";
```

Add near `ODDS_CAP`:

```js
const OBJECTIVES = [
  ["title", "Championship", "Rank by the change in your odds of winning the league."],
  ["wins",  "Seeding",      "Rank by the change in your expected regular-season wins."],
  ["gain",  "Balanced",     "Rank by points per week gained across the whole season."],
];
const objSort = (o) => (o === "title" ? "dtitle" : o === "wins" ? "dwins" : "gain");
```

- [ ] **Step 4: Add formatters and hints**

After `const cls = ...` add:

```js
/** A probability delta in percentage points, or a dash when it is inside its own error. */
const fpp = (v, se = 0) => (v == null || !Number.isFinite(v) || Math.abs(v) < 2 * se)
  ? '<span class="zero">—</span>'
  : `<span class="${cls(v)}">${v >= 0 ? "+" : "−"}${(Math.abs(v) * 100).toFixed(1)}pp</span>`;
const fw = (v) => `<span class="${cls(v)}">${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}</span>`;
```

Add to `HINT`:

```js
  objective:"What the list is sorted by. Championship uses the change in title odds from a paired season simulation; Seeding uses expected regular-season wins from your schedule; Balanced is points per week.",
  dwins:  "Change in your expected regular-season wins: each week's win probability against your scheduled opponent, before and after the trade, summed. Uses the measured spread of both lineups.",
  dtitle: "Change in your odds of winning the league, from two season simulations with identical luck - one with today's rosters, one after the trade. A dash means the change is smaller than the simulation's own error.",
  dbye:   "Change in your odds of a first-round bye. In a six-team bracket a bye roughly doubles title odds, so this is usually the number that matters in November.",
  calib:  "ESPN projections are over-spread: the gap between a position's #1 and #5 is smaller in reality than on paper. On, each projection is pulled toward its positional mean by the slope measured across twelve seasons (QB 0.67, RB 0.79, WR 0.85, TE 0.72).",
```

- [ ] **Step 5: Add the columns and the objective-driven sort**

In `render`, inside `tradeCols`, after the `gain` column entry add:

```js
    { key: "dwins", label: "Δ wins", num: true,
      value: (r) => side(r.t).win ?? 0, hint: HINT.dwins },
    { key: "dtitle", label: "Δ title", num: true,
      value: (r) => (side(r.t).team === myTeam ? r.t.odds?.title ?? -Infinity : -Infinity), hint: HINT.dtitle },
    { key: "dbye", label: "Δ bye", num: true,
      value: (r) => (side(r.t).team === myTeam ? r.t.odds?.bye ?? -Infinity : -Infinity), hint: HINT.dbye },
```

In the `grid("tradeGrid", ...)` options change `sort: "gain", dir: -1,` to:

```js
    sort: objSort(window.__objective ?? "title"), dir: -1,
```

In the row template, after the `<td class="num ${cls(me.gain)}">${f2(me.gain)}</td>` cell add three cells:

```js
        <td class="num">${fw(me.win ?? 0)}</td>
        <td class="num">${me.team === myTeam && t.odds ? fpp(t.odds.title, t.odds.se.title) : '<span class="zero">—</span>'}</td>
        <td class="num">${me.team === myTeam && t.odds ? fpp(t.odds.bye, t.odds.se.bye) : '<span class="zero">—</span>'}</td>
```

The `grid` helper sorts numerically with `-Infinity` sinking to the bottom, so trades without odds fall below those with odds in Championship mode. Because `mine` was picked by `win` before running odds, the un-odded remainder is already ordered by Δ wins — the fallback the spec asks for.

- [ ] **Step 6: Add the objective select to the filter bar**

In the `.bar` markup, before `<div class="fld"><label for="who">Team</label>`, insert:

```js
          <div class="fld"><label for="obj" data-hint="${esc(HINT.objective)}"><span class="hint">Objective</span></label>
            <select id="obj">${OBJECTIVES.map(([k, lab]) =>
              `<option value="${k}"${(window.__objective ?? "title") === k ? " selected" : ""}>${lab}</option>`).join("")}
            </select></div>
```

In the behaviour section, after the `$("#who").onchange` handler, add:

```js
  $("#obj").onchange = (e) => {
    window.__objective = e.target.value;
    chrome.storage.local.set({ "ffsm.objective": e.target.value });
    SORT.delete("tradeGrid");          // let the new objective set the default sort
    rerender();
  };
```

(`SORT` is the module-level `Map` the grid helper uses; check its name at the `grid` definition near line 105 and match it.)

- [ ] **Step 7: Make the headline tile follow the objective**

Replace the `best` computation and its tile:

```js
  const obj = window.__objective ?? "title";
  const metric = (t) => {
    const s = t.sides.find((x) => x.team === myTeam);
    if (obj === "title") return t.odds && Math.abs(t.odds.title) >= 2 * t.odds.se.title ? t.odds.title : null;
    if (obj === "wins") return s.win ?? null;
    return s.gain;
  };
  const best = myOffers.reduce((a, t) => {
    const g = metric(t);
    return g != null && g > (a?.g ?? -1e9) ? { g, t } : a;
  }, null);
  const bestText = !best ? "—" : obj === "title" ? `${best.g >= 0 ? "+" : "−"}${(Math.abs(best.g) * 100).toFixed(1)}pp`
    : obj === "wins" ? `${best.g >= 0 ? "+" : "−"}${Math.abs(best.g).toFixed(2)} W` : f2(best.g);
```

and in the tile:

```js
    <div class="tile hot"><div class="k">Best available · ${esc(OBJECTIVES.find(([k]) => k === obj)[1])}</div>
      <div class="v">${bestText}</div>
      <div class="s">${best ? "via " + esc(best.t.sides.find((s) => s.team !== myTeam).team) : "none found"}</div></div>
```

- [ ] **Step 8: Verify in the browser**

Load the extension (`chrome://extensions` → reload), open a league. Check: the loading checklist shows "Win probability" and "Season odds per trade" ticking; the trade grid has Δ wins / Δ title / Δ bye columns; the default sort is Δ title with dashes at the bottom; switching Objective re-sorts and survives a page reload; the "Best available" tile changes units with the objective. Run `node extension/test/parity.mjs` once more — still `0 failures`.

- [ ] **Step 9: Commit**

```bash
git add extension/panel.js
git commit -m "Rank trades by title odds, wins, or points

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

### Task 7: Panel — leverage strip, win sparkline, calibration toggle; docs

**Files:**
- Modify: `extension/panel.js`
- Modify: `extension/panel.css`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `Engine.weekWins`, `Engine.weekLeverage`, `Engine.opp`, `side.winWeekly`, `shrinkProjections`, `CALIBRATION_K`.
- Produces: `chrome.storage.local["ffsm.calibrate"]` (boolean, default `true`).

- [ ] **Step 1: Apply shrinkage before the engine is built**

Add the import:

```js
import { shrinkProjections, CALIBRATION_K } from "./engine/calibrate.js";
```

In `start()`, immediately before `say("building engine…");`, add:

```js
    // Calibrate before anything reads a projection. Off leaves ESPN's numbers as-is.
    const calibrate = (await chrome.storage.local.get("ffsm.calibrate"))["ffsm.calibrate"] ?? true;
    window.__calibrate = calibrate;
    if (calibrate) {
      const r = shrinkProjections(model.players, model.weeks, CALIBRATION_K);
      say(`projections calibrated for ${r.changed} players (${Object.entries(CALIBRATION_K)
        .map(([p, k]) => `${p} ${k}`).join(", ")})`, "ok");
    } else {
      say("projections used as ESPN publishes them (calibration off)", "");
    }
```

- [ ] **Step 2: Add the toggle to the season section's bar**

In `render`, replace the season `<div class="panel">` opening block (the part beginning `${divCount > 1 ? \`<div class="bar">` and ending `</div>\` : ""}`) with a bar that always renders:

```js
        <div class="bar">
          ${divCount > 1 ? `<div class="fld"><label>Seeding</label><div class="chips" id="divseed">
            <button data-v="0" aria-pressed="${!divSeed}">By record</button>
            <button data-v="1" aria-pressed="${divSeed}">Division winners first</button>
          </div></div>
          <span class="readout" style="color:var(--faint)">${divCount} divisions. ESPN does
            not say which rule applies — pick yours; it moves the bye odds.</span>` : ""}
          <div class="fld"><label data-hint="${esc(HINT.calib)}"><span class="hint">Projections</span></label>
            <div class="chips" id="calib">
              <button data-v="1" aria-pressed="${window.__calibrate !== false}">Calibrated</button>
              <button data-v="0" aria-pressed="${window.__calibrate === false}">As published</button>
            </div></div>
        </div>
```

In the behaviour section add:

```js
  app.querySelectorAll("#calib button").forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.v === "1";
      if (on === (window.__calibrate !== false)) return;
      await chrome.storage.local.set({ "ffsm.calibrate": on });
      location.reload();      // projections feed everything; a rebuild is the honest path
    };
  });
```

- [ ] **Step 3: Leverage strip under the season table**

In `render`, before `const SIMS = 20000, SIGMA = 25;`, add:

```js
  /* ---------- week leverage: where a point buys the most win probability ---------- */
  const pWin = eng.weekWins([myTeam], new Map()).get(myTeam);
  const lev = eng.weekLeverage(myTeam);
  const regIdx = W.map((_, i) => i).filter((i) => eng.regMask[i]);
  const levMax = Math.max(...regIdx.map((i) => lev[i]), 1e-9);
  const underdogWeeks = regIdx.filter((i) => pWin[i] < 0.5).length;
  const leverageStrip = `<div class="lev">
    ${regIdx.map((i) => {
      const o = eng.opp?.get(myTeam)?.[i];
      const p = pWin[i];
      return `<div class="lev-wk" style="--heat:${(lev[i] / levMax).toFixed(2)}"
        data-hint="Week ${W[i]}${o ? " vs " + esc(o) : " (all-play)"}: ${(p * 100).toFixed(0)}% to win. One extra point is worth ${(lev[i] * 100).toFixed(1)} percentage points here.">
        <div class="lev-w">WK ${W[i]}</div>
        <div class="lev-p ${p >= 0.5 ? "up" : "down"}">${(p * 100).toFixed(0)}%</div>
        <div class="lev-o">${o ? esc(o) : "all-play"}</div>
      </div>`;
    }).join("")}
  </div>
  <div class="note"><b>Leverage.</b> Brighter weeks are where one point moves your win
    probability most — the coin-flip games. ${underdogWeeks
      ? `You are the underdog in <b>${underdogWeeks}</b> of ${regIdx.length} weeks: variance helps
         there, so a boom-or-bust starter is worth more than his average says.`
      : `You are the favourite every week: protect the floor — steady starters over swingy ones.`}
  </div>`;
```

Then insert `${leverageStrip}` directly after `${seasonGrid}` in the season panel markup.

- [ ] **Step 4: Win sparkline in the trade detail**

In `detailFor`, inside the `.det-side` template, replace `<ul>${li.join("")}</ul>${deltaBars(sd.weekly, W)}</div>` with:

```js
        <ul>${li.join("")}</ul>${deltaBars(sd.weekly, W)}
        ${sd.winWeekly ? `<div class="delta-cap">Win probability, week by week
          <b class="${cls(sd.win)}">${(sd.win >= 0 ? "+" : "−") + Math.abs(sd.win).toFixed(2)} wins</b></div>
          ${deltaBars(sd.winWeekly.map((x) => x * 100), W)}` : ""}</div>
```

Also add to `det-nums`:

```js
          <span>Δ wins <b class="${cls(sd.win ?? 0)}">${(sd.win >= 0 ? "+" : "−") + Math.abs(sd.win ?? 0).toFixed(2)}</b></span>
```

- [ ] **Step 5: Styles**

Append to `extension/panel.css`:

```css
/* week leverage strip */
.lev{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:1px;
  background:var(--line);border-top:1px solid var(--line)}
.lev-wk{background:color-mix(in srgb,var(--accent) calc(var(--heat)*38%),var(--panel));
  padding:9px 8px;text-align:center;cursor:help}
.lev-w{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;color:var(--faint)}
.lev-p{font-family:var(--mono);font-size:15px;font-weight:600;margin:3px 0 1px}
.lev-o{font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.delta-cap{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;
  letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-top:14px}
```

- [ ] **Step 6: Update `CLAUDE.md`**

In the architecture map, add after the `search.js` line:

```
    winprob.js       normal CDF, P(win), per-week leverage
    calibrate.js     positional shrinkage of ESPN projections
    odds.js          paired season sims: a trade's change in playoff/bye/title odds
```

Add a load-bearing decision after the "Time windows stay separate" paragraph:

```
**Wins are scored after the search, never inside it.** `Engine.enrich` and
`attachOdds` re-score the survivors of the exact search; they need an extra lineup
solve per side and two season simulations per trade, which is fine for hundreds of
trades and ruinous for millions. `projectSeason` is deterministic and draws a fixed
number of normals per simulation, so two runs with the same seed share their noise:
the *difference* between a baseline and a post-trade run is a paired estimate.
Keep the draw order fixed - an early `continue` or a conditional draw would break
common random numbers silently.

**`positionLimits` is a filter, not a search constraint.** `score()` returns `null`
for a roster ESPN would refuse; the searches skip nulls. Recall is unchanged.
```

Update the test count line `test/parity.mjs    371 assertions against a frozen league` to the number printed by the run.

- [ ] **Step 7: Verify in the browser and run the tests**

Reload the extension. Check: the log shows "projections calibrated for N players"; the season panel shows a Projections chip pair, and switching it reloads with the other log line; the leverage strip renders one cell per regular-season week with opponent names and percentages, with brighter cells for close games; opening a trade shows a second sparkline captioned "Win probability, week by week". Run `node extension/test/parity.mjs`: `0 failures`.

- [ ] **Step 8: Commit**

```bash
git add extension/panel.js extension/panel.css CLAUDE.md
git commit -m "Show week leverage, win sparklines, and a calibration toggle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU"
```

---

## Self-review

**Spec coverage.** A5 → Task 1. A4 → Tasks 2 and 7 (toggle, default on, log line). A1 analytic → Task 3; A1 season odds with CRN, batches, SE and the dash rule → Tasks 4, 5, 6; the "top 200, my team only, 5000 sims, own loading step" rule → Task 6 (`ODDS_CAP`, `ODDS_SIMS`, `mine`). A2 → Task 6 (select, persistence, sort, headline, Δ-wins fallback via `-Infinity` sinking). A3 → Task 7 (strip, hint, `winWeekly` sparkline). `CLAUDE.md` fix → Task 7. Testing section of the spec: legality, shrinkage, analytic-vs-MC, null trade zero, CRN identical, override raises wins, batches sum → Tasks 1–5.

**Type consistency.** `side.win`/`side.winWeekly` set by `enrich` (Task 3) and read in Tasks 6–7. `t.odds = {title, bye, playoff, wins, se:{title,bye,playoff}}` set in Task 5, read in Task 6. `override` shape `{mu, sigma}` is identical in Tasks 4 and 5. `Engine.opp` produced in Task 3 and read in Task 7. `window.__objective`, `window.__calibrate`, `window.__divSeed` each set in `start()` before `render()`.

**Known gap, deliberate:** panel work has no automated tests; the repo has none for the UI and adding a DOM harness is out of scope. Each panel task carries an explicit browser check instead.
