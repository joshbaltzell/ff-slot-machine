# Phase 9 — Availability depth: return weeks, durability, news flags, handcuffs, non-frozen sim

Status: approved for build (Josh, 2026-08-27). Covers brainstorm B2, B3, B4, B5, G1.
Follow `2026-08-27-parallel-phase-rules.md` (wave 3: this phase owns `season.js` and
`availability.js`).

## Why

Phase 2 zeroes an OUT/IR player for the horizon and weights a Questionable one for
this week. That is right for today and wrong for November: a player back in week 15
is worth a lot in the `playoff` window and nothing in `gain` — the IR-stash case. A
28-year-old RB's remaining-season value should carry a higher injury hazard than a
25-year-old WR's. Headlines about suspensions and holdouts should be visible next to
any recommendation. And the season sim should draw availability like it draws
scores, so a deep bench is worth something in the odds.

## Return weeks — `availability.js`

`RETURN_WEEKS` table by `injury_body_part` (Sleeper) with median weeks missed and an
80% range (from the Footballguys re-injury tables cited in the brainstorm: high ankle
3.7, low ankle 2.3, shoulder 3.4, hamstring 2.5, knee (non-ACL) 4, ACL/Achilles rest
of season, concussion 1.2, default 3). `expectedReturn(player, currentWeek)` uses
`injury_start_date` when present; IR designations add ESPN's 4-game minimum. Output:
per-week `p` ramps from 0 to 1 across the 80% range (a CDF), not a step. Suspension:
parse a game count from `injury_notes`/ESPN news text (`/suspended (\d+) games?/i`);
absent that, 4 weeks with a low-confidence flag.

`buildAvailability` uses these instead of the Phase 2 zero-for-horizon rule for
IR/OUT/SUS players. **IR-stash finder**: free agents with `gain ≤ 0.05` and
`playoff ≥ 0.5` from `freeAgentUpgrades` run over the playoff window; new grid.

## Durability prior — `durability.js`

Per-week hazard `h(pos, age)` from a small table (RB 0.055/wk, WR 0.035, TE 0.04, QB
0.025, K/DST 0.005; +25% for age ≥ 28 at RB, ≥ 30 elsewhere; +25% if games missed last
season ≥ 4 from `rawStats` weeks with actual 0 and projection > 1). Survival
`S(k) = Π(1 − h)` multiplies future-week availability. Applied behind a toggle
`ffsm.durability` (default on) and shown as a `Dur.` column (expected games missed
over the horizon). Constants in one table; the hint says it is a prior.

## News flags — `sources/news.js` + `availability.js`

RotoWire RSS `https://www.rotowire.com/rss/news.php?sport=NFL` (CORS-open, XML via
`DOMParser` in the page; a tiny regex fallback under node) and ESPN athlete overview
`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{id}/overview`
(CORS-open) for players on my roster and in any shown trade. Keyword classifier over
title+description: `suspend|appeal` → SUS, `arrest|charged` → LEGAL, `holdout|hold out|trade request` → HOLDOUT,
`designated to return|activated` → RETURNING, `benched|committee|demoted` → ROLE,
`IR|season-ending|torn` → INJ. Match RSS items to players by full-name match within
the league's player set. Output `flags: Map<espnId, [{kind, headline, at, url}]>`.
Per-player **devalue slider** (0–100%, persisted `ffsm.devalue.{id}`) multiplies that
player's projections before the engine; flags shown as badges with the headline on
hover. No LLM; keywords only.

## Handcuff value — `availability.js`

`handcuffValue(eng, team, backup)` = `E[lineup | starter out] − E[lineup | starter in]`
weighted by the starter's hazard over the horizon, for same-NFL-team same-position
pairs. Shown in the roster grid as **Insurance** and in the drop-candidate grid (Phase 4)
so a handcuff is not cut for a marginal add.

## Non-frozen sim — `season.js`

`projectSeason` gains `avail: Float64Array(n·NW)` and `lineupOf(ids, availDraw, w)`
injection: for each sim and week, draw each uncertain starter's availability, and
score the team with the optimal lineup given the draw (use the engine's `weekly`
mixture already computed for the mean; for the sim, draw one outcome and use the
precomputed value table `valueByOutcome` for the current week and `S(k)`-thinned
projections for later weeks). Keep the draw count fixed per sim so CRN holds:
pre-draw a uniform per (team, week) and threshold it. Document in CLAUDE.md.

## UI — `extension/panel/availability-depth.js`

Stash finder grid; `Dur.`/`Insurance` columns; news badges + devalue slider in the
roster grid and trade detail; toggles; log lines; degrade paths.

## Tests — `extension/test/availability-depth.mjs`

Return CDF ramps and respects IR minimum; suspension parse; durability survival
arithmetic and age bump; news classifier on ~12 synthetic headlines incl. negatives;
name matching ignores case/punctuation; handcuff value positive for a real backup and
zero for a different position; sim with avail draws keeps CRN (identical runs
identical; +avail for one team never lowers its wins); stash finder returns the
week-15 returner and not the season-ender.
