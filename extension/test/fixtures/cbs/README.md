# CBS fixtures

Recorded payloads from a real CBS Fantasy Football league, scrubbed the way
`extension/test/fixture.json` was. They are the contract the CBS adapter
(`extension/engine/platforms/cbs.js`) and its tests (`extension/test/cbs.mjs`) are
written against, and the `## Findings` block at the bottom is what later plans read.

`extension/test/run-all.mjs` is non-recursive, so nothing in this directory is a test
file and nothing here is imported by the extension.

## Provenance

- Capture date: **2026-09-10** (`page-meta.json` carries the exact timestamp). A 12-team,
  PPR, head-to-head league in week 1 of the 2026 season, 14 regular-season periods and 3
  playoff periods, offence + DST only (no IDP), no divisions.
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

Applied by `scrub.mjs` to every string in the bundle. Rules 1 and 2 reach keys, values and
URLs alike; rules 3 to 5 stop at the value boundary, because a key is a schema name — one real
team's `short_name` is the word "Draft", and rewriting keys turned `draft_type` into
`Team B_type`:

1. Every token value that patterns P1 `CBSi.token = "…"`, P2 `'access_token': '…'` (either
   quote), P3 `"token" : "…"`, P4 `var token = "…"` or P5 `access_token=…` find in the page,
   and every `access_token=` value anywhere, becomes `REDACTED`.
2. The league slug (the first label of the hostname) becomes `redacted-league`.
3. Team names found under rosters/standings/schedules team objects become `Team A`,
   `Team B`, … in first-seen order, skipping any label a real team already uses (CBS's own
   placeholder for an unnamed team has exactly that shape); the longest name is replaced
   first so a team called "Gang" does not eat "Gridiron Gang". Team abbreviations become
   `TMA`, `TMB`, …, **in place only** — an abbreviation is too short to replace globally
   without eating an English word, so a re-record must grep for its own `long_abbr`.
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
4. Re-fetch the four public feeds into `public/`, with `Q="version=3.0&SPORT=football&response_format=JSON"`:
   `curl -sS "https://api.cbssports.com/fantasy/positions?$Q" -o public/positions.json`, and
   the same for `pro-teams`, `players/injuries` and `players/list`.
5. `node extension/test/fixtures/cbs/scrub.mjs --trim extension/test/fixtures/cbs` — trims
   `public/players-list.json` to the ids the league fixtures reference plus every team
   entity (seven keys each), and `prior-season.json`'s weekly scoring to 250 rows. Both are
   whole objects and the run is idempotent. Without it those two files are 1.7 MB and 5.7 MB.
6. Grep the directory for your own league, team and owner names, your slug and your
   `long_abbr` — the write-time check knows only what it collected.
7. `rm ~/Downloads/ffsm-cbs-spike-raw.json`
8. Fill in `## Findings` below, then
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

