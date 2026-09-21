import { listItems, updateItem, type Item } from "./src/db";

const URL = process.env.SHEET_URL;
const TOKEN = process.env.SHEET_TOKEN;

function normKey(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function stripSeason(s: string): string {
  return String(s || "")
    .replace(/\(?\s*S\d+(\s*[-–&]\s*S?\d+)*\s*\)?/gi, "")
    .trim();
}

// Pick which season entry a sheet Started/Finished date should land on: prefer
// the season that itself finished in 2026 (the finished-2026 shows we care
// about), else the only season present, else a fresh "1".
function pickSeason(sd: any, watchedAt: string | null): string {
  const keys = Object.keys(sd);
  const y2026 = keys.find((k) => sd[k]?.finished_at?.startsWith("2026"));
  if (y2026) return y2026;
  if (keys.length) return keys[0];
  if (watchedAt?.startsWith("2026")) return "1";
  return "1";
}

if (!URL || !TOKEN) {
  console.error("SHEET_URL / SHEET_TOKEN not set");
  process.exit(1);
}

const res = await fetch(URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: TOKEN, op: "reviews" }),
});
const data = await res.json();
if (!data.ok) {
  console.error("gateway error:", data.error || "unknown");
  process.exit(1);
}

console.log("tabs read:");
for (const s of data.sheets || []) {
  console.log(
    `  ${s.tab} -> col ${s.col}${s.colName ? ` ("${s.colName}")` : " (no review col)"}`,
  );
}

const byKey = new Map<string, Item>();
for (const it of listItems()) {
  const k = normKey(it.title);
  if (!byKey.has(k)) byKey.set(k, it);
}

let updated = 0;
let dates = 0;
const matched: string[] = [];
const unmatched: string[] = [];
for (const r of data.reviews || []) {
  const it =
    byKey.get(normKey(r.title)) ?? byKey.get(normKey(stripSeason(r.title)));
  if (!it) {
    unmatched.push(`${r.title} [${r.tab}]`);
    continue;
  }
  matched.push(`${r.title} [${r.tab}]`);
  let changed = false;
  if (it.review !== r.review) {
    updateItem(it.id, { review: r.review });
    updated++;
    changed = true;
  }
  // Import the sheet's Started/Finished columns into the matching season's
  // season_dates. The # days figure is derived from these two in the UI, so we
  // don't need to store it separately.
  const started = r.started ?? r.Started ?? null;
  const finished = r.finished ?? r.Finished ?? null;
  if (started || finished) {
    const sd: any = { ...(it.season_dates || {}) };
    const season = pickSeason(sd, it.watched_at);
    const prev = sd[season] || {};
    const next: any = { ...prev };
    if (started) next.started_at = started;
    if (finished) next.finished_at = finished;
    if (
      next.started_at !== prev.started_at ||
      next.finished_at !== prev.finished_at
    ) {
      sd[season] = next;
      updateItem(it.id, { season_dates: sd });
      changed = true;
    }
  }
  if (changed) dates++;
}

console.log(`\nreviews: ${(data.reviews || []).length} total`);
console.log(
  `matched: ${matched.length}, review set: ${updated}, dates set: ${dates}`,
);
if (unmatched.length) {
  console.log(`\nnot in app (${unmatched.length}):`);
  for (const t of unmatched) console.log("  " + t);
}
