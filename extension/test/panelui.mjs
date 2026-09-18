/**
 * The results screen, rendered.
 *
 * Every other test in this directory checks a function that returns a string. This one
 * checks the page those strings are assembled into, because the assembly is where the
 * tabs live and nothing else can see it: `platform.mjs` reads `panel.js` as text, and
 * text cannot tell you that `render()` throws on the Waivers tab.
 *
 * `panel.js` touches `document` while it evaluates, so the stub below has to exist
 * before the import. It is deliberately thin - `querySelector` answers null and
 * `querySelectorAll` answers empty, so every event binding is skipped and what the
 * test keeps is the markup. Each tab gets its own module instance, imported under a
 * distinct URL, because `init()` reads the tab out of `location.hash` exactly once.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../engine/search.js";
import { buildSlots, seatMask } from "../engine/lineup.js";
import { measureVolatility } from "../engine/league.js";
import { buildDistribution, attachCovariance } from "../engine/distribution.js";

let checks = 0, failures = 0;
const ok = (cond, what) => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(fs.readFileSync(path.join(here, "fixture.json")));

/* ---- a DOM thin enough to be obviously inert ---- */
let APP_HTML = "";
const el = (id) => ({
  id, hidden: false, textContent: "", style: {}, dataset: {}, children: [],
  classList: { add() {}, remove() {}, contains: () => false },
  setAttribute() {}, focus() {}, scrollIntoView() {}, appendChild() {},
  contains: () => false,
  querySelector: () => null,
  querySelectorAll: () => [],
  get innerHTML() { return id === "app" ? APP_HTML : ""; },
  set innerHTML(v) { if (id === "app") APP_HTML = v; },
});
const APP = el("app");
globalThis.window = globalThis;
globalThis.document = {
  documentElement: { dataset: {} },
  body: { appendChild() {} },
  activeElement: null,
  createElement: () => el("tip"),
  getElementById: () => null,
  querySelector: (s) => (s === "#app" ? APP : el(s)),
};
globalThis.location = { search: "", hash: "", reload() {} };
globalThis.chrome = { storage: { local: {
  async get() { return {}; }, async set() {}, async clear() {},
} } };

/* ---- the frozen league, built exactly as parity.mjs builds it ---- */
const SEASON = 2026;
const PRIOR = [1, 2, 3, 4, 5, 6, 7, 8];
const RES = [2, -2, 4, -4, 1, -1, 10, -10];       // actual minus projection, mean zero

const { slots, starters } = buildSlots(F.lineupSlotCounts);
const masks = F.pos.map((pos) => seatMask(F.eligibleSlots[pos], slots));
const model = {
  weeks: F.weeks,
  settings: {
    name: "Fixture League", currentWeek: F.weeks[0], faabBudget: 100, divisionCount: 0,
    regularSeasonWeeks: F.weeks.filter((w) => w <= 14),
    playoffWeeks: [15, 16, 17], playoffRoundWeeks: [[15], [16], [17]],
    playoffTeams: 6, playoffReseed: true, lineupSlotCounts: F.lineupSlotCounts,
  },
  players: new Map(F.pos.map((pos, i) => [i, {
    id: i, name: `p${i}`, pos, nfl: "X", eligibleSlots: F.eligibleSlots[pos],
    bye: F.weeks.find((w) => !(F.proj[i][F.weeks.indexOf(w)] > 0)) ?? 0,
    proj: Object.fromEntries(F.weeks.map((w, k) => [w, F.proj[i][k]])),
    // A prior season, so measureVolatility has something to measure. Without it
    // `eng.sigmaOf` is never set, `window.__dist` stays null, and every branch that
    // needs a weekly plan is skipped - which is how `SWAP_MIN is not defined` reached
    // a real league with this file passing.
    history: PRIOR.map((wk, k) => ({
      season: SEASON - 1, week: wk,
      proj: 10 + (i % 3),
      actual: 10 + (i % 3) + RES[k],
    })),
  }])),
  teams: new Map(F.teams.map((name, ti) =>
    [ti, { id: ti, name, roster: new Set(F.rosters[name]) }])),
};
const eng = new Engine(model, { starters }, new Map(F.pos.map((p, i) => [i, masks[i]])));
const trades = await eng.findTwoTeam(1, 0.05);
const MY = F.teams[0];

