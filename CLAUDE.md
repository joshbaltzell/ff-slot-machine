# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**FF Slot Machine** — a Chrome extension that finds fantasy trades and waiver adds
which raise a team's projected *starting-lineup* points, on ESPN and on CBS. It is
the whole project; there is no server, no build step, and no other entry point.

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
  panel.css          the analytics-terminal look, and the tab bar
  engine/
    league.js        what every platform shares: slot and position labels, pro teams,
                     volatility; re-exports platforms/espn.js so old imports still work
    platforms/
      index.js       the registry: detect, byId, the D-03 adapter contract, the
                     five-segment storage keys and their one-time migration
      hash.js        hashRosters - the one roster fingerprint, over native ids
      espn.js        the ESPN loader that used to be league.js
      cbs.js         CBS -> the same model: slot and position tables, eligibility
                     expansion, the session chain, the id crosswalk
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
    distribution.js  measured floor/median/ceiling; teammate correlation; stacks
    gameplan.js      the week's P(win)-optimal lineup, by local search
    odds.js          paired season sims: a trade's change in playoff/bye/title odds
    season.js        Monte Carlo season projection
    usage.js         snap/target share, WOPR, TD over expectation, points over usage
    faab.js          suggested waiver bids
    sources/
      cache.js       TTL-cached fetch for external feeds, storage-injectable
      csv.js         CSV reader (quoted fields)
      sleeper.js     Sleeper players, trending, NFL state
      sleeperproj.js Sleeper/RotoWire weekly projections
      fantasypros.js FantasyPros ECR via DynastyProcess
      sleeperstats.js Sleeper's weekly box score, one request per played week
      fantasycalc.js FantasyCalc crowd values keyed on espnId
      vegas.js       Vegas lines and implied team totals, one request a week
      weather.js     stadium weather for outdoor/retractable games
      stadiums.js    stadium roof and location lookup
  panel/
    market.js        every string of market HTML; degrades to a dash
    availability.js  status codes, cells, badges, log lines, the season note
    projections.js   source orchestration, the ± band, the Calibration section
    environment.js   the environment column, chips and streaming section
    roster.js        2-for-1 waiver notes and the drop-candidate table
    usage.js         the assets, breakout and waiver-bid HTML
    distributions.js floor/ceiling/stack strings; the range bar; the swap threshold
  test/
    parity.mjs       605 assertions against a frozen league — the engine contract
    availability.mjs availability, the horizon, record-seeded seasons, UI strings
    market.mjs       the market phase, offline (fetch and storage injected)
    projections.mjs  aggregate, calibration log and the panel module, offline
    sources.mjs      cache semantics and the Sleeper client, offline
    environment.mjs  151 assertions for lines, weather, factors and streaming
    roster.mjs       replacement level, the 2-for-1 shape, drop ranking
    usage.mjs        usage, breakouts, the crowd split, FAAB bids and the panel HTML
    distributions.mjs distributions, stacks and the weekly plan, offline
    horizon.mjs      the injury horizon: adapter-stated availability, the merge rule,
                     the widened search gate and the panel's return-week strings
    platform.mjs     the normalized-model schema run against every adapter; the
                     storage keys; the panel's platform surface and copy census
    cbs.mjs          the CBS adapter on the recorded league, offline
    fixtures/cbs/    19 scrubbed payloads from a real CBS league, and the capture
                     kit that recorded them; run-all is non-recursive, so no test
    panelui.mjs      the results screen rendered headlessly: the five tabs, the
                     default column set, the detail pane
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

**Usage signals and FAAB bids are evidence, not inputs.** Snap and target shares, WOPR,
touchdowns over expectation, the points-on-usage residual and the suggested bid are
heuristics built from a third-party weekly box score. They rank their own grids and
they are displayed beside the engine's numbers so a claim can be argued with. Nothing
in `search.js`, `lineup.js`, `season.js` or `odds.js` reads any of them, and nothing
should: the moment a heuristic enters the solve, "nothing in the search is
approximated" stops being true. The residual is `null` — never 0 — when a position has
too few players to fit, because 0 already means "exactly on the fit".

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

