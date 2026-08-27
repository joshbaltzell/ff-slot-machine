# Phase 2 — Availability core and the in-season horizon

Status: approved for build (Josh, 2026-08-27: "do as many phases as you can").
Covers brainstorm B1 and the data-layer half of H1; also fixes a pre-existing
in-season flaw the brainstorm missed (past weeks counted toward trade value).
Follow `2026-08-27-parallel-phase-rules.md`.

## Why

Rosters are treated as frozen and healthy. `injuryStatus` is already in the ESPN
payload we fetch and is ignored; a player on IR projects like a starter, a
Questionable one like a certainty. Bench depth is worth exactly nothing because no
starter ever misses a game. And every week of the season counts toward `gain`,
including the ones already played, so a mid-season trade is scored partly on games
that cannot change.

## Scope

| Code | Feature |
|---|---|
| H1 | Record ESPN `injuryStatus` / `injured` on player records; load Sleeper players for practice reports (shared client) |
| B1 | Play probability per player-week; expected lineup value under uncertainty inside `Engine.weekly` |
| — | Remaining-weeks horizon: engine weeks start at `currentWeek`; season sim starts from the real standings |
| — | UI: status badges, availability column, log lines, disclosures |

Out of scope: expected return week (Phase 9 B2), durability priors (B3), news (B4).

## Design

### Data

`loadLeague` records on each player: `injuryStatus` (string, e.g. ACTIVE,
QUESTIONABLE, DOUBTFUL, OUT, INJURY_RESERVE, SUSPENSION — pass ESPN's string
through), `injured` (bool). `loadFreeAgents` likewise. `loadLeague` also records per
team `record: {wins, losses, ties, pointsFor}` from `t.record.overall`.

`extension/engine/sources/sleeper.js` (exists) supplies `byEspn` with
`injury_status`, `practice_participation` (`FP`/`LP`/`DNP` or null),
`practice_description`, `injury_body_part`, `news_updated`. Loaded in `start()`
as its own loading step "Injury reports"; failure degrades to ESPN status only.

### Play probability — `extension/engine/availability.js`

```
playProb(status, practice, weekIndexOffset) -> number in [0,1]
```
`weekIndexOffset` is 0 for the current week, ≥1 for future weeks.

| ESPN status | current week | future weeks |
|---|---|---|
| ACTIVE / null | 1 | 1 |
| QUESTIONABLE | 0.71; with practice FP 0.90, LP 0.70, DNP 0.35 | 1 |
| DOUBTFUL | 0.06 | 1 |
| OUT | 0 | 1 |
| INJURY_RESERVE / IR / PUP | 0 | 0 |
| SUSPENSION | 0 | 0 (length unknown; conservative, flagged in UI) |

Sleeper's `injury_status` (Questionable/Doubtful/Out/IR/PUP/Sus) is used when ESPN
reports ACTIVE but Sleeper does not — ESPN lags the wire. Constants live in one
exported table `PLAY_PROB` so Phase 9 can replace them.

`buildAvailability(model, sleeperByEspn, weeks, currentWeek) -> Map<playerId, Float64Array(NW)>`
gives every player a probability per engine week.

### Engine — `search.js`

`Engine.setAvailability(avail)` stores `this.avail: Float64Array(n*NW)` (default 1).
`weekly(ids, out)` becomes availability-aware:

- For each week, split `ids` into certain (`p ∈ {0,1}`) and uncertain players.
  Certain players with `p = 0` are excluded; `p = 1` kept at full projection.
- If there are no uncertain players, solve once (today's path — zero cost change).
- If `1 ≤ k ≤ 6` uncertain players, enumerate the `2^k` outcomes and return the
  probability-weighted mean of the optimal lineup values. If `k > 6`, draw 64
  outcomes with a fixed-seed `mulberry32` and average.
- Only the current week can have uncertain players, so the extra cost is confined
  to one week per lineup solve.

`starterMask` and `explain` use the *most likely* outcome (each uncertain player in
if `p ≥ 0.5`) so usage strips stay readable; note this in a comment.
`rosterSigma` treats a player's variance as `p·σ²` (an OUT player contributes none).

### Horizon

In `start()`, after `loadLeague`: `model.weeks = model.weeks.filter(w => w >= currentWeek)`
and the same for `settings.regularSeasonWeeks` / `playoffWeeks` /
`playoffRoundWeeks` before `Engine` is built (do this in one helper
`restrictToRemaining(model)` in `availability.js`, tested). If no week remains
(season over), keep all weeks and log that the season is complete.

`projectSeason` gains `records: Map<team, {wins, losses, pointsFor}>` — each sim's
`wins[i]`/`pf[i]` start from the real record rather than zero. `games` in the result
becomes played + remaining. `panel.js` passes `records` from the model.

Fingerprint: `rosterFingerprint` must keep hashing the full roster set — unchanged.

### UI (`extension/panel/availability.js`)

- Roster grid: a **Status** column (`Q · LP`, `OUT`, `IR`, `SUS`, blank) with a hint.
- Trade grid packages: a small badge after any player whose current-week `p < 1`
  or any-week `p = 0` (`Q`, `D`, `O`, `IR`, `SUS`).
- Log lines: "availability: N out this week, M questionable, K on IR/suspended";
  "horizon: weeks A–B (C played)".
- Season panel note: replace "Rosters are frozen: no waivers, injuries or trades" with
  "Rosters are frozen except for current injury status: OUT/IR players score nothing,
  Questionable ones are weighted by their chance to play."

## Tests — `extension/test/availability.mjs`

Build a small model from `fixture.json` the way `parity.mjs` does (copy the
construction; do not import parity.mjs).
- `playProb` table: every row above; Sleeper override when ESPN says ACTIVE.
- `restrictToRemaining`: weeks ≥ currentWeek kept; settings arrays filtered; season-over case keeps all.
- `weekly` with one OUT starter this week equals `weekly` of the roster without him.
- `weekly` with one Questionable player `p=0.71` equals `0.71·L(with) + 0.29·L(without)` to 1e-9.
- `k=7` uncertain players: deterministic across two calls; within 3% of the enumerated value for `k=6` plus one certain player.
- All-available engine reproduces `F.baseline` exactly (the contract still holds when `avail` is all ones).
- `projectSeason` with `records`: a team seeded 5–0 has `wins ≥ 5` in every sim (assert mean ≥ 5 and mean ≤ 5 + remaining games).

## Risks

Sleeper's `espn_id` coverage is incomplete for rookies/D-ST; fall back to ESPN status.
Enumeration cost is bounded by `2^6 = 64` solves for one week. `Q` conversion rates
are league-average; team-specific tendencies are Phase 9.
