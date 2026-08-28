# Phase 4 — Roster construction: replacement level, 2-for-1, drop ranking: build report

Plan: `docs/superpowers/plans/2026-08-27-roster.md`
Spec (binding): `docs/superpowers/specs/2026-08-27-replacement-design.md`
Parallel-build rules (binding): `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`
Process: `superpowers:subagent-driven-development` — a fresh implementer per task, a
scoped reviewer after each, then one whole-branch review.

## Where the work is

| | |
|---|---|
| Branch | `phase4-roster` |
| Worktree | `.claude/worktrees/agent-a3314dc73e1d8e1cc` |
| Base (merge-base with `main`) | `6036dd5` |
| Head | see the commit table below |

Nothing was merged and nothing was pushed. `main` is untouched.

## What shipped

Every other tool grades a two-for-one with a haircut, because the two sides do not end
with the rosters the trade names: the side sending two has an empty seat, and the side
receiving two is over the roster limit. This phase prices both moves, because both are
lineup solves and therefore belong inside the score.

**Replacement level is measured, not assumed.** `Engine.backfillPool()` collects the
top three free agents in each distinct **seat mask** — masks, never position strings,
which is what keeps superflex, IDP, TQB and `RB/WR` correct. `Engine.backfill(ids)`
returns the pool member whose addition raises the roster's mean optimal lineup most;
`Engine.trim(ids, exclude, base)` returns the rostered player whose removal costs
least. Both run through `weekly`, so availability is honoured, and both refuse a roster
`legal()` rejects.

**The 2-for-1 shape is graded to the roster limit, exhaustively.**
`Engine.findTwoForOne(minGain, onProgress)` searches every ordered pair × every pair
the sender could send × every player the receiver could send back. The consolidating
side's post-trade roster is `backfill(swap(...))` and carries `backfill: fa`; the
receiving side's is `trim(swap(...))` and carries `drop: i`. Both carry `final`, the
roster the side actually ends with.

**The search is exact, and the exactness is proved rather than argued.** Two upper
bounds make it affordable: a removal never raises the optimal lineup (the trim side),
and lineup value is submodular so a man is worth no more on a larger roster than a
smaller one (the backfill side). `test/roster.mjs` runs an unbounded brute force over a
two-team sub-league and requires the answer sets to be identical — 829 trades, 0
missing, 0 extra, 0 value mismatch. Measured on the fixture: **7.12 s pruned against
72.2 s unpruned**, 10,541 trades at `minGain 0.05`, `dedupe(res, 3) = 135`.

**A drop ranking for the user's own roster.** `Engine.dropCandidates(team)` returns one
row per rostered player — what the lineup loses without him across the season, the
regular season and the playoffs, plus the best free agent the roster could then use and
what that add is worth. Ascending by cost, so the first row is the safest cut. Most of
a bench costs nothing to drop, which is exactly the point.

**The passes that run after the search read `final`.** `enrich`, `explain` and
`odds.js`'s `postWorld` all read `s.final ?? swap(roster, sent, received)`, so a
2-for-1's win deltas and season odds are computed on the roster the manager will
actually field rather than the mid-trade one, and every other shape is untouched.

**The UI says all of it.** A `2-for-1` chip in the shape row (on by default), a
`2-for-1 trades` loading step with its own progress, a `+ <FA> (waivers)` or
`drop <player>` note under the package it belongs to, detail lines naming both moves
with their start counts, and a new **Drop candidates** section on the user's own roster.

## Commits

| SHA | Task | Subject |
|---|---|---|
| `613ae59` | — | Plan Phase 4: replacement level, 2-for-1 and drop ranking |
| `8e64f2e` | 1 | Price the waiver wire: replacement level, backfill and trim |
| `f1b411b` | 2 | Search for two-for-ones, and rank what to drop |
| `bb3ac9d` | 2 (fix) | Refuse a two-for-one the receiver cannot legally make |
| `67b95a9` | 3 | Say what a two-for-one really costs, and what to cut |
| `cce3890` | 4 | Show two-for-ones and what they cost the roster |
| `1dbb3d3` | 5 | Record how a two-for-one is priced |
| `4d96c2d` | 5 (fix) | Reword the final-field topic sentence so it parses |
| `4eb0ad6` | final (fix) | Say what the backfill pool really costs |

## Files

