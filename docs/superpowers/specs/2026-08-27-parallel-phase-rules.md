# Rules for phases built in parallel worktrees

Phases 2, 3 and 5 are built at the same time on separate branches from `main`
(at or after `26eab0d`) and merged afterwards. To keep the merges mechanical:

1. **Logic lives in new files.** Engine code in `extension/engine/<name>.js` or
   `extension/engine/sources/<feed>.js`; panel code in `extension/panel/<name>.js`
   exporting functions `panel.js` calls. `panel.js` edits are limited to: one import
   line, entries in `PHASES`, one block in `start()`, one call site in `render()` per
   new section/column. Keep each edit to the smallest hunk that works.
2. **Tests go in a new file** `extension/test/<name>.mjs` using the `ok()` pattern
   from `sources.mjs`. Do not append to `parity.mjs`; it is the engine contract and
   must stay green untouched. Run `node extension/test/run-all.mjs` before every commit.
3. **Use the shared source layer.** `engine/sources/cache.js` (`cached()`) and
   `engine/sources/sleeper.js` already exist; add new feeds beside them with the same
   `{fetchImpl, storage, now}` injection so tests run offline. No host permissions are
   needed for CORS-open hosts (Sleeper, FantasyCalc, raw.githubusercontent.com).
4. **Every feature degrades.** A dead feed logs one line via `say()` and the feature
   shows `—`; nothing throws out of `start()`.
5. **Settings are read, not derived.** `readSettings` now exposes `pprValue` and
   `currentWeek`; add fields there rather than re-parsing raw settings elsewhere.
6. **`search.js` and `season.js` are Phase 2's to change** (availability enters the
   lineup solve). Phases 3 and 5 must not modify them.
7. **Commit trailers** as in the repo's recent history.
