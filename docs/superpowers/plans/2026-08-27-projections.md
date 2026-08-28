# Phase 5 — Projections: Multi-Source Aggregate and the Calibration Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Average ESPN's projections with Sleeper/RotoWire and FantasyPros ECR through a positional-fraction normalization, and start a per-league calibration log that measures this league's own shrinkage slopes instead of borrowing literature constants.

**Architecture:** Three new feed modules under `extension/engine/sources/` (`csv.js`, `sleeperproj.js`, `fantasypros.js`) supply per-week points keyed by ESPN player id. `extension/engine/aggregate.js` converts every source to a positional fraction, averages the fractions, and multiplies back by ESPN's positional mean — so nothing but league-scored points ever reaches `p.proj`. It runs in `start()` *before* `shrinkProjections`. `extension/engine/calibration.js` writes one row per player per week to `chrome.storage.local`, joins ESPN's own actuals (`statSourceId: 0`) on later runs, and fits the OLS slope of actual on projection; once six weeks have actuals those fitted slopes replace `CALIBRATION_K`. `extension/panel/projections.js` owns all orchestration and HTML so `panel.js` gains only its allowed hook points.

**Tech Stack:** Plain ES modules, no build step, Chrome MV3 extension page. Tests are `node extension/test/run-all.mjs` (custom `ok()` assertions, no framework). All new feeds are CORS-open public hosts; no host permissions are added.

**Spec:** `docs/superpowers/specs/2026-08-27-projections-design.md`
**Parallel-work rules (binding):** `docs/superpowers/specs/2026-08-27-parallel-phase-rules.md`

## Global Constraints

- **Do not modify `extension/engine/search.js` or `extension/engine/season.js`.** They belong to Phase 2 (rule 6). If a change seems necessary, stop and report instead.
- **Do not modify `extension/test/parity.mjs`.** It is the engine contract and must stay green untouched. All new assertions go in `extension/test/projections.mjs` using the `ok()` pattern from `extension/test/sources.mjs`.
- **Fixture tests never aggregate or shrink.** `projections.mjs` builds its own small synthetic model inline. Copy the model-literal pattern from `parity.mjs` lines 62–78; do not import from `parity.mjs`.
- **`panel.js` edits are limited to:** one import line, entries in `PHASES`, one block in `start()`, and one call site in `render()` per new section/column/chip group. Keep every edit to the smallest hunk that works. All logic lives in `extension/panel/projections.js`, `extension/engine/aggregate.js`, `extension/engine/calibration.js`, `extension/engine/sources/{sleeperproj,fantasypros,csv}.js`.
- **The engine models slots, not positions.** Position strings are display-only for lineup logic. `aggregate.js` and `calibration.js` group by `p.pos` *only* as the grouping for a statistical normalization / regression — never to decide a lineup. Say so in a comment in both files.
- **Every feature degrades.** A dead feed logs one line via `say()` and the feature shows `—`. Nothing throws out of `start()`. A source that fails leaves `agg === espn`.
- **Read settings, never derive them.** Use `model.settings.pprValue` and `model.settings.currentWeek` from `readSettings`. Do not re-parse raw settings.
- **Filter ESPN stats on `seasonId`.** Any `rawStats` read must match `statSplitTypeId === 1` *and* `seasonId === <current seasonId>` as well as `statSourceId` and `scoringPeriodId`. Matching without `seasonId` silently reads last season.
- **Aggregate runs before shrinkage.** Aggregate first, then calibrate the aggregate.
- **Both toggles persist.** `ffsm.aggregate` (default `true`) and the existing `ffsm.calibrate` survive "Refresh data".
- **Nothing leaves the machine.** Requests carry season and week only — never a league id, team name, or player list. No backend, no analytics.
- **All fetches are injectable.** Every function that fetches takes `{fetchImpl, storage, now}` and passes them through `cached()`, so tests run offline.
- **Sleeper politeness:** per-week projection calls are cached 6 h and fetched with concurrency ≤ 3, with a loading step that reports progress.
- **Browser verification is impossible in this environment.** Any task touching `panel.js`, `panel/projections.js` or a live URL shape must end its report with a "browser verification pending" checklist rather than a claim that the UI works.
- **Commit messages:** imperative subject, one commit per task, ending with the trailer block used in this repo:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
  ```
- **Run `node extension/test/run-all.mjs` and `node --check extension/panel.js` before every commit.**

## File structure

| File | Responsibility | Status |
|---|---|---|
| `extension/engine/sources/csv.js` | `parseCsv` / `parseCsvObjects`. Quoted fields, escaped quotes, CRLF. No feed knowledge. | create |
| `extension/engine/sources/sleeperproj.js` | Sleeper per-week projections: URL shape, PPR column choice, trim, ESPN-id join, concurrency ≤ 3, 6 h cache. | create |
| `extension/engine/sources/fantasypros.js` | DynastyProcess `fp_latest_weekly.csv` + `db_playerids.csv`; `r2p_pts` → ESPN id for the current week. | create |
| `extension/engine/aggregate.js` | `aggregateProjections`: positional-fraction normalization, in-place `p.proj` mutation, disagreement band. | create |
| `extension/engine/calibration.js` | Log read/write, actuals join from `rawStats`, `fitSlopes`, `summary`. | create |
| `extension/panel/projections.js` | All orchestration (`runProjections`) and all HTML (`sourcesChips`, `calibrationSection`, `bandMean`, `bandTag`). | create |
| `extension/panel.js` | One import line, one `PHASES` entry, one `start()` block, four minimal `render()` hunks. | modify |
| `extension/test/projections.mjs` | Every new assertion, offline. | create |
| `CLAUDE.md` | Architecture map + two load-bearing notes. | modify |

**Test file conventions.** `extension/test/projections.mjs` defines `ok(cond, what)`, `mkStorage()`, `mkFetch(table)` (copied from `sources.mjs`), `close(a, b, eps)` and a `mkModel()` helper. Each task appends a numbered section immediately before the final three lines:

```js
console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PROJECTIONS OK");
```

**Rulings already made by the controller** (implementers must follow, not relitigate):

1. **The `band` array is aligned to the `weeks` argument**, not to `model.weeks`. `band.get(id)[i]` is the band for `weeks[i]`. The panel passes the remaining weeks, which is exactly what the `±` column needs.
2. **The band uses the population standard deviation** (divide by *n*, not *n−1*). With two or three sources the sample sd overstates, and this is a display band, not an inference.
3. **Partial coverage is rescaled.** A source covering only some of a position's players is compared against ESPN *on the same shared set*, so a source that agrees with ESPN cannot shift the players it covers merely by covering a skewed subset. With full coverage the rescale factor is exactly 1 and the formula reduces to the spec's. Details in Task 4.
4. **Log rows carry `id` and `pos`** as well as the spec's `{week, espn, sleeper, fp, agg}`. Without them the actuals cannot be joined and nothing can be grouped by position.
5. **Slopes are fitted on the `agg` column** — that is the number `shrinkProjections` will actually shrink. With the aggregate toggle off, `agg` equals `espn`, so the column is always the right one.
6. **Fitted slopes are clamped to [0.3, 1.2]** and require ≥ 20 paired observations for that position; a position below the bar falls back to its `CALIBRATION_K` constant. `fitSlopes` returns `null` outright when fewer than 6 weeks have actuals.
7. **The `±` column is a plain mean over all remaining weeks**, counting weeks with no measurable disagreement as 0. It under-reports rather than over-reports, and it is a hint rather than a statistic.
8. **No `panel.css` change.** The Calibration section reuses `.panel`, `grid()`, `.note` and `.chips`. Fewer merge conflicts with the sibling phases.

---

### Task 1: CSV parser

**Files:**
- Create: `extension/engine/sources/csv.js`
- Create: `extension/test/projections.mjs`

**Interfaces:**
- Produces: `parseCsv(text: string): string[][]` — raw rows including the header.
- Produces: `parseCsvObjects(text: string): object[]` — one object per data row, keyed by trimmed header names, values are raw strings.

- [ ] **Step 1: Write the failing test**

Create `extension/test/projections.mjs`:

```js
/**
 * Tests for Phase 5: the projection sources, the aggregate and the calibration log.
 *
 * Everything here is offline: `fetchImpl` and `storage` are injected, and the model
 * is a small synthetic league built in `mkModel()` rather than `fixture.json` — the
 * fixture is the engine contract and must never be aggregated or shrunk.
 *
 *   node extension/test/projections.mjs
 */
import { parseCsv, parseCsvObjects } from "../engine/sources/csv.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const close = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; }, async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const mkFetch = (table) => { const calls = []; const f = async (url) => { calls.push(url);
  const hit = table[url]; if (!hit) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; }; f.calls = calls; return f; };

