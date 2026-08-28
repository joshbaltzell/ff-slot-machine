# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**FF Slot Machine** — a Chrome extension that finds ESPN fantasy trades and waiver
adds which raise a team's projected *starting-lineup* points. It is the whole
project; there is no server, no build step, and no other entry point.

The name is literal rather than a joke about luck: the engine matches players to
lineup **slots** through ESPN's `eligibleSlots` and never models positions at all.

## Commands

```bash
node extension/test/run-all.mjs    # every test file under extension/test, ~5s
node extension/test/parity.mjs     # the engine contract alone, ~2s
```

Load the extension with `chrome://extensions` → Developer mode → Load unpacked →
`extension/`. There is nothing to build; it is plain ES modules.

## Architecture

```
extension/
  manifest.json      MV3
  background.js      opens the page; nothing else lives here
  panel.html/.js     the UI
  panel.css          the analytics-terminal look
  engine/
    league.js        ESPN API -> normalized model; settings; volatility; injury status
    market.js        FantasyCalc fairness, the pitch sentence, buy low / sell high
    lineup.js        optimal lineup for any slot configuration
    search.js        swap table, shapes, N-sided trades, three-way, 2-for-1, waiver
                     backfill and trim, free agents, drop ranking
    availability.js  injury status -> play probability; the remaining-weeks horizon
    winprob.js       normal CDF, P(win), per-week leverage
    calibrate.js     positional shrinkage of ESPN projections
    odds.js          paired season sims: a trade's change in playoff/bye/title odds
    season.js        Monte Carlo season projection
    sources/
      cache.js       TTL-cached fetch for external feeds, storage-injectable
      sleeper.js     Sleeper players, trending, NFL state
      fantasycalc.js FantasyCalc crowd values keyed on espnId
  panel/
    market.js        every string of market HTML; degrades to a dash
    availability.js  status codes, cells, badges, log lines, the season note
    roster.js        2-for-1 waiver notes and the drop-candidate table
  test/
    parity.mjs       605 assertions against a frozen league — the engine contract
    availability.mjs availability, the horizon, record-seeded seasons, UI strings
    market.mjs       the market phase, offline (fetch and storage injected)
    sources.mjs      cache semantics and the Sleeper client, offline
    roster.mjs       replacement level, the 2-for-1 shape, drop ranking
    run-all.mjs      runs every *.mjs in the directory
```

**Fetching happens in the page, not the service worker.** MV3 terminates idle
service workers after ~30s and a full season pull takes longer. Extension pages
carry the same host permissions — CORS-free, cookies attached — with no termination
risk. `background.js` only opens the page.

## Load-bearing decisions

**The engine models slots, not positions.** ESPN gives every player an
`eligibleSlots` array and every league a `lineupSlotCounts` map, so players are
matched to slots directly. That is what makes superflex, IDP, TQB, `RB/WR` and
`WR/TE` work with no special cases. Position strings are display-only — never key
logic on them.

**The lineup solver is a transversal-matroid greedy.** Players simultaneously
seatable in slots form a matroid, so greedy by descending value is optimal for
*any* slot structure. The older "fill dedicated slots then flex" shortcut is only
valid for nested eligibility and was measured wrong 8% of the time when `RB/WR` and
`WR/TE` coexist. Do not reintroduce it as a fast path; the matroid solver runs at
~1 µs per team-week.

**Nothing in the search is approximated, with two named exceptions.** Three-way is
exhaustive via the swap table in `search.js`, and so is 2-for-1. A marginal-value
pruning heuristic was measured at 57% recall and rejected. The first exception is
availability: above six uncertain players in a week, `weekly` samples 64 fixed-seed
outcomes instead of enumerating all `2^k`. It is deterministic and confined to the
current week. The second is the backfill pool, below. Keep them the only two.

**Market values are display and ranking only.** FantasyCalc's numbers come from real
completed trades, which makes them a good model of what the manager on the other side
believes — and a bad model of what a player is worth to a specific lineup, which is the
only thing this engine measures. They are never read by `score`, `sideMetrics`, any
search, `enrich` or `projectSeason`. They fill one column, one filter, one line of the
pitch and one section. The gap between the two rankings is the product, so collapsing
them would delete it.

