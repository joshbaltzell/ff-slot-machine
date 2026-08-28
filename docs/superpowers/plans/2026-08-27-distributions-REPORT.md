# Phase 8 — Measured distributions, stacks and the weekly plan: build report

**Branch:** `phase8-distributions`
**Worktree:** `.claude/worktrees/agent-a926bf499759a2a83`
**Base (merge-base with `main`):** `6036dd5` (after phase2-availability and phase3-market
were already merged; before phase4-roster, phase5-projections and phase7-environment)
**Head:** `0125e5c` — the last code commit; `bc28110` (CLAUDE.md) and this report follow it.
**Plan:** `docs/superpowers/plans/2026-08-27-distributions.md`
**Spec (binding):** `docs/superpowers/specs/2026-08-27-distributions-design.md`
**Parallel-build rules (binding):** `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`

Not merged, not pushed. Six tasks, each built by a fresh implementer and gated by its own
reviewer; three of the six needed a fix round (Tasks 2, 4, 5); two controller deaths
(API spend limit) mid-phase, both recovered by verifying the tree and re-dispatching rather
than trusting an assumed-complete step.

## What shipped

A player's projection used to be one number. It is now a measured floor and ceiling, a
roster's spread now accounts for teammates scoring together, and Sunday morning gets its
own lineup — the one most likely to beat this week's opponent, not the one with the highest
mean.

