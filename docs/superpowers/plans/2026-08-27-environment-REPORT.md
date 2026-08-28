# Phase 7 — Game environment: build report

Plan: `docs/superpowers/plans/2026-08-27-environment.md`
Spec (binding): `docs/superpowers/specs/2026-08-27-environment-design.md`
Rules: `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`

| | |
|---|---|
| Branch | `phase7-environment` |
| Worktree | `/Users/joshbaltzell/Documents/GitHub/FF Trade Identifier/.claude/worktrees/agent-aa6cd222496321c2e` |
| Branch base | `f9e08ca` (merge-base with `main`) |
| Head | `df23d37` |
| Process | `superpowers:subagent-driven-development` — fresh implementer per task, task review after each, one whole-branch review, one fix wave |
| Not done | Not merged, not pushed. `main` and every other worktree untouched. |

The phase was built in two controller sessions. The first was killed by an API limit
after Task 4; the second resumed from the ledger, restarted Task 5 (its implementer
had died before writing anything) and carried the phase through the final review and
the fix wave.

## What was built

Reads the NFL betting market and the kickoff forecast, turns them into one
multiplicative factor per player-week on the current week and the next, and adds a
three-week hold-or-churn planner for the roster slots where the waiver wire is
genuinely competitive.

| File | What it is |
|---|---|
| `extension/engine/sources/stadiums.js` | 32 rows: proTeamId → lat, lon, roof. `PRO_TEAM_ID`, `stadiumOf`, `isOutdoor`. |
| `extension/engine/sources/vegas.js` | ESPN core API odds. Implied team totals from the spread and the over/under. |
| `extension/engine/sources/weather.js` | Open-Meteo wind and precipitation at kickoff, open-roof stadiums only, one fetch per *stadium*. |
| `extension/engine/environment.js` | `ENV_K`, `envGroup`, `avgImplied`, `vegasFactor`, `weatherFactor`, `applyEnvironment`. |
| `extension/engine/streaming.js` | `STREAM_SLOTS`, `streamPlan`. |
| `extension/panel/environment.js` | Every line of the phase's UI. |
| `extension/panel.js` | Nine hook-point hunks, +19/−1. |
| `extension/panel.css` | Four appended rules. |
| `extension/test/environment.mjs` | 151 assertions across five sections, all offline. |
| `CLAUDE.md` | Architecture map, two load-bearing decisions (the factor, and the C4 deferral). |

Whole-branch diff against `f9e08ca`: 11 files, +3290/−3 — of which the plan document
is 1858 lines. `CLAUDE.md` is +36/−2.

## Commits

```
312e332  Plan the game-environment phase: lines, weather, streaming
853d31e  Add the stadium table: where each NFL team plays, and its roof
4311821  Read Vegas totals and spreads from ESPN's core API
5e957a2  Read kickoff wind and rain from Open-Meteo for open-roof games
7c82401  Gate weather rows on a real wind reading, not a defaulted zero
9f44b6d  Turn lines and weather into a per-player-week projection factor
ae2d1b4  Plan three weeks of streaming at the slots worth churning
445a8b0  Show the game environment and a three-week streaming plan
27865bc  Record where the game environment sits in the pipeline
f45fd16  Fix false "one exception" claim about envGroup keying on pos
df23d37  Say what the environment factor and the streaming plan actually do
```

`7c82401` and `f45fd16` are task-review fix commits. `df23d37` is the single fix wave
that answered the whole-branch review. The rest are task commits.

## Final test output

```
$ node extension/test/run-all.mjs

=== environment.mjs ===

151 assertions, 0 failures
ENVIRONMENT OK

=== parity.mjs ===
slots: 9 starters/week  [1, 2, 2, 4, 4, 6, 16, 17, 23]
  per-trade odds: 28 ms per trade at 2000 sims

605 assertions, 0 failures
ENGINE OK — reproduces the verified baseline exactly

=== sources.mjs ===

14 assertions, 0 failures
SOURCES OK

3 files, 0 failing
```

`extension/test/parity.mjs` has zero diff against `f9e08ca` — the engine contract
stayed green untouched, which is what the parallel-phase rules require. Three test
files is the whole suite *on this branch*; the base predates the phase 2/3/5 merges,
so `run-all.mjs` will pick up six once this lands on `main`.

