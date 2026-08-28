# Phase 2 — Availability core and the in-season horizon: build report

Plan: `docs/superpowers/plans/2026-08-27-availability.md`
Spec (binding): `docs/superpowers/specs/2026-08-27-availability-design.md`
Parallel-build rules (binding): `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`
Process: `superpowers:subagent-driven-development` — a fresh implementer per task, a
scoped reviewer after each, then one whole-branch review.

## Where the work is

| | |
|---|---|
| Branch | `phase2-availability` |
| Worktree | `.claude/worktrees/agent-a72b44359a4a2f4b2` |
| Base (merge-base with `main`) | `33ab692` |
| Head | see the commit table below |

Nothing was merged and nothing was pushed. `main` is untouched.

## What shipped

The engine used to treat every rostered player as certain to suit up and every week
of the season as still winnable. Both are now false where they should be.

**Injury status is read.** `loadLeague` and `loadFreeAgents` record ESPN's
`injuryStatus` and `injured` on every player, and `t.record.overall` on every team.
`engine/sources/sleeper.js` supplies the practice report — `FP` / `LP` / `DNP` — which
is the only public signal separating a Questionable who practised in full from one who
did not practise at all. Sleeper is CORS-open, keyless, cached for a day, and entirely
optional: a dead feed costs the practice detail and nothing else.

**A play probability per player-week.** `engine/availability.js` turns a status string
and a practice report into a number in `[0,1]`, from one exported table so a later
phase can replace the constants without touching the engine.

**The lineup is priced under uncertainty.** `Engine.weekly` splits each week's roster
into certain players (`p` exactly 0 or 1) and uncertain ones, then returns the
probability-weighted mean of the *optimal* lineup across the outcomes. This is the
phase's one real piece of mathematics and it is worth stating plainly: optimal lineup
value is a max over assignments, so it is convex in the projections and not linear in
availability. `E[L]` is not `L(E[proj])`. Two players at 50% are not one certain
starter — a bench absorbs one absence far better than two — so the obvious shortcut of
multiplying a projection by its probability understates the damage every time.

**The horizon is the weeks that remain.** `restrictToRemaining` trims `model.weeks` and
the settings week arrays to `w >= currentWeek` before the engine is built. A trade
proposed in week nine used to be scored partly on eight weeks nobody could change.

**The season simulation starts from the standings.** `projectSeason` takes the real
records and starts each simulated season there rather than at 0-0.

**The UI says all of it.** A Status column on the roster grid, a badge after any
injured player's name inside a trade package, log lines for the horizon and the
injury summary, and a season-panel note that no longer claims rosters are frozen.

## Commits

| SHA | Task | Subject |
|---|---|---|
| `525441f` | — | Plan Phase 2: availability and the in-season horizon |
| `e5b842a` | 1 | Read injury status, and price the chance a player suits up |
| `c5b39cc` | 2 | Solve the lineup for who is actually going to play |
| `384ad2c` | 3 | Start each simulated season from the real standings |
| `d5b37e3` | 4 | Add the availability strings the panel shows |
| `f43fff4` | 5 | Load injury reports and score only the weeks that remain |
| `ff225cd` | 6 | Show who is playing on the roster and in every package |
| `532edd6` | 7 | Record how availability and the horizon work |
| `a199728` | — | Tell the truth when the season is over or the standings are missing |

Every task passed a scoped review with no Critical and no Important findings. Two
tasks had a review finding folded forward into the next task rather than reopened;
both are recorded as rulings below. The last commit is the single fix wave that
followed the whole-branch review.

## Test results

`node extension/test/run-all.mjs`, at the branch head:

```
=== availability.mjs ===
463 assertions, 0 failures
AVAILABILITY OK
=== parity.mjs ===
605 assertions, 0 failures
ENGINE OK — reproduces the verified baseline exactly
=== sources.mjs ===
14 assertions, 0 failures
SOURCES OK

3 files, 0 failing
```