- auth_route: cookie — probe A (`https://{slug}.football.cbssports.com/api/league/details?…&league_id={slug}` with `credentials: "include"`, no token) answered HTTP 200 with envelope `statusCode` 200. The session cookie alone authenticates the league-subdomain proxy; the page token is a fallback, not the primary (D-10 inverted, RESEARCH assumption A2 overturned). Every one of the 14 recorded routes was fetched through it and every one answered 200. The proxy does **not** infer the league from the hostname: without an explicit `league_id` every league-scoped route answers 400 `Missing league_id`.
- token_transport: query — probe C (`https://api.cbssports.com/fantasy/league/details?…&access_token=<token>`) answered 200/200, which is how the page's own scripts call the API (`params={payload:…,access_token:CBSi.token,…}` in `page.html`). Probe B (the same URL with a bare `Authorization: <token>` header) returned status 0, `Failed to fetch`: a custom header triggers a CORS preflight the page origin is not allowed to make. `header` is therefore **untested, not disproved** — an extension page holding the host permission may still manage it, and 11-05 should probe it there rather than assume either way (RESEARCH A9 half-confirmed).
- eligibility_source: rosters and weekly-scoring — **not** `league/stats`, which carries only the single display code. `league/rosters?team_id=all` gives every rostered player's full list; `league/fantasy-points/weekly-scoring` gives every free agent's.
- eligibility_key: `eligible` on a roster player — a **comma-separated string**, not an array (`"RB,RB-WR-TE"`, `"WR,RB-WR-TE"`, `"TE,RB-WR-TE"`, `"QB"`, `"DST"`; 135 of 168 rostered players carry more than one code). `player.eligible_positions` on a weekly-scoring row is the same list as a real **array** (`["WR","RB-WR-TE"]`, 1,809 of 1,809). `eligible_positions_display` and `roster_pos` are single codes and are not the eligibility list. The codes are CBS **slot** abbreviations — the same vocabulary as `public/positions.json` — so D-13 expands a recorded list, not a guess.
- eligibility_vocabulary: **undetermined for IDP.** This league is offence + DST, so only `QB RB WR TE DST RB-WR-TE` appear. `public/positions.json` lists all 18 codes CBS supports (`QB TQB RB WR TE RB-WR WR-TE RB-WR-TE FLEX K TK DST D ST DB LB DL DL-LB-DB`) and describes `DB` as CB + S and `DL` as DE + DT + NT, so the league-facing vocabulary is `DL/LB/DB`; whether an IDP league's per-player `eligible` also spells `DE/DT/CB/S` is unrecorded. D-13 must accept both and a test must pin only what is recorded here.
- stats_shape: array — `body.league_stats.players[]`, one object per player, **not** keyed by id (the public `stats` route's `player_stats` object-by-id shape does not carry over). Each row is stat abbreviations to string-numbers (`"PaYd": "254.0"`) with a few numbers, plus `id`, `name`, `position`, `eligible_positions_display`, `pro_team`, `TM`, `free_agent`, `owned_by_team_id`, `on_waivers`, `period`, `date`.
- stats_points_field: `FPTS` (a number, e.g. `26.2`). It equals the roster row's `projected_points` on all 148 rostered players present in both, so it is the league-scored figure. `TP` is a different number on every row (0 of 148 match) and must not be used.
- roster_player_keys: 43 — `age, avg_points, bye_week, elias_id, eligible, eligible_for_il, eligible_for_offense_and_defense, eligible_positions_display, firstname, fullname, game_odds, gametime, headline, home_game, icons, id, is_keeper, is_locked, jersey, lastname, no_longer_eligible_for_il, no_longer_eligible_for_ml, on_waivers, on_waivers_until, opponent, opponent_team, opponents, oprk, owned_by_team_id, percentowned, percentstarted, photo, player_props, position, pro_status, pro_team, profile_link, profile_url, projected_points, roster_pos, roster_status, update_type, ytd_points`. Rosters are `body.rosters.teams[]` (12 teams, `{id, name, short_name, abbr, long_abbr, division, is_vacant, logo, lineup_status, point, projected_points, players[]}`) with `body.rosters.period` alongside. **No owner object and no owner name appears in any recorded route** — the scrubber replaced 0 owner strings because CBS returns none here.
- details_structured_fields: `body.league_details` carries current period (`current_period: "1"`, and `effective_period`), season (`season_status: "regularseason"`, `scoring_periods: 17`), regular-season and playoff **counts** (`regular_season_periods: 14`, `playoff_periods: "3"`), and league settings (`num_teams: 12`, `is_ppr: 1`, `is_h2h: "1"`, `uses_keepers`, `service_level`). Which weeks those are comes from `league/schedules?period=all`, whose `periods[]` each carry `type` — `"Regular Season"` for ids 1-14 and `"Playoffs"` for 15-17 — plus `label` ("Week 1"), `start`, `end` and `matchups[]`. So `currentWeek`, `regularSeasonWeeks` and `playoffWeeks` are all **read, never derived**; per-round playoff groupings are not published and must come from the period ids. Divisions are a per-team `division` string, empty in this league. Do not parse `rules.schedule.playoffs_last.value` ("3 Weeks") — it is display prose, as RESEARCH warned. Numbers arrive as mixed strings and numbers throughout (`"3"` beside `14`), so `Number()` everything.
- prior_season_projections: **yes** — `league/stats?stats_type=projections&period=week1&timeframe=2025` answered 200 with 271 players, each carrying `FPTS`. **RESEARCH assumption A8 is overturned**: CBS does retain prior-season projections under league scoring.
- prior_season_actuals: **yes**, from `league/fantasy-points/weekly-scoring?timeframe=2025` — 200 with `weekly_scoring.players[]`, each `{id, total, avg, player, periods: [{period, score}] }` over 22 periods, 443 of 1,809 rows carrying a non-zero total. The alternate parameter set the plan also tried, `league/stats?stats_type=stats&period=week1&timeframe=2025`, answered 200 with `players: []` — empty, so `stats_type=stats` is the wrong door and `fantasy-points/weekly-scoring` is the right one. **Caveat:** the route defaults to `player_status: free_agents`, so what came back is every player *currently* unrostered; 0 of the 168 rostered players appear. The adapter must send `player_status=all` to get a rostered player's history, and 11-05 should record that variant. With both tiers present, D-15's "assume ±25" fallback should be the last resort, not the expected path.
- viewer_team: **yes** — `var myTeamId = 16;` in the league page (`page-meta.json` `viewerHints[0]`, pattern `myTeamId`), and team 16 is a real team in `rosters.json`. The page also embeds the viewer's own team object beside its chat config (`"team": {"id": "16", …}`, pattern `long_abbr`), so there is a second, id-bearing route to the same answer. D-16's `pickTeam` prompt stays as the fallback but should not be the common path.
- weekly_scoring_shape: `body.weekly_scoring = { player_status, players[] }`, each row `{id, total, avg, player: {id, name, position, pro_team, eligible_positions, eligible_positions_display, free_agent, eligible_for_offense_and_defense}, periods: [{period, score}]}`. `periods` holds one entry per period played (1 in the current season's week 1, 22 for 2025). **`player_status` defaults to `free_agents`** — the current-season fixture is 1,809 free agents with 12 non-zero rows, and no rostered player. This is the feed `history` comes from, so the adapter must pass `player_status=all`.
- current_week: 1 — `league_details.current_period: "1"` (string), confirmed by `rosters.period: 1` and `standings.period: 1`. `season_status` is `regularseason`.

### Two notes the later plans need

- **Fixture sizes.** `public/players-list.json` (4,910 players, 1.7 MB) and `prior-season.json`
  (1,809 players over 22 periods, 5.7 MB) were trimmed by `scrub.mjs --trim` to 620 and 250
  whole rows; every other fixture is as recorded. `weekly-scoring.json` (1.11 MB) and the two
  `stats-week*.json` (about 1 MB each) are untrimmed.
- **Pro teams.** `public/pro-teams.json` differs from `PRO_TEAM` in `extension/engine/league.js`
  in exactly the two places RESEARCH found and no more: CBS says `JAC` where ESPN says `JAX`,
  and `WAS` where ESPN says `WSH`. ESPN's `FA` is a placeholder, not a 33rd team.
