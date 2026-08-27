# FF Slot Machine — roadmap brainstorm (2026-08-27)

Status: ideas only. Nothing here is approved or built. Researched against
what the engine does today, what competing tools do, what the analytics
literature supports, and which data a client-side extension can actually reach.

## Where we stand

The engine's edge is that it scores **marginal starting-lineup value under the
league's real `eligibleSlots`**, exactly, across five time windows. No shipping
tool does this — ESPN/IBM, FantasyPros, Draft Sharks, 4for4, ETR and the crowd
value sites all sum per-player values and at best add a "starters only" toggle.
Every idea below should either feed that engine better inputs (projections,
availability, distributions) or point it at a better objective (wins and
titles rather than points). Ideas that don't do one of those are decoration.

Facts uncovered while surveying the code that shape the list:

- `sideMetrics.win` is always 0 — win-probability scoring was designed but never ported.
- `positionLimits` is read from settings but never enforced by the engine.
- Rosters are treated as frozen. `injuryStatus` is already in the ESPN payload we fetch and we ignore it.
- `CLAUDE.md` names `engine/swaps.js`; the swap table actually lives in `search.js`.

## Research findings that change the design

Cited in detail in the appendix; the headlines:

1. **Aggregating projection sources beats any single source** (FFA, 12 seasons: the plain average beat individual sources 69% of the time). Weighting by past accuracy adds nothing — equal weights won 64% of the time.
2. **Projections are optimistic and over-spread.** Calibration slopes are below 1 (QB 0.67, TE 0.72, RB 0.79, WR 0.85). The real gap between a source's #1 and #5 is smaller than printed. Shrinking toward the positional mean is free accuracy.
3. **Vegas beats projections where it applies.** Implied team totals are the strongest single signal for D/ST and are competitive at QB.
4. **Injury tags convert to probabilities**: Questionable played 71% (2017–23), Doubtful sat 94%. Practice trend (DNP→LP→FP) beats the tag. Body-part matters: QB high-ankle averages 3.7 weeks missed.
5. **Opportunity predicts better than production.** Snap share, target share, WOPR and expected fantasy points (xFP) lead box scores by 1–2 weeks; TD rate over expectation is the canonical sell-high signal.
6. **Defense-vs-position is weak** (~0.07–0.13 PPG per rank spot; zero for TE; top-5 defenses repeat 20–30%). Offensive environment matters ~3x more. Matchup should be a tiebreaker, not a driver.
7. **Variance is a sticky trait** (CV: TE 0.63, WR 0.58, RB 0.54, QB 0.36) and it helps the underdog. Weekly scores are right-skewed with a floor near zero — gamma-like, not normal.
8. **A first-round bye roughly doubles title odds** in a 6-team bracket. Seeding, not season points, is the objective that matters in November.
9. **Crowd trade values diverge from projection values by 10–20% per player.** That gap is the trade edge, and FantasyCalc exposes it as open JSON keyed on `espnId`.

## The ideas

Grouped by theme. Each carries an impact/effort call and what it needs.
**★** marks the ones I'd build first.

### A. Point the engine at the right objective (no new data)