Lines below are `git diff --numstat 6036dd5..HEAD` (the whole branch against its
merge-base, so `CLAUDE.md` — committed after the last code commit — is included; a new
file's count is its insertion total, since it has no deletions).

| File | What it is | Lines |
|---|---|---|
| `extension/engine/distribution.js` | `CORR`, `rho`, `quantiles`, `buildDistribution`, `playerRange`, `cv`, `attachCovariance`, `stacks`, `lineupRange`. The whole measured-shape and correlation model. | 281 |
| `extension/engine/gameplan.js` | `lineupStats`, `feasible`, `gameplan` — the P(win)-optimal lineup by local search. | 177 |
| `extension/engine/league.js` | `measureVolatility` now also returns `residuals` (every qualifying player) and `byPosResiduals` (players clearing `minWeeks` only). | +15/−2 |
| `extension/engine/search.js` | `rosterSigma` gains the `2 Σ ρ σ σ` covariance term, active only when `eng.rhoOf` is attached. No other method touched. | +25/−3 |
| `extension/panel/distributions.js` | Every string for floors, ceilings, stacks and the This-week section; the range bar; `SWAP_MIN`. | 138 |
| `extension/panel.js` | Imports, volatility-step wiring (`attachCovariance`, `buildDistribution`), the This-week section above the trade grid, stack chips in trade detail, Floor/Ceiling roster-grid columns, the season note rewritten to name the measured constants. | +41/−4 |
| `extension/panel.css` | Styles for the range bar and the This-week section. | +19 |
| `extension/test/distributions.mjs` | 131 assertions for quantiles, correlation, stacks, the gameplan local search and every panel string. | 640 |
| `CLAUDE.md` | Architecture map plus two load-bearing paragraphs (volatility's residuals, the `CORR` table, the gameplan heuristic). | +40/−9 |

In the UI: a **This week** section above the trade grid (opponent, P(win) before and after
the local search's swaps, a range for both sides), **Floor** and **Ceiling** columns in the
roster grid, stack chips (`QB+WR ρ0.25`, etc.) in trade detail beside the players actually
co-starting, and the season note rewritten to state the measured shrinkage and correlation
instead of the old "assumes independence" / "±25 is assumed" placeholders.

## Commits

| SHA | Subject |
|---|---|
| `999f661` | Plan Phase 8: measured distributions, stacks and the weekly plan |
| `d00aacc` | Keep the residuals volatility already measured |
| `4abacbe` | Measure a floor and a ceiling instead of guessing a symmetric one |
| `23625a5` | Give the cv shrinkage test a prior that isn't its own sample |
| `bcdc693` | Count the correlation between teammates in a roster's spread |
| `0decf46` | Pick the lineup most likely to beat this week's opponent |
| `17ae8c2` | Document the gameplan estimator asymmetry and strengthen the drift guard |
| `402a713` | Add the strings for floors, ceilings and this week's game |
| `3e60326` | Make the stack-chip-count and range-bar-position tests falsifiable |
| `0125e5c` | Show this week's odds, and a measured floor and ceiling |
| `bc28110` | Record how distributions, stacks and the weekly plan work |
| _(this file)_ | Record what Phase 8 built, ruled and left to the browser |

## Final test output

```
$ node extension/test/run-all.mjs
=== availability.mjs ===
  sampling error at k=7: 2.21%
  k=7 sampling gap: 2.78%

463 assertions, 0 failures
AVAILABILITY OK

=== distributions.mjs ===

131 assertions, 0 failures
DISTRIBUTIONS OK

=== market.mjs ===

141 assertions, 0 failures
MARKET OK

=== parity.mjs ===
slots: 9 starters/week  [1, 2, 2, 4, 4, 6, 16, 17, 23]
  per-trade odds: 28 ms per trade at 2000 sims

605 assertions, 0 failures
ENGINE OK — reproduces the verified baseline exactly

=== sources.mjs ===

14 assertions, 0 failures
SOURCES OK

5 files, 0 failing

$ node --check extension/panel.js
(no output)
```

`extension/test/parity.mjs` carries 605 assertions unchanged throughout the phase — no task
touched it. `season.js` and `manifest.json` are likewise absent from every task's diff.
`league.js` was touched only inside `measureVolatility`; `search.js` only inside
`rosterSigma`, confirmed by re-diffing each task's range and, separately, by diffing
`rosterSigma`'s body between this branch's merge-base (`6036dd5`) and current `main` —
byte-identical, so nothing this phase built on has moved under it.

## Rulings

Twenty decisions were taken without asking during Tasks 1–7, in the order they were made.
The eight pre-flight rulings first, then the ones made during each task. (The review that
produced this report's own fix round added further rulings to the ledger afterward; those
concern the report's accuracy, not the phase's build, and are not counted here.)

**Pre-flight 1. `Engine.stacks(ids)` is attached from `distribution.js`, not added to the
`Engine` class.** The parallel-build rules give this phase exactly `rosterSigma`/`teamSigma`
in `search.js`, and Phase 4 owns the rest of that file concurrently; attaching it inside
`attachCovariance` gives the spec's call shape with a one-method diff and no import line.
*Cost if wrong:* a reader greps `search.js` for `stacks` and does not find it — `CLAUDE.md`
and the JSDoc both say where it actually lives.

**Pre-flight 2. The covariance reaches `rosterSigma` as an attached `this.rhoOf`, not an
`import`.** Same constraint. It also means an engine nobody attaches to —
`parity.mjs`'s — takes the identical code path it always did.
*Cost if wrong:* one indirection between the constant table and its use.

**Pre-flight 3. `CORR` is implemented literally as the spec's four rules**, which puts a
kicker or a D/ST into the "same team, non-QB" bucket at 0.10 even though a D/ST is arguably
negatively correlated with its own offence.
*Cost if wrong:* one pair out of roughly 45 mis-signed at 0.10, worth well under 1% of a
team sigma. Parked as a finding rather than deviating from a binding spec.

**Pre-flight 4. `residuals` keeps every player with at least one qualifying week;
`byPosResiduals` pools only players who cleared `minWeeks`.** The spec specifies neither.
Shrinkage exists precisely to make a small sample safe, so gating a rookie's own residuals
out would discard the only data he has — but the prior everyone shrinks *toward* must not
itself be built from noise.
*Cost if wrong:* a one-week player's range leans slightly more on his own week than it
should.

**Pre-flight 5. `cv(player)` becomes `cv(player, dist)`.** The spec's one-argument form
cannot shrink toward a positional CV with no access to one.
*Cost if wrong:* a signature that differs from the spec by one argument.

**Pre-flight 6. The `dist` parameter is dropped from `lineupRange` and `gameplan`.** Both
compute the team total as a normal around the lineup mean and neither reads a per-player
quantile, so `dist` would be an unused parameter — a lie about what the function depends on.
*Cost if wrong:* a signature change on the day a later phase makes the team range
skew-aware.

**Pre-flight 7. `gameplan` prices its own lineups (μ = Σ p·proj over a fixed lineup) while
the opponent is priced from `eng.baseline`/`eng.teamSigma`, as the spec directs.** Those are
E[optimal lineup] under substitution, so `pWinMean` may differ slightly from
`eng.weekWins` for the same matchup and week. Within one plan every candidate lineup is
priced identically, which is what makes the swap deltas comparable to each other.
*Cost if wrong:* the This-week percentage differs by a fraction of a point from the
leverage strip's for the same week.

**Pre-flight 8. `gameplan`'s candidate pool is every rostered player with play probability
greater than 0**, including one under 0.5 whom `starterMask` would not show as a starter.
μ already discounts him by his own p.
*Cost if wrong:* a 40%-to-play player can be recommended as a variance dart; the badge
beside his name already says he is Questionable.

**Task 2, review-process. No verdict was found for the first Task 2 review on resume** (no
reviewer artifact, no follow-up fix commit, clean tree). Ruling: treat the first review as
never completed and re-dispatch a fresh one over the same range.
*Cost if wrong:* one duplicate review seat.

**Task 2, Important finding — FIX (divergence 1, see below).** The brief's own cv shrinkage
test collapsed to a tautology: the fixture's `vol.bySigma` holds only one player, so the
positional prior is derived from that same player's own CV, making `own === prior` and the
weighted blend equal to the same constant regardless of the shrinkage weight, `n0`, or the
formula's shape. Decision: rewrite the test with a prior built from data the assertion
doesn't also depend on, rather than ship the phase's only `cv` coverage unable to fail.
*Cost if wrong:* `extension/test/distributions.mjs`'s block-2 `cv` test no longer matches
the plan text character-for-character — recorded here as required.

**Task 4, Important 1 — FIX.** The brief's own "rulings to encode in comments" list
requires Ruling 7's estimator asymmetry (ours priced by `lineupStats`, the opponent's by
`eng.baseline`/`eng.teamSigma`) to be documented in `gameplan.js`; the brief's code block
simply omitted the comment while giving Rulings 1 and 3 theirs.
*Cost if wrong:* none — a missing comment.

**Task 4, Important 2 — FIX (divergence 2, see below).** The drift guard is the sole
safeguard against `lineupStats` and `rosterSigma` silently diverging, and no test in the
block called `setAvailability`, so `eng.avail` was null throughout and both functions took
their `p === 1` path unconditionally — a `p` swapped for `p*p` in one and not the other
would have gone undetected. Decision: attach availability to the drift-guard case so the
`sqrt(p)` scaling term is actually pinned.
*Cost if wrong:* the drift-guard test no longer matches the plan text character-for-character
— recorded here.

**Task 4, minors 3 and 4 — bundled into the same fix.** The dropped-`dist` ruling comment
and `maxRounds`'s dual role (guarding a non-strict objective *and* bounding effort on a
genuinely long chain) were folded into the Important-1 fix dispatch since they are
comment-only edits in the same file and region, and the loop was already open.
*Cost if wrong:* two comment lines the plan did not ask for.

**Task 4, cannot-verify 1 — PARKED, not fixed.** Behaviour when `w` indexes past `eng.NW`
is unguarded. `gameplan` is documented and called for the current week only, and
`restrictToRemaining` trims `model.weeks` before the engine is built, so a bounds check
would defend against a call the codebase does not make.
*Cost if wrong:* a future caller passing a stale week index gets undefined-driven
arithmetic instead of a null plan.

**Task 4, cannot-verify 2 — folded into the Important-2 fix.** Whether the drift-guard
fixture's stacked players actually co-start (so a non-zero ρ is genuinely summed at
runtime, not just present in the arithmetic) could not be confirmed by review alone; the
fix was required to assert it directly via `stacks(...)`.

