# Phase 6 — Usage: opportunity signals, breakout watch and FAAB bids — build report

**Status:** complete, reviewed, not merged and not pushed.
**Branch:** `phase6-usage`
**Worktree:** `.claude/worktrees/agent-a2917610c38eabf53`
**Base (merge-base with `main`):** `3882e6a`
**Head:** this commit; the last code commit is `84eee93`.
**Spec:** `docs/superpowers/specs/2026-08-27-usage-design.md` (binding)
**Parallel-work rules:** `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md` (binding, wave 3)
**Plan:** `docs/superpowers/plans/2026-08-27-usage.md`
**Ledger:** `.superpowers/sdd/2026-08-27-usage/progress.md`
**Process:** `superpowers:subagent-driven-development` — one implementer per task, a spec+quality
review after each, one fix round on Task 5, one scoped re-review.

## What shipped

Opportunity evidence beside the engine's numbers. The engine says a trade is worth 3.1 points a
week; it cannot say whether the player it wants is being fed the ball more than his box score
shows yet. Sleeper's weekly box score carries snaps, targets, air yards, carries and dropbacks,
which lead scoring by a week or two, and this phase turns them into five signals and a bid.

- **Usage signals.** Snap share, target share, WOPR, touchdowns over expectation (`tdOver`) and
  the points-on-usage residual (`ppgOverUsage`) — a one-variable OLS of points on the position's
  own opportunity driver, so the residual answers "who is scoring more than his opportunity
  explains". Shares are ratios of sums over the weeks a player has a row in, not means of weekly
  ratios.
- **Assets and targets (usage).** A sell-high grid (yours, residual and `tdOver` both in the
  position's top quartile) and a buy-low grid (someone else's, driver above the position median
  and residual in the bottom quartile), each joined to the search's own best offer for that name.
  `assetRows` returns the quartile cut points alongside the two lists so a test can check it.
- **Breakout watch.** Rising driver trend plus low snap share, cross-checked against Sleeper's
  24-hour add count and against a depth-chart improvement measured between runs (`ffsm.depth`).
- **Quiet vs contested waivers.** The free-agent grid gains a `Crowd 24h` column and a relative
  contested threshold with a floor, so an upgrade nobody else has noticed is visible as such.
- **Suggested FAAB bids.** A `Bid` column: the league's remaining budget split across the top
  five upgrades in proportion to gain, nudged by the crowd, off-round rounded, clamped, and shown
  beside the most the add is worth. A no-FAAB league shows a dash.

| File | What it is | Lines |
|---|---|---|
| `extension/engine/sources/sleeperstats.js` | One request per played week against `api.sleeper.app/stats/nfl/{season}/{week}`, trimmed to twelve fields. A finished week caches for a week, the most recent for six hours. Accepts both response shapes Sleeper has served. | 91 |
| `extension/engine/usage.js` | The usage math: `usageTable`, `assetRows`, `breakouts`, `depthChanges`, `crowdSplit`, `bestOfferFor`, plus `USAGE_K`, `DRIVER`, `quantile`, `ptsKeyFor`. No DOM, no fetch. | 347 |
| `extension/engine/faab.js` | `faabBids`, `offRound`, `FAAB_K`. Pure arithmetic over an upgrade list. | 95 |
| `extension/panel/usage.js` | Every string of usage HTML, the hints, and the loader that swallows a dead feed. No `document`, `window` or `chrome` at module load; `grid` is injected. | 402 |
| `extension/engine/league.js` | Two hunks only: `settings.faabBudget` and `rec.faabSpent`. | +6 |
| `extension/panel.js` | Eight wiring hunks. | +28/−2 |
| `extension/test/usage.mjs` | 191 offline assertions (fetch, storage and clock injected). | 651 |
| `CLAUDE.md` | Architecture map plus one load-bearing note. | this commit |

Untouched, verified by `git diff --name-only 3882e6a..HEAD`: `extension/engine/search.js`,
`extension/engine/season.js`, `extension/engine/sources/cache.js`, `extension/panel.css`,
`extension/manifest.json` — zero files in that list changed. `extension/test/parity.mjs` is
byte-identical to the merge-base (`git diff --quiet 3882e6a HEAD -- extension/test/parity.mjs`
returns nothing).