**A status is a guess about a horizon; a weekly payload is a statement about a week,
and the statement wins.** `PLAY_PROB.later` reads `INJURY_RESERVE`, `PUP` and a
suspension as zero for every remaining week. That is the only reading available on
ESPN, which publishes a projection for every player in every week whatever his status,
so the status string is the only thing that knows he is hurt. It is wrong wherever a
platform already states, week by week, whom it expects to play - and it is wrong in the
expensive direction, because it deletes the eleven good weeks that are the entire reason
to buy an injured starter. So a player may carry an optional
`availability: {[week]: 0..1}`, and `buildAvailability` merges it: a stated week wins
outright from next week on, and **this** week takes the more pessimistic of stated and
guessed, because a weekly include/exclude flag is binary and a Questionable Sunday is
not. ESPN sets nothing, so its path is unchanged character for character - `horizon.mjs`
group 1 is what pins that, and `platform.mjs` holds the field's optional schema. The
derived `statusOf.returnWeek` is read off the row the engine is about to score, never
off a feed's prose, so the badge cannot claim a return the numbers do not have.

**An omission is only information about a position the route actually carries.**
`league/stats?period=weekN` returns QB/RB/WR/TE and nothing else, and within those it
returns whom CBS expects to play that week - recorded week 1 answered with exactly the
148 rostered players it expected plus all 301 free agents, and week 2 re-admitted the
men whose absence had ended, each with a real forecast for that week. Reading absence as
a zero projection therefore conflated two unrelated things, and both were live bugs:
a shelved man lost his return, and **every team defence in every CBS league projected
zero for all seventeen weeks**, in a league that starts one. `attachWeekShape` derives
the covered-position set from the payloads rather than hardcoding it - so a route that
starts carrying defences tomorrow needs no change, and one that stops carrying tight ends
cannot silently shelve every tight end - and a week that answers with a fraction of the
largest payload states nothing at all, because reading it as four hundred absences would
shelve every roster at once. `fillUncoveredPositions` then carries the roster row's
`projected_points` flat across the horizon for the positions nothing covers, zeroed on
the bye. That flat carry is a bad number - it gives every defence the same week every
week, which is the streaming decision a manager actually wants help with - and it is
named in `model.notes` as such. It replaces zero, which was worse: a required starting
slot worth nothing and a defence tradeable for free in either direction. On the waiver
wire there is no roster row to read, so a position the route never carries simply has no
free agents; a note says so rather than leaving an empty list the user reads as "nothing
worth adding".

**The gate was the blocker, not the projections.** `findTwoTeam` accepted a trade only
when every side cleared `minGain` on `gain`, the season average. A trade that buys an
injured starter is negative there by construction - six weeks of nothing for eleven weeks
of a man - so the search could never emit one however good the numbers got. The gate now
takes an `accept` list of window metrics and a side qualifies on any of them; it defaults
to `["gain"]`, which is the predicate that produced `golden_1for1.json`, so the frozen set
cannot move. The panel passes `["gain", "playoff"]`, and the predicate is hoisted out of
the loop so the default path stays one property compare per candidate - 2-for-2 evaluates
it hundreds of thousands of times. `findThreeWay` and `findTwoForOne` stay on `gain`
alone: their prunes are bounds whose correctness proofs assume the gate, and widening
those is a separate change with its own reference test, not a flag. The asymmetry is the
product rather than a side effect - the man selling still qualifies on `gain`, which is
exactly why he would say yes, and the pitch says so in those words. `odds.js` is already
the honest arbiter of whether a side can afford the absence: `season.js` scores every week
from `mu[i].get(w)` and `rosterSigma` returns a per-week array, so the paired simulation
already prices "worse until November, better after" without any change.

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
the spread, not of the projection. The covariance term added on top of this weights each
pair by `sqrt(p_i) sqrt(p_j)`, where the same `E[Var | availability]` decomposition would
call for `p_i p_j` - a 41% overweight on a pair both at `p = 0.71`. That moves team sigma
by well under 1% for a realistic case, and for the positive correlations this build
actually applies it pushes sigma up, partly offsetting the understatement above rather
than adding to it.

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

**The roster is read from the payload that has no week on it.** `view=mRoster&view=mTeam`
without a `scoringPeriodId` is the league as it stands now, and `fingerprint` was already
fetching it. `loadLeague` reads the league out of that blob and hashes the same one, then
fetches only the weeks whose projections the blob did not already carry - a player's
`stats` array often holds several scoring periods at once, so on some leagues that is no
week requests at all. The old loop asked for all seventeen weeks and `restrictToRemaining`
threw the played ones away, which was not merely waste: rosters were unioned across every
fetched week, so a man dropped in September was still on his old team in November and the
search would trade him away. Two things must not drift. The fingerprint must stay a
nicety - when that request fails the week payloads build the league exactly as they always
did, with a null hash, and `platform.mjs` asserts it. And the bye argmax must count only
the weeks actually fetched: an unfetched week is silent for every player on every pro
team, and an argmax over silence hands everybody a bye they have already taken.

