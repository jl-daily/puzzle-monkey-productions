// Seed for _test_tidy_watched_e2e.mjs: the cases the sweep must get right.
//   Tidy Solo      scored, No Di only             -> 2026 (needs a new row)
//   Tidy Dup       scored, No Di + 2026           -> 2026 (drop the No Di row)
//   Tidy Fresh     unscored, No Di                -> untouched
//   Tidy Movies    scored, Movies only            -> 2026
//   Tidy Archived  scored, No Di + Movies Archive -> Movies Archive (keep it)
//
// The two-primary states are written straight to item_lists: setItemLists
// collapses to a single primary, but the live database still holds rows like
// this from before that rule existed — which is exactly the mess being swept.
import { Database } from "bun:sqlite";
import { createItem, updateItem, setItemLists, getItemById } from "./src/db";

const db = new Database(process.env.MOVIE_DB_PATH || "movie.db");

type Seed = { title: string; j: number | null; lists: string[]; extra?: string; watched?: string };

const SEEDS: Seed[] = [
  { title: "Tidy Solo", j: 88, lists: ["No Di"], watched: "2026-03-04" },
  { title: "Tidy Dup", j: 77, lists: ["2026"], extra: "No Di", watched: "2026-02-01" },
  { title: "Tidy Fresh", j: null, lists: ["No Di"] },
  { title: "Tidy Movies", j: 64, lists: ["Movies"], watched: "2026-01-09" },
  { title: "Tidy Archived", j: 91, lists: ["Movies Archive"], extra: "No Di", watched: "2025-11-11" },
];

const out = [];
let n = 0;
for (const s of SEEDS) {
  const it = createItem({
    tmdb_id: 990000 + ++n,
    kind: "movie",
    title: s.title,
    year: "2024",
    taste_score: 70,
    genres: "Drama",
    overview: null,
    poster: null,
    providers: [],
    seasons: null,
    episodes: null,
    runtime: 100,
    director: "Test Director",
    lists: s.lists,
  } as never);
  if (s.j != null)
    updateItem(it.id, {
      my_rating: s.j,
      ...(s.watched ? { watched_at: s.watched } : {}),
    });
  setItemLists(it.id, s.lists);
  if (s.extra)
    db.run("INSERT OR IGNORE INTO item_lists (item_id, list) VALUES (?, ?)", [
      it.id,
      s.extra,
    ]);
  const back = getItemById(it.id);
  out.push({ id: back?.id, title: back?.title, lists: back?.lists, j: back?.my_rating });
}
console.log(JSON.stringify(out));
