/**
 * How the page says who is playing.
 *
 * Every string lives here rather than in panel.js, so that panel.js's diff for this
 * phase stays four small hunks and the merge with the phases built alongside it is
 * mechanical. Nothing here touches the DOM: panel.js hands in its own escaper and
 * gets HTML strings back.
 */

export const AVAIL_HINT = {
  status: "Whether this player is expected to suit up. Q/D is ESPN's game-status tag "
        + "with Sleeper's practice report beside it (FP full, LP limited, DNP none); "
        + "OUT scores nothing this week; IR, PUP and SUS score nothing for the rest "
        + "of the horizon. A blank cell means nothing is being reported.",
};

const CODE = {
  QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "OUT",
  INJURY_RESERVE: "IR", PUP: "PUP", SUSPENSION: "SUS",
};
const BADGE = {
  QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O",
  INJURY_RESERVE: "IR", PUP: "PUP", SUSPENSION: "SUS",
};
const RANK = {
  QUESTIONABLE: 1, DOUBTFUL: 2, OUT: 3,
  INJURY_RESERVE: 4, PUP: 4, SUSPENSION: 4,
};
const PRACTICE = { FP: "full practice", LP: "limited practice", DNP: "did not practise" };

/** Short code for a resolved status: what fits in a table cell. */
export function statusCode(status) { return CODE[status] ?? ""; }

/** The same, compressed to fit beside a name inside a trade package. */
export function badgeCode(status) { return BADGE[status] ?? ""; }

/** Sort key for the roster grid: worse news sorts higher. */
export function statusRank(av, id) {
  const s = av?.statusOf?.get(id);
  return s ? (RANK[s.status] ?? 0) : 0;
}

/** What the tooltip says. The number is the honest part - the code is shorthand. */
function tip(s) {
  const pct = `${Math.round(s.now * 100)}% chance of playing this week`;
  const bits = [];
  if (s.status === "QUESTIONABLE" || s.status === "DOUBTFUL") {
    bits.push(`${s.status === "DOUBTFUL" ? "Doubtful" : "Questionable"} - ${pct}`);
    if (s.practice && PRACTICE[s.practice]) bits.push(PRACTICE[s.practice]);
  } else if (s.status === "OUT") {
    bits.push("Out this week; assumed back after it");
  } else if (s.status === "SUSPENSION") {
    bits.push("Suspended. Neither feed publishes the length, so this is assumed to "
            + "run to the end of the horizon");
  } else if (s.status === "PUP") {
    bits.push("On the PUP list; scores nothing for the rest of the horizon");
  } else {
    bits.push("On injured reserve; scores nothing for the rest of the horizon");
  }
  if (s.note) bits.push(String(s.note));
  return bits.join(". ");
}

/** The Status cell for the roster grid, or an empty string. */
export function statusCell(av, id, esc) {
  const s = av?.statusOf?.get(id);
  if (!s) return "";
  const code = statusCode(s.status);
  if (!code) return "";
  const prac = s.status === "QUESTIONABLE" && s.practice && PRACTICE[s.practice]
    ? ` · ${s.practice}` : "";
  return `<span class="avail ${s.now > 0 ? "warn" : "gone"}" title="${esc(tip(s))}"`
       + `>${esc(code + prac)}</span>`;
}

/** The badge after a player's name inside a trade package, or an empty string. */
export function statusBadge(av, id, esc) {
  const s = av?.statusOf?.get(id);
  if (!s) return "";
  const code = badgeCode(s.status);
  if (!code) return "";
  return ` <span class="avail sm ${s.now > 0 ? "warn" : "gone"}"`
       + ` title="${esc(tip(s))}">${esc(code)}</span>`;
}

/** One or two lines for the loading log. */
export function availabilityLines(summary) {
  const s = summary ?? { out: 0, questionable: 0, shelved: 0, uncertain: 0, matched: 0 };
  const n = (s.out ?? 0) + (s.questionable ?? 0) + (s.shelved ?? 0);
  if (!n) return ["availability: nobody on a roster is listed with an injury"];
  const lines = [`availability: ${s.out ?? 0} out this week, `
    + `${s.questionable ?? 0} questionable, ${s.shelved ?? 0} on IR or suspended`];
  if (s.uncertain) lines.push(`  ${s.uncertain} lineup${s.uncertain === 1 ? "" : "s"}`
    + ` priced across both outcomes rather than guessed either way`);
  return lines;
}

/** One line for the loading log, naming the window the whole report is about. */
export function horizonLine(h) {
  if (!h) return "horizon: the whole season";
  if (h.complete)
    return "horizon: the season is complete - showing every week, as a retrospective";
  if (!h.played) return `horizon: weeks ${h.from}–${h.to}, the whole season`;
  return `horizon: weeks ${h.from}–${h.to} (${h.played} already played and excluded)`;
}

/** The season panel's "what this is not" sentence. */
export function seasonNote(av) {
  const shelved = av?.summary?.shelved ?? 0;
  return "Rosters are frozen except for current injury status: OUT and IR players "
       + "score nothing, and Questionable ones are weighted by their chance to play. "
       + "No waivers, no trades, and no return dates"
       + (shelved ? ` — the ${shelved} shelved player${shelved === 1 ? "" : "s"} `
                  + "stay out for every remaining week." : ".");
}