## Commits

| SHA | Subject |
|---|---|
| `2faa2d2` | Plan Phase 6: usage signals, breakouts, crowd waivers and FAAB |
| `47ed9e0` | Add the Sleeper weekly usage feed |
| `4b97381` | Measure what each player is being given, not just what he scored |
| `988579e` | Pick out who to sell, who to ask for, and who is breaking out |
| `8a621a7` | Suggest what a waiver add is worth bidding |
| `c8df25f` | Show the usage behind a sell-high, a buy-low and a waiver claim |
| `12fda35` | Tell a dead crowd feed apart from a crowd of nobody |
| `84eee93` | Put usage, breakouts and bids on the page |
| _(this commit)_ | Record what Phase 6 built, ruled and left unverified |

`12fda35` is Task 5's fix round, not a new task.

## Final test output

```
$ node extension/test/run-all.mjs
=== availability.mjs ===
  sampling error at k=7: 2.21%
  k=7 sampling gap: 2.78%

463 assertions, 0 failures
AVAILABILITY OK

=== market.mjs ===

141 assertions, 0 failures
MARKET OK

=== parity.mjs ===
slots: 9 starters/week  [1, 2, 2, 4, 4, 6, 16, 17, 23]
  per-trade odds: 39 ms per trade at 2000 sims

605 assertions, 0 failures
ENGINE OK — reproduces the verified baseline exactly

=== sources.mjs ===

14 assertions, 0 failures
SOURCES OK

=== usage.mjs ===

191 assertions, 0 failures
USAGE OK

5 files, 0 failing

$ node --check extension/panel.js
(no output)
```

## Rulings, in the order they were made

Eleven decisions taken without a human. Each is listed with what it costs if it turns out wrong.

**1. The uncommitted Task 3 test diff was kept as-is and committed with Task 3's
implementation.** The branch was resumed with an unstaged diff on `extension/test/usage.mjs`
adding test section 3; compared line for line against the plan's Task 3 Step 1 it was
byte-identical apart from one trailing blank line, and the plan states every number in it was
produced by executing the fixture before the plan was committed. Revising it would have meant
re-deriving measured constants by hand.
*Cost if wrong:* a wrong expected value in section 3 that the implementer then codes toward.
Mitigated by the reviewer checking assertions against the plan text and by the quartile
arithmetic being hand-checkable, which the pre-flight scan did.

**2. Task 4's "Three rulings to transcribe as comments" heading is a miscount; all four rulings
were transcribed.** The fourth — `offRound`'s type-guarded second parameter — is the one the plan
says was found by running the arithmetic, and dropping it reintroduces a `NaN`. The count word is
wrong, not the content.
*Cost if wrong:* one extra comment block.

**3. Task 7's `CLAUDE.md` insertion follows the tree actually in this worktree, not the literal
paste in the plan.** The plan itself says to grep first and match what is there.
`engine/usage.js` and `engine/faab.js` go with the other `engine/` files, before the nested
`sources/` block rather than after it; `sleeperstats.js` goes inside `sources/` aligned with its
siblings, not as a flattened `sources/sleeperstats.js` line; `test/usage.mjs` is added to the
`test/` block, which the plan's Step 1 omits.
*Cost if wrong:* a cosmetically wrong tree in a doc, one line to move.

**4. Task 7 also writes this report.** The plan's Task 7 covers only `CLAUDE.md`, but every merged
phase on `main` carries a `-REPORT.md` beside its plan (`availability`, `market`, `projections`),
the merger reads them, and this branch's rulings and known gaps have nowhere else to land.
*Cost if wrong:* one extra doc file that nobody needed.

**5. This worktree's `CLAUDE.md` predates the `phase5-projections` merge, and Task 7 edited it as
it stands here rather than reconciling with `main`.** Branching from `3882e6a` means
`aggregate.js`, `calibration.js` and `panel/projections.js` are absent from this copy's map.
Adding them here would fabricate a merge.
*Cost if wrong:* the architecture-map hunk conflicts textually on merge. See **Merge notes**.

