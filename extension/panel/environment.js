/**
 * Every line of Phase 7's UI, kept out of panel.js so the merge stays mechanical.
 *
 * `panel.js` gets one import, one PHASES entry, one block in start() and three
 * one-line call sites in render(). `grid` and `esc` are handed in at the call site
 * rather than imported: panel.js exports nothing and has a top-level init, so
 * importing from it would run the page twice.
 */
import { loadVegas } from "../engine/sources/vegas.js";
import { loadWeather } from "../engine/sources/weather.js";
import { applyEnvironment, avgImplied } from "../engine/environment.js";
import { streamPlan } from "../engine/streaming.js";

const esc0 = (v) => String(v).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const HINT_ENV = {
  env: "What the betting market and the forecast say about this week's game, as a "
     + "multiplier on the projection. Implied team totals come from the spread and "
     + "the over/under; wind and rain apply only to open-roof stadiums. Only this "
     + "week and next are moved - no line exists past that.",
  chip: "On, each projection for this week and next is scaled by its game's implied "
      + "team total and, outdoors, by the wind and rain at kickoff. Defences are "
      + "priced off the opponent's total. Off leaves projections exactly as they "
      + "arrived. Nothing here touches any other week or any lineup decision.",
  window: "Projected points across the whole planning window. A player on bye "
        + "inside the window is scored zero for that week, which is the honest "
        + "comparison against someone who plays all three.",
  owner: "Whether this player is already on your roster or sitting in the free-agent "
       + "pool.",
};

/* ============ loading ============ */

/**
 * Load the lines and the forecast and apply them, or degrade to identity.
 *
 * Nothing thrown in here escapes: the trade search is the product, and a dead odds
 * feed must cost a log line, not the run.
 */
export async function environmentStep(model, seasonId, say) {
  const env = { on: true, weeks: [], byPlayer: new Map(), vegas: new Map(),
                weather: new Map(), games: 0, note: "", state: "skip" };
  try {
    env.on = (await chrome.storage.local.get("ffsm.environment"))["ffsm.environment"] ?? true;
  } catch { /* storage unavailable; default on */ }

  const w0 = model.settings.currentWeek ?? model.weeks[0];
  env.weeks = [w0, w0 + 1].filter((w) => model.weeks.includes(w));

  if (!env.on) {
    say("game environment off - projections used as they arrived", "");
    env.note = "off";
    return env;
  }
  if (!env.weeks.length) {
    say("no weeks left to adjust - game environment skipped", "");
    env.note = "no weeks";
    return env;
  }

  try {
    env.vegas = await loadVegas(seasonId, env.weeks);
    const now = env.vegas.get(env.weeks[0]) ?? new Map();
    env.games = now.size / 2;
    if (!env.games) throw new Error("no games priced");
    const avg = avgImplied(now);
    say(`Vegas: ${env.games} games priced for week ${env.weeks[0]} `
      + `(avg total ${(avg * 2).toFixed(1)})`, "ok");
  } catch (e) {
    // `||`, not `??`: an Error with an empty message is still an Error, and `??`
    // would print "unavailable ()" rather than falling through to the object.
    say(`Vegas lines unavailable (${e.message || e}) - projections unchanged`, "err");
    env.note = "no lines";
    env.state = "warn";
    return env;
  }

  try {
    env.weather = await loadWeather(env.vegas.get(env.weeks[0]) ?? new Map());
    const stadiums = [...new Set(env.weather.values())];
    const worst = stadiums.reduce((m, r) => Math.max(m, r.wind ?? 0), 0);
    say(`weather: ${stadiums.length} open-roof games, worst wind ${worst.toFixed(0)} mph`, "ok");
  } catch (e) {
    say(`weather unavailable (${e.message || e}) - wind and rain ignored`, "err");
  }

  // The last unguarded call, now guarded: "nothing escapes start()" should be true
  // by construction, not because this one happens not to throw. A partial pass
  // leaves some projections scaled and some not, which is the same shape of answer
  // as a feed that priced only half the week - honest, and not worth losing the run.
  try {
    const r = applyEnvironment(model, env.vegas, env.weather, env.weeks);
    env.byPlayer = r.byPlayer;
    env.note = `${env.games} games`;
    env.state = "done";
    say(`environment applied to ${r.adjusted} player-weeks `
      + `across weeks ${env.weeks.join(" and ")}`, "ok");
  } catch (e) {
    say(`environment could not be applied (${e.message || e}) - projections left as they are`, "err");
    env.note = "not applied";
    env.state = "warn";
  }
  return env;
}

/* ============ roster grid ============ */

export function envColumn(env) {
  return {
    key: "env", label: "Env", num: true, hint: HINT_ENV.env,
    // Read exactly what `envCell` reads, or the column sorts on something it is not
    // showing: `rec.factor` is 1 for a player with no game THIS week, which would
    // file every dashed row in among the average ones. -1 is below any real factor
    // (they clamp at 0.6), so dashes gather at one end where they can be ignored.
    value: (r) => env?.byPlayer?.get(r.p.id)?.weeks?.[env?.weeks?.[0]]?.factor ?? -1,
  };
}

const ENV_DASH = '<td class="num" style="color:var(--faint)">—</td>';