**One request prices a week, not thirty-one.** `vegas.js` used to walk ESPN's core API -
a week index, then an event body, then an odds body reachable only through a `$ref` inside
that body - so fifteen games cost ~31 requests and ~8 serial round trips, 63% of the whole
run, for a clamped `[0.6, 1.4]` multiplier over two weeks. The site scoreboard route carries
every game's line inline. `buildWeek` did not change: it already read a competitor as
`refId(team.$ref) ?? Number(id)`, and on this route `competitor.id` **is** the pro-team id,
so a fallback written for robustness turned out to be the whole adapter. One book is quoted
rather than several, so `pickOdds` takes its documented fallback - the first row with a
total. The rule that a week with no line is left out entirely, never defaulted to zero,
is unchanged and is what makes a dead feed identity rather than a distortion.

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
league-scored volatility. `measureVolatility` keeps those residuals, not only their
standard deviation, because a sigma is symmetric and a fantasy week is not: the
10th/50th/90th percentiles in `distribution.js` are the real shape, shrunk toward the
position's by `n/(n+10)`. Team sigma is the root of the summed variance of that week's
starters, so it follows roster composition.

**The correlation constants live in one table, and only real pro teams get them.**
`CORR` in `distribution.js` is the whole model: `0.25` for a quarterback with his own
receiver or tight end, `0.10` for any other pair of teammates, `0` for a running back
with a teammate, `-0.05` for opponents in the same NFL game. `rho`'s cross-team check
runs before the running-back rule, so that `0` applies only within one team: a running
back facing an opponent in the same game would return `-0.05`, not `0`, if the
same-game term were ever wired up. It is not wired up today — `panel.js` calls
`attachCovariance` with no `gameOf`, so `rhoOf` never learns which pro teams share a
game and the `-0.05` figure is defined but inert in the shipped build; wiring a
schedule lookup is future work, not this phase's. `rosterSigma` adds `2 Σ ρ σ σ` over
the week's starters, weighted by the same `sqrt(p)` availability factor the variance
term uses. It applies **only when both players have a real pro team** — never `"X"`,
`"?"` or `"FA"`. That guard is load-bearing twice over: the frozen fixture puts every
player on `"X"`, so parity's season invariants stay true, and a free agent with no
team never invents a stack. The correlation reaches `search.js` as an attached
`eng.rhoOf`, not an import, so `rosterSigma` behaves exactly as it always did on an
engine nobody attached to.

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

**The league model is deliberately not cached, and that is a reversal.** The plan for
this work called for parking `loadLeague`'s return in `chrome.storage` behind a short TTL
and a fingerprint check, because the ESPN loader cost nineteen uncached requests every
run. It does not any more: reading the roster from the no-period payload and fetching only
the weeks that payload did not answer took that to two, sometimes eleven, and the
fingerprint request the cache would need as its freshness check is now **one of them**. So
the saving fell to a handful of requests, against the cost of a hand-written serializer for
`players` and `teams` - Maps and Sets do not survive `chrome.storage` - which is the one
data structure every number in this app is read from. A model that loses a `roster` or a
`proj` on the way through is a league the engine scores wrong and nothing on screen says
so. The four chip groups that `location.reload()` were the other argument for it, and they
re-run thirty seconds of search either way, so the network was never their bottleneck.
Revisit only if the loader goes back to costing many requests.

**The page paints after the 1-for-1 search, and four more times after that.** Both of
the things this tool is for are answerable long before the run is over: the 1-for-1 list
is a real list, and the waiver table needs only the Engine - `render()` computes it and it
never waited on a search at all. So `start()` paints there and then again after each of
2-for-1, 2-for-2 and three-way, after the season odds resolve the Δ columns from dashes to
numbers, and once more when the two display-only feeds land. The shapes were already
ordered cheapest first for exactly this reason; there was simply nowhere to show the
result until the screen had tabs. `enrich` moved to per batch, which changes no number -
it is per-trade independent, one extra lineup solve a side.