**A1 ★ Win-probability scoring.** Fill `win`. Per week, team mean and sigma
already exist; the opponent's do too via the schedule. P(win) is a normal-CDF of
the difference. Score trades on Δ expected wins for `reg`, and Δ P(playoffs),
Δ P(bye), Δ P(title) via the season Monte Carlo with common random numbers
(same seed, baseline vs post-trade, so the delta isn't swamped by MC noise).
This is what turns "+4.2 points a week" into "+11% bye odds". Impact: highest
in the list. Effort: medium; the pieces exist.

**A2 ★ Objective toggle** (already specced): Championship / Seeding / Balanced.
Ranks the same trade list by A1's deltas instead of points. Small once A1 exists.

**A3 Week leverage.** Not every week is worth the same. A week you're 85% to win
or 15% to win is low leverage; a 50/50 week is where a point buys the most win
probability. Compute per-week leverage from A1 and show trades that help the
weeks that decide your seed. Also tells you when to seek variance (underdog) or
avoid it (favorite) — see D2.

**A4 Projection shrinkage.** Apply the measured calibration slope per position
to ESPN projections before anything else sees them. Then measure our own slope
over the season (H2) and replace the literature number with a league-scored one.
Trivial code, real accuracy.

**A5 Enforce `positionLimits`.** A bug, not a feature. A trade that lands you
five RBs in a 4-RB league is not legal and shouldn't be suggested.

### B. Availability: injuries, suspensions, returns (rosters are not frozen)

**B1 ★ Play probability per player-week.** Map ESPN `injuryStatus` (already in
our payload: ACTIVE/QUESTIONABLE/DOUBTFUL/OUT/IR/SUSPENSION) plus Sleeper's
`practice_participation`/`practice_description` to a probability: roughly
Q 0.71, D 0.06, O/IR/Sus 0 for this week, refined by practice trend. Feed the
lineup solver a *mixture*: expected lineup value = Σ over availability draws of
the optimal lineup. The matroid solver already handles the "starter is out, bench
guy slides in" case — that's exactly what makes bench depth worth something in
the score. Sleeper `/v1/players/nfl` is free, CORS-open, 5 MB, cache daily.

**B2 Expected return week and ROS discount.** For OUT/IR players, an expected
games-missed prior from body part (Sleeper `injury_body_part`,
`injury_start_date`) and the re-injury tables: high-ankle ≈ 3.7 wks, low-ankle
2.3, shoulder 3.4. The `playoff` window then correctly values a stash who's
back for week 15 and correctly zeros one who isn't. This is also the
**IR-stash finder**: free agents with zero `gain` but positive `playoff`.

**B3 Durability prior.** Position × age × recent injury-history hazard rate
applied as a per-week survival curve to every player's ROS windows. RBs miss
the most; a 28-year-old RB's `full` value should be discounted more than a
25-year-old WR's. Draft Sharks does this with 300 variables; we can get most of
the signal from position, age, and prior-season games missed (nflverse
`injuries`, Sleeper fields). Honest framing: a prior, shown as such.

**B4 Suspension and news flags.** No public suspension feed exists, but three
free signals cover it: ESPN `injuryStatus: SUSPENSION`, Sleeper `Sus`, and text
from RotoWire's RSS (`ACAO: *`) plus ESPN's athlete `overview` blurbs
(CORS-open). Keyword-classify headlines (suspend, appeal, arrest, holdout,
designated to return, benched, committee) into flags shown beside every player
in a suggested trade, with a per-player manual devalue slider the user controls.
Don't attempt full NLP; surface the news and let the human weigh it. The trade
list should never recommend acquiring someone whose headline says "facing
suspension" without saying so.

**B5 Handcuff value, computed.** With B1/B3, the value of your RB2 conditional
on your RB1's injury hazard is a real number, not a vibe. Rank bench players by
insurance value; rank free agents the same way.

### C. Better projections

**C1 ★ Multi-source aggregate.** ESPN (league-scored) + Sleeper/RotoWire weekly
projections (`api.sleeper.app/projections/nfl/{season}/{week}`, CORS-open,
includes `rec_tgt`/`rush_att` so we can re-score to league settings) +
FantasyPros ECR via DynastyProcess mirror on `raw.githubusercontent.com`
(`fp_latest_weekly.csv`: `ecr`, `sd`, `r2p_pts`, CORS-open) + ffverse
`ff_opportunity` xFP. Equal-weight, per research. Show disagreement between
sources as an uncertainty band — a player the sources fight about is a
different kind of asset than one they agree on. Join key is `espn_id`, present
in all four.

**C2 Vegas implied team totals.** ESPN's own core API
(`sports.core.api.espn.com/.../events/{id}/competitions/{id}/odds`, `ACAO: *`)
gives spread and O/U per game; implied total = (O/U ∓ spread)/2. Use it to
(a) drive D/ST and K projections, where it's the best signal in existence,
(b) nudge QB/team pass-catcher projections for the current week, and (c) feed
the streaming planner (F3). Only meaningful for the current and next week —
lines don't exist further out.

**C3 Usage-based regression signals.** This is the honest version of
sell-high/buy-low (specced). Pull weekly snap share, targets, air yards from
Sleeper `/stats/nfl/{season}/{week}` (`off_snp`, `tm_off_snp`, `rec_tgt`,
`rec_air_yd` — CORS-open, no GitHub needed) and xFP from ffverse. Sell-high =
points well above xFP and TD rate above expectation on stable-or-falling usage.
Buy-low = WOPR/snap share rising, output lagging. Rank your roster's sell
candidates and the league's buy candidates, then hand them to the trade search
as preferred sides.

**C4 Playoff-week matchup, as a tiebreaker.** The literature says DvP is weak,
so implement it as a small, transparent adjustment: offensive environment
(team pace and implied totals when available, season points-for otherwise)
weighted ~3x over defense-vs-position, applied only to weeks 15–17 and shown
as a separate column so nobody mistakes it for signal.

**C5 Weather.** Open-Meteo / api.weather.gov (both free, keyless, CORS-open) plus
a 30-row stadium table. Only wind > 15 mph and heavy precipitation have
measurable effects, mainly on K and deep passing, and only game week. Low
priority; cheap; nice for the weekly lineup view (D3).

### D. Distributions, boom/bust, correlation

**D1 Skewed per-player distributions.** We already measure residual sigma from
prior-season actuals. Upgrade from normal to a right-skewed fit (gamma or
lognormal on the residual), treat CV as a sticky per-player trait shrunk toward
the positional CV, and show P10/P50/P90 per player and per lineup. "Floor /
ceiling" in every other tool is a guess; ours would be measured.

**D2 Correlation flags and covariance** (specced). Same-team QB–WR/TE stacks and
same-game pairs add covariance to the team sigma. Flag them; feed the covariance
into A1 so the win probability is right. Then the recommendation follows from A3:
stack when you're the underdog, diversify when you're the favorite.

**D3 Weekly lineup for P(win), not E[points].** A new surface: this week's
matchup, both lineups, both distributions, and the lineup that maximises win
probability given the opponent — which sometimes benches the higher-mean player
for the higher-variance one. Needs `mMatchup` for the opponent's roster (we
already pull it). This is the feature people would open every Sunday morning.

