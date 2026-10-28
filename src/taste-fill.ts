// Fill in missing taste.io scores.
//
//   bun src/taste-fill.ts                 # every title with no score
//   bun src/taste-fill.ts 2026 Movies      # only titles on those lists
//   bun src/taste-fill.ts --dry 2026       # print without writing
//   bun src/taste-fill.ts --no-sheet 2026  # skip the Google Sheet mirror
//
// Adds and rewatch moves fetch scores as they happen; this sweeps the titles
// where that lookup failed (or never ran, e.g. before curl_cffi was installed).
import { listItems, updateItem } from "./db";
import { pushScore } from "./sheet";
import { tasteScore } from "./taste";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SHEET = !args.includes("--no-sheet");
const lists = args.filter((a) => !a.startsWith("--"));

async function main() {
  const targets = listItems().filter(
    (it) =>
      it.taste_score == null &&
      (!lists.length || it.lists.some((l) => lists.includes(l))),
  );
  let done = 0;
  let set = 0;
  let failed = 0;
  for (const it of targets) {
    const score = await tasteScore(it.title, it.kind, it.year);
    done++;
    if (score == null) {
      failed++;
      console.log(
        `${done}/${targets.length} - no score: ${it.title}${it.year ? ` (${it.year})` : ""}`,
      );
      continue;
    }
    set++;
    console.log(
      `${done}/${targets.length} - ${DRY ? "[DRY] " : ""}${it.title}${it.year ? ` (${it.year})` : ""} -> ${score}`,
    );
    if (!DRY) {
      const updated = updateItem(it.id, { taste_score: score });
      if (updated && SHEET) pushScore(updated);
    }
  }
  console.log(
    `\n${DRY ? "[DRY] " : ""}targets=${targets.length} set=${set} no-score=${failed}`,
  );
  // The sheet pushes are queued; give the gateway time to drain before exit.
  if (!DRY && SHEET && set) await new Promise((r) => setTimeout(r, 3000));
}

main();
