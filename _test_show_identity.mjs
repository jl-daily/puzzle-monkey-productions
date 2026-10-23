// Regression: a TV show that shares its title with a movie keeps its own
// identity, and a show the app is actively tracking survives a spreadsheet
// reconcile.
//
// The bug: the 2026 series "Carrie" and the 2002 TV movie "Carrie" normalize to
// the same key, so the sheet's single "Carrie" row served whichever item the
// app's list order put first (the movie — status 'todo' sorts before 'watching').
// doSync then saw no row for the show and deleted it, and /api/items/by-title
// re-created it as a *movie* because the caller didn't say otherwise.
//
//   STUB_LOG=/tmp/stub-sheet.log STUB_PORT=4121 bun _stub_sheet.mjs &
//   MOVIE_DB_PATH=/tmp/showid-test.db SHEET_URL=http://localhost:4121 \
//     SHEET_TOKEN=test TASTE_REFRESH_TOKEN= PORT=3014 bun src/index.ts &
//   TEST_BASE=http://localhost:3014 bun _test_show_identity.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.TEST_BASE || "http://localhost:3014";
const SHEET_LOG = process.env.STUB_LOG || "/tmp/stub-sheet.log";
const GAS_UA =
  "Mozilla/5.0 (compatible; Google-Apps-Script; +http://www.google.com/script/start)";

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(
    ok ? "PASS" : "FAIL",
    "|",
    name,
    "|",
    `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
  );
};

const raw = async (method, path, body, headers = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: r.status, json };
};
const req = async (method, path, body, headers) => {
  const { status, json } = await raw(method, path, body, headers);
  if (status >= 400)
    throw new Error(`${method} ${path} -> ${status} ${JSON.stringify(json)}`);
  return json;
};
const all = () => req("GET", "/api/items");
const byTitle = (title, year, list, kind) =>
  req("POST", "/api/items/by-title", {
    title,
    year,
    list,
    ...(kind ? { kind } : {}),
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sheetCmds = () => {
  try {
    return readFileSync(SHEET_LOG, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const runStart = sheetCmds().length; // the stub truncates its log when it boots
let logStart = runStart;
const runCmds = () => sheetCmds().slice(runStart);
const cmdsFor = (title) => sheetCmds().slice(logStart).filter((c) => c.title === title);
const resetLog = () => {
  logStart = sheetCmds().length;
};

// A show the app is tracking: one season, first episode ticked off.
const track = async (show, { progress = { 1: [1] } } = {}) => {
  await req("PATCH", `/api/items/${show.id}`, {
    episode_progress: progress,
    season_counts: { 1: 8 },
    ep_started_at: "2026-10-15",
  });
  await req("PUT", `/api/items/${show.id}/lists`, {
    lists: ["Currently Watching"],
  });
  await sleep(80);
  resetLog();
};

// --- find the show: a 2026 series named "Carrie" ---------------------------
const search = await req("GET", "/api/search?kind=tv&q=" + encodeURIComponent("Carrie"));
const showHit =
  (search.results || []).find((r) => /^carrie$/i.test(r.title) && r.year === "2026") ||
  (search.results || []).find((r) => /^carrie$/i.test(r.title));
if (!showHit) {
  console.log("FAIL | could not find a TV series named Carrie via TMDB search");
  process.exit(1);
}
console.log(`# show: "${showHit.title}" (${showHit.year}, tmdb ${showHit.tmdb_id})`);
console.log(`# same name as the movie: TMDB movie 7342 "Carrie" (2002)`);

// --- 1. the movie, exactly as the sheet has it -----------------------------
// TMDB 7342 is the 2002 TV movie "Carrie" — the row that sits on the user's
// Currently Watching tab.
const movie = await req("POST", "/api/items", {
  tmdb_id: 7342,
  kind: "movie",
  list: "Movies",
});
check("the 2002 movie is in the collection", [movie.kind, movie.year], ["movie", "2002"]);

// --- 2. the show's row: same title, another year, a show tab ---------------
// doSync sends the tab (and no kind) for a Currently Watching row, and used to
// default the kind to "movie" — minting a movie and re-attaching the row to
// the 2002 one.
const show = await byTitle("Carrie", "2026", "Currently Watching");
check("show row does not return the 2002 movie", show.year === "2002", false);
check("show row is a tv item", show.kind, "tv");
check("show row joins Currently Watching", (show.lists || []).includes("Currently Watching"), true);
check("the show is its own item", show.id !== movie.id && show.tmdb_id !== 7342, true);

// --- 3. same title, two items: year and kind pick the right one ------------
const tv = (await all()).find((x) => x.id === show.id);
check("both items exist", !!(await all()).find((x) => x.id === movie.id) && !!tv, true);
check(
  "by-title year 2002 -> the movie",
  (await byTitle("Carrie", "2002", "Movies")).id,
  movie.id,
);
check(
  "by-title year 2026 -> the show",
  (await byTitle("Carrie", "2026", "Currently Watching")).id,
  tv.id,
);
check(
  "by-title with no year on a show tab -> the show",
  (await byTitle("Carrie", null, "Currently Watching")).id,
  tv.id,
);
check(
  "an explicit kind still wins",
  (await byTitle("Carrie", "2002", "Movies", "movie")).id,
  movie.id,
);

// --- 4. a reconcile may not un-list a show that's mid-season ----------------
await track(tv);
const stripped = await req(
  "PUT",
  `/api/items/${tv.id}/lists`,
  { lists: ["Shows 2026"] }, // the sheet can't see the CW row
  { "x-sheet-sync": "1" },
);
check("sync cannot strip Currently Watching", (stripped.lists || []).includes("Currently Watching"), true);

const strippedUa = await req(
  "PUT",
  `/api/items/${tv.id}/lists`,
  { lists: ["Shows 2026"] },
  { "User-Agent": GAS_UA },
);
check("Apps Script user agent is recognised too", (strippedUa.lists || []).includes("Currently Watching"), true);

// the deployed sheet script already sends x-internal on every call, so the
// guard works without it being re-pasted
const strippedInternal = await req(
  "PUT",
  `/api/items/${tv.id}/lists`,
  { lists: ["Shows 2026"] },
  { "x-internal": "1" },
);
check(
  "the sheet's x-internal marker is recognised too",
  (strippedInternal.lists || []).includes("Currently Watching"),
  true,
);

// …while the app's own UI (no sync marker) can still take it off the tab
const uiStrip = await req("PUT", `/api/items/${tv.id}/lists`, { lists: ["Shows 2026"] });
check("the app's own list change still works", (uiStrip.lists || []).includes("Currently Watching"), false);
await track(tv);

// --- 5. a reconcile may not delete a show that's mid-season ----------------
const del = await raw("DELETE", `/api/items/${tv.id}`, null, { "User-Agent": GAS_UA });
check("sync delete of an in-progress show is refused", del.status, 409);
check("the show is still there", !!(await all()).find((x) => x.id === tv.id), true);
check(
  "still on Currently Watching",
  ((await all()).find((x) => x.id === tv.id).lists || []).includes("Currently Watching"),
  true,
);

// a show with no episodes ticked off is not "in progress" — it can go
const otherHit = (search.results || []).find((r) => r.tmdb_id !== showHit.tmdb_id);
const idle = await req("POST", "/api/items", {
  tmdb_id: otherHit.tmdb_id,
  kind: "tv",
  list: "Shows",
});
check(`idle show "${idle.title}" has no progress`, Object.keys(idle.episode_progress || {}).length, 0);
const del2 = await raw("DELETE", `/api/items/${idle.id}`, null, { "User-Agent": GAS_UA });
check("an untouched show can still be deleted", del2.status, 200);
check("it is gone", !(await all()).find((x) => x.id === idle.id), true);

// --- 6. the movie is unaffected: its row still governs it ------------------
const del3 = await raw("DELETE", `/api/items/${movie.id}`, null, { "User-Agent": GAS_UA });
check("movies are still the sheet's to delete", del3.status, 200);

// --- 7. a year in the sheet that matches neither work ----------------------
// The year tabs hold the year a movie was watched, so a row's year can be
// stale: it may bind a row to the closest same-title item, but it must never
// mint a second item for a title we already have.
const carrieCount = async () => (await all()).filter((x) => /^carrie$/i.test(x.title)).length;
check("only the show is left", await carrieCount(), 1);

// the movie's row comes back, and the app mints the movie again (its tmdb id
// is free now that we deleted it)
const remade = await byTitle("Carrie", "2002", "Movies");
check("the missing movie's row mints the movie again", [remade.kind, remade.year], ["movie", "2002"]);
check("the same work as before (tmdb 7342)", remade.tmdb_id, 7342);
check("two Carrie items", await carrieCount(), 2);

const staleMovie = await byTitle("Carrie", "1999", "Movies");
check("a stale year adds no third item", await carrieCount(), 2);
check("it binds to the movie instead", [staleMovie.kind, staleMovie.year], ["movie", "2002"]);
const staleShow = await byTitle("Carrie", "1999", "Currently Watching");
check("a stale year on a show tab binds to the show", staleShow.id, tv.id);
check("still two Carrie items", await carrieCount(), 2);
// a stale year for a work we do not have: it must attach to what does exist
// rather than mint something unrelated from TMDB
const del4 = await raw("DELETE", `/api/items/${remade.id}`, null, { "User-Agent": GAS_UA });
check("the movie can be removed again", del4.status, 200);
const staleOrphan = await byTitle("Carrie", "1999", "Movies");
check("a stale year with no movie mints nothing", await carrieCount(), 1);
check("it binds to the surviving item", staleOrphan.id, tv.id);

// --- 8. every row the app pushed for the show named its kind ---------------
const adds = runCmds().filter(
  (c) => c.op === "add" && c.title === "Carrie" && String(c.year) === "2026",
);
check("the app pushed rows for the show", adds.length > 0, true);
check(
  `all ${adds.length} of them named kind=tv`,
  adds.every((c) => c.kind === "tv"),
  true,
);
const movieAdds = runCmds().filter(
  (c) => c.op === "add" && c.title === "Carrie" && String(c.year) === "2002",
);
check(
  `the movie's ${movieAdds.length} row(s) named kind=movie`,
  movieAdds.length > 0 && movieAdds.every((c) => c.kind === "movie"),
  true,
);

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL_PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