| File | Change |
|---|---|
| `extension/engine/search.js` | `_rankVal`, `_wmean`, `backfillPool`, `backfill`, `_backfillFrom`, `trim`, `_metrics`, `dropCandidates`, `findTwoForOne`; `sideMetrics` becomes a wrapper; `enrich` and `explain` read `final` |
| `extension/engine/odds.js` | one line — `postWorld` reads `s.final ?? swap(...)` |
| `extension/panel/roster.js` | new — every string of 2-for-1 and drop-candidate HTML |
| `extension/panel.js` | one import, one `PHASES` entry, one `SHAPES` const, one `start()` block, five one-line `render()` sites |
| `extension/panel.css` | `.movenote` |
| `extension/test/roster.mjs` | new — the phase's whole test file |
| `CLAUDE.md` | architecture map, the approximation paragraph, the backfill-pool note, the sampling caveat, the `final` note |

Confirmed untouched versus base: `parity.mjs`, `fixture.json`, `golden_1for1.json`,
`season.js`, `league.js`, `availability.js`, `lineup.js`.

## Test results

`node extension/test/run-all.mjs` at head — **5 files, 0 failing**:

| File | Assertions |
|---|---|
| `availability.mjs` | 463, 0 failures |
| `market.mjs` | 141, 0 failures |
| `parity.mjs` | **605, 0 failures** — the frozen contract, unedited |
| `roster.mjs` | 276, 0 failures (new: 28 → 254 → 263 → 276 across Tasks 1, 2, 2-fix and 3) |
| `sources.mjs` | 14, 0 failures |

The suite was re-run at every commit on this branch, including both documentation-only
fixes, and `parity.mjs` has never been edited.

`node --check` passes on `extension/panel.js`, `extension/panel/roster.js` and
`extension/engine/search.js`. There is no `projections.mjs` on this branch — it reached
`main` with Phase 5, after this branch was cut.

What `roster.mjs` actually proves, beyond the assertion count: `backfill` and `trim`
are checked against independent brute forces written in the test file with its own
helper rather than the engine's `_wmean`, so a bug shared between the two could not
hide; section 6 proves the pruned search equals an unbounded one; section 6b proves the
capped-league case that the phase's one Critical came from; and section 8 re-asserts
the fixture baseline from the other side, so the refactor of `sideMetrics` is pinned
twice.

## Rulings

Every decision taken on Josh's behalf during this run, in order, with what it costs if
wrong. The five pre-flight rulings were recorded before Task 1 was dispatched.

### Before execution

1. **The test file duplicates `parity.mjs`'s model construction verbatim, and stays
   that way.** A review rubric treats duplicated logic as a defect, but `CLAUDE.md`
   explicitly requires the copy so that a change in a phase test can never move the
   golden set, and `availability.mjs` already does it. *Cost if wrong:* ~40 lines of
   fixture setup live in three test files and drift apart; the drift is caught by
   `parity.mjs` staying green.
2. **Tests assert on private methods** (`_rankVal`, `_metrics`, `_wmean`, and
   `_backfillFrom` via `findTwoForOne`). The exactness contract of this phase *is* an
   internal one — that the bounded search equals the unbounded one — and it cannot be
   stated through the public surface alone. *Cost if wrong:* renaming a private method
   breaks a test.
3. **`extension/engine/odds.js` gets one line, although the wave-2 ownership table
   assigns it to nobody.** Without it a 2-for-1's season odds are simulated on a 15-man
   roster for one side and a 17-man for the other — the mid-trade rosters, which nobody
   will ever field. The alternative, widening `sent`/`received` to carry the waiver
   move, would make the trade grid offer the partner a player who is being dropped.
   *Cost if wrong:* a one-line conflict for the merger, in a file no other wave-2 phase
   touches. **The final review endorsed this and confirmed zero conflict there.**
4. **`panel.js` exceeds the parallel rules' hunk budget.** One import, one `PHASES`
   entry, one `SHAPES` const, one `start()` block and five one-line `render()` sites,
   against a budget of one-and-one. Each site is individually one line and each is
   load-bearing. Phase 2's report records the same overrun for the same reason.
   *Cost if wrong:* the `render()` merge is done by hand. **The final review endorsed
   this and measured the result: the whole `panel.js` merge onto `main` produces exactly
   one conflict hunk, the import block.**
5. **The bare `1e-12` comparisons become a named `TIE_EPS`.** It is not the same thing
   as `GATE_EPS`: `GATE_EPS` loosens a bound against a user-facing minimum, `TIE_EPS`
   decides when two lineup values are the same number. *Cost if wrong:* one extra
   constant.

### During execution

