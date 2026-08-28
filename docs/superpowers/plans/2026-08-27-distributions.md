# Phase 8 — Distributions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a measured floor and ceiling instead of a symmetric guess, count the correlation between teammates so a stacked lineup reads as swingy as it is, and answer the Sunday-morning question — which legal lineup is most likely to beat *this* opponent.

**Architecture:** Three new engine modules and one new panel module. `league.js`'s `measureVolatility` starts keeping the residuals it already computes. `distribution.js` turns those residuals into shrunk quantiles and owns the single `CORR` table. `search.js` is touched in exactly one method body — `rosterSigma` — which gains a covariance term guarded by an optional `eng.rhoOf` that `distribution.js` attaches from outside; nothing else in `search.js` moves. `gameplan.js` runs a legality-checked local search over single starter↔bench swaps to maximise P(win) for the current week. `panel/distributions.js` holds every string.

**Tech Stack:** Plain ES modules, no build step, Chrome MV3 extension page. Tests are `node extension/test/run-all.mjs` (custom `ok()` assertions, no framework).

**Spec:** `docs/superpowers/specs/2026-08-27-distributions-design.md`
**Parallel-build rules (binding):** `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`

## Global Constraints

- **File ownership, wave 2.** This phase owns `extension/engine/league.js` (`measureVolatility`). It may edit **only** the body of `rosterSigma` in `extension/engine/search.js` — no new methods, no new imports, no other method touched; Phase 4 owns the rest of that file concurrently and the hunk must stay minimal. It **must not** modify `extension/engine/season.js`.
- **`extension/test/parity.mjs` is never edited.** It is the frozen engine contract. `node extension/test/run-all.mjs` must be green with `parity.mjs` byte-identical to `main`. Fixture players carry `nfl: "X"`, which must keep covariance OFF so the season invariants hold.
- **Tests go in a new file**, `extension/test/distributions.mjs`, using the `ok()` pattern from `extension/test/availability.mjs`. The model is **copied** from `parity.mjs`, never imported.
- **The engine models slots, not positions.** Position strings are display-only. The `CORR` table is the one exception and it is display-adjacent: it keys on a *position family* for correlation only, never for lineup logic.
- **Correlation constants live in exactly one exported table** (`CORR` in `distribution.js`) and apply **only when both players have a real pro team** — never for `"X"`, `"?"` or `"FA"`.
- **Every feature degrades.** No volatility measured → no ranges, no covariance, no gameplan; the page shows `—` and nothing throws out of `start()`.
- **Panel code lives in `extension/panel/distributions.js`.** `panel.js` gets one import line and the smallest hunks that work.
- **No new network calls**, no backend, nothing leaves the machine.
- Commit messages: imperative subject, ending with the trailer block used in this repo:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
  ```

## File structure

| File | Responsibility | Status |
|---|---|---|
| `extension/engine/league.js` | `measureVolatility` additionally returns `residuals` and `byPosResiduals`. Nothing else changes. | modify |
| `extension/engine/distribution.js` | `CORR`, `quantiles`, `buildDistribution`, `playerRange`, `cv`, `rho`, `attachCovariance`, `stacks`, `lineupRange`. No DOM, no engine mutation beyond the documented attach. | create |
| `extension/engine/search.js` | `rosterSigma` body only: adds the covariance term when `this.rhoOf` is present. | modify (one method) |
| `extension/engine/gameplan.js` | `lineupStats`, `feasible`, `gameplan` — the weekly P(win) local search. | create |
| `extension/panel/distributions.js` | Every string and HTML fragment the page shows for this phase. | create |
| `extension/panel.js` | One import line; two small `start()` inserts; one new section, two roster columns, one detail line and one note swap in `render()`. | modify |
| `extension/panel.css` | `.rng` range bar and `.gp` this-week block. | modify |
| `extension/test/distributions.mjs` | Everything this phase adds. | create |
| `CLAUDE.md` | Architecture map plus two new load-bearing decisions. | modify |

Test helper convention for `extension/test/distributions.mjs`: the file defines `ok(cond, what)` and `near(a, b, eps, what)` exactly as `availability.mjs` does, plus `mkModel()` / `mkEngine()` copied from it. Each task appends one numbered block before the final summary lines.

---

### Task 1: Keep the residuals

**Files:**
- Modify: `extension/engine/league.js` (`measureVolatility`, lines 225–258)
- Create: `extension/test/distributions.mjs`

**Interfaces:**
- Consumes: player records with `rawStats` (already produced by `loadLeague`).
- Produces: `measureVolatility(players, priorSeason, minWeeks = 6)` returns
  `{ bySigma: Map<id, number>, byPos: Map<pos, number>, global: number, measured: number,
     residuals: Map<id, number[]>, byPosResiduals: Map<pos, number[]> }`.
  The four existing fields are computed exactly as before.

Two rulings to encode in comments:
1. `residuals` keeps every player with **at least one** qualifying week, not `minWeeks` — shrinkage handles small samples, and gating them out would throw away the only data a rookie has.
2. `byPosResiduals` pools only players who cleared `minWeeks`, so the prior a small sample is shrunk *toward* is not itself made of small samples.

- [ ] **Step 1: Write the failing test**

Create `extension/test/distributions.mjs` with this exact content:

```js
/**
 * Tests for measured distributions, stack covariance and the weekly P(win) lineup.
 *
 * `parity.mjs` is the engine's frozen contract and is never touched; this file
 * carries everything Phase 8 added. The model is built the way parity.mjs builds
 * it - deliberately copied rather than imported, so that a change here can never
 * move the golden set. Fixture players carry `nfl: "X"`, which is what keeps
 * covariance off in parity.mjs; several tests below assert exactly that.
 *
 *   node extension/test/distributions.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { Engine } from "../engine/search.js";
import { measureVolatility } from "../engine/league.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));
const NW = F.weeks.length;
const { slots, starters } = buildSlots(F.lineupSlotCounts);
const masks = F.pos.map((p) => seatMask(F.eligibleSlots[p], slots));

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const near = (a, b, eps, what) => ok(Math.abs(a - b) < eps, `${what} (${a} vs ${b})`);

/** A fresh model, shaped like parity.mjs's. `nfl` defaults to "X" for every player. */
function mkModel(nflOf = () => "X") {
  return {
    weeks: F.weeks.slice(),
    settings: {
      currentWeek: 1,
      regularSeasonWeeks: F.weeks.filter((w) => w <= 14),
      playoffWeeks: [15, 16, 17],
      playoffRoundWeeks: [[15], [16], [17]],
      playoffTeams: 6,
      playoffReseed: true,
      lineupSlotCounts: F.lineupSlotCounts,
    },
    players: new Map(F.pos.map((pos, i) => [i, {
      id: i, name: `p${i}`, pos, nfl: nflOf(i, pos),
      eligibleSlots: F.eligibleSlots[pos],
      bye: F.weeks.find((w) => !(F.proj[i][F.weeks.indexOf(w)] > 0)) ?? 0,
      proj: Object.fromEntries(F.weeks.map((w, k) => [w, F.proj[i][k]])),
    }])),
    teams: new Map(F.teams.map((name, ti) =>
      [ti, { id: ti, name, roster: new Set(F.rosters[name]) }])),
  };
}
const mkEngine = (model) =>
  new Engine(model, { starters }, new Map(F.pos.map((p, i) => [i, masks[i]])));

