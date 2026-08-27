# Fantasy Trade Finder — Chrome extension

Finds ESPN fantasy trades that raise **both** teams' projected starting-lineup
points, reading your league live from the browser.

## Install (30 seconds, no store account needed)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder
4. Sign in at [fantasy.espn.com](https://fantasy.espn.com), open your league, and
   click the extension's toolbar icon

No cookie copying. Code running in your browser already has your ESPN session.

## Works with any league

Nothing about a particular league is hardcoded. Slot layout, roster size, team
count, regular-season length and playoff format are all read from the league's own
settings, and players are matched to slots through ESPN's `eligibleSlots` rather
than a position taxonomy. That means superflex, two-QB, TQB, IDP, `RB/WR` and
`WR/TE` slots, and two-week playoff rounds all work with no special handling.

The lineup solver is exact for every one of those. It treats the seating problem as
a transversal matroid, where greedy by descending value is provably optimal — the
older "fill dedicated slots, then flex" shortcut is wrong about 8% of the time when
`RB/WR` and `WR/TE` both exist.

## Privacy

Everything runs locally. The only network calls are to ESPN's own read API using the
session your browser already holds. No backend, no analytics, no league data leaves
your machine. Fetched data is cached in `chrome.storage.local` for 12 hours; the
Refresh button clears it.

## Correctness

The Python engine in the repo root is the test oracle. `test/parity.mjs` asserts the
JS reproduces it exactly:

```bash
node extension/test/parity.mjs     # 360 lineup assertions + full search parity
python3 -m pytest -q               # the oracle itself
```

Current state: 0 mismatches on lineups, and the JS finds the same 49 one-for-one and
92 three-way trades as Python, with identical gains to six decimal places.
