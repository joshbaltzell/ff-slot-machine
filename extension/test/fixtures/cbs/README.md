# CBS fixtures

Recorded payloads from a real CBS Fantasy Football league, scrubbed the way
`extension/test/fixture.json` was. They are the contract the CBS adapter
(`extension/engine/platforms/cbs.js`) and its tests (`extension/test/cbs.mjs`) are
written against, and the `## Findings` block at the bottom is what later plans read.

`extension/test/run-all.mjs` is non-recursive, so nothing in this directory is a test
file and nothing here is imported by the extension.

## Provenance

- Capture date: `<capture date, filled by plan 11-01 Task 3>`
- Recorded from a real league through the owner's own signed-in browser session with
  `capture.js`, then scrubbed with `scrub.mjs`. The raw bundle held a live API token and
  real names; it was deleted after scrubbing and never entered the repository.
- No password was asked for, read or stored at any point. The token, if the page carries
  one, is only ever a string in the page the user is already signed in to (D-10, D-11).

## Files

Each route file is `{ url, status, ok, body }` where `body` is the CBS response exactly as
it came back — the `{ statusMessage, statusCode, uri, uriAlias, body }` envelope when the
route answered JSON, or the text (for example `User not signed in`) when it did not.

| File | Route — every request carries `league_id=<slug>`; sent through the league subdomain's `/api/` proxy with the session cookie when that authenticates, otherwise to `api.cbssports.com/fantasy/` with the page token (`authMode` in the bundle says which) |
|------|-------|
| `details.json` | `league/details` |
| `rules.json` | `league/rules` |
| `scoring-rules.json` | `league/scoring/rules` |
| `rosters.json` | `league/rosters?team_id=all` |
| `stats-week1.json` | `league/stats?stats_type=projections&period=week1&player_status=all` |
| `stats-week2.json` | `league/stats?stats_type=projections&period=week2&player_status=all` |
| `stats-free-agents-week1.json` | `league/stats?stats_type=projections&period=week1&player_status=free_agents` |
| `schedules.json` | `league/schedules?period=all` |
| `standings.json` | `league/standings/overall` |
| `weekly-scoring.json` | `league/fantasy-points/weekly-scoring` |
| `prior-season.json` | the three prior-season attempts, keyed by route: `league/fantasy-points/weekly-scoring?timeframe=2025`, `league/stats?stats_type=projections&period=week1&timeframe=2025`, `league/stats?stats_type=stats&period=week1&timeframe=2025` |
| `transactions.json` | `league/transaction-list/add-drops` — written only when the route answered; read for COVERAGE.md, never by the adapter |
| `auth-probe.json` | `{ A, B, C, cookieNames }`: statuses of the cookie route (A), the `Authorization`-header route (B) and the `access_token=` query route (C) on `league/details`; URLs scrubbed, no bodies, no token |
| `page.html` | the signed-in league page reduced to the `<script>` element(s) that matched a token pattern and the viewer-hint contexts, secrets replaced — or `<!-- no token match in page -->` |
| `page-meta.json` | `{ capturedAt, href, token: {found, pattern, length}, viewerHints: [{pattern, context}] }` |
| `public/positions.json`, `public/pro-teams.json`, `public/players-injuries.json`, `public/players-list.json` | the four public, unauthenticated `api.cbssports.com/fantasy/` feeds, fetched separately (Task 3); `players-list.json` is trimmed to the ids the league fixtures reference plus every team entity |

Everything else in this directory — `capture.js`, `scrub.mjs`, this file — is the kit.

## Scrub rules

Applied by `scrub.mjs` to every string in the bundle, keys and URLs included:

1. Every token value that patterns P1 `CBSi.token = "…"`, P2 `'access_token': '…'` (either
   quote), P3 `"token" : "…"`, P4 `var token = "…"` or P5 `access_token=…` find in the page,
   and every `access_token=` value anywhere, becomes `REDACTED`.
2. The league slug (the first label of the hostname) becomes `redacted-league`.
3. Team names found under rosters/standings/schedules team objects become `Team A`,
   `Team B`, … in first-seen order; the longest name is replaced first so a team called
   "Gang" does not eat "Gridiron Gang". Team abbreviations become `TMA`, `TMB`, ….