Three things this rearrangement must keep true. `marketOrNull` and `usageOrNull` are
**started** before the search and **awaited** after the first paint - they are display-only
by the rule above, and between them they carried 8 and 15 seconds of timeout sitting in
front of thirty seconds of search; `platform.mjs` pins that ordering by source index,
because nothing else can see it. The boot checklist disappears with the boot screen, so
`#working` - a strip outside `#app`, where a re-render cannot reach it - says what is still
running, and the `catch` reports a late failure there instead of writing to a `#bootmsg`
nobody can see any more. And `OPEN_TRADE` holds the trade rather than its row index,
because each paint re-sorts the list and an index would come back pointing at a different
deal.

**Independent feeds start together.** `loadSleeperPlayers` (five megabytes) and
`loadSchedule` depend on nothing below them and on each other not at all, yet were awaited
several steps apart, so the run cost their sum where it should have cost their maximum.
They are settled rather than awaited at the point they start, so a rejection cannot escape
before the step that reports it. Environment is deliberately **not** hoisted: it folds its
factor into `p.proj` before the Engine is constructed and that ordering is load-bearing -
and now that Vegas is two requests rather than sixty-two, there is nothing left to hoist.

**The results screen is five tabs, and `render()` still rebuilds all of it.** There is no
patching layer and there should not be one: `render()` was always idempotent and always
re-invoked on every filter change, so the cheap way to make that affordable was to build
one tab instead of fourteen sections. Each tab is a thunk in `PANELS`; only the open one is
ever called. Anything the user chose therefore has to live outside `render()` or it is
silently reset on the next keystroke - `ACTIVE`, `OPEN_TRADE` and `COLS` sit beside `SORT`
for exactly the reason `SORT` does, and the tab is mirrored into `location.hash` because
four chip groups deliberately call `location.reload()` and used to land the user back on
the first screen. Three things this fixed that were bugs rather than layout: every section
was built eagerly, so `projectSeason` at twenty thousand seasons, `freeAgentUpgrades` and
`gameplan` all re-ran on every step of the min-gain slider (`once()` now memoizes them, and
every chip that could invalidate one reloads the page anyway); the player filter debounced
for 180ms and then replaced the document, dropping focus to `<body>` on every pause in
typing; and the trade rows were clickable and completely unreachable from a keyboard.

**The trade table defaults to eight of its seventeen columns, and two of them are not
optional.** Seventeen columns answer one question with about six. The default set is the
deal, the partner, your gain, their gain and the crowd's price - `theirs` promoted from
column eleven, because "helps my team and theirs" is the whole job - plus the market
balance. Nothing is deleted; the rest are a click away in the Columns menu and persist to
`ffsm.tradeCols`. Two invariants, each a silent failure if missed. `grid()` sorts by
`SORT`'s key only if it can find that key among the columns it was handed, so the current
objective's own column is forced visible and hiding the active sort key hands the sort back
to the objective - otherwise the table reads as insertion order with nothing on screen to
say so. And a filter that keys on a hidden column reveals it: "Even splits" reads `balance`.

**A badge on a trade is a statement about the trade, not about a column.** Phase 12's
`later` tag and the `bye` tag used to live inside the Playoffs and Partner-bye cells, which
made them casualties of any column change. They sit beside the incoming players now, where
`pkg()` already puts the injury badge, so a list the user reads as "trades that help me"
still cannot quietly contain trades that hurt until December whatever the column set is.
The Home screen's "Best move" card carries the same tag for the same reason - the widened
gate means it can pick one.

**The per-trade detail is a pane, not a row.** It used to be a hidden `<tr>` inside a
horizontally scrolling table, which is why it needed `position:sticky;left:0` and a
hand-computed `width:min(calc(100vw - 56px),1324px)` to escape its own scroller. Outside
the table it is an ordinary block that inherits `.wrap`, and both the hack and the
duplicated `.det` rule are gone. `panelui.mjs` asserts the stylesheet no longer contains
them, because that is the kind of thing that gets copied back in.

**`panelui.mjs` renders the page.** Every other test here checks a function that returns a
string; the assembly of those strings is where the tabs live, and `platform.mjs` reads
`panel.js` as text, which cannot tell you that `render()` throws on the Waivers tab. The
test stubs a DOM thin enough to be obviously inert - `querySelector` answers null and
`querySelectorAll` answers empty, so every binding is skipped and what survives is the
markup - and imports `panel.js` once per tab under a distinct URL, because `init()` reads
the tab out of `location.hash` exactly once. It is not a substitute for opening Chrome. It
is the difference between knowing the markup is right and knowing nothing at all.

