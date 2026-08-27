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

    // Free agents are optional: a failure here should not cost you the trade search.
    try {
      say("reading the free-agent pool…");
      const fas = await loadFreeAgents(ref, model.weeks);
      for (const fa of fas) model.players.set(fa.id, fa);
      say(`  ${fas.length} available players`, "ok");
    } catch (e) {
      say(`  free agents unavailable (${e.message}) - continuing without them`, "err");
    }

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
    try {
      schedule = await loadSchedule(ref, model.teams);
      say(`schedule: ${schedule.size} weeks of real matchups`, "ok");
    } catch {
      say("schedule unavailable - season projection will use all-play", "err");
    }
    window.__schedule = schedule;

    // Volatility is measured from last season's actuals, which ESPN returns in the
    // same payload as the projections. Falling back to a guessed constant would
    // change every number in the season projection.
    const vol = measureVolatility([...model.players.values()], ref.seasonId - 1);
    if (vol.measured >= 20) {
      eng.setVolatility(vol);
      const posText = [...vol.byPos].sort()
        .map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ");
      say(`volatility measured on ${vol.measured} players: ${posText}`, "ok");
      say(`your team's weekly spread: ±${
        (eng.teamSigma(myTeam).reduce((a, b) => a + b, 0) / model.weeks.length).toFixed(1)} pts`, "ok");
    } else {
      say(`only ${vol.measured} players have prior-season history - `
        + `season projection will assume ±25 pts`, "err");
    }
    window.__vol = vol;
    say("searching 1-for-1…");
    const one = eng.findTwoTeam(1, 0.05, (n, tot) => progress(n / tot));
    say(`  ${one.length} mutually beneficial`, "ok");

    say("searching three-way…");
    const three = eng.findThreeWay(0.05, (n, tot) => progress(n / tot));
    say(`  ${three.length} cycles`, "ok");

    const trades = [...dedupe(one, 3), ...dedupe(three, 3)]
      .sort((a, b) => b.total - a.total);
    say(`${trades.length} offers after dedupe`, "ok");

    render(eng, model, trades, myTeam, schedule);
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
  optimal:"What this roster would score each week if it started its best possible lineup every week.",
  fagain: "How much your best lineup improves if you add this player and drop the one shown. A free agent who would never start is worth nothing, however good his projection looks.",
  owned:  "Share of ESPN leagues where this player is rostered. A low number with a real gain is the most likely to still be available.",
  record: "Average wins and losses across every simulated season. Fractional because it is an average of many outcomes, not a prediction of one.",
  pf:     "Average total points scored over the regular season. Used as the seeding tiebreak, as in most ESPN leagues.",
  podds:  "Share of simulated seasons where this team qualifies for the playoffs.",
  byeodds:"Share of simulated seasons where this team earns a first-round bye. Worth far more than it looks: it skips an elimination game.",
  title:  "Share of simulated seasons where this team wins the league.",
  swing:  "How far this roster's weekly score typically lands from its projection, measured from last season's results for the players it starts. A lower number means a more predictable team - which helps a favourite and hurts an underdog.",
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
function usageBars(strip, proj, thin, weeks) {
  const max = Math.max(...proj, 1);
  return `<div class="bars">${strip.map((v, i) => {
    const h = v === -1 ? 12 : Math.max(8, proj[i] / max * 100);
    return `<i class="${v === 1 ? "on" : v === -1 ? "bye" : ""}${thin && thin[i] ? " thin" : ""}"
      style="height:${h.toFixed(0)}%" title="Wk ${weeks[i]}: ${
        v === -1 ? "bye" : proj[i].toFixed(1) + (v === 1 ? " · starts" : " · benched")}"></i>`;
  }).join("")}</div>`;
}

function render(eng, model, trades, myTeam, schedule = window.__schedule ?? new Map()) {
  const rates = eng.startRates();
  const W = eng.weeks;
  const nm = (i) => model.players.get(eng.ids[i]).name;
  const pos = (i) => model.players.get(eng.ids[i]).pos;
  const tag = (i) => `<span class="pos" data-p="${esc(pos(i))}">${esc(pos(i))}</span>`;
  const pkg = (ids) => ids.map(i => `${esc(nm(i))} ${tag(i)}`).join('<span class="plus">+</span>');

  /* One panel per side, plus the case for each partner. */
  function detailFor(t) {
    const ex = eng.explain(t);
    const panels = t.sides.map(side => {
      const d = ex[side.team];
      const li = [];
      for (const a of d.acquired)
        li.push(`<li><b>${esc(nm(a.i))}</b> would start <b>${a.startsHere}</b> of ${W.length}
                 weeks here, versus ${a.startsThere} where he is now.</li>`);
      for (const x of d.sent)
        li.push(`<li>Gives up ${esc(nm(x.i))} — ${x.wasStarting} starts.</li>`);
      for (const x of d.displaced)
        li.push(`<li class="b">${esc(nm(x.i))} loses ${-x.delta} starts.</li>`);
      for (const x of d.promoted)
        li.push(`<li class="g">${esc(nm(x.i))} gains ${x.delta} starts.</li>`);
      return `<div><h4>${esc(side.team)}${side.team === myTeam ? " — you" : ""}</h4>
        <div class="hd ${cls(side.gain)}">${f2(side.gain)}<span
          style="font-size:12px;color:var(--faint)">/wk</span>
          <span style="font-size:12px;color:var(--dim)">· reg ${f2(side.reg)}
          · playoffs ${f2(side.playoff)}</span></div>
        <ul>${li.join("")}</ul>${deltaBars(side.weekly, W)}</div>`;
    }).join("");

    const cases = t.sides.filter(s => s.team !== myTeam).map(other => {
      const d = ex[other.team];
      const rows = d.acquired.map(a => `
        <div class="cmp-name">${esc(nm(a.i))} ${tag(a.i)}
          <span class="tag${a.startsHere > a.startsThere ? " g" : ""}">${
            a.startsThere} &rarr; ${a.startsHere} starts</span></div>
        <div class="cmp-lab">Where he<br>is now</div>
        <div>${usageBars(a.now, a.proj, null, W)}</div>
        <div class="cmp-lab">With ${esc(other.team)}<br>after</div>
        <div>${usageBars(a.after, a.proj, d.thin, W)}</div>`).join("");
      const line = d.acquired.map(a => a.startsHere > a.startsThere
        ? `<b>${esc(nm(a.i))}</b> starts ${a.startsThere} of ${W.length} weeks where he is
           now — he'd start <b>${a.startsHere}</b> for ${esc(other.team)}.`
        : `<b>${esc(nm(a.i))}</b> starts ${a.startsHere} of ${W.length} weeks for ${esc(other.team)}.`
        ).join(" ");
      return `<div class="pitch">
        <div class="pitch-hd"><h4>The case for ${esc(other.team)}</h4></div>
        <p class="pitch-say">${line}</p>
        <div class="cmp">${rows}</div>
        <div class="legend">
          <span><i class="swatch" style="background:var(--accent)"></i> starts</span>
          <span><i class="swatch" style="background:var(--line-hi)"></i> benched</span>
          <span><i class="swatch" style="background:var(--warn);height:3px"></i> their thin week</span>
          <span style="color:var(--dim)">Bar height is his weekly projection.</span>
        </div></div>`;
    }).join("");
    return `<div class="det">${panels}${cases}</div>`;
  }

  const viewing = window.__view ?? myTeam;
  const mineOnly = viewing !== "__all__";
  const shown = trades
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !mineOnly || t.sides.some(s => s.team === viewing));

  const body = shown.slice(0, 60).map(({ t, i: n }) => {
    // With a team selected the row is always written from that team's side. With
    // "all teams" there is no "you", so each side is labelled by name instead.
    const me = t.sides.find(s => s.team === viewing) ?? t.sides[0];
    const others = t.sides.filter(s => s !== me);
    return `<tr class="tr-row${me.team === myTeam ? " mine" : ""}" data-i="${n}">
      <td class="rank"><span class="car">&#9656;</span></td>
      <td class="num" style="white-space:nowrap">${esc(t.shape)}</td>
      <td>${mineOnly ? "" : `<div class="side-l">${esc(me.team)}</div>`}
          <div class="pkg">${pkg(me.received)}</div></td>
      <td><div class="pkg">${pkg(me.sent)}</div></td>
      <td style="color:var(--dim)">${others.map(o => esc(o.team)).join(" + ")}</td>
      <td class="num ${cls(me.gain)}">${f2(me.gain)}</td>
      <td class="num ${cls(me.reg)}">${f2(me.reg)}</td>
      <td class="num ${cls(me.playoff)}">${f2(me.playoff)}</td>
      <td class="num" style="color:var(--dim)">${others.map(o => f2(o.gain)).join(" / ")}</td>
    </tr>
    <tr class="detail" data-for="${n}" hidden><td colspan="9"></td></tr>`;
  }).join("");

  const chips = eng.roster.get(myTeam)
    .map(i => ({ i, r: rates.get(i) ?? 0 }))
    .sort((a, b) => a.r - b.r)
    .map(({ i, r }) => {
      const p = model.players.get(eng.ids[i]);
      return `<tr><td style="font-weight:600">${esc(p.name)}</td><td>${tag(i)}</td>
        <td class="nfl">${esc(p.nfl)}</td><td class="num" style="color:var(--faint)">${p.bye || "—"}</td>
        <td class="num ${r < .35 ? "down" : r > .8 ? "up" : ""}">${(r * 100).toFixed(0)}%</td>
        <td><div class="meter"><i style="width:${(r * 100).toFixed(0)}%"></i></div></td></tr>`;
    }).join("");

  const upgrades = eng.freeAgents.length
    ? eng.freeAgentUpgrades(myTeam, { minGain: 0.05, limit: 25 }) : [];
  const fa = upgrades.map((u) => {
    const p = model.players.get(eng.ids[u.fa]);
    const d = model.players.get(eng.ids[u.drop]);
    return `<tr>
      <td style="font-weight:600">${esc(p.name)}</td>
      <td>${tag(u.fa)}</td>
      <td class="nfl">${esc(p.nfl)}</td>
      <td style="color:var(--dim)">${esc(d.name)}</td>
      <td class="num ${cls(u.gain)}">${f2(u.gain)}</td>
      <td class="num ${cls(u.reg)}">${f2(u.reg)}</td>
      <td class="num ${cls(u.playoff)}">${f2(u.playoff)}</td>
      <td class="num" style="color:var(--faint)">${p.owned != null ? p.owned + "%" : "—"}</td>
    </tr>`;
  }).join("");

  const SIMS = 20000, SIGMA = 25;
  const hasSched = schedule.size > 0;
  const measured = eng.volatility?.measured ?? 0;
  const divCount = model.settings.divisionCount ?? 0;
  const divisionOf = new Map([...model.teams.values()].map(t => [t.name, t.divisionId]));
  const divSeed = divCount > 1 && (window.__divSeed ?? false);
  const proj = projectSeason(eng, schedule, model.settings,
    { sims: SIMS, sigma: SIGMA, divisionSeeding: divSeed, divisionOf });
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const season = proj.map((r, i) => `<tr${r.team === myTeam ? ' class="mine"' : ""}>
      <td class="rank">${i + 1}</td>
      <td${r.team === myTeam ? ' style="font-weight:700"' : ""}>${esc(r.team)}</td>
      <td class="num">${r.wins.toFixed(1)}&#8202;–&#8202;${r.losses.toFixed(1)}</td>
      <td class="num" style="color:var(--dim)">${r.pointsFor.toFixed(0)}</td>
      <td class="num ${r.playoffPct > .5 ? "up" : ""}">${pct(r.playoffPct)}</td>
      <td class="num" style="color:var(--dim)">${pct(r.byePct)}</td>
      <td class="num ${r.titlePct > .15 ? "up" : ""}">${pct(r.titlePct)}</td>
      <td class="num" style="color:var(--faint)">±${(r.sigma ?? SIGMA).toFixed(1)}</td>
      <td><div class="meter" style="min-width:90px"><i style="width:${
        (r.titlePct / Math.max(...proj.map(x => x.titlePct)) * 100).toFixed(0)}%"></i></div></td>
    </tr>`).join("");

  const table = eng.teams
    .map(t => ({ t, avg: eng.baseline.get(t).reduce((a, b) => a + b, 0) / eng.NW }))
    .sort((a, b) => b.avg - a.avg);
  const hi = table[0].avg, lo = table.at(-1).avg;
  const standings = table.map((s, i) => `<tr${s.t === myTeam ? ' class="mine"' : ""}>
      <td class="rank">${i + 1}</td>
      <td${s.t === myTeam ? ' style="font-weight:700"' : ""}>${esc(s.t)}</td>
      <td class="num">${s.avg.toFixed(2)}</td>
      <td><div class="meter"><i style="width:${(8 + 92 * (s.avg - lo) / Math.max(hi - lo, 1e-9)).toFixed(0)}%"></i></div></td>
    </tr>`).join("");

  $("#boot").hidden = true;
  const app = $("#app");
  app.hidden = false;
  app.innerHTML = `
    <div class="wrap" style="padding-top:26px">
      <h1 style="font-family:var(--serif);font-weight:400;font-size:42px;margin:0 0 4px">
        FF Slot <em style="font-style:italic;color:var(--accent)">Machine</em></h1>
      <p class="mast-meta">${esc(model.settings.name.toUpperCase())} ·
        ${esc(myTeam.toUpperCase())} · ${model.teams.size} TEAMS ·
        ${eng.starters} STARTERS · LIVE FROM ESPN</p>

      <h2 class="secttl">${mineOnly ? "Offers for you" : "Every trade in the league"}</h2>
      <p class="sectsub">${shown.length} offer${shown.length === 1 ? "" : "s"},
        ranked by gain; every side has to come out ahead.
        <b>Click any row</b> for the week-by-week detail and the case to make to your
        partner. Hover a column heading to see what it measures.</p>
      <div class="panel">
        <div class="meter">
          <div class="fld"><label for="who">Viewing as</label>
            <select id="who">
              ${eng.teams.map(t => `<option${t === viewing ? " selected" : ""}>${esc(t)}</option>`).join("")}
              <option value="__all__"${viewing === "__all__" ? " selected" : ""}>All teams</option>
            </select></div>
          <span class="readout" style="color:var(--faint)">${
            mineOnly ? "showing only trades involving " + esc(viewing) : "showing the whole league"}</span>
        </div>
        <div class="scroll"><table id="trades">
        <thead><tr><th></th>${th("Shape", "shape", "num")}
          ${th(mineOnly ? "You receive" : "Receives", "recv")}
          ${th(mineOnly ? "You send" : "Sends", "send")}${th("Partner", "partner")}
          ${th(mineOnly ? "Your gain" : "Gain", "gain", "num")}
          ${th("Reg. season", "reg", "num")}
          ${th("Playoffs", "po", "num")}${th("Partner gain", "theirs", "num")}</tr></thead>
        <tbody>${body || '<tr><td colspan="9"><div class="empty"><b>No trades found</b>Nothing helps both sides right now.</div></td></tr>'}</tbody>
      </table></div></div>

      <h2 class="secttl">${mineOnly ? "Your least-used players" : "Least-used players"}</h2>
      <p class="sectsub">Points parked on your bench are what another roster would
        actually start.</p>
      <div class="panel"><div class="scroll"><table>
        <thead><tr><th>Player</th><th>Pos</th><th>NFL</th>${th("Bye", "bye", "num")}
          ${th("Starts", "starts", "num")}<th></th></tr></thead>
        <tbody>${chips}</tbody></table></div></div>

      <h2 class="secttl">Free agents worth adding</h2>
      <p class="sectsub">A full roster means a pickup is really a swap, so each row
        shows who to drop. Gains are measured the same way as trades: the change in
        your best possible starting lineup.</p>
      <div class="panel"><div class="scroll"><table>
        <thead><tr><th>Add</th><th>Pos</th><th>NFL</th><th>Drop</th>
          ${th("Gain", "fagain", "num")}${th("Reg. season", "reg", "num")}
          ${th("Playoffs", "po", "num")}${th("Owned", "owned", "num")}</tr></thead>
        <tbody>${fa || '<tr><td colspan="8"><div class="empty"><b>Nothing on waivers helps</b>Your worst starter already beats the pool.</div></td></tr>'}</tbody>
      </table></div></div>

      <h2 class="secttl">League strength</h2>
      <div class="panel"><div class="scroll"><table>
        <thead><tr><th>#</th><th>Team</th>${th("Optimal pts/wk", "optimal", "num")}<th></th></tr></thead>
        <tbody>${standings}</tbody></table></div></div>

      <h2 class="secttl">Projected season</h2>
      <p class="sectsub">If today's rosters played the whole season out. Each week is
        drawn ${SIMS.toLocaleString()} times as a random result around its projection
        rather than awarding the win to whoever projects higher, so a narrow edge buys
        a small share of a win rather than a certain one.
        ${hasSched ? "Uses your real schedule."
          : "<b>No schedule available</b>, so records are an all-play share of the league rather than your actual matchups."}
        ${measured >= 20
          ? `How far a week lands from its projection is <b>measured</b> from last
             season's results for ${measured} players, not assumed, so a roster of
             steady players is correctly less swingy than a boom-or-bust one.`
          : "Too little prior-season history, so weekly spread falls back to an assumed ±25 points."}</p>
      <div class="panel">
        ${divCount > 1 ? `<div class="bar">
          <div class="fld"><label>Seeding</label><div class="chips" id="divseed">
            <button data-v="0" aria-pressed="${!divSeed}">By record</button>
            <button data-v="1" aria-pressed="${divSeed}">Division winners first</button>
          </div></div>
          <span class="readout" style="color:var(--faint)">Your league has
            ${divCount} divisions. ESPN does not report which rule it uses, so pick
            the one your league actually applies &mdash; it moves the bye odds.</span>
        </div>` : ""}
        <div class="scroll"><table>
        <thead><tr><th>#</th><th>Team</th>${th("Record", "record", "num")}
          ${th("Points for", "pf", "num")}${th("Playoffs", "podds", "num")}
          ${th("First-round bye", "byeodds", "num")}${th("Title", "title", "num")}
          ${th("Weekly swing", "swing", "num")}<th></th></tr></thead>
        <tbody>${season}</tbody></table></div>
        <div class="note"><b>What this is not.</b> Rosters are frozen: no waiver
          moves, injuries or trades. ${measured >= 20
            ? `Weekly swing is measured per player from last season and assumes their
               results are independent - real correlation, like a quarterback and
               receiver from the same NFL team, would make a roster swingier than
               shown.`
            : `Weekly scatter is assumed at ±${SIGMA} points, the single biggest lever
               on every number here.`}
          Odds are shown to the nearest tenth because the simulation's own error is
          about ±${(100 * (proj[0]?.mcError ?? 0)).toFixed(2)} points.</div>
      </div>

      <footer style="padding:34px 0 60px;color:var(--faint);font-family:var(--mono);font-size:11px">
        Live from ESPN. Nothing leaves your machine.
        <button class="btn ghost2" id="refresh" style="margin-left:14px">Refresh data</button>
      </footer>
    </div>`;

  // Accordion: build the detail only when a row is first opened - explain() re-solves
  // lineups, and doing it for 60 rows up front would stall the page.
  app.querySelectorAll("#trades tr.tr-row").forEach((row) => {
    row.onclick = () => {
      const n = row.dataset.i;
      const det = app.querySelector(`tr.detail[data-for="${n}"]`);
      const wasOpen = row.classList.contains("open");
      // Only one detail at a time - several open at once buries the table.
      app.querySelectorAll("#trades tr.tr-row.open").forEach((r) => {
        r.classList.remove("open");
        app.querySelector(`tr.detail[data-for="${r.dataset.i}"]`).hidden = true;
      });
      if (wasOpen) return;
      row.classList.add("open");
      if (!det.dataset.built) {
        det.firstElementChild.innerHTML = detailFor(trades[Number(n)]);
        det.dataset.built = "1";
        initTooltips(det);
      }
      det.hidden = false;
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
  });
  initTooltips(app);
  document.querySelectorAll("#divseed button").forEach((b) => {
    b.onclick = () => {
      window.__divSeed = b.dataset.v === "1";
      render(eng, model, trades, myTeam, schedule);
    };
  });
  $("#who").onchange = (e) => {
    window.__view = e.target.value;
    if (e.target.value !== "__all__") chrome.storage.local.set({ "ffsm.myTeam": e.target.value });
    render(eng, model, trades, e.target.value === "__all__" ? myTeam : e.target.value, schedule);
  };
  $("#refresh").onclick = async () => {
    const keep = (await chrome.storage.local.get("ffsm.myTeam"))["ffsm.myTeam"];
    await chrome.storage.local.clear();
    if (keep) await chrome.storage.local.set({ "ffsm.myTeam": keep });
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
