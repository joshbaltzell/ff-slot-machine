# Phase 5 — Projections: multi-source aggregate and the calibration log — build report

**Status:** complete, reviewed, not merged and not pushed.
**Branch:** `phase5-projections`
**Worktree:** `/Users/joshbaltzell/Documents/GitHub/FF Trade Identifier/.claude/worktrees/agent-a3baf012abeb295ed`
**Base (merge-base with `main`):** `33ab692`
**Head:** `02f80e3`
**Spec:** `docs/superpowers/specs/2026-08-27-projections-design.md` (binding)
**Parallel-work rules:** `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md` (binding)
**Plan:** `docs/superpowers/plans/2026-08-27-projections.md`
**Process:** `superpowers:subagent-driven-development` — fresh implementer per task, a spec+quality
review after each, fix loops, one whole-branch review, one fix wave, one scoped re-review.

## What shipped

Two features, both behind the existing panel:

**The aggregate.** ESPN's projections are averaged with Sleeper/RotoWire weekly projections and
FantasyPros ECR (via the DynastyProcess CSV mirror). External sources are not league-scored, so
raw points are never averaged with ESPN's: each source becomes a fraction of its own positional
mean, the fractions are averaged, and the result is multiplied back by ESPN's positional mean.
Nothing but league-scored points ever reaches `p.proj`. A disagreement band — the population
standard deviation of those fractions, in points — surfaces as a `±` column on the roster grid and
a `±N.N` tag on acquired players. A `Sources` chip group toggles it (`ffsm.aggregate`, default on).

**The calibration log.** Each run stores one row per rostered player for the current week —
`{id, pos, week, espn, sleeper, fp, agg}` — under `ffsm.calib.{leagueId}.{seasonId}`. On later runs
past weeks' actuals are joined from ESPN's own `rawStats` and the within-week OLS slope of actual on
projection is fitted per position. Once six weeks have actuals and a position has twenty pairs, the
fitted slope replaces the literature constant in `CALIBRATION_K`. A new **Calibration** section shows
MAE, bias, slope and n per source × position, and says which slopes are in use.

## Commits

| SHA | Subject |
|---|---|
| `cc6e46c` | Plan the multi-source aggregate and the calibration log |
| `eddf4b3` | Add a CSV reader for the DynastyProcess feeds |
| `e1856fd` | Add Sleeper's weekly projections as a second source |
| `56296a1` | Add FantasyPros ECR as a third source |
| `0f3d3bf` | Document and test the FantasyPros week fail-open |
| `101cacb` | Average projection sources through positional fractions |
| `56464fa` | Measure this league's own calibration slopes |
| `0988871` | Arm the seasonId decoy, and cover mergeSlopes |
| `dadf651` | Add the panel module for projection sources and calibration |
| `f9e4edc` | Fix the Aggregate chip no-op and guard the aggregate call |
| `f1895f5` | Show the aggregate, the disagreement band and the calibration log |
| `ac0090f` | Record why external points are normalized, not averaged |
| `02f80e3` | Stop losing the calibration log, and fit the slope it earns |

Files added: `extension/engine/sources/csv.js`, `sources/sleeperproj.js`, `sources/fantasypros.js`,
`extension/engine/aggregate.js`, `extension/engine/calibration.js`, `extension/panel/projections.js`,
`extension/test/projections.mjs`. Modified: `extension/panel.js` (wiring only, 31 insertions),
`CLAUDE.md`.

Untouched, verified by `git diff --name-only 33ab692..HEAD`: `extension/engine/search.js`,
`extension/engine/season.js`, `extension/test/parity.mjs`, `extension/panel.css`,
`extension/engine/league.js` — zero files in that path list changed.

## Final test output

