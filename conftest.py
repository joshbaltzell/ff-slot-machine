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
