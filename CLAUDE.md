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
    aggregate.js     average outside sources into ESPN's scoring
    calibration.js   the per-league projection-error log and its fitted slopes
    environment.js   Vegas + weather -> a factor on this week's and next week's proj
    streaming.js     three-week hold-or-churn plan for K, D/ST, QB and TE slots
    odds.js          paired season sims: a trade's change in playoff/bye/title odds
    season.js        Monte Carlo season projection
    sources/
      cache.js       TTL-cached fetch for external feeds, storage-injectable
      csv.js         CSV reader (quoted fields)
      sleeper.js     Sleeper players, trending, NFL state
      sleeperproj.js Sleeper/RotoWire weekly projections
      fantasypros.js FantasyPros ECR via DynastyProcess
      fantasycalc.js FantasyCalc crowd values keyed on espnId
      vegas.js       Vegas lines and implied team totals
      weather.js     stadium weather for outdoor/retractable games
      stadiums.js    stadium roof and location lookup
  panel/
    market.js        every string of market HTML; degrades to a dash
    availability.js  status codes, cells, badges, log lines, the season note
    projections.js   source orchestration, the ± band, the Calibration section
    environment.js   the environment column, chips and streaming section
    roster.js        2-for-1 waiver notes and the drop-candidate table
  test/
    parity.mjs       605 assertions against a frozen league — the engine contract
    availability.mjs availability, the horizon, record-seeded seasons, UI strings
    market.mjs       the market phase, offline (fetch and storage injected)
    projections.mjs  aggregate, calibration log and the panel module, offline
    sources.mjs      cache semantics and the Sleeper client, offline
    environment.mjs  151 assertions for lines, weather, factors and streaming
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
superflex, IDP and `RB/WR` correct. Backfill is exact within the pool, but the pool
itself can leave the best add out: it ranks by availability-weighted mean projection
over the horizon, while an add's marginal value is a max over assignments, so week
*shape* can invert that order. A free agent whose points are concentrated in the weeks
a roster is thin — an IR stash about to return, a rookie about to be handed a job, a
streamer with a favourable late schedule — can be worth more than three higher-mean
men of the same eligibility and still be ranked out of the top three. The loss is
one-directional: a missed better add understates the consolidating side's gain, so the
bound costs recall and can never manufacture a trade that is not there. The *search*
around it is exhaustive: the two prunes are upper bounds — a removal never raises the
optimal lineup, and lineup value is submodular so a man is worth no more on a larger
roster than a smaller one — and `test/roster.mjs` proves them against a brute force
with zero missing and zero extra. Measured at 7.3 s against 72.2 s unpruned on the
fixture. Do not widen the pool into the search or narrow the search into a heuristic.

**The two pruning bounds are exact for a certain roster, and only up to sampling noise
when a week holds seven or more uncertain players.** `_sample` draws its 64
fixed-seed outcomes from one stream consumed in candidate order, so adding or removing
a player shifts every later draw, and monotonicity and submodularity then hold only up
to that noise — which is far larger than `GATE_EPS`, so a prune could in principle drop
a real trade. It is narrow, since only the current week can hold uncertain players and
it takes seven of them, and `test/roster.mjs` cannot see it because the reference test
runs with no availability attached.

**A side that ends somewhere other than `(sent, received)` carries `final`.**
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

**Game environment is an input adjustment, and only ever to this week and next.**
`environment.js` scales `p.proj[w]` by an implied-total and weather factor for
`currentWeek` and `currentWeek + 1`, in `start()`, after shrinkage and before the
`Engine` is constructed. It composes with shrinkage on purpose: shrinkage is about
how far a projection sits from its positional mean, this is about which game it is
for. Three rules keep it safe. First, it is an adjustment to an *input*, not a new
term: because it is folded into `proj` before the Engine is built, everything
downstream — the lineup solver, `sideMetrics`, `projectSeason`, `attachOdds`, the
leverage strip — reads the adjusted number, which is the point of the seam. What
nothing downstream carries is a *separate* environment term, and no slot decision
keys on one: the solver still runs entirely on `eligibleSlots`. The position strings
`envGroup` reads are one of a small set of sanctioned exceptions to "position strings
are display-only," alongside `calibrate.js`'s positional shrinkage and the
positional-median volatility fallback in `league.js` and `search.js`; every one of
them picks a coefficient, none picks a slot, and `positionLabel` derives `pos` from
`eligibleSlots` to begin with, so `envGroup` is transitively slot-keyed. Second, it
never touches a week without a line, so a dead feed is identity rather than a
distortion. Third, it never reaches past next week — `gain` averages every week in
the model and `reg` the regular-season weeks alone, so two moved weeks shift a
season-long trade metric by at most 2/17 of the per-week swing, which is where the
bound comes from. Factors clamp to [0.6, 1.4]; retractable roofs count as covered,
since no feed says whether the roof was shut and closing it is the common case.

**Volatility is measured, not assumed.** `statSourceId: 0` gives the prior season's
actual weekly scores in the same payload as projections; the residual is real
league-scored volatility. Team sigma is the root of the summed variance of that
week's starters, so it follows roster composition.

**Raw external points are never averaged with ESPN's.** ESPN's projections are scored
under *this league's* rules — its reception value, its bonuses, its defensive scoring.
Sleeper's `pts_half_ppr` and FantasyPros' `r2p_pts` are scored under theirs. Averaging
them as points would silently re-score the league by whatever the rule sets disagree
about. So `aggregate.js` converts each source to a dimensionless fraction of its own
positional mean for that week, averages the fractions, and multiplies back by *ESPN's*
positional mean. Only the shape of a source's opinion crosses over; the unit stays
ESPN's. A source published at twice the scale is therefore the same source, and that
invariant is what makes the average legitimate — it is worth a test if you touch this.
A source covering only part of a position is compared against ESPN on the shared set,
so covering a skewed subset cannot shift that subset's level.

**Aggregate before shrinkage, and log what was shown.** `aggregateProjections` runs
before `shrinkProjections` in `start()`: shrinkage is a property of the number the
engine is about to use, so it must be applied to the aggregate, not to ESPN's raw
number before averaging. The calibration log's `espn` column is snapshotted *before*
the aggregate mutates `p.proj` — otherwise the log records the aggregate twice and the
fitted slope measures nothing.

**The calibration log is the only league-specific model, and it lives in
`chrome.storage.local`.** `CALIBRATION_K` is a literature constant from other people's
leagues; the slope of actual on projected depends on the scoring rules, so this league
has its own. Only something running here each week can measure it — it needs the
projection as it stood before the week alongside the points actually awarded. Each run
writes one row per player to `ffsm.calib.{leagueId}.{seasonId}`; each later run joins
ESPN's own actuals (`statSourceId: 0`, matched on `seasonId`) and refits. Six weeks of
actuals and twenty pairs per position before a fitted slope is trusted, clamped to
[0.3, 1.2]. It is never sent anywhere, and there is nowhere to send it. Nothing prunes
these keys, either: a user in several leagues across several seasons keeps one key per
league-season forever. The rows are small — one per rostered player per week — so this
is housekeeping debt rather than a quota risk, but nothing cleans it up today.

**Defence-versus-position is deferred, deliberately.** Ranking playoff-week matchups
by how each defence performs against a position needs nflverse release assets, which
are not CORS-open and would need either a host permission for a redirecting CDN or a
copy of the data in the repo. The measured effect is also small next to the implied
total, which the environment factor already carries. Revisit only with a CORS-open
source.

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
