import {
  listItems,
  getItemById,
  setItemLists,
  setListPosition,
  topPosition,
  type Item,
} from "./db";
import { pushSheet } from "./sheet";
import { TABS } from "./constants";

const DRY = process.argv.includes("--dry");
const SHOWS_2026 = TABS.SHOWS_2026;
const EXCLUDE = new Set(["What We Do in the Shadows"]);

function normKey(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function finished2026(it: Item): boolean {
  return !!(it.watched_at && String(it.watched_at).startsWith("2026"));
}

// Read the sheet to know which titles already have a Shows 2026 row.
async function sheetShows2026(): Promise<Set<string>> {
  const URL = process.env.SHEET_URL;
  const TOKEN = process.env.SHEET_TOKEN;
  if (!URL || !TOKEN) return new Set();
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, op: "reviews" }),
  });
  const data = (await res.json()) as {
    reviews?: { title: string; tab: string }[];
  };
  const set = new Set<string>();
  for (const r of data.reviews || []) {
    if (r.tab === SHOWS_2026) set.add(normKey(r.title));
  }
  return set;
}

async function main() {
  const onSheet = await sheetShows2026();
  const targets = listItems().filter(
    (it) => it.kind === "tv" && finished2026(it) && !EXCLUDE.has(it.title),
  );

  let adds = 0;
  let reviews = 0;
  let appFix = 0;
  for (const it of targets) {
    const updated = getItemById(it.id)!;
    const hasApp = updated.lists.includes(SHOWS_2026);
    if (!hasApp) {
      appFix++;
      if (!DRY) {
        const lists = [
          SHOWS_2026,
          ...updated.lists.filter((l) => l !== SHOWS_2026),
        ];
        const u = setItemLists(updated.id, lists);
        if (u) setListPosition(u.id, SHOWS_2026, topPosition(SHOWS_2026));
      }
    }
    const onSh = onSheet.has(normKey(updated.title));
    if (!onSh) {
      adds++;
      if (!DRY)
        void pushSheet({
          op: "add",
          tab: SHOWS_2026,
          title: updated.title,
          year: updated.year,
          status: updated.status,
          genres: updated.genres,
          taste_score: updated.taste_score,
          j: updated.my_rating,
          d: updated.di_rating,
          date: updated.watched_at,
        });
    }
    if (updated.review) {
      reviews++;
      if (!DRY)
        void pushSheet({
          op: "setReview",
          tab: SHOWS_2026,
          title: updated.title,
          review: updated.review,
        });
    }
    console.log(
      `${onSh ? "  " : "+ "} ${updated.title} (${updated.year})` +
        `${hasApp ? "" : " [app+list]"}` +
        `${onSh ? "" : " [sheet+row]"}` +
        `${updated.review ? " [review]" : ""}`,
    );
  }
  console.log(
    `\n${DRY ? "[DRY] " : ""}targets=${targets.length}  app-list-added=${appFix}  sheet-rows=${adds}  reviews-pushed=${reviews}`,
  );
}

main();