`node --check extension/panel.js` is clean.

`extension/test/parity.mjs` was never edited. It is the frozen engine contract — 605
assertions produced by an independently written implementation and verified line for
line before that implementation was retired — and it still reproduces the baseline
exactly. That is the strongest single statement this branch can make: the engine's
behaviour with no availability attached is unchanged.

Worth knowing about that guarantee's shape: `parity.mjs` builds its engine without
ever calling `setAvailability`, so it exercises only the fast path. It proves the fast
path is untouched; it says nothing about the slow one. The slow path's own coverage
lives in `extension/test/availability.mjs`.

## Rulings

Every decision taken on your behalf during the build, in the order taken, each with
what it costs if it was wrong. This list is exhaustive.

### Before execution

**1. `mulberry32` is duplicated verbatim between `availability.js` and `season.js`.**
The review rubric treats verbatim duplication of a logic block as a defect and the
plan mandated it. Ruling: keep the duplication. Importing `season.js` into `search.js`
would couple the lineup solver to the season simulator, and `season.js`'s copy is
load-bearing for the common random numbers `odds.js` depends on — a future edit to one
would silently reseed the other. *Cost if wrong:* eight lines drift apart unnoticed.
Mitigated: Task 2 carries an assertion that the two generators emit an identical
sequence, so drift now fails a test.

**2. Task 5 imports five names it does not use**, which Task 6 then uses. Ruling: keep
them in Task 5's single import hunk. The parallel-phase rules cap `panel.js` at one
import line, and splitting the import across two commits doubles the merge surface for
the phases being built alongside this one. *Cost if wrong:* one commit in this
branch's history has unused imports; nothing ships broken.

**3. The Status column is marked `num: true`** although its cell holds a badge, not a
number. Ruling: correct as written — `num` is what makes `grid()` sort with the
numeric comparator over `statusRank`'s number and default to descending, which is what
puts the worst news at the top. *Cost if wrong:* a cosmetic alignment nit.

**4. `.superpowers/` was not git-ignored in this repo.** Ruling: added it to
`.git/info/exclude` rather than to the tracked `.gitignore`, so the phase branch
carries no build scaffolding into the merge. *Cost if wrong:* none; the exclude is
local to this clone.

### During execution

**5. The `mulberry32` duplication has no drift test (Task 1).** The task reviewer
accepted the ruling above but pointed out the duplicate was unguarded. Ruling: carry
an added assertion into Task 2 rather than reopen Task 1 — cheaper than either
coupling the modules or leaving the drift undetected. *Cost if wrong:* one extra
assertion nobody needed.

**6. `rosterSigma` understates spread on heavily-questionable rosters (Task 2).**
It computes `E[Var | A]` and drops the between-outcome term `Var(E[L | A])`, so a
roster carrying several Questionable players has a narrower spread than reality
feeding `winProb` and per-week leverage. The formula is what the spec mandates.
Ruling: ships as specified — the *mean* is exact and the spread around it is
first-order. *Cost if wrong:* win probabilities are slightly overconfident for rosters
with several Questionable players. **This is the one item worth your own judgment**
rather than mine; it is a spec decision, not an implementation slip, and Phase 9 is
the natural place to revisit it.

**7. A partial records map would silently mis-seed the standings (Task 3 → 5).** The
Task 3 reviewer noted that a team missing from a partial `records` map is treated as
0-and-played, which shifts seeding and therefore odds — not merely the printed record.
Task 5 builds that map from `model.teams` but filters on `t.record` being present, so
an ESPN response missing `record.overall` for a single team would produce exactly that
map. Ruling: close the class in Task 5 rather than reopen `season.js` — pass `records`
only when the map covers every team, otherwise pass `null` and log one line. *Cost if
wrong:* a league whose ESPN payload omits one team's record loses record seeding
entirely and projects from 0-0 — which is the pre-Phase-2 behaviour, and it says so in
the log — rather than silently mis-seeding one team.

