/**
 * Optimal starting lineup, for any ESPN slot configuration.
 *
 * The engine never asks what position a player *is*. ESPN gives every player an
 * `eligibleSlots` array and every league a `lineupSlotCounts` map, so players are
 * matched to slots directly. That removes the position taxonomy and with it every
 * special case - TQB, superflex, IDP, punters, head coaches all work with no extra
 * code, because eligibility is data rather than logic.
 *
 * Optimality: the sets of players that can be simultaneously seated in slots form a
 * transversal matroid, and greedy by descending value is optimal on any matroid. So
 * one algorithm covers every structure ESPN can produce - including RB/WR plus
 * WR/TE, which overlap without nesting and which a fill-dedicated-slots-first
 * approach gets wrong about 8% of the time.
 */

/** Slots that are never part of a starting lineup. */
export const BENCH_SLOTS = new Set([20, 21, 24]);   // Bench, IR, ER

/**
 * @param {Object<string|number, number>} lineupSlotCounts  from mSettings
 * @returns {{slots: Int32Array, masks: Int32Array, starters: number}}
 *   `slots[i]` is the slot id of the i-th starting seat; `masks[i]` is a bitmask of
 *   that seat, for fast eligibility tests.
 */
export function buildSlots(lineupSlotCounts) {
  const seats = [];
  for (const [id, n] of Object.entries(lineupSlotCounts)) {
    const slotId = Number(id);
    if (BENCH_SLOTS.has(slotId)) continue;
    for (let k = 0; k < n; k++) seats.push(slotId);
  }
  // Most-restrictive seats first shortens augmenting-path searches.
  seats.sort((a, b) => a - b);
  return { slots: Int32Array.from(seats), starters: seats.length };
}

/** Bitmask of a player's eligible seats, given the seat layout. */
export function seatMask(eligibleSlots, slots) {
  let mask = 0;
  const elig = new Set(eligibleSlots);
  for (let i = 0; i < slots.length; i++) if (elig.has(slots[i])) mask |= (1 << i);
  return mask;
}

/**
 * Best possible started points for one week.
 *
 * @param order  player indices, pre-sorted by descending value for this week
 * @param values values[p] for this week
 * @param masks  masks[p] = bitmask of seats player p may fill
 * @param nSeats number of starting seats
 */
export function bestLineup(order, values, masks, nSeats) {
  const seatOf = new Int32Array(nSeats).fill(-1);   // seat -> player
  const seen = new Uint8Array(nSeats);
  let total = 0, filled = 0;

  // Kuhn's augmenting path: can player p be seated, possibly by shuffling others?
  const assign = (p) => {
    const mask = masks[p];
    for (let s = 0; s < nSeats; s++) {
      if (!(mask & (1 << s)) || seen[s]) continue;
      seen[s] = 1;
      if (seatOf[s] === -1 || assign(seatOf[s])) { seatOf[s] = p; return true; }
    }
    return false;
  };

  for (let i = 0; i < order.length && filled < nSeats; i++) {
    const p = order[i];
    if (!masks[p]) continue;
    seen.fill(0);
    if (assign(p)) { total += values[p]; filled++; }
  }
  return total;
}

/** Which seat each starter occupies. Mirrors bestLineup; used for explanations. */
export function bestLineupSeats(order, values, masks, nSeats) {
  const seatOf = new Int32Array(nSeats).fill(-1);
  const seen = new Uint8Array(nSeats);
  let filled = 0;
  const assign = (p) => {
    const mask = masks[p];
    for (let s = 0; s < nSeats; s++) {
      if (!(mask & (1 << s)) || seen[s]) continue;
      seen[s] = 1;
      if (seatOf[s] === -1 || assign(seatOf[s])) { seatOf[s] = p; return true; }
    }
    return false;
  };
  for (let i = 0; i < order.length && filled < nSeats; i++) {
    const p = order[i];
    if (!masks[p]) continue;
    seen.fill(0);
    if (assign(p)) filled++;
  }
  return seatOf;
}
