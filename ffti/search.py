"""Trade enumeration and scoring.

A trade is scored by re-solving both teams' optimal lineups for every week and
comparing to their pre-trade baseline. Only trades where *both* sides gain are
worth surfacing - a trade that helps one manager is not a trade, it is a wish.
"""

from __future__ import annotations

import itertools
from collections import Counter
from dataclasses import dataclass, field, replace
from typing import NamedTuple

import numpy as np

from .lineup import LineupSolver


class Move(NamedTuple):
    """One leg of a trade: `players` go from `src` to `dst`."""
    src: str
    dst: str
    players: tuple[int, ...]


@dataclass(frozen=True)
class TradeSide:
    """One team's view of a trade. Every metric is that team's own.

    The regular season and the playoffs are separate objectives, and a trade can
    average out positive across all weeks while making the record it takes to
    QUALIFY for those playoffs worse - so `gain`, `reg` and `playoff` are kept
    apart rather than collapsed into one number.
    """
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
    """A trade of any shape. A two-team swap is just N=2."""
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


@dataclass(frozen=True)
class Shape:
    """A trade template. `legs` are (from_slot, to_slot, n_players) over the
    team tuple the search is currently considering."""
    legs: tuple[tuple[int, int, int], ...]
    n_teams: int
    backfill: bool = False      # short side signs a free agent (Phase 5)


SHAPES: dict[str, Shape] = {
    "1-for-1":   Shape(((0, 1, 1), (1, 0, 1)), n_teams=2),
    "2-for-2":   Shape(((0, 1, 2), (1, 0, 2)), n_teams=2),
    "three-way": Shape(((0, 1, 1), (1, 2, 1), (2, 0, 1)), n_teams=3),
}


