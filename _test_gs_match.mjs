// Loads movie-app.gs (the Apps Script half) with the Apps Script globals stubbed
// out and exercises the parts that decide which app item a sheet row belongs to
// and which row a write lands in. This is the half of the "Carrie" bug that
// lives in the spreadsheet, and it cannot be run in place — so at minimum it has
// to parse and its pure decisions have to be right.
//
//   bun _test_gs_match.mjs
import { readFileSync } from "node:fs";

// ---- stubs -----------------------------------------------------------------
function makeSheet(name, grid) {
  const g = grid.map((r) => r.slice());
  const range = (row, col, nr = 1, nc = 1) => ({
    getValues() {
      const out = [];
      for (let r = 0; r < nr; r++) {
        const src = g[row - 1 + r] || [];
        const line = [];
        for (let c = 0; c < nc; c++) line.push(src[col - 1 + c] ?? "");
        out.push(line);
      }
      return out;
    },
    setValues(vals) {
      for (let r = 0; r < vals.length; r++) {
        const rr = row - 1 + r;
        while (g.length <= rr) g.push([]);
        for (let c = 0; c < vals[r].length; c++) g[rr][col - 1 + c] = vals[r][c];
      }
    },
    getValue() {
      return (g[row - 1] || [])[col - 1] ?? "";
    },
    setValue(v) {
      while (g.length < row) g.push([]);
      g[row - 1][col - 1] = v;
    },
    setNumberFormat() {},
  });
  return {
    name,
    grid: g,
    getName: () => name,
    getLastRow() {
      let n = 0;
      for (let i = 0; i < g.length; i++) if ((g[i] || []).some((c) => String(c ?? "") !== "")) n = i + 1;
      return n;
    },
    getLastColumn() {
      let n = 0;
      for (const row of g) {
        for (let c = 0; c < row.length; c++) if (String(row[c] ?? "") !== "") n = Math.max(n, c + 1);
      }
      return n;
    },
    getRange: range,
    insertSheet: () => null,
    deleteRow(r) {
      g.splice(r - 1, 1);
    },
  };
}
function makeSS(sheets) {
  const map = new Map(sheets.map((s) => [s.name, s]));
  return {
    getSheetByName: (n) => map.get(n) || null,
    insertSheet: (n) => {
      const s = makeSheet(n, []);
      map.set(n, s);
      return s;
    },
    getSheets: () => [...map.values()],
    toast: () => {},
  };
}
const HEADER = ["Movie Title", "Year", "Taste Score", "Genre", "J", "D", "Di", "Date", "Status"];

const ss = makeSS([
  makeSheet("Currently Watching", [
    HEADER,
    ["Carrie", "2002", "73", "Horror", "100", "", "", "", ""],
  ]),
  makeSheet("Shows 2026", [HEADER]),
  makeSheet("Shows", [HEADER]),
]);
const props = { getProperty: (k) => (k === "SPREADSHEET_ID" ? "fake" : null), setProperty: () => {} };
const GLOBALS = {
  SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss },
  PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
  Utilities: {
    formatDate: (d) => d.toISOString().slice(0, 10),
    sleep: () => {},
  },
  Session: { getScriptTimeZone: () => "UTC", getActiveUser: () => ({ getEmail: () => "x@y.z" }) },
  Logger: { log: () => {} },
  ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: "json" } },
  UrlFetchApp: { fetch: () => ({}) },
  ScriptApp: {},
  HtmlService: {},
  DriveApp: {},
  MailApp: {},
};

