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
import { attachActuals, fitSlopes, loadLog, logKey, logWeek, mergeSlopes, summary,
         weeksStored, weeksWithActuals } from "../engine/calibration.js";
import { CALIBRATION_K } from "../engine/calibrate.js";

const AGG_KEY = "ffsm.aggregate";

const store = (opts) => opts.storage
  ?? ((typeof chrome !== "undefined" && chrome.storage?.local) ? chrome.storage.local : null);

/**
 * @param model  the loaded league; `p.proj` is mutated in place
 * @param ref    { platform, leagueId, seasonId }
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
  //
  // Rostered players only (`teamId != null`; `loadFreeAgents` sets it to null). The
  // free-agent pool is merged into `model.players` before this runs and outnumbers
  // rostered players about 2.5 to 1, so a pooled log would be mostly deep-bench
  // adds projected 2-5 points that score 0 because they were inactive. Their slope
  // is genuinely different, and it is the top of each position that drives trades,
  // so the fitted slope has to come from the players who are actually started.
  // This is the LOG only — the aggregate below still covers everyone, because free
  // agents are traded for and waiver-added and their aggregated number is the point.
  const espnAt = new Map();
  for (const p of model.players.values())
    if (p.teamId != null && p.proj?.[currentWeek] > 0) espnAt.set(p.id, p.proj[currentWeek]);

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
      // The heaviest call on this path, and the one that mutates `p.proj` in
      // place: wrapped like every other fallible call here, so a failure degrades
      // to agg === espn and one log line instead of throwing out of `start()`.
      try {
        const agg = aggregateProjections(model, sources, out.remaining);
        out.band = agg.band;
        out.coverage = { sleeper: agg.coverage.sleeper ?? 0, fp: agg.coverage.fp ?? 0 };
        say(`projections: Sleeper covers ${out.coverage.sleeper} of ${model.players.size} players, `
          + `FantasyPros ${out.coverage.fp} (week ${currentWeek})`, "ok");
        if (sl.failed?.length) say(`  ${sl.failed.length} Sleeper week(s) unavailable`, "");
        if (!fp.available) say(`  FantasyPros unavailable (${fp.reason || "no data"})`, "");
      } catch (e) {
        fail(`projections: aggregate failed (${e.message ?? e}) — using ESPN alone`);
      }
    } else {
      say(`projections: no outside source available (Sleeper 0, FantasyPros 0) — `
        + `using ESPN alone`, "err");
      if (!fp.available && fp.reason) say(`  FantasyPros: ${fp.reason}`, "");
    }
  } else {
    say("projections: ESPN only (aggregate off)", "");
  }

  /* ---- the calibration log ----
     Written every run, aggregate toggle on or off: with the toggle off (or every
     source dead) `agg` is simply `espn` again, and that is deliberate — the log
     records what was actually fed to the engine, not what would have been fed
     under some other setting, so a single league's log can mix ESPN-only and
     aggregated rows across sessions and still be exactly what should be
     calibrated. */
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
      await logWeek({ storage, platform: ref.platform, leagueId: ref.leagueId, seasonId: ref.seasonId,
        week: currentWeek, rows, now: opts.now ?? Date.now() });

      const log = await loadLog({ storage, platform: ref.platform, leagueId: ref.leagueId, seasonId: ref.seasonId });
      // Write the joined actuals back. A player's `history` only carries a week for
      // as long as the platform does; an actual visible this session and gone the
      // next is lost for good unless it is persisted the moment it is seen.
      const { filled } = attachActuals(log, model.players, ref.seasonId);
      if (filled) await storage.set({ [logKey(ref.platform, ref.leagueId, ref.seasonId)]: log });
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

// Hand-escaped on purpose, and deliberately not routed through `esc` like every
// other hint here: it is a module constant with no feed data in it, and `esc` would
// double-escape the `&#39;` entities into visible `&amp;#39;`.
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
      // Guard on the chip's OWN rendered state, not a global: `sourcesChips`
      // already rendered `aria-pressed` from the real toggle, so re-reading it
      // here needs nothing else to have been set first.
      if (b.getAttribute("aria-pressed") === "true") return;
      try { await (storage ?? chrome.storage.local).set({ [AGG_KEY]: on }); } catch { /* ignore */ }
      (reload ?? (() => location.reload()))();
    };
  });
}

/* ---------- the Calibration section ---------- */

const SRC_LABEL = { espn: "ESPN", sleeper: "Sleeper", fp: "FantasyPros", agg: "Aggregate" };
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