### E. Market awareness and getting trades accepted

**E1 ★ FantasyCalc market layer.**
`api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=N&ppr=P`
is free, keyless, CORS-open, refreshed daily from real completed trades, and
carries `espnId`. Two uses: (a) show every suggested trade's *market fairness*
alongside our lineup delta, so we prefer trades the partner's gut will accept;
(b) an **arbitrage list** — players where our projection-derived value exceeds
market value (buy) or trails it (sell). The gap between market and model is the
whole trade edge, and this makes it visible for one fetch.

**E2 Partner-need modelling.** We already show what a partner gives up. Add
their bye-week and injury holes for the coming weeks (from B1), their
`positionLimits` headroom, and their FAAB/waiver position. Rank partners by how
badly they need what you have *this week*. Sell into bye clusters; buy after
them; know the league trade deadline from settings and the NFL deadline date.

**E3 Manager behaviour.** The league's transaction history (ESPN `mTransactions2`
/ communication views) tells you who actually trades, how often, and how
recently they logged an action. A perfect trade with a manager who hasn't
opened the app since draft night is worth zero. Rank partners by
responsiveness; badge the dormant ones.

**E4 Pitch generator, improved.** The Copy-pitch already exists. Feed it the
partner's gains in *their* windows, the market-fairness number, and the
usage/news facts, so the pitch reads like a case rather than a printout.

### F. Waivers and roster construction

**F1 ★ Replacement level and 2-for-1 consolidation** (specced; unblocked). The
best available free agent per slot *is* replacement level, and our engine
computes it exactly. 2-for-1s graded by lineup delta with waiver backfill is
what every other tool approximates with a 20% consolidation haircut.

**F2 Crowd-vs-engine waiver finder.** Sleeper `/players/nfl/trending/add`
(24-hour counts across all Sleeper leagues) tells you what the crowd is
grabbing. Cross it with our lineup delta: players high on our list and low on
the crowd's are the adds you can make on Wednesday without a bidding war;
players high on both need an aggressive FAAB bid. ESPN gives FAAB budgets per
team in `mTeam`, so we can also estimate what the bid needs to be.

**F3 Streaming planner (K / DST / QB / TE).** For each streamable slot, value
free agents over "this week + next two" using Vegas implied totals (C2) and
the schedule, so you can hold a streamer through a good stretch instead of
churning weekly. Subvertadown's approach; D/ST is the most predictable
streamable position precisely because Vegas lines are.

**F4 Drop candidate ranking.** The mirror of the add list: each bench player's
marginal contribution across all windows including insurance value (B5).
"Who do I cut for this pickup?" answered with a number.

