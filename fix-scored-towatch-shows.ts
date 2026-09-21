import { listItems, setItemLists, deleteItem } from "./src/db";

// Per-user confirmation: shows that are fully seen (or movies mis-entered as
// shows) get pulled off the Shows / Shows w/o Di to-watch tabs. Partially
// watched shows the user still needs to finish are left alone. Run:
// bun fix-scored-towatch-shows.ts
const TO_WATCH = new Set(["Shows", "Shows w/o Di"]);

// Destination list when a seen title has nothing else to keep it visible.
const seen = new Map<string, string[]>([
  ["Blindspotting", ["Movies Archive"]], // user: "is a movie that I've seen"
  ["Fallen Angels", []], // already in Movies Archive
  ["Maniac", []], // already in Archive
  ["Shrinking", []], // already in Shows Archive
  ["Spotlight", ["Shows Archive"]], // scored/seen; keep visible
  ["The 'Burbs", []], // already in Shows Archive
]);

let items = 0;
let removed = 0;
for (const it of listItems()) {
  const dest = seen.get(it.title);
  if (dest === undefined) continue;
  const onToWatch = it.lists.filter((l) => TO_WATCH.has(l));
  if (!onToWatch.length) continue;
  const next = [
    ...it.lists.filter((l) => !TO_WATCH.has(l)),
    ...dest.filter((l) => !it.lists.includes(l)),
  ];
  setItemLists(it.id, next);
  items++;
  removed += onToWatch.length;
  console.log(
    `- ${it.title} (${it.year || "?"}): left ${onToWatch.join(", ")} -> ${next.join(", ")}`,
  );
}

// Ink is a mistaken duplicate of Shrinking (same di_rating, no other data); the
// real Shrinking entry is already done/archived, so drop the bogus one.
for (const it of listItems()) {
  if (it.title === "Ink") {
    deleteItem(it.id);
    console.log(`- Ink (${it.year || "?"}): deleted (duplicate of Shrinking)`);
  }
}

console.log(
  `done: ${items} title(s), ${removed} to-watch membership(s) removed`,
);
