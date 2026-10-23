// End-to-end: POST /api/tidy-watched takes every scored movie off Movies / No
// Di in one pass, keeps the rest of its memberships, files a title with nothing
// else on 2026, and tells the sheet to move the rows. Unscored movies stay.
//
//   MOVIE_DB_PATH=/tmp/tidy.db bun _seed_tidy_watched.ts
//   STUB_LOG=/tmp/stub-tidy.log STUB_PORT=4112 bun _stub_sheet.mjs &
//   MOVIE_DB_PATH=/tmp/tidy.db SHEET_URL=http://localhost:4112 \
//     SHEET_TOKEN=test TASTE_REFRESH_TOKEN= PORT=3097 bun src/index.ts &
//   TEST_BASE=http://localhost:3097 STUB_LOG=/tmp/stub-tidy.log \
//     bun _test_tidy_watched_e2e.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.TEST_BASE || "http://localhost:3097";
const SHEET_LOG = process.env.STUB_LOG || "/tmp/stub-tidy.log";

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push([ok, name, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`]);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const req = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const sheetCmds = () => {
  try {
    return readFileSync(SHEET_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const byTitle = async () =>
  new Map((await req("GET", "/api/items")).map((x) => [x.title, x]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = await byTitle();
check(
  "setup",
  ["Tidy Solo", "Tidy Dup", "Tidy Fresh", "Tidy Movies", "Tidy Archived"].map(
    (t) => [...(before.get(t)?.lists || [])].sort(),
  ),
  [["No Di"], ["2026", "No Di"], ["No Di"], ["Movies"], ["Movies Archive", "No Di"]],
);

const logStart = sheetCmds().length;
const res = await req("POST", "/api/tidy-watched");
check("sweep reports the four it moved", res.moved, 4);

const after = await byTitle();
check("solo: No Di -> 2026", after.get("Tidy Solo").lists, ["2026"]);
check("dup: No Di dropped, 2026 kept", after.get("Tidy Dup").lists, ["2026"]);
check("unscored: left alone", after.get("Tidy Fresh").lists, ["No Di"]);
check("Movies: moved to 2026", after.get("Tidy Movies").lists, ["2026"]);
check(
  "archived: No Di dropped, archive kept",
  after.get("Tidy Archived").lists,
  ["Movies Archive"],
);
check(
  "scores survive the move",
  ["Tidy Solo", "Tidy Dup", "Tidy Movies", "Tidy Archived"].map(
    (t) => after.get(t).my_rating,
  ),
  [88, 77, 64, 91],
);
check("unscored movie has no score to keep", after.get("Tidy Fresh").my_rating, null);

// The queued gateway pushes are serialised in the app; wait for them to drain.
const want = 5;
for (let i = 0; i < 80 && sheetCmds().length - logStart < want; i++) await sleep(100);
const pushed = sheetCmds().slice(logStart);
const removes = pushed.filter((c) => c.op === "remove").map((c) => `${c.title}:${c.tab}`);
const adds = pushed.filter((c) => c.op === "add").map((c) => `${c.title}:${c.tab}`);
check(
  "sheet: the No Di / Movies rows go",
  removes.sort(),
  [
    "Tidy Archived:No Di",
    "Tidy Dup:No Di",
    "Tidy Movies:Movies",
    "Tidy Solo:No Di",
  ],
);
check(
  "sheet: only the titles with no 2026 row get one",
  adds.sort(),
  ["Tidy Movies:2026", "Tidy Solo:2026"],
);
const add = pushed.find((c) => c.op === "add" && c.title === "Tidy Solo");
check("sheet: the new 2026 row carries the scores and date", [add.j, add.d, add.date], [88, null, "2026-03-04"]);

// Idempotent: a second press finds nothing to do.
const again = await req("POST", "/api/tidy-watched");
check("second sweep is a no-op", again.moved, 0);
check("nothing moved on the second sweep", (await byTitle()).get("Tidy Solo").lists, ["2026"]);

const pass = results.every(([ok]) => ok);
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
