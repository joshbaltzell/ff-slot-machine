# Browser checklist — ESPN and CBS

Everything in Phase 11 that a test can prove offline is proved offline: `node
extension/test/run-all.mjs` is 11 files, 0 failing, and the nine pre-existing files'
output is byte-identical to where the phase started. What no test can reach is the
browser. Nothing offline can load an unpacked MV3 extension, click a toolbar icon,
send a real `chrome.tabs` message across the extension boundary, or ask CBS whether it
answers a bare `Authorization` header. This document is that half.

**Run the ESPN section first, and run it in full.** Phases 1–8 were built in parallel
worktrees and merged without ever being loaded in Chrome — `STATE.md` has said so since
the milestone opened. The CBS work is the newer risk, but the older, larger, unverified
surface is ESPN's, and a CBS run that goes wrong is impossible to attribute until the
ESPN run has gone right.

**Setup, once.**

1. `chrome://extensions` → Developer mode on → **Load unpacked** → the `extension/`
   directory. There is no build step.
2. After any change to `manifest.json`, `background.js` or `content.js`, press
   **Reload** on the extension card. A stale service worker is the single most common
   cause of a step below "not working" when the code is fine.
3. Open the panel's own DevTools for the log: right-click inside the panel → Inspect.
   The panel writes its progress to the page, not to the console, but the console is
   where the storage step below runs and where a thrown error would surface.

A step whose expected outcome does not appear is a **phase gap, not a checklist typo**.
Write down what you saw instead; do not tick the box.

## ESPN

1. Open any ESPN fantasy football league page (`fantasy.espn.com/football/...`) while
   signed in.
   *Expect:* within a second or two, a small pill in the corner of the page naming the
   platform — "ESPN reprojects every week" — with a dismiss control. If you have seen
   it today for this league already, it will not reappear; that is correct.
2. Click the extension's toolbar icon from that page.
   *Expect:* the panel opens in a new tab, and its boot line reads **Reading your
   league from ESPN**. Not "Reading your league" alone, and not "from CBS".
3. Watch the log as it loads.
   *Expect:* a line naming the platform, the league id and the season
   (`ESPN league 12345, season 2026`); a slots line; a `baseline built for N teams`
   line; a `your team: …` line naming how it was identified; and a **volatility
   measured on N players: …** line with per-position numbers. The volatility line must
   *not* say "keeps no prior-season projections" — that is the CBS fallback and ESPN
   publishes prior-season projections.
4. Let the trade search finish.
   *Expect:* a trade table with rows, a Market column carrying percentages (dashes only
   where FantasyCalc has no price), and the step strip along the top all green or
   amber, never red.
5. Press the panel's refresh control and let it run again.
   *Expect:* the Calibration section still shows its rows. Refresh clears
   `ffsm.league.*` by design but must keep `ffsm.calib.*` — a refresh that empties the
   calibration log has broken the one league-specific model this extension has.
6. Return to the league page and reload it.
   *Expect:* the pill does **not** reappear (once per league per day, and a dismissal
   holds for 24 hours). An extension that announces itself every visit gets
   uninstalled.
7. Note anything that looks wrong in a section built in phases 1–8 — availability
   badges, the environment chips, the streaming plan, floors and ceilings, the
   This-week lineup. This is the first time any of it has run in a browser.

## CBS

1. Sign in to CBS and open your league's home page
   (`https://<slug>.football.cbssports.com/`).
   *Expect:* the same pill, reading "CBS reprojects every week". If no pill appears,
   check the extension card for a content-script error before going on — the CBS block
   matches `https://*.football.cbssports.com/*` and nothing on `www.cbssports.com`.
2. Click the toolbar icon from that page.
   *Expect:* the panel opens and its boot line reads **Reading your league from CBS**,
   with the league's slug as the id.
3. Watch the notes the adapter writes.
   *Expect:* one or more `CBS: …` lines, including **`CBS: id crosswalk maps N of M
   rostered players to canonical ids; M−N unmapped will show dashes from Sleeper,
   FantasyPros and FantasyCalc`**. On the recorded league that ratio was 5 of 168 with
   a synthetic crosswalk; against the real DynastyProcess file expect roughly 85%.
4. Read the lineup line.
   *Expect:* the slots line to total the number of starters CBS's own "Active Players"
   setting allows — 8 for the recorded league (QB 1, RB 1, D/ST 1, RB/WR/TE 5), not 14.
   If a `CBS: the lineup allows N starters but the position maxima total M` note
   appears, that is the adapter saying which reading it took; check that N matches what
   your league's lineup page actually lets you set.
5. Read the volatility line.
   *Expect:* either the normal `volatility measured on N players: …` line, or that line
   followed by **`those are prior-season actuals around each player's own mean — CBS
   keeps no prior-season projections, so each sigma is shrunk toward the positional
   prior`**. The second is the D-15 fallback and is the expected CBS path today. What
   must not appear on a league with history is `only N players have prior-season
   history on CBS - season projection will assume ±25 pts`.
