// Regression check for the delete pass in doSync. Moving a title's row from a
// synced tab onto a tab the sync does not read (the Archive tabs) used to delete
// the app item while the row sat in the sheet untouched; it must move the item
// instead. Deleting the row outright must still delete the item, or the sheet
// would lose the ability to remove anything.
//
//   bun _test_gs_archive_rescue.mjs
import { readFileSync } from "node:fs";

const HEADER = ["Movie Title", "Year", "Taste Score", "Genre", "J", "D", "Di", "Date", "Status"];
const ARCHIVE_HEADER = ["Series Title", "Year", "Taste Score", "Genre", "J", "D", "CUR", "Epis", "Started", "Finished"];

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
    getValue: () => (g[row - 1] || [])[col - 1] ?? "",
    setValue(v) {
      while (g.length < row) g.push([]);
      g[row - 1][col - 1] = v;
    },
    setNumberFormat() {},
    setDataValidation() {},
  });
  return {
    name,
    grid: g,
    getName: () => name,
    getLastRow() {
      let n = 0;
      for (let i = 0; i < g.length; i++)
        if ((g[i] || []).some((c) => String(c ?? "") !== "")) n = i + 1;
      return n;
    },
    getLastColumn() {
      let n = 0;
      for (const row of g)
        for (let c = 0; c < row.length; c++)
          if (String(row[c] ?? "") !== "") n = Math.max(n, c + 1);
      return n;
    },
    getRange: range,
    deleteRow(r) {
      g.splice(r - 1, 1);
    },
    deleteSheet() {},
    hideSheet() {},
    setTabColor() {},
  };
}

// One stubbed world: sheets + stubbed app + the script's own globals.
function world(sheetDefs, items, tabs) {
  const sheets = sheetDefs.map(([name, grid]) => makeSheet(name, grid));
  const map = new Map(sheets.map((s) => [s.name, s]));
  const toasts = [];
  const calls = [];
  const ss = {
    getSheetByName: (n) => map.get(n) || null,
    insertSheet: (n) => {
      const s = makeSheet(n, []);
      map.set(n, s);
      return s;
    },
    getSheets: () => [...map.values()],
    toast: (m) => toasts.push(String(m)),
  };
  const propMap = { SPREADSHEET_ID: "fake", APP_URL: "https://app.example", TABS: tabs };
  const props = {
    getProperty: (k) => (k in propMap ? propMap[k] : null),
    setProperty: (k, v) => {
      propMap[k] = v;
    },
  };
  const respond = (body) => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify(body),
  });
  const GLOBALS = {
    SpreadsheetApp: {
      openById: () => ss,
      getActiveSpreadsheet: () => ss,
      getUi: () => ({ createMenu: () => ({ addItem: () => ({ addToUi() {} }) }), alert() {} }),
      newDataValidation: () => ({
        requireValueInList: () => ({ setAllowInvalid: () => ({ build: () => ({}) }) }),
      }),
    },
    PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep: () => {} },
    Session: { getScriptTimeZone: () => "UTC", getActiveUser: () => ({ getEmail: () => "x@y.z" }) },
    Logger: { log: () => {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: "json" } },
    UrlFetchApp: {
      fetch: (url, opts) => {
        calls.push({ url, method: (opts && opts.method) || "GET", payload: opts && opts.payload });
        if (/\/api\/items$/.test(url)) return respond(items);
        const id = String(url).split("/")[4];
        const it = items.find((x) => x.id === id);
        if (it && /\/api\/items\/[^/]+/.test(url) && (opts && opts.method) !== "DELETE") return respond(it);
        return respond({ ok: true, updated: 1, refreshed: 0 });
      },
    },
    ScriptApp: {},
    HtmlService: {},
    DriveApp: {},
    MailApp: {},
  };
  const src = readFileSync("movie-app.gs", "utf8");
  const names = Object.keys(GLOBALS);
  return {
    ss,
    toasts,
    calls,
    G: new Function(...names, src + `\nreturn { doSync };`)(...names.map((n) => GLOBALS[n])),
  };
}

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const airbender = {
  id: "m1",
  kind: "movie",
  title: "Avatar Aang: The Last Airbender",
  year: "2026",
  lists: ["2026"],
  my_rating: 87,
  taste_score: 71,
  genres: "Animation",
  positions: { 2026: 4 },
  flags: {},
};

// A: the row was dragged from the synced "2026" tab onto "Archive 2026", a tab
// the sync does not read.
const a = world(
  [
    ["2026", [HEADER]],
    ["Archive 2026", [ARCHIVE_HEADER, ["Avatar Aang: The Last Airbender", "2026", "71", "Animation", "87"]]],
  ],
  [airbender],
  "2026",
);
a.G.doSync();
console.log("# A toasts:", JSON.stringify(a.toasts));
check("A: nothing was deleted", a.calls.filter((c) => c.method === "DELETE"), []);
const moves = a.calls.filter((c) => /\/api\/items\/m1\/lists$/.test(c.url));
check("A: the item was moved to the archive tab's list", moves.length, 1);
check(
  "A: to that list",
  moves.length ? JSON.parse(moves[0].payload).lists : null,
  ["Archive 2026"],
);
check("A: the toast says it was archived, not deleted", a.toasts.some((t) => /archived 1\b/.test(t)), true);
check("A: and reports no deletions", a.toasts.every((t) => /deleted 0\b/.test(t)), true);

// B: the row was deleted from the sheet outright — that is still a removal.
const b = world([["2026", [HEADER]], ["Archive 2026", [ARCHIVE_HEADER]]], [airbender], "2026");
b.G.doSync();
console.log("# B toasts:", JSON.stringify(b.toasts));
check("B: the item was deleted", b.calls.filter((c) => c.method === "DELETE").length, 1);
check("B: no rescue was attempted", b.calls.filter((c) => /\/api\/items\/m1\/lists$/.test(c.url)), []);
check("B: the toast says deleted 1", b.toasts.some((t) => /deleted 1\b/.test(t)), true);

// C: a show mid-watch with no row anywhere is neither archived nor deleted —
// the row-restore loop puts its row back before the delete pass sees it (the
// in-progress guard behind that is the second line of defence).
const show = {
  id: "s1",
  kind: "tv",
  title: "Some Show",
  year: "2026",
  lists: ["Currently Watching"],
  episode_progress: { 1: [3] },
  season_counts: { 1: 8 },
  ep_started_at: "2026-10-01",
  flags: {},
};
const c = world(
  [
    ["Currently Watching", [["Series Title", "Year", "Taste Score", "Genre", "J", "D", "CUR", "Epis", "Started", "Finished"]]],
    ["Archive 2026", [ARCHIVE_HEADER, ["Some Show", "2026", "70", "Drama", "80"]]],
  ],
  [show],
  "Currently Watching",
);
c.G.doSync();
console.log("# C toasts:", JSON.stringify(c.toasts));
check("C: the show is not deleted", c.calls.filter((x) => x.method === "DELETE"), []);
check("C: and not archived", c.calls.filter((x) => /\/api\/items\/s1\/lists$/.test(x.url)), []);
check("C: its missing row was restored instead", c.toasts.some((t) => /restored 1 row\(s\)/.test(t)), true);
check(
  "C: and the row carries the show's own year",
  c.ss.getSheetByName("Currently Watching").grid.some((r) => String(r[1]) === "2026"),
  true,
);

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL_PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
