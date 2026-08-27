# Phase 3 — Market: FantasyCalc fairness and the arbitrage list

Status: approved for build (Josh, 2026-08-27). Covers brainstorm E1 and E4.
Follow `2026-08-27-parallel-phase-rules.md`. Do not modify `search.js` or `season.js`.

## Why

Our trades are scored by exact lineup value; the humans on the other side judge by
gut, and their gut is calibrated by trade-value charts. FantasyCalc publishes values
derived from real completed trades as open JSON keyed on `espnId`. Showing market
fairness beside our lineup delta makes suggestions the partner will accept, and the
gap between market and model is the trade edge itself.

## Data — `extension/engine/sources/fantasycalc.js`

`loadMarket(settings, teamCount, opts)` fetches
`https://api.fantasycalc.com/values/current?isDynasty=false&numQbs={q}&numTeams={t}&ppr={p}`
via `cached()` with a 12-hour TTL, where `q` = 2 if `lineupSlotCounts[0] >= 2` or
`lineupSlotCounts[7] > 0` (OP/superflex) else 1; `t` = the nearest of {8,10,12,14}
to the league's team count; `p` = `settings.pprValue` rounded to the nearest of
{0, 0.5, 1}. Returns `Map<espnId, {value, overallRank, positionRank, trend30Day, tier, name, pos}>`.
Players absent from the response have no market value (treated as 0 with a flag).

## Fairness — `extension/engine/market.js`

```
sideMarket(side, market) -> { sent, received, delta, known }   // sums of `value`; known = every player priced
tradeFairness(trade, market) -> { fairness, sides: Map<team, sideMarket> }
```
`fairness` = `min(received totals) / max(received totals)` across sides (1 = even).
`pitchMarketLine(trade, other, market)` → one sentence for the pitch: "By
FantasyCalc's crowd values you receive 4,210 and give 3,880 — a fair deal by the
market (+8%)." Omitted when any player is unpriced.

## Arbitrage — `market.js`

`arbitrage(eng, model, market, { remainingWeeks }) -> { buy: [...], sell: [...] }`
- Model rank: within each position label, rank players (rostered + free agents)
  by mean projection over remaining weeks where `proj > 0` (points per game).
- Market rank: FantasyCalc `positionRank`.
- `edge = marketRank − modelRank` (positive: the market undervalues him).
- `buy`: top 15 by edge among players not on my team; `sell`: top 15 by `−edge`
  among my players. Each row: name, pos, owner, ppg, modelRank, marketRank,
  value, trend30Day.
- Value-per-slot (replacement level) is Phase 4; this is a ranking comparison and
  says so in its hint.

## UI — `extension/panel/market.js`

- Trade grid: **Market** column = fairness as a percentage with a small bar (reuse
  `.bal` styling), hint explaining it is FantasyCalc's crowd value from real trades.
- Filter chip **Market-fair** in the existing "Only" chip group: fairness ≥ 0.8.
- Trade detail: per side, "market: sends X · receives Y" line under the point numbers.
- Pitch (`pitchText`): append `pitchMarketLine` when available.
- New section **Buy low / sell high (market vs projection)** below free agents: two
  grids from `arbitrage`.
- Loading step "Market values"; log line "FantasyCalc: N players priced (1QB, 12 teams, 0.5 PPR)"; on failure "market values unavailable" and every market cell shows `—`.

## Tests — `extension/test/market.mjs`

Fixture: a synthetic FantasyCalc payload of ~30 players (write it inline) matching
fixture player ids 0..29 via `espnId`.
- URL construction for 1QB/2QB, team-count snapping, ppr snapping.
- `sideMarket` sums and `known` false when a player is unpriced.
- `tradeFairness` = 1 for equal packages; 0.5 for 2:1.
- `arbitrage` ranks: a player with modelRank 1 and marketRank 10 tops `buy`; `sell` only contains my team's players.
- Degradation: `loadMarket` with a dead fetch throws; the panel helper `marketOrNull` returns null and the fairness column value is null.
