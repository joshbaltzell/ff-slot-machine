"""Optimal starting-lineup solver.

The whole tool rests on one idea: a roster's value is not the sum of its players,
it is the sum of the players who actually *start*. A fourth RB on a team that
starts two adds nothing; the same RB on a team starting a replacement-level flex
adds real points. Trades are scored as the change in that started-points total.

Optimality
----------
Slots are filled most-restrictive first: dedicated positions, then FLEX from
whoever is left over. That greedy order is provably optimal as long as slot
eligibility sets are nested (RB, WR, TE each a subset of FLEX) - true for this
league and for every standard ESPN configuration including superflex. It is not
valid for exotic partially-overlapping slots, so the loader checks the shape.
"""

from __future__ import annotations

import numpy as np


class LineupSolver:
    """Solves a full season of optimal lineups at once, vectorized over weeks."""

    def __init__(self, config: dict):
        lineup = config["starting_lineup"]
        flex_elig = config.get("flex_eligibility", {})

        self.dedicated: dict[str, int] = {
            pos: n for pos, n in lineup.items() if pos not in flex_elig and n > 0
        }
        # Flex groups, widest last, so narrower groups claim their players first.
        self.flex: list[tuple[str, int, tuple[str, ...]]] = sorted(
            ((name, lineup[name], tuple(flex_elig[name]))
             for name in flex_elig if lineup.get(name, 0) > 0),
            key=lambda g: len(g[2]),
        )
        self._validate(flex_elig)
        self.starters = sum(self.dedicated.values()) + sum(g[1] for g in self.flex)

    def _validate(self, flex_elig: dict) -> None:
        """Reject slot shapes where greedy filling would not be optimal."""
        sets = [set(e) for e in flex_elig.values()]
        for i, a in enumerate(sets):
            for b in sets[i + 1:]:
                if a & b and not (a <= b or b <= a):
                    raise ValueError(
                        "flex_eligibility groups partially overlap "
                        f"({sorted(a)} vs {sorted(b)}); the greedy solver only "
                        "guarantees an optimal lineup for nested groups."
                    )

    # -- core ------------------------------------------------------------

    def weekly_points(self, blocks: dict[str, np.ndarray]) -> np.ndarray:
        """Best possible started points per week.

        blocks maps position -> (n_players_at_pos, n_weeks) projections.
        Returns a (n_weeks,) array.
        """
        n_weeks = next(iter(blocks.values())).shape[1]
        total = np.zeros(n_weeks)
        leftovers: dict[str, np.ndarray] = {}

        for pos, need in self.dedicated.items():
            ranked = _rank(blocks.get(pos), need, n_weeks)
            total += ranked[:need].sum(axis=0)
            leftovers[pos] = ranked[need:]

        for _name, need, eligible in self.flex:
            pool = [leftovers[p] for p in eligible if p in leftovers]
            pool += [blocks[p] for p in eligible if p not in leftovers and p in blocks]
            stacked = np.concatenate(pool, axis=0) if pool else None
            ranked = _rank(stacked, need, n_weeks)
            total += ranked[:need].sum(axis=0)
            # Re-distributing the flex remainder is unnecessary: with nested groups
            # a wider group never needs a narrower group's leftovers back.
        return total

    def starter_mask(self, blocks: dict[str, np.ndarray],
                     ids: dict[str, np.ndarray]) -> dict[int, np.ndarray]:
        """Which weeks each player actually starts. player id -> (n_weeks,) bool.

        Solved one week at a time in plain Python. That is far slower than
        weekly_points, but it only ever runs on the handful of trades that make
        the report, and the slot logic stays readable enough to audit against
        the league rules.
        """
        n_weeks = next(iter(blocks.values())).shape[1]
        started = {int(p): np.zeros(n_weeks, dtype=bool)
                   for arr in ids.values() for p in arr}

        for w in range(n_weeks):
            available = {
                pos: sorted(
                    ((float(blocks[pos][i, w]), int(ids[pos][i]))
                     for i in range(len(ids[pos]))),
                    key=lambda t: -t[0],
                )
                for pos in ids
            }
            for pos, need in self.dedicated.items():
                for _v, pid in available.get(pos, [])[:need]:
                    started[pid][w] = True
                available[pos] = available.get(pos, [])[need:]
            for _name, need, eligible in self.flex:
                pool = sorted(
                    (entry for pos in eligible for entry in available.get(pos, [])),
                    key=lambda t: -t[0],
                )
                taken = {pid for _v, pid in pool[:need]}
                for pid in taken:
                    started[pid][w] = True
                for pos in eligible:
                    available[pos] = [e for e in available.get(pos, [])
                                      if e[1] not in taken]
        return started

def _rank(block: np.ndarray | None, need: int, n_weeks: int) -> np.ndarray:
    """Sort a position block best-first per week, padding if the roster is short.

    A roster can legitimately be too thin to fill a slot (both TQBs traded away,
    or both on bye). ESPN would start nobody and score zero, so pad with zeros
    rather than raising - the trade simply grades out badly, which is correct.
    """
    if block is None or len(block) == 0:
        return np.zeros((need, n_weeks))
    ranked = -np.sort(-block, axis=0)
    if len(ranked) < need:
        ranked = np.vstack([ranked, np.zeros((need - len(ranked), n_weeks))])
    return ranked