**Task 5, review-process. No verdict for the first review** (controller died mid-dispatch;
verified clean tree, no fix commit, no reviewer artifact on resume). Ruling: re-dispatch,
same precedent as Task 2.
*Cost if wrong:* one duplicate review seat.

**Controller ruling (pre-Task-7).** Task 7 is extended to also write this report, beyond
the plan text's CLAUDE.md-only instruction, because two earlier rulings (Task 2's and
Task 4's) each promised "Task 7's report must record the divergence," and the durable place
for that is a build report, not the git-ignored workspace. The convention already exists on
sibling branches (`-availability-REPORT.md`, `-market-REPORT.md`).
*Cost if wrong:* one extra documentation file the plan text did not ask for, in a directory
that already holds two of its kind.

**Task 5, Important 1 — FIX (divergence 3, see below).** `stackLine` renders every chip's
title as the literal text `rho 0.25`, so the brief's "two stacks are both reported"
assertion — `... || two.includes("2")` — was satisfied by the first chip alone; dropping
the second stack entirely still passed. Same defect class as Tasks 2 and 4.
*Cost if wrong:* the block-5 stack assertion no longer matches the plan text
character-for-character — recorded here.

**Task 5, Important 2 — FIX (divergence 3, continued).** `rangeBar` returns a template
literal containing `<div`, `<i` and literal `%` characters in its style attributes for any
input, so `bar.includes("<") && bar.includes("%")` held for any implementation of this
shape — including one computing NaN positions. Replaced with the exact percentages the
documented inputs imply.
*Cost if wrong:* same divergence cost as above, recorded here.

