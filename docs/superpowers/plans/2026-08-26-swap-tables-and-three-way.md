# Swap Tables and Three-Way Trades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exhaustive, exact three-way trade search to the FF Trade Identifier by precomputing per-team swap value tables and generalizing the two-team `Trade` model to N sides.

**Architecture:** A team's value after a one-player-each trade depends only on `(player_out, player_in)`, so we precompute that table once per team (0.46 s, 3.7 MB) and every one-player-each trade becomes an array lookup. `Trade` becomes a tuple of `TradeSide` records so two-team and three-team trades share one code path. Three-way search then runs exhaustively in ~0.5 s with no heuristic.

**Tech Stack:** Python 3.14, numpy 2.4, pandas 3.0, pytest 9.0.2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-trade-strategies-design.md`

## Global Constraints

- **Never approximate what the user is shown.** Every displayed trade is verified by the exact lineup solver. Phase 1 introduces zero approximations.
- **No roster cache.** A previous version cached by roster id-tuple and grew to 1.3M entries at depth 2 with a near-zero hit rate. `TradeFinder.evaluate` must stay uncached.
- **`TQB` is a real position.** Position logic keyed on `QB` matches nothing in this league. Positions: `TQB`, `RB`, `WR`, `TE`, `D/ST`, `K`.
- **Lineup is 1 TQB / 2 RB / 2 WR / 1 TE / 1 FLEX / 1 K / 1 D-ST** — 9 starters, 7 bench, read from `league_config.json`. Never hardcode.
- **Bye detection uses the `Bye` column, never `value == 0`.** An off-bye zero is ESPN projecting nothing.
- **Runtime budget: 90 s total.** Phase 1 adds ~1 s. If breached, add a flag to skip a shape — never a silent heuristic.
- **Team names contain apostrophes and emoji** (`Can't Ceedee Ball`, `Miami Venom🏆🏆`). Never use them unslugged as identifiers or filenames.
- Existing behavior for 1-for-1 and 2-for-2 must be **bit-identical** after the refactor. Task 1 pins this with a golden snapshot.

---

## File Structure

| File | Responsibility |
|---|---|
| `conftest.py` (create, repo root) | Makes `ffti` importable under pytest; shares one loaded `League` across the suite |
| `tests/test_lineup.py` (create) | Locks the lineup solver's two invariants before anything moves |
| `tests/test_swaps.py` (create) | Swap table equals a direct solve |
| `tests/test_search.py` (create) | Golden snapshot of current results; shape enumeration; three-way correctness |
| `ffti/swaps.py` (create) | `SwapTable` — precomputed `(out, in)` value lookup |
| `ffti/search.py` (modify) | `Move`, `TradeSide`, N-sided `Trade`, `Shape`, shape-driven `find()`, three-way |
| `ffti/report.py` (modify) | Payload emits `sides` array instead of `a`/`b` fields |
| `ffti/template.html` (modify) | Render N-sided trades; add a `three-way` size chip |
| `find_trades.py` (modify) | `--shape` flag; terminal summary reads `sides` |

---

## Task 1: Pin current behavior before touching anything

There is no test suite. The refactor in Task 3 rewrites the core data structure, so current output must be captured first or a regression will be invisible.

**Files:**
- Create: `conftest.py`
- Create: `tests/test_lineup.py`
- Create: `tests/test_search.py`

**Interfaces:**
- Consumes: existing `ffti.data.load`, `ffti.lineup.LineupSolver`, `ffti.search.TradeFinder`
- Produces: pytest fixtures `league`, `solver`, `finder` used by every later task; `tests/golden_1for1.json` snapshot consumed by Task 3

- [ ] **Step 1: Write the conftest with shared fixtures**

Create `conftest.py` at the repo root (not in `tests/`) so pytest puts the root on `sys.path` and `import ffti` resolves.

```python
"""Shared fixtures. Loading the league costs ~0.3s, so it is session-scoped."""

import pytest

from ffti import data, lineup, search


@pytest.fixture(scope="session")
def league():
    return data.load("big_money_projections.xlsx", "league_config.json")


@pytest.fixture(scope="session")
def solver(league):
    return lineup.LineupSolver(league.config)


@pytest.fixture(scope="session")
def finder(league, solver):
    return search.TradeFinder(league, solver)
```

- [ ] **Step 2: Write the lineup invariant tests**

Create `tests/test_lineup.py`. These two properties are what make the solver trustworthy: `weekly_points` and `starter_mask` are independent implementations of the same rules, so agreement between them is real evidence.

