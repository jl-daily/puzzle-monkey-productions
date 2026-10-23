// Regression: adding a title that is already in the collection is only a
// rewatch when James has actually watched it. Adding a movie parked on a
// to-watch tab (No Di → Movies) must not pick up a watch date or a rewatch
// mark, while a re-add of something already watched (archive → 2026) must keep
// stamping today's date. Run against a local server started with the stub sheet
// gateway:
//
//   STUB_LOG=/tmp/stub-sheet.log STUB_PORT=4111 bun _stub_sheet.mjs &
//   MOVIE_DB_PATH=/tmp/rewatch-test.db SHEET_URL=http://localhost:4111 \
//     SHEET_TOKEN=test TASTE_REFRESH_TOKEN= PORT=3013 bun src/index.ts &
//   TEST_BASE=http://localhost:3013 bun _test_add_rewatch.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.TEST_BASE || "http://localhost:3013";
const SHEET_LOG = process.env.STUB_LOG || "/tmp/stub-sheet.log";
// Mirrors src/constants.ts today() — LOCAL date, not the UTC one.
const _d = new Date();
const todayISO = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const req = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const all = () => req("GET", "/api/items");
const one = async (id) => (await all()).find((x) => x.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Commands the app pushed to the (stub) sheet gateway so far.
const sheetCmds = () => {
  try {
    return readFileSync(SHEET_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
// The stub log persists across runs, so assertions must only see the commands
// this run pushed — otherwise a second run re-finds the first run's ops.
let logStart = sheetCmds().length;
const cmdsFor = (title) => sheetCmds().slice(logStart).filter((c) => c.title === title);
const resetLog = () => {
  logStart = sheetCmds().length;
};

// Put the item into a known state: given watch dates, rewatch mark and lists.
const setState = async (movie, { watched = null, first = null, rewatch = false, lists }) => {
  await req("PATCH", `/api/items/${movie.id}`, {
    my_rating: null,
    di_rating: null,
    watched_at: watched,
    first_watched_at: first,
    rewatched_at: null,
    rewatch,
  });
  await req("PUT", `/api/items/${movie.id}/lists`, { lists });
  await sleep(100);
  resetLog();
};

// The user's gesture: search a title the collection already has and hit "Add"
// while the Movies tab is open (src/frontend/app.js addFromResult).
const addToList = (movie, list) =>
  req("POST", "/api/items", { tmdb_id: movie.tmdb_id, kind: movie.kind, list });

const movie = (await all()).find((x) => x.kind === "movie" && x.tmdb_id);
if (!movie) {
  console.log("FAIL | no movie with a tmdb_id in local DB");
  process.exit(1);
}
console.log(`# using "${movie.title}" (${movie.year}, tmdb ${movie.tmdb_id}) lists=${JSON.stringify(movie.lists)}`);
const orig = {
  my_rating: movie.my_rating,
  di_rating: movie.di_rating,
  watched_at: movie.watched_at,
  first_watched_at: movie.first_watched_at,
  rewatched_at: movie.rewatched_at,
  rewatch: movie.rewatch,
  lists: movie.lists,
  positions: movie.positions || {},
};

try {
  // --- 1. never-watched movie on No Di, added to Movies: a move, not a viewing ---
  await setState(movie, { lists: ["No Di"] });
  const before1 = await one(movie.id);
  check("setup: on No Di, never watched", [before1.lists, before1.watched_at, before1.rewatch], [["No Di"], null, false]);
  await addToList(movie, "Movies");
  await sleep(600);
  const a = await one(movie.id);
  check("lands on Movies", a.lists.includes("Movies"), true);
  check("off No Di", a.lists.includes("No Di"), false);
  check("no watch date added", a.watched_at, null);
  check("no rewatch date added", a.rewatched_at, null);
  check("not marked a rewatch", a.rewatch, false);
  const cmds1 = cmdsFor(movie.title);
  check("sheet: Movies row added", cmds1.some((c) => c.op === "add" && c.tab === "Movies"), true);
  check("sheet: added row carries no watch date", cmds1.find((c) => c.op === "add" && c.tab === "Movies")?.date ?? null, null);
  check("sheet: no watched write", cmds1.some((c) => c.op === "watched"), false);
  check("sheet: no rewatch highlight", cmds1.some((c) => c.op === "markRewatch"), false);
  // Ordering guard: doSync reads a title on no tab as deleted, so the
  // destination row must exist before the source row goes away.
  const iAdd1 = cmds1.findIndex((c) => c.op === "add" && c.tab === "Movies");
  const iRem1 = cmds1.findIndex((c) => c.op === "remove" && c.tab === "No Di");
  check("sheet: Movies row written before No Di row removed", iAdd1 > -1 && iRem1 > -1 && iAdd1 < iRem1, true);

  // --- 2. previously watched (archive) added to the 2026 tab: still a rewatch ---
  await setState(movie, { watched: "2024-05-01", lists: ["Movies Archive"] });
  await addToList(movie, "2026");
  await sleep(600);
  const b = await one(movie.id);
  check("files to 2026", b.lists.includes("2026"), true);
  check("off the archive", b.lists.includes("Movies Archive"), false);
  check("watched_at refreshed to today", b.watched_at, todayISO);
  check("original viewing kept", b.first_watched_at, "2024-05-01");
  check("marked a rewatch", [b.rewatch, b.rewatched_at], [true, todayISO]);
  const cmds2 = cmdsFor(movie.title);
  check("sheet: watches the date", cmds2.some((c) => c.op === "watched" && c.date === todayISO), true);
  check(
    "sheet: 2026 row written before the archive row removed",
    cmds2.findIndex((c) => c.op === "add" && c.tab === "2026") <
      cmds2.findIndex((c) => c.op === "remove" && c.tab === "Movies Archive"),
    true,
  );

  // --- 2b. previously watched, but added to the to-watch tab: no date claim ---
  await setState(movie, { watched: "2024-05-01", lists: ["Movies Archive"] });
  await addToList(movie, "Movies");
  await sleep(600);
  const c = await one(movie.id);
  check("back on Movies", c.lists.includes("Movies"), true);
  check("keeps its old watch date (no today stamp)", c.watched_at, "2024-05-01");
  check("still flagged a rewatch (he has seen it)", c.rewatch, true);
  check("sheet: no watched write for a to-watch add", cmdsFor(movie.title).some((x) => x.op === "watched"), false);

  // --- 3. adding something already on the tab is a no-op, not a viewing ---
  await setState(movie, { lists: ["Movies"] });
  await addToList(movie, "Movies");
  await sleep(600);
  const d = await one(movie.id);
  check("still on Movies", d.lists, ["Movies"]);
  check("double add leaves no watch date", [d.watched_at, d.rewatched_at, d.rewatch], [null, null, false]);
  check("sheet: nothing pushed for a no-op add", cmdsFor(movie.title).filter((x) => x.op === "watched" || x.op === "markRewatch"), []);

  // --- 4. the sheet's recovery route must not fake a viewing either ---
  await setState(movie, { lists: ["No Di"] });
  await req("POST", "/api/items/by-title", { title: movie.title, list: "Movies" });
  await sleep(600);
  const e = await one(movie.id);
  check("by-title attaches to Movies", e.lists.includes("Movies"), true);
  check("by-title adds no watch date", e.watched_at, null);
  check("by-title adds no rewatch date", e.rewatched_at, null);
  check("by-title adds no rewatch mark", e.rewatch, false);
  check("sheet: by-title pushed no watched write", cmdsFor(movie.title).some((x) => x.op === "watched"), false);
} finally {
  await req("PATCH", `/api/items/${movie.id}`, {
    my_rating: orig.my_rating,
    di_rating: orig.di_rating,
    watched_at: orig.watched_at,
    first_watched_at: orig.first_watched_at,
    rewatched_at: orig.rewatched_at,
    rewatch: orig.rewatch,
  });
  await req("PUT", `/api/items/${movie.id}/lists`, { lists: orig.lists });
  if (Object.keys(orig.positions).length)
    await req("PUT", `/api/items/${movie.id}/positions`, { positions: orig.positions });
  const f = await one(movie.id);
  check(
    "restored",
    [
      f.my_rating,
      f.di_rating,
      f.watched_at,
      f.first_watched_at,
      f.rewatched_at,
      f.rewatch,
      JSON.stringify(f.lists) === JSON.stringify(orig.lists),
    ],
    [orig.my_rating, orig.di_rating, orig.watched_at, orig.first_watched_at, orig.rewatched_at, orig.rewatch, true],
  );
}

const pass = results.every(Boolean);
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