6. **The plan file's two literal NUL bytes stay as the JS escape `\0`.** Line 814 of
   the plan carries raw NULs as a cache-key separator, which is why the file trips
   grep's binary detection and why the brief extractor truncated that line. The
   implementer wrote `\0` instead, so the runtime string is identical while `search.js`
   stays plain text. Verified no other plan line and no committed source file contains
   a NUL, and that Tasks 3-5's briefs were unaffected. *Cost if wrong:* none — the
   strings are byte-identical at runtime.
7. **The Task 2 Critical stands and the plan was wrong.** The plan's own code guards
   the backfill side's legality and never guards the trim side, so in a `positionLimits`
   league a receiver two men over a cap gets `trim` → `{drop: null, ids: unchanged}` and
   the trade ships an illegal 17-man roster with an inflated gain — reproduced as 12 of
   449 trades on the fixture with an ordinary TE cap of 2. `CLAUDE.md`'s "`positionLimits`
   is a filter" and the plan's own Global Constraint both bind, and the plan's authorship
   does not grade its own work. *Cost if wrong:* one extra `continue` in the hot loop; the
   limitless answer set was confirmed unchanged at 829 trades.
8. **The `dropped`/`displaced` duplication is resolved by suppression** (taken by the
   Task 4 implementer under delegated authority, accepted here). `detailFor`'s displaced
   loop skips the entry whose index equals `d.dropped?.i`, because `moveLines` already
   states the same fact with better causal framing. A provable no-op for every shape
   that sets no `drop`. *Cost if wrong:* the panel omits one displaced line that is
   factually true; the fix is to delete the guard.
9. **`.movenote.add` uses `--accent`, not the brief's `--up`.** `panel.css` has no
   `--up`; `--accent` is this file's existing convention for positive. Disclosed rather
   than invented, as the brief itself required. *Cost if wrong:* one colour token in one
   11px label.
10. **The Task 5 task review and the final whole-branch review were dispatched
    concurrently.** Both are read-only and the branch was frozen; the only thing
    serialising them buys is that a Task 5 fix would land before the final reviewer read
    the file, and against that, a second spend-limit death costs the whole run. *Cost if
    wrong:* the final reviewer reads a `CLAUDE.md` one paragraph out of date. **This
    materialised in its mildest form** — HEAD moved to `4d96c2d` mid-read, and the final
    reviewer verified that commit itself and confirmed it resolved what would otherwise
    have been a Minor in its own report.
11. **The final review's two Important findings are documentation fixes, taken now.**
    Both are false-or-overclaiming prose rather than code defects; see the next section.
    *Cost if wrong:* prose churn in two files, no behaviour change.

## What the final whole-branch review found

Verdict: **ready with the noted fixes** — 0 Critical, 2 Important, 7 Minor. Both
Importants were documentation, and both are fixed on this branch:

**The stated reason the pool bound is mild was false, and the reviewer disproved it by
construction.** `CLAUDE.md` and `search.js` both argued that "the fourth free agent
behind three better men of identical eligibility cannot beat all three into a lineup."
That needs week-by-week dominance, and `_rankVal` ranks on the availability-weighted
*mean* over the horizon while an add's marginal value is a max over assignments — so
week shape can invert the order. On the real fixture, four same-mask free agents (three
flat at 12.0 / 11.9 / 11.8, all pooled; one whose points sit in the last three weeks,
ranked 7.50 and excluded) give the three pooled candidates +0.0000/wk on a 15-man
roster and the excluded fourth **+5.1867/wk**. The pattern is ordinary: an IR stash
about to return, a rookie handed a job, a streamer with a favourable late schedule. The
*limitation* was always declared honestly; the reason given for it being harmless was
wrong, and it sat in the binding rules file where the next maintainer would read it as a
theorem. The direction is safe — a missed better add understates the consolidating
side, so the pool costs recall and can never manufacture a trade.

**The `findTwoForOne` docblock overclaimed.** It said the two bounds were "both exact"
while the sampling caveat lived 700 lines away in `CLAUDE.md`. The docblock is what a
maintainer editing the function reads, so the caveat now appears there too.

Two Minors were taken in the same wave: `trim`'s docblock now states the `drop === null`
contract that `findTwoForOne` depends on, and the non-negativity dependency below is
now written down.