/* ---- 1. CSV ---- */
{
  const rows = parseCsv('a,b,c\n1,"x,y",3\n');
  ok(rows.length === 2, "csv: two rows");
  ok(rows[1][1] === "x,y", "csv: quoted comma stays one field");
  ok(rows[1][2] === "3", "csv: field after a quoted field");

  ok(parseCsv("a,b\n,2\n")[1][0] === "", "csv: leading empty field");
  ok(parseCsv("a,b\n1,\n")[1][1] === "", "csv: trailing empty field");
  ok(parseCsv('a\n"he said ""hi"""\n')[1][0] === 'he said "hi"', "csv: escaped quotes");
  ok(parseCsv("a,b\r\n1,2\r\n").length === 2, "csv: CRLF");
  ok(parseCsv("a,b\n1,2").length === 2, "csv: no trailing newline");
  ok(parseCsv("").length === 0, "csv: empty input");
  ok(parseCsv('a\n"x\ny"\n')[1][0] === "x\ny", "csv: newline inside quotes");

  const objs = parseCsvObjects(' fp_id ,r2p_pts\n7,12.5\n8,\n');
  ok(objs.length === 2, "csvObjects: two objects");
  ok(objs[0].fp_id === "7", "csvObjects: header is trimmed");
  ok(objs[0].r2p_pts === "12.5", "csvObjects: value read");
  ok(objs[1].r2p_pts === "", "csvObjects: empty field is an empty string");
  ok(parseCsvObjects("a,b\n1,2\n\n").length === 1, "csvObjects: blank trailing line ignored");
  ok(parseCsvObjects("").length === 0, "csvObjects: empty input");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PROJECTIONS OK");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/projections.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `Cannot find module .../engine/sources/csv.js`.

- [ ] **Step 3: Write the implementation**

Create `extension/engine/sources/csv.js`:

```js
/**
 * A CSV reader, because the DynastyProcess files are CSV and a naive `split(",")`
 * gets them wrong: player names contain commas inside quotes, and rows end with an
 * empty field often enough that dropping empties silently shifts every column after
 * it. Nothing here knows about any particular feed.
 */

/** @returns string[][] including the header row. Handles quotes, "" escapes and CRLF. */
export function parseCsv(text) {
  const s = String(text ?? "");
  const rows = [];
  let row = [], field = "", quoted = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }   // "" is one quote
        quoted = false; i++; continue;
      }
      field += c; i++; continue;                                     // newlines allowed inside quotes
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * @returns object[] — one per data row, keyed by the trimmed header names. Missing
 * trailing columns read as "", and a blank line is skipped rather than becoming a
 * row of empties.
 */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => String(h).trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === "") continue;
    const o = {};
    for (let c = 0; c < head.length; c++) o[head[c]] = cells[c] ?? "";
    out.push(o);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node extension/test/run-all.mjs`
Expected: three files, 0 failing; `PROJECTIONS OK` with 0 failures; parity still prints `605 assertions, 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/sources/csv.js extension/test/projections.mjs
git commit -m "$(cat <<'EOF'
Add a CSV reader for the DynastyProcess feeds

Quoted commas, "" escapes, CRLF and empty trailing fields — a split(",")
gets all four wrong, and a shifted column is a silent wrong answer.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
EOF
)"
```

---

### Task 2: Sleeper per-week projections

**Files:**
- Create: `extension/engine/sources/sleeperproj.js`
- Modify: `extension/test/projections.mjs` (append section 2)

**Interfaces:**
- Consumes: `cached()` from `./cache.js`; `loadSleeperPlayers().bySleeper` (a `Map<sleeperId, rec>` where `rec.espn_id` is a **number**) is passed in as `bySleeper`.
- Produces:
  - `weekUrl(season, week): string`
  - `pprColumn(pprValue): "pts_ppr" | "pts_half_ppr" | "pts_std"`
  - `trimWeek(raw): Array<{player_id: string, pts_ppr?: number, pts_half_ppr?: number, pts_std?: number}>`
  - `loadSleeperProjections({season, weeks, pprValue, bySleeper, onProgress, concurrency, ...opts}): Promise<{byWeek: Map<number, Map<number, number>>, weeks: number[], covered: number, failed: number[]}>` — the inner map is keyed by **ESPN** player id.

Note the endpoint has **no `/v1`** segment: `https://api.sleeper.app/projections/nfl/...`. Do not reuse `sleeper.js`'s `BASE`.

- [ ] **Step 1: Write the failing test**

Add this import at the top of `extension/test/projections.mjs`, after the `csv.js` import:

```js
import { loadSleeperProjections, pprColumn, trimWeek, weekUrl } from "../engine/sources/sleeperproj.js";
```

Append section 2 immediately before the `console.log(\`\n${checks} assertions...\`)` line:

```js
/* ---- 2. Sleeper per-week projections ---- */
{
  ok(pprColumn(1) === "pts_ppr", "ppr 1.0 -> pts_ppr");
  ok(pprColumn(0.5) === "pts_half_ppr", "ppr 0.5 -> pts_half_ppr");
  ok(pprColumn(0) === "pts_std", "ppr 0 -> pts_std");
  ok(pprColumn(0.9) === "pts_ppr", "ppr 0.9 rounds to full");
  ok(pprColumn(0.4) === "pts_half_ppr", "ppr 0.4 rounds to half");
  ok(pprColumn(0.2) === "pts_std", "ppr 0.2 rounds to standard");
  ok(pprColumn(undefined) === "pts_std", "missing ppr value -> standard");

  const u = weekUrl(2026, 7);
  ok(u.startsWith("https://api.sleeper.app/projections/nfl/2026/7?"), "week url has no /v1 segment");
  ok(u.includes("season_type=regular"), "week url asks for the regular season");
  ok(["QB", "RB", "WR", "TE", "K", "DEF"].every((p) => u.includes(`position[]=${p}`)), "week url asks for six positions");

  const rawWeek = (mult) => [
    { player_id: "s1", stats: { pts_ppr: 20 * mult, pts_half_ppr: 18 * mult, pts_std: 16 * mult } },
    { player_id: "s2", stats: { pts_ppr: 10 * mult, pts_half_ppr: 9 * mult, pts_std: 8 * mult } },
    { player_id: "s3", stats: { pts_ppr: 5 * mult } },
    { player_id: "s9", stats: { pts_ppr: 99 } },          // no espn id in the crosswalk
    { player_id: "s4" },                                  // no stats at all
    { stats: { pts_ppr: 1 } },                            // no id at all
  ];
  const trimmed = trimWeek(rawWeek(1));
  ok(trimmed.length === 4, "trimWeek drops rows with no id and no stats");
  ok(!trimmed.some((r) => "player" in r), "trimWeek keeps only the columns we read");
  ok(trimmed[0].player_id === "s1" && trimmed[0].pts_std === 16, "trimWeek keeps all three columns");
  ok(trimWeek(null).length === 0, "trimWeek tolerates a non-array payload");

  const bySleeper = new Map([["s1", { espn_id: 101 }], ["s2", { espn_id: 102 }], ["s3", { espn_id: 103 }]]);
  const storage = mkStorage();
  const fetchImpl = mkFetch({ [weekUrl(2026, 5)]: rawWeek(1), [weekUrl(2026, 6)]: rawWeek(2) });
  const seen = [];
  const r = await loadSleeperProjections({ season: 2026, weeks: [5, 6, 7], pprValue: 0.5, bySleeper,
    fetchImpl, storage, now: 0, onProgress: (d, t) => seen.push([d, t]) });
  ok(r.byWeek.get(5).get(101) === 18, "half-ppr column is used");
  ok(r.byWeek.get(6).get(102) === 18, "each week is fetched separately");
  ok(r.byWeek.get(5).get(103) === 5, "a row missing the chosen column falls back rather than vanishing");
  ok(!r.byWeek.get(5).has(99) && r.byWeek.get(5).size === 3, "a player with no espn id is dropped");
  ok(!r.byWeek.has(7), "a week whose fetch 404s is simply absent");
  ok(r.failed.length === 1 && r.failed[0] === 7, "the failed week is reported");
  ok(r.covered === 3, "covered counts distinct espn ids");
  ok(seen.length === 3 && seen[2][1] === 3, "progress is reported once per week");

  const again = await loadSleeperProjections({ season: 2026, weeks: [5], pprValue: 0.5, bySleeper,
    fetchImpl, storage, now: 1000 });
  ok(again.byWeek.get(5).get(101) === 18 && fetchImpl.calls.length === 3, "a fresh week comes from the cache");
  ok(JSON.stringify(storage._m.get("src.sleeperproj.2026.5").data).length
     < JSON.stringify(rawWeek(1)).length, "the cached copy is trimmed");

  const dead = await loadSleeperProjections({ season: 2026, weeks: [11, 12], pprValue: 1, bySleeper,
    fetchImpl: mkFetch({}), storage: mkStorage(), now: 0 });
  ok(dead.byWeek.size === 0 && dead.covered === 0 && dead.failed.length === 2, "a dead feed returns empty, not a throw");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/projections.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `Cannot find module .../engine/sources/sleeperproj.js`.

- [ ] **Step 3: Write the implementation**

Create `extension/engine/sources/sleeperproj.js`:

```js
/**
 * Sleeper's weekly projections (RotoWire's numbers), free and CORS-open.
 *
 * One call per remaining week, which is why they are cached for six hours and
 * fetched three at a time: this is a public feed being read on someone's behalf and
 * it should stay gentle enough to look like it. The response is trimmed to the three
 * scoring columns before it is cached — the raw payload is ~600 rows of full player
 * objects per week.
 *
 * Points come out keyed by ESPN player id, joined through the crosswalk in
 * `sleeper.js` (`loadSleeperPlayers().bySleeper`), because ESPN ids are what the
 * model is keyed on. Nothing but the season and the week goes over the wire.
 */
import { cached } from "./cache.js";

const BASE = "https://api.sleeper.app/projections/nfl";     // note: no /v1 here
const SIX_HOURS = 6 * 3600e3;
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const COLUMNS = ["pts_ppr", "pts_half_ppr", "pts_std"];

export function weekUrl(season, week) {
  const pos = POSITIONS.map((p) => `position[]=${p}`).join("&");
  return `${BASE}/${season}/${week}?season_type=regular&${pos}&order_by=pts_ppr`;
}

/**
 * Which of Sleeper's three scoring columns is closest to this league, from the
 * league's own points-per-reception setting. Nearest of 1 / 0.5 / 0.
 */
export function pprColumn(pprValue) {
  const v = Number(pprValue ?? 0);
  const options = [[1, "pts_ppr"], [0.5, "pts_half_ppr"], [0, "pts_std"]];
  let best = "pts_std", bestGap = Infinity;
  for (const [value, name] of options) {
    const gap = Math.abs((Number.isFinite(v) ? v : 0) - value);
    if (gap < bestGap) { bestGap = gap; best = name; }
  }
  return best;
}

/** Keep the id and the three scoring columns; drop everything else before caching. */
export function trimWeek(raw) {
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const id = row?.player_id ?? row?.player?.player_id;
    const stats = row?.stats;
    if (id == null || !stats) continue;
    const rec = { player_id: String(id) };
    let any = false;
    for (const c of COLUMNS) if (Number.isFinite(stats[c])) { rec[c] = stats[c]; any = true; }
    if (any) out.push(rec);
  }
  return out;
}

/**
 * @param weeks       the remaining weeks, one request each
 * @param bySleeper   Map<sleeperId, {espn_id}> from loadSleeperPlayers()
 * @param onProgress  (done, total, label)
 * @returns { byWeek: Map<week, Map<espnId, points>>, weeks, covered, failed }
 *          A week whose fetch fails is absent from `byWeek` and listed in `failed`;
 *          nothing throws, because a missing week must not cost the whole feature.
 */