```
$ node extension/test/run-all.mjs

=== parity.mjs ===
slots: 9 starters/week  [1, 2, 2, 4, 4, 6, 16, 17, 23]
  per-trade odds: 28 ms per trade at 2000 sims

605 assertions, 0 failures
ENGINE OK — reproduces the verified baseline exactly

=== projections.mjs ===

201 assertions, 0 failures
PROJECTIONS OK

=== sources.mjs ===

14 assertions, 0 failures
SOURCES OK

3 files, 0 failing

$ node --check extension/panel.js
(clean)
```

`parity.mjs` is byte-identical to the merge-base and still reports 605/0. Phase 5 added 201
assertions in `projections.mjs`, all offline: every fetch, storage and clock is injected.

## Rulings, in the order they were made

Each is a decision taken without a human, with what it costs if it was wrong.

**1. Branch base.** `phase5-projections` was created at `33ab692`, not at the worktree's original
HEAD `3c15bf5`. The worktree was provisioned from `origin/main`, which is 19 commits behind local
`main`; none of Phase 5's inputs (`calibrate.js`, `sources/`, `run-all.mjs`, the specs) exist at
`3c15bf5`, and the sibling phase 2 and phase 3 worktrees are both at `33ab692`. HEAD was a strict
ancestor with no unique commits and a clean tree, so nothing was discarded.
*Cost if wrong:* the branch is based on a commit the integrator did not intend and needs rebasing.
Cheap, and verifiable from the sibling worktrees.

**2. FantasyPros week fail-open (Task 3).** A row with a missing or unparseable `week` cell is kept
for every requested week rather than dropped. `fp_latest_weekly.csv` may legitimately carry no
`week` column at all — it is by definition the latest week — and failing closed would drop every
row and silently disable the whole source. The behaviour stands; what was missing was that the
choice was undocumented and untested, so the fix round added a comment and tests, not a change.
*Cost if wrong:* one stale row's ECR enters a positional mean that is refetched every six hours and
normalized by that same mean. Visible in the `±` band, reversible in one line.

**3. The `seasonId` decoy test was inert (Task 5).** The reviewer mutation-proved it: deleting
`&& x.seasonId === seasonId` from the filter left the suite green, because every decoy sat after
the true row so `.find()` never reached them. `CLAUDE.md` names this filter as the codebase's most
expensive documented mistake (~15% low). A test that cannot notice its reintroduction is worse than
no test. Decoys reordered ahead of the true row; all three conjuncts now mutation-fail.
*Cost if wrong:* none. Strictly increases test strength, no production change.

**4. `fitSlopes` returns slope only (Task 5).** The fitted intercept is measured, displayed, and
deliberately discarded. `shrinkProjections` re-centres on the projected positional mean, which is
exactly `CALIBRATION_K` semantics; applying a level shift would move every player's absolute points
and so every trade's headline value, which the spec did not ask for. Recorded as a decision in the
docstring rather than left as an accident.
*Cost if wrong:* a systematic level bias in this league's projections goes uncorrected. It stays
visible in the Calibration grid, so a human can see it and we can revisit deliberately.

**5. Rows with `proj <= 0` are skipped (Task 5).** Correct, no change. The filter conditions on `x`,
the regressor, and selection on the regressor does not bias an OLS slope. Excluding byes and
inactives also avoids a mass point at the origin dragging the slope toward 1.
*Cost if wrong:* none identified.

**6. Old league-season storage keys are never pruned (Task 5).** Real but minor; carried forward to
Task 8 as an explicit documented limitation in `CLAUDE.md` so it could not fall off. Later reduced
by roughly 70% as a side effect of ruling 10.
*Cost if wrong:* housekeeping debt accumulates in `chrome.storage.local` for a user who plays many
league-seasons. Small rows; `unlimitedStorage` is granted.

**7. The Aggregate chip was a no-op (Task 6).** `if (on === (window.__aggregate !== false)) return;`
evaluates `(undefined !== false)` as `true`, so clicking **Aggregate** did nothing while **ESPN
only** worked — a one-way switch. The brief specified that line verbatim and it copies the file's
existing `window.__calibrate` guard, and Task 7 does set the global, so the defect was latent rather
than live. Changed anyway: the module's documented interface is `(root, {storage, reload})` with no
global in it, and a module silently broken until an unrelated file assigns a global is fragile. The
guard now reads the chip's own `aria-pressed`; the global remains render-side state.
*Cost if wrong:* none in behaviour — identical when the global is set, strictly more robust when it
is not.