## Rulings

Every decision taken on Josh's behalf, in the order it was made, with what it costs
if it turns out to be wrong. The plan-time rulings come first because the later ones
build on them.

### Made while writing the plan (commit `312e332`)

1. **Retractable roofs are treated as domes.** The feed never says whether the roof
   was shut, and teams with retractable roofs close them for bad weather far more
   often than not. *Cost if wrong:* a missed weather penalty on a genuinely open
   retractable-roof game — the safe direction; being wrong the other way would invent
   a penalty that never applied.
2. **Weather applies to both teams in an outdoor game, not just the home team.** The
   spec says to *fetch* per home stadium, which is what keeps it to one request per
   game. A visiting quarterback throws into the same wind, so the fetched row is
   written under both `proTeamId`s. *Cost if wrong:* nothing plausible — the
   alternative is a road offence priced as though it played indoors.
3. **`TQB` joins the `pass` group.** ESPN's team-quarterback entity is a quarterback
   for every purpose the Vegas coefficient cares about, and the test fixture's league
   starts one. *Cost if wrong:* without it, a TQB league gets no quarterback
   adjustment at all.
4. **Sustained wind drives the thresholds; gusts are display only.**
   `wind_speed_10m` is the stable number. *Cost if wrong:* gusts would trip the
   25 mph rule on days that play normally.
5. **The two wind rules for kickers do not compound.** `>25` replaces `>15` rather
   than multiplying with it. *Cost if wrong:* compounding would give 0.72 at 26 mph,
   which is past what the literature supports.
6. **`currentWeek` is used as an NFL week number.** `readSettings` returns ESPN's
   `currentMatchupPeriod`, which equals the NFL week in every single-week-matchup
   league. *Cost if wrong:* in a league whose current matchup spans two weeks the
   adjustment lands one week early. The alternative is deriving the mapping, which
   `CLAUDE.md` forbids.
7. **The streaming sequence is a per-week argmax.** With one add allowed per week and
   one seat to fill, the greedy optimum for a single slot *is* the best available
   player each week. *Cost if wrong:* none under the current rules for a one-seat
   slot; a shared weekly add cap or an FAAB budget would make this a real
   optimisation, and the comment says so. For a slot that starts more than one, see
   finding I1 below — the answer is narrower rather than wrong, and now says so.
8. **`ffsm.environment` is added to `panel.js`'s `KEEP` array.** Without it the toggle
   resets on every "Refresh data". *Cost if wrong:* it is a one-token edit to a line
   other wave-2 phases will also touch; the merge conflict is trivial and expected.

### Made in the pre-flight scan, before Task 1

9. **F1 — the chips insertion anchor.** The plan's Step 5 anchors on a line reading
   `</div></div>`, which is not unique in `panel.js`. Ruled: anchor instead on the
   unique line containing `>As published</button>`; the `#calib` field closes two
   lines below it. *Cost if wrong:* the chips render in the wrong filter bar. Caught
   by `node --check` only if unbalanced, otherwise by the browser checklist.
10. **F2 — `envGroup` keys on `pos` strings, which `CLAUDE.md` forbids in general.**
    Ruled: sanctioned. The spec explicitly requires it and requires a comment saying
    why; an environment factor is an input adjustment that never reaches lineup logic.
    A reviewer flagging it should be answered with the comment, not a rewrite.
    *Cost if wrong:* none — reversible by moving the switch onto `eligibleSlots`.
    (The fix wave later found a stronger justification than the one recorded here:
    `positionLabel` derives `pos` *from* `eligibleSlots`, so `envGroup` is
    transitively slot-keyed rather than a second source of truth.)
11. **F3 — `sources/stadiums.js` imports `../league.js`, which no other `sources/`
    module does.** Ruled: allowed. The wave-2 table says Phase 7 "may add
    `PRO_TEAM`-adjacent lookups in a new file instead" of editing `league.js`; import
    is read-only and `league.js` has no top-level side effects. *Cost if wrong:* a
    layering nit; the fix is a 32-line copy of the abbreviation map.

### Made during the task loop