**Task 5, Minor — DEFERRED, not fixed.** `stackNote`'s sentence puts `sameGame` (a
cross-team relationship) inside a clause that opens "two players on one NFL team." It is
verbatim from the brief, purely prose, and four separate tests already pin the exact
sentence.
*Cost if wrong:* one slightly muddled sentence in the season note.

### The three deliberate divergences from the plan text

Three assertions in `extension/test/distributions.mjs` do not match the plan's verbatim
test text, all for the same reason: the brief's own wording, transcribed faithfully, would
have passed regardless of the implementation underneath it. Each was caught by a task
reviewer, ruled FIX rather than accepted, and re-verified by a separate re-review that
re-derived the numbers from the code rather than trusting the implementer's report.

1. **Task 2's `cv` shrinkage test (block 2).** The fixture gave `vol.bySigma` only one
   player, so the positional prior `byPosCv` was derived from that same player's own CV.
   `own === prior` collapsed the shrinkage blend to a constant no matter the weight, `n0`,
   or the formula's shape. Fixed in `23625a5` by giving the prior a source the assertion
   doesn't also depend on.
2. **Task 4's drift-guard test (the `lineupStats`/`rosterSigma` agreement check).** No
   assertion in the block ever attached availability, so both functions took their
   unconditional `p === 1` path — a broken `sqrt(p)` scaling term in one but not the other
   would have gone unnoticed. Fixed in `17ae8c2` by attaching availability and asserting the
   modal lineup is unchanged (to isolate the scaling) and that `stacks(...)` is non-empty
   (to prove the stacked players genuinely co-start, not just appear in the arithmetic).
3. **Task 5's two block-5 assertions — the stack-chip count and the range-bar position.**
   "Two stacks are both reported" was satisfiable by rendering only the first chip, because
   `stackLine`'s literal `rho 0.25` title text matched the assertion's fallback check
   regardless of whether a second chip existed. The range-bar assertion checked only that the
   returned HTML contained `<` and `%`, which is true of `rangeBar`'s template for any input,
   including a NaN position. Fixed in `3e60326` by pinning the exact percentages `rangeBar`'s
   own arithmetic implies for the documented inputs, and by asserting the second stack's
   presence directly rather than through a fallback.

`extension/test/distributions.mjs` therefore does not match the plan's test text
character-for-character in these three places. That was the right call: a test that cannot
fail is not coverage, it is a comment shaped like an assertion, and each replacement was
independently re-derived from the shipped code by a re-reviewer before being accepted —
never taken on the implementer's word.

## Review record

Every task passed review; three needed one fix round each (Tasks 2, 4, 5), all triggered by
the tautological-assertion defect above.

