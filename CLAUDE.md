# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A trade finder for ESPN fantasy football league 153385. It searches for trades
that raise **both** teams' projected starting-lineup points. See `README.md` for
usage; this file covers what you can't infer from reading one file.

## Commands

```bash
python3 find_trades.py --open        # all shapes (1-for-1, 2-for-2, three-way)
python3 find_trades.py --shape three-way   # one shape; repeatable
python3 find_trades.py --depth 1     # 1-for-1 only, ~1s - use this while iterating
python3 find_trades.py --excel       # also emit trade_report.xlsx
python3 espn_pull.py                 # refresh the workbook (needs ESPN cookies)
```

Tests live in `tests/`, run with `python3 -m pytest -q`. `conftest.py` sits at the
repo root so `import ffti` resolves. The suite's most valuable member is
`tests/test_search.py::test_one_for_one_matches_golden`, a snapshot of 1-for-1
output — it is how the N-sided refactor was proven behaviour-preserving. If it
fails, the change is wrong; regenerate `tests/golden_1for1.json` deliberately,
never to make a red test green.

The two solver invariants it rests on, both of which have held:

```bash
# weekly_points and starter_mask are independent implementations of the same rules
python3 -c "
import sys; sys.path.insert(0,'.'); import numpy as np
from ffti import data, lineup
lg=data.load(); s=lineup.LineupSolver(lg.config)
pos=lg.players['Position'].to_numpy()
for t,idx in lg.rosters.items():
    b={p:lg.proj[idx[pos[idx]==p]] for p in set(pos[idx])}
    i={p:idx[pos[idx]==p] for p in set(pos[idx])}
    m=s.starter_mask(b,i); manual=sum(np.where(v,lg.proj[k],0.) for k,v in m.items())
    assert np.allclose(s.weekly_points(b), manual), t
    assert all(sum(v[w] for v in m.values())==s.starters for w in range(lg.n_weeks)), t
print('solver ok')"
```

## Architecture

The pipeline is linear: `data.load()` → `LineupSolver` → `TradeFinder` →
`report.write()`. Each stage is independently runnable in a REPL.

**`ffti/data.py`** flattens the workbook into a `League`: a `(160, 18)` float array
of projections plus index arrays per fantasy team. Everything downstream indexes
into that array by integer player id — names are only rejoined at report time.

**`ffti/lineup.py`** is the core. It solves a full season of optimal lineups at
once, vectorized over weeks, by filling dedicated position slots first and FLEX
from the leftovers. **That greedy order is only optimal because slot eligibility
sets are nested** (RB, WR, TE each ⊂ FLEX). `_validate` rejects partially
overlapping flex groups rather than silently returning a suboptimal lineup — if
you add a slot type, keep that invariant or replace the solver with a proper
assignment algorithm.

`starter_mask` deliberately re-solves in slow per-week Python instead of sharing
code with `weekly_points`. It only runs on displayed trades, and having two
independent implementations is what makes the invariant check above meaningful.

**`ffti/swaps.py`** precomputes, per team, the value of every `(player_out,
player_in)` swap. That table is what makes exhaustive three-way search cheap
(~1 s, no heuristic, no caveat). Built lazily — only the three-way path needs it.
Its exactness is load-bearing and is pinned by `tests/test_swaps.py`. An earlier
design pruned the three-way search with marginal-value estimates instead; that was
measured at 57% recall and abandoned. Do not reintroduce it.

**`ffti/search.py`** enumerates trades and scores each as the change in optimal
started points. Trades are **N-sided**: `Trade.sides` is a tuple of `TradeSide`,
and a two-team swap is just N=2. Search is driven by named entries in `SHAPES`
(`1-for-1`, `2-for-2`, `three-way`), not by a depth integer; `depth=` survives
only as shorthand for the symmetric two-team shapes. Do not add a roster cache — an earlier version cached by roster
id-tuple and grew to 1.3M entries at depth 2 with a near-zero hit rate.

Each trade is scored on several time windows because they disagree, often sharply:
all-18-week `gain_*`, regular-season `reg_*`, `playoff_*`, and thin-vs-full-strength
`bye_*`/`full_*`. A trade can be positive on the season average while being negative
across the regular season — the average is carried by playoff weeks that do not
affect seeding. Never collapse these back into one number.

