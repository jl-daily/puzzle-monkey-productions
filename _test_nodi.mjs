// Regression: a movie Diana scores but James hasn't must move from "Movies"
// (watch together) to "No Di" (watch solo) — not to "2026", because James
// hasn't seen it, so watched_at must stay empty. James's own score still files
// it to 2026. Run against a local server started with the stub sheet gateway:
//
//   STUB_LOG=/tmp/stub-sheet.log STUB_PORT=4111 bun _stub_sheet.mjs &
//   MOVIE_DB_PATH=/tmp/nodi-test.db SHEET_URL=http://localhost:4111 \
//     SHEET_TOKEN=test TASTE_REFRESH_TOKEN= PORT=3012 bun src/index.ts &
//   TEST_BASE=http://localhost:3012 bun _test_nodi.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.TEST_BASE || "http://localhost:3012";
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
// Same as req(), but surfaces the status instead of throwing, for the paths
// that are supposed to be refused.
const tryReq = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
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
const logStart = sheetCmds().length;

// The app's default sort for a plain tab (src/frontend/app.js): pinned
// positions first (ascending), unpinned last, di_confirmed sinking to the end.
const sortTab = (arr, list) =>
  arr.slice().sort((a, b) => {
    const pa = a.positions && a.positions[list] != null ? a.positions[list] : null;
    const pb = b.positions && b.positions[list] != null ? b.positions[list] : null;
    if (pa == null && pb == null) return (b.created_at || "").localeCompare(a.created_at || "");
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  });

const movie = (await all()).find((x) => x.kind === "movie");
if (!movie) {
  console.log("FAIL | no movie in local DB");
  process.exit(1);
}
console.log(`# using "${movie.title}" (id ${movie.id}) lists=${JSON.stringify(movie.lists)}`);
const orig = {
  my_rating: movie.my_rating,
  di_rating: movie.di_rating,
  watched_at: movie.watched_at,
  first_watched_at: movie.first_watched_at,
  di_review: movie.di_review,
  lists: movie.lists,
  positions: movie.positions || {},
};

