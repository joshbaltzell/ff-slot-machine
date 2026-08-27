# Trade strategies: three-way, consolidation, waivers, objectives

**Date:** 2026-08-26
**Status:** Draft for review
**Scope:** Six features on top of the existing FF Trade Identifier — playoff/objective
targeting, 2-for-1 consolidation, correlation flags, sell-high/buy-low, waiver-pool
integration, and three-way trades.

## The finding that shaped this design

The plan originally called for a marginal-value heuristic to make three-way trades
tractable. Two spikes killed that idea and replaced it with something better.

**Summed marginal values are not usable for scoring packages.** Measured across 4,000
random trades against the exact solver:

| Package shape | Estimates off by >0.5 pts/wk | Worst error |
|---|---|---|
| 1-for-1 | 14% | −4.52 |
| 2-for-2 | 52% | +18.62 |
| Same-position swaps | 62% | −4.52 |

The lineup value function is submodular, so adding players has diminishing returns
while removing them has compounding losses. Errors run in *both* directions, which
rules out using the estimate even as a safe upper bound.

**Shortlisting by marginal value loses real trades.** Keeping the top 4 candidates per
team captured only 57% of known-good 1-for-1 trades; top 8 reached 76%; full recall
required K=16, which is the entire roster.

**The right answer is to make exhaustive search cheap instead.** For a one-player-each
trade, a team's post-trade value depends only on `(player_out, player_in)`. Precompute
that table once — 16 × 144 entries per team — and every trade becomes an array lookup:

| Measurement | Result |
|---|---|
| Swap table build | 0.46 s |
| Table memory | 3.7 MB |
| Agreement with direct solve | 500/500 exact |
| Exhaustive three-way search | 0.5 s, 92 all-gain cycles |

Three-way search is therefore **exhaustive and exact in under a second**, with no
heuristic and no caveat. The marginal-value matrix survives only for the one job it is
actually valid for: valuing a *single* player to a *single* team, which is what
sell-high/buy-low needs.

**Design rule for this work:** approximate during search only where a spike proves the
approximation safe, and never in what the user is shown. Exactly one approximation is
planned (the free-agent shortlist in Feature 5) and it carries a spike as a
precondition. Every trade displayed is verified by the exact lineup solver.

## Architecture

Current pipeline is linear: `data.load()` → `LineupSolver` → `TradeFinder` →
`report.write()`. Four new modules slot in without disturbing that.

```
ffti/
  data.py         extend: load the free-agent pool alongside rosters
  lineup.py       unchanged
  swaps.py        NEW  precomputed (out, in) value tables
  marginal.py     NEW  single-player value matrix; sell-high/buy-low spreads
  pool.py         NEW  free agents, replacement level
  objective.py    NEW  three ranking modes; title-odds simulation
  risk.py         NEW  NFL-team stacks and shared byes
  search.py       generalize from fixed depth to trade *shapes*
  wins.py         extend: share one noise draw with objective.py
  report.py       extend payload
  template.html   objective toggle, three-way rendering, two new tabs
```

### `swaps.py` — the foundation

```python
class SwapTable:
    """value[team][out_index][in_player] -> (n_weeks,) points after the swap."""
    def build(league, solver) -> SwapTable
    def after(team, out_id, in_id) -> np.ndarray
```

Built once per run. Everything one-player-each reads from it. `search.py` keeps its
existing exact path for 2-for-2, whose in-pair space is too large to tabulate
(C(144,2) ≈ 10k per out-pair) and which already runs acceptably at 44 s.

### `search.py` — shapes instead of depth

`find()` currently hardcodes `itertools.combinations(teams, 2)` and one `depth` for
both sides. Replace with an explicit shape:

```python
@dataclass(frozen=True)
class Shape:
    legs: tuple[tuple[int, int, int], ...]   # (from_team_idx, to_team_idx, n_players)
    backfill: bool = False                   # short side signs a free agent

SHAPES = {
    "1-for-1":   Shape(((0,1,1), (1,0,1))),
    "2-for-2":   Shape(((0,1,2), (1,0,2))),
    "2-for-1":   Shape(((0,1,2), (1,0,1)), backfill=True),
    "three-way": Shape(((0,1,1), (1,2,1), (2,0,1))),
}
```