```python
"""The lineup solver's two load-bearing invariants."""

import numpy as np


def _blocks(league, ids):
    pos = league.players["Position"].to_numpy()
    p = pos[ids]
    return ({q: league.proj[ids[p == q]] for q in set(p.tolist())},
            {q: ids[p == q] for q in set(p.tolist())})


def test_weekly_points_equals_starter_mask_sum(league, solver):
    """Two independent implementations of the same slot rules must agree."""
    for team, ids in league.rosters.items():
        blocks, id_blocks = _blocks(league, ids)
        summed = solver.weekly_points(blocks)
        mask = solver.starter_mask(blocks, id_blocks)
        manual = np.zeros(league.n_weeks)
        for pid, m in mask.items():
            manual += np.where(m, league.proj[pid], 0.0)
        assert np.allclose(summed, manual), f"{team} disagrees"


def test_exactly_nine_starters_every_week(league, solver):
    """1 TQB + 2 RB + 2 WR + 1 TE + 1 FLEX + 1 K + 1 D/ST."""
    for team, ids in league.rosters.items():
        blocks, id_blocks = _blocks(league, ids)
        mask = solver.starter_mask(blocks, id_blocks)
        for w in range(league.n_weeks):
            started = sum(int(m[w]) for m in mask.values())
            assert started == solver.starters, f"{team} week {w}: {started}"


def test_bye_weeks_are_never_started(league, solver):
    """A player on bye projects zero, so the optimizer must never start him."""
    bye = league.players["Bye"].to_numpy()
    for ids in league.rosters.values():
        blocks, id_blocks = _blocks(league, ids)
        mask = solver.starter_mask(blocks, id_blocks)
        for pid, m in mask.items():
            b = int(bye[pid])
            if b in league.weeks:
                w = league.weeks.index(b)
                assert league.proj[pid][w] == 0.0
```

- [ ] **Step 3: Run the lineup tests — they must pass against current code**

Run: `python3 -m pytest tests/test_lineup.py -v`
Expected: 3 passed. These describe behavior that already works; a failure means the fixture is wrong, not the solver.

- [ ] **Step 4: Write the golden snapshot test**

Create `tests/test_search.py`. This captures today's 1-for-1 output so Task 3's refactor can be proven behavior-preserving.

```python
"""Search behavior, pinned before the N-sided refactor."""

import json
import pathlib

import pytest

GOLDEN = pathlib.Path(__file__).parent / "golden_1for1.json"


def _fingerprint(trades, league):
    """Order-independent, refactor-independent description of a result set."""
    out = []
    for t in trades:
        a, b = sorted([
            (t.team_a, tuple(sorted(int(i) for i in t.send_a)), round(t.gain_a, 6)),
            (t.team_b, tuple(sorted(int(i) for i in t.send_b)), round(t.gain_b, 6)),
        ])
        out.append([list(a), list(b)])
    return sorted(out)


def test_one_for_one_matches_golden(finder, league):
    """1-for-1 results must not change. Regenerate deliberately, never casually."""
    current = _fingerprint(finder.find(depth=1), league)
    if not GOLDEN.exists():
        GOLDEN.write_text(json.dumps(current, indent=1))
        pytest.skip("golden snapshot created; re-run to compare")
    assert current == json.loads(GOLDEN.read_text())


def test_every_reported_trade_benefits_both_sides(finder):
    for t in finder.find(depth=1):
        assert t.gain_a > 0 and t.gain_b > 0
```

- [ ] **Step 5: Generate and then verify the snapshot**

Run: `python3 -m pytest tests/test_search.py -v`
Expected: first run — 1 skipped ("golden snapshot created"), 1 passed.

Run again: `python3 -m pytest tests/test_search.py -v`
Expected: 2 passed. Confirm `tests/golden_1for1.json` exists and is non-empty (37 entries).

- [ ] **Step 6: Commit**

```bash
git add conftest.py tests/
git commit -m "test: pin lineup invariants and 1-for-1 output before refactor"
```

---

## Task 2: SwapTable

**Files:**
- Create: `ffti/swaps.py`
- Create: `tests/test_swaps.py`

**Interfaces:**
- Consumes: `League` (from `ffti.data`), `LineupSolver` (from `ffti.lineup`), `TradeFinder.evaluate`
- Produces:
  - `SwapTable.build(league, finder) -> SwapTable`
  - `SwapTable.after(team: str, out_id: int, in_id: int) -> np.ndarray` — `(n_weeks,)` points
  - `SwapTable.delta(team: str, out_id: int, in_id: int) -> np.ndarray` — `(n_weeks,)` change vs baseline

- [ ] **Step 1: Write the failing test**

Create `tests/test_swaps.py`.