**6. Commit trailers keep `Co-Authored-By: Claude Fable 5`,** as the plan's Global Constraints
require and as `47ed9e0` and `4b97381` already did, even though the repo's recent history and the
harness default say `Claude Sonnet 5`. Consistency within the branch beats consistency with the
repo for a trailer.
*Cost if wrong:* a wrong attribution line in seven commits.

**7. Task 6's eight `panel.js` hunks stand,** although the wave rules cap `panel.js` at "one
import line, entries in `PHASES`, one block in `start()`, one call site in `render()` per new
section/column". The plan's Global Constraints explicitly authorize exactly eight named hunks and
argue the alternative — relocating the free-agent grid into `panel/usage.js` — is the wider,
conflict-prone edit. Eight decompose as 1 import + 1 `PHASES` + 1 `start()` block + 5 `render()`
sites, which is the rule's shape at the rule's own granularity. Phases 2 and 4 recorded the same
overrun.
*Cost if wrong:* the `render()` merge is done by hand. See **Merge notes**.

**8. The `league.js` change is 6 insertions, not the 5 the plan asserts, and 6 is correct.** The
implementer flagged the mismatch rather than trimming a line to hit the number. The diff is
exactly the plan's two hunks and nothing else: Hunk A is a 2-line comment + `const faabBudget` +
the `faabBudget,` return field (4), Hunk B is a 1-line comment + the `rec.faabSpent` assignment
(2). The plan's own verbatim code sums to 6; its "5 insertions and 0 deletions" gate is an
off-by-one in the plan. Trimming to satisfy the gate would have deleted either a provenance
comment or a functional line.
*Cost if wrong:* none to the code; the plan's verification step reads one line wrong for anyone
re-running it.

**9. Task 5's finding 1 is real and was fixed, though `live: !!view` is brief-verbatim.** When
Sleeper's *trending* endpoint alone is down, `usageOrNull` deliberately continues with
`trending = []`, so `view` is non-null, `wv.live` is true, and every free agent renders a green
`0` adds — an affirmative claim that nobody wants him — while `crowdSplit`'s `max` of 0 marks the
whole field uncontested. The spec's own words are "a dead feed … shows `—`", and this project's
invariant is that a missing number and a zero are different claims; a single `live` flag cannot
express a half-dead feed, which is the one degradation its own loader was written to survive.
`usageOrNull` now carries a separate crowd-liveness flag through `usageView` into `wv.live`.
*Cost if wrong:* one extra boolean threaded through three functions in a file no other phase
touches; Task 6's `panel.js` never reads `live` directly, so the wiring is unaffected.

**10. Task 5's finding 2 is a defect even though the assertion is brief-verbatim.** The behaviour
was right on the merits — a bid derives from engine gains and the league budget, not from Sleeper
— but the assertion message said "both showing a dash" when the bid cell shows `$81 /80` and the
`/—/` regex passes on the crowd dash alone. A message claiming more than its assertion checks is
a defect, and the plan's authorship does not grade its own work. The label now names the crowd
cell.
*Cost if wrong:* nothing; it is a string.

**11. The `mySpent`-by-display-name lookup is parked, not fixed.** See **Parked findings**.

## Parked findings — real, not fixed, with why

**P1 — `panel.js:663` looks up my FAAB spend by team display name.**
`[...model.teams.values()].find((t) => t.name === myTeam)?.faabSpent ?? 0` returns the first
match, so a league with two identically-named teams would read the wrong `faabSpent` and show a
wrong suggested bid. It is real. It is also brief-verbatim H4, and the reviewer found the same
by-name lookup already load-bearing at `panel.js:200`, `:354`, `:476` and `:1002` — so fixing it
properly means keying five call sites on ESPN team id, in a file whose whole constraint this wave
is minimal hunks, with four other phases editing it concurrently. The blast radius is one
advisory column that both `CLAUDE.md` and the panel copy already label a heuristic, and it never
reaches the search.
*Cost if wrong:* a manager in a league with two identically-named teams sees a wrong bid figure;
nothing else moves. **Follow-up:** key the team lookup on ESPN team id rather than name, at all
five sites at once, once the wave's phases have merged.

