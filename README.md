# FF Slot Machine

Finds the ESPN fantasy football trades and waiver adds that actually raise your
score — by only counting players who would **start**.

> **The Chrome extension in [`extension/`](extension/) is the product.** It reads
> any ESPN league live from your browser session, so there are no cookies to copy
> and no spreadsheet to refresh. The Python engine documented below is now the
> reference implementation the extension is tested against; it still runs, but new
> features go to the extension.

The premise: a roster's value is not the sum of its players, it's the sum of the
players who actually *start*. A fourth RB on a team that starts two is worth
nothing. Move him to a team starting a replacement-level flex and he's worth real
points. This tool looks for exactly those mismatches.

## Run it

```bash
python3 find_trades.py --open
```

That reads `big_money_projections.xlsx`, searches every 1-for-1 and 2-for-2 trade
between all 45 team pairs, and writes `trade_report.html` — a self-contained page,
no server required. Takes about 45 seconds.

The report has three tabs. **Trades** lists every mutually beneficial offer; when a
team is selected the rows flip so that team is always "you", and every column sorts
on click. **My Roster** shows each player's season usage strip — 18 cells marking
exactly which weeks he starts. **League** ranks every roster by its ceiling.
Both themes are supported; the toggle sticks between runs.

```bash
python3 find_trades.py --depth 1                  # 1-for-1 only, ~1 second
python3 find_trades.py --team "MR. PLOW"          # only trades with one team
python3 find_trades.py --min-gain 0.5             # only meaningful gains
python3 find_trades.py --excel                    # also write trade_report.xlsx
python3 find_trades.py --my-team "Second String"  # whose view the report opens in
```

## How a trade is scored

For every week, each team's optimal lineup is solved under the league rules —
**1 TQB / 2 RB / 2 WR / 1 TE / 1 FLEX / 1 K / 1 D-ST**. A trade's value to a team
is how much that optimal total moves, averaged across the season. Bench depth
contributes nothing, byes are handled automatically (a player projecting 0 simply
never gets started), and only trades where *both* sides gain are reported.

Because those two things can disagree, the report separates **regular season** from
**playoff** weeks, and converts both into **expected wins**. A trade that averages
positive over all 18 weeks can still be negative across the 14 that decide seeding.

It also flags **bye-driven** trades: offers that are roughly neutral at full strength
but worth real points once byes force a manager to start players he'd rather bench.
Byes are staggered, so a surplus RB can be worth far more to a team whose week 7 is
gutted than his season average suggests. Expand any trade for the pitch panel — the
argument written from the *other* manager's side, with a copy button.

The report also shows each player's **start rate** — the share of weeks he'd crack
your optimal lineup. Anyone near 0% is a trade chip: points sitting on your bench.

## Refreshing the data

The workbook is a point-in-time pull. ESPN regenerates projections weekly, so
re-pull before acting on anything past the current week:

```bash
export ESPN_SWID='{...}'   # from your browser cookies
export ESPN_S2='AEB...'
python3 espn_pull.py
```

League 153385 is private, so this needs the two cookies your logged-in browser
already has — `espn_pull.py`'s header has the three-step way to get them. It also
prints the lineup slots and playoff weeks straight from the league settings, which
is worth doing once to confirm `league_config.json` is right.

## Configuration

`league_config.json` holds the league rules. The two entries worth checking:

- `playoff_weeks` — assumed `[15, 16, 17]`, not present in the ESPN export. Only
  affects the playoff-gain column.
- `enforce_position_limits` — off. Every team currently holds exactly
  2 TQB / 4 RB / 4 WR / 2 TE / 2 D-ST / 2 K. If that uniformity is an enforced
  roster rule rather than a draft artifact, turn it on and trades will be
  restricted to like-for-like swaps.

## Layout

```
find_trades.py        CLI entry point
espn_pull.py          refresh the workbook from ESPN (needs cookies)
league_config.json    lineup slots, weeks, playoff weeks
ffti/
  data.py             workbook -> arrays
  lineup.py           optimal-lineup solver
  search.py           trade enumeration, scoring, explanations
  report.py           HTML and Excel output
  template.html       the report page
```

## Caveats

Projections are ESPN's own, already scored under this league's settings. They are
a season-long baseline that moves every week, and they say nothing about injuries,
schedule strength, or whether a manager will actually accept your offer. Treat the
output as a shortlist of conversations worth having, not a ranking of good moves.
