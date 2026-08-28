/**
 * Loads the league the user is looking at, runs the search, renders the report.
 *
 * Everything runs locally: no backend, no analytics, no league data leaves the
 * machine. The only network calls are to ESPN's own read API, with the session the
 * browser already has.
 */
import { parseLeagueUrl, loadLeague, loadFreeAgents, loadSchedule, measureVolatility,
         mySwid, identifyTeam, SLOT_LABEL } from "./engine/league.js";
import { buildSlots, seatMask } from "./engine/lineup.js";
import { Engine, dedupe } from "./engine/search.js";
import { projectSeason } from "./engine/season.js";
import { attachOdds, significant } from "./engine/odds.js";
import { marketOrNull, marketView, marketFair, marketFairChip, marketCol, marketCell,
         marketDetail, marketPitchLine, arbitrageSection } from "./panel/market.js";
import { restrictToRemaining, buildAvailability } from "./engine/availability.js";
import { loadSleeperPlayers } from "./engine/sources/sleeper.js";
import { AVAIL_HINT, statusRank, statusCell, statusBadge, seasonNote,
         availabilityLines, horizonLine } from "./panel/availability.js";
import { shrinkProjections } from "./engine/calibrate.js";
import { bandMean, bandTag, bindSourcesChips, calibrationSection, runProjections,
         sourcesChips } from "./panel/projections.js";
import { environmentStep, envColumn, envCell, envChips, bindEnvChips, streamingSection }
  from "./panel/environment.js";
import { ROSTER_HINT, moveNote, moveLines, dropSection } from "./panel/roster.js";
import { usageOrNull, usageViewStored, assetsSection, breakoutSection,
         waiverView, faCrowdCols, faCrowdCells } from "./panel/usage.js";
import { buildDistribution, attachCovariance, playerRange } from "./engine/distribution.js";
import { gameplan } from "./engine/gameplan.js";
import { DIST_HINT, weekSection, stackLine, stackNote } from "./panel/distributions.js";

const $ = (s) => document.querySelector(s);

/* ============ loading ============
   A checklist beats a scrolling log: it shows what is left, not just what happened.
   The log survives underneath for anything that goes wrong. */
const PHASES = [
  ["settings", "League settings"],
  ["rosters",  "Rosters and projections"],
  ["agents",   "Free-agent pool"],
  ["injuries", "Injury reports"],
  ["proj",     "Projection sources"],
  ["env",      "Game environment"],
  ["schedule", "Schedule"],
  ["vol",      "Player volatility"],
  ["market",   "Market values"],
  ["usage",    "Usage and trends"],
  ["s1",       "1-for-1 trades"],
  ["s21",      "2-for-1 trades"],
  ["s2",       "2-for-2 trades"],
  ["s3",       "Three-team trades"],
  ["win",      "Win probability"],
  ["odds",     "Season odds per trade"],
  ["build",    "Building the report"],
];

const Steps = {
  started: 0,
  init() {
    this.started = Date.now();
    $("#steps").innerHTML = PHASES.map(([k, label]) =>
      `<li data-k="${k}" data-s="wait"><span class="ic"></span>
        <span>${label}</span><span class="note"></span></li>`).join("");
    clearInterval(this._t);
    this._t = setInterval(() => {
      const s = Math.round((Date.now() - this.started) / 1000);
      $("#bootclock").textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }, 500);
  },
  set(key, state, note) {
    const li = $(`#steps li[data-k="${key}"]`);
    if (!li) return;
    li.dataset.s = state;
    if (note != null) li.querySelector(".note").textContent = note;
    if (state === "run") $("#bootnow").textContent = li.children[1].textContent;
    const done = [...document.querySelectorAll("#steps li")]
      .filter((x) => x.dataset.s === "done" || x.dataset.s === "skip").length;
    $("#bootbar").style.width = `${(done / PHASES.length * 100).toFixed(0)}%`;
  },
  stop() { clearInterval(this._t); },
};

const say = (text, cls = "") => {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  $("#log").appendChild(d);
  $("#log").scrollTop = $("#log").scrollHeight;
  return d;
};
const progress = (frac) => {
  const li = $('#steps li[data-s="run"]');
  if (li) li.querySelector(".note").textContent = `${Math.round(frac * 100)}%`;
};

function theme(next) {
  document.documentElement.dataset.theme = next;
  const b = document.getElementById("theme");
  if (b) b.textContent = next === "light" ? "Dark" : "Light";
  try { localStorage.setItem("ffsm-theme", next); } catch { /* private mode */ }
}

/* Clipboard: an extension page is a secure context, but keep the execCommand path
   so a failure is visible rather than silent. */
function copy(text, btn) {
  const done = (okd) => {
    btn.textContent = okd ? "Copied" : "Press \u2318C";
    btn.classList.toggle("done", okd);
    setTimeout(() => { btn.textContent = "Copy pitch"; btn.classList.remove("done"); }, 1900);
  };
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let okd = false;
    try { okd = document.execCommand("copy"); } catch { /* blocked */ }
    ta.remove();
    done(okd);
  };
  if (navigator.clipboard?.writeText)
    navigator.clipboard.writeText(text).then(() => done(true), fallback);
  else fallback();
}

/* ============ sortable grid ============
   Every table on the page runs through this: it owns header rendering, the sort
   indicator, aria-sort, and a stable numeric-aware comparison. Sort state is kept
   per grid id so a re-render (changing team, toggling a filter) does not silently
   reset the column the user chose. */
const SORT = new Map();

function grid(id, cols, rows, opts = {}) {
  const st = SORT.get(id) ?? { key: opts.sort, dir: opts.dir ?? -1 };
  SORT.set(id, st);

  const head = cols.map((c, i) => {
    const sortable = c.sortable !== false && c.value;
    const aria = st.key === c.key ? (st.dir > 0 ? "ascending" : "descending") : null;
    return `<th class="${c.num ? "num " : ""}${sortable ? "s" : ""}"
      ${c.hint ? `data-hint="${esc(c.hint)}"` : ""}
      ${aria ? `aria-sort="${aria}"` : ""}
      ${sortable ? `data-sort="${c.key}" tabindex="0" role="columnheader"` : ""}
      >${c.head ?? `<span class="hint">${esc(c.label ?? "")}</span>`}</th>`;
  }).join("");

  const data = rows.map((r, i) => [r, i]);
  const col = cols.find((c) => c.key === st.key);
  if (col?.value) {
    data.sort(([a, ia], [b, ib]) => {
      const va = col.value(a), vb = col.value(b);
      const d = col.num ? (va - vb)
        : String(va).localeCompare(String(vb), undefined, { sensitivity: "base" });
      return d ? d * st.dir : ia - ib;          // stable
    });
  }

  const body = data.length
    ? data.map(([r], i) => opts.row(r, i)).join("")
    : `<tr><td colspan="${cols.length}">${opts.empty
        ?? '<div class="empty"><b>Nothing here</b>Try widening the filters.</div>'}</td></tr>`;

  return `<div class="scroll"><table id="${id}">
    <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Wire click-to-sort after the grid HTML is in the document. */
function bindSort(root, onChange) {
  root.querySelectorAll("th[data-sort]").forEach((th) => {
    const table = th.closest("table");
    const go = () => {
      const st = SORT.get(table.id);
      const num = th.classList.contains("num");
      st.dir = st.key === th.dataset.sort ? -st.dir : (num ? -1 : 1);
      st.key = th.dataset.sort;
      onChange();
    };
    th.onclick = go;
    th.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    };
  });
}

const CACHE_HOURS = 12;

/* Per-trade season odds run two 2500-sim worlds per trade. Capped at 100 so the
   loading screen stays around five seconds (measured ~125 ms per trade at 5000
   sims in the test suite). */
const ODDS_CAP = 100;
const ODDS_SIMS = 2500;
/* Odds run in two passes. At 2500 sims the paired title delta often sits inside its
   own standard error - roughly one trade in fifteen clears it on a live league, 5 of
   11 on the test fixture - so the top few are re-simulated at 20,000 sims (~210 ms
   per trade on the fixture, ~290 ms measured on a live league), where it resolved
   for 10 of those 11. Without the second pass the Championship objective shows a
   dash for almost everything and quietly becomes a ranking by wins. */
const REFINE_TOP = 15;
const REFINE_SIMS = 20000;

/* Chip order is search order: the cheapest shapes first, so the list fills early. */
const SHAPES = ["1-for-1", "2-for-1", "2-for-2", "three-way"];

const OBJECTIVES = [
  ["title", "Championship", "Rank by the change in your odds of winning the league."],
  ["wins",  "Seeding",      "Rank by the change in your expected regular-season wins."],
  ["gain",  "Balanced",     "Rank by points per week gained across the whole season."],
];
const objSort = (o) => (o === "title" ? "dtitle" : o === "wins" ? "dwins" : "gain");

/** Must match the fingerprint the background check computes. */
function rosterFingerprint(model) {
  const parts = [...model.teams.values()]
    .map(t => `${t.id}:${[...t.roster].sort((a, b) => a - b).join(",")}`).sort();
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}

function pickTeam(teams) {
  return new Promise((resolve) => {
    $("#bootmsg").textContent = "Which team is yours?";
    $("#bootact").innerHTML =
      `<select class="lg" id="whoami" style="width:auto">${
        teams.map(t => `<option>${t.replace(/</g, "&lt;")}</option>`).join("")}</select>
       <button class="btn" id="pick">That's me</button>`;
    $("#pick").onclick = () => {
      const t = $("#whoami").value;
      chrome.storage.local.set({ "ffsm.myTeam": t });
      $("#bootact").innerHTML = "";
      resolve(t);
    };
  });
}

