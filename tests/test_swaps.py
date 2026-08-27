"""The swap table is load-bearing for three-way search: it must be exact."""

import time

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
    t0 = time.time()
    swaps.SwapTable.build(league, finder)
    assert time.time() - t0 < 2.0
