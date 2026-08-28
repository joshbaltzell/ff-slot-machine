# Phase 6 — Usage signals: sell-high/buy-low, breakouts, crowd waivers, FAAB

Status: approved for build (Josh, 2026-08-27). Covers brainstorm C3, F5, F2, F6.
Follow `2026-08-27-parallel-phase-rules.md` (wave 3: this phase touches no engine
core file; new modules only).

## Why

Opportunity predicts future points better than points do: snap share, target share
and expected points lead the box score by a week or two, and touchdown rate over
expectation is the canonical sell-high signal. The market phase ranks by projection
vs crowd value; this phase adds the *evidence* — who is producing above or below
their usage — and turns Sleeper's trending adds into a waiver plan with a bid.

## Sources

**`sources/sleeperstats.js`.** `https://api.sleeper.app/stats/nfl/{season}/{week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE`
for each *played* week of the season (`< currentWeek`; cached 7 days per past week,
6 h for the most recent). Fields per `player_id`: `off_snp`, `tm_off_snp`, `rec_tgt`,
`rec_air_yd`, `rush_att`, `rec`, `rec_td`, `rush_td`, `pts_ppr/half/std`. Map to ESPN
ids via `loadSleeperPlayers().bySleeper`. Trending adds/drops via the existing
`loadTrending()`.

## Signals — `extension/engine/usage.js`

Per player, over the last `N = min(4, played weeks)` weeks and season-to-date:
- `snapShare = off_snp / tm_off_snp`; `targetShare = rec_tgt / team targets` (team
  targets = Σ rec_tgt over that team's players in the week); `airShare` likewise;
  `WOPR = 1.5·targetShare + 0.7·airShare`.
- `xTD` proxy: `0.04·rush_att + 0.06·rec_tgt` (league-average conversion; constants in
  one table `USAGE_K` with a comment on provenance); `tdOver = (rec_td + rush_td) − xTD`.
- `ppgOverUsage`: actual points per game minus a linear fit of ppg on WOPR (RB: on
  `rush_att + rec_tgt`) across the position for the same weeks — the residual is the
  "producing above usage" number.
- `trend`: last-2-weeks snap share minus previous-2-weeks (breakout indicator).

`usageTable(model, stats, currentWeek) -> Map<espnId, {snapShare, targetShare, wopr, tdOver, ppgOverUsage, trend, games}>`.

`sellHigh(team)` = my players with `ppgOverUsage` and `tdOver` both in the top
quartile of their position; `buyLow()` = others' players with `wopr` (or touches) in
the top half and `ppgOverUsage` in the bottom quartile. Each row carries the numbers
and the trade search's best offer involving that player (join on existing `trades`).

**Breakouts.** `breakouts(model, usage, trending)` = free agents and low-usage
rostered players with `trend ≥ +0.15` snap share or a `depth_chart_order` improvement
(Sleeper players file), ranked by `trend`, annotated with the Sleeper 24-h add count.

**Crowd vs engine waivers.** Join `freeAgentUpgrades` (engine gain) with trending
adds: `quiet` = high gain, low crowd count (add for free); `contested` = high gain,
high crowd count (needs a bid). Owned % from ESPN stays as the third column.

**FAAB advisor** (`faab.js`). Inputs: my remaining budget and every team's remaining
budget (ESPN `mTeam` → `transactionCounter.acquisitionBudgetSpent` vs
`settings.acquisitionSettings.acquisitionBudget` — `readSettings` gains
`faabBudget`; `loadLeague` records `team.faabSpent`), the add's `gain`, its crowd
count, weeks remaining. Suggested bid = `clamp(gain_share × my remaining × urgency)`
where `gain_share = gain / (sum of top-5 gains)`, `urgency = 1 + min(1, crowd/500)`,
rounded to an off-round number (ends in 1/6); a "max sensible" = the bid at which the
add's remaining-season gain per dollar falls below the median of the top-5. Constants
in one table; hint states it is a heuristic, not an auction model. Leagues without
FAAB (`faabBudget` 0) show waiver priority instead.

## UI — `extension/panel/usage.js`

- New section **Assets and targets (usage)**: two grids, sell-high (mine) and buy-low
  (theirs) with snap%, tgt%, WOPR, TD over xTD, pts over usage, best offer.
- **Breakout watch** grid: player, owner/FA, trend, depth chart change, crowd adds.
- Free-agent grid gains **Crowd adds (24h)** and **Bid** columns; the section title
  becomes "Free agents worth adding — quiet vs contested".
- Loading step "Usage and trends"; log lines with coverage; degrade to `—`.

## Tests — `extension/test/usage.mjs`

Synthetic weekly stats for ~12 players over 4 weeks: shares and WOPR arithmetic;
`tdOver` sign; `ppgOverUsage` residual is zero for a player exactly on the fit; trend
detects a snap jump; `sellHigh`/`buyLow` quartile membership; `breakouts` ordering;
quiet vs contested split; FAAB bid rounding, clamp to remaining budget, zero-budget
league falls back to priority; all fetches injected.
