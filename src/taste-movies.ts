import { listItems, updateItem, type Item } from "./db";
import { pushScore } from "./sheet";
import { tasteScore } from "./taste";

const DRY = process.argv.includes("--dry");
const OVERWRITE = process.argv.includes("--overwrite");
const MOVIES = "Movies";

async function main() {
  const targets = listItems().filter(
    (it) =>
      it.kind === "movie" &&
      it.lists.includes(MOVIES) &&
      (OVERWRITE || it.taste_score == null),
  );
  let done = 0;
  let set = 0;
  let failed = 0;
  for (const it of targets) {
    const score = await tasteScore(it.title, "movie", it.year);
    done++;
    if (score == null) {
      failed++;
      console.log(
        `${done}/${targets.length} - no score: ${it.title} (${it.year})`,
      );
      continue;
    }
    if (score === it.taste_score) {
      console.log(`${done}/${targets.length} - same: ${it.title} = ${score}`);
      continue;
    }
    set++;
    console.log(
      `${done}/${targets.length} - ${DRY ? "[DRY] " : ""}${it.title} (${it.year}) -> ${score}`,
    );
    if (!DRY) {
      const updated = updateItem(it.id, { taste_score: score });
      if (updated) pushScore(updated);
    }
  }
  console.log(
    `\n${DRY ? "[DRY] " : ""}targets=${targets.length} set=${set} failed=${failed}`,
  );
}

main();