| Task | First review | Fix rounds | Final |
|---|---|---|---|
| 1 | clean | 0 | spec OK |
| 2 | spec COMPLIANT, 1 Important + 2 Minor | 1 | clean, spec OK |
| 3 | spec COMPLIANT, 0/0/3 | 0 | clean |
| 4 | spec ISSUES / NEEDS FIXES, 2 Important + 2 Minor + 2 cannot-verify | 1 (4 addressed + 1 folded-in) | clean, spec OK |
| 5 | spec COMPLIANT, 2 Important + 1 Minor + 1 cannot-verify | 1 (2 addressed + falsification requirement) | clean, spec OK |
| 6 | spec COMPLIANT, 0/0/1 Minor + 1 cannot-verify | 0 | clean |

Two controller deaths (API spend limit) interrupted the phase — once immediately after
dispatching Task 4's fix round, once after dispatching Task 5's review. Both times the
resumed controller verified the tree independently (HEAD unchanged, no stray commit, no
reviewer artifact, no fix report) before treating the interrupted step as never having
happened and re-dispatching, rather than assuming partial progress that could not be
confirmed.

Task 3's review independently recomputed the same closed-form numbers the pre-flight scan
had derived (3 WRs → √960, cross-game → √890, p=0.5 → plain/√2) and traced both `rosterSigma`
and `stacks` algebraically for the pairing and no-self-pairing invariants. Task 6's review
confirmed every one of ten brief anchors landed at the correct place in `panel.js` and that
`grep -c "assumes independence\|±25 is assumed" extension/panel.js` returns 0 — the old
placeholder language the Task 5 review had flagged as a risk is fully gone.

## Deferred minors

None blocks merge. Listed so they are not lost.

| Where | What |
|---|---|
| `league.js` | `measureVolatility`'s JSDoc (around line 220) omits `measured`, `residuals`, `byPosResiduals` — stale from before this phase too. |
| `distributions.mjs` | Import scaffolding for `buildSlots`/`seatMask`/`Engine`/`mkModel`/`mkEngine`/`NW`/`near` used by later tasks in the same file — fine as landed, flagged only because Task 1 introduced it before Task 3 used it. |
| `distribution.js` | The 4-line `median` helper duplicates one already in `league.js`, differing only in the empty-array fallback (0 vs null). Share only if a third copy appears. |
| `distribution.js` | Zero/negative mean projection and a player object missing `nfl` entirely are handled defensively but not pinned by any assertion. |
| `distribution.js` | `lineupRange`'s `median` is the modal-lineup point estimate (`Σ p·proj` over `starterMask`), not the enumerated expectation `weekly()`/`baseline` compute. Spec-consistent and precedented by `explain`/`startRates`, but — unlike `rosterSigma`'s own comment — the function's doc comment does not disclose the approximation. The reviewer asked that this be folded into Phase 7's (this phase's) documentation if not fixed in code first; it was not fixed in code, so it is recorded here rather than in `CLAUDE.md`, since `CLAUDE.md`'s Step 2 text was locked to the brief's exact wording. |
| `distribution.js` | `attachCovariance`'s optional `gameOf` returning `undefined` is handled by `ga != null` but not pinned by a test. |
| `search.js` | `rosterSigma`'s doc comment claims the no-`rhoOf` path is "character for character" the old arithmetic; output identity holds (confirmed empirically) but the expression itself changed (`Math.max(0, v)` wraps the old `Math.sqrt(v)`). |
| `panel/distributions.js` | `stackNote`'s sentence places `sameGame` (a cross-team relationship) inside a clause that opens "two players on one NFL team." Verbatim from the brief; four tests pin the exact wording. |
| `panel/distributions.js` | `DIST_HINT.pwin` is exported but nothing in `panel.js` attaches it — the This-week section's win-probability tile carries no hover title. Out of Task 6's file-ownership scope; the other two hints (floor, ceiling) are wired. |

## Browser verification — pending

There is no browser in this environment, and nothing in this phase has been exercised
against a real ESPN league. The engine and panel-string modules carry 131 assertions;
`panel.js`'s own wiring carries none, because `panel.js` is a DOM module with no test
harness — its only coverage is `node --check` (syntax only) plus the fact that the
functions it calls are themselves tested in isolation. The This-week section, the range
bars, the roster-grid Floor/Ceiling columns and the trade-detail stack flags have never
been rendered. **This is the single biggest residual risk of the phase**, same as it was
for Phases 2 and 3.

A reviewer should click, in this order:

- [ ] Load the unpacked extension against a real league and confirm the loading checklist
  still finishes; volatility measurement (`vol.measured >= 20`) is the gate for the whole
  phase — below it, `window.__dist` is never built and the This-week section, the ranges and
  the stack chips should all be silently absent rather than broken.
- [ ] A **This week** section appears above "Every trade in the league" / "Offers for you",
  showing the opponent, a win-probability delta if the local search found any improving
  swap, and a floor/median/ceiling range for both sides.
- [ ] The roster grid shows **Floor** and **Ceiling** columns after "Proj/wk," populated for
  players who are actually projected to play and showing `—` only for a bye week.
- [ ] Expanding a trade whose incoming or outgoing players share an NFL team (or a QB with
  his own pass-catcher) shows a stack chip (`QB+WR ρ0.25`) under that side's numbers; a trade
  with no such pair shows nothing there, not an empty chip.
- [ ] The season note at the bottom names the measured shrinkage and correlation instead of
  the old "assumes independence" / "±25 is assumed" language — hover it and confirm the
  sentence reads coherently rather than as two clauses stitched together (see the deferred
  `stackNote` minor above).
- [ ] Range bars render with a visible marker inside a bounded track, not a bar running off
  either edge — this is exactly the arithmetic the Task 5 fix round had to make failable, so
  it is worth a specific look rather than a glance.
- [ ] Hover the Floor and Ceiling column headings and confirm a hint tooltip appears; the
  This-week section's win-probability tile will *not* have one (see the `DIST_HINT.pwin`
  deferred minor).

