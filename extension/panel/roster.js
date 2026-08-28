/**
 * Everything the page renders about roster construction.
 *
 * It lives here rather than in panel.js so that a new shape, two package notes, two
 * detail lines and a whole new section cost panel.js one import and four one-line
 * call sites.
 *
 * Two rules shape this file, the same two that shape panel/market.js:
 *   - No `document`, `window` or `chrome` at module load. The tests import it under
 *     node; everything DOM-shaped is a string returned from a function.
 *   - `grid` is injected rather than imported, so this module has no dependency on
 *     panel.js and the table still gets the page's sorting and hints.
 */
import { statusCell, statusRank, AVAIL_HINT } from "./availability.js";

const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (n) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2);
const cls = (n) => (n > 0.005 ? "up" : n < -0.005 ? "down" : "zero");

export const ROSTER_HINT = {
  shape21: "Two players for one. The side sending two fills the seat it just emptied "
    + "from the waiver wire; the side receiving two is over the roster limit and drops "
    + "somebody. Both moves are scored, so the gain shown is what the rosters are "
    + "really worth afterwards - not the trade with a haircut.",
  cost: "Points per week your best lineup loses if you cut him. Zero means the lineup "
    + "never seats him, so he costs nothing to drop however good his projection looks.",
  bestadd: "The free agent your lineup would gain most from once this player is gone. "
    + "Chosen from the best few available at every eligibility, then solved exactly.",
  addgain: "What that free agent is worth on the roster you would have after the drop.",
  net: "The whole move: what the free agent adds, minus what the drop costs. Positive "
    + "means make it.",
};

/**
 * The waiver move a 2-for-1 side makes, rendered under its incoming package.
 *
 * A trade that quietly assumes a waiver add or a drop and does not say so is a trade
 * the user cannot execute. Shapes without either return an empty string, so the call
 * site needs no condition.
 */
export function moveNote(side, nm) {
  if (side.backfill != null)
    return `<div class="movenote add">+ ${esc(nm(side.backfill))}<span class="mn">waivers</span></div>`;
  if (side.drop != null)
    return `<div class="movenote cut">drop ${esc(nm(side.drop))}</div>`;
  return "";
}

/** The same two moves as detail list items, with the start counts that justify them. */
export function moveLines(d, nm) {
  const out = [];
  if (d?.backfill)
    out.push(`<li class="g">Fills the empty seat with <b>${esc(nm(d.backfill.i))}</b> from `
      + `waivers — <b>${d.backfill.startsHere}</b> starts.</li>`);
  if (d?.dropped)
    out.push(`<li class="b">Drops ${esc(nm(d.dropped.i))} to make room — `
      + `${d.dropped.wasStarting} starts given up.</li>`);
  return out.join("");
}

/**
 * The Drop candidates table: who on this roster is safe to cut, and what the wire
 * would put in his place.
 */
export function dropSection(eng, model, opts = {}) {
  const { team, grid, avail = null } = opts;
  const nm = (i) => model.players.get(eng.ids[i]).name;
  const pl = (i) => model.players.get(eng.ids[i]);
  const rows = eng.dropCandidates(team);

  const table = grid("dropGrid", [
    { key: "name", label: "Player", value: (r) => nm(r.i) },
    { key: "pos", label: "Pos", value: (r) => pl(r.i).pos },
    { key: "status", label: "Status", num: true,
      value: (r) => statusRank(avail, pl(r.i).id), hint: AVAIL_HINT.status },
    { key: "cost", label: "Cost/wk", num: true, value: (r) => r.cost, hint: ROSTER_HINT.cost },
    { key: "reg", label: "Reg. season", num: true, value: (r) => r.reg, hint: ROSTER_HINT.cost },
    { key: "po", label: "Playoffs", num: true, value: (r) => r.playoff, hint: ROSTER_HINT.cost },
    { key: "add", label: "Best add if dropped", value: (r) => (r.add == null ? "" : nm(r.add)),
      hint: ROSTER_HINT.bestadd },
    { key: "addgain", label: "Add gain", num: true, value: (r) => r.addGain, hint: ROSTER_HINT.addgain },
    { key: "net", label: "Net", num: true, value: (r) => r.net, hint: ROSTER_HINT.net },
  ], rows, {
    sort: "cost", dir: 1,
    empty: '<div class="empty"><b>Nothing to rank</b>This roster is empty.</div>',
    row: (r) => `<tr>
      <td style="font-weight:600">${esc(nm(r.i))}</td>
      <td><span class="pos" data-p="${esc(pl(r.i).pos)}">${esc(pl(r.i).pos)}</span></td>
      <td class="num">${statusCell(avail, pl(r.i).id, esc)}</td>
      <td class="num ${r.cost > 0.005 ? "down" : "zero"}">${r.cost.toFixed(2)}</td>
      <td class="num ${r.reg > 0.005 ? "down" : "zero"}">${r.reg.toFixed(2)}</td>
      <td class="num ${r.playoff > 0.005 ? "down" : "zero"}">${r.playoff.toFixed(2)}</td>
      <td style="color:var(--dim)">${r.add == null ? "—" : esc(nm(r.add))}</td>
      <td class="num ${cls(r.addGain)}">${f2(r.addGain)}</td>
      <td class="num ${cls(r.net)}">${f2(r.net)}</td>
    </tr>`,
  });

  return `<section>
    <h2 class="secttl">Drop candidates</h2>
    <p class="sectsub">What each player is worth to <b>keep</b>, measured the way
      everything else here is: the points per week your best lineup loses without him.
      A zero means the lineup never seats him. The last two columns price the whole
      move — cut him, add the best free agent your roster could then use.</p>
    <div class="panel">${table}</div>
  </section>`;
}
