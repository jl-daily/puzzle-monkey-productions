// Dry run of the *patched* doSync against your real data: it reads the live
// app's items and a read-only dump of the spreadsheet, then runs the script's
// own logic with the network and the sheet stubbed out. Nothing is written —
// not to the app, not to the spreadsheet. It prints every call the sync would
// make and the rows it would touch, so the next sync is not a surprise.
//
//   node _dryrun_gs_sync.mjs            (reads .env for the sheet gateway)
import { existsSync, readFileSync } from "node:fs";

const APP = process.env.APP_BASE || "https://129-80-103-21.sslip.io";
const env = Object.fromEntries(
  readFileSync(process.env.ENV_FILE || ".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

// ---- read-only inputs ------------------------------------------------------
const items = await (await fetch(APP + "/api/items")).json();
// The sheet dump: reuse a saved one when present (dump_all_tabs.mjs retries
// every tab), otherwise fetch it here with retries — Google's gateway answers
// scripted reads with an HTML page often enough that a single attempt silently
// yields zero tabs and a run that deletes nothing for the wrong reason.
const dumpFile = process.env.SHEET_DUMP || "/tmp/sheet-dump.json";
let dump;
if (existsSync(dumpFile) && !process.env.FRESH_DUMP) {
  dump = JSON.parse(readFileSync(dumpFile, "utf8")).tabs || {};
  console.log(`# sheet dump reused from ${dumpFile}`);
} else {
  for (let i = 0; i < 4; i++) {
    const dumpRes = await fetch(env.SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: env.SHEET_TOKEN, op: "dump" }),
    });
    const body = await dumpRes.text();
    try {
      dump = JSON.parse(body).tabs || {};
    } catch {
      dump = {};
    }
    if (Object.keys(dump).length) break;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
}
console.log(`# app: ${items.length} items · sheet: ${Object.keys(dump).length} tabs`);

const HEADER = ["Movie Title", "Year", "Taste Score", "Genre", "J", "D", "with Di?", "Date Watched", "Status"];
// The dump exposes title/year/j/review/watched_at; the rest of the columns are
// not needed to see what the sync decides for a title.
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

// ---- stubbed Apps Script ---------------------------------------------------
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

const propMap = {
  SPREADSHEET_ID: "fake",
  APP_URL: APP,
  // The script's own tab list (script property TABS). Pass the real one —
  // TABS=... — or the run approximates it with every tab in the dump, which
  // makes the sync look like it processes tabs it actually never reads (a list
  // whose tab is not synced is never "processed", so it can never be deleted).
  // Read the real value from the gateway: op "reviews" returns the tab list.
  TABS: process.env.TABS || tabs.join(","),
};
const calls = [];
const GLOBALS = {
  SpreadsheetApp: {
    openById: () => ss,
    getActiveSpreadsheet: () => ss,
    getUi: () => ({ createMenu: () => ({ addItem: () => ({ addToUi() {} }) }), alert() {} }),
    newDataValidation: () => ({ requireValueInList: () => ({ setAllowInvalid: () => ({ build: () => ({}) }) }) }),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => propMap[k] ?? null, setProperty: (k, v) => (propMap[k] = v) }), getUserProperties: () => ({ getProperty: () => null }) },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep: () => {} },
  Session: { getScriptTimeZone: () => "UTC", getActiveUser: () => ({ getEmail: () => "x@y.z" }) },
  Logger: { log: () => {} },
  ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: "json" } },
  UrlFetchApp: {
    fetch: (url, opts) => {
      const method = (opts && opts.method) || "GET";
      const path = String(url).replace(APP, "");
      if (/^\/api\/items$/.test(path)) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(items) };
      calls.push({ method, path, body: opts && opts.payload ? JSON.parse(opts.payload) : null });
      // Every write on an item answers with the updated item — the script keeps
      // the item it gets back (id and all), so a stub that answers "ok" would
      // make the sync forget which item a row belongs to and report a deletion
      // that the real app never causes.
      const id = path.split("/")[3];
      const it = items.find((x) => x.id === id);
      if (it && /^\/api\/items\/[^/]+/.test(path) && method !== "DELETE")
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(it) };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, updated: 1, refreshed: 0 }) };
    },
  },
  ScriptApp: {},
  HtmlService: {},
  DriveApp: {},
  MailApp: {},
};

const src = readFileSync("movie-app.gs", "utf8");
const names = Object.keys(GLOBALS);
const G = new Function(...names, src + `\nreturn { doSync };`)(...names.map((n) => GLOBALS[n]));

const carrieBefore = (map.get("Currently Watching")?.grid || []).filter((r) => /^carrie$/i.test(String(r[0] || "")));

// ---- run -------------------------------------------------------------------
G.doSync();

const interesting = calls.filter(
  (c) => /^\/api\/items\/[^/]+\/lists$/.test(c.path) || c.method === "DELETE" || /^\/api\/items\/[^/]+\/positions$/.test(c.path),
);
const nameOf = (id) => (items.find((i) => i.id === id) || {}).title || id;
console.log("\n# calls the sync would make (nothing was actually sent):");
for (const c of interesting) {
  const id = c.path.split("/")[3];
  const what = c.method === "DELETE" ? "DELETE the item" : c.body && c.body.lists ? `set lists -> ${JSON.stringify(c.body.lists)}` : "set positions";
  console.log(`   ${c.method} ${nameOf(id)} (${id.slice(0, 8)}): ${what}`);
}
const counts = interesting.reduce((acc, c) => ((acc[c.method] = (acc[c.method] || 0) + 1), acc), {});
console.log("   totals:", JSON.stringify(counts));
console.log("# toast:", JSON.stringify(toasts));

const deletes = calls.filter((c) => c.method === "DELETE");
if (deletes.length) {
  console.log("\n# items the sync would delete, and where they live:");
  for (const c of deletes) {
    const id = c.path.split("/")[3];
    const it = items.find((i) => i.id === id) || {};
    console.log(`   - ${it.title} (${it.kind} ${it.year}) lists=${JSON.stringify(it.lists)} reprog=${JSON.stringify(Object.keys(it.episode_progress || {}))} watched=${it.watched_at}`);
  }
  console.log(`   (of ${Object.keys(dump).length} tabs dumped; a list with no such tab can never be "processed")`);
  const noTab = items.filter((i) => (i.lists || []).length && i.lists.every((l) => !(l in dump)));
  console.log(`   items whose every list has no sheet tab: ${noTab.length} (those are never deleted)`);
}

const cw = map.get("Currently Watching")?.grid || [];
const carrieAfter = cw.filter((r) => /^carrie$/i.test(String(r[0] || "")));
console.log(`\n# "Carrie" rows on Currently Watching: ${carrieBefore.length} -> ${carrieAfter.length}`);
for (const r of carrieAfter) console.log("  ", JSON.stringify([r[0], r[1], r[4], r[7]]), "= title, year, J, date");
console.log(calls.filter((c) => c.method === "DELETE").length === 0 ? "# nothing would be deleted" : "# SOMETHING WOULD BE DELETED — review above");