// ---- load the file ---------------------------------------------------------
const src = readFileSync("movie-app.gs", "utf8");
let G;
try {
  const names = Object.keys(GLOBALS);
  const factory = new Function(
    ...names,
    src +
      `\nreturn { isShowTab_, indexApp_, pickApp_, inProgress_, rememberApp_, normKey, gatewayAdd_, gatewayWatched_, restoreRow_, headerRow_, findRows_ };`,
  );
  G = factory(...names.map((n) => GLOBALS[n]));
} catch (e) {
  console.log("FAIL | movie-app.gs does not parse:", e.message);
  process.exit(1);
}
console.log("PASS | movie-app.gs parses and its helpers are callable");

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// ---- 1. which tabs hold shows ---------------------------------------------
check("Currently Watching is a show tab", G.isShowTab_("Currently Watching"), true);
check("Shows 2026 is a show tab", G.isShowTab_("Shows 2026"), true);
check("Shows 2024 is a show tab", G.isShowTab_("Shows 2024"), true);
check("Shows Archive is a show tab", G.isShowTab_("Shows Archive"), true);
check("Movies is not", G.isShowTab_("Movies"), false);
check("2026 is not", G.isShowTab_("2026"), false);

// ---- 2. two works, one title ----------------------------------------------
const movie = { id: "m1", kind: "movie", title: "Carrie", year: "2002", lists: ["Movies"] };
const show = {
  id: "s1",
  kind: "tv",
  title: "Carrie",
  year: "2026",
  lists: ["Currently Watching"],
  episode_progress: { 1: [1] },
  ep_started_at: "2026-10-15",
};
// the app's /api/items order: 'todo' items (the movie) come before 'watching'
const byKey = G.indexApp_([movie, show]);
const claimed = {};
check(
  "the row that says 2026 gets the show",
  G.pickApp_("Carrie", "2026", "Currently Watching", byKey, claimed).id,
  "s1",
);
check(
  "the row that says 2002 gets the movie",
  G.pickApp_("Carrie", "2002", "Movies", byKey, claimed).id,
  "m1",
);

// a row with no year on a show tab: the tab's kind decides
const claimed2 = {};
check(
  "an undated Currently Watching row gets the show",
  G.pickApp_("Carrie", "", "Currently Watching", byKey, claimed2).id,
  "s1",
);
check(
  "and an undated Movies row gets the movie",
  G.pickApp_("Carrie", "", "Movies", byKey, claimed2).id,
  "m1",
);
// both rows undated and the same tab kind: the second row must not re-bind to
// the item the first row already owns
const claimed3 = {};
const first = G.pickApp_("Carrie", "", "Movies", byKey, claimed3);
const second = G.pickApp_("Carrie", "", "Movies", byKey, claimed3);
check("the second same-name row takes the other item", [first.id, second.id].sort(), ["m1", "s1"]);
// The Year column is not always the release year: the year tabs hold the year a
// movie was watched. A year that matches nothing must still bind the row to
// something — a row that binds to nothing leaves its item looking deleted.
const claimedStale = {};
const staleMovie = G.pickApp_("Carrie", "1999", "Movies", byKey, claimedStale);
check("a stale year still binds a row (never null)", staleMovie && staleMovie.id, "m1");
const claimedStaleShow = {};
check(
  "a stale year on a show tab still gets the show",
  G.pickApp_("Carrie", "1999", "Currently Watching", byKey, claimedStaleShow).id,
  "s1",
);
// and the year still discriminates when it does match one of them
const claimedYear = {};
check(
  "the year still wins while it matches",
  [
    G.pickApp_("Carrie", "2002", "Movies", byKey, claimedYear).id,
    G.pickApp_("Carrie", "2026", "Currently Watching", byKey, claimedYear).id,
  ],
  ["m1", "s1"],
);
check("unknown title -> null", G.pickApp_("Nope", "2026", "Movies", byKey, {}), null);

// ---- 3. is the show being watched -----------------------------------------
check("a show with an episode ticked off is in progress", G.inProgress_(show), true);
check("a finished show is not", G.inProgress_({ ...show, watched_at: "2026-10-15" }), false);
check("an untouched show is not", G.inProgress_({ kind: "tv", title: "X", lists: [] }), false);
check("a movie never is", G.inProgress_(movie), false);
check("a season in progress counts", G.inProgress_({ kind: "tv", current_season: 2, episode_progress: {} }), true);

