// Offline companion to the dry run: read a saved sheet dump (no gateway call)
// and answer the one question the dry run cannot answer on its own — for each
// app item the sync would delete, is there a row with that title anywhere in
// the spreadsheet?
//
//   bun _dryrun_dump_check.mjs /tmp/sheet-dump.json [--want "Title|Title2"]
//   bun _dryrun_dump_check.mjs /tmp/sheet-dump.json --titles        (all items)
import { readFileSync } from "node:fs";

export function normKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const file = process.argv[2] || "/tmp/sheet-dump.json";
const dump = JSON.parse(readFileSync(file, "utf8")).tabs || {};
const APP = process.env.APP_BASE || "https://129-80-103.21.sslip.io";
const items = await (await fetch(APP + "/api/items")).json();

// rowsByKey: normalized title -> [{tab, year}]
const rowsByKey = new Map();
for (const [tab, rows] of Object.entries(dump)) {
  for (const r of rows || []) {
    const k = normKey(r.title);
    if (!k) continue;
    if (!rowsByKey.has(k)) rowsByKey.set(k, []);
    rowsByKey.get(k).push({ tab, year: String(r.year ?? "") });
  }
}

const wantArg = process.argv.indexOf("--want");
const all = process.argv.includes("--titles");
const want = wantArg > -1 ? String(process.argv[wantArg + 1]).split("|").filter(Boolean) : [];

console.log(`# ${Object.keys(dump).length} tabs, ${rowsByKey.size} distinct titles in the sheet`);
let withRow = 0;
let noRow = 0;
for (const it of items) {
  const lists = it.lists || [];
  if (!all && want.length && !want.some((w) => it.title.toLowerCase().includes(w.toLowerCase()))) continue;
  const rows = rowsByKey.get(normKey(it.title)) || [];
  const onItsOwnTab = rows.some((r) => lists.includes(r.tab));
  const verdict = rows.length === 0 ? "NO ROW ANYWHERE" : onItsOwnTab ? "row on the item's own tab" : "row only on other tabs";
  if (rows.length === 0) noRow++;
  else withRow++;
  console.log(
    `- ${it.title} (${it.kind} ${it.year}) lists=${JSON.stringify(lists)} -> ${verdict}${rows.length ? " " + JSON.stringify(rows.map((r) => `${r.tab}${r.year ? " " + r.year : ""}`)) : ""}`,
  );
}
if (all) console.log(`\n# totals: ${withRow} items have a row somewhere, ${noRow} have no row at all`);