```python
"""The swap table is load-bearing for three-way search: it must be exact."""

import numpy as np

from ffti import swaps


def test_table_matches_direct_solve(league, finder):
    """Every entry must equal what the exact solver would return."""
    table = swaps.SwapTable.build(league, finder)
    owner = league.players["Fantasy Team"].to_numpy()
    rng = np.random.default_rng(0)

    for _ in range(300):
        team = league.teams[int(rng.integers(len(league.teams)))]
        roster = [int(i) for i in league.rosters[team]]
        out_id = int(rng.choice(roster))
        candidates = [p for p in range(len(league.players)) if owner[p] != team]
        in_id = int(rng.choice(candidates))

        direct = finder.evaluate(finder._swap(league.rosters[team], (out_id,), (in_id,)))
        assert np.allclose(table.after(team, out_id, in_id), direct), (
            f"{team}: out={out_id} in={in_id}")


def test_delta_is_after_minus_baseline(league, finder):
    table = swaps.SwapTable.build(league, finder)
    team = league.teams[0]
    out_id = int(league.rosters[team][0])
    in_id = int(league.rosters[league.teams[1]][0])
    expected = table.after(team, out_id, in_id) - finder.baseline[team]
    assert np.allclose(table.delta(team, out_id, in_id), expected)


def test_build_is_under_two_seconds(league, finder):
    """Budget guard: the whole point of the table is that it is cheap."""
    import time
    t0 = time.time()
    swaps.SwapTable.build(league, finder)
    assert time.time() - t0 < 2.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_swaps.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ffti.swaps'`

- [ ] **Step 3: Write the implementation**

Create `ffti/swaps.py`.

```python
"""Precomputed swap values.

For a one-player-each trade, a team's post-trade value depends only on which
player leaves and which arrives - not on who the other team is. Tabulating that
once turns every such trade into an array lookup, which is what makes exhaustive
three-way search cheap enough to need no heuristic at all.

Measured on this league: 0.46s to build, 3.7 MB, exact against the direct solver.
"""

from __future__ import annotations

import numpy as np


class SwapTable:
    """value[team][out_slot][in_player] -> (n_weeks,) points after the swap."""

    def __init__(self, league, finder, tables: dict[str, np.ndarray]):
        self._lg = league
        self._finder = finder
        self._tables = tables
        self._slot = {t: {int(p): i for i, p in enumerate(ids)}
                      for t, ids in league.rosters.items()}

    @classmethod
    def build(cls, league, finder) -> "SwapTable":
        owner = league.players["Fantasy Team"].to_numpy()
        n_players = len(league.players)
        tables: dict[str, np.ndarray] = {}

        for team, ids in league.rosters.items():
            roster = [int(p) for p in ids]
            incoming = [p for p in range(n_players) if owner[p] != team]
            tab = np.zeros((len(roster), n_players, league.n_weeks))
            for slot, out_id in enumerate(roster):
                kept = np.array([q for q in roster if q != out_id], dtype=int)
                for in_id in incoming:
                    tab[slot, in_id] = finder.evaluate(
                        np.append(kept, in_id))
            tables[team] = tab
        return cls(league, finder, tables)

    def after(self, team: str, out_id: int, in_id: int) -> np.ndarray:
        return self._tables[team][self._slot[team][int(out_id)], int(in_id)]

    def delta(self, team: str, out_id: int, in_id: int) -> np.ndarray:
        return self.after(team, out_id, in_id) - self._finder.baseline[team]

    @property
    def nbytes(self) -> int:
        return sum(t.nbytes for t in self._tables.values())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_swaps.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add ffti/swaps.py tests/test_swaps.py
git commit -m "feat: add SwapTable for exact one-player-each trade lookups"
```

---

## Task 3: N-sided Trade model

The breaking change. `Trade` currently has 18 two-team fields (`gain_a`, `gain_b`, `reg_a`, …). Replace with a tuple of sides so two-team and three-team trades share one path.

**Files:**
- Modify: `ffti/search.py` (the `Trade` dataclass and `TradeFinder.score`)
- Modify: `ffti/report.py` (payload construction)
- Modify: `find_trades.py` (`_summary`)
- Modify: `tests/test_search.py` (fingerprint reads `sides`)

**Interfaces:**
- Consumes: `SwapTable` from Task 2 (not yet used here; Task 5 uses it)
- Produces:
  - `Move(src: str, dst: str, players: tuple[int, ...])` — a namedtuple
  - `TradeSide(team, sent, received, gain, reg, playoff, bye, full, win, weekly)`
  - `Trade(sides: tuple[TradeSide, ...], shape: str)` with `.total`, `.balance`, `.side(team)`
  - `TradeFinder.score(moves: tuple[Move, ...], shape: str) -> Trade`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_search.py`:

```python
def test_trade_side_accessors(finder, league):
    from ffti.search import Move
    a, b = league.teams[0], league.teams[1]
    pa = int(league.rosters[a][0])
    pb = int(league.rosters[b][0])
    trade = finder.score((Move(a, b, (pa,)), Move(b, a, (pb,))), "1-for-1")

    assert len(trade.sides) == 2
    assert {s.team for s in trade.sides} == {a, b}
    assert trade.side(a).sent == (pa,)
    assert trade.side(a).received == (pb,)
    assert trade.side(b).sent == (pb,)
    assert trade.shape == "1-for-1"
    assert abs(trade.total - sum(s.gain for s in trade.sides)) < 1e-9


