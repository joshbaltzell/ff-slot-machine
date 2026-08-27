"""Load league data from the ESPN projections workbook into arrays the solver can use."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

SHEET = "Weekly Projections"


@dataclass(frozen=True)
class League:
    """Immutable snapshot of the league.

    proj is the core structure: one row per player, one column per week, in the
    week order given by ``weeks``. Everything else indexes into it.
    """

    players: pd.DataFrame          # Player, Position, NFL Team, Fantasy Team, Bye
    proj: np.ndarray               # (n_players, n_weeks) float64
    weeks: list[int]
    teams: list[str]
    rosters: dict[str, np.ndarray]  # fantasy team -> player row indices
    config: dict

    @property
    def n_weeks(self) -> int:
        return len(self.weeks)

    def pos(self, idx) -> np.ndarray:
        return self.players["Position"].to_numpy()[idx]

    def name(self, i: int) -> str:
        return self.players["Player"].iat[int(i)]


def load_config(path: str | Path = "league_config.json") -> dict:
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    return {k: v for k, v in cfg.items() if not k.startswith("_")}


def load(workbook: str | Path = "big_money_projections.xlsx",
         config_path: str | Path = "league_config.json") -> League:
    cfg = load_config(config_path)
    df = pd.read_excel(workbook, sheet_name=SHEET)

    week_cols = [c for c in df.columns if re.fullmatch(r"Wk \d+", str(c))]
    all_weeks = [int(str(c).split()[1]) for c in week_cols]
    keep = [w for w in cfg["weeks"] if w in all_weeks]
    missing = [w for w in cfg["weeks"] if w not in all_weeks]
    if missing:
        raise ValueError(f"league_config.json asks for weeks {missing}, "
                         f"but the workbook only has {all_weeks}")

    cols = [f"Wk {w}" for w in keep]
    proj = df[cols].to_numpy(dtype=float)
    proj = np.nan_to_num(proj, nan=0.0)

    # Safety net for the D/ST quirk the workbook's Notes sheet documents: ESPN can
    # return a live projection for a defense during its bye. A player on bye scores
    # nothing, so force it. Currently a no-op on this export - kept so a future pull
    # that does carry the quirk can't silently inflate a lineup.
    bye = df["Bye"].to_numpy(dtype=float)
    week_arr = np.array(keep)
    on_bye = bye[:, None] == week_arr[None, :]
    zeroed = int((on_bye & (proj > 0)).sum())
    proj = np.where(on_bye, 0.0, proj)
    if zeroed:
        print(f"  note: zeroed {zeroed} bye-week projection(s) (D/ST quirk)")

    meta = df[["Player", "Position", "NFL Team", "Fantasy Team", "Bye"]].copy()
    teams = sorted(meta["Fantasy Team"].unique().tolist())
    rosters = {t: np.flatnonzero((meta["Fantasy Team"] == t).to_numpy())
               for t in teams}

    return League(players=meta, proj=proj, weeks=keep, teams=teams,
                  rosters=rosters, config=cfg)
