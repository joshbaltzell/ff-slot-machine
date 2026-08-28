# Phase 3 — Market: FantasyCalc fairness and the arbitrage list — build report

**Branch:** `phase3-market`
**Worktree:** `.claude/worktrees/agent-a959f72bc82ba521a`
**Base:** `33ab692` (merge-base with `main`)
**Head:** `56349eb` — the last code commit; this report is the commit after it.
**Plan:** `docs/superpowers/plans/2026-08-27-market.md`
**Spec:** `docs/superpowers/specs/2026-08-27-market-design.md`
**Rules:** `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`

Not merged, not pushed. Six tasks, each built by a fresh implementer and gated by its
own reviewer; one whole-branch review on Opus; one fix wave; one scoped re-review.

## What shipped

FantasyCalc's crowd-derived trade values, as a second opinion beside the engine's own
lineup-value model. Our trades are scored by exact starting-lineup points; the humans on
the other side judge by trade-value charts. The market column tells you whether a
suggestion is one a partner will accept, and the *gap* between the two rankings is the
buy low / sell high list.

| File | What it is | Lines |
|---|---|---|
| `extension/engine/sources/fantasycalc.js` | URL/parameter construction, the cached fetch, the trim to seven fields. Knows nothing about the engine. | 96 |
| `extension/engine/market.js` | Pure math over a value map: `indexMarket`, `sideMarket`, `tradeFairness`, `pitchMarketLine`, `arbitrage`. No DOM, no fetch. | 181 |
| `extension/panel/market.js` | Every string of market HTML, the hints, and the two functions that swallow a dead feed. | 234 |
| `extension/panel.js` | Eleven wiring hunks plus the fix wave's two edits inside them. | +28 |
| `extension/test/market.mjs` | 141 offline assertions (fetch, storage and clock injected). | 510 |
| `CLAUDE.md` | Architecture map plus two load-bearing notes. | +18/−1 |

In the UI: a **Market** column after Balance, a **Market-fair** filter chip, a
`market: sends X · receives Y` line per side in the trade detail, a FantasyCalc sentence
appended to the copied pitch, and a **Buy low / sell high** section below free agents.

## Commits

| SHA | Subject |
|---|---|
| `86076ec` | Add the Phase 3 market implementation plan |
| `726c1c9` | Add the FantasyCalc feed |
| `546bd24` | Score trades the way the other manager will |
| `c6fd4a2` | Fix the arbitrage test fixture in the plan |
| `ba06580` | List the players the market and the projection disagree on |
| `cef0f66` | Give the market its own panel module |
| `c01470c` | Cover the arbitrage row's HTML escaping with a direct test |
| `b39223e` | Show the market's opinion beside our own |
| `812cfdd` | Record that market values never enter the search |
| `56349eb` | Bound the feed's patience and stop a dead feed from hiding trades |
| _(this file)_ | Record how Phase 3 was built and what was decided |

## Final test output

```
$ node extension/test/run-all.mjs
=== market.mjs ===

141 assertions, 0 failures
MARKET OK

=== parity.mjs ===
slots: 9 starters/week  [1, 2, 2, 4, 4, 6, 16, 17, 23]
  per-trade odds: 27 ms per trade at 2000 sims

605 assertions, 0 failures
ENGINE OK — reproduces the verified baseline exactly

=== sources.mjs ===

14 assertions, 0 failures
SOURCES OK

3 files, 0 failing

$ node --check extension/panel.js
(no output)
```

`extension/test/parity.mjs` is byte-identical to its state at `33ab692` — confirmed with
`git diff --stat 33ab692..HEAD -- extension/test/parity.mjs` (empty). `search.js`,
`season.js`, `manifest.json`, `league.js` and `sources/cache.js` are likewise untouched:
rule 6 and the parallel-merge surface are intact.

## Rulings

Ten decisions were taken without asking. Each is listed with what it costs if it turns
out wrong, in the order it was made.