**F5 Breakout detector.** Week-over-week snap-share jump ≥ 15 points, route
participation rise, depth-chart order change (Sleeper `depth_chart_order`, ESPN
depth charts), a teammate landing on IR. These lead box scores by a week or two,
which is exactly the window in which a waiver add is still free.

**F6 FAAB bid advisor.** Given the lineup gain of an add, the crowd trending
count, remaining budget across the league, and the research finding that spending
75–80% early on a true breakout wins finals, suggest a bid range and an
off-round number.

### G. Season simulation upgrades

**G1 Non-frozen rosters in the Monte Carlo.** Draw player availability (B1/B3)
each simulated week and backfill from replacement level (F1). Today the sim
assumes every starter plays every week, which flatters deep-and-fragile rosters
and punishes teams with good benches.

**G2 Opponent scouting view.** Each future opponent's projected lineup and
distribution for the week you play them, with their bye exposure. Makes A3's
leverage number concrete.

**G3 Division seeding, resolved.** ESPN doesn't tell us whether division winners
seed top; the toggle exists and defaults to record. Open item — only Josh knows
the league rule. Once set, persist it per league.

### H. Infrastructure that makes the above possible

**H1 Data layer.** One module per source with TTL caching in `chrome.storage` /
IndexedDB (Sleeper asks for at most one 5 MB player pull per day), an `espn_id`
crosswalk, `optional_host_permissions` for anything not CORS-open (nflverse
release assets, KeepTradeCut), and graceful degradation: every feature must work
with ESPN alone and get better as sources come online. Sources break every
season; the engine must not.

**H2 ★ Self-calibration log.** Every week, store each source's projection and
the actual league-scored result for every rostered and top-400 free-agent
player. After a few weeks we have *this league's* calibration slope, per-source
bias, and per-player residual variance under the league's scoring — the thing no
external tool can have. Feeds A4, C1 weights (if they ever justify weighting),
and D1. Cheap to build, compounding in value, and unique.

**H3 Explainability everywhere.** Every recommendation lists its drivers —
projection, availability, market, usage, news — with the number each
contributed. The user should be able to disagree with one input and see the
recommendation change. This is the antidote to the black-box "Trade Grade: B+".

## Suggested order

Build order chosen so each step is useful alone and the next one gets cheaper:

1. **A5, A4** — enforce `positionLimits`, shrink projections. Half a day, fixes a bug and improves accuracy.
2. **A1 → A2** — win probability and the objective toggle. Biggest change in what the tool *means*; no new data.
3. **B1** — availability from ESPN `injuryStatus` (already fetched) then Sleeper practice reports. Rosters stop being frozen.
4. **E1** — FantasyCalc market layer. One fetch; makes suggestions acceptable to humans.
5. **F1** — replacement level and 2-for-1 (specced, unblocked).
6. **H1 + C1** — the data layer and the multi-source aggregate.
7. **C3** — usage-based sell-high/buy-low (the specced feature, done properly).
8. **H2** — start the calibration log early so the data exists by midseason.
9. **C2 + F3** — Vegas totals and the streaming planner.
10. **D1, D2, D3** — distributions, correlation, weekly P(win) lineup.
11. **B2–B5, F2, F4–F6, E2–E4, G1–G2, C4, C5** as appetite allows.

## Things deliberately not on the list

- **An LLM advisor.** Every competitor has bolted one on; none publish methodology and all are wrappers over a projection layer. Our edge is exact arithmetic with visible drivers. Revisit only for B4's headline classification, and even there keywords are probably enough.
- **Scraping FantasyPros, CBS, NFL.com, KeepTradeCut.** ToS grey areas that break every September. The CORS-open, keyless sources above cover the same ground.
- **Dynasty/keeper value.** Out of scope per the original spec.
- **Any backend.** Every source listed is reachable from the extension page. Privacy stays as it is.

## Open items carried forward

1. **Public league data in `docs/superpowers/`.** Team names and rosters of leaguemates are in a public repo. Low stakes, but it's their data; one scrub command when you decide.
2. **Division seeding rule** (G3) — only you know it.
3. **`CLAUDE.md` names `engine/swaps.js`**, which doesn't exist; the swap table is in `search.js`. Minor doc fix.

## Appendix: sources