12. **Task 2 — accept the implementer's removal of the derived fallback odds URL in
    `fetchWeekEvents`.** The plan wrote `comp.odds?.$ref ?? <derived URL>`. `cached()`
    does not cache failures, so for any event whose payload omits `odds.$ref` the
    derived URL is re-fetched and re-404s on *every* page load — which breaks the
    plan's own assertion that a second load inside the three-hour TTL is free, and
    hammers ESPN once per load per unpriced game. Skipping the fetch when there is no
    `$ref` is what the plan's own fixture describes. *Cost if wrong:* a game whose
    event payload omits `odds.$ref` while the odds resource does exist would be
    silently unpriced. Recoverable by restoring the derived URL together with negative
    caching.
13. **Task 3 — the reviewer's Important finding is accepted in part.** The reviewer
    was right that `num()` turning a missing hourly reading into `0` fabricates a
    "calm and dry" measurement. But the two failure directions differ: a missing Vegas
    total defaulting to 0 says "this offence will not score" and badly distorts, while
    a missing wind defaulting to 0 lands on identity — the safe direction. The real
    cost is honesty, not arithmetic: the roster-grid hint would report "0 mph wind,
    0% rain" for a reading that does not exist. So the fix was scoped to the field the
    thresholds key on: `atKickoff` returns `null` unless `wind_speed_10m[best]` is a
    finite number; gusts (display-only) and precipitation probability (missing → no
    penalty) keep defaulting to 0. *Cost if wrong:* a forecast that omits only
    `wind_speed_10m` but carries usable precipitation is discarded rather than partly
    used — a rare feed shape, and the loss is one 0.95 factor.
14. **Task 6 — accept the `envCell` deviation.** The plan dashes only when `byPlayer`
    has no record at all, but `applyEnvironment` creates a record inside the per-week
    loop and assigns `rec.factor` only when `w === weeks[0]`. A player whose team is
    on bye this week but has a line next week therefore ends up with `factor: 1` and
    no current-week entry, and the plan's own code would render `×1.00` with an empty
    `data-hint` — a focusable cell with a blank tooltip, and a direct contradiction of
    the plan's browser-checklist item 4. Dashing on `!rec || !wk` is what the plan asks
    for everywhere except in that one code block. *Cost if wrong:* a player with a
    next-week line but no current-week line shows `—` rather than surfacing next
    week's factor; the fix would be to render the next-week entry as a labelled
    fallback.
15. **Task 6 — accept the streaming-note rewording.** "at the cost of N roster move(s)"
    became "N switch(es) inside the window, plus the first add if that name is not
    already yours". `streamPlan` counts transitions between consecutive weeks and
    excludes the initial acquisition, so the plan's wording undercounts by one
    whenever the week-1 pick is a free agent. *Cost if wrong:* a hedged sentence where
    a precise one was possible. The precise fix is to add an `owner` field to each
    `sequence` entry in `streaming.js`.
16. **Task 7 — widen the fix past the task's brief into `extension/engine/environment.js`.**
    The reviewer found a Critical falsehood in `CLAUDE.md`: it claimed the `pos`
    strings `envGroup` reads are "the one sanctioned exception in the codebase". Three
    pre-existing sites also key on `pos` — `calibrate.js:24-33` (`shrinkProjections`
    looks up `k[pos]` for a shrinkage slope), `league.js:245-248` (`measureVolatility`
    buckets into `posSamples` for a positional-median sigma) and `search.js:247-249`
    (`setVolatility` falls back to `vol.byPos.get(pos)`). I confirmed all three. The
    identical claim sat in `environment.js`'s own `envGroup` docstring, which is the
    source the `CLAUDE.md` prose was copied from, so fixing only the copy would
    guarantee its return. Ruled: fix both. `environment.js` is a Phase 7 file, not one
    owned by another wave-2 phase, and the edit is comment-only. *Cost if wrong:* one
    comment hunk lands in a Task-4 file after that task's review closed — reversible
    with a `git revert` of that hunk, and the scoped re-review covered it.

## Final whole-branch review and the fix wave

Reviewer (opus), base `f9e08ca` → head `f45fd16`. Verdict: **Approved with
conditions** — 0 Critical, 2 Important, 9 Minor. All six cross-file invariants were
verified by reading rather than by trusting the claim: the forbidden files have zero
diff; `parity.mjs` is untouched; every URL in the branch carries only a season, a
week, a latitude/longitude or an event id, and the event and odds URLs are taken
verbatim from ESPN's own `$ref` fields rather than constructed; the shrinkage →
environment → `Engine` ordering is right; the `pos`-keying exception is correctly
scoped. The reviewer confirmed all five controller rulings stand and disagreed with
none.