## Platforms

**The engine never learns a second platform exists.** `engine/platforms/index.js` is a
registry of adapters and the only place that decides which site a league lives on. An
adapter turns a platform's own API into the model `loadLeague` has always returned, and
nothing in `search.js`, `lineup.js`, `season.js`, `odds.js`, `distribution.js`,
`gameplan.js` or any `sources/` module changed for CBS — the masked `run-all` diff under
Testing is what proves that, rather than the claim. The contract is fixed: `id`, `label`,
`hosts`, `acceptsToken`, `signInUrl`, `parseLeagueUrl`, `loadLeague`, `loadFreeAgents`,
`loadSchedule`, `identify`, `fingerprint`, with `ref = {platform, leagueId, seasonId,
teamId?, session?}` and `opts = {fetchImpl, storage, now, notes?}` so every adapter runs
offline under Node. `loadLeague` returns its degradations in `model.notes`;
`loadFreeAgents` returns a plain array, so it writes them to `opts.notes` when the caller
passes one — a dash costs nothing only when the user can tell which dash is which. A "not signed in / no access" failure throws with `code: "AUTH"` and
everything else throws a plain `Error`, because the panel switches on the code and a
message regex was already fragile with one platform. Adapters must not import from
`index.js` — it reads their default exports while it evaluates — which is why the one
thing they share, `hashRosters`, lives in `platforms/hash.js`.

