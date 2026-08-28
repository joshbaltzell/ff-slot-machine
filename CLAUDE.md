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
    sources/         one module per external feed (cache, sleeper, vegas, weather, stadiums)
    league.js        ESPN API -> normalized model; settings; volatility
    lineup.js        optimal lineup for any slot configuration
    search.js        swap table, shapes, N-sided trades, three-way, free agents
    winprob.js       normal CDF, P(win), per-week leverage
    calibrate.js     positional shrinkage of ESPN projections
    environment.js   Vegas + weather -> a factor on this week's and next week's proj
    streaming.js     three-week hold-or-churn plan for K, D/ST, QB and TE slots
    odds.js          paired season sims: a trade's change in playoff/bye/title odds
    season.js        Monte Carlo season projection
  test/parity.mjs    605 assertions against a frozen league
  panel/environment.js  the environment column, chips and streaming section
  test/environment.mjs  141 assertions for lines, weather, factors and streaming
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

**Nothing in the search is approximated.** Three-way is exhaustive via the swap table in `search.js`.
A marginal-value pruning heuristic was measured at 57% recall and rejected.

**Time windows stay separate.** `gain` / `reg` / `playoff` / `bye` / `full` disagree
with each other, and that is the point: a trade can be positive on the season
average while hurting the record that decides seeding. Never collapse them.

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
for. Three rules keep it safe. It never enters lineup logic — the solver still runs
entirely on `eligibleSlots`, and the position strings `envGroup` reads are the one
sanctioned exception in the codebase, because they choose a coefficient and nothing
else. It never touches a week without a line, so a dead feed is identity rather than
a distortion. And it never reaches past next week, because a season-long trade
evaluation must not be tilted by two weeks of weather. Factors clamp to
[0.6, 1.4]; retractable roofs count as covered, since no feed says whether the roof
was shut and closing it is the common case.

**Volatility is measured, not assumed.** `statSourceId: 0` gives the prior season's
actual weekly scores in the same payload as projections; the residual is real
league-scored volatility. Team sigma is the root of the summed variance of that
week's starters, so it follows roster composition.

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
backend, no analytics, no league data leaves the machine. Keep it that way.