// Everything start() does between the engine and the first paint, so the page under
// test is the page a league actually gets rather than its most degraded form.
const vol = measureVolatility([...model.players.values()], SEASON - 1);
eng.setVolatility(vol);
attachCovariance(eng, model.players);
globalThis.window.__dist = buildDistribution(vol, model.players);

// A real schedule, because `gameplan` returns null without an opponent
// (`eng.opp?.get(team)?.[w]`, gameplan.js:91) - and a null plan is exactly the
// degraded shape that let `SWAP_MIN is not defined` through. Teams are paired off
// and rotated a week at a time, which is all the weekly plan needs.
const SCHEDULE = new Map(F.weeks.map((wk, k) => {
  const rot = [F.teams[0], ...F.teams.slice(1).map((_, i) =>
    F.teams[1 + (i + k) % (F.teams.length - 1)])];
  const pairs = [];
  for (let i = 0; i < rot.length / 2; i++) pairs.push([rot[i], rot[rot.length - 1 - i]]);
  return [wk, pairs];
}));
eng.setSchedule(SCHEDULE);
globalThis.window.__schedule = SCHEDULE;

const draw = async (tab) => {
  APP_HTML = "";
  globalThis.location.hash = tab ? `#${tab}` : "";
  // A fresh module instance per tab: init() reads the hash once, at evaluation.
  const mod = await import(`../panel.js?tab=${tab || "default"}`);
  mod.render(eng, model, trades, MY, new Map());
  return APP_HTML;
};

console.log(`fixture: ${F.teams.length} teams, ${trades.length} 1-for-1 trades`);

/* ---- 1. the shell ---- */
{
  const html = await draw("");
  ok(html.includes('role="tablist"'), "the page carries a tablist");
  const tabs = [...html.matchAll(/role="tab"/g)].length;
  ok(tabs === 5, `five tabs (${tabs})`);
  const selected = [...html.matchAll(/aria-selected="true"/g)].length;
  ok(selected === 1, `exactly one tab is selected (${selected})`);
  ok(/id="tab-home"[^>]*aria-selected="true"/s.test(html), "an empty hash opens Home");
  ok(/aria-selected="true"[^>]*tabindex="0"/s.test(html)
     && [...html.matchAll(/tabindex="-1"/g)].length === 4,
     "roving tabindex: the selected tab is the only one in the tab order");
  ok(/aria-controls="panel-home"/.test(html) && /id="panel-home"/.test(html),
     "the selected tab points at a panel that exists");
  ok(/role="tabpanel"[^>]*aria-labelledby="tab-home"/s.test(html),
     "…and the panel points back at its tab");
  ok(html.includes('id="theme"') && html.includes('id="refresh"'),
     "theme and refresh are outside the panel, so they exist on every tab");
  ok(!/<span class="n"[^>]*>(?!\s*\d)/.test(html), "every count badge holds a number");
  ok(/class="n" aria-hidden="true"/.test(html),
     "the count badge is hidden from the label, which names the number itself");
}

