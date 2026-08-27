"""Translate points into expected wins.

Points are the wrong unit for a decision: leagues are won on record. A trade worth
+0.4 points a week sounds small, and usually is - but the honest way to say so is
in wins, not to leave the manager guessing.

Two things matter here.

**Scores are not deterministic.** The projections are point estimates; real weekly
scores scatter around them by roughly 25 points. Treating a 0.4-point edge as a
guaranteed win would wildly overstate any trade. Each team's weekly score is
modelled as Normal(projection, sigma), so a matchup is won with probability
Phi(diff / (sigma * sqrt(2))) and small edges buy small fractions of a win.

**The schedule may be unknown.** The ESPN export carries no matchups, so the default
is an all-play record: each week, the expected share of the other nine teams a roster
would beat. That measures strength without schedule luck, and needs no extra data.
If a real schedule is available it is used instead.
"""

from __future__ import annotations

import math

import numpy as np

SQRT2 = math.sqrt(2.0)


def _phi(z: np.ndarray) -> np.ndarray:
    """Standard normal CDF, vectorized (math.erf is scalar-only)."""
    return 0.5 * (1.0 + np.vectorize(math.erf)(z / SQRT2))


def win_prob(mine: np.ndarray, theirs: np.ndarray, sigma: float) -> np.ndarray:
    """P(mine beats theirs) for each week, given both are noisy around projection."""
    return _phi((mine - theirs) / (sigma * SQRT2))


class WinModel:
    def __init__(self, league, baseline: dict[str, np.ndarray]):
        cfg = league.config
        self.sigma = float(cfg.get("weekly_score_sigma", 25.0))
        self.teams = league.teams
        self.baseline = baseline
        weeks = np.array(league.weeks)
        reg = cfg.get("regular_season_weeks")
        if reg:
            self.reg_mask = np.isin(weeks, reg)
        else:                                   # everything before the playoffs
            playoffs = cfg.get("playoff_weeks") or [weeks.max() + 1]
            self.reg_mask = weeks < min(playoffs)
        self.schedule = cfg.get("schedule") or {}   # team -> [opponent per week]

    @property
    def n_games(self) -> int:
        return int(self.reg_mask.sum())

    def expected_wins(self, team: str, points: dict[str, np.ndarray]) -> float:
        """Expected regular-season wins for one team, given everyone's weekly points."""
        mine = points[team][self.reg_mask]
        opp = self.schedule.get(team)
        if opp:
            theirs = np.array([points[opp[w]][self.reg_mask][i]
                               for i, w in enumerate(np.flatnonzero(self.reg_mask))])
            return float(win_prob(mine, theirs, self.sigma).sum())
        # all-play: expected share of the field beaten each week, scaled to a season
        others = [t for t in self.teams if t != team]
        share = np.mean([win_prob(mine, points[t][self.reg_mask], self.sigma)
                         for t in others], axis=0)
        return float(share.sum())

    def table(self, points: dict[str, np.ndarray] | None = None) -> dict[str, float]:
        pts = points or self.baseline
        return {t: self.expected_wins(t, pts) for t in self.teams}

    def delta(self, team_a: str, team_b: str,
              new_a: np.ndarray, new_b: np.ndarray) -> tuple[float, float]:
        """Change in expected wins for both sides of a trade.

        The two traded rosters are compared against a field that also contains each
        other, so a trade that lifts both teams does not double-count.
        """
        pts = dict(self.baseline)
        pts[team_a], pts[team_b] = new_a, new_b
        return (self.expected_wins(team_a, pts) - self.expected_wins(team_a, self.baseline),
                self.expected_wins(team_b, pts) - self.expected_wins(team_b, self.baseline))
