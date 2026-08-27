# Chrome extension: live trade finder inside ESPN

**Date:** 2026-08-26
**Status:** Draft for review
**Supersedes:** the delivery vehicle in `2026-08-26-trade-strategies-design.md`.
That spec's *feature designs* still stand — this changes where they run, not what
they do.

## Why

The tool's remaining friction is all about being outside the browser: copying
`SWID`/`espn_s2` cookies that expire, re-pulling a spreadsheet by hand, and reading
results in a file rather than next to the league. Code running on `fantasy.espn.com`
has the session already.

A spike confirmed both unknowns before this was written:

| Question | Result |
|---|---|
| Is JS fast enough for the search? | 2-for-2 exhaustive in **13.7 s vs Python's 52 s** — 3.8× faster, from an unoptimised port |
| Does the ported solver agree with Python? | **998 mutual hits vs 998** — identical |
| Does an in-page authenticated fetch work? | **Confirmed** — returns league name, slot counts, playoff settings |

The port is also cheaper than it looks. `ffti/template.html` is already ~900 lines of
dependency-free vanilla JS, so the UI moves nearly as-is, and `data.py` disappears
entirely: reading the API directly removes the spreadsheet, `openpyxl`, and the
bye-week inference built on top of it.

## The decision this locks in

Phases 2–6 of the feature spec are ~800 more lines. Writing them in Python and
porting later does the work twice. From here, **new features are written once, in
JS.** The Python engine is not deleted — it becomes the test oracle.

## Architecture

```
extension/
  manifest.json      MV3, host_permissions for the ESPN API
  background.js      opens the side panel; nothing else lives here
  panel.html         the UI, ported from ffti/template.html
  panel.js           render + filter + sort (existing code)
  worker.js          Web Worker: search runs off the UI thread
  engine/
    league.js        API -> normalized model (replaces data.py)
    lineup.js        optimal lineup solver
    swaps.js         precomputed (out, in) value tables
    search.js        shapes, N-sided trades, three-way
    wins.js          expected wins, title odds
  test/
    parity.mjs       asserts JS output matches the Python golden fixtures
```

**Fetching happens in the side panel, not the service worker.** MV3 service workers
are terminated after roughly 30 seconds idle, and pulling 18 weeks takes longer than
that. Extension *pages* carry the same host permissions — they bypass CORS and send
cookies — without the termination risk. `background.js` therefore does one job: open
the panel when the toolbar icon is clicked.

**Computation happens in a Web Worker.** A 3.8×-faster-than-Python search is still
seconds long, and blocking the panel thread would freeze the UI mid-render.

### Data layer (`engine/league.js`)

Replaces `data.py`. Four views, all now reachable:

| View | Gives us | Retires |
|---|---|---|
| `mRoster` + `mTeam` (per week) | rosters, weekly `appliedTotal` projections | the xlsx |
| `mSettings` | real lineup slots, roster limits, playoff format | three assumptions |
| `mSchedule` | actual matchups | the all-play win proxy |
| `kona_player_info` (filtered) | the free-agent pool | the Phase 5/6 blocker |

That table is the strongest argument for this port: **every open assumption in the
current tool is answerable from data the extension can already reach.** No more
guessing σ's context, playoff format, or whether position limits are enforced.

**League-agnostic by construction.** `leagueId` and `seasonId` are parsed from the
active tab URL (`fantasy.espn.com/football/*?leagueId=…&seasonId=…`); the viewer's
own team is identified by matching their SWID against the league's members. Nothing
about league 153385 or "Perrysburg Spreadsheets" is hardcoded, so a leaguemate can
install it and see their own side of every deal. That is also the point: a trade
needs a counterparty, and the pitch panel is far more useful when the person being
pitched can read it.

**Caching.** Eighteen weekly calls take 10–20 s. Results cache in
`chrome.storage.local` keyed by `(leagueId, season, week)` with a fetch timestamp;
a refresh is manual or triggered when the cache is over a day old. Without this the
panel feels broken on every open.

