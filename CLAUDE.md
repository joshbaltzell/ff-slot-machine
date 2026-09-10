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
  panel.css          the analytics-terminal look
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
      vegas.js       Vegas lines and implied team totals
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
    platform.mjs     the normalized-model schema run against every adapter; the
                     storage keys; the panel's platform surface and copy census
    cbs.mjs          the CBS adapter on the recorded league, offline
    fixtures/cbs/    19 scrubbed payloads from a real CBS league, and the capture
                     kit that recorded them; run-all is non-recursive, so no test
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

## Platforms

**The engine never learns a second platform exists.** `engine/platforms/index.js` is a
registry of adapters and the only place that decides which site a league lives on. An
adapter turns a platform's own API into the model `loadLeague` has always returned, and
nothing in `search.js`, `lineup.js`, `season.js`, `odds.js`, `distribution.js`,
`gameplan.js` or any `sources/` module changed for CBS — the masked `run-all` diff under
Testing is what proves that, rather than the claim. The contract is fixed: `id`, `label`,
`hosts`, `acceptsToken`, `signInUrl`, `parseLeagueUrl`, `loadLeague`, `loadFreeAgents`,
`loadSchedule`, `identify`, `fingerprint`, with `ref = {platform, leagueId, seasonId,
teamId?, session?}` and `opts = {fetchImpl, storage, now}` so every adapter runs offline
under Node. A "not signed in / no access" failure throws with `code: "AUTH"` and
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
negative id rather than evicting the first. CBS **team entities stay negative**: the
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
text, then a hand-over from this extension's content script on an open CBS tab. Each
non-primary route re-probes the cheapest authenticated endpoint before its session is
accepted, so a stale token is refused at the door rather than four requests later. The
token lives on the run's `ref` in memory: never in `chrome.storage`, never in a URL, never
in a log line, never in a note, and never shared between two concurrent runs. The
password endpoint `general/oauth/mobile/login` is never called and the string does not
appear in the extension. `acceptsToken` is what puts a paste field on the sign-in screen,
so an adapter with no sanctioned token route never offers one.

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
season carries both a projection and an actual. Where it carries actuals only — which is
every CBS history row, because the route the adapter reads publishes points and nothing
else — it measures the spread of his weekly scores around his own prior-season mean, drops
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
`--verify` pass re-checks a re-record without knowing the secrets.

**"ESPN is unchanged" is a diff, not a promise.** Capture the suite's output with the one
nondeterministic line masked, the two platform files' blocks dropped and the trailing file
count normalised, and diff it against a copy taken before the seam existed (the Phase 11
baseline is `.planning/phases/11-cbs-platform/run-all-before.txt`):

```bash
node extension/test/run-all.mjs 2>&1 \
  | sed -E 's/[0-9]+ ms per trade/N ms per trade/' \
  | awk '/^=== (platform|cbs)\.mjs ===/{skip=1; next} /^=== /{skip=0} !skip' \
  | sed -E 's/^[0-9]+ files, /N files, /'
```

An empty diff means the nine pre-existing files' assertion counts and output are
byte-identical. Anything else is a behaviour change in ESPN's path, whatever the commit
message says.

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
