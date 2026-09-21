import { listItems, updateItem } from "./src/db";
import { watchProviders, tvMeta } from "./src/providers";

let updated = 0;
const items = listItems();
for (const it of items) {
  const [prov, meta] = await Promise.all([
    watchProviders(it.kind, it.tmdb_id),
    it.kind === "tv"
      ? tvMeta(it.tmdb_id)
      : Promise.resolve({ seasons: null, episodes: null }),
  ]);
  const changed =
    JSON.stringify(prov) !== JSON.stringify(it.providers) ||
    it.seasons !== meta.seasons ||
    it.episodes !== meta.episodes;
  if (changed) {
    updateItem(it.id, {
      providers: prov,
      seasons: meta.seasons,
      episodes: meta.episodes,
    });
    updated++;
  }
  console.log(
    it.title +
      " -> " +
      (prov.map((p) => p.name).join(", ") || "none") +
      (it.kind === "tv"
        ? " | " + (meta.seasons ?? "?") + "s " + (meta.episodes ?? "?") + "e"
        : ""),
  );
}
console.log("done: " + updated + " updated of " + items.length);