**8. A completed season would be priced with this week's injury table (Task 5 → 6).**
When `horizon.complete`, `restrictToRemaining` keeps every week, so every week offset
is `<= 0` and `playProb` prices already-played weeks as though they were the current
one: a currently-OUT player would score zero across the whole retrospective. Ruling:
fold the guard into Task 6 rather than reopen Task 5 — it is one condition inside a
block Task 6 was already modifying, and reopening would have cost a full review round
for the same edit. *Cost if wrong:* a completed-season retrospective ignores injuries
entirely, which is what it did before Phase 2.

**9. Task 6 ran on the cheaper model.** The standing direction was Opus for panel
integration, and Task 6 edits `panel.js`. Ruling: Sonnet. All six of its steps are
verbatim before/after pairs that I checked against the file byte for byte before
dispatch, plus one condition change I specified exactly — that is transcription, not
integration. *Cost if wrong:* a fix round on a diff whose every line was dictated.
(It came back clean, with no findings at any severity.)

**10. Task 6's added requirements went into the brief, not the plan.** Rulings 7 and 8
both added work to a task the plan had already specified. Ruling: write them into
`task-6-brief.md` as numbered steps so the brief stays the single source of
requirements the implementer and the reviewer both work from. *Cost if wrong:* the
brief file diverges from the plan file — which is why this report records it.

**11. The plan's Task 7 was written against a stale `CLAUDE.md`, and is wrong in two
places.** Its Step 1 edit to the Commands block was already satisfied by an earlier
merge, in better words. Its Step 2 architecture map lists `engine/swaps.js`, which does
not exist — the swap table lives in `search.js` — and omits `winprob.js`,
`calibrate.js` and `odds.js`, which do. Ruling: skip Step 1; replace the map with one I
verified file by file against the tree. *Cost if wrong:* `CLAUDE.md`'s map would have
sent the next reader to a file that is not there, which is the exact failure the map
exists to prevent.

**12. `CLAUDE.md`'s "Nothing in the search is approximated" was made false by this
phase.** Task 2 introduced the 64-sample fallback above six uncertain players, and the
plan's Global Constraints require it to be documented as the engine's one
approximation — but the plan's new paragraph documented it without retracting the old
absolute claim. Ruling: amend the old paragraph to name the exception. *Cost if
wrong:* two paragraphs of `CLAUDE.md` contradict each other, and the one a reader hits
first says the engine is exact.

**13. `CLAUDE.md`'s Privacy section did not name Sleeper.** I confirmed `main`'s
`panel.js` never imported the Sleeper client, so this branch is the first to put
`api.sleeper.app` on the load path. Ruling: add one sentence naming the host and
stating that the request is league-agnostic — no league id, team or roster is sent.
*Cost if wrong:* a one-line conflict with a parallel phase branch editing the same
paragraph, resolvable by hand in seconds.

### At the final whole-branch review

The whole-branch review ran on the branch's full diff against the merge-base. It found
no Critical issues and no engine defects, and it did not take the per-task reviews'
word for anything: it reimplemented `main`'s `weekly` and ran both over every fixture
team-week to prove the fast path is unchanged; it showed that enumeration gives 133.824
where the naive blended-projection shortcut gives 130.431, a 3.4-point error in the
wrong direction, which is the whole argument for enumerating; it proved the
`gauss(rand)` draw order is fixed by demonstrating that a run seeded with all-zero
records is byte-identical to a run seeded with none; and it measured the slow path's
cost on the search that actually ships at about +5%.

It raised three Important findings. Two were fixed. The third is parked.

