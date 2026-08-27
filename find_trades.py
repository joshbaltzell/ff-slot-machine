#!/usr/bin/env python3
"""Find trades that raise BOTH teams' projected starting-lineup points.

    python3 find_trades.py                     # 1-for-1 and 2-for-2, full report
    python3 find_trades.py --depth 1           # faster, 1-for-1 only
    python3 find_trades.py --team "MR. PLOW"   # only trades involving one team
    python3 find_trades.py --open              # write the report and open it

Writes trade_report.html - a self-contained page, no server needed.
"""

from __future__ import annotations

import argparse
import sys
import time
import webbrowser
from pathlib import Path

from ffti import data, lineup, report, search, wins


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workbook", default="big_money_projections.xlsx")
    ap.add_argument("--config", default="league_config.json")
    ap.add_argument("--out", default="trade_report.html")
    ap.add_argument("--shape", action="append", choices=sorted(search.SHAPES),
                    help="trade shape; repeatable. "
                         "Default: 1-for-1, 2-for-2 and three-way.")
    ap.add_argument("--team", default=None, help="restrict to trades involving this team")
    ap.add_argument("--my-team", default="Perrysburg Spreadsheets")
    ap.add_argument("--min-gain", type=float, default=0.05,
                    help="minimum avg points/week each side must gain (default 0.05)")
    ap.add_argument("--per-pair", type=int, default=3,
                    help="max distinct offers kept per team pair (default 3)")
    ap.add_argument("--excel", nargs="?", const="trade_report.xlsx", default=None,
                    metavar="PATH", help="also write the findings as a workbook")
    ap.add_argument("--open", action="store_true", help="open the report when done")
    args = ap.parse_args(argv)

    if not Path(args.workbook).exists():
        print(f"error: workbook not found: {args.workbook}", file=sys.stderr)
        return 1

    print(f"Loading {args.workbook} ...")
    lg = data.load(args.workbook, args.config)
    solver = lineup.LineupSolver(lg.config)
    print(f"  {len(lg.players)} players, {len(lg.teams)} teams, "
          f"weeks {lg.weeks[0]}-{lg.weeks[-1]}, {solver.starters} starters/wk")

    if args.my_team not in lg.teams:
        print(f"error: --my-team {args.my_team!r} not in league. "
              f"Teams: {', '.join(lg.teams)}", file=sys.stderr)
        return 1
    if args.team and args.team not in lg.teams:
        print(f"error: --team {args.team!r} not in league.", file=sys.stderr)
        return 1

    finder = search.TradeFinder(lg, solver)
    masks = search.start_masks(lg, solver)
    rates = {pid: float(m.mean()) for pid, m in masks.items()}

    shapes = args.shape or ["1-for-1", "2-for-2", "three-way"]
    found: list[search.Trade] = []
    for name in shapes:
        t0 = time.time()
        print(f"Searching {name} trades ...", end="", flush=True)

        def tick(n, total, hits, _n=name):
            if n % 5 and n != total:
                return
            print(f"\r  {_n}: group {n}/{total}, {hits} candidates ...",
                  end="", flush=True)

        raw = finder.find(shape=name, min_gain=args.min_gain,
                          only_team=args.team, progress=tick)
        kept = search.dedupe(raw, per_pair=args.per_pair)
        found += kept
        print(f"\r  {name}: {len(raw)} mutually beneficial, "
              f"{len(kept)} after dedupe ({time.time()-t0:.0f}s)" + " " * 24)

    found.sort(key=lambda t: -t.total)

    model = wins.WinModel(lg, finder.baseline)
    print(f"Scoring expected wins ({model.n_games} games, "
          f"{'real schedule' if model.schedule else 'all-play'}) ...")
    search.score_wins(finder, model, found)

    print(f"Building report ({len(found)} trades) ...")
    payload = report.build_payload(lg, finder, found, rates, args.my_team,
                                  masks=masks, model=model)
    out = report.write(payload, args.out)
    size = out.stat().st_size / 1024
    print(f"\nWrote {out}  ({size:.0f} KB)")
    _standings(lg, model, finder)
    if args.excel:
        xl = report.write_excel(payload, lg, args.excel)
        print(f"Wrote {xl}  ({xl.stat().st_size/1024:.0f} KB)")

    _summary(lg, finder, found, rates, args.my_team)

    if args.open:
        webbrowser.open(out.resolve().as_uri())
    return 0


def _standings(lg, model, finder) -> None:
    tbl = model.table()
    print(f"\nProjected record ({model.n_games} games, "
          f"{'real schedule' if model.schedule else 'all-play'}, "
          f"sigma {model.sigma:.0f}):")
    for t, w in sorted(tbl.items(), key=lambda kv: -kv[1]):
        print(f"  {t:<24} {w:5.2f}-{model.n_games - w:5.2f}   "
              f"{finder.baseline[t].mean():6.2f} pts/wk")


def _avg(row) -> float:
    """Mean projection excluding bye weeks - matches the workbook's own column."""
    live = row[row > 0]
    return float(live.mean()) if len(live) else 0.0


def _summary(lg, finder, trades, rates, my_team) -> None:
    """Terminal digest, so the tool is useful without opening the report."""
    def my_side(t):
        return t.side(my_team)

    mine = sorted((t for t in trades if my_team in t.teams),
                  key=lambda t: -my_side(t).gain)
    bench = sorted((i for i in lg.rosters[my_team]), key=lambda i: rates.get(int(i), 0))

    print(f"\n{'='*74}\n{my_team}: {finder.baseline[my_team].mean():.2f} pts/wk "
          f"from an optimal lineup\n{'='*74}")
    print("\nLeast-used players on your roster (your trade chips):")
    for i in bench[:5]:
        print(f"  {lg.name(i):<24} {lg.players['Position'].iat[int(i)]:<5} "
              f"starts {rates[int(i)]*100:>3.0f}% of weeks   "
              f"proj {_avg(lg.proj[int(i)]):.1f}/wk")

    if not mine:
        print("\nNo mutually beneficial trades found for your team.")
        return
    print(f"\nBest offers for you, ranked by YOUR gain ({len(mine)} total):")
    for t in mine[:5]:
        me = t.side(my_team)
        others = [s for s in t.sides if s.team != my_team]
        print(f"\n  {t.shape} with {', '.join(s.team for s in others)}")
        print(f"    you get  {' + '.join(lg.name(i) for i in me.received)}")
        print(f"    you give {' + '.join(lg.name(i) for i in me.sent)}")
        flag = "  <- helps you only in the playoffs" if me.reg < 0 <= me.gain else ""
        print(f"    you {me.gain:+.2f}/wk overall   reg season {me.reg:+.2f}   "
              f"playoffs {me.playoff:+.2f}   {me.win:+.2f} wins{flag}")
        for s in others:
            print(f"    {s.team} {s.gain:+.2f}/wk")


if __name__ == "__main__":
    raise SystemExit(main())