/* ---- 1. measureVolatility keeps the residuals it already computes ---- */
{
  // Two synthetic seasons of ESPN stat rows. statSplitTypeId 1 is "one week";
  // statSourceId 1 is the projection, 0 the actual.
  const rows = (season, pairs) => pairs.flatMap(([wk, proj, act]) => [
    { statSplitTypeId: 1, seasonId: season, statSourceId: 1, scoringPeriodId: wk, appliedTotal: proj },
    { statSplitTypeId: 1, seasonId: season, statSourceId: 0, scoringPeriodId: wk, appliedTotal: act },
  ]);
  const eight = [[1, 10, 12], [2, 10, 8], [3, 10, 14], [4, 10, 6],
                 [5, 10, 11], [6, 10, 9], [7, 10, 20], [8, 10, 0]];
  const two = [[1, 10, 30], [2, 10, 4]];
  const players = [
    { id: 1, pos: "WR", rawStats: rows(2025, eight) },
    { id: 2, pos: "WR", rawStats: rows(2025, two) },      // below minWeeks
    { id: 3, pos: "RB", rawStats: rows(2024, eight) },     // wrong season
    { id: 4, pos: "TE", rawStats: rows(2025, [[1, 0.5, 9], [2, 0.5, 3]]) }, // proj <= 1
  ];
  const vol = measureVolatility(players, 2025);

  ok(vol.bySigma.has(1) && !vol.bySigma.has(2),
     "sigma still needs minWeeks weeks of history");
  ok(vol.measured === 1, "measured still counts only the players with a sigma");
  ok(vol.residuals instanceof Map, "residuals is a Map");
  ok(vol.byPosResiduals instanceof Map, "byPosResiduals is a Map");

  const r1 = vol.residuals.get(1);
  ok(Array.isArray(r1) && r1.length === 8, "eight residuals for the eight-week player");
  ok(r1.slice().sort((a, b) => a - b).join(",") === "-10,-4,-2,-1,1,2,4,10",
     "residuals are actual minus projection");

  ok(vol.residuals.get(2)?.length === 2,
     "a player under minWeeks still keeps his residuals - shrinkage handles the sample");
  ok(!vol.residuals.has(3), "a prior-season filter still applies");
  ok(!vol.residuals.has(4) || vol.residuals.get(4).length === 0,
     "weeks projected at or under 1 point are not residuals");

  ok(vol.byPosResiduals.get("WR")?.length === 8,
     "the positional pool takes only players who cleared minWeeks");
  ok(!vol.byPosResiduals.has("TE"), "a position with no qualifying player has no pool");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("DISTRIBUTIONS OK");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/distributions.mjs`
Expected: FAIL lines for `residuals is a Map`, `byPosResiduals is a Map`, `eight residuals…`, and every assertion that dereferences them — because `measureVolatility` returns neither field yet.

- [ ] **Step 3: Keep the residuals in `measureVolatility`**

In `extension/engine/league.js`, replace the body of `measureVolatility` (lines 225–258) with:

```js
export function measureVolatility(players, priorSeason, minWeeks = 6) {
  const bySigma = new Map();
  const posSamples = new Map();
  const residuals = new Map();
  const posResiduals = new Map();
  const all = [];

  for (const p of players) {
    const act = new Map(), prj = new Map();
    for (const st of p.rawStats ?? []) {
      if (st.statSplitTypeId !== 1 || st.seasonId !== priorSeason) continue;
      if (st.statSourceId === 0) act.set(st.scoringPeriodId, st.appliedTotal);
      else if (st.statSourceId === 1) prj.set(st.scoringPeriodId, st.appliedTotal);
    }
    // Only weeks he was expected to play: a projection near zero means he was not
    // in the plan, and counting those measures roster churn rather than volatility.
    const weeks = [...act.keys()].filter(w => prj.has(w) && prj.get(w) > 1
      && act.get(w) != null && prj.get(w) != null);
    if (!weeks.length) continue;
    const res = weeks.map(w => act.get(w) - prj.get(w));
    // Every player with any history keeps his residuals, even below minWeeks: the
    // quantiles are shrunk toward the positional prior by n/(n+n0), so a two-week
    // sample contributes almost nothing rather than nothing at all. Sigma keeps the
    // stricter gate, because a two-week standard deviation is noise, not a number.
    residuals.set(p.id, res);
    if (weeks.length >= minWeeks) {
      const mean = res.reduce((a, b) => a + b, 0) / res.length;
      const sd = Math.sqrt(res.reduce((a, b) => a + (b - mean) ** 2, 0) / (res.length - 1));
      bySigma.set(p.id, sd);
      all.push(sd);
      if (!posSamples.has(p.pos)) posSamples.set(p.pos, []);
      posSamples.get(p.pos).push(sd);
      // The prior a small sample is shrunk toward must not itself be made of small
      // samples, so the pooled positional residuals take only these players.
      if (!posResiduals.has(p.pos)) posResiduals.set(p.pos, []);
      posResiduals.get(p.pos).push(...res);
    }
  }
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const byPos = new Map([...posSamples].map(([k, v]) => [k, median(v)]));
  return { bySigma, byPos, global: median(all) ?? 6, measured: bySigma.size,
           residuals, byPosResiduals: posResiduals };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `node extension/test/run-all.mjs`
Expected: `distributions.mjs` prints `DISTRIBUTIONS OK`; `availability.mjs`, `market.mjs`, `parity.mjs` and `sources.mjs` all unchanged and green; `5 files, 0 failing`.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/league.js extension/test/distributions.mjs
git commit -m "Keep the residuals volatility already measured"
```

---

### Task 2: Quantiles, ranges and the CORR table

**Files:**
- Create: `extension/engine/distribution.js`
- Modify: `extension/test/distributions.mjs`

**Interfaces:**
- Consumes: `measureVolatility`'s return value (Task 1); player records `{ id, pos, nfl, proj }`.
- Produces:
  - `CORR: { qbToPass: 0.25, sameTeam: 0.10, rb: 0, sameGame: -0.05 }` — frozen.
  - `Z90: 1.2815515655446004`
  - `posFamily(pos: string): "QB" | "RB" | "PASS" | "OTHER"`
  - `isRealTeam(nfl: string): boolean`
  - `rho(a: {pos, nfl}, b: {pos, nfl}, opts?: {sameGame?: boolean}): number`
  - `quantiles(residuals: number[], shrinkTo: {p10,p50,p90}, n0?: number): {p10,p50,p90}`
  - `buildDistribution(vol, players: Map<id, player>, n0?: number): Dist`
    where `Dist = { of: Map<id,{p10,p50,p90,n}>, byPos: Map<pos,{p10,p50,p90}>,
    global: {p10,p50,p90}, cvOf: Map<id, number>, byPosCv: Map<pos, number>, n0: number }`
  - `playerRange(player, w: number, dist): {floor, median, ceiling}` — `w` is the **ESPN week number**, the key of `player.proj`.
  - `cv(player, dist): number`

Ruling to encode in a comment: the spec writes `cv(player)`, which cannot shrink toward a positional prior with no access to one. The signature is `cv(player, dist)`.

- [ ] **Step 1: Write the failing test**

Append to `extension/test/distributions.mjs`, immediately before the final `console.log(...)` summary lines:

```js
/* ---- 2. quantiles, ranges and the correlation table ---- */
{
  const S = [-10, -5, 0, 5, 10];
  const TO = { p10: -20, p50: 0, p90: 20 };

  // n = 0 is pure prior.
  const none = quantiles([], TO);
  ok(none.p10 === -20 && none.p50 === 0 && none.p90 === 20,
     "with no sample the quantiles are the positional ones");

  // n = 5, n0 = 10 -> weight 1/3 on the sample. Linear-interpolated sample
  // quantiles of [-10,-5,0,5,10] are -8, 0, 8, so the shrunk values are exactly
  // (1/3)(-8) + (2/3)(-20) = -16, 0, and +16.
  const five = quantiles(S, TO);
  near(five.p10, -16, 1e-9, "n = 5 shrinks a third of the way to the sample");
  near(five.p50, 0, 1e-12, "the median of a symmetric sample and prior is zero");
  near(five.p90, 16, 1e-9, "and symmetrically on the ceiling");

  // n -> infinity is the sample's own. 200 copies of S has sample quantiles
  // -10, 0, 10 (the interpolation lands inside a run of equal values), and a
  // weight of 1000/1010, so p90 = 10.0990099...
  const big = [];
  for (let k = 0; k < 200; k++) big.push(...S);
  const many = quantiles(big, TO);
  near(many.p90, 10.099009900990099, 1e-9, "a large sample all but ignores the prior");
  ok(Math.abs(many.p90 - 10) < Math.abs(five.p90 - 8),
     "and is closer to its own quantile than a small one is to hers");
  ok(many.p10 < many.p50 && many.p50 < many.p90, "quantiles stay ordered");

  // playerRange floors at zero and keeps its order.
  const dist = { of: new Map([[7, { p10: -10, p50: -1, p90: 12, n: 8 }]]),
                 byPos: new Map([["WR", { p10: -6, p50: 0, p90: 6 }]]),
                 global: { p10: -5, p50: 0, p90: 5 },
                 cvOf: new Map(), byPosCv: new Map(), n0: 10 };
  const low = playerRange({ id: 7, pos: "WR", proj: { 3: 3 } }, 3, dist);
  ok(low.floor === 0, "a floor below zero is zero - nobody scores negative points");
  near(low.median, 2, 1e-12, "the median is the projection plus the median residual");
  near(low.ceiling, 15, 1e-12, "and the ceiling the projection plus p90");
  ok(low.floor <= low.median && low.median <= low.ceiling, "floor <= median <= ceiling");

  const high = playerRange({ id: 7, pos: "WR", proj: { 3: 14 } }, 3, dist);
  near(high.floor, 4, 1e-12, "a bigger projection lifts the floor off zero");
  near(high.ceiling, 26, 1e-12, "and the ceiling with it");

  const unknown = playerRange({ id: 99, pos: "WR", proj: { 3: 10 } }, 3, dist);
  near(unknown.floor, 4, 1e-12, "a player with no residuals falls back to his position");
  const alien = playerRange({ id: 99, pos: "HC", proj: { 3: 10 } }, 3, dist);
  near(alien.floor, 5, 1e-12, "and a position with no pool falls back to the league");

  // The correlation table. Real pro teams only.
  const P = (pos, nfl) => ({ pos, nfl });
  ok(rho(P("TQB", "KC"), P("WR", "KC")) === CORR.qbToPass, "QB to his own WR");
  ok(rho(P("QB", "KC"), P("TE", "KC")) === CORR.qbToPass, "QB to his own TE");
  ok(rho(P("WR", "KC"), P("TE", "KC")) === CORR.sameTeam, "two non-QB teammates");
  ok(rho(P("RB", "KC"), P("WR", "KC")) === 0, "a RB is uncorrelated with anyone");
  ok(rho(P("RB", "KC"), P("RB", "KC")) === 0, "including another RB");
  ok(rho(P("QB", "KC"), P("K", "KC")) === 0, "QB to a non-receiver is not in the table");
  ok(rho(P("WR", "KC"), P("WR", "BUF")) === 0, "different teams, different games");
  ok(rho(P("WR", "KC"), P("WR", "BUF"), { sameGame: true }) === CORR.sameGame,
     "opponents in the same game pull apart");
  ok(rho(P("TQB", "X"), P("WR", "X")) === 0,
     "the fixture's placeholder team is never correlated - this is what keeps parity green");
  ok(rho(P("TQB", "?"), P("WR", "?")) === 0, "nor is an unknown team");
  ok(rho(P("D/ST", "FA"), P("WR", "FA")) === 0, "nor a free agent");
  ok(!isRealTeam("X") && !isRealTeam("?") && !isRealTeam("FA") && isRealTeam("KC"),
     "isRealTeam names exactly the three placeholders");
  ok(CORR.qbToPass === 0.25 && CORR.sameTeam === 0.10 && CORR.rb === 0
       && CORR.sameGame === -0.05,
     "the constants are the ones the spec fixed");
  ok(posFamily("TQB") === "QB" && posFamily("QB") === "QB" && posFamily("RB") === "RB"
       && posFamily("WR") === "PASS" && posFamily("TE") === "PASS"
       && posFamily("D/ST") === "OTHER" && posFamily("K") === "OTHER",
     "a team quarterback is a quarterback; a kicker is neither passer nor runner");
  ok(Z90 > 1.28 && Z90 < 1.282, "z90 is the tenth-percentile normal deviate");

  // buildDistribution wires the three tiers together.
  {
    const vol = {
      bySigma: new Map([[1, 6]]),
      byPos: new Map([["WR", 6]]),
      global: 6,
      measured: 1,
      residuals: new Map([[1, [-6, -3, 0, 3, 6]], [2, [-2, 2]]]),
      byPosResiduals: new Map([["WR", [-6, -3, 0, 3, 6]]]),
    };
    const players = new Map([
      [1, { id: 1, pos: "WR", nfl: "KC", proj: { 1: 10, 2: 10, 3: 0 } }],
      [2, { id: 2, pos: "WR", nfl: "KC", proj: { 1: 8, 2: 8, 3: 0 } }],
    ]);
    const d = buildDistribution(vol, players);
    ok(d.of.get(1).n === 5, "the sample size rides along");
    ok(d.byPos.has("WR"), "the positional prior is built from the pooled residuals");
    ok(d.of.get(2).p90 < d.of.get(1).p90,
       "a two-week sample is pulled harder toward a wider prior than a five-week one");
    ok(d.global.p10 < 0 && d.global.p90 > 0, "the league-wide prior exists as a last resort");
    ok(cv(players.get(1), d) > 0, "a measured player has a coefficient of variation");
    near(cv(players.get(1), d), 0.6, 0.35,
         "and it is sigma over the mean projection, shrunk - 6/10 before shrinkage");
    ok(cv({ id: 404, pos: "WR" }, d) === d.byPosCv.get("WR"),
       "an unmeasured player falls back to his position's");
    ok(cv({ id: 404, pos: "HC" }, d) === 0, "and to zero when even that is missing");
  }
}
```

Add these names to the file's import block (edit the existing import section, do not add a second one):

```js
import { CORR, Z90, quantiles, buildDistribution, playerRange, cv, rho, isRealTeam,
         posFamily } from "../engine/distribution.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/distributions.mjs`
Expected: `Cannot find module .../engine/distribution.js`.

- [ ] **Step 3: Write `extension/engine/distribution.js`**

Create the file with exactly this content:

```js
/**
 * Measured distributions and the correlation between teammates.
 *
 * A sigma is a symmetric number and a fantasy week is not. Residuals are
 * right-skewed with a floor near zero - a receiver's bad week is bounded below by
 * nothing and his good week is not bounded above - so "projection plus or minus a
 * sigma" invents a floor that cannot happen and misses the ceiling that decides
 * games. The residuals `measureVolatility` already computes are the real shape, and
 * their 10th, 50th and 90th percentiles are what this module publishes.
 *
 * The second half of the file is correlation. Two players on the same NFL team do
 * not score independently: a quarterback's good day is his receivers' good day, so
 * a stacked lineup's spread is wider than the root of the summed variances. The
 * constants live in ONE table, `CORR`, and they apply only when both players have a
 * real pro team - never for the fixture's placeholder "X", an unresolved "?" or a
 * free agent's "FA". That guard is load-bearing: it is what keeps parity.mjs green.
 */

/**
 * The whole correlation model. One table, one place.
 *
 * Values are the middle of the range the public work reports for full-PPR scoring;
 * they are deliberately conservative, because being wrong about a correlation costs
 * a mis-stated spread on every downstream number.
 */
export const CORR = {
  qbToPass: 0.25,   // same NFL team, QB with a WR or TE
  sameTeam: 0.10,   // same NFL team, neither of them a QB
  rb: 0,            // a RB with anyone: his carries are not the passing game
  sameGame: -0.05,  // opponents in the same NFL game: one offence's yards are the other's absence
};

/** z for the 10th/90th percentile of a normal. */
export const Z90 = 1.2815515655446004;

/** Teams that are not teams. Correlation is off for every one of them. */
const PLACEHOLDER = new Set(["X", "?", "FA", "", null, undefined]);

export function isRealTeam(nfl) {
  return typeof nfl === "string" && nfl.length > 0 && !PLACEHOLDER.has(nfl);
}

/**
 * The correlation family a display position belongs to.
 *
 * This is the one place the engine reads a position string for anything but
 * display, and it reads it only to pick a correlation - never to seat a player.
 * `TQB` is this league's team-quarterback entity and behaves as a quarterback.
 */
export function posFamily(pos) {
  if (pos === "QB" || pos === "TQB") return "QB";
  if (pos === "RB") return "RB";
  if (pos === "WR" || pos === "TE") return "PASS";
  return "OTHER";
}

/**
 * Correlation between two players' weekly scores.
 *
 * @param a {{pos: string, nfl: string}}
 * @param b {{pos: string, nfl: string}}
 * @param opts.sameGame true when the two pro teams meet each other that week
 */
export function rho(a, b, { sameGame = false } = {}) {
  if (!a || !b) return 0;
  if (!isRealTeam(a.nfl) || !isRealTeam(b.nfl)) return 0;
  if (a.nfl !== b.nfl) return sameGame ? CORR.sameGame : 0;
  const fa = posFamily(a.pos), fb = posFamily(b.pos);
  if (fa === "RB" || fb === "RB") return CORR.rb;
  if (fa === "QB" && fb === "QB") return 0;
  if (fa === "QB" || fb === "QB") {
    const other = fa === "QB" ? fb : fa;
    return other === "PASS" ? CORR.qbToPass : 0;
  }
  return CORR.sameTeam;
}

/** Linear-interpolated sample quantile. Returns null for an empty sample. */
function q(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const i = p * (n - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * The 10th, 50th and 90th percentiles of a residual sample, shrunk toward a prior.
 *
 * A six-week sample's 90th percentile is one observation, so it is shrunk toward the
 * position's pooled quantiles with weight n/(n+n0). n0 = 10 makes a full prior season
 * count for about 63% of its own quantile and a two-week sample for 17%.
 */
export function quantiles(residuals, shrinkTo, n0 = 10) {
  const to = shrinkTo ?? { p10: 0, p50: 0, p90: 0 };
  const n = residuals?.length ?? 0;
  if (!n) return { p10: to.p10, p50: to.p50, p90: to.p90, n: 0 };
  const s = [...residuals].sort((x, y) => x - y);
  const w = n / (n + n0);
  return {
    p10: w * q(s, 0.10) + (1 - w) * to.p10,
    p50: w * q(s, 0.50) + (1 - w) * to.p50,
    p90: w * q(s, 0.90) + (1 - w) * to.p90,
    n,
  };
}

/** Mean projection over the weeks he is actually projected to play. */
function meanProj(player) {
  const v = Object.values(player?.proj ?? {}).filter((x) => x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * Everything the panel and the gameplan need, computed once.
 *
 * Three tiers, each the fallback for the one above: the player's own shrunk
 * quantiles, his position's pooled ones, and the league's. A player ESPN has never
 * projected before still gets a range rather than a dash.
 */
export function buildDistribution(vol, players, n0 = 10) {
  const pooled = [];
  for (const r of (vol?.byPosResiduals ?? new Map()).values()) pooled.push(...r);
  const global = quantiles(pooled, { p10: -(vol?.global ?? 6) * Z90, p50: 0,
                                     p90: (vol?.global ?? 6) * Z90 }, n0);

  const byPos = new Map();
  for (const [pos, res] of vol?.byPosResiduals ?? new Map())
    byPos.set(pos, quantiles(res, global, n0));

  const of = new Map();
  for (const [id, res] of vol?.residuals ?? new Map()) {
    const p = players?.get?.(id);
    of.set(id, quantiles(res, byPos.get(p?.pos) ?? global, n0));
  }

  // The coefficient of variation is a sticky trait - a boom-or-bust player stays
  // one - so it is worth reporting per player rather than per position, shrunk the
  // same way the quantiles are.
  const rawCv = new Map(), posCv = new Map();
  for (const [id, sd] of vol?.bySigma ?? new Map()) {
    const p = players?.get?.(id);
    const m = meanProj(p);
    if (!(m > 0)) continue;
    rawCv.set(id, sd / m);
    if (!posCv.has(p.pos)) posCv.set(p.pos, []);
    posCv.get(p.pos).push(sd / m);
  }
  const byPosCv = new Map([...posCv].map(([k, v]) => [k, median(v)]));
  const cvOf = new Map();
  for (const [id, res] of vol?.residuals ?? new Map()) {
    const p = players?.get?.(id);
    const prior = byPosCv.get(p?.pos) ?? 0;
    const m = meanProj(p);
    const own = rawCv.get(id) ?? (m > 0 && res.length > 1
      ? Math.sqrt(res.reduce((a, b) => a + b * b, 0) / (res.length - 1)) / m : null);
    if (own == null) { cvOf.set(id, prior); continue; }
    const w = res.length / (res.length + n0);
    cvOf.set(id, w * own + (1 - w) * prior);
  }

  return { of, byPos, global, cvOf, byPosCv, n0 };
}

/**
 * A player's floor, median and ceiling for one week.
 *
 * `w` is the ESPN week number - the key of `player.proj`, not an engine week index.
 * The floor is clamped at zero: a fantasy score cannot be negative in any scoring
 * setting this engine supports, and a p10 of -14 on an 8-point projection means
 * "he busts", not "he loses you six points".
 */
export function playerRange(player, w, dist) {
  const proj = player?.proj?.[w] ?? 0;
  const qs = dist?.of?.get(player?.id)
    ?? dist?.byPos?.get(player?.pos)
    ?? dist?.global
    ?? { p10: 0, p50: 0, p90: 0 };
  return {
    floor: Math.max(0, proj + qs.p10),
    median: Math.max(0, proj + qs.p50),
    ceiling: Math.max(0, proj + qs.p90),
  };
}

/** Sigma over mean projection, shrunk toward the position's. See buildDistribution. */
export function cv(player, dist) {
  return dist?.cvOf?.get(player?.id) ?? dist?.byPosCv?.get(player?.pos) ?? 0;
}
```

- [ ] **Step 4: Run the tests**

Run: `node extension/test/run-all.mjs`
Expected: `DISTRIBUTIONS OK`, everything else green, `5 files, 0 failing`.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/distribution.js extension/test/distributions.mjs
git commit -m "Measure a floor and a ceiling instead of guessing a symmetric one"
```

---

### Task 3: Stack covariance in `rosterSigma`

**Files:**
- Modify: `extension/engine/distribution.js` (append `attachCovariance`, `stacks`, `lineupRange`)
- Modify: `extension/engine/search.js` — **the body of `rosterSigma` only** (lines 420–435)
- Modify: `extension/test/distributions.mjs`

**Interfaces:**
- Consumes: `rho`, `isRealTeam`, `posFamily`, `Z90` (Task 2); `Engine.starterMask`, `Engine.rosterSigma`, `Engine.sigmaOf`, `Engine.avail`, `Engine.proj`, `Engine.ids`, `Engine.weeks`, `Engine.n`, `Engine.NW`.
- Produces:
  - `attachCovariance(eng, players, opts?: {gameOf?: (nfl: string, week: number) => any}): Engine`
    — sets `eng.rhoOf(i, j, w) -> number`, `eng.corrMeta: Map<index, {pos, nfl}>` and
    `eng.stacks(ids, w?) -> [{a, b, rho, nfl, label}]`, and clears `eng._teamSigma`.
  - `stacks(eng, ids, w = 0): [{a, b, rho, nfl, label}]`
  - `lineupRange(eng, ids, w): {floor, median, ceiling}` — `w` is an engine week **index**.
  - `Engine.rosterSigma(ids)` adds `2 Σ_{i<j} ρ_ij σ_i σ_j` when `this.rhoOf` is set, and is byte-for-byte equivalent to today when it is not.

**Ruling — the spec's `dist` parameter is dropped from `lineupRange`.** The spec writes
`lineupRange(eng, ids, w, dist)`, but the function computes the team total as a normal
around the lineup's mean and never reads a per-player quantile, so `dist` would be an
unused parameter — a lie about what the function depends on. If a later phase makes the
team range skew-aware, it adds the argument back then.

**Why the attach, and not an import.** The parallel-build rules let this phase edit only `rosterSigma` in `search.js`; Phase 4 owns the rest of the file at the same time. An `import` line and a `stacks()` method would both be edits outside that method. Attaching `rhoOf` and `stacks` from `distribution.js` keeps the `search.js` diff to one method body with no import, and still gives the spec's `eng.stacks(ids)` call shape.

**How covariance composes with Phase 2's availability weighting.** `rosterSigma`
already weights each starter's variance by his probability of playing, so his
effective standard deviation that week is `sqrt(p_i) · σ_i`. The covariance term uses
the same effective deviations, `2 ρ_ij sqrt(p_i p_j) σ_i σ_j`. Scaling a covariance
matrix by a positive diagonal preserves positive semi-definiteness, so the total can
never go negative for any correlation matrix that was valid unweighted; the `Math.max(0, …)`
clamp is belt and braces against a future constant that is not.

- [ ] **Step 1: Write the failing test**

Append to `extension/test/distributions.mjs`, immediately before the final `console.log(...)` summary lines:

```js
/* ---- 3. stack covariance ---- */
{
  // Team A's roster is fixture indices 0..15 and its week-1 starters are
  // 1 (TQB), 2 (RB), 3 (RB), 6 (WR), 7 (WR), 8 (WR), 10 (TE), 13 (D/ST), 14 (K).
  // With a uniform sigma of 10 across nine starters the independent spread is
  // sqrt(9 * 100) = 30 exactly, which makes every closed form below readable.
  const T0 = F.teams[0];
  const uniform = { bySigma: new Map(F.pos.map((_, i) => [i, 10])),
                    byPos: new Map(), global: 10, measured: F.pos.length,
                    residuals: new Map(), byPosResiduals: new Map() };
  const build = (nflOf) => {
    const m = mkModel(nflOf);
    const e = mkEngine(m);
    e.setVolatility(uniform);
    return { e, m };
  };
  const WK0 = [1, 2, 3, 6, 7, 8, 10, 13, 14];

  {
    const { e } = build(() => "X");
    const sm = e.starterMask(e.roster.get(T0));
    ok([...sm].filter(([, mm]) => mm[0]).map(([i]) => i).join(",") === WK0.join(","),
       "the fixture's week-1 starters are the nine this block reasons about");
    near(e.rosterSigma(e.roster.get(T0))[0], 30, 1e-9,
         "nine starters at sigma 10 are sqrt(900) with no correlation attached");
  }

  // The parity guard. Every fixture player is on "X", so attaching covariance to a
  // fixture engine must change nothing at all.
  {
    const { e, m } = build(() => "X");
    const before = Array.from(e.rosterSigma(e.roster.get(T0)));
    attachCovariance(e, m.players);
    const after = Array.from(e.rosterSigma(e.roster.get(T0)));
    ok(before.every((x, i) => Math.abs(x - after[i]) < 1e-12),
       "covariance attached to an all-\"X\" league is the independent value - the parity guard");
    ok(e.stacks(e.roster.get(T0), 0).length === 0,
       "and it reports no stacks");
  }

  // QB + WR on the same real team: sqrt(900 + 2 * 0.25 * 10 * 10) = sqrt(950).
  {
    const { e, m } = build((i) => (i === 1 || i === 6 ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], Math.sqrt(950), 1e-9,
         "a QB-WR stack widens the spread by exactly the closed form");
    const st = e.stacks(e.roster.get(T0), 0);
    ok(st.length === 1, "and the pair is listed once, not twice");
    ok(st[0].a === 1 && st[0].b === 6 && st[0].rho === CORR.qbToPass,
       "with the lower index first and the table's own value");
    ok(st[0].nfl === "KC" && st[0].label === "QB+WR", "and enough to render a flag");
  }

  // Two non-QB teammates: sqrt(900 + 2 * 0.10 * 100) = sqrt(920).
  {
    const { e, m } = build((i) => (i === 6 || i === 7 ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], Math.sqrt(920), 1e-9,
         "two receivers on one team are the non-QB constant");
  }

  // Three receivers: three pairs, sqrt(900 + 6 * 0.10 * 100) = sqrt(960).
  {
    const { e, m } = build((i) => ([6, 7, 8].includes(i) ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], Math.sqrt(960), 1e-9,
         "three teammates are three pairs, not two");
    ok(e.stacks(e.roster.get(T0), 0).length === 3, "and three stack rows");
  }

  // The whole passing game: 3 QB-WR pairs at .25 and 3 WR-WR pairs at .10.
  {
    const { e, m } = build((i) => ([1, 6, 7, 8].includes(i) ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], Math.sqrt(1110), 1e-9,
         "a QB with his three receivers is 900 + 150 + 60");
  }

  // A running back is uncorrelated with everybody, teammates included.
  {
    const { e, m } = build((i) => ([2, 3, 6].includes(i) ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], 30, 1e-9,
         "two RBs and a WR on one team add nothing - the RB rule overrides");
    ok(e.stacks(e.roster.get(T0), 0).length === 0, "and there is no stack to flag");
  }

  // A bench player on the same team is not a starter and must not count.
  {
    const { e, m } = build((i) => ([1, 0].includes(i) ? "KC" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], 30, 1e-9,
         "a benched teammate contributes no covariance - only starters do");
  }

  // Cross-game, through the injected lookup. Without gameOf the term is skipped.
  {
    const { e, m } = build((i) => (i === 1 ? "KC" : i === 6 ? "BUF" : "X"));
    attachCovariance(e, m.players);
    near(e.rosterSigma(e.roster.get(T0))[0], 30, 1e-9,
         "with no schedule of pro games the cross-game term is skipped");

    const { e: e2, m: m2 } = build((i) => (i === 1 ? "KC" : i === 6 ? "BUF" : "X"));
    attachCovariance(e2, m2.players, {
      gameOf: (nfl, week) => (week === 1 && (nfl === "KC" || nfl === "BUF") ? "KC@BUF" : null),
    });
    near(e2.rosterSigma(e2.roster.get(T0))[0], Math.sqrt(890), 1e-9,
         "opponents in one game pull the spread in");
    near(e2.rosterSigma(e2.roster.get(T0))[1], 30, 1e-9,
         "and only in the week they actually meet");
  }

  // Availability composes: p = 0.5 on every starter halves the variance, correlated
  // or not, because the covariance term uses the same sqrt(p) * sigma deviations.
  {
    const { e, m } = build((i) => (i === 1 || i === 6 ? "KC" : "X"));
    attachCovariance(e, m.players);
    const plain = e.rosterSigma(e.roster.get(T0))[0];
    const half = new Map(e.roster.get(T0).map((i) => {
      const row = new Float64Array(NW).fill(1);
      if (WK0.includes(i)) row[0] = 0.5;
      return [e.ids[i], row];
    }));
    const { e: e3, m: m3 } = build((i) => (i === 1 || i === 6 ? "KC" : "X"));
    e3.setAvailability(half);
    attachCovariance(e3, m3.players);
    near(e3.rosterSigma(e3.roster.get(T0))[0], plain / Math.SQRT2, 1e-9,
         "p = 0.5 halves the variance of the correlated spread too");
  }

  // lineupRange puts the team total on a normal, which is the honest shape for a sum.
  {
    const { e, m } = build((i) => (i === 1 || i === 6 ? "KC" : "X"));
    attachCovariance(e, m.players);
    const r = lineupRange(e, e.roster.get(T0), 0);
    const mu = e.baseline.get(T0)[0];
    near(r.median, mu, 1e-9, "the centre of the team range is the lineup's mean");
    near(r.ceiling - r.median, Z90 * Math.sqrt(950), 1e-9,
         "and the ceiling is z90 sigmas above it, correlation included");
    near(r.median - r.floor, Z90 * Math.sqrt(950), 1e-9, "symmetrically below");
    ok(r.floor >= 0, "a team floor is never negative");
  }
}
```

Extend the `distribution.js` import in the file's import block to add `attachCovariance`, `stacks` and `lineupRange`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/distributions.mjs`
Expected: `SyntaxError: The requested module '../engine/distribution.js' does not provide an export named 'attachCovariance'`.

- [ ] **Step 3: Append the covariance helpers to `distribution.js`**

Append to `extension/engine/distribution.js`:

```js
/**
 * Teach an Engine about correlation, from outside.
 *
 * The parallel-build rules give this phase exactly one method of `search.js` -
 * `rosterSigma` - so the correlation cannot arrive as an import there. It arrives as
 * an attached function instead: `rosterSigma` adds a covariance term if and only if
 * `eng.rhoOf` exists, so an engine nobody attaches to behaves exactly as it did
 * before. That is also the mechanism that keeps `parity.mjs` green, twice over: it
 * never calls this, and every fixture player is on "X" anyway.
 *
 * @param players Map<playerId, {pos, nfl}> - the model's player map
 * @param gameOf  optional (nflAbbrev, weekNumber) -> game key, for the cross-game
 *   term. Phase 7 publishes `gameOf(proTeamId, week)`; the call site adapts the id
 *   to the abbreviation. Absent, the cross-game term is skipped entirely.
 */
export function attachCovariance(eng, players, { gameOf = null } = {}) {
  const meta = new Map();
  for (let i = 0; i < eng.n; i++) {
    const p = players?.get?.(eng.ids[i]);
    meta.set(i, { pos: p?.pos ?? "?", nfl: p?.nfl ?? "?" });
  }
  eng.corrMeta = meta;
  eng.rhoOf = (i, j, w) => {
    const a = meta.get(i), b = meta.get(j);
    if (!a || !b) return 0;
    if (a.nfl === b.nfl) return rho(a, b);
    if (!gameOf || !isRealTeam(a.nfl) || !isRealTeam(b.nfl)) return 0;
    const week = eng.weeks[w];
    const ga = gameOf(a.nfl, week);
    return ga != null && ga === gameOf(b.nfl, week) ? rho(a, b, { sameGame: true }) : 0;
  };
  eng.stacks = (ids, w = 0) => stacks(eng, ids, w);
  // teamSigma memoises, and it memoised the uncorrelated answer.
  eng._teamSigma = null;
  return eng;
}

/**
 * The correlated pairs among a roster's starters in one week, each listed once.
 *
 * `w` is an engine week index. Bench players are excluded: a stack you are not
 * starting is not a stack, it is depth.
 */
export function stacks(eng, ids, w = 0) {
  if (!eng.corrMeta) return [];
  const mask = eng.starterMask(ids);
  const on = [...mask].filter(([, m]) => m[w]).map(([i]) => i).sort((a, b) => a - b);
  const out = [];
  for (let x = 0; x < on.length; x++) {
    for (let y = x + 1; y < on.length; y++) {
      const r = eng.rhoOf(on[x], on[y], w);
      if (!r) continue;
      const a = eng.corrMeta.get(on[x]), b = eng.corrMeta.get(on[y]);
      const fam = (p) => (posFamily(p.pos) === "QB" ? "QB" : p.pos);
      out.push({ a: on[x], b: on[y], rho: r, nfl: a.nfl === b.nfl ? a.nfl : null,
                 label: `${fam(a)}+${fam(b)}` });
    }
  }
  return out;
}

/**
 * A team's floor, median and ceiling for one week, as a normal.
 *
 * A single player's score is not normal - it is a mixture of a bust and a big game,
 * bounded below at zero and long-tailed above - which is why `playerRange` uses his
 * measured quantiles instead. A lineup total is a sum of nine such scores of
 * comparable size and mostly modest correlation, and that is precisely the situation
 * the central limit theorem describes: the sum is far closer to symmetric than any
 * of its terms, so `mean +/- z * sigma_team` is the honest shape here even though it
 * would be the wrong one one level down.
 *
 * `w` is an engine week index. `sigma_team` comes from `rosterSigma`, so it already
 * carries both the availability weighting and the covariance. There is deliberately
 * no `dist` argument: nothing here reads a per-player quantile.
 */
export function lineupRange(eng, ids, w) {
  const mask = eng.starterMask(ids);
  const av = eng.avail, NW = eng.NW;
  let mu = 0;
  for (const [i, m] of mask)
    if (m[w]) mu += (av ? av[i * NW + w] : 1) * eng.proj[i * NW + w];
  const sig = eng.rosterSigma(ids)?.[w] ?? 0;
  return { floor: Math.max(0, mu - Z90 * sig), median: mu, ceiling: mu + Z90 * sig };
}
```

- [ ] **Step 4: Add the covariance term to `rosterSigma`**

In `extension/engine/search.js`, replace the whole of `rosterSigma` (lines 420–435) with the following. **Change nothing else in this file** — not the imports, not `teamSigma`, not a neighbouring method.

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `node extension/test/run-all.mjs`
Expected: `DISTRIBUTIONS OK`; `availability.mjs` still green — including its
`p = 0.5 halves the variance, not the sigma` assertion, which exercises the no-`rhoOf`
path; `parity.mjs` unchanged and green. `5 files, 0 failing`.

- [ ] **Step 6: Confirm the `search.js` diff is one method**

Run: `git diff --stat extension/engine/search.js && git diff -U0 extension/engine/search.js | head -60`
Expected: a single hunk inside `rosterSigma`. If the diff touches any other method or the import block, revert those lines before committing.

- [ ] **Step 7: Commit**

```bash
git add extension/engine/distribution.js extension/engine/search.js extension/test/distributions.mjs
git commit -m "Count the correlation between teammates in a roster's spread"
```

---

### Task 4: The weekly P(win) lineup

**Files:**
- Create: `extension/engine/gameplan.js`
- Modify: `extension/test/distributions.mjs`

**Interfaces:**
- Consumes: `bestLineupSeats` from `lineup.js`; `winProb`, `FALLBACK_SIGMA` from `winprob.js`; `Z90` from `distribution.js`; `eng.opp`, `eng.baseline`, `eng.teamSigma`, `eng.rhoOf`, `eng.sigmaOf`, `eng.proj`, `eng.avail`, `eng.mask`, `eng.starters`, `eng.roster`.
- Produces:
  - `lineupStats(eng, starters: number[], w: number): {mu, sigma}` — a **given** lineup's mean and spread.
  - `feasible(eng, starters: number[]): boolean` — can every one of them be seated at once.
  - `gameplan(eng, team: string, w: number, opts?): Plan | null` where
    ```
    Plan = { opponent, week, pWinMean, pWinBest,
             lineupMean: number[], lineupBest: number[],
             swaps: [{out: number, in: number, dP: number}],
             me: {floor, median, ceiling}, them: {floor, median, ceiling} }
    ```
    `w` is an engine week index. Returns `null` when volatility is unmeasured or the
    team has no scheduled opponent that week.

**Rulings to encode in comments:**
1. `lineupStats` deliberately repeats `rosterSigma`'s arithmetic. `rosterSigma` re-solves the *optimal* lineup for the roster it is handed; this needs the mean and spread of a **specific** lineup, which is a different question. A test asserts the two agree on the mean-optimal lineup, so the duplication cannot drift silently.
2. The opponent is priced from `eng.baseline` and `eng.teamSigma` — the spec says so. Those are the expectation of his *optimal* lineup; ours is a chosen one. The two estimators differ by a hair, and `pWinMean` may therefore differ slightly from `eng.weekWins`. Within one gameplan every lineup is priced the same way, which is what makes the swaps comparable, and that is the number the section is about.
3. Candidates are every rostered player with a play probability above zero, including one below 0.5 whom `starterMask` would not show. `mu` already discounts him by `p`; excluding him would rule out precisely the dart an underdog wants.
4. The spec's `dist` parameter is dropped here for the same reason it is dropped from `lineupRange` — nothing in the plan reads a per-player quantile.

- [ ] **Step 1: Write the failing test**

Append to `extension/test/distributions.mjs`, immediately before the final `console.log(...)` summary lines:

```js
/* ---- 4. the weekly P(win) lineup ---- */
{
  // A two-team, one-week, one-seat league, so every number below is checkable by
  // hand. Team A may start one RB: a steady 10 or a wild 8.
  const tiny = (opts) => {
    const { slots: sl, starters: st } = buildSlots(opts.slotCounts);
    const model = {
      weeks: [1],
      settings: { currentWeek: 1, regularSeasonWeeks: [1], playoffWeeks: [],
                  playoffRoundWeeks: [], playoffTeams: 2, playoffReseed: false,
                  lineupSlotCounts: opts.slotCounts },
      players: new Map(opts.players.map((p) => [p.id, {
        ...p, proj: { 1: p.p }, bye: 0,
      }])),
      teams: new Map([
        [0, { id: 0, name: "Team A", roster: new Set(opts.a) }],
        [1, { id: 1, name: "Team B", roster: new Set(opts.b) }],
      ]),
    };
    const mk = new Map(opts.players.map((p) => [p.id, seatMask(p.eligibleSlots, sl)]));
    const e = new Engine(model, { starters: st }, mk);
    e.setVolatility({ bySigma: new Map(opts.players.map((p) => [p.id, p.s])),
                      byPos: new Map(), global: 10, measured: opts.players.length,
                      residuals: new Map(), byPosResiduals: new Map() });
    attachCovariance(e, model.players);
    e.setSchedule(new Map([[1, [["Team A", "Team B"]]]]));
    return { e, model };
  };
  const RB = [2, 20], WR = [4, 20];

  // Trailing badly: the wild lineup is worth 14.6 percentage points.
  {
    const { e } = tiny({
      slotCounts: { "2": 1 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 10, s: 2 },
                { id: 1, pos: "RB", nfl: "X", eligibleSlots: RB, p: 8, s: 12 },
                { id: 2, pos: "RB", nfl: "X", eligibleSlots: RB, p: 20, s: 5 }],
      a: [0, 1], b: [2],
    });
    const gp = gameplan(e, "Team A", 0);
    ok(gp.opponent === "Team B", "the plan names the scheduled opponent");
    near(gp.pWinMean, 0.031658830926, 1e-9,
         "the mean-optimal lineup is a 3.2% shot against a 20-point favourite");
    near(gp.pWinBest, 0.177983534902, 1e-9,
         "and the high-variance lineup is a 17.8% shot");
    ok(gp.swaps.length === 1, "one swap gets there");
    ok(gp.swaps[0].out === 0 && gp.swaps[0].in === 1,
       "the steady 10 comes out for the wild 8");
    near(gp.swaps[0].dP, 0.146324703976, 1e-9, "and it is worth 14.6 points of win probability");
    ok(gp.lineupMean.join(",") === "0" && gp.lineupBest.join(",") === "1",
       "both lineups are reported");
    ok(gp.me.ceiling > gp.me.median && gp.me.median > gp.me.floor,
       "the range is ordered");
    ok(gp.them.median > gp.me.median, "and the favourite's centre is above ours");
  }

  // Leading comfortably: variance is now the enemy and nothing moves.
  {
    const { e } = tiny({
      slotCounts: { "2": 1 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 10, s: 2 },
                { id: 1, pos: "RB", nfl: "X", eligibleSlots: RB, p: 8, s: 12 },
                { id: 2, pos: "RB", nfl: "X", eligibleSlots: RB, p: 2, s: 5 }],
      a: [0, 1], b: [2],
    });
    const gp = gameplan(e, "Team A", 0);
    near(gp.pWinMean, 0.931302555604, 1e-9, "a heavy favourite wins 93% of the time");
    ok(gp.swaps.length === 0, "and never trades that away for a swingier lineup");
    ok(gp.pWinBest === gp.pWinMean, "so the best plan is the mean-optimal one");
    ok(gp.lineupBest.join(",") === gp.lineupMean.join(","), "and the same lineup");
  }

  // Legality: a swap that cannot be seated is never offered. One RB seat and one WR
  // seat; swapping the RB out for a second WR would leave the RB seat empty.
  {
    const { e } = tiny({
      slotCounts: { "2": 1, "4": 1 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 10, s: 2 },
                { id: 1, pos: "WR", nfl: "X", eligibleSlots: WR, p: 9, s: 3 },
                { id: 2, pos: "WR", nfl: "X", eligibleSlots: WR, p: 8, s: 14 },
                { id: 3, pos: "RB", nfl: "X", eligibleSlots: RB, p: 30, s: 5 }],
      a: [0, 1, 2], b: [3],
    });
    ok(feasible(e, [0, 1]), "a RB and a WR fill a RB seat and a WR seat");
    ok(!feasible(e, [1, 2]), "two WRs cannot fill a RB seat");
    const gp = gameplan(e, "Team A", 0);
    ok(gp.swaps.every((s) => s.out !== 0),
       "the RB is never swapped out for a second WR - the lineup would be illegal");
    near(gp.pWinMean, 0.037176402015, 1e-9, "the mean-optimal lineup's odds");
    near(gp.pWinBest, 0.211855333665, 1e-9, "and the best legal lineup's");
  }

  // P(win) never decreases across accepted swaps, and the search terminates.
  {
    const { e } = tiny({
      slotCounts: { "2": 2 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 12, s: 1 },
                { id: 1, pos: "RB", nfl: "X", eligibleSlots: RB, p: 11, s: 2 },
                { id: 2, pos: "RB", nfl: "X", eligibleSlots: RB, p: 9, s: 18 },
                { id: 3, pos: "RB", nfl: "X", eligibleSlots: RB, p: 8, s: 20 },
                { id: 4, pos: "RB", nfl: "X", eligibleSlots: RB, p: 60, s: 4 }],
      a: [0, 1, 2, 3], b: [4],
    });
    const gp = gameplan(e, "Team A", 0);
    ok(gp.swaps.every((s) => s.dP > 0), "every accepted swap strictly raised P(win)");
    ok(gp.pWinBest >= gp.pWinMean, "so the plan is never worse than the mean lineup");
    near(gp.pWinBest - gp.pWinMean,
         gp.swaps.reduce((a, s) => a + s.dP, 0), 1e-9,
         "and the deltas sum to the total gain");
    ok(gp.lineupBest.length === gp.lineupMean.length,
       "a swap keeps the lineup the same size");
    ok(feasible(e, gp.lineupBest), "and legal");
  }

  // lineupStats agrees with rosterSigma on the lineup rosterSigma would pick.
  {
    const T0 = F.teams[0];
    const m = mkModel((i) => ([1, 6, 7].includes(i) ? "KC" : "X"));
    const e = mkEngine(m);
    e.setVolatility({ bySigma: new Map(F.pos.map((_, i) => [i, 10])), byPos: new Map(),
                      global: 10, measured: F.pos.length,
                      residuals: new Map(), byPosResiduals: new Map() });
    attachCovariance(e, m.players);
    const sm = e.starterMask(e.roster.get(T0));
    const on = [...sm].filter(([, mm]) => mm[0]).map(([i]) => i);
    near(lineupStats(e, on, 0).sigma, e.rosterSigma(e.roster.get(T0))[0], 1e-9,
         "the two spread calculations agree on the optimal lineup - a drift guard");
    near(lineupStats(e, on, 0).mu, e.baseline.get(T0)[0], 1e-9,
         "and so do the means");
  }

  // No opponent, no plan.
  {
    const { e } = tiny({
      slotCounts: { "2": 1 },
      players: [{ id: 0, pos: "RB", nfl: "X", eligibleSlots: RB, p: 10, s: 2 },
                { id: 2, pos: "RB", nfl: "X", eligibleSlots: RB, p: 9, s: 5 }],
      a: [0], b: [2],
    });
    e.setSchedule(new Map());
    ok(gameplan(e, "Team A", 0) === null,
       "with nobody to play there is no gameplan");
    const bare = mkEngine(mkModel());
    ok(gameplan(bare, F.teams[0], 0) === null,
       "and with no measured volatility there is none either");
  }
}
```

Add one more import at the top of the test file (`buildSlots` and `seatMask` are
already imported by Task 1's header):

```js
import { gameplan, lineupStats, feasible } from "../engine/gameplan.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/distributions.mjs`
Expected: `Cannot find module .../engine/gameplan.js`.

- [ ] **Step 3: Write `extension/engine/gameplan.js`**

Create the file with exactly this content:

```js
/**
 * Which lineup is most likely to beat THIS opponent, this week.
 *
 * Every other number in this project maximises expected points. On Sunday morning
 * that is the wrong objective: an underdog does not want the highest mean, he wants
 * the fattest right tail, and a heavy favourite wants the opposite. P(win) is
 * Phi((mu - mu_opp) / sqrt(sigma^2 + sigma_opp^2)), and it is not monotone in mu -
 * so the lineup that maximises it is often not the lineup the rest of the engine
 * would field.
 *
 * This is a LOCAL SEARCH, and it is the only search in the project that is not
 * exhaustive. The trade search enumerates because the answer has to be trustworthy
 * and the space is a few million rosters; the lineup space is C(roster, starters)
 * over a full bench and then a matroid feasibility test on each, which is a
 * different order of problem for an answer a manager will eyeball anyway. Repeated
 * best single swaps from the mean-optimal lineup converge in a handful of rounds,
 * every step is a strict improvement, and the starting point is already the answer
 * to the question everyone else asks. Say so on screen; do not present it as exact.
 */
import { bestLineupSeats } from "./lineup.js";
import { winProb, FALLBACK_SIGMA } from "./winprob.js";
import { Z90 } from "./distribution.js";

/**
 * The mean and spread of one GIVEN lineup in one week.
 *
 * This repeats `rosterSigma`'s arithmetic on purpose. `rosterSigma` re-solves the
 * optimal lineup for whatever roster it is handed, which is the wrong question here:
 * the whole point is to price lineups the optimiser would not pick. The test suite
 * asserts the two agree on the mean-optimal lineup, so they cannot drift apart
 * unnoticed.
 */
export function lineupStats(eng, starters, w) {
  const av = eng.avail, NW = eng.NW;
  let mu = 0, v = 0;
  const sd = [];
  for (const i of starters) {
    const p = av ? av[i * NW + w] : 1;
    const s = eng.sigmaOf?.[i] ?? 0;
    mu += p * eng.proj[i * NW + w];
    v += p * s * s;
    if (eng.rhoOf) sd.push(i, Math.sqrt(p) * s);
  }
  if (eng.rhoOf) {
    for (let x = 0; x < sd.length; x += 2) {
      for (let y = x + 2; y < sd.length; y += 2) {
        const r = eng.rhoOf(sd[x], sd[y], w);
        if (r) v += 2 * r * sd[x + 1] * sd[y + 1];
      }
    }
  }
  return { mu, sigma: Math.sqrt(Math.max(0, v)) };
}

/**
 * Can all of these players be seated at once?
 *
 * The same transversal matroid the lineup solver uses. Kuhn's augmenting path
 * returns a MAXIMUM matching regardless of the order it is fed, so "every player got
 * a seat" is a sound feasibility test and does not depend on the sort.
 */
export function feasible(eng, starters) {
  if (starters.length > eng.starters) return false;
  const vals = new Float64Array(eng.n);
  for (const i of starters) vals[i] = 1;
  const seatOf = bestLineupSeats(starters.slice(), vals, eng.mask, eng.starters);
  let filled = 0;
  for (const s of seatOf) if (s >= 0) filled++;
  return filled === starters.length;
}

const sig = (s) => (s > 0 ? s : FALLBACK_SIGMA);

/**
 * The week's plan: the mean-optimal lineup, the P(win)-optimal one, and the swaps
 * between them.
 *
 * @param w engine week index
 * @returns null when volatility is unmeasured or nobody is scheduled that week
 */
export function gameplan(eng, team, w, { maxRounds = 24, minDelta = 1e-9 } = {}) {
  if (!eng.sigmaOf) return null;
  const opponent = eng.opp?.get(team)?.[w];
  if (!opponent) return null;

  const ids = eng.roster.get(team) ?? [];
  const av = eng.avail, NW = eng.NW;
  // Anyone who might play at all. A man at 40% is discounted inside `mu` already;
  // ruling him out here would exclude exactly the dart an underdog is looking for.
  const pool = ids.filter((i) => eng.mask[i] && (av ? av[i * NW + w] > 0 : true));

  // The mean-optimal seed, solved here rather than read from starterMask so that the
  // baseline and every candidate are priced by the same function.
  const vals = new Float64Array(eng.n);
  for (const i of pool) vals[i] = (av ? av[i * NW + w] : 1) * eng.proj[i * NW + w];
  const order = pool.slice().sort((a, b) => vals[b] - vals[a]);
  const seatOf = bestLineupSeats(order, vals, eng.mask, eng.starters);
  const lineupMean = [...seatOf].filter((p) => p >= 0).sort((a, b) => a - b);

  const them = {
    mu: eng.baseline.get(opponent)?.[w] ?? 0,
    sigma: sig(eng.teamSigma(opponent)?.[w] ?? 0),
  };
  const pOf = (line) => {
    const st = lineupStats(eng, line, w);
    return winProb(st.mu, sig(st.sigma), them.mu, them.sigma);
  };

  const pWinMean = pOf(lineupMean);
  let cur = lineupMean.slice();
  let best = pWinMean;
  const swaps = [];

  // Repeated best single swap. Each accepted move strictly increases P(win) and the
  // set of lineups is finite, so this terminates; maxRounds is a belt against a
  // future change that makes the objective non-strict.
  for (let round = 0; round < maxRounds; round++) {
    let pick = null;
    const bench = pool.filter((i) => !cur.includes(i));
    for (let k = 0; k < cur.length; k++) {
      for (const b of bench) {
        const cand = cur.slice();
        cand[k] = b;
        if (!feasible(eng, cand)) continue;
        const p = pOf(cand);
        if (p > best + minDelta && p > (pick?.p ?? -Infinity)) {
          pick = { p, out: cur[k], in: b, cand };
        }
      }
    }
    if (!pick) break;
    swaps.push({ out: pick.out, in: pick.in, dP: pick.p - best });
    best = pick.p;
    cur = pick.cand.sort((a, b) => a - b);
  }

  return {
    opponent, week: eng.weeks[w],
    pWinMean, pWinBest: best,
    lineupMean, lineupBest: cur,
    swaps,
    me: rangeOf(eng, cur, w),
    them: {
      floor: Math.max(0, them.mu - Z90 * them.sigma),
      median: them.mu,
      ceiling: them.mu + Z90 * them.sigma,
    },
  };
}

/** The chosen lineup's own range - lineupRange re-solves, so price this one directly. */
function rangeOf(eng, line, w) {
  const st = lineupStats(eng, line, w);
  const s = sig(st.sigma);
  return { floor: Math.max(0, st.mu - Z90 * s), median: st.mu, ceiling: st.mu + Z90 * s };
}
```


- [ ] **Step 4: Run the tests**

Run: `node extension/test/run-all.mjs`
Expected: `DISTRIBUTIONS OK`, `5 files, 0 failing`.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/gameplan.js extension/test/distributions.mjs
git commit -m "Pick the lineup most likely to beat this week's opponent"
```

---

### Task 5: The strings the page shows

**Files:**
- Create: `extension/panel/distributions.js`
- Modify: `extension/test/distributions.mjs`

**Interfaces:**
- Consumes: a `Plan` from `gameplan` (Task 4); `stacks()` output (Task 3); an `esc` function supplied by the caller; a `name(i)` function mapping engine index to display name.
- Produces:
  - `DIST_HINT: { floor: string, ceiling: string, pwin: string }`
  - `weekSection(gp, { esc, name, myTeam }): string` — the whole **This week** section's HTML, or `""` when `gp` is null.
  - `rangeBar(r, scale, esc): string` — one floor/median/ceiling bar.
  - `stackLine(pairs, { esc, name }): string` — `""` when there are none.
  - `stackNote(measured: number, corr): string` — the season note's swing sentence.
  - `SWAP_MIN = 0.01` — a swap is only recommended when it is worth a full percentage point.

Nothing here touches the DOM: `panel.js` hands in its own escaper and gets HTML back, exactly as `panel/availability.js` does.

- [ ] **Step 1: Write the failing test**

Append to `extension/test/distributions.mjs`, immediately before the final `console.log(...)` summary lines:

```js
/* ---- 5. the strings the page shows ---- */
{
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const name = (i) => `Player ${i}`;

  ok(weekSection(null, { esc, name, myTeam: "Team A" }) === "",
     "no plan renders nothing at all");

  const plan = {
    opponent: "Team B", week: 5,
    pWinMean: 0.412, pWinBest: 0.466,
    lineupMean: [1, 2], lineupBest: [1, 3],
    swaps: [{ out: 2, in: 3, dP: 0.054 }],
    me: { floor: 88, median: 121, ceiling: 154 },
    them: { floor: 95, median: 128, ceiling: 161 },
  };
  const html = weekSection(plan, { esc, name, myTeam: "Team A" });
  ok(html.includes("Team B"), "the opponent is named");
  ok(html.includes("41.2%"), "the mean lineup's win probability is shown");
  ok(html.includes("46.6%"), "and the best lineup's");
  ok(html.includes("Player 2") && html.includes("Player 3"),
     "the recommended swap names both players");
  ok(html.includes("+5.4pp"), "and states what it is worth");
  ok(html.includes("121") && html.includes("128"), "both teams' medians appear");
  ok(/heuristic|local search|not exhaustive/i.test(html),
     "and the section says the search is a heuristic, not an exhaustive one");

  // A swap under a percentage point is noise on numbers this soft.
  const small = weekSection({ ...plan, pWinBest: 0.4145,
    swaps: [{ out: 2, in: 3, dP: 0.0025 }] }, { esc, name, myTeam: "Team A" });
  ok(!small.includes("Player 3"),
     "a sub-one-point swap is not recommended - it is inside the model's own error");
  ok(small.includes("Team B"), "but the week is still described");
  ok(SWAP_MIN === 0.01, "and the bar is one percentage point");

  // Escaping. A team called <script> must not become one.
  const nasty = weekSection({ ...plan, opponent: '<script>x</script>' },
                            { esc, name, myTeam: "Team A" });
  ok(!nasty.includes("<script>"), "the opponent's name is escaped");

  // Stack flags.
  ok(stackLine([], { esc, name }) === "", "no stacks, no line");
  const sl = stackLine([{ a: 1, b: 6, rho: 0.25, nfl: "KC", label: "QB+WR" }],
                       { esc, name });
  ok(sl.includes("QB+WR") && sl.includes("KC"), "a stack flag names the shape and the team");
  const two = stackLine([{ a: 1, b: 6, rho: 0.25, nfl: "KC", label: "QB+WR" },
                         { a: 6, b: 7, rho: 0.10, nfl: "KC", label: "WR+WR" }],
                        { esc, name });
  ok((two.match(/KC/g) ?? []).length >= 2 || two.includes("2"),
     "two stacks are both reported");

  // The season note replaces the old independence disclaimer.
  const note = stackNote(140, CORR);
  ok(!/independen/i.test(note),
     "the note no longer claims the swing assumes independence - it does not");
  ok(/0\.25/.test(note) && /0\.1/.test(note),
     "and it states the constants it now uses");
  ok(/stack/i.test(note), "in the language of stacks");
  ok(/±25/.test(stackNote(0, CORR)) && !/0\.25/.test(stackNote(0, CORR)),
     "with no measurement it falls back to ±25 rather than quoting constants");
  ok(/no correlation/i.test(stackNote(0, CORR)),
     "and says plainly that no correlation is modelled");

  ok(DIST_HINT.floor.length > 40 && DIST_HINT.ceiling.length > 40
       && DIST_HINT.pwin.length > 40,
     "every new column has a real hint");
  ok(/10th/.test(DIST_HINT.floor) && /90th/.test(DIST_HINT.ceiling),
     "and the hints say which percentile they are");

  const bar = rangeBar({ floor: 88, median: 121, ceiling: 154 }, { lo: 80, hi: 170 }, esc);
  ok(bar.includes("<") && bar.includes("%"), "the range bar is positioned HTML");
}
```

Extend the imports at the top of the test file:

```js
import { DIST_HINT, SWAP_MIN, weekSection, rangeBar, stackLine, stackNote }
  from "../panel/distributions.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/distributions.mjs`
Expected: `Cannot find module .../panel/distributions.js`.

- [ ] **Step 3: Write `extension/panel/distributions.js`**

Create the file with exactly this content:

```js
/**
 * How the page talks about floors, ceilings, stacks and this week's game.
 *
 * Every string lives here rather than in panel.js, so that panel.js's diff for this
 * phase stays a handful of small hunks and the merge with the phases built alongside
 * it is mechanical. Nothing here touches the DOM: panel.js hands in its own escaper
 * and its own index-to-name function, and gets HTML strings back.
 */
import { CORR } from "../engine/distribution.js";

/**
 * How much a variance swap must be worth before it is recommended.
 *
 * The correlation constants are round numbers and the sigmas come from one prior
 * season, so a tenth of a percentage point is not a real difference. A full point
 * is, and a recommendation nobody should act on is worse than no recommendation.
 */
export const SWAP_MIN = 0.01;

export const DIST_HINT = {
  floor: "His 10th-percentile game: he scores this or worse one week in ten. "
       + "Measured from last season's residuals - actual minus projection, week by "
       + "week - and shrunk toward his position's, so a short history is pulled "
       + "toward the typical shape rather than trusted on its own. Never below zero.",
  ceiling: "His 90th-percentile game: he scores this or better one week in ten. "
         + "Measured the same way as the floor. The gap between the two is the whole "
         + "reason a projection is not a prediction.",
  pwin: "The chance your best possible lineup outscores this week's opponent. It "
      + "uses both teams' measured spread, so it is not the same as who projects "
      + "higher: an underdog is helped by variance and a favourite is hurt by it.",
};

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pp = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}pp`;

/**
 * One floor / median / ceiling bar, positioned inside a shared scale so that two
 * teams' bars can be read against each other rather than each against itself.
 */
export function rangeBar(r, scale, esc) {
  const lo = scale?.lo ?? 0, hi = scale?.hi ?? 1;
  const span = hi - lo || 1;
  const at = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const a = at(r.floor), b = at(r.ceiling), m = at(r.median);
  return `<div class="rng" title="${esc(`floor ${r.floor.toFixed(0)} · median `
    + `${r.median.toFixed(0)} · ceiling ${r.ceiling.toFixed(0)}`)}">
    <i class="rng-span" style="left:${a.toFixed(1)}%;width:${(b - a).toFixed(1)}%"></i>
    <i class="rng-med" style="left:${m.toFixed(1)}%"></i>
  </div>`;
}

/**
 * The **This week** section.
 *
 * Returns "" when there is no plan - an unscheduled week, an unmeasured league - so
 * that panel.js can interpolate it unconditionally and get nothing rather than a
 * section apologising for itself.
 */
export function weekSection(gp, { esc, name, myTeam }) {
  if (!gp) return "";
  const gain = gp.pWinBest - gp.pWinMean;
  const worth = gain >= SWAP_MIN && gp.swaps.length;
  const lo = Math.min(gp.me.floor, gp.them.floor);
  const hi = Math.max(gp.me.ceiling, gp.them.ceiling);
  const scale = { lo, hi };

  const swapRows = worth ? gp.swaps.map((s) => `<li>
      <b>${esc(name(s.in))}</b> in for <b>${esc(name(s.out))}</b>
      <span class="tag g">${esc(pp(s.dP))}</span></li>`).join("") : "";

  return `<section>
    <h2 class="secttl">This week</h2>
    <p class="sectsub">Week ${gp.week} against <b>${esc(gp.opponent)}</b>. Every other
      number on this page maximises points; this one maximises the chance of winning
      one game, which is not the same thing when you are the underdog.</p>
    <div class="panel gp">
      <div class="gp-top">
        <div class="gp-p">
          <div class="k">Win probability</div>
          <div class="v ${gp.pWinMean >= 0.5 ? "up" : "down"}">${esc(pct(gp.pWinMean))}</div>
          <div class="s">with your best-points lineup</div>
        </div>
        ${worth ? `<div class="gp-p">
          <div class="k">If you play for variance</div>
          <div class="v up">${esc(pct(gp.pWinBest))}</div>
          <div class="s">${esc(pp(gain))} from ${gp.swaps.length}
            swap${gp.swaps.length === 1 ? "" : "s"}</div>
        </div>` : ""}
      </div>
      ${worth ? `<ul class="gp-swaps">${swapRows}</ul>` : ""}
      <div class="gp-rng">
        <div class="gp-lab">${esc(myTeam)}</div>
        <div>${rangeBar(gp.me, scale, esc)}</div>
        <div class="num">${gp.me.floor.toFixed(0)}&#8202;–&#8202;${
          gp.me.ceiling.toFixed(0)} <span class="mid">${gp.me.median.toFixed(0)}</span></div>
        <div class="gp-lab">${esc(gp.opponent)}</div>
        <div>${rangeBar(gp.them, scale, esc)}</div>
        <div class="num">${gp.them.floor.toFixed(0)}&#8202;–&#8202;${
          gp.them.ceiling.toFixed(0)} <span class="mid">${gp.them.median.toFixed(0)}</span></div>
      </div>
      <div class="note">${worth
        ? `A swingier lineup wins more often when you are behind on paper and less
           often when you are ahead — this is the arithmetic of that, not a hunch.`
        : `No lineup change is worth a percentage point here, so field your best
           points lineup.`}
        The bars are the 10th to 90th percentile of each team's total, with the median
        marked. This lineup search is a <b>local search heuristic</b>, not the
        exhaustive enumeration the trade search runs: it takes the best single
        starter-for-bench swap until no swap helps. The number of legal lineups is
        combinatorial, and the starting point is already the best-points answer.</div>
    </div>
  </section>`;
}

/** Stack flags for one roster, or "" when it has none. */
export function stackLine(pairs, { esc, name }) {
  if (!pairs?.length) return "";
  const chips = pairs.map((p) => `<span class="tag warn"
    title="${esc(`${name(p.a)} and ${name(p.b)} share an offence — their scores move `
      + `together (rho ${p.rho})`)}">${esc(p.label)} stack${
      p.nfl ? `: ${esc(p.nfl)}` : ""}</span>`).join(" ");
  return `<div class="gp-stacks">${chips}</div>`;
}

/**
 * The season panel's swing sentence. Replaces the old independence disclaimer, which
 * this phase made false.
 */
export function stackNote(measured, corr = CORR) {
  if (!(measured >= 20))
    return "Weekly swing falls back to an assumed ±25 points, and no correlation "
         + "between teammates is modelled.";
  return `Swing is measured per player and now counts stacks: two players on one NFL `
       + `team are correlated at ${corr.qbToPass} for a quarterback with his own `
       + `receiver or tight end and ${corr.sameTeam} for any other pair of `
       + `teammates, running backs at ${corr.rb}, and opponents in the same game at `
       + `${corr.sameGame}. A stacked roster is genuinely swingier and this says so.`;
}
```

- [ ] **Step 4: Run the tests**

Run: `node extension/test/run-all.mjs`
Expected: `DISTRIBUTIONS OK`, `5 files, 0 failing`.

- [ ] **Step 5: Commit**

```bash
git add extension/panel/distributions.js extension/test/distributions.mjs
git commit -m "Add the strings for floors, ceilings and this week's game"
```

---

### Task 6: Wire it into the page

**Files:**
- Modify: `extension/panel.js`
- Modify: `extension/panel.css`

**Interfaces:**
- Consumes: everything Tasks 1–5 produced.
- Produces: no new exports. The page gains a **This week** section, two roster-grid columns, a stack flag in the trade detail, and a rewritten season note.

Keep every hunk to the smallest edit that works — Phase 4 and Phase 7 are editing this file on their own branches at the same time.

- [ ] **Step 1: Add the import**

In `extension/panel.js`, immediately after the existing line

```js
import { AVAIL_HINT, statusRank, statusCell, statusBadge, seasonNote,
         availabilityLines, horizonLine } from "./panel/availability.js";
```

add:

```js
import { buildDistribution, attachCovariance, playerRange } from "./engine/distribution.js";
import { gameplan } from "./engine/gameplan.js";
import { DIST_HINT, weekSection, stackLine, stackNote } from "./panel/distributions.js";
```

- [ ] **Step 2: Build the distribution in `start()`**

In `start()`, inside the volatility block, change

```js
    if (vol.measured >= 20) {
      eng.setVolatility(vol);
      const posText = [...vol.byPos].sort()
```

to

```js
    if (vol.measured >= 20) {
      eng.setVolatility(vol);
      // Teammates' scores move together. Attaching this clears the sigma cache, so
      // it has to follow setVolatility and precede anything that reads teamSigma.
      attachCovariance(eng, model.players);
      const posText = [...vol.byPos].sort()
```

and change

```js
    window.__vol = vol;
```

to

```js
    window.__vol = vol;
    // Measured floors and ceilings, from the residuals measureVolatility keeps.
    window.__dist = buildDistribution(vol, model.players);
```

- [ ] **Step 3: Run the syntax check**

Run: `node --check extension/panel.js`
Expected: no output.

- [ ] **Step 4: Build the plan in `render()`**

`DIST` is read by the roster grid, which is built about 150 lines above the page
template, so it has to be declared before both. In `render()`, immediately after the
closing `};` of the `avgProj` helper and before the `/* ---------- filter state ---------- */`
comment, add:

```js
  // This week's game. The horizon starts at the current week, so index 0 is it
  // unless ESPN reported a week outside the trimmed range.
  const DIST = window.__dist ?? null;
  const curIdx = Math.max(0, W.indexOf(model.settings.currentWeek ?? W[0]));
  const plan = DIST && eng.sigmaOf ? gameplan(eng, myTeam, curIdx) : null;
  const thisWeek = weekSection(plan, { esc, name: nm, myTeam });
```

Then, in the page template, insert `${thisWeek}` on its own line immediately after

```js
  <div class="wrap">
```

and before

```js
    <section>
      <h2 class="secttl">${mineOnly ? "Offers for you" : "Every trade in the league"}</h2>
```

- [ ] **Step 5: Add the Floor and Ceiling columns**

In `render()`, immediately before `const rosterGrid = grid("rosterGrid", [`, add:

```js
  // Floor and ceiling per game, averaged over the weeks he is projected to play.
  // A bye is not a bad week, it is no week, so it is excluded from both.
  const rangeOf = (p) => {
    const f = [], c = [];
    for (const w of W) {
      if (!(p.proj?.[w] > 0)) continue;
      const r = playerRange(p, w, DIST);
      f.push(r.floor); c.push(r.ceiling);
    }
    return f.length
      ? { floor: f.reduce((a, b) => a + b, 0) / f.length,
          ceiling: c.reduce((a, b) => a + b, 0) / c.length }
      : { floor: 0, ceiling: 0 };
  };
```

Change the `rosterRows` line

```js
    i, p: model.players.get(eng.ids[i]), rate: rates.get(i) ?? 0, avg: avgProj(i),
```

to

```js
    i, p: model.players.get(eng.ids[i]), rate: rates.get(i) ?? 0, avg: avgProj(i),
    rng: DIST ? rangeOf(model.players.get(eng.ids[i])) : null,
```

In the `rosterGrid` column list, insert two entries between the `avg` and `rate` entries:

```js
    { key: "floor", label: "Floor", num: true,
      value: (r) => r.rng?.floor ?? 0, hint: DIST_HINT.floor },
    { key: "ceil", label: "Ceiling", num: true,
      value: (r) => r.rng?.ceiling ?? 0, hint: DIST_HINT.ceiling },
```

and in the `row` template, insert two cells between the `avg` cell and the `rate` cell:

```js
      <td class="num" style="color:var(--dim)">${r.rng ? r.rng.floor.toFixed(1) : "—"}</td>
      <td class="num" style="color:var(--dim)">${r.rng ? r.rng.ceiling.toFixed(1) : "—"}</td>
```

- [ ] **Step 6: Flag stacks in the trade detail**

In `detailFor`, inside the `panels` map, change

```js
          ${marketDetail(sd, mkt)}
        </div>
        <ul>${li.join("")}</ul>${deltaBars(sd.weekly, W)}
```

to

```js
          ${marketDetail(sd, mkt)}
        </div>
        ${eng.stacks ? stackLine(
          eng.stacks(eng.swap(eng.roster.get(sd.team), sd.sent, sd.received), 0),
          { esc, name: nm }) : ""}
        <ul>${li.join("")}</ul>${deltaBars(sd.weekly, W)}
```

- [ ] **Step 7: Replace the independence disclaimer**

In the season section's note, change

```js
        <div class="note"><b>What this is not.</b> ${seasonNote(AV)} ${measured >= 20
            ? `Swing is measured per player and assumes independence — a stack of players
               from one NFL team is swingier than shown.`
            : `±25 is assumed and is the biggest lever on every number here.`}
```

to

```js
        <div class="note"><b>What this is not.</b> ${seasonNote(AV)} ${stackNote(measured)}
```

- [ ] **Step 8: Add the CSS**

Append to `extension/panel.css`:

```css
/* ---- this week: range bars and the gameplan block ---- */
.gp{padding:15px}
.gp-top{display:flex;gap:34px;flex-wrap:wrap;margin-bottom:12px}
.gp-p .k{font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint)}
.gp-p .v{font-family:var(--mono);font-size:26px;font-weight:500;margin-top:3px}
.gp-p .s{font-size:11px;color:var(--dim);margin-top:2px}
.gp-swaps{list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:5px}
.gp-swaps li{font-size:13px;display:flex;align-items:center;gap:8px}
.gp-rng{display:grid;grid-template-columns:auto 1fr auto;gap:7px 12px;align-items:center;
  padding:11px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.gp-lab{font-size:11px;color:var(--dim);white-space:nowrap}
.gp-rng .num{white-space:nowrap;color:var(--faint)}
.gp-rng .mid{color:var(--ink)}
.rng{position:relative;height:11px;background:var(--sunken);border-radius:2px;overflow:hidden}
.rng-span{position:absolute;top:0;bottom:0;background:var(--accent-soft);
  border-left:1px solid var(--accent-line);border-right:1px solid var(--accent-line)}
.rng-med{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--accent)}
.gp-stacks{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 4px}
```

- [ ] **Step 9: Verify**

Run: `node --check extension/panel.js && node extension/test/run-all.mjs`
Expected: no output from `--check`; `5 files, 0 failing`.

Run: `git diff --stat extension/engine/search.js extension/engine/season.js extension/test/parity.mjs`
Expected: `season.js` and `parity.mjs` show no change at all; `search.js` shows only the `rosterSigma` hunk.

- [ ] **Step 10: Commit**

```bash
git add extension/panel.js extension/panel.css
git commit -m "Show this week's odds, and a measured floor and ceiling"
```

---

### Task 7: Write down what this phase decided

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the architecture map**

In the `## Architecture` code block, replace the `engine/` listing with one that matches the tree. Verify each filename with `ls extension/engine extension/panel extension/test` before writing it, and include `distribution.js`, `gameplan.js`, `panel/distributions.js` and `test/distributions.mjs`. Do not invent entries and do not delete existing correct ones.

- [ ] **Step 2: Extend the volatility decision**

Under `## Load-bearing decisions`, replace the paragraph beginning **Volatility is measured, not assumed.** with:

```markdown
**Volatility is measured, not assumed.** `statSourceId: 0` gives the prior season's
actual weekly scores in the same payload as projections; the residual is real
league-scored volatility. `measureVolatility` keeps those residuals, not only their
standard deviation, because a sigma is symmetric and a fantasy week is not: the
10th/50th/90th percentiles in `distribution.js` are the real shape, shrunk toward the
position's by `n/(n+10)`. Team sigma is the root of the summed variance of that week's
starters, so it follows roster composition.

**The correlation constants live in one table, and only real pro teams get them.**
`CORR` in `distribution.js` is the whole model: `0.25` for a quarterback with his own
receiver or tight end, `0.10` for any other pair of teammates, `0` for a running back
with anyone, `-0.05` for opponents in the same NFL game. `rosterSigma` adds
`2 Σ ρ σ σ` over the week's starters, weighted by the same `sqrt(p)` availability
factor the variance term uses. It applies **only when both players have a real pro
team** — never `"X"`, `"?"` or `"FA"`. That guard is load-bearing twice over: the
frozen fixture puts every player on `"X"`, so parity's season invariants stay true,
and a free agent with no team never invents a stack. The correlation reaches
`search.js` as an attached `eng.rhoOf`, not an import, so `rosterSigma` behaves
exactly as it always did on an engine nobody attached to.

**The weekly lineup search is a local-search heuristic — and that is fine here.**
`gameplan.js` starts from the mean-optimal lineup and takes the best single
starter-for-bench swap that raises `P(win) = Φ((μ−μₒ)/√(σ²+σₒ²))` until none does.
Every step is a strict improvement, so it terminates, but it is not exhaustive and it
does not claim to be. This does not contradict "nothing in the search is
approximated": the trade search's answer is a recommendation about an irreversible
decision over a space of a few million rosters, while the lineup space is
`C(roster, starters)` with a matroid feasibility test on each candidate, the starting
point is already the best-points answer, and a manager eyeballs the result before
setting it. The panel says it is a heuristic on screen. Do not quietly upgrade the
claim, and do not downgrade the trade search to match.
```

- [ ] **Step 3: Verify the claims**

Run: `node extension/test/run-all.mjs && node --check extension/panel.js`
Expected: `5 files, 0 failing`; no output from `--check`.

Re-read the two new paragraphs against the code. Every constant quoted must match `CORR`; every filename in the map must exist.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Record how distributions, stacks and the weekly plan work"
```

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| `measureVolatility` returns `residuals`, `byPosResiduals` | 1 |
| `quantiles(residuals, shrinkTo, n0 = 10)` | 2 |
| `playerRange` floored at 0 | 2 |
| `cv(player)` shrunk toward positional CV | 2 (as `cv(player, dist)` — ruling in the task) |
| `lineupRange` with a comment on why a team total is closer to normal | 3 |
| `CORR` table, exported, one place | 2 |
| `rosterSigma` gains `2Σρσσ`; only `rosterSigma`/`teamSigma` touched | 3 |
| `Engine.stacks(ids)` | 3 (attached, not a class method — ruling in the task) |
| Guard on `nfl: "X"` so parity stays green | 2 and 3 |
| Injected optional `gameOf`, term skipped when absent | 3 |
| `gameplan.js` local search with the seat legality check | 4 |
| Its full output shape | 4 |
| **This week** section above the trade grid, swap threshold ≥ 1pp, range bars | 5 and 6 |
| Roster grid Floor/Ceiling columns | 6 |
| Trade detail stack flags | 5 and 6 |
| Season note rewritten with the constants | 5 and 6 |
| Every spec test | 1–5 |
| `parity.mjs` unchanged and green | every task's Step 4 |
| CLAUDE.md: covariance table, heuristic justification | 7 |

**Type consistency.** `dist` is the object `buildDistribution` returns everywhere it
appears (Tasks 2, 3, 4, 6). `playerRange(player, w, dist)` takes an **ESPN week
number**; `lineupRange(eng, ids, w, dist)`, `stacks(eng, ids, w)` and
`gameplan(eng, team, w, dist)` take an **engine week index**. `out`/`in` in a swap and
`a`/`b` in a stack are engine indices, matching `trade.sides[].sent`. `rho` is the
function; `CORR` is the table; `stacks` is both a free function and the attached
method, with the same signature minus `eng`.