## Deviations from the spec

Four, each recorded as a ruling in its own task. None blocks merge.

| Deviation | Why |
|---|---|
| `pass_att` added to `STAT_FIELDS` | Without it a quarterback has no opportunity driver, so `DRIVER.QB = "dropbacks"` has nothing to compute from. |
| A quarterback's `tdOver` is `null` | A passer's touchdowns are overwhelmingly thrown, and `STAT_FIELDS` carries no passing touchdowns. Reporting `rec_td + rush_td` against an expectation built from carries would be a rushing-only number wearing a regression label. |
| The contested threshold is relative with a floor, not absolute | An absolute add count means one thing in a week the whole league is watching one injury and another in week 14. `USAGE_K.CROWD_SHARE` with `CROWD_FLOOR` under it scales with the week's actual attention. |
| `waiverRank` is not added to `league.js` | The spec asks a no-FAAB league to show a waiver-priority number; it shows a dash instead. Adding it means a third hunk in `league.js`, which Phase 10 owns. **Parked for Phase 10.** |

## Plan defects found by building it

Two, both ruled on rather than worked around. Recorded so the plan is not re-run against them.

- **Task 4's verification step asserts the `league.js` diff will be "5 insertions and 0
  deletions"; its own verbatim code sums to 6.** The code is right, the count is wrong (ruling 8).
- **Task 4's heading reads "Three rulings to transcribe as comments" above a list of four**
  (ruling 2).

## Review record

Every task passed a spec+quality review. Tasks 3, 4 and 6 were clean first time. Task 5 returned
**Needs fixes** — spec ❌ on two counts, 4 Important, 5 Minor — and took one fix round (`12fda35`)
followed by a scoped re-review over `c8df25f..12fda35` alone, which verdicted all four findings
ADDRESSED with no new Critical or Important breakage.

Three things worth carrying forward from the reviews:

- The Task 5 reviewer endorsed the implementer's one deviation from its brief: `SINK = -1e9`
  instead of the brief's `-1` sort sentinel, because `-1` would have sorted a genuine "−3.6
  touchdowns under expectation" *below* a missing value.
- Task 5's implementer mutation-tested the three `esc` sites one at a time; each removal produces
  exactly one named failure, so the direct `o.row(...)` calls genuinely bite. This is the gap the
  market phase's Task 4 shipped with, and the brief was written to prevent it.
- The Task 6 reviewer read `panel.js` directly rather than trusting diff context and confirmed
  each hunk's scope, the 10/10 free-agent column parity, that the trade-detail
  `colspan="${tradeCols.length}"` tracks the *trade* grid and is untouched, and that
  `Steps.set("s1", "run")` is reached unconditionally so a dead usage feed never gates the search.

**Process note.** The controller crashed on an API spend limit after dispatching Task 6's
reviewer. On resume the ledger held no verdict and the reviewer's result was unrecoverable, so
the review was re-dispatched from the same package. No code was re-run and no commit repeated —
`84eee93` was already on the branch and the tree was clean.

## Deferred minors

None blocks merge. Listed so they are not lost.

