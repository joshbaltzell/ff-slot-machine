"""Build a self-contained HTML report - no server, no network, just open the file."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np

from . import search as S

TEMPLATE = Path(__file__).parent / "template.html"


def _lineup_label(cfg: dict) -> str:
    order = ["TQB", "QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "D/ST"]
    slots = cfg["starting_lineup"]
    parts = [f"{n}{p}" for p in order if (n := slots.get(p, 0))]
    parts += [f"{n}{p}" for p, n in slots.items() if p not in order and n]
    return " / ".join(parts)


def build_payload(lg, finder: S.TradeFinder, trades: list[S.Trade],
                  rates: dict[int, float], my_team: str,
                  explain_top: int = 400, masks: dict | None = None,
                  model=None) -> dict:
    cfg = lg.config
    meta_df = lg.players
    masks = masks or {}

    players = [{
        "id": int(i),
        "name": meta_df["Player"].iat[i],
        "pos": meta_df["Position"].iat[i],
        "nfl": meta_df["NFL Team"].iat[i],
        "team": meta_df["Fantasy Team"].iat[i],
        "bye": int(meta_df["Bye"].iat[i]),
        "avg": float(lg.proj[i][lg.proj[i] > 0].mean()) if (lg.proj[i] > 0).any() else 0.0,
        "start_rate": round(rates.get(int(i), 0.0), 4),
        # per-week: 1 starts, 0 benched, -1 bye. Drawn as the season strip.
        "starts": [(-1 if lg.weeks[w] == int(meta_df["Bye"].iat[i])
                    else int(bool(masks.get(int(i), [0] * lg.n_weeks)[w])))
                   for w in range(lg.n_weeks)],
        "proj": [round(float(x), 1) for x in lg.proj[i]],
    } for i in range(len(meta_df))]

    standings = sorted(
        ({"name": t, "avg": float(v.mean()), "season": float(v.sum()),
          "byes": [int(x) for x in finder.team_byes[t]],
          "thin": [int(x) for x in finder.thin[t]],
          # what bye weeks actually cost this roster
          "wins": round(model.table()[t], 2) if model else None,
          "thin_avg": float(v[finder.thin[t]].mean()) if finder.thin[t].any() else float(v.mean()),
          "full_avg": float(v[~finder.thin[t]].mean()) if (~finder.thin[t]).any() else float(v.mean())}
         for t, v in finder.baseline.items()),
        key=lambda d: -d["avg"])

    out_trades = []
    for n, t in enumerate(trades):
        out_trades.append({
            "shape": t.shape,
            "sides": [{
                "team": x.team,
                "sent": [int(i) for i in x.sent],
                "recv": [int(i) for i in x.received],
                "g": round(x.gain, 3), "r": round(x.reg, 3),
                "p": round(x.playoff, 3), "b": round(x.bye, 3),
                "f": round(x.full, 3), "w": round(x.win, 4),
                "wk": [round(float(v), 2) for v in x.weekly],
            } for x in t.sides],
            "explain": S.explain(finder, t) if n < explain_top else {},
        })

    playoffs = cfg.get("playoff_weeks", [])
    win_note = []
    if model:
        win_note = [
            f"Expected wins model a weekly score as a normal draw around its projection "
            f"(sigma {model.sigma:.0f} pts) over {model.n_games} regular-season games"
            + (", against the real schedule." if model.schedule else
               ", against the whole field - the ESPN export carries no schedule, so this "
               "is an all-play record rather than your actual matchups."),
        ]
    assumptions = win_note + [
        f"Lineup is {_lineup_label(cfg)}; a trade is scored as the change in "
        "optimal started points, so bench depth is worth nothing.",
        f"Playoff weeks assumed to be {playoffs} - not present in the ESPN export.",
        "Projections are ESPN's own, already scored under this league's settings, "
        "and ESPN regenerates them weekly, so later weeks will move.",
        "Only trades where BOTH teams gain are listed.",
        "Gain columns average all weeks. A trade can be positive overall while hurting "
        "the regular-season record that decides seeding - the regular-season and playoff "
        "columns separate the two.",
        f"A 'thin' week is one where {cfg.get('thin_week_byes', 2)}+ of a roster is on "
        "bye - when a manager is forced to start players he would normally bench.",
    ]
    if cfg.get("enforce_position_limits"):
        assumptions.append("Position limits enforced: trades must swap like for like.")

    return {
        "meta": {
            "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "n_players": len(players), "teams": len(lg.teams),
            "team_list": lg.teams, "my_team": my_team,
            "weeks": lg.weeks, "playoff_weeks": playoffs,
            "lineup": _lineup_label(cfg), "assumptions": assumptions,
            "n_games": model.n_games if model else None,
            "sigma": model.sigma if model else None,
        },
        "players": players, "standings": standings, "trades": out_trades,
        # id -> name lookup, used by the Excel export and stripped before embedding
        "_names": {str(p["id"]): p["name"] for p in players},
    }


def write(payload: dict, path: str | Path) -> Path:
    embed = {k: v for k, v in payload.items() if not k.startswith("_")}
    html = TEMPLATE.read_text(encoding="utf-8").replace(
        "__PAYLOAD__", json.dumps(embed, ensure_ascii=False, separators=(",", ":")))
    path = Path(path)
    path.write_text(html, encoding="utf-8")
    return path


def write_excel(payload: dict, lg, path: str | Path) -> Path:
    """Same findings as a workbook, for anyone who would rather sort in Excel."""
    import pandas as pd

    trades = pd.DataFrame([{
        "Team A": t["a"],
        "A receives": " + ".join(payload["_names"][str(i)] for i in t["sb"]),
        "Team B": t["b"],
        "B receives": " + ".join(payload["_names"][str(i)] for i in t["sa"]),
        "Size": f'{t["d"]}-for-{t["d"]}',
        "A gain/wk": t["ga"], "B gain/wk": t["gb"],
        "Combined": round(t["ga"] + t["gb"], 3),
        "A playoff gain/wk": t["pa"], "B playoff gain/wk": t["pb"],
    } for t in payload["trades"]])

    players = pd.DataFrame(payload["players"]).rename(columns={
        "name": "Player", "pos": "Position", "nfl": "NFL Team",
        "team": "Fantasy Team", "bye": "Bye", "avg": "Proj/wk (excl. bye)",
        "start_rate": "Start rate"}).drop(columns=["id"])
    players = players.sort_values(["Fantasy Team", "Start rate"])

    standings = pd.DataFrame(payload["standings"]).rename(columns={
        "name": "Fantasy Team", "avg": "Optimal pts/wk", "season": "Season total"})

    notes = pd.DataFrame({"Assumptions": payload["meta"]["assumptions"]})

    path = Path(path)
    with pd.ExcelWriter(path, engine="openpyxl") as xl:
        trades.to_excel(xl, sheet_name="Trades", index=False)
        players.to_excel(xl, sheet_name="Player Usage", index=False)
        standings.to_excel(xl, sheet_name="Team Strength", index=False)
        notes.to_excel(xl, sheet_name="Notes", index=False)
        for name, df in (("Trades", trades), ("Player Usage", players),
                         ("Team Strength", standings), ("Notes", notes)):
            ws = xl.sheets[name]
            for col in ws.columns:
                width = max(len(str(c.value or "")) for c in col)
                ws.column_dimensions[col[0].column_letter].width = min(width + 3, 46)
            ws.freeze_panes = "A2"
    return path