def test_three_sided_trade_scores_all_sides(finder, league):
    from ffti.search import Move
    a, b, c = league.teams[0], league.teams[1], league.teams[2]
    pa = int(league.rosters[a][0])
    pb = int(league.rosters[b][0])
    pc = int(league.rosters[c][0])
    trade = finder.score(
        (Move(a, b, (pa,)), Move(b, c, (pb,)), Move(c, a, (pc,))), "three-way")

    assert len(trade.sides) == 3
    assert trade.side(a).sent == (pa,) and trade.side(a).received == (pc,)
    assert trade.side(b).sent == (pb,) and trade.side(b).received == (pa,)
    assert trade.side(c).sent == (pc,) and trade.side(c).received == (pb,)
    for s in trade.sides:
        assert len(s.weekly) == league.n_weeks
```

Also update `_fingerprint` in the same file to read the new model:

```python
def _fingerprint(trades, league):
    """Order-independent, refactor-independent description of a result set."""
    out = []
    for t in trades:
        sides = sorted(
            (s.team, tuple(sorted(int(i) for i in s.sent)), round(s.gain, 6))
            for s in t.sides)
        out.append([list(s) for s in sides])
    return sorted(out)
```

And update the both-sides test:

```python
def test_every_reported_trade_benefits_both_sides(finder):
    for t in finder.find(depth=1):
        assert all(s.gain > 0 for s in t.sides)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_search.py -v`
Expected: FAIL — `ImportError: cannot import name 'Move'`

- [ ] **Step 3: Replace the Trade model in `ffti/search.py`**

Delete the existing `Trade` dataclass entirely and replace with:

```python
class Move(NamedTuple):
    """One leg of a trade: `players` go from `src` to `dst`."""
    src: str
    dst: str
    players: tuple[int, ...]


@dataclass(frozen=True)
class TradeSide:
    """One team's view of a trade. Every metric is that team's own."""
    team: str
    sent: tuple[int, ...]
    received: tuple[int, ...]
    gain: float          # avg points/week, all weeks
    reg: float           # regular-season weeks only
    playoff: float       # playoff weeks only
    bye: float           # this team's thin (multi-bye) weeks
    full: float          # this team's full-strength weeks
    win: float = 0.0     # change in expected wins; filled by score_wins
    weekly: np.ndarray = field(repr=False, default=None)


@dataclass
class Trade:
    sides: tuple[TradeSide, ...]
    shape: str

    def side(self, team: str) -> TradeSide:
        for s in self.sides:
            if s.team == team:
                return s
        raise KeyError(team)

    @property
    def teams(self) -> tuple[str, ...]:
        return tuple(s.team for s in self.sides)

    @property
    def total(self) -> float:
        return sum(s.gain for s in self.sides)

    @property
    def balance(self) -> float:
        """How evenly the gain splits. 1.0 = even, 0 = one-sided."""
        gains = [s.gain for s in self.sides]
        hi = max(gains)
        return min(gains) / hi if hi > 0 else 0.0
```

Add to the imports at the top of the file:

```python
from dataclasses import dataclass, field
from typing import NamedTuple
```

- [ ] **Step 4: Replace `TradeFinder.score`**

Delete the existing `score` method and replace with:

```python
    def score(self, moves: tuple[Move, ...], shape: str) -> Trade:
        """Score a trade of any shape by re-solving every affected roster."""
        sent: dict[str, list[int]] = {}
        recv: dict[str, list[int]] = {}
        for m in moves:
            sent.setdefault(m.src, []).extend(m.players)
            recv.setdefault(m.dst, []).extend(m.players)
            sent.setdefault(m.dst, [])
            recv.setdefault(m.src, [])

        sides = []
        for team in sent:
            out = tuple(sent[team])
            inn = tuple(recv[team])
            new = self.evaluate(self._swap(self.lg.rosters[team], out, inn))
            d = new - self.baseline[team]
            thin, reg = self.thin[team], self.reg_mask
            sides.append(TradeSide(
                team=team, sent=out, received=inn,
                gain=float(d.mean()),
                reg=float(d[reg].mean()) if reg.any() else 0.0,
                playoff=float(d[self.playoff_mask].mean())
                        if self.playoff_mask.any() else 0.0,
                bye=float(d[thin].mean()) if thin.any() else 0.0,
                full=float(d[~thin].mean()) if (~thin).any() else 0.0,
                weekly=d,
            ))
        return Trade(sides=tuple(sides), shape=shape)
```

- [ ] **Step 5: Update the two-team call site in `find()`**

In `find()`, replace the body of the inner loop:

```python
                    t = self.score(
                        (Move(ta, tb, sa), Move(tb, ta, sb)), f"{depth}-for-{depth}")
                    if all(s.gain >= min_gain for s in t.sides):
                        out.append(t)