| Where | What |
|---|---|
| `usage.js` | `assetRows`'s `asc()` helper sorts `ppgOverUsage` twice per position instead of once. Inherited verbatim from the brief; negligible at this data scale. |
| `usage.js` | The quartile positions `0.25` / `0.5` / `0.75` are inline literals rather than `USAGE_K` entries. Standard statistical definitions, not tunable thresholds. |
| `faab.js` | No test pins a pool of fewer than five upgrades. Correct by inspection (`slice(0, K.TOP)` degrades, `denom > 0` guards) but unpinned. |
| `faab.js` | No test pins `max` when `myRemaining === 0` (the `rate = null` path). Sound by inspection. |
| `faab.js` | The urgency base/cap `1` and the `Math.max(1, …)` bid floor are inline literals rather than `FAAB_K` entries. Structural constants of the formula, not tunable thresholds. |
| `panel/usage.js:299` | ~~A missing NFL team renders as a bare `esc(r.nfl ?? "—")`~~ — **fixed in the final-review fix wave**: wrapped in `<span class="zero">` like every other dash in the file. |
| `panel/usage.js` | `faCrowdCols` keeps the brief's `-1` sort sentinel four lines from the docstring explaining why `-1` was rejected in favour of `SINK`. Harmless — crowd counts and bids are non-negative — but it reads as an oversight. |
| `panel/usage.js` | The buy grid's `owner` column is the only column with no hint, because `USAGE_HINT` has no `owner` key. |
| `panel/usage.js` | ~~`USAGE_HINT.crowd` promises "how many Sleeper leagues added him in the last 24 hours" but the value is 0 for anyone outside Sleeper's trending top-N even on a healthy feed~~ — **fixed in the final-review fix wave**: the hint now says so. |
| `panel.js:21` | ~~`USAGE_HINT` is imported and referenced nowhere else~~ — **fixed in the final-review fix wave**: the name is dropped from the import. |
| process | A Task 5 report presented an assertion-count split ("116 + 48") as measurement; it does not reconcile with the `ok()` calls in section 5. The 191 total is measured; that split was not. |

## Follow-ups for the merge

Recorded, not fixed here — this fix wave was scoped to the findings above it. Each entry carries
enough for whoever picks it up cold.

**I1 — the outer 15s race can discard a partially-loaded season.** `panel/usage.js` around line 113
wraps the *whole* season load in `Promise.race([work, timeout(15000)])` — the Sleeper players file
plus up to 17 week requests at concurrency 4. `loadSeasonStats` was written so one bad week costs
precision, not the feature, and the outer race discards that: if week 15 of 17 is still in flight at
15s, the user gets "unavailable" and zero weeks instead of 14 weeks of usage. Late-season cold starts
are exactly the case that trips this. It self-heals across runs — `cached()` awaits `storage.set`
before returning, so completed weeks are banked — but the first run shows "unavailable" with no hint
that a retry would help. Fix later by giving the timeout to `loadWeekStats` per week, or by resolving
with whatever `byWeek` holds instead of rejecting the whole batch.

**I3 — the WOPR column dashes for every RB and QB, in a section whose job is saying why.**
`assetRows` (in `extension/engine/usage.js`) selects buy-low on `r.driver >= c.drvMed`; for a WR/TE
the driver *is* WOPR and the column shows it, but for an RB the driver is `touches` and for a QB
`dropbacks` — both computed and carried on the row, neither rendered in `assetCols`/`assetRow` in
`extension/panel/usage.js`. So a user sees "he's in the bottom residual quartile" and a blank where
"and he's getting above-median touches" belongs. `USAGE_K.MIN_FIT` is 3, so ordinary leagues will
populate RB rows and hit this. Fix later by rendering `r.driver` when the driver key is not WOPR,
relabelling the column "WOPR / touches", and keeping `sortNum(r.driver)` as the sort key. This is a
gap in the spec's literal column list, not an implementation defect — the build matches the spec.

**Ruling 16, for the merger.** The wave-3 ownership table assigns `extension/engine/league.js` to
Phase 10, with an exception granted only to Phase 9. This branch's 6-line edit (`settings.faabBudget`
and `rec.faabSpent`) has no exception in the rules; the plan's Global Constraints authorised it and
the controller ruled it stands, because reverting it strands `faab.js` with no budget to read.
**Phase 10 must be told `faabBudget` and `faabSpent` already landed in `readSettings` and the
team-record block**, and that `waiverRank` — the field this branch left as a dash (see Deviations
from the spec) — wants to sit beside them.

