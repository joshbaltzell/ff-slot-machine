/**
 * Loads the league the user is looking at, runs the search, renders the report.
 *
 * Everything runs locally: no backend, no analytics, no league data leaves the
 * machine. The only network calls are to ESPN's own read API, with the session the
 * browser already has.
 */
import { parseLeagueUrl, loadLeague, mySwid, SLOT_LABEL } from "./engine/league.js";
import { buildSlots, seatMask } from "./engine/lineup.js";
import { Engine, dedupe } from "./engine/search.js";

const $ = (s) => document.querySelector(s);
const steps = $("#steps");
const say = (text, cls = "") => {
  const d = document.createElement("div");
  d.className = cls; d.textContent = text;
  steps.appendChild(d); steps.scrollTop = steps.scrollHeight;
  return d;
};
const progress = (frac) => { $("#bootbar").style.width = `${Math.round(frac * 100)}%`; };

const CACHE_HOURS = 12;

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
    say(`league ${ref.leagueId}, season ${ref.seasonId}`);
    const model = await loadLeague(ref, (done, total, label) => {
      progress(done / total);
      if (done === 0) say(`reading ${label}…`);
      else if (done % 3 === 0 || done === total) say(`  ${label} (${done}/${total})`);
    });

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

    const { slots, starters } = buildSlots(s.lineupSlotCounts);
    const masks = new Map();
    for (const [id, p] of model.players) masks.set(id, seatMask(p.eligibleSlots, slots));

    const unplayable = [...model.players.values()].filter(p => !masks.get(p.id));
    if (unplayable.length)
      say(`${unplayable.length} rostered players fit no starting slot (IR/taxi)`, "");

    say("building engine…");
    const eng = new Engine(model, { starters }, masks);
    say(`baseline built for ${eng.teams.length} teams`, "ok");

    const swid = await mySwid();
    let myTeam = null;
    if (ref.teamId) myTeam = model.teams.get(ref.teamId)?.name ?? null;
    if (!myTeam && swid) {
      for (const t of model.teams.values())
        if ((t.owners ?? []).some(o => o === swid)) myTeam = t.name;
    }
    myTeam = myTeam ?? eng.teams[0];
    say(`your team: ${myTeam}`, "ok");

    say("searching 1-for-1…");
    const one = eng.findTwoTeam(1, 0.05, (n, tot) => progress(n / tot));
    say(`  ${one.length} mutually beneficial`, "ok");

    say("searching three-way…");
    const three = eng.findThreeWay(0.05, (n, tot) => progress(n / tot));
    say(`  ${three.length} cycles`, "ok");

    const trades = [...dedupe(one, 3), ...dedupe(three, 3)]
      .sort((a, b) => b.total - a.total);
    say(`${trades.length} offers after dedupe`, "ok");

    render(eng, model, trades, myTeam);
  } catch (err) {
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

function render(eng, model, trades, myTeam) {
  const rates = eng.startRates();
  const name = (i) => model.players.get(eng.ids[i]).name;
  const rows = trades.slice(0, 60).map((t) => {
    const me = t.sides.find(s => s.team === myTeam) ?? t.sides[0];
    const others = t.sides.filter(s => s !== me);
    return `<tr>
      <td>${t.shape}</td>
      <td><b>${me.received.map(name).join(" + ")}</b></td>
      <td>${me.sent.map(name).join(" + ")}</td>
      <td>${others.map(o => o.team).join(" + ")}</td>
      <td class="num ${me.gain > 0 ? "up" : "down"}">${me.gain >= 0 ? "+" : "−"}${Math.abs(me.gain).toFixed(2)}</td>
      <td class="num">${me.reg >= 0 ? "+" : "−"}${Math.abs(me.reg).toFixed(2)}</td>
      <td class="num">${me.playoff >= 0 ? "+" : "−"}${Math.abs(me.playoff).toFixed(2)}</td>
      <td class="num" style="color:var(--dim)">${others.map(o => (o.gain >= 0 ? "+" : "−") + Math.abs(o.gain).toFixed(2)).join(" / ")}</td>
    </tr>`;
  }).join("");

  const chips = eng.roster.get(myTeam)
    .map(i => ({ i, r: rates.get(i) ?? 0 }))
    .sort((a, b) => a.r - b.r)
    .map(({ i, r }) => {
      const p = model.players.get(eng.ids[i]);
      return `<tr><td>${p.name}</td><td><span class="pos">${p.pos}</span></td>
        <td class="nfl">${p.nfl}</td><td class="num">${p.bye || "—"}</td>
        <td class="num ${r < .35 ? "down" : r > .8 ? "up" : ""}">${(r * 100).toFixed(0)}%</td></tr>`;
    }).join("");

  const standings = eng.teams
    .map(t => ({ t, avg: eng.baseline.get(t).reduce((a, b) => a + b, 0) / eng.NW }))
    .sort((a, b) => b.avg - a.avg)
    .map((s, i) => `<tr><td class="rank">${i + 1}</td>
      <td${s.t === myTeam ? ' style="font-weight:700"' : ""}>${s.t}</td>
      <td class="num">${s.avg.toFixed(2)}</td></tr>`).join("");

  $("#boot").hidden = true;
  const app = $("#app");
  app.hidden = false;
  app.innerHTML = `
    <div class="wrap" style="padding-top:26px">
      <h1 style="font-family:var(--serif);font-weight:400;font-size:42px;margin:0 0 4px">
        Trade <em style="font-style:italic;color:var(--accent)">Finder</em></h1>
      <p class="mast-meta">${model.settings.name.toUpperCase()} · ${myTeam.toUpperCase()}
        · ${model.teams.size} TEAMS · ${eng.starters} STARTERS · LIVE FROM ESPN</p>

      <h2 class="secttl">Offers for you</h2>
      <p class="sectsub">Ranked by your gain. Both sides must come out ahead.</p>
      <div class="panel"><div class="scroll"><table>
        <thead><tr><th>Shape</th><th>You receive</th><th>You send</th><th>Partner</th>
          <th class="num">Your gain</th><th class="num">Reg</th><th class="num">Playoffs</th>
          <th class="num">Partner gain</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8"><div class="empty">No mutually beneficial trades found.</div></td></tr>'}</tbody>
      </table></div></div>

      <h2 class="secttl">Your least-used players</h2>
      <p class="sectsub">How often each would crack your optimal lineup. Low numbers are trade chips.</p>
      <div class="panel"><div class="scroll"><table>
        <thead><tr><th>Player</th><th>Pos</th><th>NFL</th><th class="num">Bye</th>
          <th class="num">Starts</th></tr></thead><tbody>${chips}</tbody></table></div></div>

      <h2 class="secttl">League strength</h2>
      <div class="panel"><div class="scroll"><table>
        <thead><tr><th>#</th><th>Team</th><th class="num">Optimal pts/wk</th></tr></thead>
        <tbody>${standings}</tbody></table></div></div>

      <footer style="padding:34px 0 60px;color:var(--faint);font-family:var(--mono);font-size:11px">
        Live from ESPN. Nothing leaves your machine.
        <button class="btn ghost2" id="refresh" style="margin-left:14px">Refresh data</button>
      </footer>
    </div>`;
  $("#refresh").onclick = async () => {
    await chrome.storage.local.clear();
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