function askForLeague(message) {
  $("#bootmsg").textContent = message;
  $("#bootact").innerHTML = `
    <input class="lg" id="lid" placeholder="league ID" inputmode="numeric">
    <button class="btn" id="go">Load</button>
    <p style="font-size:12px;color:var(--faint);margin-top:14px">
      Open your league on fantasy.espn.com and click the toolbar icon there, or paste
      the <code>leagueId</code> from its URL.</p>`;
  $("#go").onclick = () => {
    const id = Number($("#lid").value.trim());
    if (id) start({ leagueId: id, seasonId: new Date().getFullYear() });
  };
}

async function cached(key, fn) {
  const hit = await chrome.storage.local.get(key);
  const entry = hit[key];
  if (entry && Date.now() - entry.at < CACHE_HOURS * 3600e3) {
    say(`using cached data from ${new Date(entry.at).toLocaleString()}`, "ok");
    return entry.data;
  }
  const data = await fn();
  await chrome.storage.local.set({ [key]: { at: Date.now(), data } });
  return data;
}

async function start(ref) {
  $("#bootact").innerHTML = "";
  steps.innerHTML = "";
  try {
    Steps.init();
    Steps.set("settings", "run");
    say(`league ${ref.leagueId}, season ${ref.seasonId}`);
    let seenSettings = false;
    const model = await loadLeague(ref, (done, total, label) => {
      if (!seenSettings) { Steps.set("settings", "done"); Steps.set("rosters", "run"); seenSettings = true; }
      progress(done / total);
      if (done && (done % 3 === 0 || done === total)) say(`  ${label} (${done}/${total})`);
    });
    Steps.set("rosters", "done", `${model.players.size} players`);

    // Weeks already played cannot be changed by a trade, and averaging them into a
    // trade's value scores games nobody can affect. Everything downstream reads
    // model.weeks, so trimming it here is the whole fix. Must happen before the
    // settings are read below, and before anything builds the engine.
    const horizon = restrictToRemaining(model);
    say(horizonLine(horizon), horizon.complete ? "err" : "ok");

    const s = model.settings;
    say(`${s.name}: ${model.teams.size} teams, ${s.starters} starters, `
      + `${s.rosterSize}-player rosters`, "ok");
    say(`slots: ${Object.entries(s.lineupSlotCounts)
      .map(([id, n]) => `${n}×${SLOT_LABEL[id] ?? id}`).join(", ")}`, "ok");
    say(`regular season ${s.regularSeasonWeeks.length} wks, `
      + `playoffs wk ${s.playoffWeeks.join("/")} (${s.playoffTeams} teams, `
      + `${s.playoffRounds} rounds)`, "ok");
    if (s.divisions > 1)
      say(`note: ${s.divisions} divisions - playoff odds ignore divisional seeding`, "err");

    // Free agents are optional: a failure here should not cost you the trade search.
    try {
      Steps.set("agents", "run");
      const fas = await loadFreeAgents(ref, model.weeks);
      for (const fa of fas) model.players.set(fa.id, fa);
      say(`  ${fas.length} available players`, "ok");
      Steps.set("agents", "done", `${fas.length}`);
    } catch (e) {
      say(`  free agents unavailable (${e.message})`, "err");
      Steps.set("agents", "warn", "unavailable");
    }

    // Injury reports. ESPN's own injuryStatus rides along with every player record
    // we already fetched; Sleeper adds the practice report, which is the only public
    // signal separating a Questionable who practised in full from one who did not
    // practise at all. Sleeper is CORS-open and keyless, cached for a day by
    // engine/sources/cache.js, and entirely optional: a dead feed costs the practice
    // detail and nothing else.
    let sleeperByEspn = null;
    Steps.set("injuries", "run");
    try {
      const sl = await loadSleeperPlayers();
      sleeperByEspn = sl.byEspn;
      say(`  injury reports for ${sl.byEspn.size} players`
        + `${sl.fromCache ? " (cached)" : ""}${sl.stale ? ", stale" : ""}`, "ok");
      Steps.set("injuries", "done", `${sl.byEspn.size}`);
    } catch (e) {
      say(`  practice reports unavailable (${e.message}) - using ESPN status only`, "err");
      Steps.set("injuries", "warn", "ESPN only");
    }
    const av = buildAvailability(model, sleeperByEspn, model.weeks, s.currentWeek);
    for (const line of availabilityLines(av.summary)) say(line, "ok");
    // `applied` is what the engine actually priced, not what the feeds reported. A
    // badge stating a man is on IR is true either way; the season note makes a claim
    // about the arithmetic, and on a finished season that claim would be false.
    window.__avail = { statusOf: av.statusOf, summary: av.summary, horizon,
                       applied: av.avail.size > 0 && !horizon.complete,
                       feed: sleeperByEspn ? "sleeper" : "espn" };

    const { slots, starters } = buildSlots(s.lineupSlotCounts);
    const masks = new Map();
    for (const [id, p] of model.players) masks.set(id, seatMask(p.eligibleSlots, slots));

    const unplayable = [...model.players.values()].filter(p => !masks.get(p.id));
    if (unplayable.length)
      say(`${unplayable.length} rostered players fit no starting slot (IR/taxi)`, "");

    // Projection sources, then calibration. Aggregate first and shrink the aggregate:
    // shrinkage is a property of the number the engine is about to use, and the
    // calibration log has to record what was shown before the week to measure anything.
    Steps.set("proj", "run");
    const P = await runProjections({ model, ref, say, progress });
    window.__band = P.band;
    window.__aggregate = P.aggregate;
    window.__calibState = P;
    // Toggle on but every feed dead is a warning, not a success: the step ran and
    // came back with nothing, exactly as the free-agent step reports it.
    Steps.set("proj", !P.aggregate ? "skip"
        : (P.coverage.sleeper || P.coverage.fp) ? "done" : "warn",
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

    // Game environment. After shrinkage on purpose: shrinkage is about how far a
    // projection sits from its positional mean, this is about which game it is for,
    // and the two compose. Before the Engine, because the Engine snapshots proj.
    Steps.set("env", "run");
    window.__env = await environmentStep(model, ref.seasonId, say);
    Steps.set("env", window.__env.state, window.__env.note);

    say("building engine…");
    const eng = new Engine(model, { starters }, masks);
    // Only when somebody's availability is actually in doubt: an engine with an
    // all-ones table takes a slower path through weekly() for no benefit, and
    // 2-for-2 calls it millions of times. And never on a finished season:
    // restrictToRemaining keeps every week when nothing remains, so this week's
    // injury table would price games played in September — a currently-OUT
    // player would score zero across the whole retrospective.
    if (av.avail.size && !horizon.complete) {
      eng.setAvailability(av.avail);
      say(`availability applied to ${av.avail.size} players`, "ok");
    }
    // The standings so far. Every simulated season starts from them rather than 0-0.
    const records = new Map([...model.teams.values()]
      .filter((t) => t.record).map((t) => [t.name, t.record]));
    // All or nothing. projectSeason takes games played from whichever team has
    // played most, so a map missing one team would seed that team 0-and-N and
    // quietly move everybody's seeding. Projecting from 0-0 and saying so is the
    // honest failure.
    window.__records = records.size === model.teams.size ? records : null;
    if (window.__records) say(`standings seeded from ${records.size} team records`, "ok");
    else if (records.size) say(`ESPN reported records for only ${records.size} of `
      + `${model.teams.size} teams - projecting from 0-0`, "err");
    // Seeding comes from the regular season, from the standings, or from nowhere.
    // With no weeks left the simulation plays none, and with no records every team
    // is 0-0 on 0 points, so the sort that decides the bracket collapses to the
    // order ESPN happened to return the teams in and the first few would be shown
    // 100% playoff odds. There is no answer here; do not invent one.
    window.__noSeason = s.regularSeasonWeeks.length === 0 && !window.__records;
    if (window.__noSeason)
      say("the regular season has no weeks left and ESPN did not report a complete "
        + "set of standings - no season projection can be made", "err");
    say(`baseline built for ${eng.teams.length} teams`, "ok");

    const swid = await mySwid();
    const saved = (await chrome.storage.local.get("ffsm.myTeam"))["ffsm.myTeam"];
    let { team: myTeam, how } = identifyTeam(model, { swid, teamId: ref.teamId });
    if (saved && eng.teams.includes(saved)) { myTeam = saved; how = "your saved choice"; }
    if (myTeam) say(`your team: ${myTeam} (from ${how})`, "ok");
    else {
      // Never guess. Picking whichever team ESPN returned first and captioning its
      // trades "you" is worse than asking.
      say("could not tell which team is yours - pick below", "err");
      myTeam = await pickTeam(eng.teams);
    }

    say(`free-agent pool usable: ${eng.freeAgents.length}`, "ok");

    let schedule = new Map();
    Steps.set("schedule", "run");
    try {
      schedule = await loadSchedule(ref, model.teams);
      say(`schedule: ${schedule.size} weeks of real matchups`, "ok");
      Steps.set("schedule", "done", `${schedule.size} wks`);
    } catch {
      say("schedule unavailable - season projection will use all-play", "err");
      Steps.set("schedule", "warn", "all-play");
    }
    window.__schedule = schedule;

    // Volatility is measured from last season's actuals, which ESPN returns in the
    // same payload as the projections. Falling back to a guessed constant would
    // change every number in the season projection.
    Steps.set("vol", "run");
    const vol = measureVolatility([...model.players.values()], ref.seasonId - 1);
    if (vol.measured >= 20) {
      eng.setVolatility(vol);
      // Teammates' scores move together. Attaching this clears the sigma cache, so
      // it has to follow setVolatility and precede anything that reads teamSigma.
      attachCovariance(eng, model.players);
      const posText = [...vol.byPos].sort()
        .map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ");
      say(`volatility measured on ${vol.measured} players: ${posText}`, "ok");
      Steps.set("vol", "done", `${vol.measured} players`);
      say(`your team's weekly spread: ±${
        (eng.teamSigma(myTeam).reduce((a, b) => a + b, 0) / model.weeks.length).toFixed(1)} pts`, "ok");
    } else {
      say(`only ${vol.measured} players have prior-season history - `
        + `season projection will assume ±25 pts`, "err");
      Steps.set("vol", "warn", "assumed ±25");
    }
    window.__vol = vol;
    // Measured floors and ceilings, from the residuals measureVolatility keeps.
    window.__dist = buildDistribution(vol, model.players);
    // FantasyCalc's crowd values: what the manager on the other side is thinking.
    // Display and ranking only - nothing below this line reads them, and a dead feed
    // costs a dash in one column, not the search.
    Steps.set("market", "run");
    const loadedMarket = await marketOrNull(model.settings, model.teams.size, say);
    window.__market = marketView(eng, loadedMarket);
    // Zero priced players is not a healthy load - an empty feed should read the same
    // as a dead one, not go green.
    const marketHealthy = !!loadedMarket && loadedMarket.byEspn.size > 0;
    Steps.set("market", marketHealthy ? "done" : "warn",
      loadedMarket ? `${loadedMarket.byEspn.size} priced` : "unavailable");

    // Usage: what the box score has not caught up with yet. Evidence only - nothing
    // below this line reads it, and a dead feed costs two sections and two columns,
    // not the search - so the computation, not just the load, is guarded.
    Steps.set("usage", "run");
    try {
      const loadedUsage = await usageOrNull(model, ref.seasonId, say);
      window.__usage = await usageViewStored(model, loadedUsage, s.currentWeek, say);
    } catch { window.__usage = null; }
    Steps.set("usage", window.__usage ? "done" : "warn",
      window.__usage ? `${window.__usage.table.rows.size} players` : "unavailable");

    Steps.set("s1", "run");
    const one = await eng.findTwoTeam(1, 0.05, (n, tot) => progress(n / tot));
    say(`  ${one.length} mutually beneficial`, "ok");

    Steps.set("s1", "done", `${one.length}`);
    // A consolidation is scored to the roster limit: the sender fills the seat it
    // empties from waivers, the receiver drops his least useful man. Exhaustive.
    Steps.set("s21", "run");
    const t21 = Date.now();
    const twoOne = await eng.findTwoForOne(0.05, (n, tot) => progress(n / tot));
    say(`  ${twoOne.length} consolidations in ${((Date.now() - t21) / 1000).toFixed(1)}s`, "ok");
    Steps.set("s21", "done", `${twoOne.length}`);
    Steps.set("s2", "run", "slowest step");
    const two = await eng.findTwoTeam(2, 0.05, (n, tot) => progress(n / tot));
    say(`  ${two.length} mutually beneficial`, "ok");

    Steps.set("s2", "done", `${two.length}`);
    Steps.set("s3", "run");
    const three = await eng.findThreeWay(0.05, (n, tot) => progress(n / tot));
    say(`  ${three.length} cycles`, "ok");

    const trades = [...dedupe(one, 3), ...dedupe(twoOne, 3), ...dedupe(two, 3), ...dedupe(three, 3)]
      .sort((a, b) => b.total - a.total);
    Steps.set("s3", "done", `${three.length}`);

    // Wins, not points, decide a season. The exact search is done; these passes only
    // re-score its survivors, so recall is unaffected.
    Steps.set("win", "run");
    eng.setSchedule(schedule);
    await eng.enrich(trades, (n, tot) => progress(n / tot));
    Steps.set("win", "done", `${trades.length} trades`);

    // A Δ odds figure is a difference between two simulated worlds. When neither
    // world means anything the difference does not either, so the trades keep no
    // odds at all and every reader of them falls back through significant().
    if (window.__noSeason) {
      Steps.set("odds", "warn", "no standings");
    } else {
      Steps.set("odds", "run");
      const mine = trades.filter((t) => t.sides.some((s) => s.team === myTeam))
        .sort((a, b) => b.sides.find((s) => s.team === myTeam).win - a.sides.find((s) => s.team === myTeam).win)
        .slice(0, ODDS_CAP);
      const divisionOf = new Map([...model.teams.values()].map((t) => [t.name, t.divisionId]));
      const divSeedSaved = (await chrome.storage.local.get("ffsm.divSeed"))["ffsm.divSeed"] ?? false;
      window.__divSeed = divSeedSaved;
      const oddsOpts = { batches: 10, divisionOf, records: window.__records,
        divisionSeeding: divSeedSaved && (model.settings.divisionCount ?? 0) > 1 };
      const { ms } = await attachOdds(eng, schedule, model.settings, mine, myTeam,
        { ...oddsOpts, sims: ODDS_SIMS }, (n, tot) => progress(n / tot));

      // Δ bye resolves at 2500 sims where Δ title usually does not, so it picks the
      // shortlist; the rest fall through to expected wins. Re-simulating those few at
      // 20,000 seasons is what makes the Championship number readable at all.
      const rank = (t) =>
        significant(t.odds, "bye") ?? (-1e6 + t.sides.find((s) => s.team === myTeam).win);
      const refine = mine.slice().sort((a, b) => rank(b) - rank(a)).slice(0, REFINE_TOP);
      const fine = await attachOdds(eng, schedule, model.settings, refine, myTeam,
        { ...oddsOpts, sims: REFINE_SIMS }, (n, tot) => progress(n / tot));
      say(`season odds for ${mine.length} trades in ${(ms / 1000).toFixed(1)}s; `
        + `top ${refine.length} re-run at ${REFINE_SIMS.toLocaleString()} seasons `
        + `in ${(fine.ms / 1000).toFixed(1)}s`, "ok");
      Steps.set("odds", "done", `${mine.length} trades · ${refine.length} refined`);
    }

    Steps.set("build", "run");
    say(`${trades.length} offers after dedupe`, "ok");

    // Record what this run found, so the daily check and the on-page notice have
    // something real to report rather than a generic nag.
    try {
      const mine = trades.filter(t => t.sides.some(x => x.team === myTeam)).length;
      const key = `ffsm.league.${ref.leagueId}.${ref.seasonId}`;
      await chrome.storage.local.set({ [key]: {
        at: Date.now(), offers: mine, team: myTeam,
        rosterHash: rosterFingerprint(model), changed: false,
      } });
      chrome.runtime.sendMessage({ type: "ffsm.analysed" });
    } catch { /* storage unavailable; the report still works */ }

    Steps.set("build", "done");
    Steps.stop();
    window.__objective = (await chrome.storage.local.get("ffsm.objective"))["ffsm.objective"] ?? "title";
    render(eng, model, trades, myTeam, schedule);
  } catch (err) {
    Steps.stop();
    const running = $('#steps li[data-s="run"]');
    if (running) running.dataset.s = "warn";
    $("#bootmsg").textContent = "Could not finish loading.";
    say(String(err.message ?? err), "err");
    if (/signed in|access/i.test(String(err))) {
      $("#bootmsg").textContent = "ESPN did not accept the request.";
      $("#bootact").innerHTML =
        `<p style="font-size:13px;color:var(--dim)">Sign in at
         <a href="https://fantasy.espn.com" target="_blank">fantasy.espn.com</a>,
         then reload this page.</p>`;
    } else {
      askForLeague("Could not load that league.");
    }
  }
}

/* Column meanings, shown on hover. The numbers are meaningless without these -
   "gain" in particular is not points scored, it is the change in the best lineup
   you could field. */
const HINT = {
  shape:  "How many players move, and between how many teams. A three-way is a cycle: you send to one team and receive from another.",
  recv:   "Players who would join your roster.",
  send:   "Players who would leave your roster.",
  partner:"The other team or teams in the deal. Every side has to gain, or nobody accepts.",
  gain:   "Average points per week this team's BEST POSSIBLE starting lineup improves, across the whole season. Bench depth counts for nothing - only players who would actually start.",
  reg:    "The same gain, counting only regular-season weeks - the ones that decide seeding. A trade can be positive overall while making a record worse.",
  po:     "The same gain, but counting only playoff weeks.",
  theirs: "What the other side gains. They need this above zero or they will not say yes.",
  starts: "Share of weeks this player would crack your optimal lineup. Near zero means his points are sitting on your bench - that is a trade chip.",
  bye:    "The week his NFL team is off. He scores nothing that week.",
  projwk: "Average projection in the weeks he actually plays, ignoring his bye.",
  gap:    "Points per week behind the strongest roster in the league.",
  optimal:"What this roster would score each week if it started its best possible lineup every week.",
  fagain: "How much your best lineup improves if you add this player and drop the one shown. A free agent who would never start is worth nothing, however good his projection looks.",
  owned:  "Share of ESPN leagues where this player is rostered. A low number with a real gain is the most likely to still be available.",
  record: "Average wins and losses across every simulated season. Fractional because it is an average of many outcomes, not a prediction of one.",
  pf:     "Average total points scored over the regular season. Used as the seeding tiebreak, as in most ESPN leagues.",
  podds:  "Share of simulated seasons where this team qualifies for the playoffs.",
  byeodds:"Share of simulated seasons where this team earns a first-round bye. Worth far more than it looks: it skips an elimination game.",
  title:  "Share of simulated seasons where this team wins the league.",
  weeks:  "How many weeks the trade is a net positive for you. A gain spread across every week is more dependable than the same average earned in three big ones.",
  combined:"Both sides' gains added together. High combined value means the trade creates the most points league-wide, which is not the same as being good for you.",
  byehelp:"What the trade is worth to your partner during their bye-thinned weeks. A big number here with little full-strength value means you are selling them a bye fix, not talent.",
  balance:"How evenly the gain splits. Lopsided offers are the ones that get declined, however good the total looks.",
  swing:  "How far this roster's weekly score typically lands from its projection, measured from last season's results for the players it starts. A lower number means a more predictable team - which helps a favourite and hurts an underdog.",
  objective:"What the list is sorted by. Championship uses the change in title odds from a paired season simulation; Seeding uses expected regular-season wins from your schedule; Balanced is points per week.",
  dwins:  "Change in your expected regular-season wins: each week's win probability against your scheduled opponent, before and after the trade, summed. Uses the measured spread of both lineups.",
  dtitle: "Change in your odds of winning the league, from two season simulations with identical luck - one with today's rosters, one after the trade. A dash means the change is smaller than the simulation's own error. The top trades are re-simulated at 20,000 seasons so this number resolves for the ones you would actually consider.",
  dbye:   "Change in your odds of a first-round bye. In a six-team bracket a bye roughly doubles title odds, so this is usually the number that matters in November.",
  calib:  "ESPN projections are over-spread: the gap between a position's #1 and #5 is smaller in reality than on paper. On, each projection is pulled toward its positional mean by the slope measured across twelve seasons (QB 0.67, RB 0.79, WR 0.85, TE 0.72).",
  band:   "How much the projection sources disagree about this player, in points per week, averaged over the weeks left. A wide band means the number above it is less settled than it looks — not that the player is volatile.",
};
const th = (label, key, cls = "") =>
  `<th class="${cls}" data-hint="${esc(HINT[key])}"><span class="hint">${esc(label)}</span></th>`;

/* A `title` attribute is slow to appear and easy to miss, and a CSS tooltip would be
   clipped by the table's own overflow:auto. A fixed-position node dodges both. */
function initTooltips(root) {
  let tip = document.getElementById("tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "tip";
    document.body.appendChild(tip);
  }
  const show = (el) => {
    tip.textContent = el.dataset.hint;
    tip.classList.add("on");
    const r = el.getBoundingClientRect();
    tip.style.visibility = "hidden";
    tip.style.left = "0px";
    const w = tip.offsetWidth;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${r.bottom + 8}px`;
    tip.style.visibility = "visible";
  };
  root.querySelectorAll("[data-hint]").forEach((el) => {
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("focus", () => show(el));
    el.addEventListener("mouseleave", () => tip.classList.remove("on"));
    el.addEventListener("blur", () => tip.classList.remove("on"));
    el.tabIndex = 0;
  });
}

const esc = (v) => String(v).replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (n) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2);
const cls = (n) => (n > 0.005 ? "up" : n < -0.005 ? "down" : "zero");
/** A probability delta in percentage points, or a dash. Feed it `significant()`. */
const fpp = (v) => (v == null || !Number.isFinite(v))
  ? '<span class="zero">—</span>'
  : `<span class="${cls(v)}">${v >= 0 ? "+" : "−"}${(Math.abs(v) * 100).toFixed(1)}pp</span>`;
const fw = (v) => `<span class="${cls(v)}">${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}</span>`;

/** Diverging per-week bars: how much the trade helps or hurts, week by week. */
function deltaBars(weekly, weeks) {
  const m = Math.max(...weekly.map(Math.abs), 0.05);
  return `<div class="delta">${weekly.map((v, i) =>
    `<i class="${v > 0 ? "p" : v < 0 ? "n" : ""}" style="--h:${(Math.abs(v) / m * 48).toFixed(1)}%"
       title="Wk ${weeks[i]}: ${f2(v)}"></i>`).join("")}</div>
    <div class="delta-l"><span>WK ${weeks[0]}</span><span>PER-WEEK CHANGE</span>
      <span>WK ${weeks.at(-1)}</span></div>`;
}

/** A player's season: bar height is his projection, green means he starts. */
function usageBars(strip, proj, thin, weeks, outgoing = false) {
  const max = Math.max(...proj, 1);
  return `<div class="bars${outgoing ? " out" : ""}">${strip.map((v, i) => {
    const h = v === -1 ? 12 : Math.max(8, proj[i] / max * 100);
    return `<i class="${v === 1 ? "on" : v === -1 ? "bye" : ""}${thin && thin[i] ? " thin" : ""}"
      style="height:${h.toFixed(0)}%" title="Wk ${weeks[i]}: ${
        v === -1 ? "bye" : proj[i].toFixed(1) + (v === 1 ? " · starts" : " · benched")}"></i>`;
  }).join("")}</div>`;
}

function render(eng, model, trades, myTeam, schedule = window.__schedule ?? new Map()) {
  const W = eng.weeks;
  const AV = window.__avail ?? null;
  const rates = eng.startRates();
  const nm = (i) => model.players.get(eng.ids[i]).name;
  const posOf = (i) => model.players.get(eng.ids[i]).pos;
  const tag = (i) => `<span class="pos" data-p="${esc(posOf(i))}">${esc(posOf(i))}</span>`;
  // A package that hands you a man on IR has to say so where the names are, not
  // three sections further down.
  const pkg = (ids) => ids
    .map((i) => `${esc(nm(i))} ${tag(i)}${statusBadge(AV, eng.ids[i], esc)}`)
    .join('<span class="plus">+</span>');
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const avgProj = (i) => {
    const v = [];
    for (let w = 0; w < eng.NW; w++) {
      const x = eng.proj[i * eng.NW + w];
      if (x > 0) v.push(x);
    }
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const bandMeanOf = (id) => bandMean(window.__band, id);

  // Floors, ceilings and the gameplan all need a measured spread - gate every one of
  // them on eng.sigmaOf, which setVolatility only assigns once vol.measured >= 20.
  // Without that gate a league with no prior-season history still got a fabricated
  // +-7.69 band from the empty-sample fallback in buildDistribution.
  const DIST = eng.sigmaOf ? (window.__dist ?? null) : null;
  // This week's game. The horizon starts at the current week, so index 0 is it -
  // unless the season is over, in which case restrictToRemaining keeps every week and
  // currentWeek exceeds all of them, and indexOf returns -1. Clamping that to 0 used
  // to silently show week 1's game as "this week"; instead, no index means no plan.
  const curIdx = W.indexOf(model.settings.currentWeek ?? W[0]);
  const plan = DIST && eng.sigmaOf && curIdx >= 0 ? gameplan(eng, myTeam, curIdx) : null;
  const thisWeek = weekSection(plan, { esc, name: nm, myTeam });

  /* ---------- filter state ---------- */
  const viewing = window.__view ?? myTeam;
  const mineOnly = viewing !== "__all__";
  const mkt = window.__market ?? null;
  const uv = window.__usage ?? null;
  // What is left of my acquisition budget, for the bid column. Settings are read.
  const myBudget = model.settings.faabBudget ?? 0;
  const mySpent = [...model.teams.values()].find((t) => t.name === myTeam)?.faabSpent ?? 0;
  const F = (window.__filters ??= {
    shapes: new Set(SHAPES),
    minGain: 0.10, only: new Set(), q: "",
  });
  const balance = (t) => {
    const g = t.sides.map((s) => s.gain);
    return Math.min(...g) / Math.max(...g);
  };
  // A bye play rather than a talent upgrade: neutral at full strength, but worth
  // real points once byes force a partner to start players he would rather bench.
  const byeDriven = (t) =>
    t.sides.some((s) => s.team !== viewing && s.full <= 0.15 && s.bye >= 1.5);
  const side = (t) => t.sides.find((s) => s.team === viewing) ?? t.sides[0];
  const others = (t) => t.sides.filter((s) => s !== side(t));

  const shown = trades
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !mineOnly || t.sides.some((s) => s.team === viewing))
    .filter(({ t }) => F.shapes.has(t.shape))
    .filter(({ t }) => Math.min(...t.sides.map((s) => s.gain)) >= F.minGain)
    .filter(({ t }) => !F.only.has("bye") || byeDriven(t))
    .filter(({ t }) => !F.only.has("even") || balance(t) >= 0.6)
    // A dead feed (mkt === null) must never empty the list - the chip is also hidden
    // whenever there is no market, but the filter stays inert on its own in case
    // "mktfair" was set while the feed was still up.
    .filter(({ t }) => !F.only.has("mktfair") || !mkt || (marketFair(t, mkt) ?? 0) >= 0.8)
    .filter(({ t }) => !F.q || t.sides.some((s) =>
      [...s.sent, ...s.received].some((i) => nm(i).toLowerCase().includes(F.q))));

  /* ---------- expanded detail ---------- */
  function detailFor(t) {
    const ex = eng.explain(t);
    const panels = t.sides.map((sd) => {
      const d = ex[sd.team];
      const li = [];
      for (const a of d.acquired)
        li.push(`<li><b>${esc(nm(a.i))}</b>${esc(bandTag(window.__band, eng.ids[a.i]))} would start
                 <b>${a.startsHere}</b> of ${W.length} weeks here, versus ${a.startsThere}
                 where he is now.</li>`);
      for (const x of d.sent)
        li.push(`<li>Gives up ${esc(nm(x.i))} — ${x.wasStarting} starts.</li>`);
      for (const x of d.displaced)
        if (x.i !== d.dropped?.i) li.push(`<li class="b">${esc(nm(x.i))} loses ${-x.delta} starts.</li>`);
      for (const x of d.promoted)
        li.push(`<li class="g">${esc(nm(x.i))} gains ${x.delta} starts.</li>`);
      li.push(moveLines(d, nm));
      return `<div class="det-side${sd.team === myTeam ? " det-mine" : ""}">
        <h4>${esc(sd.team)}${sd.team === myTeam ? " · you" : ""}</h4>
        <div class="hd ${cls(sd.gain)}">${f2(sd.gain)}<span class="unit">/wk</span></div>
        <div class="det-nums">
          <span>reg <b class="${cls(sd.reg)}">${f2(sd.reg)}</b></span>
          <span>playoffs <b class="${cls(sd.playoff)}">${f2(sd.playoff)}</b></span>
          <span>bye weeks <b class="${cls(sd.bye)}">${f2(sd.bye)}</b></span>
          <span>weeks helped <b>${sd.weekly.filter((x) => x > 0.005).length}/${W.length}</b></span>
          <span>Δ wins <b class="${cls(sd.win ?? 0)}">${(sd.win >= 0 ? "+" : "−") + Math.abs(sd.win ?? 0).toFixed(2)}</b></span>
          ${marketDetail(sd, mkt)}
        </div>
        ${eng.stacks ? stackLine(
          eng.stacks(eng.swap(eng.roster.get(sd.team), sd.sent, sd.received), 0),
          { esc, name: nm }) : ""}
        <ul>${li.join("")}</ul>${deltaBars(sd.weekly, W)}
        ${sd.winWeekly ? `<div class="delta-cap">Win probability, week by week
          <b class="${cls(sd.win)}">${(sd.win >= 0 ? "+" : "−") + Math.abs(sd.win).toFixed(2)} wins</b></div>
          ${deltaBars(sd.winWeekly.map((x) => x * 100), W)}` : ""}</div>`;
    }).join("");

    const cases = others(t).map((other) => {
      const d = ex[other.team];
      const bw = W.filter((_, i) => d.thin?.[i]);
      const isBye = other.full <= 0.15 && other.bye >= 1.5 && bw.length;
      const inRows = d.acquired.map((a) => `
        <div class="cmp-name">${esc(nm(a.i))} ${tag(a.i)}
          <span class="tag${a.startsHere > a.startsThere ? " g" : ""}">${
            a.startsThere} &rarr; ${a.startsHere} starts</span></div>
        <div class="cmp-lab">Where he<br>is now</div>
        <div>${usageBars(a.now, a.proj, null, W)}</div>
        <div class="cmp-lab">With ${esc(other.team)}<br>after</div>
        <div>${usageBars(a.after, a.proj, d.thin, W)}</div>`).join("");

      // What this partner gives up. There is no "after" strip - he is gone - so it
      // shows the starts being surrendered, which is the cost side of the pitch.
      const outRows = (d.sent ?? []).map((x) => `
        <div class="cmp-name">${esc(nm(x.i))} ${tag(x.i)}
          <span class="tag warn">gives up ${x.wasStarting} start${
            x.wasStarting === 1 ? "" : "s"}</span></div>
        <div class="cmp-lab">Starting for<br>them now</div>
        <div>${x.now ? usageBars(x.now, x.proj, d.thin, W, true) : ""}</div>`).join("");

      return `<div class="pitch">
        <div class="pitch-hd">
          <h4>The case for ${esc(other.team)}</h4>
          <div style="display:flex;gap:8px;align-items:center">
            ${isBye ? `<span class="tag">Bye relief · wks ${bw.join(", ")}</span>` : ""}
            <button class="copy" data-team="${esc(other.team)}">Copy pitch</button>
          </div>
        </div>
        <p class="pitch-say">${d.acquired.map((a) => a.startsHere > a.startsThere
          ? `<b>${esc(nm(a.i))}</b> starts ${a.startsThere} of ${W.length} weeks where he
             is now — he'd start <b>${a.startsHere}</b> for ${esc(other.team)}.`
          : `<b>${esc(nm(a.i))}</b> starts ${a.startsHere} of ${W.length} weeks for
             ${esc(other.team)}.`).join(" ")}
          ${isBye ? `Most of the value lands in weeks ${bw.join(", ")}, when byes leave
             that roster starting players it would rather bench — at full strength it is
             only ${f2(other.full)} per week.` : ""}</p>
        <div class="cmp-group"><h5>What ${esc(other.team)} gets</h5>
          <div class="cmp">${inRows}</div></div>
        ${outRows ? `<div class="cmp-group out"><h5>What ${esc(other.team)} gives up</h5>
          <div class="cmp">${outRows}</div></div>` : ""}
        <div class="legend">
          <span><i class="swatch" style="background:var(--accent)"></i> starts</span>
          <span><i class="swatch" style="background:var(--line-hi)"></i> benched</span>
          <span><i class="swatch" style="background:var(--warn);height:3px"></i> their thin week</span>
          <span style="color:var(--dim)">Bar height is his weekly projection.</span>
        </div></div>`;
    }).join("");
    return `<div class="det">${panels}${cases}</div>`;
  }

  /** Plain text a manager can paste into a league chat. */
  function pitchText(t, other) {
    const ex = eng.explain(t);
    const d = ex[other.team];
    const L = [t.sides.length > 2
      ? `Three-team idea — you get ${other.received.map(nm).join(" + ")}, you send ${
          other.sent.map(nm).join(" + ")}.`
      : `Trade idea — you get ${other.received.map(nm).join(" + ")}, I get ${
          other.sent.map(nm).join(" + ")}.`, ""];
    for (const a of d.acquired) {
      const g = a.startsHere - a.startsThere;
      L.push(g > 0
        ? `${nm(a.i)} would start ${a.startsHere} of ${W.length} weeks for you. He only `
          + `starts ${a.startsThere} where he is now — ${g} more weeks in a lineup.`
        : `${nm(a.i)} starts ${a.startsHere} of ${W.length} weeks for you.`);
    }
    for (const x of d.sent ?? [])
      L.push(x.wasStarting > 0
        ? `You give up ${nm(x.i)}, who starts ${x.wasStarting} of ${W.length} weeks for you.`
        : `You give up ${nm(x.i)}, who never cracks your lineup.`);
    L.push("", `Net for you: ${f2(other.gain)} points per week, using your best possible `
      + `lineup each week.`);
    if (Math.abs(other.reg - other.gain) > 0.15)
      L.push(`In the regular season specifically it is ${f2(other.reg)} per week.`);
    if (other.full <= 0.15 && other.bye >= 1.5)
      L.push(`It is really a bye-week fix: ${f2(other.full)} at full strength, but `
        + `${f2(other.bye)} in the weeks byes thin you out.`);
    if (other.playoff > 0.3) L.push(`Playoff weeks: ${f2(other.playoff)} per week.`);
    const me = side(t);
    L.push("", balance(t) >= 0.5
      ? `I gain ${f2(me.gain)} per week, so we both come out ahead.`
      : `I gain ${f2(me.gain)} per week — most of the value here is on your side.`);
    const mline = marketPitchLine(t, other, mkt);
    if (mline) L.push("", mline);
    return L.join("\n");
  }

  /* ---------- grids ---------- */
  const tradeCols = [
    { key: "car", label: "", sortable: false },
    { key: "shape", label: "Shape", num: true, value: (r) => r.t.shape,
      hint: HINT.shape + " " + ROSTER_HINT.shape21 },
    { key: "recv", label: mineOnly ? "You receive" : "Receives",
      value: (r) => side(r.t).received.map(nm).join(" "), hint: HINT.recv },
    { key: "send", label: mineOnly ? "You send" : "Sends",
      value: (r) => side(r.t).sent.map(nm).join(" "), hint: HINT.send },
    { key: "partner", label: "Partner",
      value: (r) => others(r.t).map((o) => o.team).join(" "), hint: HINT.partner },
    { key: "weeks", label: "Weeks helped", num: true,
      value: (r) => side(r.t).weekly.filter((x) => x > 0.005).length, hint: HINT.weeks },
    { key: "gain", label: mineOnly ? "Your gain" : "Gain", num: true,
      value: (r) => side(r.t).gain, hint: HINT.gain },
    { key: "dwins", label: "Δ wins", num: true,
      value: (r) => side(r.t).win ?? 0, hint: HINT.dwins },
    { key: "dtitle", label: "Δ title", num: true,
      // A dash in the cell must sort as a dash: fall through to Δ wins, below every
      // resolved title delta, so the significance rule and the order agree.
      value: (r) => {
        const s = side(r.t);
        const v = s.team === myTeam ? significant(r.t.odds, "title") : null;
        return v ?? -1e6 + (s.win ?? 0);
      },
      hint: HINT.dtitle },
    { key: "dbye", label: "Δ bye", num: true,
      value: (r) => {
        const s = side(r.t);
        const v = s.team === myTeam ? significant(r.t.odds, "bye") : null;
        return v ?? -1e6 + (s.win ?? 0);
      },
      hint: HINT.dbye },
    { key: "theirs", label: "Partner gain", num: true,
      value: (r) => Math.min(...others(r.t).map((o) => o.gain)), hint: HINT.theirs },
    { key: "combined", label: "Combined", num: true, value: (r) => r.t.total, hint: HINT.combined },
    { key: "reg", label: "Reg. season", num: true, value: (r) => side(r.t).reg, hint: HINT.reg },
    { key: "po", label: "Playoffs", num: true, value: (r) => side(r.t).playoff, hint: HINT.po },
    { key: "byehelp", label: "Partner bye help", num: true,
      value: (r) => Math.max(...others(r.t).map((o) => o.bye)), hint: HINT.byehelp },
    { key: "balance", label: "Balance", num: true, value: (r) => balance(r.t), hint: HINT.balance },
    marketCol(mkt),
  ];
  const tradeGrid = grid("tradeGrid", tradeCols, shown, {
    sort: objSort(window.__objective ?? "title"), dir: -1,
    empty: '<div class="empty"><b>No trades match</b>Lower the minimum gain, enable '
         + 'more shapes, or clear the player filter.</div>',
    row: ({ t, i }) => {
      const me = side(t), rest = others(t);
      return `<tr class="tr-row${me.team === myTeam ? " mine" : ""}" data-i="${i}">
        <td class="rank"><span class="car">&#9656;</span></td>
        <td class="num nowrap">${esc(t.shape)}</td>
        <td>${mineOnly ? "" : `<div class="side-l">${esc(me.team)}</div>`}
            <div class="pkg">${pkg(me.received)}</div>${moveNote(me, nm)}</td>
        <td><div class="pkg">${pkg(me.sent)}</div></td>
        <td class="nowrap" style="color:var(--dim)">${rest.map((o) => esc(o.team)).join(" + ")}</td>
        <td class="num">${me.weekly.filter((x) => x > 0.005).length}<span
          style="color:var(--faint)">/${W.length}</span></td>
        <td class="num ${cls(me.gain)}">${f2(me.gain)}</td>
        <td class="num">${fw(me.win ?? 0)}</td>
        <td class="num">${fpp(me.team === myTeam ? significant(t.odds, "title") : null)}</td>
        <td class="num">${fpp(me.team === myTeam ? significant(t.odds, "bye") : null)}</td>
        <td class="num" style="color:var(--dim)">${rest.map((o) => f2(o.gain)).join(" / ")}</td>
        <td class="num">${t.total.toFixed(2)}</td>
        <td class="num ${cls(me.reg)}">${f2(me.reg)}</td>
        <td class="num ${cls(me.playoff)}">${f2(me.playoff)}</td>
        <td class="num ${cls(rest[0].bye)}">${f2(rest[0].bye)}${
          byeDriven(t) ? ' <span class="tag">bye</span>' : ""}</td>
        <td><div class="bal"><div class="track"><i style="width:${
          (balance(t) * 100).toFixed(0)}%"></i></div><span class="balpct">${
          (balance(t) * 100).toFixed(0)}%</span></div></td>
        ${marketCell(t, mkt)}
      </tr>
      <tr class="detail" data-for="${i}" hidden><td colspan="${tradeCols.length}"></td></tr>`;
    },
  });

  // Floor and ceiling per game, averaged over the weeks he is projected to play.
  // A bye is not a bad week, it is no week, so it is excluded from both.
  const rangeOf = (p) => {
    const f = [], c = [];
    for (const w of W) {
      if (!(p.proj?.[w] > 0)) continue;
      const r = playerRange(p, w, DIST);
      f.push(r.floor); c.push(r.ceiling);
    }
    return f.length
      ? { floor: f.reduce((a, b) => a + b, 0) / f.length,
          ceiling: c.reduce((a, b) => a + b, 0) / c.length }
      : { floor: 0, ceiling: 0 };
  };
  const rosterRows = eng.roster.get(mineOnly ? viewing : myTeam).map((i) => ({
    i, p: model.players.get(eng.ids[i]), rate: rates.get(i) ?? 0, avg: avgProj(i),
    rng: DIST ? rangeOf(model.players.get(eng.ids[i])) : null,
  }));
  const rosterGrid = grid("rosterGrid", [
    { key: "name", label: "Player", value: (r) => r.p.name },
    { key: "pos", label: "Pos", value: (r) => r.p.pos },
    { key: "nfl", label: "NFL", value: (r) => r.p.nfl },
    { key: "status", label: "Status", num: true,
      value: (r) => statusRank(AV, r.p.id), hint: AVAIL_HINT.status },
    { key: "bye", label: "Bye", num: true, value: (r) => r.p.bye || 99, hint: HINT.bye },
    { key: "avg", label: "Proj/wk", num: true, value: (r) => r.avg, hint: HINT.projwk },
    { key: "band", label: "±", num: true, value: (r) => bandMeanOf(r.p.id), hint: HINT.band },
    { key: "floor", label: "Floor", num: true,
      value: (r) => r.rng?.floor ?? 0, hint: DIST_HINT.floor },
    { key: "ceil", label: "Ceiling", num: true,
      value: (r) => r.rng?.ceiling ?? 0, hint: DIST_HINT.ceiling },
    { key: "rate", label: "Starts", num: true, value: (r) => r.rate, hint: HINT.starts },
    envColumn(window.__env),
    { key: "bar", label: "", sortable: false },
  ], rosterRows, {
    sort: "rate", dir: 1,
    row: (r) => { const bd = bandMeanOf(r.p.id); return `<tr>
      <td style="font-weight:600">${esc(r.p.name)}</td>
      <td>${tag(r.i)}</td>
      <td class="nfl">${esc(r.p.nfl)}</td>
      <td class="num">${statusCell(AV, r.p.id, esc)}</td>
      <td class="num" style="color:var(--faint)">${r.p.bye || "—"}</td>
      <td class="num">${r.avg.toFixed(1)}</td>
      <td class="num" style="color:var(--faint)">${bd > 0.05 ? bd.toFixed(1) : "—"}</td>
      <td class="num" style="color:var(--dim)">${r.rng ? r.rng.floor.toFixed(1) : "—"}</td>
      <td class="num" style="color:var(--dim)">${r.rng ? r.rng.ceiling.toFixed(1) : "—"}</td>
      <td class="num ${r.rate < 0.35 ? "down" : r.rate > 0.8 ? "up" : ""}">${
        (r.rate * 100).toFixed(0)}%</td>
      ${envCell(window.__env, r.p)}
      <td><div class="meter"><i style="width:${(r.rate * 100).toFixed(0)}%"></i></div></td>
    </tr>`; },
  });

  const upgrades = eng.freeAgents.length
    ? eng.freeAgentUpgrades(mineOnly ? viewing : myTeam, { minGain: 0.05, limit: 25 }) : [];
  const wv = waiverView(upgrades, uv, eng,
    { budget: myBudget, myRemaining: Math.max(0, myBudget - mySpent), weeksLeft: eng.NW });
  const faGrid = grid("faGrid", [
    { key: "add", label: "Add", value: (u) => nm(u.fa) },
    { key: "pos", label: "Pos", value: (u) => posOf(u.fa) },
    { key: "nfl", label: "NFL", value: (u) => model.players.get(eng.ids[u.fa]).nfl },
    { key: "drop", label: "Drop", value: (u) => nm(u.drop) },
    { key: "gain", label: "Gain", num: true, value: (u) => u.gain, hint: HINT.fagain },
    { key: "reg", label: "Reg. season", num: true, value: (u) => u.reg, hint: HINT.reg },
    { key: "po", label: "Playoffs", num: true, value: (u) => u.playoff, hint: HINT.po },
    { key: "own", label: "Owned", num: true,
      value: (u) => model.players.get(eng.ids[u.fa]).owned ?? 0, hint: HINT.owned },
    ...faCrowdCols(wv),
  ], upgrades, {
    sort: "gain", dir: -1,
    empty: '<div class="empty"><b>Nothing on waivers helps</b>Your worst starter '
         + 'already beats everything available.</div>',
    row: (u) => `<tr>
      <td style="font-weight:600">${esc(nm(u.fa))}</td>
      <td>${tag(u.fa)}</td>
      <td class="nfl">${esc(model.players.get(eng.ids[u.fa]).nfl)}</td>
      <td style="color:var(--dim)">${esc(nm(u.drop))}</td>
      <td class="num ${cls(u.gain)}">${f2(u.gain)}</td>
      <td class="num ${cls(u.reg)}">${f2(u.reg)}</td>
      <td class="num ${cls(u.playoff)}">${f2(u.playoff)}</td>
      <td class="num" style="color:var(--faint)">${
        model.players.get(eng.ids[u.fa]).owned ?? "—"}%</td>
      ${faCrowdCells(u, wv)}
    </tr>`,
  });

  const strength = eng.teams.map((t) => ({
    t, avg: eng.baseline.get(t).reduce((a, b) => a + b, 0) / eng.NW,
  }));
  const hi = Math.max(...strength.map((x) => x.avg));
  const lo = Math.min(...strength.map((x) => x.avg));
  const leagueGrid = grid("leagueGrid", [
    { key: "name", label: "Team", value: (r) => r.t },
    { key: "avg", label: "Optimal pts/wk", num: true, value: (r) => r.avg, hint: HINT.optimal },
    { key: "gap", label: "Behind leader", num: true, value: (r) => r.avg - hi, hint: HINT.gap },
    { key: "bar", label: "", sortable: false },
  ], strength, {
    sort: "avg", dir: -1,
    row: (r) => `<tr${r.t === myTeam ? ' class="mine"' : ""}>
      <td${r.t === myTeam ? ' style="font-weight:700"' : ""}>${esc(r.t)}</td>
      <td class="num" style="font-size:14px">${r.avg.toFixed(2)}</td>
      <td class="num ${r.avg < hi - 0.005 ? "down" : "zero"}">${
        r.avg < hi - 0.005 ? (r.avg - hi).toFixed(2) : "—"}</td>
      <td><div class="meter" style="min-width:120px"><i style="width:${
        (8 + 92 * (r.avg - lo) / Math.max(hi - lo, 1e-9)).toFixed(0)}%"></i></div></td>
    </tr>`,
  });

  /* ---------- week leverage: where a point buys the most win probability ---------- */
  const pWin = eng.weekWins([myTeam], new Map()).get(myTeam);
  const lev = eng.weekLeverage(myTeam);
  const regIdx = W.map((_, i) => i).filter((i) => eng.regMask[i]);
  const levMax = Math.max(...regIdx.map((i) => lev[i]), 1e-9);
  const underdogWeeks = regIdx.filter((i) => pWin[i] < 0.5).length;
  const leverageStrip = `<div class="lev">
    ${regIdx.map((i) => {
      const o = eng.opp?.get(myTeam)?.[i];
      const p = pWin[i];
      return `<div class="lev-wk" style="--heat:${(lev[i] / levMax).toFixed(2)}"
        data-hint="Week ${W[i]}${o ? " vs " + esc(o) : " (all-play)"}: ${(p * 100).toFixed(0)}% to win. One extra point is worth ${(lev[i] * 100).toFixed(1)} percentage points here.">
        <div class="lev-w">WK ${W[i]}</div>
        <div class="lev-p ${p >= 0.5 ? "up" : "down"}">${(p * 100).toFixed(0)}%</div>
        <div class="lev-o">${o ? esc(o) : "all-play"}</div>
      </div>`;
    }).join("")}
  </div>
  <div class="note"><b>Leverage.</b> Brighter weeks are where one point moves your win
    probability most — the coin-flip games. ${underdogWeeks
      ? `You are the underdog in <b>${underdogWeeks}</b> of ${regIdx.length} weeks: variance helps
         there, so a boom-or-bust starter is worth more than his average says.`
      : `You are the favourite every week: protect the floor — steady starters over swingy ones.`}
  </div>`;

  const SIMS = 20000, SIGMA = 25;
  const hasSched = schedule.size > 0;
  const measured = eng.volatility?.measured ?? 0;
  const divCount = model.settings.divisionCount ?? 0;
  const divisionOf = new Map([...model.teams.values()].map((t) => [t.name, t.divisionId]));
  const divSeed = divCount > 1 && (window.__divSeed ?? false);
  const proj = projectSeason(eng, schedule, model.settings,
    { sims: SIMS, sigma: SIGMA, divisionSeeding: divSeed, divisionOf,
      records: window.__records ?? null });
  const maxTitle = Math.max(...proj.map((x) => x.titlePct), 1e-9);
  const seasonGrid = grid("seasonGrid", [
    { key: "name", label: "Team", value: (r) => r.team },
    { key: "wins", label: "Record", num: true, value: (r) => r.wins, hint: HINT.record },
    { key: "pf", label: "Points for", num: true, value: (r) => r.pointsFor, hint: HINT.pf },
    { key: "po", label: "Playoffs", num: true, value: (r) => r.playoffPct, hint: HINT.podds },
    { key: "bye", label: "First-round bye", num: true, value: (r) => r.byePct, hint: HINT.byeodds },
    { key: "title", label: "Title", num: true, value: (r) => r.titlePct, hint: HINT.title },
    { key: "swing", label: "Weekly swing", num: true, value: (r) => r.sigma ?? SIGMA, hint: HINT.swing },
    { key: "bar", label: "", sortable: false },
  ], proj, {
    sort: "title", dir: -1,
    row: (r) => `<tr${r.team === myTeam ? ' class="mine"' : ""}>
      <td${r.team === myTeam ? ' style="font-weight:700"' : ""}>${esc(r.team)}</td>
      <td class="num">${r.wins.toFixed(1)}&#8202;–&#8202;${r.losses.toFixed(1)}</td>
      <td class="num" style="color:var(--dim)">${r.pointsFor.toFixed(0)}</td>
      <td class="num ${r.playoffPct > 0.5 ? "up" : ""}">${pct(r.playoffPct)}</td>
      <td class="num" style="color:var(--dim)">${pct(r.byePct)}</td>
      <td class="num ${r.titlePct > 0.15 ? "up" : ""}">${pct(r.titlePct)}</td>
      <td class="num" style="color:var(--faint)">±${(r.sigma ?? SIGMA).toFixed(1)}</td>
      <td><div class="meter" style="min-width:90px"><i style="width:${
        (r.titlePct / maxTitle * 100).toFixed(0)}%"></i></div></td>
    </tr>`,
  });

  /* ---------- page ---------- */
  const me = proj.find((r) => r.team === myTeam);
  const myOffers = trades.filter((t) => t.sides.some((s) => s.team === myTeam));
  const obj = window.__objective ?? "title";
  const metric = (mode) => (t) => {
    const s = t.sides.find((x) => x.team === myTeam);
    if (mode === "title") return significant(t.odds, "title");
    if (mode === "wins") return s.win ?? null;
    return s.gain;
  };
  const pick = (m) => myOffers.reduce((a, t) => {
    const g = m(t);
    return g != null && g > (a?.g ?? -1e9) ? { g, t } : a;
  }, null);
  // On an average roster no title delta clears its own error, and a tile reading
  // "—  ·  none found" says there are no offers, which is false. Fall back to the
  // best Δ wins and say which number is on screen.
  let best = pick(metric(obj)), bestMode = obj, byWins = false;
  if (!best && obj === "title") {
    best = pick(metric("wins"));
    bestMode = "wins";
    byWins = !!best;
  }
  const bestText = !best ? "—" : bestMode === "title" ? `${best.g >= 0 ? "+" : "−"}${(Math.abs(best.g) * 100).toFixed(1)}pp`
    : bestMode === "wins" ? `${best.g >= 0 ? "+" : "−"}${Math.abs(best.g).toFixed(2)} W` : f2(best.g);
  const benchCount = eng.roster.get(myTeam).filter((i) => (rates.get(i) ?? 0) < 0.25).length;

  $("#boot").hidden = true;
  const app = $("#app");
  app.hidden = false;
  app.innerHTML = `
  <header class="masthead"><div class="wrap"><div class="mast-in">
    <div>
      <div class="eyebrow"><b>${esc(model.settings.name)}</b><span>·</span>
        <span>${model.teams.size} teams · ${eng.starters} starters ·
        weeks ${W[0]}–${W.at(-1)}</span></div>
      <h1>FF Slot <em>Machine</em></h1>
      <div class="mast-meta">${esc(myTeam.toUpperCase())} · LIVE FROM ESPN</div>
    </div>
    <div class="mast-right"><button class="ghost" id="theme">Light</button></div>
  </div>
  <div class="tiles">
    <div class="tile"><div class="k">Projected record</div>
      <div class="v">${me ? `${me.wins.toFixed(1)}–${me.losses.toFixed(1)}` : "—"}</div>
      <div class="s">${me ? pct(me.playoffPct) + " to make the playoffs" : ""}</div></div>
    <div class="tile hot"><div class="k">Offers for you</div>
      <div class="v">${myOffers.length}</div>
      <div class="s">${trades.length} league-wide</div></div>
    <div class="tile hot"><div class="k">Best available · ${esc(OBJECTIVES.find(([k]) => k === obj)?.[1] ?? "Championship")}</div>
      <div class="v">${bestText}</div>
      <div class="s">${!best ? "none found"
        : byWins ? "title odds inside simulation error · ranked by wins"
        : "via " + esc(best.t.sides.find((s) => s.team !== myTeam).team)}</div></div>
    <div class="tile"><div class="k">Trade chips</div>
      <div class="v">${benchCount}</div>
      <div class="s">players under 25% usage</div></div>
  </div></div></header>

  <div class="wrap">
    ${thisWeek}
    <section>
      <h2 class="secttl">${mineOnly ? "Offers for you" : "Every trade in the league"}</h2>
      <p class="sectsub">${shown.length} of ${trades.length} offers. Every side has to
        come out ahead. <b>Click a row</b> for the week-by-week detail and a pitch you
        can send. <b>Click a column heading</b> to sort; hover one to see what it means.</p>
      <div class="panel">
        <div class="bar">
          <div class="fld"><label for="obj" data-hint="${esc(HINT.objective)}"><span class="hint">Objective</span></label>
            <select id="obj">${OBJECTIVES.map(([k, lab]) =>
              `<option value="${k}"${(window.__objective ?? "title") === k ? " selected" : ""}>${lab}</option>`).join("")}
            </select></div>
          <div class="fld"><label for="who">Team</label><select id="who">
            ${eng.teams.map((t) => `<option${t === viewing ? " selected" : ""}>${esc(t)}</option>`).join("")}
            <option value="__all__"${viewing === "__all__" ? " selected" : ""}>All teams</option>
          </select></div>
          <div class="fld"><label>Shape</label><div class="chips" id="shapes">
            ${SHAPES.map((sh) =>
              `<button data-v="${sh}" aria-pressed="${F.shapes.has(sh)}">${
                sh === "three-way" ? "3-team" : sh}</button>`).join("")}
          </div></div>
          <div class="fld"><label for="mg">Min gain</label>
            <input type="range" id="mg" min="0" max="150" step="5" value="${F.minGain * 100}">
            <span class="readout" id="mgv">${F.minGain.toFixed(2)}</span></div>
          <div class="fld"><label>Only</label><div class="chips" id="only">
            <button data-v="bye" aria-pressed="${F.only.has("bye")}">Bye-driven</button>
            <button data-v="even" aria-pressed="${F.only.has("even")}">Even splits</button>
            ${marketFairChip(mkt, F.only.has("mktfair"))}
          </div></div>
          <div class="fld"><label for="q">Player</label>
            <input type="search" id="q" value="${esc(F.q)}" placeholder="filter by name…"
                   spellcheck="false"></div>
          <button class="ghost" id="reset">Reset</button>
        </div>
        ${tradeGrid}
      </div>
    </section>

    <section>
      <h2 class="secttl">${mineOnly && viewing !== myTeam
        ? esc(viewing) + "'s usage" : "Your least-used players"}</h2>
      <p class="sectsub">How often each player cracks the optimal lineup. Points parked
        on a bench are what another roster would actually start.</p>
      <div class="panel">${rosterGrid}</div>
    </section>

    ${streamingSection({ eng, model, team: mineOnly ? viewing : myTeam,
                         env: window.__env, grid, esc })}

    <section>
      <h2 class="secttl">Free agents worth adding — quiet vs contested</h2>
      <p class="sectsub">A full roster makes a pickup a swap, so every row names the drop.
        Gains are measured exactly like trades: the change in the best lineup you could
        field. <b>Crowd</b> is how many Sleeper leagues added him in the last day, and
        <b>Bid</b> is a suggested FAAB figure beside the most it is worth — a heuristic
        shown next to the gain, never part of it.</p>
      <div class="panel">${faGrid}</div>
    </section>

    ${dropSection(eng, model, { team: mineOnly ? viewing : myTeam, grid, avail: AV })}

    ${arbitrageSection(eng, model, mkt, { myTeam, grid })}

    ${assetsSection(eng, model, uv, { myTeam, grid, trades })}

    ${breakoutSection(eng, model, uv, { myTeam, grid })}

    <section>
      <h2 class="secttl">League strength</h2>
      <p class="sectsub">Each roster's ceiling — what it scores with its best lineup every
        week. Bench depth is excluded, so this is usable strength, not raw talent.</p>
      <div class="panel">${leagueGrid}</div>
    </section>

    <section>
      <h2 class="secttl">Projected season</h2>
      <p class="sectsub">If today's rosters played the season out, ${SIMS.toLocaleString()}
        times. Weekly scores are drawn around their projection rather than handed to
        whoever projects higher, so a narrow edge buys a fraction of a win.
        ${hasSched ? "Uses your real schedule."
          : "<b>No schedule available</b>, so records are an all-play share of the league."}
        ${measured >= 20
          ? `Weekly swing is <b>measured</b> from last season for ${measured} players.`
          : "Weekly swing falls back to an assumed ±25 points."}</p>
      <div class="panel">
        <div class="bar">
          ${divCount > 1 ? `<div class="fld"><label>Seeding</label><div class="chips" id="divseed">
            <button data-v="0" aria-pressed="${!divSeed}">By record</button>
            <button data-v="1" aria-pressed="${divSeed}">Division winners first</button>
          </div></div>
          <span class="readout" style="color:var(--faint)">${divCount} divisions. ESPN does
            not say which rule applies — pick yours; it moves the bye odds.</span>` : ""}
          <div class="fld"><label data-hint="${esc(HINT.calib)}"><span class="hint">Projections</span></label>
            <div class="chips" id="calib">
              <button data-v="1" aria-pressed="${window.__calibrate !== false}">Calibrated</button>
              <button data-v="0" aria-pressed="${window.__calibrate === false}">As published</button>
            </div></div>
          ${sourcesChips({ aggregate: window.__aggregate })}
          ${envChips(window.__env)}
        </div>
        ${window.__noSeason
          ? `<div class="note"><b>No season projection.</b> The regular season has no
              weeks left and ESPN did not report a complete set of standings, so there
              is nothing to seed a bracket from and any number here would be an
              artifact of the order the teams came back in.</div>`
          : seasonGrid}
        ${leverageStrip}
        <div class="note"><b>What this is not.</b> ${seasonNote(AV)} ${stackNote(measured)}
          Odds are to the nearest tenth; the simulation's own error is about
          ±${(100 * (proj[0]?.mcError ?? 0)).toFixed(2)} points.</div>
      </div>
    </section>

    ${calibrationSection(window.__calibState ?? {}, { grid, esc })}

    <footer>Live from ESPN. Nothing leaves your machine.
      <button class="ghost" id="refresh">Refresh data</button></footer>
  </div>`;

  /* ---------- behaviour ---------- */
  const rerender = () => render(eng, model, trades, myTeam, schedule);
  bindSort(app, rerender);
  initTooltips(app);
  bindEnvChips(app);

  app.querySelectorAll("#tradeGrid tr.tr-row").forEach((row) => {
    row.onclick = () => {
      const n = row.dataset.i;
      const det = app.querySelector(`tr.detail[data-for="${n}"]`);
      const wasOpen = row.classList.contains("open");
      app.querySelectorAll("#tradeGrid tr.tr-row.open").forEach((r) => {
        r.classList.remove("open");
        app.querySelector(`tr.detail[data-for="${r.dataset.i}"]`).hidden = true;
      });
      if (wasOpen) return;
      row.classList.add("open");
      const t = trades[Number(n)];
      if (!det.dataset.built) {
        det.firstElementChild.innerHTML = detailFor(t);
        det.dataset.built = "1";
        initTooltips(det);
        det.querySelectorAll(".copy").forEach((btn) => {
          btn.onclick = (ev) => {
            ev.stopPropagation();
            const other = t.sides.find((s) => s.team === btn.dataset.team);
            copy(pitchText(t, other), btn);
          };
        });
      }
      det.hidden = false;
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
  });

  app.querySelectorAll("#shapes button").forEach((b) => {
    b.onclick = () => {
      F.shapes.has(b.dataset.v) ? F.shapes.delete(b.dataset.v) : F.shapes.add(b.dataset.v);
      rerender();
    };
  });
  app.querySelectorAll("#only button").forEach((b) => {
    b.onclick = () => {
      F.only.has(b.dataset.v) ? F.only.delete(b.dataset.v) : F.only.add(b.dataset.v);
      rerender();
    };
  });
  app.querySelectorAll("#divseed button").forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.v === "1";
      if (on === (window.__divSeed === true)) return;
      await chrome.storage.local.set({ "ffsm.divSeed": on });
      location.reload();      // odds are computed at load; a rebuild is the honest path
    };
  });
  app.querySelectorAll("#calib button").forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.v === "1";
      if (on === (window.__calibrate !== false)) return;
      await chrome.storage.local.set({ "ffsm.calibrate": on });
      location.reload();      // projections feed everything; a rebuild is the honest path
    };
  });
  bindSourcesChips(app);
  $("#mg").oninput = (e) => {
    F.minGain = +e.target.value / 100;
    $("#mgv").textContent = F.minGain.toFixed(2);
    rerender();
  };
  let qt;
  $("#q").oninput = (e) => {
    clearTimeout(qt);
    const v = e.target.value.trim().toLowerCase();
    qt = setTimeout(() => { F.q = v; rerender(); }, 180);
  };
  $("#who").onchange = (e) => {
    window.__view = e.target.value;
    if (e.target.value !== "__all__")
      chrome.storage.local.set({ "ffsm.myTeam": e.target.value });
    rerender();
  };
  $("#obj").onchange = (e) => {
    window.__objective = e.target.value;
    chrome.storage.local.set({ "ffsm.objective": e.target.value });
    SORT.delete("tradeGrid");          // let the new objective set the default sort
    rerender();
  };
  $("#reset").onclick = () => {
    window.__filters = null;
    window.__view = myTeam;
    rerender();
  };
  $("#theme").onclick = () =>
    theme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  $("#refresh").onclick = async () => {
    // Refresh drops the cached league. It must not drop the user's choices, and it
    // must not drop anything they cannot get back: the calibration log accumulates
    // one week at a time and needs six of them, so a wiped log is six weeks of
    // waiting with no explanation. Its keys are dynamic (`ffsm.calib.{league}.{season}`),
    // so no literal list can name them — they are matched by prefix instead.
    const KEEP = ["ffsm.myTeam", "ffsm.objective", "ffsm.calibrate", "ffsm.divSeed",
                  "ffsm.aggregate", "ffsm.environment"];
    const all = await chrome.storage.local.get(null);
    const keep = Object.fromEntries(Object.entries(all).filter(([k]) =>
      KEEP.includes(k) || k.startsWith("ffsm.calib.")));
    await chrome.storage.local.clear();
    if (Object.keys(keep).length) await chrome.storage.local.set(keep);
    location.reload();
  };
}

(async function init() {
  document.documentElement.dataset.theme = "dark";
  const params = new URLSearchParams(location.search);
  const from = params.get("from");
  const ref = from ? parseLeagueUrl(from) : null;
  if (ref) start(ref);
  else askForLeague("Which league?");
})();
