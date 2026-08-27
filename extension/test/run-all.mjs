/** Runs every *.mjs test file in this directory (except itself) and fails if any fails. */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs").sort();
let bad = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: "inherit" });
  if (r.status !== 0) bad++;
}
console.log(`\n${files.length} files, ${bad} failing`);
process.exit(bad ? 1 : 0);
