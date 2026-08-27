#!/usr/bin/env python3
"""Pull fresh rosters, projections and league rules from ESPN.

League 153385 is private, so ESPN needs the two cookies your browser already has:

  1. Log in to fantasy.espn.com in Chrome.
  2. DevTools (Cmd-Opt-I) -> Application -> Cookies -> https://fantasy.espn.com
  3. Copy the values of `SWID` (with the braces) and `espn_s2` (very long).

Then either export them:

    export ESPN_SWID='{XXXXXXXX-....}'
    export ESPN_S2='AEB...'
    python3 espn_pull.py

or drop them in a file named `.espn_cookies` as two lines:

    SWID={XXXXXXXX-....}
    ESPN_S2=AEB...

Writes a workbook in the same shape find_trades.py already reads, and - unlike
the hand-made export - can also read the real lineup slots and playoff weeks
straight from the league settings, removing two assumptions.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pandas as pd

BASE = ("https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
        "/seasons/{season}/segments/0/leagues/{league}")

# ESPN lineup slot ids -> the labels this project uses.
SLOT = {0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE",
        7: "OP", 16: "D/ST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX", 24: "ER"}
POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
PRO_TEAM = {
    0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
    8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
    15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
    22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH",
    29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}
STARTABLE = {"QB", "TQB", "RB", "WR", "TE", "K", "D/ST", "FLEX", "RB/WR", "WR/TE", "OP"}


def cookies(args) -> dict[str, str]:
    swid, s2 = args.swid or os.environ.get("ESPN_SWID"), args.s2 or os.environ.get("ESPN_S2")
    path = Path(args.cookie_file)
    if (not swid or not s2) and path.exists():
        for line in path.read_text().splitlines():
            if "=" not in line or line.strip().startswith("#"):
                continue
            k, _, v = line.partition("=")
            k, v = k.strip().upper(), v.strip()
            if k == "SWID":
                swid = swid or v
            elif k in ("ESPN_S2", "S2"):
                s2 = s2 or v
    if not swid or not s2:
        sys.exit(f"error: need ESPN cookies. See the header of {__file__} "
                 "for the three-step way to get them.")
    return {"SWID": swid, "espn_s2": s2}


def get(url: str, jar: dict, tries: int = 3) -> dict:
    cookie = "; ".join(f"{k}={v}" for k, v in jar.items())
    req = Request(url, headers={"Cookie": cookie, "User-Agent": "Mozilla/5.0",
                                "Accept": "application/json"})
    for attempt in range(tries):
        try:
            with urlopen(req, timeout=30) as r:
                return json.load(r)
        except HTTPError as e:
            if e.code in (401, 403):
                sys.exit("error: ESPN rejected the cookies (401/403). They expire - "
                         "grab fresh ones from your browser.")
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("unreachable")


def pull(season: int, league: int, jar: dict, weeks: range) -> tuple[pd.DataFrame, dict]:
    base = BASE.format(season=season, league=league)
    settings = get(f"{base}?view=mSettings", jar)

    names: dict[int, str] = {}
    rows: dict[int, dict] = {}
    for wk in weeks:
        print(f"  week {wk:>2} ...", end="", flush=True)
        blob = get(f"{base}?view=mRoster&view=mTeam&scoringPeriodId={wk}", jar)
        for team in blob.get("teams", []):
            tname = (team.get("name")
                     or f"{team.get('location','')} {team.get('nickname','')}".strip()
                     or f"Team {team['id']}")
            names[team["id"]] = tname
            for entry in team.get("roster", {}).get("entries", []):
                p = entry["playerPoolEntry"]["player"]
                pid = p["id"]
                slots = {SLOT.get(s, str(s)) for s in p.get("eligibleSlots", [])}
                pos = ("TQB" if "TQB" in slots
                       else POS.get(p.get("defaultPositionId"), "?"))
                rec = rows.setdefault(pid, {
                    "Player": p["fullName"], "Position": pos,
                    "NFL Team": PRO_TEAM.get(p.get("proTeamId"), "?"),
                    "Fantasy Team": tname,
                    "Bye": None})
                rec["Fantasy Team"] = tname
                proj = next((s["appliedTotal"] for s in p.get("stats", [])
                             if s.get("statSourceId") == 1
                             and s.get("statSplitTypeId") == 1
                             and s.get("scoringPeriodId") == wk), 0.0)
                rec[f"Wk {wk}"] = round(float(proj or 0.0), 2)
        print(" ok")

    df = pd.DataFrame(rows.values())
    week_cols = [f"Wk {w}" for w in weeks]
    for c in week_cols:
        if c not in df:
            df[c] = 0.0
    df[week_cols] = df[week_cols].fillna(0.0)

    # Bye weeks are a property of the NFL team, not the player: a single player can
    # project 0 for all sorts of reasons (injury, depth chart), but a whole NFL roster
    # only goes quiet together on its bye. Take the week where the most of a pro
    # team's players project nothing.
    zeros = (df[week_cols] == 0)
    byes: dict[str, int] = {}
    for pro, grp in zeros.groupby(df["NFL Team"]):
        counts = grp.sum(axis=0)
        byes[pro] = int(counts.idxmax().split()[1]) if counts.max() else 0
    df["Bye"] = df["NFL Team"].map(byes).fillna(0).astype(int)
    df["Season Total"] = df[week_cols].sum(axis=1)
    df["Avg/Wk (excl. bye)"] = df[week_cols].replace(0, pd.NA).mean(axis=1)

    cols = ["Player", "Position", "NFL Team", "Fantasy Team", "Bye"] + week_cols \
        + ["Season Total", "Avg/Wk (excl. bye)"]
    return df[cols], settings


def config_from_settings(settings: dict) -> dict:
    """Read the real lineup slots and playoff weeks out of the league settings."""
    s = settings.get("settings", {})
    counts = s.get("rosterSettings", {}).get("lineupSlotCounts", {})
    lineup = {SLOT.get(int(k), str(k)): v for k, v in counts.items()
              if v and SLOT.get(int(k)) in STARTABLE}
    sched = s.get("scheduleSettings", {})
    first = sched.get("matchupPeriodCount")
    length = sched.get("playoffMatchupPeriodLength", 1)
    teams = sched.get("playoffTeamCount", 0)
    playoffs = []
    if first:
        rounds = max(1, (teams or 4).bit_length() - 1)
        playoffs = list(range(first + 1, first + 1 + rounds * length))
    return {"starting_lineup": lineup, "playoff_weeks": playoffs}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--league", type=int, default=153385)
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--weeks", default="1-18")
    ap.add_argument("--out", default="big_money_projections.xlsx")
    ap.add_argument("--swid"), ap.add_argument("--s2")
    ap.add_argument("--cookie-file", default=".espn_cookies")
    ap.add_argument("--print-settings", action="store_true",
                    help="show the lineup slots and playoff weeks ESPN reports")
    args = ap.parse_args(argv)

    lo, _, hi = args.weeks.partition("-")
    weeks = range(int(lo), int(hi or lo) + 1)
    jar = cookies(args)

    print(f"Pulling league {args.league}, season {args.season}, weeks {weeks.start}-{weeks.stop-1}")
    df, settings = pull(args.season, args.league, jar, weeks)

    out = Path(args.out)
    if out.exists():
        backup = out.with_suffix(".bak.xlsx")
        out.replace(backup)
        print(f"  existing workbook moved to {backup}")
    with pd.ExcelWriter(out, engine="openpyxl") as xl:
        df.to_excel(xl, sheet_name="Weekly Projections", index=False)
    print(f"Wrote {out}  ({len(df)} players, {df['Fantasy Team'].nunique()} teams)")

    derived = config_from_settings(settings)
    print("\nLeague settings ESPN reports:")
    print(f"  starting lineup: {derived['starting_lineup']}")
    print(f"  playoff weeks:   {derived['playoff_weeks']}")
    print("Compare these against league_config.json and update it if they differ.")
    if args.print_settings:
        print(json.dumps(settings.get("settings", {}), indent=2)[:4000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
