# Phase 7 — Game environment: Vegas totals, streaming planner, weather

Status: approved for build (Josh, 2026-08-27). Covers brainstorm C2, F3, C5.
C4 (playoff-week defence-vs-position tiebreak) is **deferred**: it needs nflverse
release assets, which are not CORS-open, and the literature says the effect is
small. Follow `2026-08-27-parallel-phase-rules.md`; this phase does not touch
`search.js`, `season.js` or `league.js`.

## Sources (`extension/engine/sources/`)

**`odds.js` → rename to avoid clash: `vegas.js`.** ESPN core API, CORS-open, no key:
`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{yr}/types/2/weeks/{w}/events`
→ list of `$ref`s; each event `…/events/{id}/competitions/{id}/odds` → items with
`provider.id`, `spread`, `overUnder`, `homeTeamOdds.favorite`. Prefer provider 58
(ESPN BET), else the first. Implied totals: favourite `(O/U + |spread|)/2`, underdog
`(O/U − |spread|)/2`. Team keys: ESPN team `id` from the competition's competitors
(`team.$ref` ends in the pro team id, which matches `proTeamId` in the league data).
Fetch for `currentWeek` and `currentWeek + 1`; concurrency ≤ 4; cached 3 h.
`loadVegas(season, weeks, opts) -> Map<week, Map<proTeamId, {implied, opp, oppImplied, total, spread, home}>>`.

**`weather.js`.** Open-Meteo, keyless, CORS-open:
`https://api.open-meteo.com/v1/forecast?latitude=&longitude=&hourly=wind_speed_10m,wind_gusts_10m,precipitation_probability&forecast_days=7&wind_speed_unit=mph`.
A static table `STADIUMS` (32 rows: proTeamId → lat, lon, roof: open|dome|retractable)
lives in `sources/stadiums.js`. Only for the current week's home team and only when
the roof is open; kickoff time comes from the ESPN event `date`. Returns
`{wind, gust, precipProb}` at kickoff hour. Cached 3 h.

## Adjustment — `extension/engine/environment.js`

Multiplicative factors for the current week (and next, for Vegas only), applied to
`p.proj[w]` in `start()` after aggregation and shrinkage, behind a toggle
`ffsm.environment` (default on). Constants in one exported table `ENV_K`:

| Group | Vegas factor | Weather factor |
|---|---|---|
| D/ST | `1 + 0.6 · (avgImplied − oppImplied) / avgImplied` | — |
| K | `1 + 0.4 · (teamImplied − avgImplied) / avgImplied` | wind > 15 mph: ×0.90; > 25: ×0.80 |
| QB, WR, TE | `1 + 0.25 · (teamImplied − avgImplied) / avgImplied` | wind > 20 mph: ×0.95; precip ≥ 70%: ×0.95 |
| RB | `1 + 0.15 · (teamImplied − avgImplied) / avgImplied` | — |

Factors clamp to [0.6, 1.4]. `avgImplied` is the mean implied total across that
week's games. `applyEnvironment(model, vegas, weather, weeks) -> {adjusted, byPlayer: Map<id, {vegas, weather}>}`.
Position groups come from `pos` labels (display-only strings — acceptable here because
this is an input adjustment, not lineup logic; say so in a comment).

## Streaming planner — `extension/engine/streaming.js`

For slot groups K, D/ST, QB, TE (only those where `lineupSlotCounts` has the slot):
`streamPlan(eng, model, team, {weeks: 3})` → for the next 3 remaining weeks, rank
candidates (my rostered players at that position + free agents) by the sum of
projected points over the window, using environment-adjusted values where lines
exist; mark bye weeks; report the best single hold and the best week-by-week
sequence (greedy, one add per week). Output rows: player, owner (me/FA), pts by week,
window total, `hold` flag.

## UI — `extension/panel/environment.js`

- Chips: **Environment** `Vegas + weather` / `Off` beside the Projections chips.
- Log lines: "Vegas: N games priced for week W (avg total T)"; "weather: K open-roof games, worst wind X mph"; degrade lines on failure.
- Roster grid: **Env** column showing the combined factor as `×1.08`, hint names implied total and weather.
- New section **Streaming planner** with one grid per streamable slot present.

## Tests — `extension/test/environment.mjs`

- Implied totals from spread/OU (favourite/underdog), provider preference.
- Factor table: each group; clamp; `avgImplied` computed over the week.
- `applyEnvironment` leaves weeks without lines untouched; toggle off is identity.
- Weather thresholds; dome → no factor.
- `streamPlan`: window sums, bye marked, greedy sequence beats hold when a candidate's bye falls inside the window.
- All fetches injected; dead feed → identity and a log flag.
