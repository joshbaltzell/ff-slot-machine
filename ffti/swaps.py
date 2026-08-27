"""Precomputed swap values.

For a one-player-each trade, a team's post-trade value depends only on which
player leaves and which arrives - not on who the other team is. Tabulating that
once turns every such trade into an array lookup, which is what makes exhaustive
three-way search cheap enough to need no heuristic at all.

Measured on this league: ~0.5s to build, ~3.7 MB, exact against the direct solver.
An earlier design used marginal-value estimates to prune the three-way search
instead; it was measured at 57% recall and abandoned. See the design spec.
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
                    tab[slot, in_id] = finder.evaluate(np.append(kept, in_id))
            tables[team] = tab
        return cls(league, finder, tables)

    def after(self, team: str, out_id: int, in_id: int) -> np.ndarray:
        return self._tables[team][self._slot[team][int(out_id)], int(in_id)]

    def delta(self, team: str, out_id: int, in_id: int) -> np.ndarray:
        return self.after(team, out_id, in_id) - self._finder.baseline[team]

    @property
    def nbytes(self) -> int:
        return sum(t.nbytes for t in self._tables.values())
