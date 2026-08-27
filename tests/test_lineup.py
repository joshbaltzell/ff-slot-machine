"""The lineup solver's load-bearing invariants."""

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