export async function loadSleeperProjections({ season, weeks = [], pprValue = 0, bySleeper,
                                               onProgress = () => {}, concurrency = 3, ...opts } = {}) {
  const column = pprColumn(pprValue);
  const byWeek = new Map();
  const failed = [];
  const list = [...weeks];
  let done = 0;

  const one = async (wk) => {
    try {
      const r = await cached(`src.sleeperproj.${season}.${wk}`, weekUrl(season, wk),
        opts.ttlMs ?? SIX_HOURS, { ...opts, transform: trimWeek });
      const m = new Map();
      for (const row of r.data ?? []) {
        const espn = bySleeper?.get(row.player_id)?.espn_id;
        if (espn == null) continue;
        // The chosen column first. Sleeper always publishes all three for offence,
        // but a defence or kicker row can carry only one; a slightly different
        // reception weight beats dropping the player out of the average entirely.
        let pts = row[column];
        if (!Number.isFinite(pts)) for (const c of COLUMNS) if (Number.isFinite(row[c])) { pts = row[c]; break; }
        if (!(pts > 0)) continue;
        m.set(espn, pts);
      }
      byWeek.set(wk, m);
    } catch {
      failed.push(wk);
    }
    onProgress(++done, list.length, `week ${wk}`);
  };

  for (let i = 0; i < list.length; i += Math.max(1, concurrency))
    await Promise.all(list.slice(i, i + Math.max(1, concurrency)).map(one));

  const covered = new Set();
  for (const m of byWeek.values()) for (const id of m.keys()) covered.add(id);
  return { byWeek, weeks: [...byWeek.keys()].sort((a, b) => a - b), covered: covered.size, failed };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node extension/test/run-all.mjs`
Expected: 0 failures across all three files.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/sources/sleeperproj.js extension/test/projections.mjs
git commit -m "$(cat <<'EOF'
Add Sleeper's weekly projections as a second source

One call per remaining week, cached six hours, three at a time. The
scoring column is chosen from the league's own pprValue rather than
assumed, and points come out keyed by ESPN id through the existing
crosswalk. A week that fails is absent, not fatal.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
EOF
)"
```

---

### Task 3: FantasyPros ECR via DynastyProcess

**Files:**
- Create: `extension/engine/sources/fantasypros.js`
- Modify: `extension/test/projections.mjs` (append section 3)

**Interfaces:**
- Consumes: `cached()` from `./cache.js`, `parseCsvObjects` from `./csv.js`.
- Produces:
  - `WEEKLY_URL: string`, `IDS_URL: string`
  - `trimWeekly(text): {rows: Array<{fp: string, pts: number, week: number|null, pos: string}>, idKey: string|null, hasPts: boolean}`
  - `trimIds(text): Array<[string, number]>` — `[fantasypros_id, espn_id]` pairs, cache-friendly.
  - `loadFantasyProsWeek({week, ...opts}): Promise<{byEspn: Map<number, number>, week, available: boolean, reason: string}>`

**Assumption to state in a comment (and to flag in the task report as needing browser verification):** the FantasyPros id column in `fp_latest_weekly.csv` is one of `fantasypros_id`, `fp_id`, `id`, and the points column is `r2p_pts`. The header is probed at runtime; when neither the id column nor `r2p_pts` is present the source reports `available: false` and is skipped rather than guessed at. `db_playerids.csv` is assumed to carry literal `fantasypros_id` and `espn_id` columns.

- [ ] **Step 1: Write the failing test**

Add the import at the top of `extension/test/projections.mjs`:

```js
import { IDS_URL, WEEKLY_URL, loadFantasyProsWeek, trimIds, trimWeekly } from "../engine/sources/fantasypros.js";
```

Append section 3 before the summary lines:

```js
/* ---- 3. FantasyPros ECR via DynastyProcess ---- */
{
  const weekly = 'fp_id,player_name,pos,week,ecr,r2p_pts\n'
    + '7,"Smith, John",RB,5,3.1,14.25\n'
    + '8,Jones,WR,5,9.4,11.00\n'
    + '9,Ghost,TE,5,20.0,\n'
    + '10,Old,QB,4,1.0,25.00\n';
  const ids = "fantasypros_id,espn_id,name\n7,101,a\n8,102,b\n9,103,c\n10,104,d\n11,,e\n";

  const tw = trimWeekly(weekly);
  ok(tw.idKey === "fp_id", "the id column is probed from the header");
  ok(tw.hasPts === true, "r2p_pts is detected");
  ok(tw.rows.length === 3, "a row with no r2p_pts value is dropped");
  ok(tw.rows[0].fp === "7" && tw.rows[0].pts === 14.25 && tw.rows[0].week === 5, "a weekly row is read");
  ok(trimWeekly("fp_id,ecr\n7,1.0\n").hasPts === false, "no r2p_pts column is reported, not guessed");
  ok(trimWeekly("player_name,r2p_pts\nx,1.0\n").idKey === null, "no id column is reported");
  ok(trimWeekly("").rows.length === 0, "an empty CSV is tolerated");

  const pairs = trimIds(ids);
  ok(pairs.length === 4, "id rows without an espn id are dropped");
  ok(pairs[0][0] === "7" && pairs[0][1] === 101, "espn_id is numeric");

  const storage = mkStorage();
  const fetchImpl = mkFetch({ [WEEKLY_URL]: weekly, [IDS_URL]: ids });
  const r = await loadFantasyProsWeek({ week: 5, fetchImpl, storage, now: 0 });
  ok(r.available === true, "the source reports itself available");
  ok(r.byEspn.get(101) === 14.25 && r.byEspn.get(102) === 11, "points arrive keyed by espn id");
  ok(!r.byEspn.has(104), "another week's row is filtered out");
  ok(r.byEspn.size === 2, "only the current week matched");
  ok(fetchImpl.calls.length === 2, "two files, one fetch each");

  const r2 = await loadFantasyProsWeek({ week: 5, fetchImpl, storage, now: 1000 });
  ok(r2.byEspn.get(101) === 14.25 && fetchImpl.calls.length === 2, "both files come from the cache");

  const noPts = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0,
    fetchImpl: mkFetch({ [WEEKLY_URL]: "fp_id,ecr\n7,1.0\n", [IDS_URL]: ids }) });
  ok(noPts.available === false && noPts.byEspn.size === 0, "no r2p_pts means the source is skipped");
  ok(/r2p_pts/.test(noPts.reason), "the reason names the missing column");

  const deadIds = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0,
    fetchImpl: mkFetch({ [WEEKLY_URL]: weekly }) });
  ok(deadIds.available === false && deadIds.byEspn.size === 0, "a dead crosswalk degrades to unavailable");

  const dead = await loadFantasyProsWeek({ week: 5, storage: mkStorage(), now: 0, fetchImpl: mkFetch({}) });
  ok(dead.available === false && dead.reason.length > 0, "a dead feed returns a reason, not a throw");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/projections.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `Cannot find module .../engine/sources/fantasypros.js`.

- [ ] **Step 3: Write the implementation**

Create `extension/engine/sources/fantasypros.js`:

```js
/**
 * FantasyPros ECR, through DynastyProcess's public mirror on raw.githubusercontent
 * (CORS-open, no key, no scraping). Two files:
 *
 *  - `fp_latest_weekly.csv`  this week's consensus. The column we want is `r2p_pts`,
 *    FantasyPros' rank-to-points conversion: a rank is not a projection, and the
 *    conversion is the only thing in the file that can be averaged with points. When
 *    the column is absent the source is skipped rather than approximated.
 *  - `db_playerids.csv`      `fantasypros_id` -> `espn_id`, cached a week because
 *    ids do not move.
 *
 * Current week only: the file carries one week, and a weekly consensus does not
 * extrapolate. Nothing but the two file paths goes over the wire.
 *
 * ASSUMPTION, verified at runtime rather than trusted: the FantasyPros id column is
 * one of `fantasypros_id` / `fp_id` / `id`. The header is probed and the source
 * reports itself unavailable when no candidate matches, so a renamed column costs a
 * log line instead of wrong numbers.
 */
import { cached } from "./cache.js";
import { parseCsvObjects } from "./csv.js";

const RAW = "https://raw.githubusercontent.com/dynastyprocess/data/master/files";
export const WEEKLY_URL = `${RAW}/fp_latest_weekly.csv`;
export const IDS_URL = `${RAW}/db_playerids.csv`;
const SIX_HOURS = 6 * 3600e3;
const SEVEN_DAYS = 7 * 24 * 3600e3;
const ID_KEYS = ["fantasypros_id", "fp_id", "id"];

/** @returns {{rows, idKey, hasPts}} — trimmed to what we read, before caching. */
export function trimWeekly(text) {
  const raw = parseCsvObjects(text);
  if (!raw.length) return { rows: [], idKey: null, hasPts: false };
  const header = Object.keys(raw[0]);
  const idKey = ID_KEYS.find((k) => header.includes(k)) ?? null;
  const hasPts = header.includes("r2p_pts");
  const rows = [];
  if (idKey && hasPts) {
    for (const r of raw) {
      const id = r[idKey];
      // Number("") is 0, not NaN — an empty cell would sail through as a real
      // projection of zero and drag the positional mean down.
      const cell = String(r.r2p_pts ?? "").trim();
      const pts = cell === "" ? NaN : Number(cell);
      if (!id || !Number.isFinite(pts)) continue;
      const wk = Number(r.week);
      rows.push({ fp: String(id), pts, week: Number.isFinite(wk) ? wk : null,
                  pos: String(r.pos ?? r.position ?? "") });
    }
  }
  return { rows, idKey, hasPts };
}

/** @returns [[fantasypros_id, espn_id]] — an array so it survives JSON in storage. */
export function trimIds(text) {
  const out = [];
  for (const r of parseCsvObjects(text)) {
    const fp = r.fantasypros_id;
    const cell = String(r.espn_id ?? "").trim();      // Number("") is 0, not NaN
    const espn = cell === "" ? NaN : Number(cell);
    if (!fp || !Number.isFinite(espn)) continue;
    out.push([String(fp), espn]);
  }
  return out;
}

/**
 * @param week  the current scoring week; rows carrying a different week are dropped.
 * @returns { byEspn: Map<espnId, points>, week, available, reason }
 *          Never throws: a dead or renamed feed comes back `available: false` with a
 *          reason the panel can log in one line.
 */
export async function loadFantasyProsWeek({ week = null, ...opts } = {}) {
  let weekly;
  try {
    weekly = await cached("src.fp.weekly", WEEKLY_URL, opts.ttlMs ?? SIX_HOURS,
      { ...opts, parse: "text", transform: trimWeekly });
  } catch (err) {
    return { byEspn: new Map(), week, available: false, reason: String(err.message ?? err) };
  }
  const w = weekly.data ?? { rows: [], idKey: null, hasPts: false };
  if (!w.hasPts) return { byEspn: new Map(), week, available: false, reason: "no r2p_pts column" };
  if (!w.idKey) return { byEspn: new Map(), week, available: false, reason: "no fantasypros id column" };

  let idFile;
  try {
    idFile = await cached("src.fp.ids", IDS_URL, opts.idTtlMs ?? SEVEN_DAYS,
      { ...opts, parse: "text", transform: trimIds });
  } catch (err) {
    return { byEspn: new Map(), week, available: false, reason: `crosswalk ${err.message ?? err}` };
  }

  const toEspn = new Map(idFile.data ?? []);
  const byEspn = new Map();
  for (const r of w.rows) {
    if (r.week != null && week != null && r.week !== Number(week)) continue;
    const espn = toEspn.get(r.fp);
    if (espn == null || !(r.pts > 0)) continue;
    if (!byEspn.has(espn)) byEspn.set(espn, r.pts);      // first row wins; ids are unique in practice
  }
  return { byEspn, week, available: byEspn.size > 0, reason: byEspn.size ? "" : "no rows matched" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node extension/test/run-all.mjs`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/sources/fantasypros.js extension/test/projections.mjs
git commit -m "$(cat <<'EOF'
Add FantasyPros ECR as a third source

DynastyProcess's CORS-open mirror, current week only, joined to ESPN ids
through db_playerids.csv. Uses r2p_pts — a rank is not a projection, so
without that column the source is skipped rather than approximated. The
id column is probed, not trusted.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
EOF
)"
```

---

### Task 4: The aggregate — positional-fraction normalization

**Files:**
- Create: `extension/engine/aggregate.js`
- Modify: `extension/test/projections.mjs` (append `mkModel()` helper and section 4)

**Interfaces:**
- Consumes: a model shaped like `loadLeague`'s return — `{players: Map<id, {id, pos, proj}>, weeks}` where `p.proj` is an **object keyed by week number**.
- Produces: `aggregateProjections(model, sources, weeks): {changed: number, coverage: Record<string, number>, band: Map<number, Float64Array>, weeks: number[]}`
  - `sources`: `Array<{name: string, byWeek: Map<number, Map<number, number>>}>` — exactly the shape Tasks 2 and 3 produce (FantasyPros wraps its single week in a one-entry map).
  - Mutates `p.proj[week]` in place, the way `shrinkProjections` does.
  - `band.get(id)[i]` is the band for `weeks[i]` (ruling 1).

**The maths, spelled out.** For each position group and each week *w*:

- `E` = the group's players with `espn > 0`; `mE` = mean of `espn` over `E`. Skip the week when `|E| < 2` or `mE <= 0`.
- For each source *s*: `I_s` = players in `E` that *s* covers with a value `> 0`; skip *s* when `|I_s| < 2`. `mS` = mean of `src_s` over `I_s`.
- `kS` = (mean of `espn` over `I_s`) / `mE` — ESPN's own mean fraction on the shared set. **This is ruling 3:** multiplying by `kS` compares the source with ESPN on the same players, so a source covering a skewed subset cannot shift that subset's level. With full coverage `kS === 1` and the formula is exactly the spec's.
- `frac_s(p)` = `src_s(p) / mS * kS` for `p ∈ I_s`; `frac_ESPN(p)` = `espn(p) / mE`.
- `agg(p)` = `mE ×` mean of `frac_ESPN(p)` and every available `frac_s(p)`, rounded to 2dp.
- `band(p)` = `mE ×` **population** sd of the same fractions (ruling 2); `0` when only ESPN is available, in which case `agg === espn` and the player is left alone.

Every read of `espn` uses the pre-aggregate value, so all new values are staged and written only after every group and week is computed.

- [ ] **Step 1: Write the failing test**

Add the import at the top of `extension/test/projections.mjs`:

```js
import { aggregateProjections } from "../engine/aggregate.js";
```

Add this helper immediately after the `mkFetch` definition:

```js
/**
 * A synthetic league: four RBs and two QBs over three weeks. Deliberately not the
 * fixture — `fixture.json` is the engine contract and must never be aggregated.
 * Shaped like `loadLeague`'s return: `proj` is an object keyed by week number.
 */
const mkModel = (weeks = [5, 6, 7]) => {
  const spec = [
    [101, "RB", 10], [102, "RB", 20], [103, "RB", 30], [104, "RB", 40],
    [201, "QB", 15], [202, "QB", 25],
  ];
  return {
    weeks: [...weeks],
    settings: { pprValue: 0.5, currentWeek: weeks[0] },
    players: new Map(spec.map(([id, pos, base]) => [id, {
      id, name: `p${id}`, pos, nfl: "X", eligibleSlots: [], rawStats: [],
      proj: Object.fromEntries(weeks.map((w) => [w, base])),
    }])),
  };
};
const src = (name, week, entries) => ({ name, byWeek: new Map([[week, new Map(entries)]]) });
```

Append section 4 before the summary lines:

```js
/* ---- 4. the aggregate: positional-fraction normalization ---- */
{
  // A source that agrees with ESPN exactly changes nothing and disagrees by nothing.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 10], [102, 20], [103, 30], [104, 40]]);
    const r = aggregateProjections(m, [s], [5, 6, 7]);
    ok(close(m.players.get(101).proj[5], 10) && close(m.players.get(104).proj[5], 40),
       "a source agreeing exactly leaves agg = espn");
    ok(close(r.band.get(101)[0], 0) && close(r.band.get(104)[0], 0), "agreement means band = 0");
    ok(close(m.players.get(101).proj[6], 10), "a week the source does not cover is untouched");
    ok(r.coverage.sleeper === 4, "coverage counts the players the source reached");
  }

  // Only the shape matters, not the scale: a source at 2x across the board is the
  // same source. This is what makes averaging a non-league-scored feed legitimate.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 20], [102, 40], [103, 60], [104, 80]]);
    aggregateProjections(m, [s], [5]);
    ok(close(m.players.get(101).proj[5], 10) && close(m.players.get(103).proj[5], 30),
       "a source at 2x scale is identical after normalization");
  }

  // One player doubled inside the source. Hand-computed:
  //   src = 20,20,30,40 -> mS = 27.5 ; mE = 25 ; kS = 1
  //   frac_s : 0.727272..., 0.727272..., 1.090909..., 1.454545...
  //   frac_E : 0.4, 0.8, 1.2, 1.6
  //   agg(101) = 25 * (0.4 + 0.727272...)/2 = 14.09
  //   agg(102) = 25 * (0.8 + 0.727272...)/2 = 19.09
  //   agg(104) = 25 * (1.6 + 1.454545...)/2 = 38.18
  //   band(101) = 25 * |0.4 - 0.727272...|/2 = 4.09
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 20], [102, 20], [103, 30], [104, 40]]);
    const r = aggregateProjections(m, [s], [5]);
    ok(close(m.players.get(101).proj[5], 14.09, 5e-3), "a doubled player moves halfway to the source");
    ok(close(m.players.get(102).proj[5], 19.09, 5e-3), "the other players move by the mean shift");
    ok(close(m.players.get(104).proj[5], 38.18, 5e-3), "the top player moves too");
    ok(close(r.band.get(101)[0], 4.09, 5e-3), "band is the population sd, scaled back to points");
    ok(close(r.band.get(103)[0], 25 * Math.abs(1.2 - 30 / 27.5) / 2, 1e-6), "band for a middling player");
  }

  // Two sources, both agreeing: still espn, still no band.
  {
    const m = mkModel();
    const a = src("sleeper", 5, [[101, 10], [102, 20], [103, 30], [104, 40]]);
    const b = src("fp", 5, [[101, 5], [102, 10], [103, 15], [104, 20]]);
    const r = aggregateProjections(m, [a, b], [5]);
    ok(close(m.players.get(102).proj[5], 20), "two agreeing sources produce agg = espn");
    ok(close(r.band.get(102)[0], 0), "two agreeing sources produce band = 0");
    ok(r.coverage.sleeper === 4 && r.coverage.fp === 4, "coverage is reported per source");
  }

  // A player nobody else covers is left exactly alone.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 20], [102, 20], [103, 30]]);
    const before = m.players.get(104).proj[5];
    const r = aggregateProjections(m, [s], [5]);
    ok(m.players.get(104).proj[5] === before, "a player only ESPN covers is unchanged");
    ok(!r.band.has(104) || close(r.band.get(104)[0], 0), "an uncovered player has no band");
    ok(r.coverage.sleeper === 3, "coverage excludes the player the source missed");
  }

  // Partial coverage must not shift the covered players (ruling 3): the source agrees
  // with ESPN on the three players it covers, so all three stay put even though the
  // subset's mean is well below the position's.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[101, 10], [102, 20], [103, 30]]);
    aggregateProjections(m, [s], [5]);
    ok(close(m.players.get(101).proj[5], 10) && close(m.players.get(102).proj[5], 20)
       && close(m.players.get(103).proj[5], 30),
       "a source agreeing on a skewed subset does not move that subset");
  }

  // Positions are normalized independently.
  {
    const m = mkModel();
    const s = src("sleeper", 5, [[201, 30], [202, 25]]);
    aggregateProjections(m, [s], [5]);
    ok(m.players.get(101).proj[5] === 10, "an RB is untouched by a QB-only source");
    ok(m.players.get(201).proj[5] > 15, "the QB the source likes moves up");
    ok(m.players.get(202).proj[5] < 25, "the QB the source likes less moves down");
  }

  // Degradation and edges.
  {
    const m = mkModel();
    const r = aggregateProjections(m, [], [5, 6, 7]);
    ok(r.changed === 0 && r.band.size === 0, "no sources changes nothing");
    ok(m.players.get(103).proj[5] === 30, "no sources leaves ESPN alone");

    const m2 = mkModel();
    const dead = { name: "sleeper", byWeek: new Map() };
    aggregateProjections(m2, [dead], [5]);
    ok(m2.players.get(103).proj[5] === 30, "a dead source leaves agg = espn");

    const m3 = mkModel();
    aggregateProjections(m3, [src("sleeper", 5, [[101, 20]])], [5]);
    ok(m3.players.get(101).proj[5] === 10, "a source covering one player is ignored (no mean to take)");

    const m4 = mkModel();
    for (const p of m4.players.values()) p.proj[5] = 0;      // a bye-like week
    aggregateProjections(m4, [src("sleeper", 5, [[101, 20], [102, 20], [103, 30], [104, 40]])], [5]);
    ok(m4.players.get(101).proj[5] === 0, "a week with no ESPN projection is skipped");

    const m5 = mkModel();
    const r5 = aggregateProjections(m5, [src("sleeper", 5, [[101, 20], [102, 20], [103, 30], [104, 40]])], [5, 6, 7]);
    ok(r5.band.get(101).length === 3, "band is aligned to the weeks argument");
    ok(close(r5.band.get(101)[1], 0) && close(r5.band.get(101)[2], 0), "uncovered weeks band at zero");
    ok(r5.changed === 4, "changed counts the players actually moved");
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/projections.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `Cannot find module .../engine/aggregate.js`.

- [ ] **Step 3: Write the implementation**

Create `extension/engine/aggregate.js`:

```js
/**
 * Average several projection sources into ESPN's own scoring.
 *
 * Averaging sources beats any single source — Fantasy Football Analytics measured
 * the plain average of a set of projections beating the individual members 69% of
 * the time over twelve seasons, and accuracy-weighting the average added nothing.
 * ESPN is one source. Sleeper (RotoWire) and FantasyPros are two more.
 *
 * The catch is that raw points from different sources are not the same unit. ESPN's
 * numbers are scored under *this league's* rules — its reception value, its bonuses,
 * its defensive scoring. Sleeper's `pts_half_ppr` and FantasyPros' `r2p_pts` are
 * scored under theirs. Averaging them directly would silently re-score the league,
 * and the error is not small: it is whatever the two rule sets disagree about.
 *
 * So nothing is averaged in points. Each source is converted to a dimensionless
 * positional fraction — a player's value as a multiple of his position's mean in
 * that source, for that week — the fractions are averaged, and the result is
 * multiplied back by *ESPN's* positional mean. Only the shape of a source's opinion
 * crosses over; the units stay ESPN's throughout. A source at twice the scale is the
 * same source, and that is the property that makes this legitimate.
 *
 * The spread of the fractions is a second, free output: how much the sources
 * disagree about a player, in points. That is the `±` the panel shows.
 *
 * `pos` is used here only as the grouping for a statistical normalization. It is
 * never used for lineup logic — the engine models slots, not positions.
 *
 * Mutates `p.proj` in place, the way `shrinkProjections` does, and runs before it:
 * aggregate first, then calibrate the aggregate.
 */

/**
 * @param model    { players: Map<id, {id, pos, proj}> } — `proj` keyed by week number
 * @param sources  [{ name, byWeek: Map<week, Map<espnId, points>> }]
 * @param weeks    the weeks to aggregate, usually the remaining ones
 * @returns {{changed, coverage: Record<string, number>, band: Map<id, Float64Array>, weeks}}
 *          `band.get(id)[i]` is the disagreement for `weeks[i]`, in points.
 */
export function aggregateProjections(model, sources = [], weeks = model.weeks ?? []) {
  const W = [...weeks];
  const NW = W.length;
  const band = new Map();
  const covered = new Map(sources.map((s) => [s.name, new Set()]));

  const groups = new Map();
  for (const p of model.players.values()) {
    if (!groups.has(p.pos)) groups.set(p.pos, []);
    groups.get(p.pos).push(p);
  }

  // Staged, because every fraction below must be read from ESPN's ORIGINAL numbers.
  // Writing as we go would let week 5's new value feed week 6's positional mean.
  const staged = new Map();          // id -> Float64Array, NaN where untouched

  for (const members of groups.values()) {
    for (let wi = 0; wi < NW; wi++) {
      const w = W[wi];
      const live = members.filter((p) => p.proj[w] > 0);
      if (live.length < 2) continue;                       // no mean worth taking
      const mE = live.reduce((a, p) => a + p.proj[w], 0) / live.length;
      if (!(mE > 0)) continue;

      // One fraction map per source that covers at least two of this week's players.
      const fracs = [];
      for (const s of sources) {
        const feed = s.byWeek?.get(w);
        if (!feed) continue;
        const shared = [];
        for (const p of live) {
          const v = feed.get(p.id);
          if (Number.isFinite(v) && v > 0) shared.push([p, v]);
        }
        if (shared.length < 2) continue;
        const mS = shared.reduce((a, x) => a + x[1], 0) / shared.length;
        if (!(mS > 0)) continue;
        // ESPN's own mean fraction on the players this source covers. Multiplying by
        // it compares the source with ESPN on the same set, so covering a skewed
        // subset (say, only the starters) cannot shift that subset's level. With
        // full coverage this is exactly 1.
        const kS = (shared.reduce((a, x) => a + x[0].proj[w], 0) / shared.length) / mE;
        const f = new Map();
        for (const [p, v] of shared) { f.set(p.id, (v / mS) * kS); covered.get(s.name).add(p.id); }
        fracs.push(f);
      }
      if (!fracs.length) continue;

      for (const p of live) {
        const vals = [p.proj[w] / mE];                     // ESPN is a source too
        for (const f of fracs) { const v = f.get(p.id); if (v != null) vals.push(v); }
        if (vals.length < 2) continue;                     // only ESPN: leave him alone
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        // Population sd: with two or three sources the sample sd overstates, and this
        // is a spread to display, not an estimate to do inference with.
        const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;

        let arr = staged.get(p.id);
        if (!arr) { arr = new Float64Array(NW).fill(NaN); staged.set(p.id, arr); }
        arr[wi] = Math.round(mE * mean * 100) / 100;

        let b = band.get(p.id);
        if (!b) { b = new Float64Array(NW); band.set(p.id, b); }
        b[wi] = mE * Math.sqrt(varr);
      }
    }
  }

  let changed = 0;
  for (const [id, arr] of staged) {
    const p = model.players.get(id);
    if (!p) continue;
    let touched = false;
    for (let wi = 0; wi < NW; wi++) if (Number.isFinite(arr[wi])) { p.proj[W[wi]] = arr[wi]; touched = true; }
    if (touched) changed++;
  }

  const coverage = {};
  for (const s of sources) coverage[s.name] = covered.get(s.name).size;
  return { changed, coverage, band, weeks: W };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node extension/test/run-all.mjs`
Expected: 0 failures. Parity must still print `605 assertions, 0 failures` — nothing in this task touches it.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/aggregate.js extension/test/projections.mjs
git commit -m "$(cat <<'EOF'
Average projection sources through positional fractions

Raw external points are never averaged with ESPN's: ESPN's numbers are
scored under this league's rules and the others are not, so averaging
points would silently re-score the league. Each source becomes a
dimensionless fraction of its own positional mean, the fractions are
averaged, and the result is multiplied back by ESPN's mean. A source at
2x scale is therefore the same source. The spread of the fractions is
the disagreement band.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
EOF
)"
```

---

### Task 5: The calibration log

**Files:**
- Create: `extension/engine/calibration.js`
- Modify: `extension/test/projections.mjs` (append section 5)

**Interfaces:**
- Consumes: `{storage}` injection exactly like the source layer (`storage.get(key)` resolves to `{[key]: value}`; `storage.set(obj)`). `CALIBRATION_K` from `../engine/calibrate.js` for the per-position fallback.
- Produces:
  - `logKey(leagueId, seasonId): string` → `` `ffsm.calib.${leagueId}.${seasonId}` ``
  - `logWeek({storage, leagueId, seasonId, week, rows, now}): Promise<log>` where a row is `{id, pos, espn, sleeper, fp, agg}`
  - `loadLog({storage, leagueId, seasonId}): Promise<{weeks: Record<string, {at, rows}>}>`
  - `attachActuals(log, players, seasonId): {log, filled: number}` — mutates rows, adding `actual`
  - `weeksStored(log): number`, `weeksWithActuals(log): number`
  - `summary(log): Array<{source, pos, n, mae, bias, slope}>`
  - `fitSlopes(log, opts?): {QB, RB, WR, TE} | null` — `null` when fewer than `minWeeks` (6) weeks have actuals; a position with fewer than `minN` (20) pairs is `null` inside the object.
  - `mergeSlopes(fitted): {k, fitted: boolean, positions: string[]}` — fitted where measured, `CALIBRATION_K` where not. This is the map Task 6 hands to `shrinkProjections`.
  - `MIN_WEEKS: 6`, `MIN_N: 20`, `SLOPE_CLAMP: [0.3, 1.2]`, `FIT_POS: ["QB","RB","WR","TE"]`

**Why the log exists.** `CALIBRATION_K` is a literature constant measured across other people's leagues. The slope of actual on projected under *this* league's scoring is a different number, and it is one nobody but this extension can measure — it needs both the projections that were shown before the week and the points the league actually awarded. So each run appends the week's projections, and each later run joins ESPN's own actuals to them.

- [ ] **Step 1: Write the failing test**

Add the import at the top of `extension/test/projections.mjs`:

```js
import { FIT_POS, MIN_N, MIN_WEEKS, attachActuals, fitSlopes, loadLog, logKey, logWeek,
         summary, weeksStored, weeksWithActuals } from "../engine/calibration.js";
```

Append section 5 before the summary lines:

```js
/* ---- 5. the calibration log ---- */
{
  ok(logKey(7, 2026) === "ffsm.calib.7.2026", "the log is keyed by league and season");

  /* storage round trip */
  {
    const storage = mkStorage();
    const ref = { storage, leagueId: 7, seasonId: 2026 };
    await logWeek({ ...ref, week: 5, rows: [{ id: 101, pos: "RB", espn: 10, sleeper: 11, fp: 12, agg: 11 }], now: 1 });
    await logWeek({ ...ref, week: 6, rows: [{ id: 101, pos: "RB", espn: 20, sleeper: null, fp: null, agg: 20 }], now: 2 });
    const log = await loadLog(ref);
    ok(weeksStored(log) === 2, "two weeks stored");
    ok(log.weeks["5"].rows[0].sleeper === 11, "a row round-trips");
    ok(log.weeks["5"].at === 1, "each week records when it was written");
    await logWeek({ ...ref, week: 5, rows: [{ id: 101, pos: "RB", espn: 99, sleeper: null, fp: null, agg: 99 }], now: 3 });
    const log2 = await loadLog(ref);
    ok(weeksStored(log2) === 2 && log2.weeks["5"].rows[0].espn === 99, "re-running a week overwrites it");
    ok((await loadLog({ storage, leagueId: 8, seasonId: 2026 })).weeks
       && weeksStored(await loadLog({ storage, leagueId: 8, seasonId: 2026 })) === 0,
       "an unknown league reads as an empty log");
  }

  /* actuals come from ESPN's own rawStats, filtered on seasonId */
  {
    const log = { weeks: { 5: { at: 0, rows: [
      { id: 101, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10 },
      { id: 999, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10 },
    ] } } };
    const players = new Map([[101, { id: 101, rawStats: [
      { statSourceId: 0, statSplitTypeId: 1, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 13.456 },
      { statSourceId: 0, statSplitTypeId: 1, seasonId: 2025, scoringPeriodId: 5, appliedTotal: 99 },
      { statSourceId: 1, statSplitTypeId: 1, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 88 },
      { statSourceId: 0, statSplitTypeId: 0, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 77 },
    ] }]]);
    const r = attachActuals(log, players, 2026);
    ok(close(log.weeks["5"].rows[0].actual, 13.46), "the actual is read and rounded");
    ok(log.weeks["5"].rows[1].actual === undefined, "a player no longer in the league is left alone");
    ok(r.filled === 1, "filled counts the rows joined");
    ok(weeksWithActuals(log) === 1, "a week with any actual counts");
    ok(weeksWithActuals({ weeks: { 6: { rows: [{ id: 1, espn: 1 }] } } }) === 0, "a week with no actuals does not");
  }

  /* MAE, bias and slope on a hand-checkable log */
  {
    // espn 10 -> actual 12 (err +2) ; espn 20 -> actual 16 (err -4)
    const log = { weeks: {
      5: { at: 0, rows: [{ id: 1, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10, actual: 12 }] },
      6: { at: 0, rows: [{ id: 1, pos: "RB", espn: 20, sleeper: null, fp: null, agg: 20, actual: 16 }] },
    } };
    const rows = summary(log);
    const rb = rows.find((r) => r.source === "espn" && r.pos === "RB");
    ok(rb.n === 2, "summary counts pairs");
    ok(close(rb.mae, 3), "MAE is the mean absolute error");
    ok(close(rb.bias, -1), "bias is the mean signed error");
    ok(close(rb.slope, 0.4), "slope is OLS of actual on projection");
    ok(rows.every((r) => r.source !== "sleeper"), "a source with no values produces no row");
    ok(summary({ weeks: {} }).length === 0, "an empty log summarises to nothing");
  }

  /* a synthetic season: actual = 0.8 * proj + deterministic noise */
  {
    // A small LCG so the test is reproducible: real noise, no Math.random.
    // MINSTD: seed * 48271 stays inside the safe-integer range. The textbook
    // (seed * 1103515245 + 12345) does not, and silently degenerates.
    let seed = 12345;
    const noise = () => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 - 0.5) * 4; };
    const weeks = {};
    for (let w = 1; w <= 8; w++) {
      const rows = [];
      for (const pos of FIT_POS)
        for (let k = 0; k < 20; k++) {
          const proj = 4 + k * 1.2;
          rows.push({ id: `${pos}${k}`, pos, espn: proj, sleeper: null, fp: null,
                      agg: proj, actual: Math.round((0.8 * proj + noise()) * 100) / 100 });
        }
      weeks[w] = { at: 0, rows };
    }
    const log = { weeks };
    ok(weeksWithActuals(log) === 8, "eight weeks have actuals");
    const k = fitSlopes(log);
    ok(k !== null, "with eight weeks the fit runs");
    ok(FIT_POS.every((p) => Math.abs(k[p] - 0.8) < 0.05), `fitted slopes land near 0.8 (${JSON.stringify(k)})`);

    /* fewer than six weeks with actuals returns null slopes */
    const short = { weeks: Object.fromEntries(Object.entries(weeks).slice(0, 5)) };
    ok(weeksWithActuals(short) === 5, "five weeks in the short log");
    ok(fitSlopes(short) === null, "fewer than six weeks with actuals returns null");

    /* a position below the observation floor is null rather than a noisy number */
    const thin = { weeks: Object.fromEntries(Object.entries(weeks).map(([w, e]) =>
      [w, { at: 0, rows: e.rows.filter((r) => r.pos !== "TE" || Number(r.id.slice(2)) < 1) }])) };
    const kThin = fitSlopes(thin);
    ok(kThin.TE === null, `a position with fewer than ${MIN_N} pairs is null`);
    ok(typeof kThin.QB === "number", "the other positions still fit");

    /* an absurd slope is clamped rather than trusted */
    const wild = { weeks: Object.fromEntries(Object.entries(weeks).map(([w, e]) =>
      [w, { at: 0, rows: e.rows.map((r) => ({ ...r, actual: r.agg * 9 })) }])) };
    ok(fitSlopes(wild).RB === 1.2, "a slope above the clamp is clamped");
    const flat = { weeks: Object.fromEntries(Object.entries(weeks).map(([w, e]) =>
      [w, { at: 0, rows: e.rows.map((r) => ({ ...r, actual: r.agg * 0.01 })) }])) };
    ok(flat && fitSlopes(flat).RB === 0.3, "a slope below the clamp is clamped");

    ok(MIN_WEEKS === 6, "the week floor is six");
  }

  /* rows with no variation cannot produce a slope */
  {
    const rows = [];
    for (let k = 0; k < 25; k++) rows.push({ id: k, pos: "RB", espn: 10, sleeper: null, fp: null, agg: 10, actual: 11 });
    const log = { weeks: Object.fromEntries([1, 2, 3, 4, 5, 6].map((w) => [w, { at: 0, rows: rows.map((r) => ({ ...r })) }])) };
    ok(fitSlopes(log).RB === null, "no spread in the projections means no slope");
    ok(close(summary(log).find((r) => r.source === "agg" && r.pos === "RB").bias, 1), "bias still works");
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/projections.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `Cannot find module .../engine/calibration.js`.

- [ ] **Step 3: Write the implementation**

Create `extension/engine/calibration.js`:

```js
/**
 * The calibration log: this league's own projection error, measured over time.
 *
 * `CALIBRATION_K` in `calibrate.js` holds slopes measured across other people's
 * leagues over twelve seasons. They are the best available prior, but they are not
 * this league's numbers: the slope of actual on projected depends on the scoring
 * rules, and this league has its own. Nobody else can measure it either — it needs
 * the projection as it stood *before* the week alongside the points the league
 * actually awarded, and only something running here each week has both.
 *
 * So each run appends one row per player for the current week — every source's
 * number and the aggregate — and each later run joins ESPN's own actuals to the
 * weeks that have since been played. Once six weeks carry actuals the fitted slopes
 * replace the constants.
 *
 * This is the only league-specific model in the extension, and it lives entirely in
 * `chrome.storage.local` under `ffsm.calib.{leagueId}.{seasonId}`. It is never sent
 * anywhere; there is nowhere to send it.
 *
 * `pos` groups the regressions because the slope genuinely differs by position (a
 * quarterback's projection is tighter than a tight end's). It is not lineup logic.
 *
 * Storage is injected as `{storage}`, like the source layer, so tests use a Map.
 */
import { CALIBRATION_K } from "./calibrate.js";

export const FIT_POS = ["QB", "RB", "WR", "TE"];
export const MIN_WEEKS = 6;          // fewer, and the fit is noise
export const MIN_N = 20;             // per position
export const SLOPE_CLAMP = [0.3, 1.2];
const SOURCES = ["espn", "sleeper", "fp", "agg"];

export const logKey = (leagueId, seasonId) => `ffsm.calib.${leagueId}.${seasonId}`;

/**
 * Append (or replace) one week. `rows` are `{id, pos, espn, sleeper, fp, agg}`.
 * `id` and `pos` are not decoration: without `id` the actuals cannot be joined, and
 * without `pos` nothing can be grouped.
 */
export async function logWeek({ storage, leagueId, seasonId, week, rows, now = Date.now() }) {
  const key = logKey(leagueId, seasonId);
  const log = (await storage.get(key))[key] ?? { weeks: {} };
  if (!log.weeks) log.weeks = {};
  log.weeks[String(week)] = { at: now, rows: rows ?? [] };
  await storage.set({ [key]: log });
  return log;
}

export async function loadLog({ storage, leagueId, seasonId }) {
  const key = logKey(leagueId, seasonId);
  const log = (await storage.get(key))[key];
  return log && log.weeks ? log : { weeks: {} };
}

export const weeksStored = (log) => Object.keys(log?.weeks ?? {}).length;

export const weeksWithActuals = (log) => Object.values(log?.weeks ?? {})
  .filter((e) => (e.rows ?? []).some((r) => Number.isFinite(r.actual))).length;

/**
 * Fill `actual` on every logged row from ESPN's own weekly scores.
 *
 * `statSourceId: 0` is the actual, `1` is the projection, and ESPN returns the prior
 * season's rows for the same scoring period in the same payload — so `seasonId` is
 * part of the match, not an optional extra. Matching without it reads last season.
 *
 * @param players Map<id, {rawStats}> or an iterable of player records
 * @returns {{log, filled}} — mutates the rows in `log`
 */
export function attachActuals(log, players, seasonId) {
  const byId = players instanceof Map
    ? players
    : new Map([...(players ?? [])].map((p) => [p.id, p]));
  let filled = 0;
  for (const [wk, entry] of Object.entries(log?.weeks ?? {})) {
    const w = Number(wk);
    for (const r of entry.rows ?? []) {
      if (Number.isFinite(r.actual)) { filled++; continue; }
      const p = byId.get(r.id);
      if (!p) continue;
      const st = (p.rawStats ?? []).find((x) => x.statSourceId === 0 && x.statSplitTypeId === 1
        && x.seasonId === seasonId && x.scoringPeriodId === w);
      if (st && Number.isFinite(st.appliedTotal)) {
        r.actual = Math.round(st.appliedTotal * 100) / 100;
        filled++;
      }
    }
  }
  return { log, filled };
}

/** OLS slope of y on x, with an intercept. null when x has no spread. */
function slopeOf(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (const [x, y] of pairs) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  return sxx > 0 ? sxy / sxx : null;
}

function pairsFor(log, column, pos) {
  const out = [];
  for (const entry of Object.values(log?.weeks ?? {}))
    for (const r of entry.rows ?? []) {
      if (pos != null && (r.pos ?? "") !== pos) continue;
      if (!Number.isFinite(r.actual)) continue;
      const x = r[column];
      if (!Number.isFinite(x) || !(x > 0)) continue;
      out.push([x, r.actual]);
    }
  return out;
}

/**
 * One row per source × position: how wrong it has been, which way, and by how much
 * it is over-spread. `slope` is null when the projections in that cell do not vary.
 */
export function summary(log) {
  const rows = [];
  const positions = new Set();
  for (const entry of Object.values(log?.weeks ?? {}))
    for (const r of entry.rows ?? []) if (Number.isFinite(r.actual)) positions.add(r.pos ?? "?");
  for (const source of SOURCES)
    for (const pos of [...positions].sort()) {
      const pairs = pairsFor(log, source, pos);
      if (!pairs.length) continue;
      const n = pairs.length;
      const mae = pairs.reduce((a, [x, y]) => a + Math.abs(y - x), 0) / n;
      const bias = pairs.reduce((a, [x, y]) => a + (y - x), 0) / n;
      const slope = slopeOf(pairs);
      rows.push({ source, pos, n,
        mae: Math.round(mae * 100) / 100,
        bias: Math.round(bias * 100) / 100,
        slope: slope == null ? null : Math.round(slope * 1000) / 1000 });
    }
  return rows;
}

/**
 * The shrinkage slopes this league has actually earned.
 *
 * Fitted on the `agg` column, because that is the number `shrinkProjections` will
 * shrink. With the aggregate off, `agg` equals `espn`, so the column is always the
 * right one.
 *
 * @returns {{QB,RB,WR,TE}} with a number or null per position, or null overall when
 *          fewer than `minWeeks` weeks carry actuals. Slopes are clamped: a fit
 *          outside [0.3, 1.2] is measurement noise or a scoring change, not a real
 *          slope, and applying it would be worse than the literature constant.
 */
export function fitSlopes(log, { column = "agg", minWeeks = MIN_WEEKS, minN = MIN_N } = {}) {
  if (weeksWithActuals(log) < minWeeks) return null;
  const out = {};
  for (const pos of FIT_POS) {
    const pairs = pairsFor(log, column, pos);
    const b = pairs.length >= minN ? slopeOf(pairs) : null;
    out[pos] = b == null ? null
      : Math.round(Math.min(SLOPE_CLAMP[1], Math.max(SLOPE_CLAMP[0], b)) * 1000) / 1000;
  }
  return out;
}

/** Fitted where measured, literature where not. The map `shrinkProjections` wants. */
export function mergeSlopes(fitted) {
  const k = { ...CALIBRATION_K };
  if (!fitted) return { k, fitted: false, positions: [] };
  const positions = [];
  for (const pos of FIT_POS) if (Number.isFinite(fitted[pos])) { k[pos] = fitted[pos]; positions.push(pos); }
  return { k, fitted: positions.length > 0, positions };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node extension/test/run-all.mjs`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add extension/engine/calibration.js extension/test/projections.mjs
git commit -m "$(cat <<'EOF'
Measure this league's own calibration slopes

CALIBRATION_K is a literature constant from other people's leagues. The
slope of actual on projected depends on the scoring rules, so this league
has its own — and only something running here each week can measure it,
because it needs the projection as it stood before the week alongside the
points actually awarded. Each run logs the week; each later run joins
ESPN's actuals (statSourceId 0, matched on seasonId) and refits. Six
weeks of actuals and twenty pairs per position before a fitted slope is
trusted, clamped to [0.3, 1.2].

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
EOF
)"
```

---

### Task 6: Panel module — orchestration and HTML

**Files:**
- Create: `extension/panel/projections.js`
- Modify: `extension/test/projections.mjs` (append section 6)

**Interfaces:**
- Consumes: everything from Tasks 2–5, plus `loadSleeperPlayers` from `../engine/sources/sleeper.js` and `CALIBRATION_K` from `../engine/calibrate.js`.
- Produces:
  - `runProjections({model, ref, say, progress, storage, fetchImpl, now}): Promise<{aggregate, band, k, fitted, fittedPositions, summaryRows, coverage, weeksStored, weeksWithActuals, remaining}>`
    - Reads the `ffsm.aggregate` toggle (default `true`) through `storage`.
    - Never throws. Every failure becomes a `say()` line and a degraded field.
    - `k` is the map to hand `shrinkProjections`.
  - `bandMean(band, id): number` — plain mean over all weeks in the band array (ruling 7); `0` when absent.
  - `bandTag(band, id, threshold = 0.5): string` — `` ` ±N.N` `` when the mean exceeds the threshold, else `""`. Returns plain text; the caller inserts it into already-escaped markup.
  - `sourcesChips(state): string` — the `Sources` chip group HTML, `id="sources"`.
  - `bindSourcesChips(root, {storage, reload}): void`
  - `calibrationSection(state, {grid, esc}): string` — the whole `<section>`; `grid` and `esc` are passed in so `panel.js` keeps ownership of them.

`runProjections` order of operations (this is the load-bearing part):

1. `remaining` = `model.weeks.filter(w => w >= model.settings.currentWeek)`; fall back to `model.weeks` when that is empty.
2. **Snapshot ESPN's current-week value for every player before anything mutates it** — the log's `espn` column must be pre-aggregate.
3. If the toggle is on: load `bySleeper`, then Sleeper and FantasyPros in parallel, then `aggregateProjections`.
4. Log the current week: `{id, pos, espn (snapshot), sleeper, fp, agg (post-aggregate)}`.
5. Load the log, `attachActuals`, `fitSlopes`, `mergeSlopes`.
6. Return; `panel.js` runs `shrinkProjections` with `k`.

- [ ] **Step 1: Write the failing test**

Add the import at the top of `extension/test/projections.mjs`:

```js
import { bandMean, bandTag, calibrationSection, runProjections, sourcesChips }
  from "../panel/projections.js";
```

Append section 6 before the summary lines:

```js
/* ---- 6. the panel module ---- */
{
  /* band helpers */
  {
    const band = new Map([[1, Float64Array.from([2, 4, 0])], [2, Float64Array.from([0.3, 0.3, 0.3])]]);
    ok(close(bandMean(band, 1), 2), "bandMean is a plain mean over every week");
    ok(bandMean(band, 99) === 0, "an unknown player bands at zero");
    ok(bandMean(null, 1) === 0, "no band at all is zero");
    ok(bandTag(band, 1).trim() === "±2.0", "a band over the threshold renders");
    ok(bandTag(band, 2) === "", "a band under the threshold is silent");
    ok(bandTag(band, 99) === "", "an unknown player renders nothing");
  }

  /* chips reflect the toggle */
  {
    const on = sourcesChips({ aggregate: true });
    ok(on.includes('id="sources"'), "the chip group has an id to bind to");
    ok(/data-v="1"[^>]*aria-pressed="true"/.test(on), "aggregate on is pressed");
    ok(/data-v="0"[^>]*aria-pressed="false"/.test(on), "espn-only is not pressed");
    const off = sourcesChips({ aggregate: false });
    ok(/data-v="0"[^>]*aria-pressed="true"/.test(off), "the toggle flips");
  }

  /* the calibration section */
  {
    const grid = (id, cols, rows, opts) => `<table id="${id}">${rows.map((r) => opts.row(r, 0)).join("")}</table>`;
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const html = calibrationSection({
      summaryRows: [{ source: "espn", pos: "RB", n: 40, mae: 5.5, bias: -1.2, slope: 0.81 },
                    { source: "agg", pos: "RB", n: 40, mae: 5.1, bias: -0.9, slope: null }],
      fitted: true, fittedPositions: ["RB"], k: { QB: 0.67, RB: 0.81, WR: 0.85, TE: 0.72 },
      weeksStored: 8, weeksWithActuals: 7,
    }, { grid, esc });
    ok(html.includes("<section"), "it returns a section");
    ok(/Calibration/.test(html), "it is titled");
    ok(html.includes("0.81"), "a fitted slope is shown");
    ok(html.includes("—"), "a null slope renders as a dash");
    ok(/fitted/i.test(html), "the note says fitted slopes are in use");
    ok(/8/.test(html) && /7/.test(html), "it says how much data there is");

    const early = calibrationSection({ summaryRows: [], fitted: false, fittedPositions: [],
      k: { QB: 0.67, RB: 0.79, WR: 0.85, TE: 0.72 }, weeksStored: 1, weeksWithActuals: 0 },
      { grid, esc });
    ok(/literature/i.test(early), "before the fit the note says literature slopes");
    ok(!/undefined/.test(early), "an empty log renders without holes");
  }

  /* runProjections end to end, offline */
  {
    const lines = [];
    const say = (t, c) => { lines.push(String(t)); return {}; };
    const model = mkModel([5, 6]);
    for (const p of model.players.values())
      p.rawStats = [{ statSourceId: 0, statSplitTypeId: 1, seasonId: 2026, scoringPeriodId: 5, appliedTotal: 12 }];
    model.settings = { pprValue: 0.5, currentWeek: 5 };

    const sleeperPlayers = Object.fromEntries([101, 102, 103, 104, 201, 202].map((id, i) =>
      [`s${i}`, { player_id: `s${i}`, espn_id: id, full_name: `p${id}`, position: "RB" }]));
    const wk = (mult) => [101, 102, 103, 104, 201, 202].map((id, i) => ({
      player_id: `s${i}`, stats: { pts_ppr: 0, pts_half_ppr: [10, 20, 30, 40, 15, 25][i] * mult, pts_std: 0 } }));
    const table = {
      "https://api.sleeper.app/v1/players/nfl": sleeperPlayers,
      [(await import("../engine/sources/sleeperproj.js")).weekUrl(2026, 5)]: wk(1),
      [(await import("../engine/sources/sleeperproj.js")).weekUrl(2026, 6)]: wk(1),
    };
    const storage = mkStorage();
    const P = await runProjections({ model, ref: { leagueId: 7, seasonId: 2026 }, say,
      fetchImpl: mkFetch(table), storage, now: 0 });

    ok(P.aggregate === true, "the toggle defaults to on");
    ok(P.coverage.sleeper === 6, "coverage is reported");
    ok(P.band instanceof Map, "a band comes back");
    ok(P.k && typeof P.k.RB === "number", "a slope map comes back");
    ok(P.fitted === false, "one week of actuals is not enough to fit");
    ok(close(P.k.RB, 0.79) && close(P.k.QB, 0.67), "so the literature slopes are in use");
    ok(P.weeksStored === 1, "the current week was logged");
    ok(lines.some((l) => /Sleeper covers 6/.test(l)), `a coverage line is logged (${JSON.stringify(lines)})`);
    ok(lines.some((l) => /calibration log/.test(l)), "a calibration-log line is logged");
    ok(lines.some((l) => /FantasyPros/.test(l)), "FantasyPros is mentioned even when unavailable");

    const log = (await storage.get("ffsm.calib.7.2026"))["ffsm.calib.7.2026"];
    const row = log.weeks["5"].rows.find((r) => r.id === 101);
    ok(row.espn === 10, "the logged espn value is the pre-aggregate one");
    ok(Number.isFinite(row.agg), "the logged agg value is the post-aggregate one");
    ok(row.pos === "RB" && row.id === 101, "id and pos are logged");
    ok(row.fp === null, "an unavailable source logs null, not a guess");

    /* toggle off: no fetches, agg = espn */
    const model2 = mkModel([5, 6]);
    const f2 = mkFetch(table);
    await storage.set({ "ffsm.aggregate": false });
    const P2 = await runProjections({ model: model2, ref: { leagueId: 7, seasonId: 2026 }, say,
      fetchImpl: f2, storage, now: 0 });
    ok(P2.aggregate === false, "the stored toggle is honoured");
    ok(f2.calls.length === 0, "nothing is fetched when the toggle is off");
    ok(model2.players.get(101).proj[5] === 10, "espn-only leaves the projections alone");
    ok(P2.band.size === 0, "espn-only produces no band");

    /* every feed dead: still no throw, still espn */
    await storage.set({ "ffsm.aggregate": true });
    const model3 = mkModel([5, 6]);
    const P3 = await runProjections({ model: model3, ref: { leagueId: 9, seasonId: 2026 }, say,
      fetchImpl: mkFetch({}), storage: mkStorage(), now: 0 });
    ok(model3.players.get(101).proj[5] === 10, "a dead feed leaves agg = espn");
    ok(P3.k.RB === 0.79, "a dead feed still yields usable slopes");
    ok(P3.coverage.sleeper === 0 && P3.coverage.fp === 0, "coverage is zero, not undefined");
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node extension/test/projections.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `Cannot find module .../panel/projections.js`.

- [ ] **Step 3: Write the implementation**

Create `extension/panel/projections.js`:

```js
/**
 * Everything the projections feature does, so `panel.js` gains only hook points.
 *
 * `runProjections` fetches the outside sources, aggregates them into ESPN's scoring,
 * writes this week to the calibration log, joins whatever actuals have appeared
 * since, and hands back the slope map `shrinkProjections` should use. It never
 * throws: a dead feed is a log line and a degraded field, because the trade search
 * is the point and no projection source is worth losing it over.
 *
 * Order matters and is not negotiable: aggregate first, then shrink the aggregate.
 * The log's `espn` column is snapshotted before the aggregate mutates anything, or
 * the log would record the aggregate twice and the fit would measure nothing.
 */
import { loadSleeperPlayers } from "../engine/sources/sleeper.js";
import { loadSleeperProjections } from "../engine/sources/sleeperproj.js";
import { loadFantasyProsWeek } from "../engine/sources/fantasypros.js";
import { aggregateProjections } from "../engine/aggregate.js";
import { attachActuals, fitSlopes, loadLog, logWeek, mergeSlopes, summary, weeksStored,
         weeksWithActuals } from "../engine/calibration.js";
import { CALIBRATION_K } from "../engine/calibrate.js";

const AGG_KEY = "ffsm.aggregate";

const store = (opts) => opts.storage
  ?? ((typeof chrome !== "undefined" && chrome.storage?.local) ? chrome.storage.local : null);

/**
 * @param model  the loaded league; `p.proj` is mutated in place
 * @param ref    { leagueId, seasonId }
 * @param say    the panel's log function (text, cls)
 * @param progress  (frac) for the loading step
 * @returns { aggregate, band, coverage, k, fitted, fittedPositions, summaryRows,
 *            weeksStored, weeksWithActuals, remaining }
 */
export async function runProjections({ model, ref, say = () => {}, progress = () => {},
                                       ...opts } = {}) {
  const storage = store(opts);
  const fail = (msg) => say(msg, "err");
  const out = {
    aggregate: true, band: new Map(), coverage: { sleeper: 0, fp: 0 },
    k: { ...CALIBRATION_K }, fitted: false, fittedPositions: [], summaryRows: [],
    weeksStored: 0, weeksWithActuals: 0, remaining: [],
  };

  const currentWeek = Number(model.settings?.currentWeek ?? 1);
  const remaining = (model.weeks ?? []).filter((w) => w >= currentWeek);
  out.remaining = remaining.length ? remaining : [...(model.weeks ?? [])];

  // Pre-aggregate ESPN, for the log. Snapshotted before anything can mutate it.
  const espnAt = new Map();
  for (const p of model.players.values())
    if (p.proj?.[currentWeek] > 0) espnAt.set(p.id, p.proj[currentWeek]);

  if (storage) {
    try { out.aggregate = (await storage.get(AGG_KEY))[AGG_KEY] ?? true; } catch { /* default on */ }
  }

  let sleeperWeek = null, fpWeek = null;

  if (out.aggregate) {
    let bySleeper = null;
    try {
      bySleeper = (await loadSleeperPlayers({ ...opts, storage })).bySleeper;
    } catch (e) {
      fail(`projections: Sleeper crosswalk unavailable (${e.message ?? e})`);
    }

    const jobs = [];
    // `...opts` FIRST, then storage: spreading opts last would let an absent
    // opts.storage overwrite the chrome.storage.local fallback with undefined.
    jobs.push(bySleeper
      ? loadSleeperProjections({ ...opts, season: ref.seasonId, weeks: out.remaining,
          pprValue: model.settings?.pprValue ?? 0, bySleeper, storage,
          onProgress: (d, t) => progress(t ? d / t : 1) })
        .catch((e) => ({ byWeek: new Map(), covered: 0, failed: [...out.remaining], error: String(e.message ?? e) }))
      : Promise.resolve({ byWeek: new Map(), covered: 0, failed: [...out.remaining] }));
    jobs.push(loadFantasyProsWeek({ ...opts, week: currentWeek, storage })
      .catch((e) => ({ byEspn: new Map(), available: false, reason: String(e.message ?? e) })));

    const [sl, fp] = await Promise.all(jobs);
    sleeperWeek = sl.byWeek?.get(currentWeek) ?? null;
    fpWeek = fp.available ? fp.byEspn : null;

    const sources = [];
    if (sl.byWeek?.size) sources.push({ name: "sleeper", byWeek: sl.byWeek });
    if (fpWeek?.size) sources.push({ name: "fp", byWeek: new Map([[currentWeek, fpWeek]]) });

    if (sources.length) {
      const agg = aggregateProjections(model, sources, out.remaining);
      out.band = agg.band;
      out.coverage = { sleeper: agg.coverage.sleeper ?? 0, fp: agg.coverage.fp ?? 0 };
      say(`projections: Sleeper covers ${out.coverage.sleeper} of ${model.players.size} players, `
        + `FantasyPros ${out.coverage.fp} (week ${currentWeek})`, "ok");
      if (sl.failed?.length) say(`  ${sl.failed.length} Sleeper week(s) unavailable`, "");
      if (!fp.available) say(`  FantasyPros unavailable (${fp.reason || "no data"})`, "");
    } else {
      say(`projections: no outside source available (Sleeper 0, FantasyPros 0) — `
        + `using ESPN alone`, "err");
      if (!fp.available && fp.reason) say(`  FantasyPros: ${fp.reason}`, "");
    }
  } else {
    say("projections: ESPN only (aggregate off)", "");
  }

  /* ---- the calibration log ---- */
  if (storage) {
    try {
      const rows = [];
      for (const [id, espn] of espnAt) {
        const p = model.players.get(id);
        rows.push({
          id, pos: p?.pos ?? "?", espn,
          sleeper: sleeperWeek?.get(id) ?? null,
          fp: fpWeek?.get(id) ?? null,
          agg: p?.proj?.[currentWeek] ?? espn,
        });
      }
      await logWeek({ storage, leagueId: ref.leagueId, seasonId: ref.seasonId,
        week: currentWeek, rows, now: opts.now ?? Date.now() });

      const log = await loadLog({ storage, leagueId: ref.leagueId, seasonId: ref.seasonId });
      attachActuals(log, model.players, ref.seasonId);
      out.weeksStored = weeksStored(log);
      out.weeksWithActuals = weeksWithActuals(log);
      out.summaryRows = summaryOf(log);

      const merged = mergeSlopes(fitSlopes(log));
      out.k = merged.k;
      out.fitted = merged.fitted;
      out.fittedPositions = merged.positions;

      say(`calibration log: ${out.weeksStored} week${out.weeksStored === 1 ? "" : "s"} stored, `
        + `${out.weeksWithActuals} with actuals`, "ok");
      if (out.fitted)
        say(`  slopes fitted from this league: ${out.fittedPositions
          .map((p) => `${p} ${out.k[p]}`).join(", ")}`, "ok");
    } catch (e) {
      fail(`calibration log unavailable (${e.message ?? e})`);
    }
  }

  return out;
}

// A summary is a nicety; failing to build one must not lose the log write above it.
function summaryOf(log) {
  try { return summary(log); } catch { return []; }
}

/* ---------- band display ---------- */

/**
 * Mean disagreement across the remaining weeks, in points. A plain mean: weeks with
 * no measurable disagreement count as zero, so this under-reports rather than over-
 * reports. It is a hint, not a statistic.
 */
export function bandMean(band, id) {
  const arr = band?.get?.(id);
  if (!arr || !arr.length) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += Number.isFinite(arr[i]) ? arr[i] : 0;
  return sum / arr.length;
}

/** ` ±N.N` when the sources disagree enough to be worth a manager's attention. */
export function bandTag(band, id, threshold = 0.5) {
  const m = bandMean(band, id);
  return m > threshold ? ` ±${m.toFixed(1)}` : "";
}

/* ---------- chips ---------- */

export const SOURCES_HINT = "Averaging projection sources beats any single source. "
  + "On, ESPN&#39;s numbers are averaged with Sleeper/RotoWire and FantasyPros ECR — "
  + "not as raw points, which are scored under different rules, but as each source&#39;s "
  + "fraction of its own positional mean, converted back into this league&#39;s scoring.";

export function sourcesChips({ aggregate = true } = {}) {
  return `<div class="fld"><label data-hint="${SOURCES_HINT}"><span class="hint">Sources</span></label>
    <div class="chips" id="sources">
      <button data-v="1" aria-pressed="${aggregate !== false}">Aggregate</button>
      <button data-v="0" aria-pressed="${aggregate === false}">ESPN only</button>
    </div></div>`;
}

/** Reload on change: projections feed everything, so a rebuild is the honest path. */
export function bindSourcesChips(root, { storage, reload } = {}) {
  root.querySelectorAll("#sources button").forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.v === "1";
      if (on === (window.__aggregate !== false)) return;
      try { await (storage ?? chrome.storage.local).set({ [AGG_KEY]: on }); } catch { /* ignore */ }
      (reload ?? (() => location.reload()))();
    };
  });
}

/* ---------- the Calibration section ---------- */

const SRC_LABEL = { espn: "ESPN", sleeper: "Sleeper", fp: "FantasyPros", agg: "Aggregate" };
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "—");
const n2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
const n3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : "—");