### Engine port

Straight translation of `ffti/lineup.py`, `swaps.py`, `search.py`, `wins.py` — same
algorithms, same guarantees, typed arrays instead of numpy. The greedy slot rule
stays valid for the same reason (nested eligibility sets), and the `_validate` guard
against partially-overlapping flex groups must port with it.

Two things must not be lost in translation:

- **No approximation in the search.** Three-way stays exhaustive via swap tables.
  The marginal-value heuristic remains rejected — measured at 57% recall.
- **Time windows stay separate.** `gain` / `reg` / `playoff` / `bye` / `full` are
  distinct because they disagree; a trade can be positive on the season average while
  hurting the record that decides seeding.

## Correctness: Python as the oracle

The Python engine and its 16 tests stay in the repo. `test/parity.mjs` loads the same
fixtures and asserts the JS produces identical output — the 998-vs-998 match in the
spike is this mechanism working already.

| Fixture | Assertion |
|---|---|
| `tests/golden_1for1.json` | JS 1-for-1 search reproduces it exactly |
| Roster snapshots | JS `weeklyPoints` matches Python `weekly_points` per team per week |
| Starter counts | exactly 9 every week |
| Swap table sample | JS table equals JS direct solve, and equals the Python table |

This turns two implementations from a maintenance hazard into a real correctness
asset. It is also the only reason a rewrite of numeric code is safe to attempt.

**The Python CLI keeps working but stops receiving features.** It is the reference,
not a second product.

## Build order

| # | Phase | Deliverable |
|---|---|---|
| E1 | Manifest, panel skeleton, `league.js`, caching | Panel lists live rosters and standings. The xlsx is gone. |
| E2 | Engine port + `parity.mjs` | 1-for-1, 2-for-2 and three-way in-browser, proven equal to Python |
| E3 | UI port from `template.html` | Full current feature set, live, in the side panel |
| E4 | `mSettings` + `mSchedule` wiring | Real lineup rules, real playoff format, true projected wins |

Then the feature backlog from the other spec, written once in JS: sell-high/buy-low,
objective toggle with title odds, correlation flags, replacement level and free-agent
upgrades, 2-for-1 consolidation.

E1–E3 are a port with a provable finish line. E4 is where the extension starts being
strictly better than the Python tool rather than merely equal to it.

## Risks

1. **Rewrite of working numeric code.** Mitigated by the parity harness, and only
   attempted because that harness exists. If parity cannot be reached on a phase,
   stop and fix rather than accepting "close enough" — the whole value of this tool
   is that its numbers are trustworthy.
2. **Eighteen sequential API calls.** Cap concurrency at 3–4 with retry and backoff;
   this is a logged-in user reading their own league, not a scraper, and it should
   stay that way.
3. **Chrome Web Store review** scrutinises broad `host_permissions`. Loading unpacked
   needs no review at all, so personal use is unblocked regardless; the store is only
   needed to hand it to leaguemates.
4. **Manifest V3 churn.** Keep MV3-specific code confined to `manifest.json` and
   `background.js` so the engine stays portable.
5. **Firefox and Safari.** Chrome first. Firefox's MV3 differs modestly; Safari needs
   an Xcode wrapper and is out of scope.

## Out of scope

Submitting to the Web Store (until asked); Safari; writing to ESPN (proposing trades
through the site); any league-management feature; a hosted backend — everything runs
locally in the browser, and no league data leaves the machine.

## Open questions

1. **Season rollover.** `seasonId` comes from the URL, but a league viewed
   out-of-season may return sparse projections. Detect and message rather than
   render zeros.
2. **Roster position limits.** `mSettings` will finally answer whether the uniform
   2/4/4/2/2/2 is enforced. If it is, `enforce_position_limits` flips on and a
   number of currently-suggested trades become illegal.