/* ---- 2. every tab renders, and renders only itself ---- */
{
  const ids = ["home", "trades", "waivers", "team", "league"];
  const seen = {};
  for (const id of ids) {
    const html = await draw(id);
    seen[id] = html;
    ok(html.length > 400, `${id} renders something (${html.length} chars)`);
    ok(new RegExp(`id="tab-${id}"[^>]*aria-selected="true"`, "s").test(html),
       `${id} is the selected tab when the hash asks for it`);
    ok([...html.matchAll(/id="panel-/g)].length === 1,
       `${id} builds one panel, not five`);
  }
  ok(seen.trades.includes('id="tradeGrid"'), "the trade table is on Trades");
  ok(!seen.waivers.includes('id="tradeGrid"'), "…and nowhere else");
  ok(seen.waivers.includes('id="faGrid"'), "the free agents are on Waivers");
  ok(seen.team.includes('id="rosterGrid"'), "the roster is on My team");
  ok(seen.league.includes('id="seasonGrid"') && seen.league.includes('id="leagueGrid"'),
     "the season and the standings are on League");
  ok(seen.home.includes("Best move") && seen.home.includes("Playoff odds"),
     "Home leads with the answer, not a table");
  // The weekly plan is the branch that is skipped whenever volatility, the
  // distribution or the schedule is missing - which is the shape this fixture used to
  // have, and the reason a ReferenceError in it reached a real league green.
  ok(/This week[\s\S]*?class="v [a-z]+">\d/.test(seen.home),
     "Home shows a real win probability, so the weekly-plan branch actually ran");
  ok(seen.team.includes("This week") && !seen.team.includes("no game scheduled"),
     "…and My team carries the plan itself, not its empty shape");
  ok(!seen.home.includes("<table"), "Home has no table on it at all");
  const gone = ids.filter((id) => !seen[id].includes('data-go="'));
  ok(gone.length === 4 && !gone.includes("home"),
     "only Home carries the explore links");
}

/* ---- 3. the trade table's default column set ---- */
{
  const page = await draw("trades");
  // Scope to the trade table itself: the collapsed evidence panels below it are tables
  // too, and counting their headers is how this test first told itself 42 columns.
  const html = page.slice(page.indexOf('id="tradeGrid"'),
                          page.indexOf("</table>", page.indexOf('id="tradeGrid"')));
  const heads = [...html.matchAll(/<th[^>]*data-sort="([a-z]+)"/g)].map((m) => m[1]);
  const th = [...html.matchAll(/<th[\s>]/g)].length;
  ok(th > 0 && th <= 9,
     `the default table is at most nine columns (${th}: ${heads.join(",")})`);
  for (const k of ["recv", "send", "partner", "gain", "theirs"])
    ok(heads.includes(k), `"${k}" is on the default surface`);
  for (const k of ["combined", "reg", "byehelp", "weeks", "shape"])
    ok(!heads.includes(k), `"${k}" is behind the Columns menu`);
  ok(heads.includes("dtitle"),
     "the objective's own column is never hidden - grid() cannot sort by a key it "
     + "cannot find, and a hidden sort column reads as insertion order");
  // Every row must emit exactly as many cells as there are headers, or the table skews.
  const row = html.match(/<tr class="tr-row[^"]*"[\s\S]*?<\/tr>/);
  const cells = row ? [...row[0].matchAll(/<td/g)].length : -1;
  ok(cells === th, `a row has one cell per column (${cells} cells v ${th} headers)`);
  ok(page.includes('id="cols"') && page.includes('id="colskey"') && page.includes('id="colsall"'),
     "the hidden columns are one click away, not gone");
}

/* ---- 4. the detail pane left the table ---- */
{
  const html = await draw("trades");
  ok(html.includes('id="tradeDetail"'), "the detail is a pane of its own");
  ok(!html.includes('<tr class="detail"'),
     "…and no longer a hidden row inside a horizontally scrolling table");
  ok(/tr class="tr-row[^"]*"[^>]*tabindex="0"/s.test(html)
     && /role="button"/.test(html) && /aria-expanded="false"/.test(html),
     "a trade row can be reached and opened from the keyboard");
  const css = fs.readFileSync(path.join(here, "..", "panel.css"), "utf8");
  ok(!css.includes("position:sticky;left:0"),
     "the sticky hack the old placement needed is gone from the stylesheet");
  ok((css.match(/^\.det\{/gm) || []).length === 1,
     "…and .det is declared once, not twice");
}

/* ---- 5. the evidence sections are hidden, not deleted ---- */
{
  const trades_ = await draw("trades");
  const waivers = await draw("waivers");
  const league = await draw("league");
  ok(trades_.includes("Buy low, sell high") && trades_.includes("<details class=\"more\""),
     "the market view is on Trades, behind a disclosure");
  for (const [html, title, where] of [
    [waivers, "Drop candidates", "Waivers"],
    [waivers, "Streaming planner", "Waivers"],
    [waivers, "Breakout watch", "Waivers"],
    [league, "Calibration", "League"],
  ]) ok(html.includes(title), `"${title}" is still reachable, on ${where}`);
  ok(waivers.indexOf("faGrid") < waivers.indexOf("Drop candidates"),
     "the answer comes before the argument about it");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PANELUI OK");