**1. The branch was cut from `33ab692`, not the worktree's stale `3c15bf5` HEAD.**
Why: the task named `33ab692`, and it is the only commit carrying the specs,
`engine/sources/`, `run-all.mjs` and `readSettings.pprValue` that this phase builds on.
*Cost if wrong:* the branch is based on the wrong commit and merges badly — mitigated by
verifying `33ab692` contains every input file the task listed.

**2. Task 6's `CLAUDE.md` anchors were rewritten before dispatch to match the file as it
actually stood.** The plan's first draft assumed the pre-Phase-1 map (no `sources/` line,
"371 assertions"), but Phase 1 had already added `sources/` and corrected the count to
605, so the original anchors would not have matched.
*Cost if wrong:* none — the replacement anchors were grepped against the working file.

**3. `loadMarket` returns `{byEspn, params, at, fromCache, stale}` rather than the bare
`Map` the spec's prose names.** It matches `loadSleeperPlayers`' established shape in the
same directory, and the log line the spec mandates ("N players priced (1QB, 12 teams, 0.5
PPR)") needs the snapped parameters, which a bare Map cannot carry. The final reviewer
independently agreed, noting that a bare Map would have forced a second `marketParams()`
call at the call site — deriving the same thing twice, which rule 5 exists to prevent.
*Cost if wrong:* one extra `.byEspn` at each of three call sites.

**4. `arbitrage`'s `edge` subtracts `poolRank` — the player's rank by FantasyCalc value
within this league's own candidate pool at his position — rather than the published
`positionRank` the spec's formula names.** The two ranks otherwise span different
populations (all of fantasy football vs the ~200 players in this league), so every player
carries a large positive offset and the list sorts by position depth instead of by
disagreement. `marketRank` still carries and displays FantasyCalc's published number;
only the arithmetic changes. The final reviewer re-derived this rather than accepting the
argument, and confirmed that because `positionRank` is monotone in `value`, `poolRank` is
the *dense restriction of `positionRank` to this league's pool* — the same quantity over a
common population, which is what the spec's prose asks for.
*Cost if wrong:* the buy/sell ordering differs from a literal reading of the spec; the
displayed columns are identical either way.

