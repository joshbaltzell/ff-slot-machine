/**
 * How the page talks about floors, ceilings, stacks and this week's game.
 *
 * Every string lives here rather than in panel.js, so that panel.js's diff for this
 * phase stays a handful of small hunks and the merge with the phases built alongside
 * it is mechanical. Nothing here touches the DOM: panel.js hands in its own escaper
 * and its own index-to-name function, and gets HTML strings back.
 */
import { CORR } from "../engine/distribution.js";

/**
 * How much a variance swap must be worth before it is recommended.
 *
 * The correlation constants are round numbers and the sigmas come from one prior
 * season, so a tenth of a percentage point is not a real difference. A full point
 * is, and a recommendation nobody should act on is worse than no recommendation.
 */
export const SWAP_MIN = 0.01;

export const DIST_HINT = {
  floor: "His 10th-percentile game: he scores this or worse one week in ten. "
       + "Measured from last season's residuals - actual minus projection, week by "
       + "week - and shrunk toward his position's, so a short history is pulled "
       + "toward the typical shape rather than trusted on its own. Never below zero.",
  ceiling: "His 90th-percentile game: he scores this or better one week in ten. "
         + "Measured the same way as the floor. The gap between the two is the whole "
         + "reason a projection is not a prediction.",
  pwin: "The chance your best possible lineup outscores this week's opponent. It "
      + "uses both teams' measured spread, so it is not the same as who projects "
      + "higher: an underdog is helped by variance and a favourite is hurt by it.",
};

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pp = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}pp`;

/**
 * One floor / median / ceiling bar, positioned inside a shared scale so that two
 * teams' bars can be read against each other rather than each against itself.
 */
export function rangeBar(r, scale, esc) {
  const lo = scale?.lo ?? 0, hi = scale?.hi ?? 1;
  const span = hi - lo || 1;
  const at = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const a = at(r.floor), b = at(r.ceiling), m = at(r.median);
  return `<div class="rng" title="${esc(`floor ${r.floor.toFixed(0)} · median `
    + `${r.median.toFixed(0)} · ceiling ${r.ceiling.toFixed(0)}`)}">
    <i class="rng-span" style="left:${a.toFixed(1)}%;width:${(b - a).toFixed(1)}%"></i>
    <i class="rng-med" style="left:${m.toFixed(1)}%"></i>
  </div>`;
}

/**
 * The **This week** section.
 *
 * Returns "" when there is no plan - an unscheduled week, an unmeasured league - so
 * that panel.js can interpolate it unconditionally and get nothing rather than a
 * section apologising for itself.
 */
export function weekSection(gp, { esc, name, myTeam }) {
  if (!gp) return "";
  const gain = gp.pWinBest - gp.pWinMean;
  const worth = gain >= SWAP_MIN && gp.swaps.length;
  const lo = Math.min(gp.me.floor, gp.them.floor);
  const hi = Math.max(gp.me.ceiling, gp.them.ceiling);
  const scale = { lo, hi };

  const swapRows = worth ? gp.swaps.map((s) => `<li>
      <b>${esc(name(s.in))}</b> in for <b>${esc(name(s.out))}</b>
      <span class="tag g">${esc(pp(s.dP))}</span></li>`).join("") : "";

  return `<section>
    <h2 class="secttl">This week</h2>
    <p class="sectsub">Week ${gp.week} against <b>${esc(gp.opponent)}</b>. Every other
      number on this page maximises points; this one maximises the chance of winning
      one game, which is not the same thing when you are the underdog.</p>
    <div class="panel gp">
      <div class="gp-top">
        <div class="gp-p">
          <div class="k">Win probability</div>
          <div class="v ${gp.pWinMean >= 0.5 ? "up" : "down"}">${esc(pct(gp.pWinMean))}</div>
          <div class="s">with your best-points lineup</div>
        </div>
        ${worth ? `<div class="gp-p">
          <div class="k">If you play for variance</div>
          <div class="v up">${esc(pct(gp.pWinBest))}</div>
          <div class="s">${esc(pp(gain))} from ${gp.swaps.length}
            swap${gp.swaps.length === 1 ? "" : "s"}</div>
        </div>` : ""}
      </div>
      ${worth ? `<ul class="gp-swaps">${swapRows}</ul>` : ""}
      <div class="gp-rng">
        <div class="gp-lab">${esc(myTeam)}</div>
        <div>${rangeBar(gp.me, scale, esc)}</div>
        <div class="num">${gp.me.floor.toFixed(0)}&#8202;–&#8202;${
          gp.me.ceiling.toFixed(0)} <span class="mid">${gp.me.median.toFixed(0)}</span></div>
        <div class="gp-lab">${esc(gp.opponent)}</div>
        <div>${rangeBar(gp.them, scale, esc)}</div>
        <div class="num">${gp.them.floor.toFixed(0)}&#8202;–&#8202;${
          gp.them.ceiling.toFixed(0)} <span class="mid">${gp.them.median.toFixed(0)}</span></div>
      </div>
      <div class="note">${worth
        ? `A swingier lineup wins more often when you are behind on paper and less
           often when you are ahead — this is the arithmetic of that, not a hunch.`
        : `No lineup change is worth a percentage point here, so field your best
           points lineup.`}
        The bars are the 10th to 90th percentile of each team's total, with the median
        marked. This lineup search is a <b>local search heuristic</b>, not the
        exhaustive enumeration the trade search runs: it takes the best single
        starter-for-bench swap until no swap helps. The number of legal lineups is
        combinatorial, and the starting point is already the best-points answer.</div>
    </div>
  </section>`;
}

/** Stack flags for one roster, or "" when it has none. */
export function stackLine(pairs, { esc, name }) {
  if (!pairs?.length) return "";
  const chips = pairs.map((p) => `<span class="tag warn"
    title="${esc(`${name(p.a)} and ${name(p.b)} share an offence — their scores move `
      + `together (rho ${p.rho})`)}">${esc(p.label)} stack${
      p.nfl ? `: ${esc(p.nfl)}` : ""}</span>`).join(" ");
  return `<div class="gp-stacks">${chips}</div>`;
}

/**
 * The season panel's swing sentence. Replaces the old independence disclaimer, which
 * this phase made false.
 */
export function stackNote(measured, corr = CORR) {
  if (!(measured >= 20))
    return "Weekly swing falls back to an assumed ±25 points, and no correlation "
         + "between teammates is modelled.";
  return `Swing is measured per player and now counts stacks: two players on one NFL `
       + `team are correlated at ${corr.qbToPass} for a quarterback with his own `
       + `receiver or tight end and ${corr.sameTeam} for any other pair of `
       + `teammates, running backs at ${corr.rb}, and opponents in the same game at `
       + `${corr.sameGame}. A stacked roster is genuinely swingier and this says so.`;
}
