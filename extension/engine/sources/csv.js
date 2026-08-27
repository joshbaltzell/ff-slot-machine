/**
 * A CSV reader, because the DynastyProcess files are CSV and a naive `split(",")`
 * gets them wrong: player names contain commas inside quotes, and rows end with an
 * empty field often enough that dropping empties silently shifts every column after
 * it. Nothing here knows about any particular feed.
 */

/** @returns string[][] including the header row. Handles quotes, "" escapes and CRLF. */
export function parseCsv(text) {
  const s = String(text ?? "");
  const rows = [];
  let row = [], field = "", quoted = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }   // "" is one quote
        quoted = false; i++; continue;
      }
      field += c; i++; continue;                                     // newlines allowed inside quotes
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * @returns object[] — one per data row, keyed by the trimmed header names. Missing
 * trailing columns read as "", and a blank line is skipped rather than becoming a
 * row of empties.
 */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => String(h).trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === "") continue;
    const o = {};
    for (let c = 0; c < head.length; c++) o[head[c]] = cells[c] ?? "";
    out.push(o);
  }
  return out;
}
