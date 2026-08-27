# Phase 5 — Projections: multi-source aggregate and the calibration log

Status: approved for build (Josh, 2026-08-27). Covers brainstorm C1 and H2.
Follow `2026-08-27-parallel-phase-rules.md`. Do not modify `search.js` or `season.js`.

## Why

Averaging projection sources beats any single source (FFA, 12 seasons: the plain
average beat individuals 69% of the time; accuracy-weighting adds nothing). ESPN is
one source. And the calibration slopes we apply (Phase 1) are literature constants;
this league's own scoring produces its own slope, which nobody but us can measure.

## Sources

1. **ESPN** (exists): league-scored, every remaining week.
2. **Sleeper / RotoWire** — `extension/engine/sources/sleeperproj.js`:
   `https://api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_ppr`
   per remaining week (cached 6 h each). Rows have `player_id` and `stats.pts_ppr /
   pts_half_ppr / pts_std`; pick the column by `settings.pprValue` (nearest of
   1 / 0.5 / 0). Map to ESPN ids through `loadSleeperPlayers().bySleeper`.
3. **FantasyPros ECR via DynastyProcess** — `extension/engine/sources/fantasypros.js`:
   `https://raw.githubusercontent.com/dynastyprocess/data/master/files/fp_latest_weekly.csv`
   (current week only; cached 6 h; `parse: "text"`), joined to ESPN ids via
   `https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv`
   (`fantasypros_id` → `espn_id`, cached 7 days). Use the `r2p_pts` column when present
   (rank-to-points), else skip the source. Write a small CSV parser (quoted fields) in
   `sources/csv.js`.

## Aggregation — `extension/engine/aggregate.js`

External sources are not league-scored, so raw points cannot be averaged with ESPN.
Normalize each source by its own positional mean for that week among players who
appear in both that source and ESPN with `proj > 0`:

```
frac_s(p, w) = src_s(p, w) / mean_pos_s(w)
agg(p, w)    = mean_pos_ESPN(w) × mean over available sources s of frac_s(p, w)   (ESPN included)
band(p, w)   = mean_pos_ESPN(w) × sd of frac_s(p, w)   (0 when only ESPN)
```
`aggregateProjections(model, sources, weeks) -> { changed, coverage: {sleeper, fp}, band: Map<id, Float64Array(NW)> }`
mutates `p.proj` in place (like `shrinkProjections`) and returns the disagreement
band. Runs in `start()` **before** shrinkage (aggregate first, then calibrate the
aggregate), behind a toggle `ffsm.aggregate` (default on) in the same chips group as
the calibration toggle. Players a source does not cover use the sources that do.

## Calibration log — `extension/engine/calibration.js`

Each run, store for the current week and every player with an ESPN projection:
`{week, espn, sleeper, fp, agg}` under `ffsm.calib.{leagueId}.{seasonId}` (a map
week → array). On later runs, past weeks' actuals come from `rawStats`
(`statSourceId 0`, matching `seasonId`); join and compute per source and position:
MAE, mean error (bias), and the OLS slope of actual on projection. Expose
`fitSlopes(log) -> { QB, RB, WR, TE }` and `summary(log) -> rows`. When ≥ 6 weeks
have actuals, `start()` passes the fitted slopes to `shrinkProjections` instead of
`CALIBRATION_K`, and the log line says so.

Storage injection: functions take `{storage}` like the source layer, so tests use
the in-memory map.

## UI — `extension/panel/projections.js`

- Chips: **Sources** `Aggregate` / `ESPN only` beside the Projections chips.
- Log lines: "projections: Sleeper covers N of M players, FantasyPros K (week W)";
  "calibration log: W weeks stored, S with actuals".
- Roster grid: **±** column = mean band over remaining weeks (source disagreement).
- Trade detail: after each acquired player's name, `±band` when > 0.5 pts.
- New section **Calibration** (below Projected season): a grid of source × position
  with MAE, bias, slope, n; a note stating literature vs fitted slopes and which is in use.

## Tests — `extension/test/projections.mjs`

- CSV parser: quoted commas, empty fields.
- Normalization: two sources agreeing exactly produce `agg = espn` and `band = 0`;
  a source at 2× positional fraction moves `agg` by the right amount.
- Missing coverage: a player only in ESPN is unchanged.
- Sleeper column choice by `pprValue` (1 → pts_ppr, 0.5 → half, 0 → std).
- Calibration: synthetic log where actual = 0.8·proj + noise → fitted slope within 0.05 of 0.8; MAE/bias correct; `< 6` weeks returns null slopes.
- Offline: all fetches injected; a dead source leaves `agg = espn`.