**Ruling 17, amending the existing `mySpent` follow-up (P1 above).** The existing note says the
by-display-name team lookup should be keyed on ESPN team id at the five `panel.js` sites once the
wave merges. The real root is deeper: `extension/engine/search.js` builds `this.roster` as a `Map`
keyed on `t.name` (verified at lines 85–88: `this.roster = new Map(); for (const t of
model.teams.values()) { this.roster.set(t.name, …) }`), so in a league with two identically-named
teams one team's entire roster is silently overwritten by the other's, and **every trade, gain,
lineup and season projection for that league is already wrong** long before the FAAB column is
reached. The bid figure P1 describes is a symptom of that, not the bug itself. Amend the follow-up
to name `search.js` as the root and the `panel.js` by-name lookups (`:200`, `:354`, `:476`, `:663`,
`:1002`) as downstream consequences that inherit the same fix once `search.js` keys teams by id.

**Merge-order note.** Of the eight `panel.js` hunks, the riskiest is not any insertion — it is the
heading/subtitle replacement at H8 (the only two lines this branch *deletes* from `panel.js`, the
old "Free agents worth adding" heading and subtitle). Every other hunk is a pure insertion a sibling
phase can merge around; a deletion in a section Phase 10 (waivers) is likely to rewrite is where a
conflict becomes a judgment call rather than a mechanical one. Recommend merging this branch before
Phase 10 if the merge order is free to choose.

**M4 — the Sleeper weekly-stats cache keys are unpruned, the same kind of housekeeping debt
`CLAUDE.md` already documents for the calibration log on `main`.** `extension/engine/sources/
sleeperstats.js`'s `loadWeekStats` writes `src.sleeper.stats.{season}.{week}` — up to 17 keys per
season — and nothing prunes them across seasons; a user who returns to this extension season after
season keeps every week's key forever. This worktree's copy of `CLAUDE.md` predates the
`phase5-projections` merge (ruling 5), so it carries no calibration-log paragraph to extend here;
this note is parked in the build report instead, as the task instructions for this fix wave direct,
and should be folded into whichever paragraph documents that debt once the two `CLAUDE.md` copies
are reconciled on merge.

## Browser verification — revised in the final-review fix wave

This environment has no browser, and **no part of this phase's UI has been exercised.** The two
engine modules and the panel module carry 196 assertions; `extension/panel.js`'s eight hunks carry
none and cannot — `panel.js` is a DOM module and the repo has no browser harness. `node --check`
plus a hunk-by-hunk read by the implementer and again by the reviewer is the whole of the
verification on that file. Every string of HTML in `extension/panel/usage.js` is asserted as a
string, which is not the same as having been rendered. This is the largest residual risk of the
phase.

The final whole-branch review judged the checklist below, as it stood, **not adequate**: it tests
the degradation paths thoroughly and the working path not at all, which is backwards for a feature
whose degradation paths carry the bulk of those 196 offline assertions and whose working path
carries none. The old item 1 accepted amber ("unavailable") as a pass, so a feature whose Sleeper
endpoint was simply wrong could tick every box on the list. This revision keeps every item that
still holds, fixes the ones that mislead or cannot be run as written, and adds the ones the review
found missing — most importantly, a hard requirement that the working path actually be seen green.

Load `extension/` unpacked via `chrome://extensions` → Developer mode → Load unpacked, open the
panel on a real in-season league, and walk this list before trusting the feature.

- [ ] **a1 — the loading checklist must go green.** `Usage and trends` must finish **green** with a
      player count in the low hundreds — amber ("unavailable") here is a **failure**, not an
      acceptable degrade, because it means the working path was never actually seen. Separately,
      confirm the naming: **Sell high** names players you recognise from your own roster, and
      **Breakout watch** names real free agents or lightly-rostered players, not garbage rows.
- [ ] **Free agents worth adding — quiet vs contested** — the heading reads that way, the
      subtitle mentions Crowd and Bid, and the grid has ten columns with `Crowd 24h` and `Bid`
      last. Hover both new headers for their tooltips, and sort by `Crowd 24h` and by `Bid` in
      both directions. **b5 —** rather than eyeballing column parity across 25 rows, run this in
      the console (`#faGrid` is the free-agent table's real id, from `extension/panel.js`'s
      `grid("faGrid", …)` call):
      ```js
      document.querySelectorAll('#faGrid thead th').length
        === document.querySelectorAll('#faGrid tbody tr:first-child td').length
      ```
      should read `true`.
