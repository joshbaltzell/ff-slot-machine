# Phase 8 — Distributions: measured floor/ceiling, stack covariance, weekly P(win) lineup

Status: approved for build (Josh, 2026-08-27). Covers brainstorm D1, D2, D3.
Follow `2026-08-27-parallel-phase-rules.md` wave-2 ownership: this phase owns
`league.js` (`measureVolatility`) and may edit only `rosterSigma`/`teamSigma` in
`search.js`. It does not touch `season.js`.

## Why

We already measure each player's residual sigma from last season's actuals. The
residuals are right-skewed with a floor near zero; a normal sigma hides the shape,
and every other tool's "floor/ceiling" is a guess. Teammates' scores are correlated,
so a stacked roster is swingier than the sum of its sigmas. And on Sunday morning the
question is not "which lineup has the highest mean" but "which lineup is most likely
to beat *this* opponent" — for an underdog those differ.

## Measured distributions — `league.js` + `extension/engine/distribution.js`

`measureVolatility` additionally returns `residuals: Map<playerId, number[]>` (actual −
projection, prior season, weeks with projection > 1) and `byPosResiduals: Map<pos, number[]>`.

`distribution.js`:
- `quantiles(residuals, shrinkTo, n0 = 10)` → `{p10, p50, p90}` of residuals, shrunk
  toward the positional quantiles with weight `n/(n+n0)`.
- `playerRange(player, w, dist)` → `{floor: proj + p10, median: proj + p50, ceiling: proj + p90}`, floored at 0.
- `cv(player)` = sigma / mean projection, shrunk toward the positional CV — a sticky
  trait per the research.
- `lineupRange(eng, ids, w, dist)` → team `{floor, median, ceiling}` by summing starters'
  quantiles under the normal approximation (`mean ± z·σ_team` with the team σ from
  `rosterSigma`) — say in a comment why the team total is closer to normal than a
  player's score.

## Covariance — `search.js` (`rosterSigma` only) + `distribution.js`

`CORR` table (exported, one place): same NFL team QB↔WR/TE `0.25`, same team
non-QB pairs `0.10`, same team RB↔anyone `0.0`, opponents in the same game `−0.05`
(requires the week's schedule of pro games — use Phase 7's Vegas map if present via
an injected `gameOf(proTeamId, w)`; otherwise skip the cross-game term).
`rosterSigma(ids)` becomes `sqrt(Σσ_i² + 2Σ_{i<j} ρ_ij σ_i σ_j)` over that week's
starters. `Engine.stacks(ids)` → list of `{a, b, rho}` pairs among starters for flags.
`teamSigma` and everything downstream (win probability, odds) inherit the change.
The fixture has `nfl: "X"` for every player, so parity's season invariants must be
guarded: `CORR` applies only when both players have a real pro team (not `"X"`/`"?"`).

## Weekly P(win) lineup — `extension/engine/gameplan.js`

For the current week only:
- Opponent = `eng.opp.get(myTeam)[0]`; their distribution = baseline mean and `teamSigma`.
- Start from the mean-optimal lineup (`starterMask` current week). Local search:
  repeatedly try every (starter → bench) single swap that keeps the lineup legal
  (use `bestLineupSeats`-style seat check: the swapped-in player must be eligible for
  a seat the swapped-out player leaves, or re-solve); accept the swap that most
  increases `P(win) = Φ((μ − μ_o)/sqrt(σ² + σ_o²))` using covariance-aware σ; stop at
  a local optimum. This is a heuristic, not the exhaustive trade search — say so in
  CLAUDE.md under a new decision, and why (lineup count is combinatorial).
- Output: `{opponent, pWinMean, pWinBest, lineupMean, lineupBest, swaps: [{out, in, dP}], me: {floor, median, ceiling}, them: {...}}`.

## UI — `extension/panel/distributions.js`

- New top section **This week** above the trade grid: opponent, P(win) for the
  mean-optimal lineup, and — when a variance swap helps by ≥ 1 percentage point — the
  recommended swaps with ΔP, and both teams' floor/median/ceiling as a small range bar.
- Roster grid: **Floor / Ceiling** columns (P10/P90 per game, remaining-weeks mean).
- Trade detail: stack flags on either roster after the trade (`QB+WR stack: KC`).
- Season note: replace "assumes independence — a stack … is swingier than shown" with
  a line saying stacks are now counted, with the correlation constants.

## Tests — `extension/test/distributions.mjs`

- `quantiles` with n=0 returns the positional quantiles; n→∞ returns the sample's.
- `playerRange` floors at 0; ordering floor ≤ median ≤ ceiling.
- `rosterSigma` with two same-team players and ρ=0.25 equals the closed form; with `nfl: "X"` equals the independent value (parity guard).
- `stacks` lists the pair once.
- `gameplan`: with an opponent projected far above me, the search prefers a higher-variance bench player when it raises P(win); with me far ahead it never swaps to higher variance; P(win) never decreases across accepted swaps.
- `parity.mjs` unchanged and green (fixture `nfl: "X"` keeps covariance off).