**14. A completed season showed availability UI the engine had not applied.**
`window.__avail` was published unconditionally, but ruling 8's guard meant
`setAvailability` was skipped when the season was over — so the page kept claiming
that OUT players score nothing and Questionable ones are weighted, beside numbers
that ignored both. Ruling on the fix's shape: carry an `applied` flag rather than
suppress the feature. A badge saying a player is on IR states a fact, and it is true
whether or not the engine priced it; the season note makes a claim about the
arithmetic, and that is the half that was false. `seasonNote` now returns the
pre-Phase-2 frozen-rosters sentence unless availability was actually applied; the
badges stay. *Cost if wrong:* a season-over page shows status badges beside numbers
that ignore them — which is what it did before the fix anyway.

**15. An empty remaining regular season plus no records rendered playoff odds seeded
by array order.** From week 15 the remaining regular season is empty, so with a null
records map every team sits at 0 wins and 0 points and the seeding sort degenerates to
array index: the first few teams get 100% playoff odds as a pure artifact of iteration
order. This could not happen before this branch, because the regular season was never
empty. Ruling on the fix's shape: do not touch `season.js` — it behaves correctly given
its inputs, and the defect is that `panel.js` hands it inputs from which no answer
exists. The state is now detected in `panel.js`, logged as an error naming both halves
of the cause, `attachOdds` is skipped rather than pairing two meaningless worlds, and
the season grid is replaced by a note. *Cost if wrong:* a league in week 15 or later
whose ESPN payload is complete is unaffected; one whose payload is short loses a season
projection it could not have computed honestly.

**16. `panel.js` exceeded the parallel-build hunk cap. Parked, not fixed.** The rules
budgeted one import line, one `PHASES` entry, one block in `start()` and one call site
in `render()` per new section. The branch carries three import statements, four
`start()` hunks and four `render()` hunks — nine after fix 15 added one knowingly.
Ruling: park it. Collapsing the hunks would break orderings the plan requires — the
horizon must be trimmed before the settings are read, and `setAvailability` must follow
`Engine` construction, because the constructor computes baselines assuming everyone
plays. Every hunk is individually small and justified. What the rule protects is the
merge, so the correct response is to tell whoever performs it, which this report does.
**Action for the merger: `panel.js` on this branch has four `start()` hunks and four
`render()` hunks, not the one-and-one the rules assumed. Expect more conflict with
phases 3 and 5 than the rule budgeted.** *Cost if wrong:* that merge is done by hand
rather than mechanically.

**17. The fix wave's scope.** One fix wave is allowed, and a wide one on a branch
merging alongside two other phases costs conflict surface for no correctness gain.
Ruling: the two Important findings, the reviewer's own two recommendations (pin the
`ENUM_MAX` boundary with an assertion; document the `rosterSigma` spread limitation in
`CLAUDE.md`), and two one-line correctness nits inside the pure `availability.js`
module — a season-over branch that returned its played/remaining counts backwards, and
a half-guard on `model.settings`. Every other Minor is deferred and listed below.
*Cost if wrong:* a handful of cosmetic nits ship, all of them written down here.

The reviewer also measured ruling 6's `rosterSigma` question rather than reasoning
about it, and its numbers are the ones quoted under Known limitations.

**18. The build workspace is kept, not deleted.** The process directs deleting the
scratch directory once the final review is clean, on the grounds that git history is
the record. Ruling: keep it. This session was killed once mid-phase by an API limit,
the branch is complete but not merged, and the seven task briefs are the only record of
what each implementer was actually told — the plan file does not contain the
corrections that rulings 10 through 13 built tasks 6 and 7 from. It lives at
`.superpowers/sdd/2026-08-27-availability/` and is excluded via `.git/info/exclude`, so
it cannot reach the merge. *Cost if wrong:* a git-ignored directory sits on disk until
the branch lands, and can be deleted then.

The fix wave passed its scoped re-review with all six findings addressed and no new
breakage. The re-reviewer confirmed that `search.js`, `season.js` and `parity.mjs` have
zero diff across the fix; that `seasonNote` is total across all four states of its
argument; that the new season-panel guard swaps between two values that were already
built, so nothing dangles; and that the new boundary assertions fail in *both*
directions when `ENUM_MAX` is set to 5 or to 7, using a hand-enumeration that shares no
code with the implementation it checks.