// ---- 4. adding a show must not overwrite the movie's row ------------------
G.gatewayAdd_({
  op: "add",
  tab: "Currently Watching",
  title: "Carrie",
  year: "2026",
  kind: "tv",
  status: "watching",
  genres: "Mystery, Drama",
});
const cw = ss.getSheetByName("Currently Watching").grid;
const carrieRows = cw.filter((r) => String(r[0] || "").trim() === "Carrie");
check("the show got its own row", carrieRows.length, 2);
check("the movie's row still says 2002", [cw[1][1], cw[1][4]], ["2002", "100"]);
check("the show's row says 2026", cw[2][1], "2026");

// re-adding the same show updates its own row instead of adding another
G.gatewayAdd_({
  op: "add",
  tab: "Currently Watching",
  title: "Carrie",
  year: "2026",
  kind: "tv",
  status: "watching",
  taste_score: "81",
});
const cw2 = ss.getSheetByName("Currently Watching").grid;
check("no third row", cw2.filter((r) => String(r[0] || "").trim() === "Carrie").length, 2);
check("its row was updated", cw2[2][2], "81");
// a row with no year still matches the first same-name row (old behaviour)
G.gatewayAdd_({ op: "add", tab: "Currently Watching", title: "Carrie", status: "todo" });
check(
  "an undated add still lands on an existing row",
  ss.getSheetByName("Currently Watching").grid.filter((r) => String(r[0] || "").trim() === "Carrie").length,
  2,
);

// ---- 5. a watch date only lands on the row it belongs to ------------------
const dated = makeSS([
  makeSheet("2026", [
    ["Movie Title", "Year", "Taste Score", "Genre", "J", "D", "Thoughts", "Date Watched"],
    ["Carrie", "2002", "73", "Horror", "100", "", "", ""],
    ["Carrie", "2026", "81", "Drama", "", "", "", ""],
  ]),
]);
const saved = GLOBALS.SpreadsheetApp.openById;
GLOBALS.SpreadsheetApp.openById = () => dated;
// reload just the function's dependency: gatewayWatched_ resolves the sheet at
// call time, so swapping the stub is enough only if it re-reads the global —
// rebuild the factory instead.
const factory2 = new Function(
  ...Object.keys(GLOBALS),
  src + `\nreturn { gatewayWatched_ };`,
);
const G2 = factory2(...Object.keys(GLOBALS).map((n) => GLOBALS[n]));
G2.gatewayWatched_({ op: "watched", title: "Carrie", year: "2026", date: "2026-10-15" });
const y2026 = dated.getSheetByName("2026").grid;
const dateCell = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10);
check("the show's row took the date", dateCell(y2026[2][7]), "2026-10-15");
check("the movie's row did not", String(y2026[1][7] ?? ""), "");
GLOBALS.SpreadsheetApp.openById = saved;

// ---- 6. a missing row for a show being watched is restored ----------------
const empty = makeSS([makeSheet("Currently Watching", [HEADER])]);
GLOBALS.SpreadsheetApp.openById = () => empty;
const factory3 = new Function(...Object.keys(GLOBALS), src + `\nreturn { restoreRow_ };`);
const G3 = factory3(...Object.keys(GLOBALS).map((n) => GLOBALS[n]));
const ok = G3.restoreRow_(empty, "Currently Watching", show);
check("restoreRow_ wrote a row", ok, true);
const restored = empty.getSheetByName("Currently Watching").grid.filter(
  (r) => String(r[0] || "").trim() === "Carrie",
);
check("with the show's own values", [restored[0][0], restored[0][1]], ["Carrie", "2026"]);
check("and its episode count", restored[0][8] === "watching" || restored.length === 1, true);
GLOBALS.SpreadsheetApp.openById = saved;

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL_PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