## Merge notes

The branch is unmerged and handed off, based on `6036dd5` — after phase2-availability and
phase3-market were already merged into `main`, and before phase4-roster,
phase5-projections and phase7-environment were (`git merge-base --is-ancestor 18dad62
6036dd5` succeeds; the same check for phase4-roster's, phase5-projections's and
phase7-environment's merge commits fails). It owns, narrowly: `measureVolatility` in
`league.js`, one method body (`rosterSigma`) in
`search.js`, and two new files with no history to conflict over
(`engine/distribution.js`, `engine/gameplan.js`, `panel/distributions.js`,
`test/distributions.mjs`).

`rosterSigma` itself is low-risk: diffing its body between this branch's merge-base and
current `main` shows it byte-identical, even though `search.js` as a whole grew by 357
lines on `main` (phase4-roster's replacement-level and 2-for-1 work) — nothing this phase
edited has moved underneath it.

`panel.js` and `panel.css` are the real conflict surface. Diffing current `main` against
this branch's merge-base shows the already-merged phases touching the same regions this
phase does: `start()` (roughly lines 324–480 on `main`, where this phase's volatility-step
wiring and `window.__dist` also land), the top of `render()`'s trade-detail block (roughly
640–723, where this phase's stack-chip line is inserted), the roster grid (roughly 798–927,
where this phase adds the Floor/Ceiling columns), and the tail of `render()` from the wrap
insertion point through the season note (roughly 1113–1327, where this phase inserts the
This-week section and rewrites the season note). Every one of this phase's own `panel.js`
anchors falls inside a region at least one merged phase has also touched — expect a
three-way merge with manual resolution at each hunk, not a mechanical one.

`panel.css` is a guaranteed textual conflict rather than a merely likely one: both this
branch and current `main` append their new rules starting at the identical last line (352)
of the pre-phase file. Whoever merges should append both blocks rather than let either
side's diff silently win.

`CLAUDE.md`'s architecture map and load-bearing section are new prose at the end of
existing blocks; if a parallel phase's merge has already added its own entries to the same
map or the same section, add to it rather than reverting either side.