try {
  // Start clean: on Movies, no scores.
  await req("PATCH", `/api/items/${movie.id}`, {
    my_rating: null,
    di_rating: null,
    watched_at: null,
    first_watched_at: null,
  });
  await req("PUT", `/api/items/${movie.id}/lists`, { lists: ["Movies"] });
  check("setup: on Movies, unscored", [(await one(movie.id)).lists, (await one(movie.id)).di_rating], [["Movies"], null]);

  // --- 1. Diana's score on the Movies tab -> No Di, not 2026 ---
  await req("PATCH", `/api/items/${movie.id}`, { my_rating: null, di_rating: 88, move_to_2026: true });
  const a = await one(movie.id);
  check("Diana-only score leaves Movies", a.lists.includes("Movies"), false);
  check("Diana-only score lands on No Di", a.lists.includes("No Di"), true);
  check("not filed as watched-in-2026", a.lists.includes("2026"), false);
  check("watched_at not stamped", a.watched_at, null);
  check("scores kept", [a.my_rating, a.di_rating], [null, 88]);
  const noDiItems = (await all()).filter((x) => x.lists.includes("No Di"));
  check("pinned to top of No Di", sortTab(noDiItems, "No Di")[0].id, movie.id);

  await sleep(600);
  let cmds = sheetCmds().slice(logStart).filter((c) => c.title === movie.title);
  check("sheet: Movies row removed", cmds.some((c) => c.op === "remove" && c.tab === "Movies"), true);
  check("sheet: No Di row added with D score", cmds.some((c) => c.op === "add" && c.tab === "No Di" && c.d === 88), true);
  check("sheet: no 2026 add", cmds.some((c) => c.op === "add" && c.tab === "2026"), false);
  // Ordering guard: doSync deletes a title that appears on no tab, so the
  // destination row must be written before the source row is removed.
  const iAdd = cmds.findIndex((c) => c.op === "add" && c.tab === "No Di");
  const iRem = cmds.findIndex((c) => c.op === "remove" && c.tab === "Movies");
  check("sheet: No Di row written before Movies row removed", iAdd > -1 && iRem > -1 && iAdd < iRem, true);

  // --- 2. a manual Movies write can't strand it there (sync backstop) ---
  const back = await req("PUT", `/api/items/${movie.id}/lists`, { lists: ["Movies"] });
  check("Movies write relocates to No Di", [back.lists.includes("No Di"), back.lists.includes("Movies")], [true, false]);
  await sleep(600);
  cmds = sheetCmds().slice(logStart).filter((c) => c.title === movie.title);
  const lastRemove = [...cmds].reverse().find((c) => c.op === "remove" && c.tab === "Movies");
  const lastAdd = [...cmds].reverse().find((c) => c.op === "add" && c.tab === "No Di");
  check(
    "sheet converges on No Di (re-add after the stray Movies add)",
    !!lastRemove && !!lastAdd && cmds.indexOf(lastAdd) > cmds.findIndex((c) => c.op === "add" && c.tab === "Movies"),
    true,
  );

  // --- 2b. the manual "↩ Movies" undo can't quietly undo the rule ---
  const undo = await tryReq("POST", `/api/items/${movie.id}/move`, { from: "No Di", to: "Movies" });
  check("move No Di -> Movies refused", undo.status, 400);
  check("refusal explains why", /Diana has already scored/.test(undo.body?.error || ""), true);
  const stillNoDi = await one(movie.id);
  check("still on No Di after the refused move", stillNoDi.lists.includes("No Di"), true);

  // --- 3. James scores it later -> 2026 (unchanged behaviour) ---
  await req("PATCH", `/api/items/${movie.id}`, { my_rating: 90, di_rating: 88, move_to_2026: true });
  const b = await one(movie.id);
  check("James's score files to 2026", b.lists.includes("2026"), true);
  check("off the to-watch tabs", [b.lists.includes("No Di"), b.lists.includes("Movies")], [false, false]);
  check("watched_at stamped for James's viewing", b.watched_at, todayISO);

  // --- 4. James-only score (no Diana score) still files to 2026 ---
  await req("PATCH", `/api/items/${movie.id}`, { my_rating: null, di_rating: null, watched_at: null, first_watched_at: null });
  await req("PUT", `/api/items/${movie.id}/lists`, { lists: ["Movies"] });
  await req("PATCH", `/api/items/${movie.id}`, { my_rating: 80, di_rating: null, move_to_2026: true });
  const c = await one(movie.id);
  check("James-only score files to 2026", [c.lists.includes("2026"), c.watched_at != null], [true, true]);

  // --- 5. Diana scores a movie already on No Di: it just stays there ---
  await req("PATCH", `/api/items/${movie.id}`, { my_rating: null, di_rating: null, watched_at: null, first_watched_at: null });
  await req("PUT", `/api/items/${movie.id}/lists`, { lists: ["No Di"] });
  await req("PATCH", `/api/items/${movie.id}`, { my_rating: null, di_rating: 70, move_to_2026: true });
  const d = await one(movie.id);
  check("already on No Di stays on No Di", d.lists.includes("No Di"), true);
  check("no extra primary list", d.lists.filter((l) => ["Movies", "2026"].includes(l)), []);
  check("D score recorded", d.di_rating, 70);

  // --- 6. a non-score edit (Diana's comment) doesn't move an unscored movie ---
  await req("PATCH", `/api/items/${movie.id}`, { di_review: "temp test note" });
  const e = await one(movie.id);
  check("comment edit keeps it on No Di", e.lists.includes("No Di"), true);
  check("comment edit doesn't stamp watched_at", e.watched_at, null);
} finally {
  await req("PATCH", `/api/items/${movie.id}`, {
    my_rating: orig.my_rating,
    di_rating: orig.di_rating,
    watched_at: orig.watched_at,
    first_watched_at: orig.first_watched_at,
    di_review: orig.di_review,
  });
  await req("PUT", `/api/items/${movie.id}/lists`, { lists: orig.lists });
  if (Object.keys(orig.positions).length)
    await req("PUT", `/api/items/${movie.id}/positions`, { positions: orig.positions });
  const f = await one(movie.id);
  check(
    "restored",
    [f.my_rating, f.di_rating, f.watched_at, f.first_watched_at, f.di_review, JSON.stringify(f.lists) === JSON.stringify(orig.lists)],
    [orig.my_rating, orig.di_rating, orig.watched_at, orig.first_watched_at, orig.di_review, true],
  );
}

const pass = results.every(Boolean);
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