**8. `aggregateProjections` was the one unguarded call (Task 6).** Fixed. The spec's "nothing throws
out of `start()`" and "a source that fails leaves `agg === espn`" are binding, every other fallible
call in the same function was already guarded, and a throw left `p.proj` half-mutated.
*Cost if wrong:* a genuine aggregate bug is now logged and swallowed rather than surfacing as a
stack trace. Accepted: the `say()` line names it and the empty `±` column is visible.

**9. The `panel.js` hunk cap does not bind (Task 7).** The brief asserted
`git diff -U0 extension/panel.js | grep -c '^@@'` ≤ 8; it measured 13. The cap is a proxy for
parallel-phase rule 1, whose real requirement is *where* `panel.js` may be edited and that each edit
be minimal. The proxy is miscalibrated twice: `-U0` splits one logical edit into several headers,
and the brief's own steps name more than eight insertion points. 31 added lines across the allowed
hook points satisfies rule 1. Verification of *placement* was delegated to the task reviewer, not
waived — it confirmed every hunk sits at a named hook point with no logic smuggled in.
*Cost if wrong:* a noisier three-way merge with the phase 2 and 3 worktrees. Visible at merge time
and resolvable by hand; nothing silently breaks.

**10. "Refresh data" destroyed the calibration log (final review, Critical).** `KEEP` is a literal
list and the log's keys are dynamic, so one Refresh click deleted every accumulated week — and this
branch edited that very line to add `ffsm.aggregate`. The feature needs six weeks to produce a
fitted slope; a user who refreshes periodically never gets one and is never told why. Fixed by
enumerating the log keys by prefix.
*Cost if wrong:* Refresh now deserializes the whole extension store to filter it. One shot on an
explicit click; the alternative was silent data loss.

**11. Joined actuals were never persisted (final review, Critical).** `attachActuals` mutated the
in-memory log and the result was dropped, so an actual visible in week 6's session was gone by week
9. Fixed with a write-back inside the existing `try`.
*Cost if wrong:* one extra storage write per run on the weeks where an actual first appears.

**12. `rawStats` may not carry current-season played weeks (final review, Critical — NOT fixed).**
The final reviewer inferred, from `loadLeague` issuing eighteen separate `scoringPeriodId` requests
to collect eighteen weekly projections, that `rawStats` holds only the single week it was captured
from — which would make the actuals join permanently inert and `fitSlopes` return `null` forever.
It could not measure this offline. Deliberately not fixed: the fix means merging `rawStats` across
the per-week fetches in `engine/league.js`, and `league.js` is shared with the sibling phase 2 and 3
worktrees. Changing a shared loader on an unverified inference, in the last fix wave, was the worse
bet. Promoted to the **first** browser-verification item and a merge-coordination item.
*Cost if wrong:* the fitted-slope half of Phase 5 stays inert until someone opens a live mid-season
league and logs one player's `rawStats` scoring periods. The failure is visible rather than silent —
the Calibration section reads "Literature slopes are in use — N so far" and N would sit at 1. The
aggregate half, the larger half, is unaffected, and no wrong number is ever shown.

**13. The free-agent pool dominated the log (final review, Important).** `loadFreeAgents` (limit
400) merges into `model.players` before `runProjections`, so ~70% of every logged week was deep-bench
free agents projected 2–5 points that often score 0, outnumbering rostered players 2.5:1 and dragging
the single slope that is then applied to the top-of-position players who drive every trade. Logged
rows are now rostered-only (`p.teamId != null`, verified exact against `league.js`); the **aggregate
still covers free agents**, since they are traded for and waiver-added. This is a spec gap the
implementation followed faithfully — the spec's "every player with an ESPN projection" predates free
agents joining `model.players`.
*Cost if wrong:* the slope is fitted on ~160 rostered players a week instead of ~560 — noisier per
week, unbiased for the players it is applied to, and it reaches the 20-pair floor no later.
Reversible by deleting one condition.