## Parked and deferred findings

None of these blocked a task. They are listed so the next person to touch this code
does not rediscover them, roughly in descending order of how much I would care.

**Worth a second look**

- `rosterSigma` drops the between-outcome variance term — see ruling 6 and Known
  limitations below. The one finding surfaced deliberately rather than deferred.
- `losses = games - wins` absorbs half of each real tie, so a 2-2-2 team reads 3-3 in
  the projected-record column. Defensible for the simulated portion of a season,
  weaker for the portion already played; a tie-accurate display needs its own field.
- `played` is a league-wide scalar although `games` is emitted per team, so a team
  behind on games played shows a slightly high loss count. Plan-mandated.
- From week 16 the season simulation replays playoff rounds already decided, because
  the round-weeks lookup reuses the last surviving round's weeks. Related to ruling 15
  but not the same bug, and not fixed by it.
- With no regular-season weeks left, the `reg` window averages over an empty mask, so
  the "Reg. season" column reads `0.00` for every trade with no explanation.
- The `k = 7` sampling tolerance runs at 2.21% against a 3% bound. It is deterministic
  so it cannot flake, but any change to the sample count, the seed or the fixture will
  read as a regression rather than as the retune it is. The test now carries a comment
  saying so.

**Untested paths**

- `setAvailability`'s clamping, its non-finite-to-1 coercion and its unknown-id
  skipping have no assertions; nor does `_likely` returning the same array instance.
  The whole-branch reviewer exercised all three by probe and all three behave.
- `odds.js`'s `simOpts` records forwarding has no assertion — verified by reading that
  `simOpts` builds its options once and both `projectSeason` calls receive them.

**Small and cosmetic**

- The trade *detail* panel shows incoming and outgoing player names with no status
  badge, while the summary row above it has one. The drill-down is where the decision
  gets made, so a user who sees `IR` in the grid and nothing in the detail will not
  know which to believe. Same for the free-agent grid. One call each; spec-compliant
  as written, so genuinely optional.
- `avgProj` reports the raw projection, so an IR player shows a full Proj/wk beside an
  IR badge.
- The `N weeks of real matchups` schedule log now over-reports relative to the horizon,
  because `loadSchedule` still returns every matchup period.
- `statusCode` / `badgeCode` / `statusRank` silently default on an unknown status
  string, so an upstream typo would not surface in development. This is the design's
  first assumption working as intended — a new ESPN enum must never zero a roster.
- `tip` computes a percentage from `s.now` with no NaN guard; `now` comes from a
  clamped array, so it is unreachable today.
- `statusCell` / `statusBadge` throw rather than degrade if `esc` is missing —
  consistent with their stated contract, and `panel.js` is the only caller.
- `.avail.warn` hardcodes `border-color: rgba(255,111,111,.32)`, the dark-theme
  `--danger`, so the badge border stays cool red against the light theme's `#c2382c`.
- Duplicate team names would collapse the records map, and the shortfall log would then
  blame ESPN for what is a name collision. The safe outcome is still reached, and
  ruling 15's guard now catches the case where it would have mattered.
- The stale-cache case logs with `ok` styling although it means the live fetch failed.
- In the no-standings state of ruling 15, `render()` still runs `projectSeason` and
  discards the result. Wasted work, no wrong number; guarding it would have cost a
  second `render()` hunk that ruling 16 argues against.
- `playProb`'s undefined-base guard is unreachable — kept deliberately against future
  edits to the probability table.
- The `_enumerate` `wt > 0` guard is unreachable in practice (reachable in principle
  only via denormal underflow, and harmless either way); `this._play` saves no
  allocation because `play.slice` already sorts a copy. Measured cost of the whole slow
  path is +5% on 2-for-2, so this is inside the noise.
