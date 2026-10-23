// Instrumented version of the dry run: same stub sheet, same stubbed app, but
// it traces one title (`PROBE` env var, default "Christmas Break-In") through
// doSync — every pickApp_ call for it, every by-title call, and every DELETE —
// so a "would delete" line can be explained rather than guessed at.
//
//   cd /tmp/dryrun && ENV_FILE=/home/opc/movie-app/.env APP_BASE=http://localhost:3002 \
//     bun _dryrun_probe.mjs /tmp/dryrun/sheet-dump.json
import { readFileSync } from "node:fs";

const APP = process.env.APP_BASE || "http://localhost:3002";
const PROBE = process.env.PROBE || "Christmas Break-In";
const dump = JSON.parse(readFileSync(process.argv[2] || "/tmp/dryrun/sheet-dump.json", "utf8")).tabs || {};
const items = await (await fetch(APP + "/api/items")).json();
console.log(`# app: ${items.length} items · sheet: ${Object.keys(dump).length} tabs · probing "${PROBE}"`);

const HEADER = ["Movie Title", "Year", "Taste Score", "Genre", "J", "D", "with Di?", "Date Watched", "Status"];
const rowsFor = (tab) =>
  (dump[tab] || [])
    .filter((r) => String(r.title || "").trim() !== "")
    .map((r) => [
      String(r.title),
      String(r.year ?? ""),
      "",
      "",
      String(r.j ?? ""),
      "",
      "",
      String(r.watched_at ?? ""),
      "",
    ]);

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
      for (let i = 0; i < g.length; i++) if ((g[i] || []).some((c) => String(c ?? "") !== "")) n = i + 1;
      return n;
    },
    getLastColumn() {
      let n = 0;
      for (const row of g) for (let c = 0; c < row.length; c++) if (String(row[c] ?? "") !== "") n = Math.max(n, c + 1);
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

const tabs = Object.keys(dump);
const sheets = tabs.map((t) => makeSheet(t, [HEADER, ...rowsFor(t)]));
const map = new Map(sheets.map((s) => [s.name, s]));
const toasts = [];
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
const propMap = { SPREADSHEET_ID: "fake", APP_URL: APP, TABS: tabs.join(",") };
const calls = [];
const GLOBALS = {
  SpreadsheetApp: {
    openById: () => ss,
    getActiveSpreadsheet: () => ss,
    getUi: () => ({ createMenu: () => ({ addItem: () => ({ addToUi() {} }) }), alert() {} }),
    newDataValidation: () => ({ requireValueInList: () => ({ setAllowInvalid: () => ({ build: () => ({}) }) }) }),
  },
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (k) => propMap[k] ?? null, setProperty: (k, v) => (propMap[k] = v) }),
    getUserProperties: () => ({ getProperty: () => null }),
  },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep: () => {} },
  Session: { getScriptTimeZone: () => "UTC", getActiveUser: () => ({ getEmail: () => "x@y.z" }) },
  Logger: { log: () => {} },
  ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: "json" } },
  UrlFetchApp: {
    fetch: (url, opts) => {
      const method = (opts && opts.method) || "GET";
      const path = String(url).replace(APP, "");
      if (/^\/api\/items$/.test(path)) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(items) };
      const id = path.split("/")[3];
      const it = items.find((x) => x.id === id);
      if (it && /^\/api\/items\/[^/]+/.test(path) && method !== "DELETE")
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(it) };
      calls.push({
        method,
        path,
        body: opts && opts.payload ? JSON.parse(opts.payload) : null,
        stack: method === "DELETE" ? String(new Error().stack).split("\n").slice(2, 5).map((s) => s.trim()) : undefined,
      });
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, updated: 1, refreshed: 0 }) };
    },
  },
  ScriptApp: {}, HtmlService: {}, DriveApp: {}, MailApp: {},
};

const src = readFileSync("movie-app.gs", "utf8");
const trace = [];
const injected =
  src +
  `
var __T = [];
var __pick0 = pickApp_;
pickApp_ = function(title, year, tab, byKey, claimed) {
  var r = __pick0(title, year, tab, byKey, claimed);
  if (normKey(title) === normKey("${PROBE}")) {
    var cands = (byKey[normKey(title)] || []);
    __T.push(["pick", tab, "rowYear=" + String(year), "cands=" + cands.map(function(c){return c.kind + c.year;}).join(","), "-> " + (r ? r.id.slice(0,8) + ":" + r.kind + r.year : "NULL")]);
  }
  return r;
};
var __fetch0 = fetchJson_;
fetchJson_ = function(url, opts) {
  var u = String(url);
  if (u.indexOf("by-title") !== -1 || (opts && opts.method === "DELETE")) {
    __T.push(["http", (opts && opts.method) || "GET", u.replace(/^.*\\/api/, "/api"), (opts && opts.payload) || ""]);
  }
  return __fetch0(url, opts);
};
return { doSync: doSync, __T: __T, tabs_: tabs_ };`;
const names = Object.keys(GLOBALS);
const G = new Function(...names, injected)(...names.map((n) => GLOBALS[n]));

console.log("# tabs the script will visit:", JSON.stringify(G.tabs_()));
G.doSync();

const interesting = calls.filter((c) => /\/lists$/.test(c.path) || c.method === "DELETE" || /\/positions$/.test(c.path));
const idOf = (p) => p.split("/")[3];
const nameOf = (id) => {
  const it = items.find((i) => i.id === id) || {};
  return `${it.title} (${it.kind} ${it.year}) lists=${JSON.stringify(it.lists || [])}`;
};
console.log(`# calls: ${calls.length} · lists/deletes/positions: ${interesting.length}`);
for (const c of calls.filter((x) => x.method === "DELETE").slice(0, 3))
  console.log("   DELETE", nameOf(idOf(c.path)), "\n      after", calls.indexOf(c), "calls ·", JSON.stringify(c.stack));
console.log("# trace for the probed title:");
for (const t of G.__T) console.log("   ", JSON.stringify(t));
