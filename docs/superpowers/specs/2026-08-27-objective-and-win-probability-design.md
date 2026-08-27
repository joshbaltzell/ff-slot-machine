# Phase 1 — Objective: win probability, title odds, legality, shrinkage

Status: proposed. Covers brainstorm ideas A1–A5.

## Why

Trades are ranked today by average points gained per week. Leagues are won on
record and seeding, and a first-round bye roughly doubles title odds in a
six-team bracket. The season Monte Carlo already computes playoff/bye/title
odds for the league as it stands; nothing connects a *trade* to those odds, and
`sideMetrics.win` has been a hard-coded 0 since the port. This phase makes wins
the unit of decision, fixes two correctness gaps found on the way
(`positionLimits` unenforced; projections known to be over-spread), and adds
the per-week leverage view that tells you which weeks a point actually buys
win probability.

## Scope

| Code | Feature | Kind |
|---|---|---|
| A5 | Enforce `positionLimits` on trades and add/drops | bug fix |
| A4 | Positional shrinkage of ESPN projections | input correction |
| A1 | Analytic Δ expected wins per trade; Δ playoff/bye/title odds via common-random-number Monte Carlo | engine |
| A2 | Objective toggle: Championship / Seeding / Balanced | UI |
| A3 | Week leverage strip and variance hint | UI |
| — | `CLAUDE.md` architecture map fix (`swaps.js` → `search.js`) | docs |

Out of scope: injuries (Phase 2), correlation between teammates (Phase 8),
anything that changes which trades the exact search *finds* — only how they are
scored and sorted.

## Design

### A5 — `positionLimits`

`readSettings` already returns `positionLimits` (ESPN: `{defaultPositionId:
max}`, with `-1` or absent meaning unlimited). `league.js` records each player's
`defaultPositionId` on the model (it is in the roster payload already). The
engine builds `posId: Int32Array` alongside `mask`.

`Engine.legal(ids)` returns false when any limited position id appears more than
its max times in `ids`. `score()` calls it for every side before computing
metrics and returns `null` for an illegal trade; `findTwoTeam`, `findThreeWay`
and `freeAgentUpgrades` skip nulls. This is a filter on the exact search's
*output*, not a prune of its input, so recall is untouched.

Position id is an ESPN setting read verbatim, consistent with "read settings,
never derive them". It is never used for lineup logic.

### A4 — Shrinkage

Literature calibration slopes (actual on projected, season level): QB 0.67,
RB 0.79, WR 0.85, TE 0.72; K and D/ST unmeasured → 1.0. Applied per week:

```
proj'(p, w) = mean_pos(w) + k_pos · (proj(p, w) − mean_pos(w))
```

`mean_pos(w)` is the mean over every player of that position in the model
(rostered plus fetched free agents) with a non-zero projection that week, so
byes do not drag the mean. Ordering within a position is preserved, so no
within-position lineup choice changes; flex competition and every trade value
do, which is the point.

Implemented as `shrinkProjections(players, k)` in `league.js`, run once before
the engine is built, controlled by a panel option **"Calibrate projections"**
(default on, persisted). The step log states what was applied. The fixture
tests run with it off so the contract stands; new tests cover the transform.
Phase 5's calibration log replaces the literature constants with league-measured
ones — this design leaves `k` as a plain map so that swap is a one-liner.

### A1 — Win probability

**Analytic expected wins.** For week `w`, my team `T` with lineup mean `m_T(w)`
and sigma `s_T(w)` (from `teamSigma`, root-sum of starter variances), against
scheduled opponent `O`:

```
P_T(w) = Φ( (m_T − m_O) / sqrt(s_T² + s_O²) )
```

Expected regular-season wins = Σ_w P_T(w). Without a schedule, the all-play
form averages `P` against every other team, matching `season.js`'s fallback.

For a trade, every side's post-trade mean is `weekly()` of the new roster and
its sigma comes from a new `rosterSigma(ids)` that runs `starterMask` on the
new roster. When two trading teams meet in week `w`, both use post-trade values.
`sideMetrics.win` becomes Δ expected regular-season wins; `sideMetrics.winWeekly`
holds the per-week Δ P so the detail view can show which weeks moved.