4. Owner-shaped fields inside team and owner objects (`owner`, `email`, `user`, `login`,
   `first_name`, `last_name`, `nickname`, and `name` inside an owner object) become
   `Owner N`, or `owner-n@example.invalid` when they carry an `@`.
5. Two extras: the league's display name becomes `Redacted League`, and any e-mail address
   anywhere becomes `owner-n@example.invalid`.

After writing, every output file is re-read. If a collected secret survives — whole, or
as a 12-character fragment of a token — the written files are deleted and the run prints
`SCRUB FAILED`. `node scrub.mjs --self-test` proves the rules on a synthetic bundle;
`node scrub.mjs --verify <dir>` re-checks a directory without knowing the secrets.

The league-scoped CBS shapes were unrecorded until this spike, so the collector reads
context from key names rather than a fixed schema and errs toward scrubbing too much.
Before committing re-recorded fixtures, still grep the directory for your own team,
owner and league names and the slug: the write-time check knows only what it collected.

## How to re-record

1. In Chrome, signed in to CBS, open your league's home page
   `https://<slug>.football.cbssports.com/`, then DevTools (Cmd+Option+J), Console tab.
2. Paste the whole of `capture.js`, press Enter, wait for `CAPTURE OK`. The bundle lands in
   `~/Downloads/ffsm-cbs-spike-raw.json`. It holds a live token and real names: do not move
   it into the repository.
3. From the repository root:
   `node extension/test/fixtures/cbs/scrub.mjs ~/Downloads/ffsm-cbs-spike-raw.json extension/test/fixtures/cbs`
   and wait for `SCRUB OK`.
4. `rm ~/Downloads/ffsm-cbs-spike-raw.json`
5. Re-fetch the four public feeds into `public/` (see plan 11-01 Task 3), fill in
   `## Findings` below, then
   `node extension/test/fixtures/cbs/scrub.mjs --verify extension/test/fixtures/cbs`
   must print `FIXTURES OK`. It exits 2 with `STOP AND REPORT` when `auth_route` is
   `none`: no route authenticates without a password, and the phase stops at 11-01 (D-11).

## Findings

Filled from the scrubbed fixtures by plan 11-01 Task 3. Later plans read these keys:
`auth_route` decides the adapter's primary auth mode (11-05, 11-06); the eligibility keys
pin D-13; the prior-season keys pick the D-15 volatility tier; `viewer_team` decides D-16.

| Key | Values |
|-----|--------|
| `auth_route` | `cookie` (probe A ok, envelope 200) · `page-token` (B or C ok) · `none` |
| `token_transport` | `header` · `query` · `n/a` |
| `eligibility_source` | `rosters` · `stats` · `both` · `none` |
| `eligibility_key` | the key that carries the per-player position array |
| `eligibility_vocabulary` | `DL/LB/DB` · `DE/DT/CB/S` |
| `stats_shape` | `object-by-id` · `array` |
| `stats_points_field` | the field carrying league-scored points |
| `roster_player_keys` | the keys of one roster player object |
| `details_structured_fields` | which of current period, regular-season periods, playoff periods, divisions, season are structured rather than prose |
| `prior_season_projections` | `yes` · `no`, with the parameter names that worked |
| `prior_season_actuals` | `yes` · `no`, with the parameter names that worked |
| `viewer_team` | the pattern that carries the viewer's team id, or `none` |
| `weekly_scoring_shape` | shape of `league/fantasy-points/weekly-scoring` |
| `current_week` | the current period as `league/details` reports it |

- auth_route: <pending>
- token_transport: <pending>
- eligibility_source: <pending>
- eligibility_key: <pending>
- eligibility_vocabulary: <pending>
- stats_shape: <pending>
- stats_points_field: <pending>
- roster_player_keys: <pending>
- details_structured_fields: <pending>
- prior_season_projections: <pending>
- prior_season_actuals: <pending>
- viewer_team: <pending>
- weekly_scoring_shape: <pending>
- current_week: <pending>
