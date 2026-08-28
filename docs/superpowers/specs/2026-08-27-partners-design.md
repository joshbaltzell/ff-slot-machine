# Phase 10 — Partners: need modelling, manager behaviour, opponent scouting, division seeding

Status: approved for build (Josh, 2026-08-27). Covers brainstorm E2, E3, G2, G3.
Follow `2026-08-27-parallel-phase-rules.md` (wave 3: this phase owns `league.js` additions).

## Why

A perfect trade with a manager who has not opened the app since draft night is worth
nothing. A partner with two starters on bye next week will accept a deal this week
that they would laugh at in two. And the leverage strip says which weeks matter; the
opponent view says why.

## Data — `league.js`

- `loadTransactions(ref)` — `view=mTransactions2` (and `view=kona_league_communication`
  when present): per team, counts of trades proposed/accepted/rejected, waiver claims,
  lineup changes, and the most recent activity timestamp. Degrades to nulls.
- `loadLeague` records `team.faabRemaining`, `team.waiverRank` when present.
- Division seeding: persist `ffsm.divSeed` (exists) **per league** —
  key `ffsm.divSeed.{leagueId}` — and show the chosen rule in the season header.

## Partner need — `extension/engine/partners.js`

`partnerNeeds(eng, model, avail, week)` per team: bye-thinned starters next 2 weeks
(from `thin` and `avail`), injured starters (`p < 1`), `positionLimits` headroom by
position id, weakest starting slot (lowest starter value), FAAB remaining.
`partnerScore(myTeam, other, trades)` = the other side's best `gain` among mutually
beneficial trades × urgency (bye/injury holes this week 1.5×) × responsiveness.

## Manager behaviour — `partners.js`

`responsiveness(tx)` in [0,1]: 1 for activity in the last 7 days, decaying to 0.2 at
28+ days; trades accepted / proposed ratio nudges ±0.2; never zero (someone may wake
up). Badge: `active`, `quiet`, `dormant`.

## Opponent scouting — `extension/engine/scouting.js`

For each remaining regular-season week: opponent, their optimal lineup that week
(names, projections), their `teamSigma`, my P(win) (exists), their bye/injury exposure
that week. `scoutWeek(eng, model, myTeam, w)`.

## UI — `extension/panel/partners.js`

- New section **Trade partners** ranked by `partnerScore`: team, responsiveness badge,
  holes this week, best mutual offer (links to the row), FAAB remaining.
- Leverage strip cells (Phase 1) become clickable → expands the **Opponent view** for
  that week (their lineup, spread, exposure).
- Season header shows the seeding rule; the toggle persists per league.
- Loading step "League activity"; log lines; degrade to badges of `unknown`.

## Tests — `extension/test/partners.mjs`

Responsiveness decay and clamps; `partnerNeeds` finds the bye-thinned team in the
fixture-derived model with a synthetic schedule and synthetic avail; `partnerScore`
ordering; `scoutWeek` returns the opponent named by `eng.opp` and a lineup summing to
their baseline; per-league divSeed key; transactions parser on a synthetic payload
with degraded fields.