Cost: `rosterSigma` is one more lineup solve per side, so it must not run inside
the hot 2-for-2 loop. It runs in `Engine.enrich(trades)` on the survivors of the
mutual-gain filter (hundreds, not millions). `enrich` yields to the browser per
group like the searches do.

**Season odds with common random numbers.** `projectSeason` is already
deterministic (`mulberry32(0x5EED)`) and consumes a fixed number of draws per
simulation regardless of outcomes, so two runs that differ only in `mu`/`sigma`
already share their noise. The change is an `override` option:

```
projectSeason(eng, schedule, settings, { ..., override: Map(team -> {mu, sigma}) })
```

`Δ playoff / bye / title` for a trade = `projectSeason(post) − projectSeason(base)`
for my team, with the same seed. Because the difference is paired, its Monte Carlo
error is far below `sqrt(0.25/sims)`; it is estimated empirically by running the
sims in 10 batches and taking `sd(batch deltas)/sqrt(10)`. `projectSeason` gains
`batches` and returns per-batch tallies for that purpose. The UI prints `—` for
any delta smaller than twice its error, per the earlier spec.

Odds deltas are computed only for trades involving my team, for the top 200 by
the current objective after `win` is filled, at `sims = 5000` per world, as a
distinct loading step ("season odds per trade") with progress. Everything else
keeps the 20,000-sim league table.

### A2 — Objective toggle

A `<select>` in the filter bar, persisted in `chrome.storage.local`:

| Mode | Sort key (my side) | Also shown |
|---|---|---|
| Championship (default) | Δ title odds | Δ bye, Δ playoff |
| Seeding | Δ expected regular-season wins | Δ bye |
| Balanced | `gain` (today's behaviour) | — |

The toggle changes only the sort and the headline number of each card. All five
point windows stay as columns. Trades whose title delta is `—` sort by Δ wins in
Championship mode, so the list never looks empty on an average roster.

### A3 — Week leverage

Leverage of week `w` = `φ(z) / sqrt(s_T² + s_O²)`: the derivative of win
probability with respect to one point, i.e. how much a point is worth *that
week*. The season tile gains a strip: one chip per regular-season week with
opponent, `P(win)`, and leverage as a heat shade. A one-line hint reads
"underdog in N weeks — variance helps there" or "favourite — protect the floor"
based on the count of weeks below 50%. Trade detail shows `winWeekly` as a
sparkline next to the existing points sparkline.

## Data flow

```
league.js  readSettings ─ positionLimits ─┐
           players + defaultPositionId ───┤
           shrinkProjections (opt) ───────┤
                                          ▼
search.js  Engine(model) ─ legal() gate in score()
           findTwoTeam / findThreeWay (unchanged search)
           enrich(trades) → win, winWeekly, rosterSigma
                                          ▼
season.js  projectSeason(override, batches) ─ Δ odds + SE for top trades
                                          ▼
panel.js   objective select → sort; leverage strip; detail sparkline
```

## Testing (`extension/test/parity.mjs`)

- Existing 371 assertions unchanged (shrinkage off, no `positionLimits` in fixture).
- **Legality**: a synthetic limit of 1 QB rejects a QB-for-RB trade that leaves a side with two QBs; the same trade with no limits scores as before.
- **Shrinkage**: `k = 1` is the identity; `k = 0.5` halves every deviation from the positional mean; within-position rank order is preserved; bye zeros stay zero.
- **Win probability**: with all sigmas equal and a schedule, analytic `P` matches a 200k-sim Monte Carlo within 0.01; the null trade (swap a player for himself) yields `win = 0` exactly and Δ odds of exactly 0 under CRN.
- **CRN**: two `projectSeason` runs with identical inputs are bit-identical; an override that adds +5 to one team every week raises its `wins` and never lowers any sim's total draw count.
- **Batches**: batch tallies sum to the whole-run tally.

## Risks

- Literature slopes are season-level; applying them weekly is an assumption stated in the UI and replaced by Phase 5.
- `rosterSigma` treats starters as independent (as today); teammates' covariance arrives in Phase 8. Stacked rosters will read slightly too safe.
- Per-trade season sims add roughly 200 × 2 × 5000-sim runs. If that exceeds ~10 s on a typical laptop, the cap drops to 100 trades or a smaller `sims`; the plan measures this first.