6. **Unverified path 1 — a rostered player's history.** In the same log, confirm the
   volatility line counts more than a handful of players, and that the note *`CBS:
   weekly scoring for … named none of this league's rostered players`* does **not**
   appear. The adapter sends `player_status=all`, but every recorded fixture defaulted
   to `free_agents` and holds 0 of 168 rostered players, so nothing offline can show
   that CBS answers for rostered players at all. If that note appears, `player_status`
   is being ignored and D-15's fallback has nothing to measure.
7. Let the trade search finish.
   *Expect:* a trade table with rows, exactly as ESPN's. This is the phase's headline
   claim and the only place it can be observed — there is no CBS golden set.
8. Find a deep-bench or practice-squad player in the roster grid and open a trade
   involving him.
   *Expect:* an em dash in the Market column, dashes in the usage columns, and the
   trade still scored and ranked normally on the engine's own numbers. A dash, never a
   zero, never a missing row: an unmapped player keeps his roster spot and his lineup
   seat and loses only the external joins.
9. **Unverified path 2 — the token transport.** Sign out of CBS in another tab, then
   reload the panel.
   *Expect:* the CBS sign-in screen: a link to `cbssports.com`'s own login page and a
   field for an API token. There must be **no password field and no password prompt of
   any kind** — the password login endpoint is never called and never will be (D-11).
10. Paste a token into that field and continue.
    *Expect:* the league loads. If it fails with a CORS or network error rather than an
    auth error, the bare `Authorization` header is the reason: the spike measured that
    route as untested rather than disproved, because a page origin cannot make the
    preflight. The fix is to move the token to the `access_token=` query parameter the
    spike did verify — a change of transport, not of design.
11. **Unverified path 3 — the token hand-over.** Sign back in to CBS, leave the league
    page open in another tab, and open the panel fresh from the toolbar icon.
    *Expect:* the league loads with no sign-in screen at all. The panel asks each open
    CBS tab for the page's token (`chrome.tabs.sendMessage({type: "ffsm.token"})`) and
    the content script answers from the page's own script text. Both halves are pinned
    character for character by tests; whether Chrome actually delivers the message, and
    whether the signed-in page still carries `CBSi.token`, has never been observed.
    While you are here, confirm the panel and the content script agree about the host:
    the two-level wildcard `https://*.cbssports.com/*` is assumed to match
    `<slug>.football.cbssports.com` and both hosts are listed so a wrong assumption
    costs a redundant permission rather than a broken script.

## Storage and privacy

1. In the panel's console, run:
   ```js
   chrome.storage.local.get(null, console.log)
   ```
2. *Expect:* every league-scoped key has **five** dot-separated segments —
   `ffsm.league.espn.12345.2026`, `ffsm.league.cbs.your-slug.2026`,
   `ffsm.calib.cbs.your-slug.2026`. A four-segment `ffsm.league.12345.2026` means the
   one-time migration did not run; reload the extension and open the panel again.
3. *Expect:* **no value anywhere contains the CBS token.** Search the logged object for
   the first eight characters of the token you pasted, and for the string
   `access_token`. The token lives on the run's `ref` in memory and nowhere else: not
   in storage, not in a URL, not in a log line. Anything found here is a privacy
   defect, not a convenience.
4. *Expect:* no key holds a password, and no key resembling `.espn_cookies` or a
   credentials file exists. The extension has never held a password for either
   platform.
5. *Note, not a defect:* `ffsm.myTeam` is a single global key, not per league. A user
   with both an ESPN and a CBS league shares one saved team name across them, so a name
   that exists in both leagues can shadow the other's pick. Pre-existing behaviour,
   recorded in `CLAUDE.md`'s Platforms section, out of scope for this phase.
6. *Note, not a defect:* `ffsm.calib.*` keys are never pruned. One key per
   league-season accumulates forever. The rows are small — one per rostered player per
   week — so this is housekeeping debt rather than a quota risk.
7. Open the Network tab and reload the panel once for each platform.
   *Expect:* requests to the platform's own hosts, to `api.sleeper.app`,
   `raw.githubusercontent.com`, `api.fantasycalc.com`, `sports.core.api.espn.com` (the
   public odds feed — used on both platforms and not the fantasy platform) and the
   weather feed. Nothing else, and nothing carrying a league id to a host that is not
   the platform.

## Sign-off

- [ ] **ESPN verified** on ______________ by ______________ — every step above, with
      any deviations written beside it.
- [ ] **CBS verified** on ______________ by ______________ — every step above, with the
      three unverified paths (6, 9–10, 11) recorded as confirmed or refuted in
      `.planning/WINDOWS.md`.
