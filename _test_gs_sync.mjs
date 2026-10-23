// End-to-end check of doSync (the Apps Script reconciler) against stubbed Google
// APIs and a stubbed app: a show the app is watching must not be deleted because
// the spreadsheet's single "Carrie" row is occupied by the 2002 movie, and its
// missing row must come back.
//
//   bun _test_gs_sync.mjs
import { readFileSync } from "node:fs";

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

const HEADER = ["Movie Title", "Year", "Taste Score", "Genre", "J", "D", "Di", "Date", "Status"];
const TABLIST = "Currently Watching,Movies,Shows,2021";
// A movie whose sheet row carries a different year than the item does: the year
// tabs hold the year it was watched, not necessarily the release year. The row
// must still hide the item from the delete pass.
const stale = {
  id: "m2",
  kind: "movie",
  title: "Christmas Break-In",
  year: "2018",
  lists: ["2021"],
  my_rating: 90,
  taste_score: 60,
  genres: "Family",
  positions: { 2021: 2 },
  flags: {},
};

const movie = {
  id: "m1",
  kind: "movie",
  title: "Carrie",
  year: "2002",
  lists: ["Currently Watching"],
  my_rating: 100,
  taste_score: 73,
  genres: "Horror",
  positions: { "Currently Watching": 7 },
  flags: {},
};
const show = {
  id: "s1",
  kind: "tv",
  title: "Carrie",
  year: "2026",
  lists: ["Currently Watching"],
  episode_progress: { 1: [1] },
  season_counts: { 1: 8 },
  ep_started_at: "2026-10-15",
  genres: "Mystery, Drama",
  positions: { "Currently Watching": 3 },
  flags: {},
};

const ss = makeSS([
  // the user's sheet, exactly as it stands: one "Carrie" row, the 2002 film's
  makeSheet("Currently Watching", [
    HEADER,
    ["Carrie", "2002", "73", "Horror", "100", "", "", ""],
  ]),
  makeSheet("Movies", [HEADER]),
  makeSheet("Shows", [HEADER]),
  makeSheet("2021", [
    HEADER,
    ["Christmas Break-In", "2021", "60", "Family", "90", "", "", ""],
  ]),
]);

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
    toast(msg, title) {
      toasts.push(String(msg));
    },
  };
}

const toasts = [];
const propMap = { SPREADSHEET_ID: "fake", APP_URL: "https://app.example", TABS: TABLIST };
const props = {
  getProperty: (k) => (k in propMap ? propMap[k] : null),
  setProperty: (k, v) => {
    propMap[k] = v;
  },
};
const calls = [];
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
      if (/\/api\/items$/.test(url)) return respond([movie, show, stale]);
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
const G = new Function(...names, src + `\nreturn { doSync, inProgress_, pickApp_, indexApp_ };`)(
  ...names.map((n) => GLOBALS[n]),
);

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

G.doSync();

console.log("# toasts:", JSON.stringify(toasts));
const deletes = calls.filter((c) => c.method === "DELETE");
check("nothing was deleted", deletes, []);
check("the show was not un-listed", calls.filter((c) => /\/api\/items\/s1\/lists/.test(c.url)).length, 0);
check("the sync reported the restore", toasts.some((t) => /restored 1 row/.test(t)), true);
check("and claimed no deletions", toasts.every((t) => /deleted 0\b/.test(t)), true);

const cw = ss.getSheetByName("Currently Watching").grid.filter(
  (r) => String(r[0] || "").trim() === "Carrie",
);
check("the show's row is back on Currently Watching", cw.length, 2);
check(
  "the movie's row is untouched",
  [cw.find((r) => String(r[1]) === "2002")[4], cw[0][1]],
  ["100", "2002"],
);
check(
  "with the show's own year",
  cw.some((r) => String(r[1]) === "2026"),
  true,
);
// the sheet's own row for the movie still governs the movie: it already sits on
// the tab that row is on, so the sync has nothing to change
check(
  "the movie is left alone",
  calls.filter((c) => /\/api\/items\/m1\/lists/.test(c.url)).length,
  0,
);
// a row whose year disagrees with the item (the year tabs hold the year it was
// watched) still counts as that item's row
// the only call the sync may make for it is the position bookkeeping that every
// matched row gets — never a re-list or a delete
check(
  "a row with a disagreeing year still hides its item from the delete pass",
  calls.filter((c) => /m2/.test(c.url) && /\/(lists)$/.test(c.url)).length,
  0,
);
check(
  "and its item is never sent to the delete route",
  calls.filter((c) => c.method === "DELETE").length,
  0,
);
check(
  "the only call for it is the row-order pass",
  calls.filter((c) => /m2/.test(c.url)).every((c) => /positions$/.test(c.url)),
  true,
);
check(
  "and no second row was written for it",
  ss.getSheetByName("2021").grid.filter((r) => String(r[0] || "").trim() === "Christmas Break-In").length,
  1,
);
console.log(`# calls: ${calls.map((c) => `${c.method} ${c.url.replace("https://app.example", "")}`).join(", ")}`);

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL_PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