The fix wave (`4eb0ad6`) is comment and prose only — every changed line in `search.js`
is inside a docblock, mechanically verified, and `lineup.js` was not touched. Its scoped
re-review confirmed all four findings addressed with no new breakage, and left one
non-blocking observation: `search.js`'s `findTwoForOne` docblock still opens with "two
upper bounds, both exact" and qualifies it two paragraphs later, so a reader skimming
only the bullet list meets the unqualified phrase first. That is what the fix was asked
to do — add the qualification rather than rewrite the lead-in — and it is recorded here
rather than churned again.

The review also independently re-derived the mathematics rather than trusting the tests:
`weekly` is a convex combination of weighted transversal-matroid rank functions, hence
monotone and submodular for non-negative weights, so both prunes are true upper bounds;
`marg`'s cached parent relation is genuinely maintained rather than assumed; `trim`'s
early exit is a legitimate exit from an exhaustive scan; no `_buf` aliasing path exists;
the `sideMetrics` refactor preserves behaviour including key order; no mid-trade roster
is scored anywhere; and the 427-yield cadence derives exactly from `YIELD_GROUPS`
(337 group + 90 pair). It confirmed the branch adds **no** new position-string
exception, and that the test brute force is genuinely independent of the pruning logic.

## Known limitations

**The backfill pool is the one bounded step, and it bounds the waiver wire, not the
search.** The top three free agents in each seat mask are tried, exactly. A fourth man
of the same eligibility whose points are concentrated in the weeks a roster is thin can
beat all three and still be left out — that is a real recall cost, now stated correctly
in both `CLAUDE.md` and the code. It is one-directional: a missed add understates the
consolidating side.

**The two pruning bounds are exact for a certain roster, and hold only up to sampling
noise when a week holds seven or more uncertain players.** Above `ENUM_MAX`, `weekly`
falls through to `_sample`'s 64 fixed-seed draws consumed in candidate order, so adding
or removing an uncertain player shifts every later draw and the returned mean stops
being a restriction-consistent estimate. The noise is larger than `GATE_EPS`, so a
prune could in principle drop a real trade. It is narrow — only the current week can
hold uncertain players, and it takes seven of them — and the reference test runs with no
availability attached, so nothing automated can see it. Slightly pessimistic as stated:
removing a *certain* player leaves `k` and the draw order untouched, and monotonicity
then holds exactly.

**Every exactness claim requires per-week projections ≥ 0.** `bestLineup` seats players
and adds their values unconditionally, so a negative projection would stop it being a
maximum and both prunes would stop being upper bounds. Nothing violates this today —
the fixture's minimum is 0.00, shrinkage is a convex combination, and the environment
factor and calibration slope are clamped positive — but a future signed adjustment would
break the bounds silently. Now written down.

**An empty or wholly-illegal pool ships a 15-man roster.** A consolidating side then
carries `backfill: null` and ends one man short, which is the honest answer rather than
an error. The fixture never hits it, so no test covers it; the panel guards with
`!= null`, correct for a falsy index `0`. The failure is conservative — a man-short
roster scores lower, so the trade is understated.

**Scaling is named, not bounded in code.** Cost is
`ordered pairs × C(roster, 2) × roster`. A 12-team league with 16-man rosters is ~1.5×
the fixture (≈11 s); 20-man rosters would be ~2.9× (≈21 s). The search stays exact.

## Deferred findings

Not blocking, triaged by the final review:

- `panel.js`'s displaced-line suppression runs after `explain`'s `slice(0, 3)`, so a
  2-for-1 receiving side can show two displaced lines where a fourth true one existed.
  Cosmetic. Fix by filtering in `explain` before the slice.
- `_backfillFrom` returns a `val` no caller reads; `_metrics`'s `out` parameter is
  unused by both call sites. The latter is the one seam where a caller could
  reintroduce the `_buf` aliasing hazard.
- `dropCandidates` is on the render path unmemoised — ~256 `weekly` solves, about 4 ms
  on the fixture, paid again on every filter chip and keystroke. Worth watching once the
  environment sibling's `streamingSection` shares that path.
- `backfillPool`'s `!this.mask[i]` guard is unreachable given `freeAgents`'s own filter.
  Keep it: it is the invariant that makes the pool correct independently of `freeAgents`.
- Section 9's "empty grid" test does not exercise the zero-row `opts.empty` path; the
  `reg` and `playoff` columns share one hint.
- The duplicate empty `panel/` block in `CLAUDE.md`'s map exists on **`main`**, not on
  this branch — it arrived with a wave-2 sibling merge. Delete it when resolving the
  `CLAUDE.md` conflict.

## For whoever merges this branch