**5. The plan's verbatim `trimValues` guard `if (!Number.isFinite(espnId) || espnId <= 0)
continue;` is a defect in the plan, and dropping the `<= 0` clause was accepted.** The
guard drops fixture player id 0, which the brief's own assertions require to survive. The
join is by exact map key, so an id of 0 — or a negative id ESPN never issues — simply
never matches a player. The plan's text loses to the spec, which says only that players
absent from the response have no market value.
*Cost if wrong:* a FantasyCalc row with a zero or negative `espnId` is stored in the map
and never matched. No behavioural effect.

**6. `pitchMarketLine` special-cases a side whose own `sent` is 0 rather than weakening
the assertion.** The plan derived the fair/lopsided verdict from the trade-level
`fairness` alone, so its own "freebie" case rendered "lopsided by the market" while its
expected string said "a fair deal". A side with nothing priced on the scale cannot be
short-changed — there is no ratio and no percentage to state. The other side of the same
trade still correctly reads "lopsided by the market (−100%)".
*Cost if wrong:* a pitch sentence understates how favourable a zero-cost package is for
the partner receiving it. Cosmetic, and only when a whole outgoing package prices at zero.

**7. Task 3's fixture arithmetic was corrected in the plan before dispatch (`c6fd4a2`).**
The test said it priced four RBs "in EXACTLY the reverse of the model's order" but the
assignment handed the best-projected RB the highest value and the best market rank — the
same order. Every edge would have been 0 and three assertions could not hold. Fixing it
before dispatch was cheaper than a guaranteed fix round, and the fixture's own comment
already said "reverse".
*Cost if wrong:* the arbitrage test asserts something other than intended. Re-derived by
hand and again by two reviewers: k=0 → value 100, marketRank 14, poolRank 4, modelRank 1,
edge +3; k=3 → edge −3. Matches every assertion.

**8. PARKED — `remainingOf` reads `settings.currentWeek`, which `league.js` sets from
`currentMatchupPeriod`, a matchup period rather than a scoring week.** The correct fix
needs `matchupPeriods` exposed through `readSettings`, and it is not (it is consumed
inside `readSettings` at `league.js:145` and never returned). That means editing
`extension/engine/league.js`, a file both sibling phases are likely to touch, for a defect
the reviewer itself rated bounded and in the safe direction — the window only widens, only
in leagues with multi-week matchup periods, and only late in the season. Rule 5 forbids
the alternative of a second derivation site.
*Cost if wrong:* in a league with a two-week final, late-season ppg averages fold in one
or two already-played weeks, nudging the buy/sell ordering. Every displayed rank and value
stays correct. **Worth a follow-up commit on `main` once the three phases merge.**

**9. PARKED — `arbitrage` groups by the model's position label but ranks within the group
by FantasyCalc's `positionRank`, so a player whose taxonomy differs across the two sources
gets a meaningless `poolRank`.** The reviewer's suggested guard (skip rows whose two labels
disagree) would silently drop every DST player, because DST/DEF is precisely the known
mismatch this code was earlier credited for surviving. Trading a rare wrong row for a
reliably absent position group is a worse failure; the right fix is a label-normalisation
map that deserves its own design pass.
*Cost if wrong:* a player whose ESPN and FantasyCalc position labels disagree can appear in
buy or sell with a `poolRank` computed against the wrong group. Rare, and the row's name,
ppg and `marketRank` are all still correct.

**10. PARKED — no `referrerPolicy` on the FantasyCalc request.** The fix belongs in
`engine/sources/cache.js`, a shared file this phase does not own, and the reviewer
confirmed the privacy commitment holds without it: the default sends only the extension's
own origin, which is not league data.
*Cost if wrong:* none to privacy as committed.

## Review record

Every task passed its own review. Task 4 took one fix round; every other task was clean
first time.

The one Important finding inside the task loop was on Task 4: `arbRow` was the only
HTML-escaping code in the file and no test reached it, because the injected fake grid
recorded its arguments and never called `o.row(...)`. The gap was plan-mandated — my brief
had the omission and the implementer transcribed it faithfully — but "the plan told me to"
is not a reason to ship an untested escape path, so it went to the fix loop rather than
being ruled away. `c01470c` covers it, and the re-reviewer traced each of the three
`esc()` sites and confirmed at least one assertion genuinely fails if any is removed.

The whole-branch review (Opus, base `33ab692`) returned **"Ready to merge: with fixes"** —
no Critical, two Important, fifteen Minors. It agreed with all seven rulings that existed
at that point, and found none of the nine deferred minors merge-blocking. Its two
Importants were both cases where the phase's own stated degradation contract did not hold:

- **`marketOrNull` had no timeout and sat on the critical path.** `cached()` passes no
  `AbortSignal` and `fetch` has no default timeout, so a host that accepts the connection
  and then stalls held `start()` at "Market values" until the socket timed out — a minute
  or more — before any trade search began. The plan's constraint names this case verbatim
  ("down, *slow*, rate-limited or returning nonsense"); slow was the one branch not
  handled. Newly introduced, not inherited: FantasyCalc is the first non-ESPN feed
  `panel.js` actually calls.
- **The Market-fair chip emptied the trade grid when the feed was dead.** `marketFair`
  returned `null` for every trade, `?? 0` made it 0, and every row was filtered out —
  leaving a generic empty state naming three causes that were all wrong, beside a column
  of dashes. It contradicted the load-bearing note this same branch added to `CLAUDE.md`.

`56349eb` fixed both, plus nine cheap Minors. The scoped re-review verdicted every finding
ADDRESSED with no new breakage, and specifically confirmed the two things easiest to fake:
`clearTimeout` runs on both the success path and the catch, so a fast load leaves no
dangling timer; and the timeout test injects a fetch that never settles, which the
re-reviewer verified would hang forever without the fix rather than merely be slow.

## Deferred minors

None blocks merge. Listed so they are not lost.

| Where | What |
|---|---|
| `fantasycalc.js` | `\|\|` rather than `??` for `overallRank` and `trend30Day`, so a legitimate 0 coerces. Inert — a rank is never 0 and 0 is already the trend default. |
| `market.js` | Buy/sell final sorts use asymmetric secondary tie-breaks (buy on ppg, sell on value). Harmless; worth a comment. |
| `market.mjs` | An assertion message hardcodes "of 160", which goes stale if the fixture roster size changes. Message text only. |
| `panel/market.js` | `marketCell`'s dash branch carries `class="num"` where the priced branch does not. Cosmetic; both are exactly one `<td>`, and the asymmetry mirrors the existing Balance column. |
| `panel/market.js` | `Promise.race` never attaches a handler to the losing promise, so a real fetch that rejects *after* the timeout fires becomes an unhandled rejection — a console warning in the extension page, not a crash. Inherent to the bare race pattern. |
| `panel.js` | The `mktfair` filter predicate has no test, because `panel.js` is not importable under node. Verified by inspection by the re-reviewer. |
| `panel.js` | Buy/sell always follows `myTeam` while the rest of the page follows the "who" selector. Deliberate — "sell high" means *your* roster — and now recorded in `arbitrageSection`'s doc comment. |
| process | Three of six task briefs contained reference code that could not satisfy its own assertions. A plan should have its fixture arithmetic executed before it is committed. |

## Browser verification — pending, nothing here is claimed to work

There is no browser in this environment, so the wiring has never been exercised. **This is
the single biggest residual risk of the phase.** The engine and panel modules carry 141
assertions; the eleven-plus-two call sites in `panel.js` carry none and cannot, since
`panel.js` is a DOM module with no test harness. Load the unpacked extension and walk this
list before trusting the feature.

- [ ] The loading checklist shows **Market values** between "Player volatility" and "1-for-1 trades", and it finishes rather than hanging.
- [ ] The log shows `FantasyCalc: N players priced (1QB, 10 teams, 0.5 PPR)` with the league's real shape.
- [ ] The trade grid has a **Market** column after Balance, showing a bar and a percentage; hovering the heading shows the hint.
- [ ] Clicking the Market heading sorts by it, and rows showing `—` sort to the bottom.
- [ ] The **Market-fair** chip appears in the "Only" group and filters the list when clicked.
- [ ] Expanding a trade shows `market: sends X · receives Y` under each side's point numbers, with the *delta* carrying the colour.
- [ ] "Copy pitch" produces text ending in the FantasyCalc sentence.
- [ ] The **Buy low / sell high** section appears below "Free agents worth adding", both tables populate, and their column headings sort.
- [ ] With the network blocked (DevTools offline, or a bad host in the URL), the page still finishes loading, the step shows "unavailable", every Market cell is `—`, the arbitrage section shows its empty state, **the Market-fair chip is absent**, and the trade list is *not* empty.
- [ ] With a throttled/stalled connection, the Market step gives up after about 8 seconds and the search still runs.
- [ ] The detail row still spans the full table (`colspan` tracks the 17 columns) with the Market column present.
- [ ] Nothing in the DevTools Network tab goes to FantasyCalc carrying a league id, team name or player list — only `?isDynasty=false&numQbs=…&numTeams=…&ppr=…`.

## Merge notes

The branch touches no file a sibling phase owns. `panel.js` is the only shared file, and
its diff is eleven hunks, 28 insertions and zero deletions, so a three-way merge against
Phase 2's and Phase 5's `panel.js` edits should be mechanical unless they insert at the
same anchors. `CLAUDE.md` gains three tree lines and two paragraphs; if a parallel phase
has already changed the same block, add to it rather than reverting.