Projection accuracy and aggregation — FFA 12-season study:
https://fantasyfootballanalytics.net/2026/08/we-analyzed-12-seasons-of-fantasy-football-projections-heres-what-we-found.html ;
positional bias: https://fantasyfootballanalytics.net/2025/07/fantasy-football-projections-exploring-positional-bias-in-projections.html ;
Vegas vs rankings: https://www.parlaysavant.com/insights/can-vegas-betting-lines-beat-the-best-fantasy-rankings ;
Subvertadown accuracy: https://subvertadown.com/article/final-accuracy-report-2025

Variance — Underdog CV by position: https://underdognetwork.com/football/best-ball-research/weekly-variance-by-position-a-key-to-best-ball ;
PlayerProfiler variance manifesto: https://www.playerprofiler.com/article/the-player-variance-manifesto/ ;
Footballguys expectation/variance: https://www.footballguys.com/article/DFS_expectationvariance ;
stacking counterpoint: https://oneweekseason.com/exposing-the-fallacies-of-stacking-in-best-ball-and-redraft/

Injuries — Draft Sharks model: https://www.draftsharks.com/injury-predictor/about ;
Q vs D conversion: https://www.footballguys.com/article/2024-injury-index-chance-to-play-questionable-vs-doubtful ;
re-injury by type: https://www.footballguys.com/article/2025-fantasy-performance-reinjury-rate-by-position ;
RB workload: https://www.footballguys.com/article/2025-running-back-milage-myth-what-numbers-say-about-workload-injuries

Usage — POP model: https://www.thefantasyfootballers.com/analysis/players-who-pop-a-new-method-for-predicting-fantasy-football-scoring/ ;
ffopportunity: https://github.com/ffverse/ffopportunity ;
WOPR: https://statrankings.com/nfl/advanced/players/receiving/weighted-opportunity-rating ;
snap share: https://fantasyprojectionlab.com/snap-count-analysis-fantasy-projections/

Matchups — 4for4 defense repeatability: https://www.4for4.com/2025/preseason/do-defenses-repeat-fantasy-football-performances ;
Fantasy Footballers matchup regression: https://www.thefantasyfootballers.com/articles/the-fantasy-football-mythbusters-making-the-most-of-matchups/

Waivers/trades — FAAB: https://www.4for4.com/2025/preseason/ultimate-guide-waiver-wire-faab-strategy-2025 ;
consolidation: https://www.footballguys.com/article/2023-ultimate-guide-to-trades ;
playoff randomness / bye value: https://www.thefantasyfootballers.com/articles/the-fantasy-architect-how-to-reduce-playoff-randomness-in-your-league/

Competitors — IBM/ESPN grades: https://newsroom.ibm.com/2023-09-13-IBM-Brings-watsonx-to-ESPN-Fantasy-Football-with-New-Waiver-Grades-and-Trade-Grades ;
Yahoo Trade Hub: https://help.yahoo.com/kb/SLN7004.html ;
FantasyPros waiver assistant: https://www.fantasypros.com/nfl/myplaybook/waiver-wire-assistant.php ;
Draft Sharks tools: https://www.draftsharks.com/kb/best-fantasy-football-tools ;
4for4 trade evaluator: https://www.4for4.com/optimized-top-150-player-trade-evaluator ;
ETR trade values: https://establishtherun.com/nfl-redraft-trade-calculator/ ;
RotoViz GLSP: https://www.rotoviz.com/weeklyglsp/ ;
Subvertadown: https://subvertadown.com/article/subvertadown-overview ;
KeepTradeCut FAQ: https://keeptradecut.com/frequently-asked-questions

Data — ESPN player views: https://thomaswildetech.com/projects/espn/player-info-json-views/ ;
ESPN endpoints gist: https://gist.github.com/nntrn/ee26cb2a0716de0947a0a4e9a157bc1c ;
Sleeper API: https://docs.sleeper.com/ ; undocumented Sleeper endpoints: https://github.com/joeyagreco/sleeper/discussions/11 ;
nflverse schedule: https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html ;
GitHub release-asset CORS: https://github.com/orgs/community/discussions/45446 ;
DynastyProcess mirror: https://github.com/dynastyprocess/data ;
FantasyCalc: https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1 ;
FantasyPros API: https://www.fantasypros.com/api-data/ ;
The Odds API: https://the-odds-api.com/ ; Open-Meteo: https://open-meteo.com/ ;
NWS CORS: https://github.com/weather-gov/api/discussions/312 ;
DraftKings API notes: https://github.com/SeanDrum/Draft-Kings-API-Documentation ;
RotoWire RSS: https://www.rotowire.com/rss/