export function envCell(env, player) {
  const rec = env?.byPlayer?.get(player.id);
  const wk = rec?.weeks?.[env?.weeks?.[0]];
  // No row for *this* week means no game this week: a bye, or a fixture nobody has
  // priced. `rec` alone is not enough - a player on bye now but playing next week
  // still gets a record, with the identity factor this column must not advertise.
  if (!rec || !wk) return ENV_DASH;
  const f = rec.factor ?? 1;
  const bits = [
    `week ${env.weeks[0]}: implied ${wk.implied.toFixed(1)} `
      + `of a ${wk.total.toFixed(1)} game, opponent ${wk.oppImplied.toFixed(1)}`,
    wk.wx
      ? `${Math.round(wk.wx.wind)} mph wind (gusts ${Math.round(wk.wx.gust)}), `
        + `${Math.round(wk.wx.precipProb)}% chance of rain`
      : "no weather applied - roof, or no forecast for kickoff",
  ];
  const c = f > 1.005 ? "up" : f < 0.995 ? "down" : "zero";
  return `<td class="num ${c}" data-hint="${esc0(bits.join(" · "))}">×${f.toFixed(2)}</td>`;
}

/* ============ chips ============ */

export function envChips(env) {
  const on = env?.on !== false;
  return `<div class="fld">
    <label data-hint="${esc0(HINT_ENV.chip)}"><span class="hint">Environment</span></label>
    <div class="chips" id="envtog">
      <button data-v="1" aria-pressed="${on}">Vegas + weather</button>
      <button data-v="0" aria-pressed="${!on}">Off</button>
    </div></div>`;
}

export function bindEnvChips(root) {
  root.querySelectorAll("#envtog button").forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.v === "1";
      if (on === (window.__env?.on !== false)) return;
      await chrome.storage.local.set({ "ffsm.environment": on });
      location.reload();     // projections feed everything; a rebuild is the honest path
    };
  });
}

/* ============ streaming section ============ */

/**
 * The planner is a bonus; it must never cost the page - so the WHOLE body is inside
 * the try, not only `streamPlan`. Building the tables can throw too (a malformed row,
 * a grid callback), and a section that renders nothing is a better outcome than a
 * half-built page.
 */
export function streamingSection(args) {
  try {
    return streamingHtml(args);
  } catch {
    return "";
  }
}

function streamingHtml({ eng, model, team, env, grid, esc }) {
  const plan = streamPlan(eng, model, team, { weeks: 3 });
  if (!plan.groups.length) return "";
  const wk = plan.weeks;

  const body = plan.groups.map((g) => {
    const table = grid(`stream${g.slot}`, [
      { key: "name", label: "Player", value: (r) => r.name },
      { key: "owner", label: "Owner", value: (r) => r.owner, hint: HINT_ENV.owner },
      { key: "nfl", label: "NFL", value: (r) => r.nfl },
      { key: "bye", label: "Bye", num: true, value: (r) => r.bye || 99 },
      ...wk.map((w, k) => ({ key: `w${w}`, label: `Wk ${w}`, num: true, value: (r) => r.pts[k] })),
      { key: "total", label: "Window", num: true, value: (r) => r.total, hint: HINT_ENV.window },
    ], g.rows, {
      sort: "total", dir: -1,
      row: (r) => `<tr class="${r.hold ? "hold" : ""}">
        <td style="font-weight:600">${esc(r.name)}${
          r.hold ? ' <span class="tagx">hold</span>' : ""}</td>
        <td>${r.owner === "me" ? "yours" : "free agent"}</td>
        <td class="nfl">${esc(r.nfl)}</td>
        <td class="num" style="color:var(--faint)">${r.bye || "—"}</td>
        ${r.pts.map((v, k) => `<td class="num${wk[k] === r.bye ? " zero" : ""}">${
          wk[k] === r.bye ? "bye" : v.toFixed(1)}</td>`).join("")}
        <td class="num" style="font-weight:600">${r.total.toFixed(1)}</td>
      </tr>`,
      empty: '<div class="empty"><b>Nobody eligible</b>No rostered player or free agent '
           + 'can fill this slot.</div>',
    });

    const seq = g.sequence.map((s) => `wk ${s.w} ${esc(s.name)}`).join(" → ");
    const edge = g.seqTotal - g.holdTotal;
    // The planner solves one seat exactly. When the league starts more than one of
    // this slot - true 2QB, two defences - the recommendation is still a single
    // name, so it must say which of the seats it is talking about rather than let
    // the reader take it for the whole slot. `g.count` is in the heading either way.
    const seats = g.count === 1 ? "1 starter" : `${g.count} starters`;
    const many = g.count > 1
      ? ` This league starts ${g.count} at this slot; the hold and the stream above
          cover <b>one</b> of those ${g.count} seats, not all of them.`
      : "";
    // `g.adds` counts the times the name CHANGES inside the window. It does not
    // count acquiring the first name, so it must not be sold as the number of
    // waiver claims: say what it is, and name the missing move separately.
    return `<h3 class="substl">${esc(g.label)} · ${seats}</h3>
      <div class="panel">${table}
        <div class="note"><b>Hold</b> ${esc(g.hold?.name ?? "—")} for
          ${g.holdTotal.toFixed(1)} points across the window.
          <b>Stream</b> ${seq} for ${g.seqTotal.toFixed(1)} — ${edge > 0.05
            ? `${edge.toFixed(1)} more, at the cost of ${g.adds} switch${
                g.adds === 1 ? "" : "es"} inside the window`
              + ", plus the first add if that name is not already yours"
            : "no better than holding, so hold"}.${many}</div>
      </div>`;
  }).join("");

  const envNote = env?.on !== false && env?.byPlayer?.size
    ? " Weeks with a betting line are already adjusted for the game environment."
    : "";
  return `<section>
    <h2 class="secttl">Streaming planner</h2>
    <p class="sectsub">Weeks ${wk[0]}–${wk.at(-1)} at the slots where the wire is
      genuinely competitive with your bench. Candidates are everyone eligible for the
      slot — yours and free agents — ranked by what they are worth across the whole
      window rather than in one week.${envNote}</p>
    ${body}
  </section>`;
}