class TradeFinder:
    def __init__(self, league, solver: LineupSolver):
        self.lg = league
        self.solver = solver
        self.pos = league.players["Position"].to_numpy()
        self.positions = sorted(set(self.pos))
        wk = np.array(league.weeks)
        self.playoff_mask = np.isin(wk, league.config.get("playoff_weeks", []))

        # Bye pressure is a property of the roster, so it is computed once. A "thin"
        # week is one where enough of a roster is on bye that the manager is starting
        # players he would otherwise bench - which is exactly when someone else's
        # surplus depth is worth something to him.
        bye = league.players["Bye"].to_numpy()
        self.on_bye = bye[:, None] == wk[None, :]
        # The regular season and the playoffs are different objectives: a trade can
        # average out positive across all 18 weeks while making the record it takes to
        # QUALIFY for those playoffs worse. Keep the two separable.
        reg = league.config.get("regular_season_weeks")
        playoffs = league.config.get("playoff_weeks") or [int(wk.max()) + 1]
        self.reg_mask = np.isin(wk, reg) if reg else (wk < min(playoffs))

        thin_at = league.config.get("thin_week_byes", 2)
        self.team_byes = {t: self.on_bye[ids].sum(axis=0)
                          for t, ids in league.rosters.items()}
        self.thin = {t: c >= thin_at for t, c in self.team_byes.items()}
        self.baseline = {t: self.evaluate(ids) for t, ids in league.rosters.items()}
        self._swaps = None

    # -- scoring ---------------------------------------------------------

    def blocks(self, ids: np.ndarray) -> dict[str, np.ndarray]:
        p = self.pos[ids]
        return {q: self.lg.proj[ids[p == q]] for q in set(p.tolist())}

    def id_blocks(self, ids: np.ndarray) -> dict[str, np.ndarray]:
        p = self.pos[ids]
        return {q: ids[p == q] for q in set(p.tolist())}

    def evaluate(self, ids: np.ndarray) -> np.ndarray:
        return self.solver.weekly_points(self.blocks(np.asarray(ids)))

    def _swap(self, ids: np.ndarray, out: tuple[int, ...], inn: tuple[int, ...]) -> np.ndarray:
        kept = ids[~np.isin(ids, out)]
        return np.concatenate([kept, np.asarray(inn, dtype=ids.dtype)])

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

    # -- enumeration -----------------------------------------------------

    def _legal(self, out: tuple[int, ...], inn: tuple[int, ...]) -> bool:
        """Under enforced position limits, a trade must swap like for like."""
        if not self.lg.config.get("enforce_position_limits", False):
            return True
        return Counter(self.pos[list(out)]) == Counter(self.pos[list(inn)])

    def find(self, shape: str | None = None, depth: int | None = None,
             min_gain: float = 0.05, only_team: str | None = None,
             progress=None) -> list[Trade]:
        """All mutually-beneficial trades of one shape.

        `depth` is kept as shorthand for the symmetric two-team shapes.
        """
        if shape is None:
            shape = f"{depth or 1}-for-{depth or 1}"
        spec = SHAPES[shape]
        if spec.n_teams == 3:
            return self._find_three_way(spec, shape, min_gain, only_team, progress)
        return self._find_two_team(spec, shape, min_gain, only_team, progress)

    @property
    def swaps(self):
        """Built on first use - only the three-way path needs it."""
        if self._swaps is None:
            from .swaps import SwapTable
            self._swaps = SwapTable.build(self.lg, self)
        return self._swaps

    def _find_three_way(self, spec, shape, min_gain, only_team, progress):
        """Exhaustive one-player-each cycles, both directions.

        Every candidate is a table lookup, so this runs with no pruning at all.
        An earlier plan shortlisted candidates by marginal value; that was
        measured at 57% recall and dropped. Early-exit on the first non-gaining
        leg cuts the scan from 983k combinations to roughly 334k.
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
                    for pb, _db in gb:
                        for pc in rosters[c]:
                            if table.delta(c, pc, pb).mean() < min_gain:
                                continue
                            if table.delta(a, pa, pc).mean() < min_gain:
                                continue
                            out.append(self.score(
                                (Move(a, b, (pa,)), Move(b, c, (pb,)),
                                 Move(c, a, (pc,))), shape))
            if progress:
                progress(n, len(triples), len(out))

        out.sort(key=lambda t: -t.total)
        return out

    def _find_two_team(self, spec, shape, min_gain, only_team, progress):
        n_out, n_back = spec.legs[0][2], spec.legs[1][2]
        pairs = [(a, b) for a, b in itertools.combinations(self.lg.teams, 2)
                 if only_team is None or only_team in (a, b)]
        out: list[Trade] = []

        for n, (ta, tb) in enumerate(pairs, 1):
            combos_a = list(itertools.combinations(
                (int(i) for i in self.lg.rosters[ta]), n_out))
            combos_b = list(itertools.combinations(
                (int(i) for i in self.lg.rosters[tb]), n_back))
            for sa in combos_a:
                for sb in combos_b:
                    if not self._legal(sa, sb):
                        continue
                    t = self.score((Move(ta, tb, sa), Move(tb, ta, sb)), shape)
                    if all(x.gain >= min_gain for x in t.sides):
                        out.append(t)
            if progress:
                progress(n, len(pairs), len(out))

        out.sort(key=lambda t: -t.total)
        return out


def start_masks(league, solver: LineupSolver) -> dict[int, np.ndarray]:
    """Which weeks each player starts on the team that currently owns him.

    The per-week detail is what the report's season strips draw; start_rates is
    just its mean. This is the 'do I even play this guy' answer that motivates
    the whole tool.
    """
    pos = league.players["Position"].to_numpy()
    masks: dict[int, np.ndarray] = {}
    for _team, ids in league.rosters.items():
        p = pos[ids]
        blocks = {q: league.proj[ids[p == q]] for q in set(p.tolist())}
        idb = {q: ids[p == q] for q in set(p.tolist())}
        masks.update(solver.starter_mask(blocks, idb))
    return masks


def start_rates(league, solver: LineupSolver) -> dict[int, float]:
    """Fraction of weeks each player starts on his current team."""
    return {pid: float(m.mean()) for pid, m in start_masks(league, solver).items()}


def dedupe(trades: list[Trade], per_pair: int = 3) -> list[Trade]:
    """Thin out near-identical offers.

    A raw depth-2 search returns the same idea a dozen times over with one
    interchangeable piece swapped. Keep the best few per team pair, and never
    repeat a package that reuses players already shown for that pair.
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