**14. The OLS slope pooled weeks without demeaning (final review, Important).** `shrinkProjections`
re-centres on *that week's* positional mean, so the within-week slope is the quantity it needs; a
pooled fit mixes it with the between-week slope, which is close to 1, biasing the estimate toward
under-shrinkage — the wrong direction for a shrinkage feature. Changed to the within-week estimator.
My hesitation was that per-week demeaning with small per-week `n` adds noise; taking ruling 13 first
settles it, since each week still carries ~160 pairs. The implementer was forbidden from loosening
any existing tolerance to make it pass; the re-reviewer re-derived the estimator by hand (within-week
0.9 against pooled 1.971, implementation returned 0.9) and confirmed the pre-existing synthetic-log
and clamp tests pass unchanged.
*Cost if wrong:* the estimator changes in a way the synthetic test may not distinguish. Mitigated by
the no-loosening rule and by the added test that separates the two estimators by construction.

## Parked findings — real, not fixed, with why

**P1 — the Calibration table's Slope column no longer matches the slope in use.** `slopeOf` (pooled)
feeds the table's `slope` cell, while the note directly under it prints the within-week slope
actually applied. On real weekly-level drift the table can read ~0.98 beside an applied 0.80 with
nothing on the page explaining the difference. Display only, no engine effect, both numbers correct
for what they measure — but it is a direct consequence of ruling 14 and it is the **number one
follow-up**. Parked rather than fixed because the process allows exactly one fix wave and one scoped
re-review at this stage, and landing an unreviewed UI change was the worse risk.

**P2 — `MIN_N` counts pairs the estimator discards.** `withinWeekSlope` drops weeks with fewer than
two pairs, but the floor sums all pairs, so 19 single-pair weeks plus one 2-pair week clears the
20-pair floor and fits on 2 points. One line to fix, practically unreachable in a live log where
every position carries dozens of rows a week, and bounded by `SLOPE_CLAMP` and the six-week floor.

**P3 — `CLAUDE.md` does not name the within-week estimator.** Every sentence in it was verified
against the code by the Task 8 reviewer and remains true after ruling 14, so this is an addition
rather than a correction. A future agent could read "OLS slope of actual on projection" and assume
pooled.

**Deferred minors, triaged by the final review as fine to defer:** `pprColumn` ties resolve to the
higher-fidelity column; Sleeper rows with `pts <= 0` are dropped as bye/inactive markers; `coverage`
counts players a source actually influenced rather than raw feed presence; no direct test for a
position group with fewer than two live players; `onProgress` is wired to Sleeper only; a failed
`storage.set` on the Sources toggle is swallowed; `runProjections`'s prologue runs outside a `try`;
the off-season fallback aggregates already-played weeks. One deferred finding was **closed as not a
defect**: the claim that a literal `\r` inside a quoted CSV field is stripped is wrong — the quoted
branch precedes the `\r` skip, verified.

**Not caused by this branch, recorded for the merge:** `MIN_N`'s floor is untested at head *and* at
base (setting `MIN_N = 0` leaves both green); `ffsm.dismissed.{leagueId}`, `background.js`'s key, is
still wiped by Refresh.

## Browser verification — nothing below has been checked

This environment has no browser. Every UI and live-feed claim in this phase is unverified.
Load unpacked via `chrome://extensions` → Developer mode → Load unpacked → `extension/`.

**Check this one first — it decides whether half the phase works at all:**

- [ ] In a live mid-season league, log
      `p.rawStats.filter(s => s.seasonId === seasonId && s.statSplitTypeId === 1).map(s => s.scoringPeriodId)`
      for one rostered player. If that is a single period rather than every played week, the actuals
      join is inert and `engine/league.js` needs `rawStats` merged across its per-week fetches —
      raise it as a merge-coordination item (ruling 12).

