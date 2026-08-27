"""Search behavior, pinned before the N-sided refactor."""

import json
import pathlib

import pytest

GOLDEN = pathlib.Path(__file__).parent / "golden_1for1.json"


def _fingerprint(trades, league):
    """Order-independent, refactor-independent description of a result set.

    Built out of plain lists so a JSON round-trip is lossless - comparing a
    tuple against its reloaded list form silently fails every time.
    """
    out = []
    for t in trades:
        sides = sorted([s.team, sorted(int(i) for i in s.sent), round(s.gain, 6)]
                       for s in t.sides)
        out.append(sides)
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
        assert all(s.gain > 0 for s in t.sides)


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


def _shape_key(trades):
    return sorted(
        tuple(sorted((s.team, tuple(sorted(s.sent))) for s in t.sides))
        for t in trades)


def test_shape_named_search_matches_depth_search(finder):
    """The named shape must reproduce exactly what depth=1 produced."""
    assert _shape_key(finder.find(shape="1-for-1")) == _shape_key(finder.find(depth=1))


def test_unknown_shape_raises(finder):
    with pytest.raises(KeyError):
        finder.find(shape="4-for-4")


def test_three_way_sides_all_gain(finder):
    for t in finder.find(shape="three-way", min_gain=0.05):
        assert len(t.sides) == 3
        assert all(s.gain >= 0.05 for s in t.sides)


def test_three_way_is_a_true_cycle(finder):
    """Each team sends exactly one player and receives exactly one, and the set
    of players sent equals the set received."""
    for t in finder.find(shape="three-way", min_gain=0.05)[:50]:
        for s in t.sides:
            assert len(s.sent) == 1 and len(s.received) == 1
            assert s.sent[0] != s.received[0]
        assert {s.sent[0] for s in t.sides} == {s.received[0] for s in t.sides}


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