def explain(finder: "TradeFinder", trade: Trade) -> dict:
    """Why a trade works: who starts more, who gets benched.

    Answers the question the raw point delta cannot - 'does the guy I am
    acquiring actually crack my lineup, and who does he push out?'
    """
    lg, solver = finder.lg, finder.solver

    def masks(ids: np.ndarray) -> dict[int, np.ndarray]:
        return solver.starter_mask(finder.blocks(ids), finder.id_blocks(ids))

    def counts(m: dict[int, np.ndarray]) -> dict[int, int]:
        return {pid: int(v.sum()) for pid, v in m.items()}

    def strip(pid: int, m: dict[int, np.ndarray]) -> list[int]:
        """Per-week: 1 starts, 0 benched, -1 on bye. Drawn as the comparison bars."""
        started = m.get(int(pid))
        return [(-1 if finder.on_bye[int(pid), w] else int(bool(started[w])))
                for w in range(lg.n_weeks)]

    detail = {}
    for _side in trade.sides:
        team, out_ids, in_ids = _side.team, _side.sent, _side.received
        m_before = masks(lg.rosters[team])
        m_after = masks(finder._swap(lg.rosters[team], out_ids, in_ids))
        before, after = counts(m_before), counts(m_after)
        moved = sorted(
            ((pid, after.get(pid, 0) - before.get(pid, 0)) for pid in after
             if pid not in in_ids and after.get(pid, 0) != before.get(pid, 0)),
            key=lambda t: t[1],
        )
        detail[team] = {
            "acquired": [{"id": int(p), "name": lg.name(p),
                          "pos": str(finder.pos[p]),
                          "starts_here": after.get(p, 0),
                          "started_there": before_elsewhere(finder, p),
                          # side-by-side: how he is used now vs how he'd be used here
                          "now": elsewhere_strip(finder, p),
                          "after": strip(p, m_after)}
                         for p in in_ids],
            "sent": [{"id": int(p), "name": lg.name(p),
                      "pos": str(finder.pos[p]),
                      "was_starting": before.get(p, 0)} for p in out_ids],
            "thin": [int(x) for x in finder.thin[team]],
            "displaced": [{"id": int(p), "name": lg.name(p), "delta": d}
                          for p, d in moved[:3] if d < 0],
            "promoted": [{"id": int(p), "name": lg.name(p), "delta": d}
                         for p, d in reversed(moved[-3:]) if d > 0],
        }
    return detail


def _owner_mask(finder: "TradeFinder", pid: int) -> np.ndarray:
    lg = finder.lg
    ids = lg.rosters[lg.players["Fantasy Team"].iat[int(pid)]]
    return finder.solver.starter_mask(finder.blocks(ids), finder.id_blocks(ids))[int(pid)]


def before_elsewhere(finder: "TradeFinder", pid: int) -> int:
    """How many weeks this player starts on the team that currently owns him."""
    return int(_owner_mask(finder, pid).sum())


def elsewhere_strip(finder: "TradeFinder", pid: int) -> list[int]:
    """Per-week usage on his current team: 1 starts, 0 benched, -1 bye."""
    m = _owner_mask(finder, pid)
    return [(-1 if finder.on_bye[int(pid), w] else int(bool(m[w])))
            for w in range(finder.lg.n_weeks)]


def score_wins(finder: "TradeFinder", model, trades: list[Trade]) -> None:
    """Attach expected-win deltas in place, for trades of any shape.

    Only ever run on the trades that survive deduping: the win model compares a
    roster against the whole field, so it costs far more than a lineup solve and
    would dominate the search if applied to every candidate.
    """
    lg = finder.lg
    for t in trades:
        points = dict(finder.baseline)
        for s in t.sides:
            points[s.team] = finder.evaluate(
                finder._swap(lg.rosters[s.team], s.sent, s.received))
        t.sides = tuple(
            replace(s, win=(model.expected_wins(s.team, points)
                            - model.expected_wins(s.team, finder.baseline)))
            for s in t.sides)