/**
 * @param grid  panel.js's `grid()` — passed in so the sort machinery stays there
 * @param esc   panel.js's `esc()`
 */
export function calibrationSection(state, { grid, esc }) {
  const rows = state.summaryRows ?? [];
  const stored = state.weeksStored ?? 0;
  const withActuals = state.weeksWithActuals ?? 0;
  const k = state.k ?? CALIBRATION_K;
  const fitted = state.fitted === true;
  const positions = state.fittedPositions ?? [];

  const table = grid("calibGrid", [
    { key: "source", label: "Source", value: (r) => SRC_LABEL[r.source] ?? r.source },
    { key: "pos", label: "Pos", value: (r) => r.pos },
    { key: "n", label: "n", num: true, value: (r) => r.n },
    { key: "mae", label: "MAE", num: true, value: (r) => r.mae,
      hint: "Mean absolute error, in points: how far this source lands from the truth in a typical week." },
    { key: "bias", label: "Bias", num: true, value: (r) => r.bias,
      hint: "Mean signed error. Positive means the source projects low." },
    { key: "slope", label: "Slope", num: true, value: (r) => (Number.isFinite(r.slope) ? r.slope : -1),
      hint: "OLS slope of actual on projected. Below one means the source is over-spread — the gap between its #1 and #5 is bigger on paper than in reality." },
  ], rows, {
    sort: "mae", dir: 1,
    empty: `<div class="empty"><b>Nothing measured yet</b>The log has ${stored} week${
      stored === 1 ? "" : "s"} and needs a played week to compare against.</div>`,
    row: (r) => `<tr>
      <td style="font-weight:600">${esc(SRC_LABEL[r.source] ?? r.source)}</td>
      <td><span class="pos" data-p="${esc(r.pos)}">${esc(r.pos)}</span></td>
      <td class="num" style="color:var(--faint)">${r.n}</td>
      <td class="num">${n2(r.mae)}</td>
      <td class="num">${n2(r.bias)}</td>
      <td class="num">${n3(r.slope)}</td>
    </tr>`,
  });

  const inUse = ["QB", "RB", "WR", "TE"].map((p) => `${p} ${n2(k[p])}`).join(", ");
  const note = fitted
    ? `<b>Fitted slopes are in use</b> for ${positions.join(", ")} — measured from this
       league's own ${withActuals} played week${withActuals === 1 ? "" : "s"} rather than
       borrowed. In use now: ${inUse}. The literature figures, measured across twelve
       seasons of other people's leagues, are QB 0.67, RB 0.79, WR 0.85, TE 0.72.`
    : `<b>Literature slopes are in use</b>: ${inUse}, measured across twelve seasons of
       other people's leagues. This league's own slopes replace them once six weeks
       carry actuals — ${withActuals} so far. Scoring rules move the slope, so the
       measured number is the one worth having.`;

  return `<section>
    <h2 class="secttl">Calibration</h2>
    <p class="sectsub">How wrong each source has been in this league, and by how much
      it over-spreads. ${stored} week${stored === 1 ? "" : "s"} logged,
      ${withActuals} with actuals. Nothing here leaves your machine.</p>
    <div class="panel">
      ${table}
      <div class="note">${note}</div>
    </div>
  </section>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node extension/test/run-all.mjs`
Expected: 0 failures. Also run `node --check extension/panel/projections.js`.

If the `sectsub` class does not exist in `panel.css`, check what the other sections use (`grep -n 'class="sectsub"\|secttl' extension/panel.js`) and match the existing markup rather than inventing a class. Report which class you used.

- [ ] **Step 5: Commit**

```bash
git add extension/panel/projections.js extension/test/projections.mjs
git commit -m "$(cat <<'EOF'
Add the panel module for projection sources and calibration

All orchestration and all HTML live here so panel.js gains only hook
points. Aggregate runs before shrinkage, and the log's espn column is
snapshotted before the aggregate mutates anything — otherwise the log
records the aggregate twice and the fit measures nothing. Nothing throws:
a dead feed is a log line and a degraded field.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
EOF
)"
```

---

### Task 7: Wire it into `panel.js`

**Files:**
- Modify: `extension/panel.js` (one import, one `PHASES` entry, one `start()` block, four `render()` hunks, one `KEEP` entry)

**Interfaces:**
- Consumes: everything Task 6 produces.
- Produces: nothing new. This task only wires.

**Do not exceed these hunks.** Rule 1 of the parallel-phase rules exists so the three phases merge mechanically. If a change seems to need a bigger edit, stop and report.

- [ ] **Step 1: Add the import**

After the existing `calibrate.js` import (line 14):

```js
import { bandMean, bandTag, bindSourcesChips, calibrationSection, runProjections,
         sourcesChips } from "./panel/projections.js";
```

- [ ] **Step 2: Add the loading phase**

In `PHASES`, insert one entry after `["agents", "Free-agent pool"]` — free agents join `model.players` before the aggregate, so they must be aggregated too:

```js
  ["proj",     "Projection sources"],
```

- [ ] **Step 3: Replace the calibration block in `start()`**

Replace the existing block (currently lines ~285–294, from the comment `// Calibrate before anything reads a projection.` through the closing brace of the `else`) with:

```js
    // Projection sources, then calibration. Aggregate first and shrink the aggregate:
    // shrinkage is a property of the number the engine is about to use, and the
    // calibration log has to record what was shown before the week to measure anything.
    Steps.set("proj", "run");
    const P = await runProjections({ model, ref, say, progress });
    window.__band = P.band;
    window.__aggregate = P.aggregate;
    window.__calibState = P;
    Steps.set("proj", P.aggregate ? "done" : "skip",
      P.aggregate ? `Sleeper ${P.coverage.sleeper}, FP ${P.coverage.fp}` : "ESPN only");

    // Calibrate before anything reads a projection. Off leaves ESPN's numbers as-is.
    const calibrate = (await chrome.storage.local.get("ffsm.calibrate"))["ffsm.calibrate"] ?? true;
    window.__calibrate = calibrate;
    if (calibrate) {
      const r = shrinkProjections(model.players, model.weeks, P.k);
      say(`projections calibrated for ${r.changed} players (${Object.entries(P.k)
        .map(([p, k]) => `${p} ${k}`).join(", ")}) — ${P.fitted
        ? "slopes fitted from this league's calibration log" : "literature slopes"}`, "ok");
    } else {
      say("projections used as ESPN publishes them (calibration off)", "");
    }
```

- [ ] **Step 4: Add the `±` column to the roster grid**

In `render()`, in the `rosterGrid` column list, insert after the `avg` column:

```js
    { key: "band", label: "±", num: true, value: (r) => bandMeanOf(r.p.id), hint: HINT.band },
```

and in the same grid's `row`, insert a cell after the `r.avg.toFixed(1)` cell:

```js
      <td class="num" style="color:var(--faint)">${
        bandMeanOf(r.p.id) > 0.05 ? bandMeanOf(r.p.id).toFixed(1) : "—"}</td>
```

Define `bandMeanOf` once near the top of `render()`, beside `avgProj` (`bandMean` is
already in the Step 1 import line):

```js
  const bandMeanOf = (id) => bandMean(window.__band, id);
```

Add one entry to the `HINT` map beside `calib`:

```js
  band:   "How much the projection sources disagree about this player, in points per week, averaged over the weeks left. A wide band means the number above it is less settled than it looks — not that the player is volatile.",
```

- [ ] **Step 5: Annotate acquired players in the trade detail**

In `detailFor`, in the `d.acquired` loop, change the acquired `<li>` so the name carries its band:

```js
      for (const a of d.acquired)
        li.push(`<li><b>${esc(nm(a.i))}</b>${esc(bandTag(window.__band, eng.ids[a.i]))} would start
                 <b>${a.startsHere}</b> of ${W.length} weeks here, versus ${a.startsThere}
                 where he is now.</li>`);
```

`bandTag` returns plain text and `esc` is applied, so nothing can inject markup. Note `eng.ids[a.i]` — the band is keyed on the ESPN player id, and `a.i` is an engine index.

- [ ] **Step 6: Add the Sources chips and the Calibration section**

In the Projected season panel's `.bar`, immediately after the `#calib` chip group's closing `</div></div>`:

```js
          ${sourcesChips({ aggregate: window.__aggregate })}
```

After the closing `</section>` of the Projected season section and before `<footer>`:

```js
    ${calibrationSection(window.__calibState ?? {}, { grid, esc })}
```

- [ ] **Step 7: Bind the chips and keep the toggle across a refresh**

Immediately after the existing `#calib` button handler block:

```js
  bindSourcesChips(app);
```

and add `"ffsm.aggregate"` to the `KEEP` array in the `#refresh` handler:

```js
    const KEEP = ["ffsm.myTeam", "ffsm.objective", "ffsm.calibrate", "ffsm.divSeed", "ffsm.aggregate"];
```

- [ ] **Step 8: Verify**

Run, and paste the output into the task report:

```bash
node extension/test/run-all.mjs
node --check extension/panel.js
node --check extension/panel/projections.js
git diff --stat extension/panel.js
```

Expected: 0 failures; both `--check` silent; `panel.js` shows roughly 30–40 changed lines across the seven hunks above and nothing else.

Then confirm the hunk discipline explicitly:

```bash
git diff -U0 extension/panel.js | grep -c '^@@'
```

Expected: 8 or fewer hunks. If it is more, consolidate.

- [ ] **Step 9: Commit**

```bash
git add extension/panel.js
git commit -m "$(cat <<'EOF'
Show the aggregate, the disagreement band and the calibration log

panel.js gains only its hook points: one import, one loading phase, one
block in start(), the ± column, a band on acquired players, the Sources
chips and the Calibration section. Both toggles survive a refresh.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
EOF
)"
```

- [ ] **Step 10: Write the browser-verification checklist into the task report**

This environment has no browser. The report must end with, unchecked:

```
Browser verification pending:
- [ ] Load unpacked, open a real league: the "Projection sources" step runs, shows progress, and reports Sleeper/FP coverage.
- [ ] The coverage log line names a plausible number of players (hundreds, not zero and not 6).
- [ ] The Sleeper projections URL returns rows — confirm the endpoint has no /v1 and that `stats.pts_half_ppr` exists.
- [ ] FantasyPros: confirm `fp_latest_weekly.csv` really has `r2p_pts` and which id column it uses; if the source reports unavailable, the reason line says which.
- [ ] The ± column shows plausible values (roughly 0.5–4 pts) and "—" for uncovered players.
- [ ] Toggling Sources to "ESPN only" reloads, fetches nothing, and blanks the ± column.
- [ ] The toggle survives "Refresh data".
- [ ] The Calibration section renders; in week 1 it says literature slopes and shows an empty grid with the "Nothing measured yet" message.
- [ ] After six played weeks (or with a hand-seeded log) it switches to fitted slopes and the start() log line says so.
- [ ] No console errors, and a network panel showing no request carrying a league id, team name or player name.
```

---

### Task 8: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none.

- [ ] **Step 1: Extend the architecture map**

In the `## Architecture` code block, add the new files. The `engine/` list gains three entries and a `sources/` sub-list, and a `panel/` entry appears:

```
extension/
  manifest.json      MV3
  background.js      opens the page; nothing else lives here
  panel.html/.js     the UI
  panel.css          the analytics-terminal look
  panel/
    projections.js   source orchestration, the ± band, the Calibration section
  engine/
    league.js        ESPN API -> normalized model; settings; volatility
    lineup.js        optimal lineup for any slot configuration
    swaps.js         precomputed (out, in) values
    search.js        shapes, N-sided trades, three-way, free agents
    season.js        Monte Carlo season projection
    calibrate.js     shrink projections toward the positional mean
    aggregate.js     average outside sources into ESPN's scoring
    calibration.js   the per-league projection-error log and its fitted slopes
    sources/
      cache.js       cached fetch for every non-ESPN feed
      csv.js         CSV reader (quoted fields)
      sleeper.js     player crosswalk, injuries, trending
      sleeperproj.js Sleeper/RotoWire weekly projections
      fantasypros.js FantasyPros ECR via DynastyProcess
  test/parity.mjs    the engine contract, against a frozen league
  test/sources.mjs   the source layer, offline
  test/projections.mjs  aggregate, calibration log and the panel module, offline
```

Adjust to match whatever the file actually says at the time — other phases may have
added lines. Do not delete another phase's entries. Also update the `## Commands`
block if it still names `parity.mjs` alone:

```bash
node extension/test/run-all.mjs   # the whole test suite, ~3s
```

- [ ] **Step 2: Add the two load-bearing notes**

In `## Load-bearing decisions`, after the "Volatility is measured, not assumed" note:

```markdown
**Raw external points are never averaged with ESPN's.** ESPN's projections are scored
under *this league's* rules — its reception value, its bonuses, its defensive scoring.
Sleeper's `pts_half_ppr` and FantasyPros' `r2p_pts` are scored under theirs. Averaging
them as points would silently re-score the league by whatever the rule sets disagree
about. So `aggregate.js` converts each source to a dimensionless fraction of its own
positional mean for that week, averages the fractions, and multiplies back by *ESPN's*
positional mean. Only the shape of a source's opinion crosses over; the unit stays
ESPN's. A source published at twice the scale is therefore the same source, and that
invariant is what makes the average legitimate — it is worth a test if you touch this.
A source covering only part of a position is compared against ESPN on the shared set,
so covering a skewed subset cannot shift that subset's level.

**Aggregate before shrinkage, and log what was shown.** `aggregateProjections` runs
before `shrinkProjections` in `start()`: shrinkage is a property of the number the
engine is about to use, so it must be applied to the aggregate, not to ESPN's raw
number before averaging. The calibration log's `espn` column is snapshotted *before*
the aggregate mutates `p.proj` — otherwise the log records the aggregate twice and the
fitted slope measures nothing.

**The calibration log is the only league-specific model, and it lives in
`chrome.storage.local`.** `CALIBRATION_K` is a literature constant from other people's
leagues; the slope of actual on projected depends on the scoring rules, so this league
has its own. Only something running here each week can measure it — it needs the
projection as it stood before the week alongside the points actually awarded. Each run
writes one row per player to `ffsm.calib.{leagueId}.{seasonId}`; each later run joins
ESPN's own actuals (`statSourceId: 0`, matched on `seasonId`) and refits. Six weeks of
actuals and twenty pairs per position before a fitted slope is trusted, clamped to
[0.3, 1.2]. It is never sent anywhere, and there is nowhere to send it.
```

- [ ] **Step 3: Verify the file still describes reality**

Run: `grep -n "run-all\|aggregate.js\|calibration.js\|sleeperproj" CLAUDE.md`
Expected: every new file named above appears. Then re-read the `## Privacy` section and confirm it is still true — it is, because every new request carries only a season and a week.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Record why external points are normalized, not averaged

Three notes: the positional-fraction normalization and why raw points
from a differently-scored source can never be averaged with ESPN's; the
aggregate-then-shrink order and the pre-aggregate snapshot the log needs;
and that the calibration log is the only league-specific model, living in
chrome.storage and going nowhere.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiMy4csohi7nmgPZBA5bAU
EOF
)"
```

---

## Final verification

- [ ] `node extension/test/run-all.mjs` — three files, 0 failing; `parity.mjs` prints `605 assertions, 0 failures` and is unmodified (`git diff main -- extension/test/parity.mjs` is empty).
- [ ] `node --check extension/panel.js` and `node --check extension/panel/projections.js` — silent.
- [ ] `git diff --stat main -- extension/engine/search.js extension/engine/season.js` — empty. Rule 6.
- [ ] `grep -rn "chrome.storage" extension/engine/` — no hits; the engine takes `{storage}`, it never reaches for the global.
- [ ] `grep -n "host_permissions\|permissions" extension/manifest.json` — unchanged; every new host is CORS-open.
- [ ] No new request carries a league id, team name or player name — `grep -n "leagueId" extension/engine/sources/*.js` returns nothing.