**A dead feed costs a dash, not the run.** Any feed outside ESPN goes through
`engine/sources/cache.js` and must be wrapped by a caller that returns null rather
than throwing, the way `marketOrNull` wraps FantasyCalc. A source being down must
never cost a user their trade search; `start()` has to finish.

**Time windows stay separate.** `gain` / `reg` / `playoff` / `bye` / `full` disagree
with each other, and that is the point: a trade can be positive on the season
average while hurting the record that decides seeding. Never collapse them.

**Availability lives inside `weekly`, and it enumerates.** Optimal lineup value is a
max over assignments, so it is convex in the projections and not linear in
availability: `E[L]` is not `L(E[proj])`. Two players at 50% are not one certain
starter — a bench absorbs one absence far better than two — so blending a probability
into a projection understates the damage. `weekly` splits each week into certain and
uncertain players, enumerates the `2^k` outcomes for `k ≤ 6` and weights them, and
falls back to 64 fixed-seed draws above that. Only the current week can hold
uncertain players, so the cost is confined to one week per solve. Two rules protect
it: when no availability is attached the function takes the original path
character-for-character, because 2-for-2 calls it millions of times and the golden
set depends on it; and an unavailable player is *removed from the pool*, never valued
at zero — `bestLineup` seats players in the order it is given and never unseats one,
so a zeroed star still takes a seat and blocks the man who would have started.
`starterMask`, `startRates` and `explain` show the *modal* lineup (everyone at
`p ≥ 0.5`) instead, because a usage strip has to name actual players.

**The backfill pool is the one bounded step, and it bounds the waiver wire, not the
search.** A 2-for-1 does not end with the rosters it names: the side sending two has
an empty seat and fills it, and the side receiving two is over the limit and drops
somebody. `Engine.backfill` and `Engine.trim` price both, so the shape is graded
exactly rather than with the 20% haircut every other tool applies.
`backfillPool()` bounds only *which free agents are tried*: the top three in each
distinct **seat mask** — masks, never position strings, because that is what keeps
superflex, IDP and `RB/WR` correct. Backfill is exact within the pool, and the fourth
free agent behind three better men of identical eligibility cannot beat all three into
a lineup, so he cannot be the best add. The *search* around it is exhaustive: the two
prunes are upper bounds — a removal never raises the optimal lineup, and lineup value
is submodular so a man is worth no more on a larger roster than a smaller one — and
`test/roster.mjs` proves them against a brute force with zero missing and zero extra.
Measured at 7.3 s against 72.2 s unpruned on the fixture. Do not widen the pool into
the search or narrow the search into a heuristic.

**The two pruning bounds are exact for a certain roster, and only up to sampling noise
when a week holds seven or more uncertain players.** `_sample` draws its 64
fixed-seed outcomes from one stream consumed in candidate order, so adding or removing
a player shifts every later draw, and monotonicity and submodularity then hold only up
to that noise — which is far larger than `GATE_EPS`, so a prune could in principle drop
a real trade. It is narrow, since only the current week can hold uncertain players and
it takes seven of them, and `test/roster.mjs` cannot see it because the reference test
runs with no availability attached.

**A side that ends somewhere `(sent, received)` does not describe carries `final`.**
Only 2-for-1 sets it today. `enrich`, `explain` and `odds.js` all read
`s.final ?? swap(roster, sent, received)`, so every other shape is untouched and a new
shape that changes a roster after the trade must set it too — otherwise its win deltas
and season odds are computed on a roster nobody will ever field.

**The mean under uncertainty is exact; the spread is not.** `weekly` enumerates the
outcomes, but `rosterSigma` never sees them: it takes the modal lineup and scales each
starter's variance by his chance of playing. That is `E[Var | availability]` with the
between-outcome term `Var(E[L | A])` dropped, so a roster carrying several Questionable
players is shown steadier than it is. Two Questionable at `p = 0.71` understate team
sigma by 4.0%, four by 8.6%, a pathological six at `p = 0.5` by 21.7%. At a ten-point
projected edge the worst of that moves a week's win probability by under 1.5 points and
an ordinary case by well under 0.5, and both of `odds.js`'s paired worlds carry the same
bias, so the reported delta absorbs most of what is left. It is a known limitation of
the spread, not of the projection.