**ESPN's vocabulary is the model's vocabulary, and every translation table lives in
`platforms/cbs.js` and nowhere else.** An adapter emits ESPN numeric slot ids in
`eligibleSlots` and `lineupSlotCounts`, ESPN position ids, ESPN pro-team abbreviations
(CBS's `JAC` and `WAS` become `JAX` and `WSH`) and ESPN injury strings. Where CBS has
something ESPN does not — a
league that splits D/ST into a defence seat and a special-teams seat — the two smallest
unused ESPN ids, 22 and 25, are theirs and `SLOT_LABEL` names them; the engine still sees
only ids. A player's `eligibleSlots` is expanded from the league's own configured slot
codes against his own codes, so a group code accepts its own spelling and its members'
(`DL` accepts `DL`, `DE` and `DT`). That is what lets one table serve both IDP
vocabularies without knowing which one a league uses — and it is untested against a real
IDP league, because the one league ever recorded is offence plus D/ST.

**The canonical player id is the ESPN id, and a player the crosswalk misses takes
`-cbsId`.** Sleeper, FantasyPros and FantasyCalc all already join on `espn_id`, so that
stays the key. CBS ids resolve through the DynastyProcess `db_playerids.csv` that
`sources/fantasypros.js` already downloads; the transform keeps both columns now and the
cache key moved to `src.fp.ids.v2`, because a week-fresh copy of the old array shape would
otherwise be read as the new object and break FantasyPros for a week. Coverage is real and
partial: 9,315 rows carry a `cbs_id` and 7,966 carry both (85.5%), and the 1,349 CBS-only
rows are not all deep IDP — 275 WR, 240 RB, 122 TE, 98 QB. There is **no name matching**.
An unmapped player gets `id = -cbsId`, a negative number that cannot collide with an ESPN
id, and a dash from every external column; he keeps his roster spot and his lineup seat,
because valuing him at zero or dropping him would change the trade math. That is "a dead
feed costs a dash, not the run" applied per player. Two CBS players can resolve to one
ESPN id (the file has 12 duplicate `espn_id` values); the second claimant keeps his
negative id rather than evicting the first. That rule holds **across the two passes, not
only inside each one**: the free-agent pool is seeded with the ids the caller already
holds (`opts.known`), so a free agent can never claim an id a rostered player owns, and
the panel's merge refuses to overwrite an existing player whatever an adapter returns.
Without both, a duplicate row could silently replace a man on a roster, and the engine
would trade away someone who was never there. CBS **team entities stay negative**: the
crosswalk has no `DST`, `TQB` or `TK` rows at all, so every team defence, team quarterback
and team kicker shows dashes. Mapping those by pro-team code instead is a real follow-up
and is deliberately not built.

**`history` replaced the ESPN stat triples before any CBS code landed.** Every player
carries `history: [{season, week, actual, proj}]`, built by the adapter from whatever the
platform reports, and `measureVolatility` and `calibration.js` read that rather than a raw
ESPN stats array. Rows keep their `season` for the same reason ESPN stats are filtered on
`seasonId` — dropping it re-introduces the ~15%-low bug. A platform that publishes points
but not the projection that preceded them writes `proj: null`, never `0`: absent and zero
are different claims, and the volatility fallback below turns on exactly that difference.

**Storage keys carry the platform, and the key is opaque to its readers.**
`ffsm.league.{platform}.{leagueId}.{season}` and `ffsm.calib.{platform}.{leagueId}.{season}`
— five segments, so ESPN league 1234 and a CBS league whose slug happens to be `1234`
cannot share a record. The old four-segment keys are read once as `espn`, rewritten and
removed; the migration is idempotent by construction, since a five-segment key never
matches the legacy pattern. `background.js` no longer splits a key on dots: the stored
value carries its own `{platform, leagueId, seasonId}` and the worker matches the prefix.
`ffsm.myTeam` is the exception and is **global, not per league** — a user with an ESPN and
a CBS league shares one saved team name, so a name that exists in both can shadow the
other's pick. Pre-existing behaviour, out of scope, and worth knowing before debugging it.

**There is one roster fingerprint now, not two.** `hashRosters` is computed by
`platform.fingerprint(ref)` in the service worker and by `loadLeague` into
`model.fingerprint`, which is what the panel stores — the same function over the same
platform-native ids, so the two sides cannot drift. They had drifted: the panel's old
fingerprint sorted numerically and the worker's sorted lexicographically, so `changed`
could read true on a roster nobody had touched. Both of those functions are gone. Hashing
platform-native ids rather than canonical ones also keeps the crosswalk out of the service
worker, where a 12,000-row CSV has no business. A record migrated from a legacy key stores
no hash at all, and the worker adopts the first one it computes instead of comparing, so
the upgrade never lights the badge.

**CBS authenticates on the session cookie, and the fallback chain is cookie, page token,
hand-over, paste — never a password.** The league subdomain's `/api/` proxy answers on the
browser's own session with no token at all; that is measured, not assumed. It does **not**
infer the league from the hostname, so every request must carry an explicit `league_id` or
it answers 400. When the cookie is refused the chain runs: a session already on the ref (a
token the user pasted), the cookie, the token in the signed-in league page's own script
text, then a hand-over from this extension's content script on an open CBS tab. **Every
one of the four re-probes** `league/details` before its session is accepted, the pasted
token included, so a stale token is refused at the door rather than four requests later —
and a refusal falls through to the next route rather than ending the run, because a
manager whose paste has expired usually still has a good cookie. The winner is recorded
per run and outranks the candidate the caller handed in, so a refused token is presented
once and never again. The
token lives on the run's `ref` in memory: never in `chrome.storage`, never in a URL, never
in a log line, never in a note, and never shared between two concurrent runs. The
password endpoint `general/oauth/mobile/login` is never called and the string does not
appear in the extension. `acceptsToken` is what puts a paste field on the sign-in screen,
so an adapter with no sanctioned token route never offers one.

**A CBS league URL carries no season, so the season is read off the schedule rather
than the wall clock.** All three entry points — `content.js`, `panel.js`'s
`refFromInput` and `parseLeagueUrl` — seed `seasonId` from the calendar year, because
there is nothing in the URL to read. The NFL fantasy season runs into January, so from
1 January that guess is a year high, and the cost is not cosmetic: the storage and
calibration keys move to a season that has not started, orphaning a log the user has
been accumulating for months, and `attachHistory` stamps rows with a season
`measureVolatility(players, ref.seasonId - 1)` never looks for, so volatility silently
measures nothing in the weeks that matter most. `loadLeague` therefore reads
`league/schedules?period=all` before it stamps anything, takes the year from the first
regular-season period's `start` (`"9/9/26"`), reconciles it onto the ref and notes the
disagreement. The body is parked for `loadSchedule`, so the route is still read once
per run — the same trick the session probe's `league/details` body uses, since throwing
away a payload the run has already paid for only to ask for it again is a round trip for
nothing. Both parked bodies are consumed once, keyed on the ref in a `WeakMap` exactly as
a session is; anything later fetches, which is the safe direction. A schedule that
publishes no parseable date leaves the guess standing and says so — the reconciliation is
a nicety and never costs the run.

**CBS states a lineup as a per-position range under a cap, and the shared flex is where
that does not fit. This is the most important CBS limitation in this file.** ESPN
publishes fixed slot counts; CBS publishes a minimum and a maximum per position plus an
"Active Players" total. `readSettings` seats each position's `min_active` as dedicated
slots and spends the remaining seats up to the cap on the narrowest ESPN slot covering
every position with headroom (`flexSlotFor`), so the recorded league becomes QB 1, RB 1,
D/ST 1, RB-WR-TE 5 — the 8 starters CBS itself allows. The residual approximation: a
shared flex can seat more of one position than that position's own maximum allows, five
RB/WR/TE seats against an RB max of 3, because ESPN slot vocabulary cannot put a
per-position ceiling on a shared flex. It is permissive inside one position group rather
than a phantom lineup — every seat exists and the total is right — but an optimal lineup
may start a fourth running back the league would refuse. The alternative, reading the
maxima as seats, gave that league 14 starters against a cap of 8 and scored every trade
against a team nobody can field. This is the better of two imperfect readings, not a good
one.

**On CBS, volatility is measured around a player's own mean rather than around a
forecast.** `measureVolatility` keeps its original branch byte-for-byte wherever a prior
season carries both a projection and an actual. The fallback is chosen for the **league,
after the loop, not per player**: it fires only when the season carried no projection for
anybody, which is every CBS history row, because the route the adapter reads publishes
points and nothing else. That gate is load-bearing rather than tidy — a per-player gate
also fires on ESPN, for any player ESPN scored last season and never projected (a rookie,
a late add), and a sigma taken around a player's own mean then enters the same pool that
builds `byPos` and `global`, moving the priors `distribution.js`, `rosterSigma`, `P(win)`
and the season odds all inherit. The frozen fixture carries both sides of every history
row, so the masked diff cannot see that; `platform.mjs` asserts it directly instead. Where
the fallback does fire it measures the spread of a player's weekly scores around his own prior-season mean, drops
any zero week (with no projection beside it a zero and a bye are the same row), and shrinks
the resulting sigma toward the positional prior by `n/(n+10)`, where the projection branch
shrinks a sigma not at all. The return says which: `mode` is `projection-residuals`,
`actuals-only` or `none`, `counts` reports how many players each branch measured, and the
panel names the platform and the degradation rather than showing both as "measured". The
harder shrink is not decoration — sigma is what the season odds rest on, and a spread taken
around a mean estimated from the same seven numbers is a softer claim than a spread around
an independent forecast. Note what this is and is not: CBS **does** retain prior-season
projections (`stats_type=projections&period=week1&timeframe=2025` answered with 271
players, which overturns the assumption the fallback was designed on), so this is a
consequence of which route supplies `history`, not of what CBS keeps. Reading those
projections into `history.proj` would move a CBS league onto the original branch and is
recorded as unbuilt rather than impossible. The old "assume ±25" path is now the last
resort it was always meant to be, and its log line names the platform too.

**Three CBS paths are pinned by tests and have never run against a live league.** All
three are in `.planning/WINDOWS.md` and are explicit steps in
`docs/superpowers/2026-09-09-phase-11-browser-checklist.md`, whose ESPN half is not
optional either: phases 1–8 were never browser-verified at all.

- *A rostered player's weekly-scoring history.* `league/fantasy-points/weekly-scoring`
  defaults to `player_status: free_agents`, and the recorded capture took the default, so
  the fixture holds 1,809 free agents and **0** of the league's 168 rostered players. The
  adapter sends `player_status=all` and the builder is proven on the free-agent rows plus
  one synthetic rostered row. Whether CBS answers with rostered players under that
  parameter is unconfirmed — and if it does not, the volatility fallback has nothing to
  measure. No fixture was fabricated to hide this.
- *The bare `Authorization` header against `api.cbssports.com`.* The spike measured a
  custom header from a page origin as `Failed to fetch` — a CORS preflight a page origin
  may not make — and `access_token=` in the query at 200. The header route is therefore
  **untested, not disproved**: an extension page holding the host permission may manage
  the preflight. The adapter sends the header, because a token in a URL is the one thing
  the token posture forbids. If a browser run shows CBS refuses it, move to the query
  parameter — a change of transport, not of design.
- *The `ffsm.token` hand-over, and the two-level subdomain wildcard.*
  `chrome.tabs.sendMessage({type: "ffsm.token"})` and the content script's reply agree by
  assertion, and a test reads both files as text so the two copies of the host regex and
  the token pattern cannot drift; no offline test can send a real message across the
  extension boundary. `https://*.cbssports.com/*` is assumed to match
  `<slug>.football.cbssports.com`, and both hosts are listed so a wrong assumption costs a
  redundant permission rather than a broken script.

**Two things that look like bugs and are not.** `sources/vegas.js` fetches from
`sports.core.api.espn.com` on both platforms: it is a public odds feed, not the fantasy
platform, and making it platform-aware would break CBS leagues for no reason. And a
**numeric** CBS slug typed bare into the league prompt routes to ESPN — the prompt tries
digits first, because an ESPN league id is nothing but digits — so paste the league URL
rather than the slug in that case, since a URL always goes through `detect()`.

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

`platform.mjs` holds the normalized-model schema and runs it against **every** entry of
`PLATFORMS`, so a new adapter is held to the same structural assertions the ESPN one is,
on recorded or synthesized raw payloads with `fetchImpl` injected. `cbs.mjs` drives the
CBS adapter on `test/fixtures/cbs/`, nineteen payloads recorded from a real league and
scrubbed the way `fixture.json` was — the scrub kit is in that directory and its
`--verify` pass re-checks a re-record without knowing the secrets. `--verify` reads the
same `TOKEN_PATTERNS` table and the same page-field rule the write-time check reads, and
`--trim` ends on it: those are the only two things standing between a live token and this
repository, and a shape one of them omits is a shape nothing checks at all, because the
run that knew the secrets is gone by then.

**"ESPN is unchanged" is a diff, not a promise.** Capture the suite's output with the one
nondeterministic line masked, the two platform files' blocks dropped and the trailing file
count normalised, and diff it against a copy taken before the seam existed (the Phase 11
baseline is `.planning/phases/11-cbs-platform/run-all-before.txt`):

```bash
node extension/test/run-all.mjs 2>&1 \
  | sed -E 's/[0-9]+ ms per trade/N ms per trade/' \
  | awk '/^=== (platform|cbs|horizon|panelui)\.mjs ===/{skip=1; next} /^=== /{skip=0} !skip' \
  | sed -E 's/^[0-9]+ files, /N files, /'
```

An empty diff means the nine pre-existing files' assertion counts and output are
byte-identical. Each phase that adds a test file adds it to the mask - a new file's
output is new by definition, and leaving it in would mean the diff could never be
empty again. Phase 12 added `horizon`; the tab restructure added `panelui`. Anything
else is a behaviour change in ESPN's path, whatever the commit message says.

## The daily reminder

`content.js` injects a notice on both platforms' league pages —
`fantasy.espn.com/football/*` and `*.football.cbssports.com/*`, never the CBS lobby and
never `<all_urls>` — and decides which platform it is on from the page itself, sending
that with every message. `background.js` runs a 12-hourly alarm and is a **module**
service worker, so it can import the registry and resolve an adapter by `ref.platform`.
**The alarm does not run the trade search.** MV3 kills a service worker at five minutes
and a league pull is eighteen calls, so the job makes one light request through
`platform.fingerprint(ref)` — `mRoster` on ESPN, `league/rosters?team_id=all` on CBS —
and compares the hash against the one the panel stored from `model.fingerprint` on its
last run. Both sides are the same `hashRosters` over the same platform-native ids, so
there is no second implementation to keep in step; `nextLeagueRecord` is where the
compare-or-adopt decision lives.

Showing the notice is rate-limited to once per league per day and honours a dismissal
for 24 hours. Keep that bar high; an extension that announces itself every visit gets
uninstalled.

## Privacy

Everything runs locally against the platform's own read API using the browser's own
session. No backend, no analytics, no league data leaves the machine. There are two
platform hosts, `fantasy.espn.com` and `*.cbssports.com`, and each is reached only with
the user's own cookies — or, on CBS when the cookie is refused, with a token read from
the page the user is already signed in to and held in memory for the run and nowhere
else. `api.sleeper.app` is asked only for its public, league-agnostic player list,
weekly stats and trending-add feeds — no league id, no team, no roster is sent with
any of those requests — and the same holds for CBS's public `positions`, `pro-teams`,
`players/injuries` and `players/list` feeds, which carry neither a `league_id` nor the
token even though they live on the same host as the authenticated league routes. That
last one is worth a test rather than a promise, and has two: "same host" is exactly the
condition under which a credential leaks by accident. Keep it that way.