**I1 (Important) — multi-seat streaming slots.** `streamPlan` admits a group on
`count > 0` but plans a single seat: `hold` is `rows[0]` and `sequence` is one
per-week argmax. In a true 2QB league, or one starting two D/ST, the recommendation
was confidently presented as covering the slot when it covered one seat of it — and
`count` was carried in the group but never rendered. No test exercised `count > 1`.

*Resolved in `df23d37`, deliberately not by solving N seats.* Dropping the group would
delete the planner from those leagues entirely, which is worse than an imprecise note.
So the fix makes the narrowness explicit instead: the `streaming.js` header now
separates "exact for a one-seat slot" from "narrower than a full N-seat plan"; the
sub-table heading gained `· N starters`; and a group with `count > 1` renders an extra
sentence saying the hold and the stream cover **one** of those N seats, not all of
them. Five new assertions cover a `{17: 2, 16: 2}` league — the group is still planned,
`count` reports 2, rows/hold/sequence still populate, the hold matches the one-seat
answer exactly, and a one-seat slot in the same league still reports 1. Solving N seats
properly is a different problem (the top N each week, and a hold that is a set rather
than a player) and nothing in the code claims to have solved it.

**I2 (Important) — the "nothing downstream sees it" claim was false.** The invariant as
worded in `CLAUDE.md`, in the plan's Global Constraints and in `environment.js`'s
header said the factor never reaches the solver, the search or the season sim. That is
backwards: the factor is baked into `p.proj[w]` *before* the `Engine` is built, so the
lineup solver, `sideMetrics`, `projectSeason`, `attachOdds` and the leverage strip all
read the adjusted number. That is the entire point of the seam.

*Resolved in `df23d37`.* Both live copies — `CLAUDE.md` and the `environment.js` header
— now state the true, weaker claim: everything downstream reads the adjusted number;
what nothing downstream carries is a *separate* environment term, and no slot decision
keys on one. The rewrite also bounds the blast radius numerically, which the old
wording only gestured at: `gain` averages every week in the model and `reg` the
regular-season weeks alone, so two moved weeks shift a season-long trade metric by at
most 2/17 of the per-week swing. The plan document was left as written — it is the
historical record of what was planned, and amending it would erase the finding rather
than record it.

**Minors closed in the same wave, beyond the two the triage required.** The review
marked T3-4 and T6-3 as fix-before-merge and T6-5 and T5-2 as one-character freebies;
the wave took seven more that were cheap and adjacent:

- The weather cache was keyed per *team*, so two clubs sharing a stadium in the same
  week fetched the identical URL twice. `loadWeather` now groups by coordinate pair and
  keys the cache on it, reading each game's own kickoff hour out of the single cached
  forecast. Four new assertions cover a MetLife week with both tenants at home on
  different days: one request, and each game gets its own hour and its own kickoff
  stamp. This also corrects the ledger's Task 3 note, which called the collision "not
  reachable under real NFL scheduling" — it is reachable, and the review said so.
- Dashed Env cells sorted as `1.00`, filing every "no game this week" row in among the
  average ones. `envColumn` now reads exactly what `envCell` reads and falls back to
  `-1`, which is below the `0.6` clamp, so dashes gather at one end.
- `e.message ?? e` printed empty parens for a message-less `Error`; now `||`.
- The dead `counts[String(slot)]` arm is gone — bracket access already coerces numeric
  keys.
- `weather.js` now imports `isOutdoor()` instead of inlining `st.roof !== "open"`,
  so there is one definition of "outdoor".
- `streamingSection`'s comment claimed the planner "must never cost the page" while the
  `try` wrapped only `streamPlan`. The body moved into a `streamingHtml` helper and the
  whole thing is now inside the `try`, making the comment true.
- `applyEnvironment` was the one unguarded call in `environmentStep`. It now has a
  `try/catch` that degrades to a warning, so "nothing escapes `start()`" holds by
  construction rather than by luck.
