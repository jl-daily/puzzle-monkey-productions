// Seed for _test_nodi_remove_e2e.mjs: one movie James has already scored that a
// sync has left sitting on No Di. Prints the item id.
import { createItem, updateItem, setItemLists, getItemById } from "./src/db";

const it = createItem({
  tmdb_id: 1031,
  kind: "movie",
  title: "Erin Brockovich",
  year: "2000",
  taste_score: 74,
  genres: "Drama",
  overview: null,
  poster: null,
  providers: [],
  seasons: null,
  episodes: null,
  runtime: 131,
  director: "Steven Soderbergh",
  lists: [],
} as never);
updateItem(it.id, {
  my_rating: 86,
  di_rating: 86,
  watched_at: "2026-08-11",
});
setItemLists(it.id, ["No Di"]);
const back = getItemById(it.id);
console.log(
  JSON.stringify({
    id: back?.id,
    lists: back?.lists,
    j: back?.my_rating,
    w: back?.watched_at,
  }),
);
