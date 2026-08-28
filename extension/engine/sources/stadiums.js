import { PRO_TEAM } from "../league.js";

/**
 * Where each NFL team plays, and whether the weather can reach the field.
 *
 * This lives beside the feeds rather than in `league.js` for two reasons: the
 * wave-2 file-ownership table gives `league.js` to another phase, and this is the
 * only consumer. `proTeamId` is ESPN's own team id and is the *same integer* in the
 * fantasy API (`player.proTeamId`) and in the core sports API (`.../teams/{id}`),
 * which is what lets one table key both the odds feed and the forecast.
 *
 * `roof`:
 *   open        - sky above the field; weather applies.
 *   dome        - fixed roof; weather never applies.
 *   retractable - a roof that may or may not be shut on the day. Treated exactly
 *                 like `dome`, because no feed we can reach says which, and teams
 *                 with retractable roofs close them for bad weather far more often
 *                 than not. That is wrong in the direction that does nothing, rather
 *                 than the direction that invents a wind penalty.
 *
 * Two edge cases worth naming: SoFi (LAR and LAC) has a fixed translucent roof with
 * open sides and is `dome`; Lumen (SEA) and Hard Rock (MIA) have canopies over the
 * seats only, with the field open to the sky, and are `open`.
 *
 * Coordinates are the playing surface, to four decimals (~11 m), which is far finer
 * than any weather model's grid. They only need to pick the right forecast cell.
 */
export const STADIUMS = {
  1:  { name: "Mercedes-Benz Stadium",   lat: 33.7554, lon: -84.4008, roof: "retractable" },
  2:  { name: "Highmark Stadium",        lat: 42.7738, lon: -78.7870, roof: "open" },
  3:  { name: "Soldier Field",           lat: 41.8623, lon: -87.6167, roof: "open" },
  4:  { name: "Paycor Stadium",          lat: 39.0955, lon: -84.5161, roof: "open" },
  5:  { name: "Huntington Bank Field",   lat: 41.5061, lon: -81.6995, roof: "open" },
  6:  { name: "AT&T Stadium",            lat: 32.7473, lon: -97.0945, roof: "retractable" },
  7:  { name: "Empower Field",           lat: 39.7439, lon: -105.0201, roof: "open" },
  8:  { name: "Ford Field",              lat: 42.3400, lon: -83.0456, roof: "dome" },
  9:  { name: "Lambeau Field",           lat: 44.5013, lon: -88.0622, roof: "open" },
  10: { name: "Nissan Stadium",          lat: 36.1665, lon: -86.7713, roof: "open" },
  11: { name: "Lucas Oil Stadium",       lat: 39.7601, lon: -86.1639, roof: "retractable" },
  12: { name: "Arrowhead Stadium",       lat: 39.0489, lon: -94.4839, roof: "open" },
  13: { name: "Allegiant Stadium",       lat: 36.0909, lon: -115.1833, roof: "dome" },
  14: { name: "SoFi Stadium",            lat: 33.9535, lon: -118.3392, roof: "dome" },
  15: { name: "Hard Rock Stadium",       lat: 25.9580, lon: -80.2389, roof: "open" },
  16: { name: "U.S. Bank Stadium",       lat: 44.9736, lon: -93.2575, roof: "dome" },
  17: { name: "Gillette Stadium",        lat: 42.0909, lon: -71.2643, roof: "open" },
  18: { name: "Caesars Superdome",       lat: 29.9511, lon: -90.0812, roof: "dome" },
  19: { name: "MetLife Stadium",         lat: 40.8135, lon: -74.0745, roof: "open" },
  20: { name: "MetLife Stadium",         lat: 40.8135, lon: -74.0745, roof: "open" },
  21: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, roof: "open" },
  22: { name: "State Farm Stadium",      lat: 33.5276, lon: -112.2626, roof: "retractable" },
  23: { name: "Acrisure Stadium",        lat: 40.4468, lon: -80.0158, roof: "open" },
  24: { name: "SoFi Stadium",            lat: 33.9535, lon: -118.3392, roof: "dome" },
  25: { name: "Levi's Stadium",          lat: 37.4033, lon: -121.9694, roof: "open" },
  26: { name: "Lumen Field",             lat: 47.5952, lon: -122.3316, roof: "open" },
  27: { name: "Raymond James Stadium",   lat: 27.9759, lon: -82.5033, roof: "open" },
  28: { name: "Northwest Stadium",       lat: 38.9077, lon: -76.8645, roof: "open" },
  29: { name: "Bank of America Stadium", lat: 35.2258, lon: -80.8528, roof: "open" },
  30: { name: "EverBank Stadium",        lat: 30.3239, lon: -81.6373, roof: "open" },
  33: { name: "M&T Bank Stadium",        lat: 39.2780, lon: -76.6227, roof: "open" },
  34: { name: "NRG Stadium",             lat: 29.6847, lon: -95.4107, roof: "retractable" },
};

/**
 * Abbreviation -> proTeamId, inverted from the one table that already has it.
 *
 * Player records carry `nfl` (the abbreviation) rather than `proTeamId`, and both
 * feeds key on the id, so something has to bridge them. Inverting is safer than a
 * second hand-written list: it cannot drift.
 */
export const PRO_TEAM_ID = Object.fromEntries(
  Object.entries(PRO_TEAM).filter(([id]) => Number(id) !== 0).map(([id, abbr]) => [abbr, Number(id)]));

export function stadiumOf(proTeamId) {
  return STADIUMS[proTeamId] ?? null;
}

/** True only when the sky is above the field. Retractable counts as covered. */
export function isOutdoor(proTeamId) {
  return STADIUMS[proTeamId]?.roof === "open";
}