- `applyEnvironment`'s doc now says a `byPlayer` entry records a player-week that had a
  group and a line, *not* one that changed — so a consumer cannot read presence as
  "adjusted".
- The clamp assertions the review called genuinely circular (they compared
  `vegasFactor(...)` against `ENV_K.clamp`, so a widened clamp would pass green) now
  hard-code `1.4` / `0.6` and separately assert that `ENV_K.clamp` is that range.

Assertions went 141 → 151. `parity.mjs` and the forbidden files stayed at zero diff.
The ledger records the fix wave's dispatch but not a closing re-review, so its diff was
verified against the source directly while writing this report: all eleven items above
are present, the `environment.js` and `streaming.js` edits are comment-only apart from
the dead-arm removal, and the suite is green.

**One reservation the review raised and did not act on.** `ENV_K` puts K at 0.4, ranked
above pass at 0.25. That is probably too high: extra points and field goals move in
opposite directions with a team's total, so the sensitivity should be damped rather
than amplified relative to passing. The table is spec-binding, so it was not changed —
flagged for measurement instead. It is the single most consequential unverified number
in the phase, because a wrong coefficient distorts every trade the tool recommends.

**Test quality.** Four of the five sections would catch a regression. The one circular
pair the review named has been fixed.

## Parked and deferred findings

Nothing was parked at a tripped fix-loop breaker: every task's review closed clean or
after one fix round. The items below are Minor findings that were deliberately left,
recorded so they can be picked up cheaply. Everything the fix wave closed has been
removed from this list.

**`vegas.js`**
- The unconditional `try/catch` per event (111-122) and per week (141-143) would
  swallow a genuine programming bug as "dropped game" / "empty week", not only a
  network failure.
- No test for an individual event page 404 while the week's schedule list succeeds
  (structurally identical to the tested dead-feed path).

**`weather.js`**
- The nearest-hour tie-break (strict `<`, so the earlier sample wins) is neither
  documented nor tested.
- `HOURS3` and `MAX_OFFSET` are numerically identical but conceptually unrelated
  (cache TTL versus kickoff-proximity cutoff).
- Concurrency ≤ 4 is still never exercised: the shared-stadium fixture is one site, so
  the batching loop runs a single chunk. The loop is structurally identical to the
  reviewed `vegas.js` one.
- `Number(wind)` is computed twice — once for the finiteness gate, once inside `num()`.

**`environment.js`**
- Several `vegasFactor` assertions restate the production formula (`1 + k*edge`)
  rather than an independently derived number. They catch wiring bugs; they are weak
  evidence for the shape itself.
- No test exercises an unresolvable `nfl` abbreviation (the `PRO_TEAM_ID[p.nfl]`
  guard).
- Some "untouched" assertions would also pass under a total no-op; the surrounding
  positive assertions are what rescue them.

**`streaming.js`**
- `bye: eng.bye[i] || 0` is redundant — `search.js` already coerces `p.bye ?? 0`.
- `rows` is truncated to `limit` (12) *after* `hold` and `sequence` are computed, so a
  `sequence` entry can name a player absent from `rows`. Untested (the fixture pool is
  four players). The UI was built to tolerate it.
- `adds` excludes the initial acquisition, so it undercounts real waiver moves by one
  when the week-1 pick is a free agent. See ruling 15; the fix is an `owner` field on
  each `sequence` entry.
- A slot that starts more than one seat is planned for one seat. Now labelled and
  tested for `count`, but the N-seat problem itself is open. See I1.

**`panel/environment.js`**
- The streaming grid's `empty:` string "Nobody eligible" is unreachable — `streamPlan`
  skips a slot with no rows before pushing a group.
- `esc0` duplicates `panel.js`'s `esc` byte for byte. Deliberate and explained
  (importing from `panel.js` would re-run the page), but the twins can drift silently.
- `.substl:first-of-type` assumes no other `h3` is ever added above the sub-tables.

**Performance, needs browser timing**
- `environmentStep` runs on the critical path before the `Engine` is built and makes
  up to roughly 33 requests per week × 2 weeks at concurrency 4 on a cold cache. The
  escape hatch is to narrow to `[w0]` and fetch next week lazily.

