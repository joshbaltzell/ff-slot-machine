# FF Slot Machine

Finds ESPN fantasy trades that raise **both** teams' projected starting-lineup
points, reading your league live from the browser.

## Install (30 seconds, no store account needed)

1. Clone or download this repo
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the `extension/` folder
5. Sign in at [fantasy.espn.com](https://fantasy.espn.com), open your league, and
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

## Using it

Every grid sorts — click a column heading, click again to reverse. Hover any heading
to see what it measures, which matters more than it sounds: "gain" is not points
scored, it is how much your *best possible lineup* improves.

Filter trades by team, shape (1-for-1, 2-for-2, three-team), minimum gain, or player
name. **Bye-driven** finds offers that are near-worthless to your partner at full
strength but valuable once byes thin them out. **Even splits** hides the lopsided
ones nobody accepts.

Click any trade for the detail: a panel per side with the gain broken into regular
season, playoffs and bye weeks, who starts more, who gets benched, a per-week bar
chart, and a **Copy pitch** button that puts a plain-language case on your clipboard,
written from your partner's side.

The pitch shows **both directions**: what your partner gains, and what they give up.
A trade cannot be judged from the incoming players alone.

## The daily reminder

Once installed, a small notice can appear on your ESPN league page — "3 trade
options for you", "Rosters have changed", "Your analysis is out of date". Click
**Open** to run the analysis, or dismiss it and it stays quiet for a day.

The bar for showing it is deliberately high: at most once per league per day, and
only when rosters have actually changed, the last run has gone stale, or there are
offers you have not looked at today. The toolbar icon carries a small badge as the
persistent cue, so the on-page notice never has to nag.

It does **not** run the trade search in the background. Manifest V3 stops a service
worker after five minutes and a full league pull is eighteen API calls before any
searching begins, so a background search would be unreliable at best and dishonest
at worst. The daily job makes a single request for the current week's rosters and
compares them to the rosters the last analysis was built on — which answers the only
question worth interrupting you about: has anything actually changed?

## Privacy

Everything runs locally. The only network calls are to ESPN's own read API using the
session your browser already holds. No backend, no analytics, no league data leaves
your machine. Fetched data is cached in `chrome.storage.local` for 12 hours; the
Refresh button clears it.

## Correctness

```bash
node extension/test/parity.mjs
```

371 assertions over a frozen ten-team league: every team's weekly lineup total, the
full set of 49 one-for-one trades, 92 three-way cycles, and the season simulation's
invariants (wins sum to games over two; playoff, bye and title probabilities sum to
their bracket's seat counts).

Those baselines were produced by an independent Python implementation of the same
rules and verified against it line for line before that implementation was retired.
They are now the contract: a mismatch means the engine changed. Because the second
implementation is gone the numbers can no longer be re-derived independently, so
regenerate the fixtures only after deciding deliberately that new behaviour is
correct.
