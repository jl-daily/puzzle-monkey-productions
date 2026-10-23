// End-to-end companion to _test_nodi_remove.mjs: drives the exact payload the
// site sends when a seen movie is taken off No Di, against a real local server
// and the stub sheet gateway, and asserts the app state plus the sheet orders.
//
//   MOVIE_DB_PATH=/tmp/nodi-remove.db bun _seed_nodi_remove.ts   # prints the id
//   STUB_LOG=/tmp/stub-remove.log STUB_PORT=4111 bun _stub_sheet.mjs &
//   MOVIE_DB_PATH=/tmp/nodi-remove.db SHEET_URL=http://localhost:4111 \
//     SHEET_TOKEN=test TASTE_REFRESH_TOKEN= PORT=3098 bun src/index.ts &
//   SEED_ID=<id> TEST_BASE=http://localhost:3098 STUB_LOG=/tmp/stub-remove.log \
//     bun _test_nodi_remove_e2e.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.TEST_BASE || "http://localhost:3098";
const SHEET_LOG = process.env.STUB_LOG || "/tmp/stub-remove.log";
const ID = process.env.SEED_ID;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const find = async () => (await req("GET", "/api/items")).find((x) => x.id === ID);
const seeded = await find();
check("seeded on No Di, seen by James", [seeded.lists, seeded.my_rating, seeded.watched_at], [["No Di"], 86, "2026-08-11"]);

const logStart = sheetCmds().length;

// Exactly what the card's "→ 2026" button sends (fileTo2026).
const updated = await req("PUT", `/api/items/${ID}/lists`, { lists: ["2026"] });
check("off No Di", updated.lists.includes("No Di"), false);
check("on 2026", updated.lists.includes("2026"), true);
check("score survives", [updated.my_rating, updated.di_rating], [86, 86]);

// Let the queued gateway pushes drain (they are serialised in the app).
for (let i = 0; i < 40 && sheetCmds().length <= logStart; i++) await sleep(150);

const pushed = sheetCmds().slice(logStart);
check("sheet: No Di row removed", pushed.some((c) => c.op === "remove" && c.tab === "No Di"), true);
const add = pushed.find((c) => c.op === "add" && c.tab === "2026");
check("sheet: 2026 row written", !!add, true);
check("sheet: scores travel with it", add && [add.j, add.d], [86, 86]);
check("sheet: no Movies/No Di add", pushed.filter((c) => c.op === "add" && c.tab !== "2026").length, 0);

check("app still has it (not deleted)", !!(await find()), true);

const pass = results.every(([ok]) => ok);
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