**The horizon is the weeks that remain.** `restrictToRemaining` trims `model.weeks`
and the settings week arrays to `w >= settings.currentWeek` before the engine is
built. A trade proposed in week nine used to be scored partly on eight weeks nobody
could change, which is not a small distortion: a deal that is mildly positive across
a whole season is often strongly positive across the part of it that is left, and
occasionally the reverse. A season already over keeps every week and says so.

**Records seed the season simulation.** `projectSeason` takes
`records: Map<team, {wins, losses, ties, pointsFor}>` from ESPN's `t.record.overall`
and starts every simulated season there rather than at 0-0, counting a tie as half a
win exactly as the simulation scores one; `games` becomes played + remaining. Adding
a starting value adds no call to `gauss(rand)` and moves none, so the common random
numbers `odds.js` depends on are unaffected — keep it that way.

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

**The searches are async and must stay that way.** `findTwoTeam`, `findThreeWay`
and `buildSwapTable` yield a macrotask between groups. Without that, 2-for-2 blocks
the main thread for about fourteen seconds: the progress bar freezes, and nothing on
the page can be clicked. A microtask (`await Promise.resolve()`) is not enough — the
browser needs a real turn to render. If a future change makes them synchronous
again, the loading screen will look hung.

**Read settings, never derive them.** `matchupPeriods` maps a matchup to the weeks
it spans (a two-week final is `{"16": [16,17]}`); `playoffMatchupPeriodLength` can
be 0 when lengths vary by round; `playoffReseed` can be false; a league with no
divisions still reports one named "League Standings".

**Filter ESPN stats on `seasonId`.** ESPN returns the prior season's projection for
the same scoring period alongside the current one. Matching on `statSourceId`,
`statSplitTypeId` and `scoringPeriodId` alone silently reads last season — measured
~15% low.

**Projections are calibrated before the engine sees them.** `panel.js` runs
`shrinkProjections` on the model after free agents are merged and before `Engine` is
built; fixture tests run with it off. `measureVolatility` reads `rawStats`, so sigma
is unaffected.

**Volatility is measured, not assumed.** `statSourceId: 0` gives the prior season's
actual weekly scores in the same payload as projections; the residual is real
league-scored volatility. Team sigma is the root of the summed variance of that
week's starters, so it follows roster composition.

## Testing

`extension/test/fixture.json` and `golden_1for1.json` are a frozen ten-team league
with names removed. They were produced by an independent Python implementation and
verified line for line before it was retired, so they are now the contract rather
than a convenience. A mismatch means the engine changed — regenerate them only on a
deliberate decision that the new behaviour is right.

`parity.mjs` is the contract and is never edited by a feature branch. Everything a
new phase adds goes in its own `extension/test/<name>.mjs` using the `ok()` pattern,
and `run-all.mjs` runs them all. Phase 2's file also asserts the contract from the
other side: an engine given an all-ones availability table must reproduce
`fixture.json`'s baseline exactly.

## The daily reminder

`content.js` injects a notice on `fantasy.espn.com/football/*`; `background.js` runs
a 12-hourly alarm. **The alarm does not run the trade search.** MV3 kills a service
worker at five minutes and a league pull is eighteen calls, so the job makes one
`mRoster` request and compares a roster fingerprint against the one `panel.js` stored
on its last run. `rosterFingerprint` in `panel.js` and `rosterHash` in `background.js`
must stay in step — they hash the same thing in two places.

Showing the notice is rate-limited to once per league per day and honours a dismissal
for 24 hours. Keep that bar high; an extension that announces itself every visit gets
uninstalled.

## Privacy

Everything runs locally against ESPN's read API using the browser's own session. No
backend, no analytics, no league data leaves the machine. The one other host is
`api.sleeper.app`, which is asked only for its public league-agnostic player list —
no league id, no team, no roster is sent with the request. Keep it that way.
