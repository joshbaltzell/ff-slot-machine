# FF Slot Machine — program roadmap

Decomposes the 2026-08-27 brainstorm (all of it — Josh's decision) into phases
that each ship something useful on their own and make the next phase cheaper.
Letter-number codes refer to `2026-08-27-roadmap-brainstorm.md`.

Each phase gets its own spec in `specs/` and plan in `plans/` when it starts.
A phase is done when its parity tests pass, the panel shows the feature, and
`CLAUDE.md` records any new load-bearing decision.

| # | Phase | Ideas | Depends on | Ships |
|---|---|---|---|---|
| 1 | **Objective** | A5 `positionLimits`, A4 shrinkage, A1 win probability, A2 objective toggle, A3 week leverage | — | Trades ranked by Δ wins / Δ bye / Δ title odds with error bars; illegal rosters gone |
| 2 | **Availability core + data layer** | H1 data layer, B1 play probability (ESPN `injuryStatus`, then Sleeper practice reports) | 1 | Rosters stop being frozen; bench depth has value; one cached, degradable source module per feed |
| 3 | **Market** | E1 FantasyCalc fairness + arbitrage list, E4 pitch upgrade | 1 | Every trade shows market fairness; buy/sell list from model-vs-market gap |
| 4 | **Roster construction** | F1 replacement level + 2-for-1, F4 drop ranking | 1, 2 | Consolidation trades; "who do I cut" |
| 5 | **Projections** | C1 multi-source aggregate, H2 self-calibration log | 2 (data layer) | Uncertainty bands from source disagreement; league-specific calibration accruing weekly |
| 6 | **Usage signals** | C3 sell-high/buy-low from snap/target/xFP, F5 breakout detector, F2 crowd-vs-engine waivers, F6 FAAB advisor | 2, 5 | Assets/targets pages with evidence; waiver finder that beats the crowd |
| 7 | **Game environment** | C2 Vegas implied totals, F3 streaming planner, C4 playoff-matchup tiebreaker, C5 weather | 2 | K/DST/QB/TE streamer with 3-week hold logic; environment-adjusted current week |
| 8 | **Distributions** | D1 skewed per-player distributions, D2 correlation/covariance, D3 weekly P(win) lineup | 1, 5 | Measured floor/ceiling; Sunday-morning lineup that maximises win probability against the actual opponent |
| 9 | **Availability depth** | B2 return-week + IR stash finder, B3 durability prior, B4 news/suspension flags with devalue slider, B5 handcuff value, G1 non-frozen season sim | 2, 4 | Injury-aware ROS windows; stash finder; sim that models churn |
| 10 | **Partners** | E2 partner-need modelling, E3 manager behaviour, G2 opponent scouting, G3 division seeding persisted | 1, 2 | Partner ranking by need and responsiveness; opponent view per week |

**H3 explainability** is not a phase; every phase adds its drivers to the
recommendation detail as it lands.

## Housekeeping (folded into Phase 1)

- `CLAUDE.md` names `engine/swaps.js`; the swap table lives in `search.js`. Fix the map.
- Public league data in `docs/superpowers/` — still Josh's call; not touched.

## Ground rules that hold across every phase

- The engine models slots, not positions. ESPN's `positionLimits` is an ESPN rule keyed on ESPN's position id; applying it is reading a setting, not deriving one.
- Nothing in a search approximates. Enrichment (win odds, market, availability) runs on survivors of the exact search, never as a pruning step.
- Every feature works with ESPN alone and improves as other sources come online. A dead feed degrades to a disclosed gap, never a crash.
- Time windows stay separate; the objective toggle changes the *sort*, never the columns.
- All fetches stay in the page. No backend. No league data leaves the machine.