**The feeds:**

- [ ] The Sleeper projections URL returns rows; confirm the endpoint has no `/v1` and that
      `stats.pts_half_ppr` exists.
- [ ] `fp_latest_weekly.csv` still has an `r2p_pts` column, and confirm which id column it uses
      (`fantasypros_id`, `fp_id`, or `id` — the code probes, the tests use `fp_id`).
- [ ] `db_playerids.csv` still carries literal `fantasypros_id` and `espn_id` columns (hardcoded,
      not probed).
- [ ] Confirm whether the live weekly file has a `week` column at all, and whether any row carries a
      malformed week value (this is what the fail-open of ruling 2 exists for).
- [ ] Both URLs are still CORS-open from an extension page — no auth or redirect added.
- [ ] A live pull produces a non-trivial `byEspn.size`, not `available: true` with a handful of
      entries from id mismatches.

**The panel:**

- [ ] The "Projection sources" step runs, shows progress, and reports Sleeper/FantasyPros coverage.
- [ ] The coverage log line names a plausible number of players — hundreds, not zero and not six.
- [ ] With both feeds unreachable (offline, or block `api.sleeper.app` and
      `raw.githubusercontent.com`), that step renders **warn**, not done, and nothing stalls.
- [ ] The `±` column shows plausible values (roughly 0.5–4 pts) and `—` for uncovered players.
- [ ] The `±N.N` tag composes correctly into acquired-player rows in the trade detail.
- [ ] Toggling Sources to "ESPN only" reloads, fetches nothing, and blanks the `±` column; toggling
      back to Aggregate works too (this is the bug of ruling 7 — check both directions).
- [ ] The Calibration section renders and sorts by clicking column headers; in week 1 it says
      literature slopes and shows the "Nothing measured yet" empty state.
- [ ] After six played weeks — or with a hand-seeded log — it switches to fitted slopes and the
      `start()` log line says so.

**Storage:**

- [ ] With a `ffsm.calib.{leagueId}.{seasonId}` key present, click **Refresh data** and confirm via
      `chrome.storage.local.get(null)` that the log key survives alongside `ffsm.myTeam`,
      `ffsm.objective`, `ffsm.calibrate`, `ffsm.divSeed` and `ffsm.aggregate`, that the
      `ffsm.league.*` cache is gone, and that the panel reports the same "N weeks stored" after the
      reload. **This is the one fix in the whole phase with no automated cover** (ruling 10).
- [ ] The Sources toggle survives "Refresh data".
- [ ] After one run, the logged row count for the current week equals the number of rostered players
      with a projection — roughly a third of what it was before ruling 13 — and no row carries a
      free agent's id. Rows written by earlier runs of this branch are still pooled, so the fitted
      slope will drift as rostered-only weeks accumulate.

**Privacy:**

- [ ] No console errors, and a network panel showing no request carrying a league id, team name or
      player name. Requests should carry season and week only.

## Process notes

Eight tasks, each with a fresh implementer and a spec+quality review. Three tasks needed a fix round
(3, 5, 6); each round ended in a scoped re-review that verdicted every finding. The whole-branch
review ran on the most capable model against the merge-base diff and re-derived the aggregate
arithmetic numerically rather than reading it for plausibility — a shape-disagreeing source at 1×,
2× and 0.37× produced byte-identical aggregates and bands, and a skewed-subset source at 10× moved
nothing. One fix wave and one scoped re-review followed. Two residual minors were parked with
rulings, above.

Three defects were found only because a reviewer probed rather than read: the inert `seasonId` decoy
(mutation test), the one-way Sources toggle (`(undefined !== false)`), and a test helper whose
`mkStorage` aliased objects so the persistence bug of ruling 11 passed without its fix. The last was
found by the fix implementer, not by any review.

The branch is not merged and not pushed. `superpowers:finishing-a-development-branch` is the next
step, and P1 and ruling 12's verification should be settled first.