- [ ] **a2 — plausibility of the numbers, not just their presence.** All 196 assertions run
      against a synthetic fixture the tests build themselves, so nothing verifies that Sleeper
      actually calls the fields `off_snp`, `tm_off_snp`, `rec_air_yd` and `pass_att`. If
      `tm_off_snp` is absent, `snapShare` is `null` for *every* player and the step **still goes
      green with a full player count** — and in Breakout watch, a `null` snap share is treated as
      low-usage, so the whole league becomes breakout-eligible. Pick your league's clearest WR1:
      Snap% should read 80–95%, Tgt% 20–30%, WOPR 0.5–1.0. Pick a quarterback: his `TD ±` must be a
      dash (this feed carries no passing touchdowns) and his Snap% must sit near 100%. **Any column
      that is a dash for every row is a broken field name, not a quiet week.**
- [ ] **Dashes, not blanks.** First, from the panel's DevTools console, clear every cached key so a
      genuinely dead feed cannot be masked by a stale cache from an earlier successful run:
      ```js
      chrome.storage.local.get(null, (all) => {
        const keys = Object.keys(all).filter(k => k.startsWith("src.sleeper.") || k === "ffsm.depth");
        chrome.storage.local.remove(keys);
      });
      ```
      **Then** block `api.sleeper.app` in DevTools → Network and reload. The usage step goes amber,
      both new columns show `—` in every row, the grid still has ten columns, and the two new
      sections show their "Usage signals unavailable" empty states. The trade tables and the
      free-agent gains are unchanged. (Without the clear-storage step first, `cached()` in
      `engine/sources/cache.js` serves the prior run's stale copy on a fetch failure and this item
      would falsely pass against a genuinely dead feed.)
- [ ] **The half-dead feed** — this is ruling 9 and it is the one degradation with no live check.
      The real request is `https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50`
      (`/v1/`, plus a query string — DevTools matches the exact URL, so blocking the bare path
      blocks nothing). First remove the `src.sleeper.trending.add.24` key from `chrome.storage.local`
      (it caches for an hour and would otherwise serve from storage regardless of the block), then
      block the URL *pattern* `*trending/add*` and reload. The `Crowd 24h` column must show `—`, not
      a green `0`, and the contested split must not claim every upgrade is quiet.
- [ ] **The two new sections** appear after the market arbitrage section and before `League
      strength`: **Assets and targets (usage)** with the sell-high / buy-low tables and the
      offer column joined from the search, then **Breakout watch**.
- [ ] **a4 — sort the two new grids, and Sell high / Buy low / Breakout watch too.** Click every
      sortable header in **Sell high**, **Buy low** and **Breakout watch**, both directions. These
      three grids sort on `SINK = -1e9` through `sortNum` across several columns that are
      legitimately null for some rows; a `NaN` reaching `grid()`'s numeric comparator produces a
      silently arbitrary order rather than a console error, so a clean console would not catch a
      broken sort. Dashes must clump at one end of every sorted column, never interleave with real
      numbers.
- [ ] **The FAAB bid figures** appear only in a FAAB league. In a waiver-priority league the `Bid`
      column should be all dashes — this is the `waiverRank` deviation, and a dash there is
      expected, not a bug. **b4 — if your league(s) are all FAAB**, you cannot exercise the
      priority-mode dash directly; instead, in the console set `model.settings.faabBudget = 0` and
      re-render. **a3 — read your remaining budget off ESPN's own waiver page**, not off this
      panel, and confirm the suggested bids are scaled against *that* number, not the full season
      budget: if ESPN's `transactionCounter` is ever missing from the league payload,
      `faabSpent` silently reads 0, `myRemaining` becomes the *full* budget, every bid inflates
      accordingly, and "no bid exceeds the remaining budget" still passes because the budget it is
      being checked against is wrong. **Note (post-I4):** a manager who has spent his whole budget
      now shows `$0` in the Bid column, not a dash; a waiver-priority league (or the console
      override above) still shows a dash. Confirm you can tell the two apart on screen.
