/**
 * Tests for Phase 5: the projection sources, the aggregate and the calibration log.
 *
 * Everything here is offline: `fetchImpl` and `storage` are injected, and the model
 * is a small synthetic league built in `mkModel()` rather than `fixture.json` — the
 * fixture is the engine contract and must never be aggregated or shrunk.
 *
 *   node extension/test/projections.mjs
 */
import { parseCsv, parseCsvObjects } from "../engine/sources/csv.js";

let checks = 0, failures = 0;
const ok = (c, what) => { checks++; if (!c) { failures++; console.log(`  FAIL ${what}`); } };
const close = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

const mkStorage = () => { const m = new Map(); return {
  async get(k) { return { [k]: m.get(k) }; }, async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  async remove(k) { m.delete(k); }, _m: m }; };
const mkFetch = (table) => { const calls = []; const f = async (url) => { calls.push(url);
  const hit = table[url]; if (!hit) return { ok: false, status: 404 };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) }; }; f.calls = calls; return f; };

/* ---- 1. CSV ---- */
{
  const rows = parseCsv('a,b,c\n1,"x,y",3\n');
  ok(rows.length === 2, "csv: two rows");
  ok(rows[1][1] === "x,y", "csv: quoted comma stays one field");
  ok(rows[1][2] === "3", "csv: field after a quoted field");

  ok(parseCsv("a,b\n,2\n")[1][0] === "", "csv: leading empty field");
  ok(parseCsv("a,b\n1,\n")[1][1] === "", "csv: trailing empty field");
  ok(parseCsv('a\n"he said ""hi"""\n')[1][0] === 'he said "hi"', "csv: escaped quotes");
  ok(parseCsv("a,b\r\n1,2\r\n").length === 2, "csv: CRLF");
  ok(parseCsv("a,b\n1,2").length === 2, "csv: no trailing newline");
  ok(parseCsv("").length === 0, "csv: empty input");
  ok(parseCsv('a\n"x\ny"\n')[1][0] === "x\ny", "csv: newline inside quotes");

  const objs = parseCsvObjects(' fp_id ,r2p_pts\n7,12.5\n8,\n');
  ok(objs.length === 2, "csvObjects: two objects");
  ok(objs[0].fp_id === "7", "csvObjects: header is trimmed");
  ok(objs[0].r2p_pts === "12.5", "csvObjects: value read");
  ok(objs[1].r2p_pts === "", "csvObjects: empty field is an empty string");
  ok(parseCsvObjects("a,b\n1,2\n\n").length === 1, "csvObjects: blank trailing line ignored");
  ok(parseCsvObjects("").length === 0, "csvObjects: empty input");
}

console.log(`\n${checks} assertions, ${failures} failures`);
if (failures) process.exit(1);
console.log("PROJECTIONS OK");