Merge **the branch head, not `1dbb3d3`** — later commits add documentation-only lines on
top and are the correct tip.

The merge onto current `main` is four trivial conflicts, all "keep both sides", none
semantic (verified by read-only `git merge-file --diff3` on temp copies):

1. `extension/panel.js` import block — `main`'s `calibrate.js` / `panel/projections.js`
   / `panel/environment.js` imports versus this branch's `panel/roster.js`. Keep all
   four. **Every other `panel.js` hunk auto-merges**, including `PHASES`, the `start()`
   block, the `SHAPES` const, the `trades` composition line and all five `render()`
   sites. The merged file passes `node --check`, and the step order is sane: `s21` sits
   between `s1` and `s2`, after `proj` and `env`, both of which must precede `Engine`
   construction and do.
2. `CLAUDE.md` map, `panel/` block — keep `projections.js`, `environment.js` and
   `roster.js`, and delete `main`'s empty duplicate `panel/` line.
3. `CLAUDE.md` map, `test/` block — keep both `environment.mjs` and `roster.mjs`.
4. `extension/panel.css` tail — `main`'s streaming rules versus this branch's
   `.movenote`. Keep both; they share no selector.

One semantic point the merge cannot make for you: `main`'s `CLAUDE.md` still says
"Nothing in the search is approximated, with **one** named exception." This branch
rewrites that to **two**. Git takes the branch's version cleanly — confirm it did,
because the sentence is now load-bearing for the backfill pool.

Ownership exceptions to record: `odds.js` was assigned to nobody this wave and takes
three lines here (one code, two comment) — Ruling 3. `panel.js` exceeds the hunk budget
by design — Ruling 4. Neither conflicts with a sibling.

New load-time cost: `findTwoForOne` adds about 7 s on a ten-team, 16-man league, before
2-for-2's ~14 s. Nothing new leaves the machine; no new host, no new fetch.

## Browser verification — pending

None of the UI has been opened in a browser. A human should load the extension against
a live league and confirm:

- [ ] A **2-for-1 trades** step appears between "1-for-1" and "2-for-2", its progress
      bar advances smoothly rather than in one jump over roughly 7 s, and its done note
      shows a trade count.
- [ ] The shape chip row shows four chips — **1-for-1, 2-for-1, 2-for-2, 3-team** — all
      active by default, and toggling **2-for-1** filters the grid correctly.
- [ ] A 2-for-1 row shows, under the received package, either a green
      `+ <player>  waivers` note or a dimmer `drop <player>` note — never both on the
      same side.
- [ ] The detail panel names the waiver add ("Fills the empty seat with X from waivers —
      N starts") on the sending side and the drop ("Drops X to make room — N starts
      given up") on the receiving side.
- [ ] The dropped player does **not** also appear as a separate "loses N starts" bullet,
      while genuinely displaced players still do.
- [ ] The **Shape** column header hint shows the existing explanation followed by the
      2-for-1 one.
- [ ] A **Drop candidates** section renders after "Free agents worth adding", with
      Player / Pos / Status / Cost per week / Reg. season / Playoffs / Best add if
      dropped / Add gain / Net, sorted ascending by cost, and **sorts on all nine
      columns** — no test exercises the real `grid()` implementation, only an injected
      stub, and none exercises the zero-row empty state.
- [ ] Switching between "All teams" and a specific team changes which roster the Drop
      candidates table describes.
- [ ] The `.movenote` colours read correctly under the real `--accent` / `--dim` /
      `--faint` tokens, in both light and dark.
- [ ] The added ~7 s does not make the loading screen feel hung on a real league.

## Verification worth doing that this phase did not

- `node extension/test/run-all.mjs` **after the merge**, on the merged tree — the only
  gate that exercises this engine alongside the environment and projections siblings'
  pre-`Engine` mutations of `p.proj`.
- Add the capped brute force to `roster.mjs` section 6b (section 6's loop against the
  capped two-team engine, plus a `legal` guard and a null-`cutIds` skip, which the
  file's own comment identifies as what is missing). This closes the one real coverage
  gap, in the exact area the phase's only Critical came from. About a second to run.
  The final review traced the capped paths by hand and found no recall hole.
- A ten-team `findTwoForOne` against a full brute force, as a one-off rather than a
  suite member — the equivalence is currently proved on a two-team sub-league. Over a
  minute.
- A run with availability attached and seven or more uncertain players on one roster,
  pruned against unpruned, to put a number on the sampling-noise caveat instead of
  leaving it qualitative. Nothing today measures it.
