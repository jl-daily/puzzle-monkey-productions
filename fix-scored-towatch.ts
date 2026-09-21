import { listItems, setItemLists } from "./src/db";

// One-time cleanup: a movie the user has scored (my_rating or di_rating) has
// been seen, so it must not sit on a to-watch list (Movies/No Di). Movies that
// lose their only list membership are moved into Movies Archive so they stay
// visible as watched. Run: bun fix-scored-towatch.ts
const TO_WATCH = new Set(["Movies", "No Di"]);

let items = 0;
let removed = 0;
let archived = 0;
for (const it of listItems()) {
  if (it.kind !== "movie") continue;
  if (it.my_rating == null && it.di_rating == null) continue;
  const onToWatch = it.lists.filter((l) => TO_WATCH.has(l));
  if (!onToWatch.length) continue;
  const kept = it.lists.filter((l) => !TO_WATCH.has(l));
  const next = kept.length ? kept : ["Movies Archive"];
  if (!kept.length) archived++;
  setItemLists(it.id, next);
  items++;
  removed += onToWatch.length;
  console.log(
    `- ${it.title} (${it.year || "?"}): left ${onToWatch.join(", ")} -> ${next.join(", ")}`,
  );
}
console.log(
  `done: ${items} movie(s), ${removed} to-watch membership(s) removed, ${archived} moved into Movies Archive`,
);