**`ffti/wins.py`** converts points into expected wins. Weekly scores are modelled as
`Normal(projection, sigma)` so small edges buy small fractions of a win; scoring a
0.4-point edge as a certain win would overstate every trade by an order of magnitude.
With no schedule available it computes an all-play record (expected share of the
field beaten each week). `score_wins` runs only on deduped trades — it compares a
roster against the whole field and would dominate the search otherwise.

A useful invariant: with all-play and no schedule, total expected wins across the
league must equal `n_teams * n_games / 2` (70.00 here).

**`ffti/report.py`** + `template.html` produce a self-contained HTML page; the
payload is JSON-embedded at the `__PAYLOAD__` placeholder. Keys prefixed `_` are
stripped before embedding (they exist for the Excel writer).

The page is vanilla JS around one generic `Table(sel, cols, opts)` helper that owns
header rendering, click-to-sort, `aria-sort` state and stable numeric-aware sorting.
Adding a column means adding one entry to a `*Cols` array — a `label` may be a
function for headers that change with the selected team. `opts.row` may return an
array of nodes; the trades table uses that to emit a row plus its hidden detail row.

Two layout constraints that are easy to reintroduce:

- `.scroll` is `overflow:auto` with a `max-height`, **not** `overflow-x:auto`.
  `overflow-x:auto` computes `overflow-y` to `auto`, silently making that div the
  scroll container, which pushed the sticky `thead` below the first row.
- Position-tag hues are tuned for the dark palette and are re-specified under
  `:root[data-theme="light"]`; they are illegible on cream otherwise.

## League and data conventions

Non-obvious things that will silently corrupt analysis:

- **`TQB` is a real position.** This league starts a *team* quarterback
  ("Commanders TQB"), not an individual QB. Position logic keyed on `QB` matches
  nothing. Positions are `TQB`, `RB`, `WR`, `TE`, `D/ST`, `K`.
- **Lineup is 1 TQB / 2 RB / 2 WR / 1 TE / 1 FLEX / 1 K / 1 D-ST** — 9 starters,
  7 bench, confirmed by the league owner. FLEX is RB/WR/TE.
- **Points are already league-scored.** They come from ESPN's `appliedTotal` where
  `statSourceId=1` and `statSplitTypeId=1`. Never re-score them against PPR or any
  other ruleset.
- **A `0` is not always a bye.** ESPN can return a live projection for a D/ST on
  bye, and an off-bye `0` is ESPN projecting nothing (injury, depth chart). Use the
  `Bye` column, never `value == 0`. `data.load` force-zeroes bye weeks as a safety
  net; it is currently a no-op on this export.
- **Projections drift.** ESPN regenerates them weekly; anything past the current
  week is a season-long baseline.
- Team names contain apostrophes and emoji (`Can't Ceedee Ball`, `Miami Venom🏆🏆`).
  Quote and escape them; never use them unslugged as filenames or identifiers.

## Open assumptions

Both live in `league_config.json` and are flagged in the report's own header:

- `playoff_weeks` is assumed `[15, 16, 17]` — not present in the ESPN export.
  `espn_pull.py` reads the real value from league settings.
- `weekly_score_sigma` is 25.0 — the assumed spread of a real weekly score around
  its projection. It scales every expected-win number; nothing in the export
  measures it.
- `regular_season_weeks` / `schedule` are null. ESPN's export carries no matchups,
  so wins are all-play. `espn_pull.py` can reach the real schedule via `mSchedule`.
- `enforce_position_limits` is off. All ten teams hold exactly
  2/4/4/2/2/2 by position, which may be an enforced rule or just a draft artifact.
  The owner's own trade example was RB-for-WR, implying cross-position trades are
  legal, so this stays off until contradicted.

## Data source

    lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/153385
      ?view=mRoster&view=mTeam&scoringPeriodId=<week>

One request per week. **The league is private** — unauthenticated requests return
`401 AUTH_LEAGUE_NOT_VISIBLE`. `espn_pull.py` reads `SWID`/`espn_s2` cookies from
the environment or `.espn_cookies`.