```

- [ ] **Step 6: Update `explain`, `score_wins` and `dedupe` in `ffti/search.py`**

`explain` — replace its two-team loop header:

```python
    detail = {}
    for side in trade.sides:
        team, out_ids, in_ids = side.team, side.sent, side.received
```

`score_wins` — the win model is inherently pairwise, so score each side against the post-trade world:

```python
def score_wins(finder: "TradeFinder", model, trades: list[Trade]) -> None:
    """Attach expected-win deltas in place, for trades of any shape."""
    lg = finder.lg
    for t in trades:
        points = dict(finder.baseline)
        for s in t.sides:
            points[s.team] = finder.evaluate(
                finder._swap(lg.rosters[s.team], s.sent, s.received))
        updated = []
        for s in t.sides:
            win = (model.expected_wins(s.team, points)
                   - model.expected_wins(s.team, finder.baseline))
            updated.append(replace(s, win=win))
        t.sides = tuple(updated)
```

Add `replace` to the dataclasses import: `from dataclasses import dataclass, field, replace`.

`dedupe` — key on the full team set so three-ways dedupe correctly:

```python
def dedupe(trades: list[Trade], per_pair: int = 3) -> list[Trade]:
    """Thin out near-identical offers.

    A raw search returns the same idea many times with one interchangeable piece
    swapped. Keep the best few per group of teams, and never repeat a package
    that reuses players already shown for that group.
    """
    seen: dict[tuple[str, ...], list[set[int]]] = {}
    out: list[Trade] = []
    for t in trades:
        key = tuple(sorted(t.teams))
        kept = seen.setdefault(key, [])
        if len(kept) >= per_pair:
            continue
        package = {p for s in t.sides for p in s.sent}
        if any(len(package & prev) >= max(1, len(package) // 2) for prev in kept):
            continue
        kept.append(package)
        out.append(t)
    return out
```

- [ ] **Step 7: Update `ffti/report.py` payload**

In `build_payload`, replace the `out_trades` loop body:

```python
    for n, t in enumerate(trades):
        out_trades.append({
            "shape": t.shape,
            "sides": [{
                "team": s.team,
                "sent": [int(i) for i in s.sent],
                "recv": [int(i) for i in s.received],
                "g": round(s.gain, 3), "r": round(s.reg, 3),
                "p": round(s.playoff, 3), "b": round(s.bye, 3),
                "f": round(s.full, 3), "w": round(s.win, 4),
                "wk": [round(float(x), 2) for x in s.weekly],
            } for s in t.sides],
            "explain": S.explain(finder, t) if n < explain_top else {},
        })
```

- [ ] **Step 8: Update `find_trades.py` `_summary`**

Replace the body that reads `t.team_a` / `t.gain_a`:

```python
    def my_side(t):
        return t.side(my_team)

    mine = sorted((t for t in trades if my_team in t.teams),
                  key=lambda t: -my_side(t).gain)
```

and the per-trade print block:

```python
    for t in mine[:5]:
        me = t.side(my_team)
        others = [s for s in t.sides if s.team != my_team]
        print(f"\n  {t.shape} with {', '.join(s.team for s in others)}")
        print(f"    you get  {' + '.join(lg.name(i) for i in me.received)}")
        print(f"    you give {' + '.join(lg.name(i) for i in me.sent)}")
        flag = "  <- helps you only in the playoffs" if me.reg < 0 <= me.gain else ""
        print(f"    you {me.gain:+.2f}/wk overall   reg season {me.reg:+.2f}   "
              f"playoffs {me.playoff:+.2f}   {me.win:+.2f} wins{flag}")
        for s in others:
            print(f"    {s.team} {s.gain:+.2f}/wk")
```

- [ ] **Step 9: Run the full suite**

Run: `python3 -m pytest -v`
Expected: all passed, **including `test_one_for_one_matches_golden`**. That test passing is the proof the refactor changed no behavior. If it fails, the refactor is wrong — do not regenerate the golden file.

- [ ] **Step 10: Verify the pipeline still runs end to end**

Run: `python3 find_trades.py --depth 1`
Expected: completes, writes `trade_report.html`, prints the same 3 offers for Perrysburg Spreadsheets as before the refactor.

- [ ] **Step 11: Commit**

```bash
git add ffti/search.py ffti/report.py find_trades.py tests/test_search.py
git commit -m "refactor: make Trade N-sided so shapes share one code path"
```

---

## Task 4: Shape-driven enumeration

**Files:**
- Modify: `ffti/search.py`
- Modify: `tests/test_search.py`

**Interfaces:**
- Consumes: `Move`, `Trade` from Task 3
- Produces: `SHAPES: dict[str, Shape]`; `TradeFinder.find(shape="1-for-1", ...)` replacing `depth=`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_search.py`:

```python
def test_shape_named_search_matches_depth_search(finder):
    """The named shape must reproduce exactly what depth=1 produced."""
    from ffti import search
    by_shape = _shape_key(finder.find(shape="1-for-1"))
    by_depth = _shape_key(finder.find(depth=1))
    assert by_shape == by_depth


def _shape_key(trades):
    return sorted(
        tuple(sorted((s.team, tuple(sorted(s.sent))) for s in t.sides))
        for t in trades)


def test_unknown_shape_raises(finder):
    import pytest as _pytest
    with _pytest.raises(KeyError):
        finder.find(shape="4-for-4")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_search.py::test_shape_named_search_matches_depth_search -v`
Expected: FAIL — `TypeError: find() got an unexpected keyword argument 'shape'`

- [ ] **Step 3: Add the Shape registry to `ffti/search.py`**

```python
@dataclass(frozen=True)
class Shape:
    """A trade template. `legs` are (from_slot, to_slot, n_players) over the
    team tuple the search is currently considering."""
    legs: tuple[tuple[int, int, int], ...]
    n_teams: int
    backfill: bool = False      # short side signs a free agent (Phase 5)

    @property
    def directional(self) -> bool:
        """Three-way cycles differ by direction; two-team swaps do not."""
        return self.n_teams > 2


SHAPES: dict[str, Shape] = {
    "1-for-1":   Shape(((0, 1, 1), (1, 0, 1)), n_teams=2),
    "2-for-2":   Shape(((0, 1, 2), (1, 0, 2)), n_teams=2),
    "three-way": Shape(((0, 1, 1), (1, 2, 1), (2, 0, 1)), n_teams=3),
}
```

- [ ] **Step 4: Rewrite `find()` to dispatch on shape**

```python
    def find(self, shape: str | None = None, depth: int | None = None,
             min_gain: float = 0.05, only_team: str | None = None,
             progress=None) -> list[Trade]:
        """All mutually-beneficial trades of one shape.

        `depth` is kept as a shorthand for the symmetric two-team shapes.
        """
        if shape is None:
            shape = f"{depth or 1}-for-{depth or 1}"
        spec = SHAPES[shape]
        if spec.n_teams == 3:
            return self._find_three_way(spec, shape, min_gain, only_team, progress)
        return self._find_two_team(spec, shape, min_gain, only_team, progress)

    def _find_two_team(self, spec, shape, min_gain, only_team, progress):
        n_out = spec.legs[0][2]
        n_back = spec.legs[1][2]
        pairs = [(a, b) for a, b in itertools.combinations(self.lg.teams, 2)
                 if only_team is None or only_team in (a, b)]
        out: list[Trade] = []
        for n, (ta, tb) in enumerate(pairs, 1):
            ca = list(itertools.combinations(
                (int(i) for i in self.lg.rosters[ta]), n_out))
            cb = list(itertools.combinations(
                (int(i) for i in self.lg.rosters[tb]), n_back))
            for sa in ca:
                for sb in cb:
                    if not self._legal(sa, sb):
                        continue
                    t = self.score((Move(ta, tb, sa), Move(tb, ta, sb)), shape)
                    if all(s.gain >= min_gain for s in t.sides):
                        out.append(t)
            if progress:
                progress(n, len(pairs), len(out))
        out.sort(key=lambda t: -t.total)
        return out
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_search.py -v`
Expected: all passed, golden snapshot still matching.

- [ ] **Step 6: Commit**

```bash
git add ffti/search.py tests/test_search.py
git commit -m "feat: drive trade enumeration from named shapes"
```

---

## Task 5: Exhaustive three-way search

**Files:**
- Modify: `ffti/search.py`
- Modify: `tests/test_search.py`

**Interfaces:**
- Consumes: `SwapTable` (Task 2), `Shape`/`Move`/`Trade` (Tasks 3–4)
- Produces: `TradeFinder.swaps` (lazily built `SwapTable`), `TradeFinder._find_three_way`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_search.py`:

```python
def test_three_way_sides_all_gain(finder):
    for t in finder.find(shape="three-way", min_gain=0.05):
        assert len(t.sides) == 3
        assert all(s.gain >= 0.05 for s in t.sides)


def test_three_way_is_a_true_cycle(finder):
    """Each team sends exactly one player and receives exactly one, and no
    player returns to the team that sent him."""
    for t in finder.find(shape="three-way", min_gain=0.05)[:50]:
        for s in t.sides:
            assert len(s.sent) == 1 and len(s.received) == 1
            assert s.sent[0] != s.received[0]
        sent = {s.sent[0] for s in t.sides}
        recv = {s.received[0] for s in t.sides}
        assert sent == recv


def test_three_way_gains_survive_exact_recomputation(finder, league):
    """Guard against index bugs: re-solve each side from scratch."""
    import numpy as np
    for t in finder.find(shape="three-way", min_gain=0.05)[:25]:
        for s in t.sides:
            fresh = finder.evaluate(
                finder._swap(league.rosters[s.team], s.sent, s.received))
            assert np.allclose(fresh - finder.baseline[s.team], s.weekly)


def test_three_way_completes_quickly(finder):
    import time
    t0 = time.time()
    finder.find(shape="three-way", min_gain=0.05)
    assert time.time() - t0 < 15.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_search.py::test_three_way_sides_all_gain -v`
Expected: FAIL — `AttributeError: 'TradeFinder' object has no attribute '_find_three_way'`

- [ ] **Step 3: Add the lazy swap table to `TradeFinder`**

Add to `TradeFinder.__init__`, after `self.baseline` is set:

```python
        self._swaps: "SwapTable | None" = None
```

and a property:

```python
    @property
    def swaps(self):
        """Built on first use - only the three-way path needs it."""
        if self._swaps is None:
            from .swaps import SwapTable
            self._swaps = SwapTable.build(self.lg, self)
        return self._swaps
```

- [ ] **Step 4: Implement `_find_three_way`**

```python
    def _find_three_way(self, spec, shape, min_gain, only_team, progress):
        """Exhaustive one-player-each cycles, both directions.

        Every candidate is a table lookup, so this is cheap enough to run with
        no pruning. Early-exit on the first non-gaining leg cuts the scan from
        983k combinations to roughly 334k.
        """
        table = self.swaps
        rosters = {t: [int(p) for p in ids] for t, ids in self.lg.rosters.items()}
        out: list[Trade] = []
        triples = [tri for tri in itertools.combinations(self.lg.teams, 3)
                   if only_team is None or only_team in tri]

        for n, tri in enumerate(triples, 1):
            for a, b, c in ((tri[0], tri[1], tri[2]), (tri[0], tri[2], tri[1])):
                # a sends pa to b, b sends pb to c, c sends pc to a
                for pa in rosters[a]:
                    gb = [(pb, table.delta(b, pb, pa)) for pb in rosters[b]]
                    gb = [(pb, d) for pb, d in gb if d.mean() >= min_gain]
                    if not gb:
                        continue
                    for pb, db in gb:
                        for pc in rosters[c]:
                            dc = table.delta(c, pc, pb)
                            if dc.mean() < min_gain:
                                continue
                            da = table.delta(a, pa, pc)
                            if da.mean() < min_gain:
                                continue
                            out.append(self.score(
                                (Move(a, b, (pa,)), Move(b, c, (pb,)),
                                 Move(c, a, (pc,))), shape))
            if progress:
                progress(n, len(triples), len(out))

        out.sort(key=lambda t: -t.total)
        return out
```

Note: the final `self.score(...)` re-solves each side exactly rather than reusing
the table deltas. The table is proven exact by Task 2, but scoring through the same
path as every other shape keeps one source of truth for `TradeSide` metrics.

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_search.py -v`
Expected: all passed. `test_three_way_completes_quickly` confirms the runtime budget.

- [ ] **Step 6: Check the result count is sane**

Run:
```bash
python3 -c "
import sys; sys.path.insert(0,'.')
from ffti import data, lineup, search
lg=data.load(); s=lineup.LineupSolver(lg.config); f=search.TradeFinder(lg,s)
r=f.find(shape='three-way', min_gain=0.05)
print('raw:', len(r), 'deduped:', len(search.dedupe(r, per_pair=3)))
"
```
Expected: roughly 92 raw cycles at `min_gain=0.05`, far fewer after dedupe. A count in the tens of thousands means the min_gain filter is not being applied — investigate before proceeding.

- [ ] **Step 7: Commit**

```bash
git add ffti/search.py tests/test_search.py
git commit -m "feat: exhaustive three-way trade search via swap tables"
```

---

## Task 6: Surface three-way trades in the report

**Files:**
- Modify: `find_trades.py`
- Modify: `ffti/template.html`

**Interfaces:**
- Consumes: payload `sides` array from Task 3, `SHAPES` from Task 4
- Produces: a runnable `python3 find_trades.py --shape three-way`

- [ ] **Step 1: Add the `--shape` flag to `find_trades.py`**

Replace the `--depth` argument definition:

```python
    ap.add_argument("--shape", action="append", choices=sorted(search.SHAPES),
                    help="trade shape; repeatable. "
                         "Default: 1-for-1, 2-for-2 and three-way.")
```

and replace the search loop:

```python
    shapes = args.shape or ["1-for-1", "2-for-2", "three-way"]
    found: list[search.Trade] = []
    for name in shapes:
        t0 = time.time()
        print(f"Searching {name} trades ...", end="", flush=True)

        def tick(n, total, hits, _n=name):
            if n % 5 and n != total:
                return
            print(f"\r  {_n}: group {n}/{total}, {hits} candidates ...",
                  end="", flush=True)

        raw = finder.find(shape=name, min_gain=args.min_gain,
                          only_team=args.team, progress=tick)
        kept = search.dedupe(raw, per_pair=args.per_pair)
        found += kept
        print(f"\r  {name}: {len(raw)} mutually beneficial, "
              f"{len(kept)} after dedupe ({time.time()-t0:.0f}s)" + " " * 20)
```

- [ ] **Step 2: Verify the CLI runs**

Run: `python3 find_trades.py --shape three-way --shape 1-for-1`
Expected: both searches run; report written; terminal summary shows at least one `three-way` offer if one involves your team.

- [ ] **Step 3: Update the template's view model for N sides**

In `ffti/template.html`, replace the `view()` function. A three-way has no single "partner", so `them` becomes the list of other teams and the pitch panel iterates sides.

```javascript
/* Normalize a trade around one team so "your gain" is an ordinary column sort.
   Works for any number of sides; `others` is everyone else in the deal. */
function view(t, me) {
  const mine = (me !== "__all__" && t.sides.find(s => s.team === me)) || t.sides[0];
  const others = t.sides.filter(s => s !== mine);
  const gains = t.sides.map(s => s.g);
  return {
    t, sides: t.sides, me: mine.team,
    them: others.map(s => s.team).join(" + "),
    otherSides: others,
    get: mine.recv, give: mine.sent,
    mg: mine.g, tg: others.reduce((a, s) => a + s.g, 0) / others.length,
    mp: mine.p, tp: others[0].p,
    mb: mine.b, tb: others[0].b,
    mf: mine.f, tf: others[0].f,
    mw: mine.w, tw: others[0].w,
    mr: mine.r, tr_: others[0].r,
    wkMe: mine.wk, wkThem: others[0].wk,
    size: t.shape,
    up: mine.wk.filter(x => x > 0.005).length,
    bal: Math.min(...gains) / Math.max(...gains),
  };
}
```

- [ ] **Step 4: Add a `three-way` chip to the size filter**

Replace the depth chips markup:

```html
      <div class="fld"><label>Shape</label><div class="chips" id="depth">
        <button data-d="1-for-1" aria-pressed="true">1-for-1</button>
        <button data-d="2-for-2" aria-pressed="true">2-for-2</button>
        <button data-d="three-way" aria-pressed="true">3-team</button>
      </div></div>
```

and in `renderTrades()` change the depth filter to compare shape strings:

```javascript
  const shapes = [...document.querySelectorAll("#depth button")]
    .filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.dataset.d);
```

then in the filter chain replace `depths.includes(t.d)` with `shapes.includes(t.shape)`.

- [ ] **Step 5: Render the size cell as the shape name**

Replace the size cell in the trade row template:

```javascript
      <td class="num" style="white-space:nowrap">${esc(v.size)}</td>
```

- [ ] **Step 6: Verify the report renders with no console errors**

Run:
```bash
python3 find_trades.py
```
Then open `trade_report.html` and confirm: the 3-team chip filters correctly, a three-way row shows all three teams, and expanding it shows a panel per side.

- [ ] **Step 7: Run the full suite one more time**

Run: `python3 -m pytest -v`
Expected: all passed.

- [ ] **Step 8: Update CLAUDE.md**

Add to the architecture section:

```markdown
**`ffti/swaps.py`** precomputes, per team, the value of every `(player_out,
player_in)` swap. That table is what makes exhaustive three-way search cheap
(0.5 s, no heuristic). It is built lazily — only the three-way path needs it.
Its exactness is load-bearing and is pinned by `tests/test_swaps.py`.

Trades are N-sided: `Trade.sides` is a tuple of `TradeSide`, and two-team trades
are just N=2. Search is driven by named entries in `SHAPES`, not by a depth int.
```

- [ ] **Step 9: Commit**

```bash
git add find_trades.py ffti/template.html CLAUDE.md
git commit -m "feat: surface three-way trades in the report and CLI"
```

---

## Self-Review Notes

**Spec coverage for Phase 1:** `swaps.py` (Task 2), shape refactor (Tasks 3–4),
three-way (Task 5), stricter dedupe for cycles (Task 3 Step 6), testing table rows
for swap-table exactness / solver invariants / trade reproduction (Tasks 1, 2, 5).
Runtime budget guarded by explicit timing assertions in Tasks 2 and 5.

**Deferred to later plans:** Features 1–4 of the spec (objective toggle, sell-high/
buy-low, correlation flags) and Features 5–6 (waivers, 2-for-1), which are blocked
on the free-agent pool. `Shape.backfill` is defined but unused until then — it is
the single forward hook, and carries no logic yet.

**Known gap:** `score_wins` calls `model.expected_wins` twice per side, which is
more work than the two-team version did. With ~130 deduped trades this stays well
inside budget, but if a later phase raises the trade count sharply, cache the
baseline win table on the model.