**Documentation**
- The architecture map places `streaming.js` beside `environment.js`, though
  `streaming.js` runs *after* the `Engine` is built and `environment.js` runs before
  it. The map is topical rather than chronological elsewhere too (`search.js` already
  precedes `calibrate.js`), so this is consistent, but a reader could misread it.
- The `sources/` list is not alphabetical.
- The `Commands` section's `~5s` / `~2s` timings read high against a measured
  ~2.9s / ~2.7s. Pre-existing text.

## Browser verification — pending

Chrome was not available to any agent in this phase. **Nothing below has been
performed or observed.** Every item is a claim to be tested, not a result.

1. **The CORS question the whole phase rests on.** Confirm
   `sports.core.api.espn.com` actually sends a permissive `Access-Control-Allow-Origin`
   to a `chrome-extension://` origin. `manifest.json` is deliberately untouched, so
   there is no host permission to fall back on — if this fails, every Vegas call fails
   and the feature degrades to the dead-feed path. Check this first; the rest of the
   list assumes it passes.
2. Reload the unpacked extension and open a live league. The checklist shows
   **Game environment** between "Free-agent pool" and "Schedule", and it completes.
3. The log shows `Vegas: N games priced for week W (avg total T)` with a plausible T
   (NFL game totals run 35–55), then
   `weather: K open-roof games, worst wind X mph`, then
   `environment applied to N player-weeks across weeks W and W+1`.
4. The roster table has an **Env** column showing values like `×1.06`; hovering one
   names the implied total and either the wind or "no weather applied".
5. A player whose team is on bye this week shows `—` in Env. (This is specifically
   what ruling 14 exists to satisfy.) Sorting by Env gathers those dashed rows at the
   bottom rather than mixing them in with the ×1.00 rows — that is the `-1` fallback
   the fix wave added.
6. The **Streaming planner** section appears below "Your least-used players" with one
   sub-table per streamable slot the league starts. Each heading reads
   `<slot> · 1 starter`. One row per table carries the `hold` tag, and the note under
   each table reads as a sentence. In a league that starts two of a streamable slot,
   the heading reads `· 2 starters` and the note carries the extra "covers one of
   those 2 seats" sentence.
7. The season panel's filter bar shows **Environment / Vegas + weather / Off** beside
   **Projections**. Clicking **Off** reloads and the log then reads
   `game environment off - projections used as they arrived`; the Env column shows `—`
   throughout, and the toggle still reads Off after **Refresh data**.
8. Disconnect the network after the league loads (DevTools → Network → Offline) and
   reload: the log shows one `Vegas lines unavailable (…)` line, the step shows a
   warning, the Env column is all `—`, and the trade tables are otherwise unchanged.

Two things worth timing while you are in there: how long the **Game environment** step
adds to a cold load (see the performance note above), and whether any Env factor looks
implausible against the actual line for that game — `ENV_K`'s coefficients are the
substance of the feature, and the K-versus-pass reservation above is the specific one
to look at.

## Merging

The branch is self-contained and green, and touches no file another wave-2 phase owns.
Two conflicts are expected and were accepted at plan time:

- **`CLAUDE.md`'s architecture map.** This branch's base predates the phase 2/3/5
  merges, so its map is the thinner pre-wave version. Phase 7 only added lines to it
  (+36/−2) and deleted nothing, but the map region will conflict with `main`'s richer
  one. Resolve by keeping `main`'s entries and adding Phase 7's four:
  `panel/environment.js`, `engine/environment.js`, `engine/streaming.js` and
  `test/environment.mjs` (151 assertions), plus the two new load-bearing-decision
  paragraphs and the `sources/` line gaining `vegas`, `weather` and `stadiums`.
- **`panel.js`'s `KEEP` array.** Ruling 8 adds `ffsm.environment` and rewraps the line
  to two. Other wave-2 branches touch the same line; the union of the added keys is the
  resolution.

After the merge `run-all.mjs` should report six files, not three.

## Deferred from the phase, by design

**C4, the playoff-week defence-versus-position tiebreak, was not built.** It needs
nflverse release assets, which are not CORS-open and would require either a host
permission for a redirecting CDN or a copy of the data in the repo. The measured
effect is also small next to the implied total, which the environment factor already
carries. `CLAUDE.md` records the deferral. Revisit only with a CORS-open source.
