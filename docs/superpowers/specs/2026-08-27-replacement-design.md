# Phase 4 — Roster construction: replacement level, 2-for-1, drop ranking

Status: approved for build (Josh, 2026-08-27). Covers brainstorm F1 and F4 (and the
2026-08-26 trade-strategies spec's Features 4–5, updated for the JS engine).
Follow `2026-08-27-parallel-phase-rules.md` (wave 2 ownership: this phase owns `search.js`).

## Why

Starting-lineup slots are the scarce resource. A 2-for-1 that consolidates two
starters into one better starter *and* frees a roster spot for the best free agent is
the most common winning trade in real leagues, and every other tool grades it with a
20% haircut. We can grade it exactly: the side sending two backfills from waivers; the
side receiving two drops its least valuable player. Both are lineup solves.

## Engine — `search.js` (owner) and `extension/engine/roster.js`

**Candidate pool.** `Engine.backfillPool()` — for each position label, the top 3 free
agents by mean projection over remaining weeks, union across labels, legal-slot only;
cached. This bounds backfill to ≈15–20 candidates. Document plainly in code and
CLAUDE.md: *backfill is exact within this pool*; the pool is the one approximation
and it is of the waiver step, not of the trade search.

**`Engine.backfill(ids)`** → `{ids: ids+fa, fa}`: the pool member whose addition
maximises `weekly` mean over remaining weeks (legal). **`Engine.trim(ids)`** →
`{ids: ids−drop, drop}`: the rostered player whose removal costs least (legal).
Both use `weekly` so availability (Phase 2) is honoured.

**Shape `2-for-1`.** `findTwoForOne(minGain, onProgress)`: for each ordered pair
(A→B): A sends every 2-combination, B sends every single; A's post roster =
`backfill(swap(A, two, [one]))`, B's = `trim(swap(B, [one], two))`. Score with
`sideMetrics` on the *final* rosters; the side objects carry `backfill: fa` and
`drop: i`. Legality via `legal()`. Async with macrotask yields like the others.
Measure the runtime on the fixture in the plan and choose the yield cadence.

**Drop ranking.** `Engine.dropCandidates(team)` → for each rostered player:
`cost = baseline − weekly(without)` averaged over remaining weeks, `reg`, `playoff`;
`bestAdd` = `backfill(without).fa` and its gain. Sorted ascending by cost.

## UI — `extension/panel/roster.js`

- Shape chip **2-for-1** in the existing group (default on).
- Trade grid rows for 2-for-1 show `+ <FA> (waivers)` under the receiving package of
  the consolidating side and `drop <player>` under the other; hint explains both.
- Trade detail: the backfill/drop named with their start counts.
- New section **Drop candidates** (my team) below the roster grid: player, cost/wk,
  reg, playoffs, best add if dropped, gain.
- Loading step "2-for-1 trades" with progress; log line with count and time.

## Tests — `extension/test/roster.mjs`

Fixture model as in `parity.mjs` (copy construction; include free agents by
treating players unrostered in `F.rosters` as FAs, if any; otherwise synthesise 20
FAs by cloning low-value players with new ids).
- `backfillPool` size ≤ 3 × positions, all legal-slot.
- `backfill` never returns an illegal roster; picks the FA with the highest mean gain (brute-force check against the whole pool).
- `trim` removes the least costly player (brute-force check).
- `findTwoForOne`: every reported side has `gain ≥ minGain`; the consolidating side's roster size equals its original; the other side's too; a hand-built 2-for-1 with a known good outcome appears.
- `dropCandidates` sorted ascending; a never-starting player has cost 0.
- Parity: `parity.mjs` unchanged and green.
