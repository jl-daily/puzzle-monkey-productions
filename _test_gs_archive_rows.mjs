// The Sync menu's "Archive rows..." item must read the tab finished shows
// actually live on. It was written against "Shows Watched", a tab that no
// longer exists, so every use hit "no title header" and moved nothing.
//
// Loads the real movie-app.gs (with the sheet APIs stubbed) and drives the menu
// handler, then checks the rows really moved.
//
//   bun _test_gs_archive_rows.mjs
//   MOVIE_APP_SRC=/tmp/pre.gs bun _test_gs_archive_rows.mjs   (negative control:
//     the pre-fix script must fail the same assertions)
import { readFileSync } from "node:fs";

const SRC = process.env.MOVIE_APP_SRC || "movie-app.gs";

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
    clearContent() {},
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
    insertRowBefore(r) {
      g.splice(r - 1, 0, []);
    },
    deleteRow(r) {
      g.splice(r - 1, 1);
    },
    insertSheet: () => null,
    deleteSheet() {},
    hideSheet() {},
    setTabColor() {},
  };
}

const SHOW_HDR = ["Series Title", "Year", "Taste Score", "Genre", "J", "D", "CUR", "Epis", "Started", "Finished", "# Days", "Day / Epi", "Review"];
const MOVIE_HDR = ["Movie Title", "Year", "Taste Score", "Genre", "J", "D", "with Di?", "Reference", "Status"];

const ss = (sheets) => {
  const map = new Map(sheets.map((s) => [s.name, s]));
  return {
    getSheetByName: (n) => map.get(n) || null,
    insertSheet: (n, i) => {
      const s = makeSheet(n, []);
      map.set(n, s);
      return s;
    },
    getSheets: () => [...map.values()],
  };
};

// The user's spreadsheet: finished shows are filed by year; "Shows Watched" is
// gone. Rows 2-3 of "Archive 2026" are the ones the menu is asked to move.
function makeWorld() {
  const archiveYear = makeSheet("Archive 2026", [
    SHOW_HDR,
    ["Kitchen Nightmares", "2023", "72", "Reality", "81", "", "", "", "", "2026-01-04", "", "", "great"],
    ["The Vince Staples Show", "2024", "66", "Comedy", "81", "", "", "", "", "2026-02-11", "", "", "ok"],
    ["The Studio", "2025", "80", "Comedy", "92", "", "", "", "", "2026-03-02", "", "", ""],
  ]);
  const archive = makeSheet("Archive", [
    MOVIE_HDR,
    ["Barry", "2018", "", "", "75", "", "", "", ""],
  ]);
  const sheets = ss([archiveYear, archive, makeSheet("Currently Watching", [SHOW_HDR])]);
  const alerts = [];
  const prompts = [];
  const propMap = { SPREADSHEET_ID: "fake", APP_URL: "https://app.example", TABS: "Rewatch,Movies,2026" };
  const props = {
    getProperty: (k) => (k in propMap ? propMap[k] : null),
    setProperty: (k, v) => {
      propMap[k] = v;
    },
  };
  const GLOBALS = {
    SpreadsheetApp: {
      openById: () => sheets,
      getActiveSpreadsheet: () => sheets,
      getUi: () => ({
        alert: (m) => alerts.push(String(m)),
        prompt: (title, text) => {
          prompts.push({ title, text });
          return { getSelectedButton: () => "ok", getResponseText: () => "2-3" };
        },
        // Apps Script's Ui object carries both enums: Button for comparing
        // getSelectedButton(), ButtonSet for choosing the prompt's buttons.
        Button: { OK: "ok", CANCEL: "cancel", YES: "yes", NO: "no", CLOSE: "close" },
        ButtonSet: { OK: "ok", OK_CANCEL: "ok_cancel", YES_NO: "yes_no", YES_NO_CANCEL: "yes_no_cancel" },
        createMenu: () => ({ addItem: () => ({ addSeparator: () => ({ addItem: () => ({ addToUi() {} }) }) }) }),
      }),
      newDataValidation: () => ({ requireValueInList: () => ({ setAllowInvalid: () => ({ build: () => ({}) }) }) }),
    },
    PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep: () => {} },
    Session: { getScriptTimeZone: () => "UTC", getActiveUser: () => ({ getEmail: () => "x@y.z" }) },
    Logger: { log: () => {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: "json" } },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) }) },
    ScriptApp: {},
    HtmlService: {},
    DriveApp: {},
    MailApp: {},
  };
  const names = Object.keys(GLOBALS);
  // typeof guards: the pre-fix script (the negative control) has no
  // archiveRowsTab_, and asking for it directly would throw instead of failing
  const G = new Function(
    ...names,
    readFileSync(SRC, "utf8") +
      "\nreturn { archiveRows, headerRow_, archiveRowsTab_: (typeof archiveRowsTab_ === 'function' ? archiveRowsTab_ : null) };",
  )(...names.map((n) => GLOBALS[n]));
  return { G, sheets, alerts, prompts, propMap };
}

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const w = makeWorld();
const tab = w.G.archiveRowsTab_ ? w.G.archiveRowsTab_(w.sheets) : "(no such function)";
check("the menu reads this year's finished-shows tab", tab, "Archive 2026");

w.G.archiveRows();

check("no \"has no title header\" complaint", w.alerts.some((a) => /no title header|has no title/i.test(a)), false);
check("the prompt names the tab it will read", w.prompts[0] && w.prompts[0].title, "Archive rows — Archive 2026");
check("the prompt says which row is the first title", w.prompts[0] && /Row 2 is the first title/.test(w.prompts[0].text), true);
check("it reported moving the two rows", w.alerts, ["Moved 2 rows from Archive 2026 to Archive."]);

const srcRows = w.sheets.getSheetByName("Archive 2026").grid.map((r) => String(r[0] || ""));
check("rows 2-3 are gone from Archive 2026", srcRows, [SHOW_HDR[0], "The Studio"]);
check("and nothing else left that tab", srcRows.length, 2);

const dst = w.sheets.getSheetByName("Archive").grid;
const cell = (r, c) => (dst[r] ? dst[r][c] : null);
check("both rows landed at the end of Archive", [dst.length, cell(1, 0), cell(2, 0), cell(3, 0)], [4, "Barry", "Kitchen Nightmares", "The Vince Staples Show"]);
check("with their data intact", [cell(2, 4), cell(2, 12), cell(3, 4)], ["81", "great", "81"]);
check("the destination is added to the synced tab list", w.propMap.TABS.includes("Archive"), true);

// A spreadsheet with neither the current year's tab nor this script's default
// must complain about the tab, not silently do nothing.
const w2 = makeWorld();
const sheets2 = ss([makeSheet("Shows Watched", [SHOW_HDR, ["Old Show", "2020", "", "", "70", "", "", "", "", "", "", "", ""]]), makeSheet("Archive", [MOVIE_HDR])]);
check("with only the old tab name, there is no tab to read", w2.G.archiveRowsTab_ ? w2.G.archiveRowsTab_(sheets2) : "(no such function)", "Archive 2026");
check("its absence has no header to find", w2.G.headerRow_(sheets2.getSheetByName("Shows Watched")), 1);

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL_PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