- [ ] **The trade detail row** still spans the full trade table when you expand a trade — confirm
      the expanded panel is not one or two columns short.
- [ ] **Switching the viewed team** and changing filters re-renders without error; the console
      should stay clean. **a5 — and Sell high / Buy low must not change** when you do: `assetsSection`
      deliberately fixes on `myTeam` and ignores the "who" selector, the same way `arbitrageSection`
      does, because "sell high" and "buy low" are statements about your own roster. Switching the
      viewed team to somebody else must re-render everything else but leave those two grids alone.
- [ ] **b3 — the depth-chart memo, as a deterministic two-minute exercise** rather than waiting on a
      real depth-chart move to coincide with a breakout-eligible player in this league. Run the
      panel once and confirm, from the console, that `chrome.storage.local.get("ffsm.depth")`
      returns an object with a populated `.order`. Then bump it and reload:
      ```js
      chrome.storage.local.get("ffsm.depth", ({ "ffsm.depth": memo }) => {
        memo.at -= 24 * 3600e3;                        // force the snapshot to roll forward
        const sid = Object.keys(memo.order)[0];
        memo.order[sid] += 1;                           // simulate a one-slot chart move
        chrome.storage.local.set({ "ffsm.depth": memo });
      });
      ```
      Reload the page: that player should now show a depth-chart delta in Breakout watch (or in the
      Depth column, if he is already listed). This drives `depthChanges`'s full before/after path,
      which is the only part of it needing a browser — the arithmetic itself is already pinned in
      `extension/test/usage.mjs`.
- [ ] **Privacy.** The Network tab shows requests to `api.sleeper.app` carrying season, week and
      position only — no league id, team name or player list.

## Merge notes

Two textual conflicts are expected. Both are known and neither is a code conflict.

**`CLAUDE.md`.** This branch's copy predates the `phase5-projections` merge, so its map has no
`aggregate.js`, `calibration.js` or `panel/projections.js` (ruling 5). The architecture-map hunk
will conflict textually. The resolution is mechanical: keep `main`'s block and add this phase's
five lines — `engine/usage.js`, `engine/faab.js`, `engine/sources/sleeperstats.js`,
`panel/usage.js`, `test/usage.mjs`. The load-bearing note is a whole new paragraph inserted after
"Nothing in the search is approximated" and before "Market values are display and ranking only";
it should apply cleanly, and if a sibling phase inserted at the same anchor, add to it rather
than reverting.

**`extension/panel.js`.** Eight hunks, 28 insertions and 2 deletions. The 2 deletions are H8's
replaced free-agent heading and subtitle — the only lines this branch removes from the file.
Hunk anchors, as they stood at `84eee93`: import block after `panel/availability.js` (21-22),
`PHASES` entry after `market` (37), the `start()` block between the market `Steps.set` and
`Steps.set("s1", "run")` (432-439), `render()` locals after `const mkt` (660-663), `waiverView`
before `faGrid` (920-921), the `faGrid` column spread (932), the row cell spread (947), and H8's
heading plus the two new sections after `arbitrageSection` (1137-1150). Phases 2, 4 and 5 all
insert into `panel.js`; where they land at the same anchor the merge is done by hand (ruling 7).

**`extension/engine/league.js`.** Two hunks, 6 insertions, no deletions:
`settings.faabBudget` after the `pprValue` block and `rec.faabSpent` inside the
`t.record?.overall` block. Phase 10 owns this file next and will want `waiverRank` beside
`faabBudget`.

Nothing else is shared. `extension/test/usage.mjs`, `extension/engine/usage.js`,
`extension/engine/faab.js`, `extension/engine/sources/sleeperstats.js` and
`extension/panel/usage.js` are all new files owned by this phase.

The branch is not merged and not pushed. `superpowers:finishing-a-development-branch` is the next
step. Before it, the browser checklist's half-dead-feed item is the one thing worth checking on a
live league, since it is the one degradation path the fix round introduced and no test can prove
end to end.