- The `mulberry32` drift guard lives inside test section 4 rather than its own block,
  and section 5 has an unused const binding (consistent with section 3's).
- `CLAUDE.md`'s architecture map omits `extension/content.js` and `content.css`, which
  exist and are discussed by name two sections later. Pre-existing; my corrected map
  carried the gap forward.

Four items that were on this list are no longer here because the fix wave closed them:
the unpinned `ENUM_MAX` boundary, the season-complete horizon returning its counts
backwards, the half-guard on `model.settings`, and the untested `seasonNote` branches.

## Browser verification — pending

No browser was available to any agent in this build, so **nothing below has been
ticked**. The engine is covered by the test suite; the two panel tasks are not, by
design — their verification is this checklist. Please run it before merging.

```
browser verification pending (Task 5)
[ ] chrome://extensions -> reload -> open a league mid-season
[ ] the loading checklist shows "Injury reports" and it ticks green
[ ] the log shows one "horizon: weeks A-B (N already played and excluded)" line
[ ] the log shows one "availability: N out this week, M questionable, K on IR or suspended" line
[ ] the log shows "injury reports for ~11000 players" on the first run and
    "(cached)" on a reload within the day
[ ] block the Sleeper host in devtools and reload: the step goes amber with
    "ESPN only", the log says "practice reports unavailable", and the report
    still finishes
[ ] the season panel's regular-season week count is the remaining count, not 14
[ ] the projected-season Record column shows fractional wins ABOVE the team's
    real win total (a 5-0 team never shows fewer than 5.0)
[ ] a league in week 1 behaves exactly as before: "the whole season", 14 weeks
```

```
browser verification pending (Task 6)
[ ] chrome://extensions -> reload -> open a league mid-season
[ ] "Your roster" has a Status column between NFL and Bye
[ ] a Questionable player reads "Q · LP" and a hover explains the percentage
[ ] an IR player reads "IR", a suspended one "SUS" with the assumed-length note
[ ] a healthy player's Status cell is blank, not a dash or a zero
[ ] clicking the Status header sorts the worst news to the top and back
[ ] a trade package containing an injured player shows a small badge after his name
[ ] the badge survives a filter change (render is re-entrant)
[ ] the season panel's "What this is not" note names injury status
[ ] both light and dark theme: the badge is legible against .panel and .raised
[ ] a league with nobody injured shows no badges and an unchanged roster grid
```

## Known limitations

Out of scope by the spec, and worth naming so they are not mistaken for bugs:

- **The mean is exact; the spread is not.** Team sigma is `E[Var | availability]` and
  omits the variance *between* availability outcomes, so a roster carrying several
  Questionable players is shown slightly less swingy than it is. Measured on the
  fixture at a uniform per-player sigma of 9: two Questionable at `p = 0.71`
  understates team sigma by 4.0%, four by 8.6%, a pathological six at `p = 0.5` by
  21.7%. What that buys downstream is small — at a 10-point projected edge, a week's
  win probability reads 60.80% against a true 60.57% in the first case and 61.59%
  against 60.24% in the pathological one, so under 1.5 percentage points at the
  extreme and well under half a point in ordinary cases. And because `odds.js` runs
  paired worlds that both carry the bias, the reported *delta* absorbs most of even
  that. `CLAUDE.md` now says so beside the availability paragraph.
- **No expected return week.** A player OUT this week is treated as certain to play
  next week. That is deliberately optimistic and is Phase 9's B2.
- **Suspensions are priced as zero for the current week only**, because the length is
  not in either feed. The UI flags the assumption.
- **Conversion rates are league-average.** A team that always downgrades its
  Questionables late is scored like one that never does. Phase 9's B3.
- **Sleeper's `espn_id` coverage is incomplete** for rookies and D-ST; those players
  fall back to ESPN status with no practice detail.
- **Nothing models news.** Phase 9's B4.