`Trade` becomes N-sided: `sides: tuple[TradeSide, ...]` where each side carries team,
sent, received, and every gain metric. This is the one breaking change — `explain`,
`score_wins`, `dedupe` and the report payload all currently assume `team_a`/`team_b`.
Migrate them together rather than adding a two-team compatibility shim; the two-team
case is just N=2.

## Feature 1 — Objective toggle and title odds

Three selectable ranking modes, defaulting to **Championship**.

| Mode | Ranks by |
|---|---|
| Championship | Δ probability of winning the league |
| Balanced | Δ points per week across all weeks (today's behaviour) |
| Seeding | Δ expected regular-season wins |

Championship needs a real model, not a weighting of weeks 15–17:

1. Draw weekly noise once — `(sims, teams, weeks)` from `Normal(0, sigma)`.
2. Team score = projection + noise.
3. Seed by regular-season total points, top *N* qualify.
4. Simulate the bracket across the playoff weeks; count titles.

**Seeding uses total points, not record, because the export has no schedule.** That is
a documented proxy, not a modelling preference. When a real schedule is supplied it
seeds by record instead.

**Common random numbers are mandatory.** The same noise draw is reused for baseline and
post-trade worlds, so the *difference* has far lower variance than either estimate.
Without this, a 0.3 pp delta would be indistinguishable from noise.

**Report the Monte Carlo standard error and never print more precision than it
supports.** A title-odds delta is only meaningful if it exceeds its own error bar; the
UI shows `—` when it does not. `sims` is a config knob (default 20,000).

## Feature 2 — Sell-high / buy-low

The one valid use of `marginal.py`. For each player *p* owned by team *X*:

- `keep(p) = M_drop(p, X)` — what X loses by giving him up
- `best(p) = max over Y ≠ X of M_add(p, Y)` — what he is worth to his best fit
- `spread(p) = best(p) − keep(p)`

Large positive spread means someone else values him far more than his owner does. Two
ranked lists:

- **Your assets** — your players with the largest spread, and which team wants them
- **Targets** — other teams' players with high `M_add` to you and low `M_drop` to their
  owner, i.e. cheap for them to give up

This is a page, not a search, and it answers "who should I be calling" directly.
Single-player marginals are exact, so no caveat applies.

## Feature 3 — Correlation flags (warning only)

No covariance is estimated and no ranking is affected — the projections carry no
covariance data, so any number attached would be invented.

Report only what is measurable:

- **Stack exposure** — rostered players sharing an NFL team (you hold Lions TQB,
  Jameson Williams and Lions D/ST)
- **Shared bye** — the concrete, certain cost of a stack, already computed

Badge trades that increase a team's largest stack. Do not claim a direction for the
correlation: QB+WR from one team is positively correlated, offense+D/ST is not.

## Feature 4 — Waiver pool and replacement level

**Blocked on data.** Required shape, one row per free agent, matching the projections
sheet: `Player`, `Position`, `NFL Team`, `Bye`, `Wk 1`…`Wk 18`. ESPN's
`kona_player_info` view provides this. Season totals rather than weekly would degrade
bye-week and playoff-week accuracy but not break the feature.

`pool.py` computes `replacement[team][position]` — the marginal value of the best
available free agent at that position. This changes interpretation everywhere:

> A bench player's true trade cost is `M_drop(p) − replacement[pos]`, not his full
> value.

**Expect this to invalidate current suggestions.** Any trade priced on surplus depth
that is barely better than a free agent should collapse. A drop in trade count is the
tool becoming honest, not regressing. Quantify the change and report it.

**Byproduct worth shipping: free-agent upgrades.** If the best available RB beats the
WR3 currently occupying your flex, the correct move is a waiver claim, not a trade.
This falls out of the same table and may be more actionable than any trade in the list.

## Feature 5 — 2-for-1 consolidation

**Depends on Feature 4.** Confirmed league rule: roster max 16, backfill from waivers.
Both sides settle back to 16:

- Team sending 2, receiving 1: `16 − 2 + 1 = 15` → signs the best available free agent
- Team sending 1, receiving 2: `16 − 1 + 2 = 17` → drops its least valuable player

The drop cost and the backfill gain are both counted. A 2-for-1 is therefore "two
mediocre players out, one good player plus the best free agent in".

Two-stage for tractability, following the design rule:

1. Enumerate `(out_pair, in_player)` exactly — 120 × 144 per team ≈ 173k solves, ~3.3 s
2. Optimise the free-agent choice **only for candidates that already clear the
   threshold**, over the top 3 free agents per position

Stage 2 is a search-time approximation, so it must be spiked before implementation:
compare best-of-top-3 against best-of-pool on a sample. If recall is not near-total,
widen the pool or evaluate exhaustively.

## Feature 6 — Three-way trades

Exhaustive, one player from each team, both cycle directions. 0.5 s via the swap table,
no pruning, no caveat.

Ordering matters: A→B→C→A and A→C→B→A are different trades, so both are scanned.
Require every side to gain — a three-way where one team is flat is a two-way with extra
steps. Early-exit on the first non-gaining leg cuts 983k combinations to 334k scanned.

Deduping needs to be stricter than for two-way: a cycle with one interchangeable piece
generates many near-identical variants. Extend `dedupe` to key on the team *triple*
plus package overlap.

## Testing

`pytest` 9.0.2 is available; no suite exists yet. This much new arithmetic needs one.
`tests/` covering:

| Invariant | Why it matters |
|---|---|
| `SwapTable.after` == direct solve, sampled | The table is load-bearing for two features |
| `weekly_points` == `starter_mask` sum | Two independent implementations of the rules |
| Exactly 9 starters every week | Catches slot-logic regressions |
| Applying a reported trade reproduces its claimed points | End-to-end guard against index bugs |
| Expected wins sum to `n_teams × games / 2` | Caught nothing yet; would catch an all-play bug |
| ΣP(title) = 1 and P(title) ≤ P(playoffs) | Bracket logic |
| Same seed → identical simulation | Common random numbers actually shared |
| `replacement ≥ 0` | Free agents cannot have negative marginal value |
| Marginal subadditivity holds | Documents *why* marginals are not used for scoring |

## Build order

Phases 1–4 need no new data and can start immediately.

| # | Phase | Depends on | Est. runtime added |
|---|---|---|---|
| 1 | `swaps.py` + shape refactor + three-way | — | +1 s |
| 2 | Sell-high / buy-low (`marginal.py`) | — | +0.1 s |
| 3 | Objective toggle + title odds | — | +3 s |
| 4 | Correlation flags | — | negligible |
| 5 | Waiver pool, replacement level, FA upgrades | user data | +1 s |
| 6 | 2-for-1 consolidation | 5 | +5 s |

Total projected runtime ≈ 55 s, against 45 s today. Budget: **90 s**. If a phase
breaches it, the fix is a flag to skip that shape, not a silent heuristic.

## Risks

1. **Result volume.** Four shapes will flood the table. Dedupe and the default filters
   must get stricter, or the tool becomes less usable as it becomes more capable.
2. **Assumption stack on title odds.** σ = 25 (assumed), playoff format (assumed),
   points-based seeding (proxy for a schedule we lack). Three assumptions compound into
   one headline number. Surface all three next to it.
3. **`Trade` refactor is breaking.** It touches `explain`, `score_wins`, `dedupe`,
   the payload, and the template together. Do it as one phase with tests first.
4. **Waiver data may reduce output.** Expected and correct; communicate it as such.
5. **2-for-1 free-agent shortcut** is the only planned approximation. Spike it before
   relying on it.

## Explicitly out of scope

Full covariance modelling; four-way trades; multi-player three-ways; FAAB bidding
strategy; injury or snap-share modelling; in-season roster churn inside the simulation;
any UI for editing rosters.

## Open questions

1. **Playoff format** — how many of the 10 teams qualify, and is it weeks 15–17?
   Spec assumes 6 teams and 15–17. `espn_pull.py` can read this from `mSchedule`.
2. **Trade deadline** — trades after it are moot; unknown and unused today.
3. **Which managers actually trade** — not in any dataset. A per-team "responsiveness"
   weight in `league_config.json` would let ranking favour reachable deals.
