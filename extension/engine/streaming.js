/**
 * Which kicker, defence, quarterback or tight end to hold, and which to churn.
 *
 * These are the slots where the waiver wire is genuinely competitive with what you
 * roster: the gap between the best available kicker in a given week and the twelfth
 * is a matchup, not a talent, and the same is largely true of team defences. So the
 * question is not "who is better" but "who is better *this week*, and is that worth
 * a roster move".
 *
 * Candidates are chosen by SLOT, never by position: a player is a candidate for slot
 * S when his `eligibleSlots` contains S. That is the same rule the lineup solver
 * uses, so a league with TQB, or with no kicker at all, gets the right answer with
 * no special case. `pos` appears only in the output, for display.
 *
 * Values come straight out of the engine's `proj`, so if the environment adjustment
 * ran, this planner is already reading environment-adjusted numbers - which is the
 * whole point of the pairing: streaming decisions are exactly the short-horizon,
 * matchup-driven calls a Vegas total should move.
 *
 * The sequence is a per-week argmax and that is not a shortcut. With one seat to
 * fill and one add allowed per week, the best reachable plan IS the best available
 * player in each week: there is no future cost to taking this week's best, because
 * next week's add is still available. A DP here would return the same answer more
 * slowly. If the rules ever change - a weekly add limit shared across slots, an FAAB
 * budget - this becomes a real optimisation and the comment stops being true.
 */
import { SLOT_LABEL } from "./league.js";

/** Slots worth planning, in the order they are shown. QB, TQB, TE, D/ST, K. */
export const STREAM_SLOTS = [0, 1, 6, 16, 17];

/**
 * @param eng   an Engine, built from `model`
 * @param model the same model (for `eligibleSlots`, `pos` and `lineupSlotCounts`)
 * @param team  team name, as in `eng.roster`
 * @param opts  { weeks = 3, limit = 12 }
 * @returns {{weeks: number[], groups: object[]}}
 */
export function streamPlan(eng, model, team, { weeks = 3, limit = 12 } = {}) {
  const from = model.settings?.currentWeek ?? eng.weeks[0];
  const window = eng.weeks.filter((w) => w >= from).slice(0, weeks);
  if (!window.length) return { weeks: [], groups: [] };
  const wIdx = window.map((w) => eng.weeks.indexOf(w));

  const counts = model.settings?.lineupSlotCounts ?? {};
  const mine = new Set(eng.roster.get(team) ?? []);
  const pool = [...mine, ...eng.freeAgents];

  const groups = [];
  for (const slot of STREAM_SLOTS) {
    const count = Number(counts[slot] ?? counts[String(slot)] ?? 0);
    if (!(count > 0)) continue;

    const rows = [];
    for (const i of pool) {
      const p = model.players.get(eng.ids[i]);
      if (!p || !(p.eligibleSlots ?? []).includes(slot)) continue;
      const pts = wIdx.map((k) => eng.proj[i * eng.NW + k]);
      rows.push({
        i, id: p.id, name: p.name, pos: p.pos, nfl: p.nfl,
        owner: mine.has(i) ? "me" : "FA",
        bye: eng.bye[i] || 0,
        pts,
        total: pts.reduce((a, b) => a + b, 0),
        hold: false,
      });
    }
    if (!rows.length) continue;
    rows.sort((a, b) => b.total - a.total);

    // Best single hold: whoever is worth the most across the whole window.
    const hold = rows[0];
    hold.hold = true;
    const holdTotal = hold.total;

    // Best sequence: the best available player each week. See the header for why
    // greedy is optimal under "one add per week, one seat".
    const sequence = window.map((w, k) => {
      let best = rows[0];
      for (const r of rows) if (r.pts[k] > best.pts[k]) best = r;
      return { w, i: best.i, name: best.name, pts: best.pts[k] };
    });
    const seqTotal = sequence.reduce((a, s) => a + s.pts, 0);
    let adds = 0;
    for (let k = 1; k < sequence.length; k++) if (sequence[k].i !== sequence[k - 1].i) adds++;

    groups.push({
      slot, label: SLOT_LABEL[slot] ?? String(slot), count,
      rows: rows.slice(0, limit),
      hold, holdTotal, sequence, seqTotal, adds,
    });
  }
  return { weeks: window, groups };
}
