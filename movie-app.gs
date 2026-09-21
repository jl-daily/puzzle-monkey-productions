// James' Watchlist — Google Sheets <-> movie-app two-way sync
//
// Setup:
//   1. Install: Extensions -> Apps Script, paste this file, save.
//   2. Refresh the sheet -> a "Sync" menu appears.
//   3. Sync -> Set app URL -> paste your cloudflared URL, e.g.
//      https://xxx.trycloudflare.com
//   4. Sync -> Set tabs to sync -> enter the tab names to sync.
//   5. Sync -> Sync now.
//   6. (Optional) Sync -> Install auto-sync to sync every 5 minutes.
//
// Sheet layout (each synced tab):
//   A Movie Title | B Year | C Taste Score | D Genre
//   E J | F D | G with Di? | H Notes/Date Watched
// Columns A-D are synced from the app (TMDB/taste.io metadata).
// Column C (Taste Score) is written by the app only — it is never read back,
// taste scores come from taste.io, not the sheet.
// Columns E-H are yours — the sync only writes into them what the app's scores
// (E/F) and edits push: a review edited in the app lands in a "Thoughts" column
// and a reference in a "Reference" column, both auto-created (at the end of the
// header) on the title's primary tab when it lacks them.
// A column headed "Reference" (in G or H) is read and pushed into the app.
// A column headed "Date Watched" (or "Watched"/"Date"/"Date/Watched"/"Finished"/"End Date") is
// read into watched_at, and a column headed "Started" (or "Start Date") into
// ep_started_at — but only for movies. Shows track their dates in the app:
// toggling episodes stamps started/finished and pushes them into the
// Started/Finished columns of the "Shows Watched" tab, and the sync writes the
// app's dates back into those columns so a missed push self-corrects on the
// next sync.
// Columns E and F (your/Di's scores) flow both ways: the app writes its scores
// into E/F (self-healing, so a missed push corrects itself on the next sync),
// and the sheet's non-empty E/F values are read back into the app. Column E is
// ignored for shows (tv items) — James keeps "remaining episodes" there, so it
// is never read or written for shows.
// A movie's watched date in the app is written into any "Watched"/"Date
// Watched"/"Finished" column the tab has, so the day you watched it lands in
// the spreadsheet.
//
// Each tab is a separate list. A title can live on several tabs. Deleting a
// row removes that title from that tab in the app (and fully deletes it there
// if it isn't on any other tab).
//
// The Rewatch tab is special: column G ("with Di?") decides which list a
// title lands on — "Rewatch w/ Di" or "Rewatch w/o Di". A row with "yes" or
// "✓" in G goes to "Rewatch w/ Di"; any other non-empty value goes to
// "Rewatch w/o Di"; an empty G defaults to "Rewatch w/ Di" but is flagged
// (the site shows a "?" badge) until you fill it in.

var HEADERS = ["Movie Title", "Year", "Taste Score", "Genre", "J", "D", "with Di?", "Notes"];
var DEFAULT_TABS = "Rewatch,Movies,No Di,Shows,Shows w/o Di,2026,Shows Watched,Archive";
var W = HEADERS.length;
var DI_VALUES = ["yes", "✓"];
var GATEWAY_TOKEN = "5432de9c117db9bcfb54ad1c0b15e35323eee3416fdb3b37";

var SHOW_TABS = ["Shows", "Shows w/o Di", "Shows Watched"];

// Per-tab column positions (1-based) for the review/Thoughts and Reference
// columns. The "want to watch" tabs (Rewatch, Movies, No Di, Shows, Shows w/o
// Di) have a Reference column but no review column — only 2026 (and Shows
// Watched, detected by name) hold reviews. When a tab is listed here, writes
// go to that exact column instead of auto-creating a new one by name.
var THOUGHTS_COL_BY_TAB = { "2026": 7 };
var REF_COL_BY_TAB = {
  Rewatch: 8,
  Movies: 8,
  "No Di": 8,
  Shows: 7,
  "Shows w/o Di": 7,
  "2026": 9,
};
// Tabs whose date column should hold a real Date (so the full date is stored)
// displayed with a short number format. Col is 1-based. When a tab is listed
// here, writes to that column use a Date object instead of an ISO string.
var DATE_COL_BY_TAB = { "2026": { col: 8, fmt: "MMM-DD" }, "Shows 2026": { col: 8, fmt: "MMM-DD" } };

var GENRE_MAP = {
  Action: "Action",
  Adventure: "Adventure",
  "Action & Adventure": "Action",
  Animation: "Animation",
  Kids: "Anime",
  Comedy: "Comedy",
  Crime: "Crime",
  Documentary: "Documentary",
  News: "Docuseries",
  Drama: "Drama",
  Family: "Drama",
  Soap: "Drama",
  "TV Movie": "Drama",
  Fantasy: "Fantasy",
  History: "History",
  Horror: "Horror",
  Music: "Music",
  Mystery: "Mystery",
  Romance: "Romance",
  "Science Fiction": "Sci-Fi",
  "Sci-Fi & Fantasy": "Sci-Fi",
  Thriller: "Thriller",
  War: "War",
  "War & Politics": "War",
  Western: "Action",
  Reality: "Reality",
  Talk: "Reality",
};

var GENRE_VALUES = [
  "Action",
  "Adventure",
  "Anime",
  "Animation",
  "Classic",
  "Comedy",
  "Crime",
  "Documentary",
  "Docuseries",
  "Drama",
  "Fantasy",
  "Gameshow",
  "History",
  "Horror",
  "Music",
  "Mystery",
  "Reality",
  "Romance",
  "Satire",
  "Sci-Fi",
  "Thriller",
  "War",
];

function fixValidation_(sh) {
  if (sh.getLastRow() < 2) return;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(GENRE_VALUES, true)
    .setAllowInvalid(true)
    .build();
  var end = Math.max(sh.getLastRow() + 20, 100);
  sh.getRange("D2:D" + end).setDataValidation(rule);
}

function props() {
  return PropertiesService.getScriptProperties();
}

function appUrl_() {
  return props().getProperty("APP_URL") || "";
}

function tabs_() {
  var raw = props().getProperty("TABS") || DEFAULT_TABS;
  var out = [];
  for (var i = 0; i < raw.split(",").length; i++) {
    var t = String(raw.split(",")[i]).trim();
    if (t) out.push(t);
  }
  return out;
}

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu("Sync")
    .addItem("Set app URL", "setAppUrl")
    .addItem("Set tabs to sync", "setTabs")
    .addItem("Sync now", "doSync")
    .addItem("Archive rows...", "archiveRows")
    .addItem("Archive by year...", "archiveByYear")
    .addItem("Clean up lists...", "cleanupLists")
    .addSeparator()
    .addItem("Install auto-sync (5 min)", "installSync")
    .addItem("Remove auto-sync", "removeSync")
    .addToUi();
}

function setAppUrl() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    "Movie app URL",
    "Paste the cloudflared URL from your tunnel, e.g. https://xxx.trycloudflare.com",
    ui.ButtonSet.OK_CANCEL,
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var url = String(res.getResponseText() || "").trim().replace(/\/+$/, "");
  if (!url) return;
  props().setProperty("APP_URL", url);
  saveSheetId_(SpreadsheetApp.getActiveSpreadsheet());
  ui.alert("App URL saved.");
}

function setTabs() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    "Tabs to sync",
    "Comma-separated tab names, e.g.\n" + DEFAULT_TABS,
    ui.ButtonSet.OK_CANCEL,
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var val = String(res.getResponseText() || "").trim();
  if (!val) return;
  props().setProperty("TABS", val);
  ui.alert("Tabs saved.");
}

function installSync() {
  removeSync();
  ScriptApp.newTrigger("doSync").timeBased().everyMinutes(5).create();
  saveSheetId_(SpreadsheetApp.getActiveSpreadsheet());
  SpreadsheetApp.getActiveSpreadsheet().toast("Auto-sync installed (every 5 min).", "Sync");
}

function removeSync() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "doSync") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function saveSheetId_(ss) {
  props().setProperty("SPREADSHEET_ID", ss.getId());
}

function fetchJson_(url, opts) {
  var res = UrlFetchApp.fetch(url, {
    method: opts && opts.method ? opts.method : "GET",
    contentType: "application/json",
    headers: { "X-Internal": "1" },
    payload: opts && opts.body ? opts.body : null,
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code >= 400) {
    var msg = "";
    try {
      msg = JSON.parse(text).error || "";
    } catch (e) {}
    throw new Error(code + " " + msg);
  }
  return text ? JSON.parse(text) : null;
}

function normTitle(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// True when the tab's header at 0-based idx is the named column. Scores are
// only written into a column that actually holds scores — the "Shows" and
// "Shows w/o Di" tabs use column F for "Di interest?" (Yes/No), not D.
function colIs_(hdr, idx, name) {
  return !!hdr && idx < hdr.length && normTitle(hdr[idx]) === name;
}

// Index of the column headed `name` (0-based) in the header row at `h`.
// When `create` is true and no such column exists, appends a new header column
// with that name and returns its index. Returns -1 when absent and not created.
function colIdx_(sh, h, name, create) {
  var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
  for (var ci = 0; ci < hdr.length; ci++) {
    if (normTitle(hdr[ci]) === name) return ci;
  }
  if (!create) return -1;
  var col = sh.getLastColumn() + 1;
  sh.getRange(h, col).setValue(name);
  return col - 1;
}

function dateVal_(v) {
  var s = String(v || "").trim();
  if (s === "") return "";
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return m[1] + "-" + ("0" + +m[2]).slice(-2) + "-" + ("0" + +m[3]).slice(-2);
  }
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return s;
}

function dateFromISO_(s) {
  var m = String(s || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function rowsEqual_(a, b) {
  for (var i = 0; i < a.length; i++) {
    var av = a[i];
    var bv = b[i];
    if (av instanceof Date || bv instanceof Date) {
      // A real Date must stay a Date: normalize both sides only when they are
      // both Dates, so the sync overwrites any leftover string date with a Date.
      if (!(av instanceof Date) || !(bv instanceof Date)) return false;
      if (dateVal_(av) !== dateVal_(bv)) return false;
    } else if (String(av || "") !== String(bv || "")) return false;
  }
  return true;
}

// Matches titles ignoring case, spaces and punctuation ("Spider-Man: No Way Home"
// == "Spider Man No Way Home"). Never merges distinct titles ("House" !=
// "The Housemaid"), so new sheet rows can't be swallowed into an existing item.
function normKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findApp_(title, appByKey) {
  var t = normKey(title);
  if (!t) return null;
  return appByKey[t] || null;
}

function mapGenres_(genres) {
  if (!genres) return null;
  var parts = String(genres).split(",");
  for (var i = 0; i < parts.length; i++) {
    var mapped = GENRE_MAP[parts[i].trim()];
    if (mapped) return mapped;
  }
  return null;
}

function effectiveList_(tab, row) {
  if (tab !== "Rewatch") return tab;
  var g = String(row[6] || "").trim().toLowerCase();
  for (var i = 0; i < DI_VALUES.length; i++) {
    if (g === DI_VALUES[i].toLowerCase()) return "Rewatch w/ Di";
  }
  return g === "" ? "Rewatch w/ Di" : "Rewatch w/o Di";
}

// The app treats "Rewatch w/ Di" and "Rewatch w/o Di" as separate lists, but
// both live on the single "Rewatch" sheet tab — column G picks the derived
// list. Ops that name a tab resolve through here so they hit the real sheet.
function baseTab_(tab) {
  return tab === "Rewatch w/ Di" || tab === "Rewatch w/o Di" ? "Rewatch" : tab;
}

// Column G value that marks a Rewatch row as belonging to a derived list.
function diValue_(tab) {
  if (tab === "Rewatch w/ Di") return "yes";
  if (tab === "Rewatch w/o Di") return "no";
  return null;
}

// Compute a show's Current Episode (CUR) and Total Episodes (Epis) from the
// app item, mirroring the app's src/sheet.ts episodeSummary. Cur is the last
// watched episode of the current season; total is that season's count. When the
// show is finished (no current season) we fall back to the highest-touched
// season so the figures still reflect where the show ended. Used to self-heal
// CUR/Epis into the sheet during doSync.
function episodeSummary_(it) {
  var prog = (it && it.episode_progress) || {};
  var counts = (it && it.season_counts) || {};
  var ckeys = Object.keys(counts);
  var seasonNums = [];
  for (var i = 0; i < ckeys.length; i++) {
    var n = Number(ckeys[i]);
    if (isFinite(n) && n > 0) seasonNums.push(n);
  }
  seasonNums.sort(function (a, b) { return a - b; });
  var s = it ? it.current_season : null;
  if (s == null) {
    s = undefined;
    for (var i = 0; i < seasonNums.length; i++) {
      var n = seasonNums[i];
      var arr = prog[n] || [];
      var c = counts[n];
      if (arr.length && (c == null || arr.length < c)) { s = n; break; }
    }
    if (s == null) s = seasonNums[seasonNums.length - 1];
    if (s == null) {
      var pkeys = Object.keys(prog);
      var pnums = [];
      for (var i = 0; i < pkeys.length; i++) {
        var n = Number(pkeys[i]);
        if (isFinite(n) && n > 0) pnums.push(n);
      }
      pnums.sort(function (a, b) { return b - a; });
      s = pnums[0];
    }
  }
  if (s == null) return { cur: null, total: null };
  var arr = (prog[s] || []).slice().sort(function (a, b) { return a - b; });
  var last = arr.length ? arr[arr.length - 1] : 0;
  var total = counts[s] != null ? counts[s] : null;
  var complete = total != null && last >= total;
  var cur = complete ? last : last + 1;
  return { cur: cur, total: total };
}

function rowFromApp_(it, row, hdr, startIdx, watchIdx, tab) {
  var out = row.slice();
  out[0] = it.title;
  if (it.year) out[1] = String(it.year);
  if (it.taste_score != null) out[2] = String(it.taste_score);
  var g = mapGenres_(it.genres);
  if (g) out[3] = g;
  // Self-heal the app's scores into the sheet (J=col5, D=col6) so a missed
  // live push corrects itself on the next sync. Col5 is "remaining episodes"
  // for shows, so it's never written there.
  if (it.kind !== "tv" && it.my_rating != null && colIs_(hdr, 4, "j")) out[4] = String(it.my_rating);
  if (it.di_rating != null && colIs_(hdr, 5, "d")) out[5] = String(it.di_rating);
  // Self-heal the app's Started/Finished dates into the sheet (missed pushes
  // fix themselves on the next sync). Only non-empty dates are written so an
  // empty app field never wipes a historical date out of the sheet. Tabs in
  // DATE_COL_BY_TAB get a real Date (with the full value kept); others keep
  // the ISO string.
  var spec = tab && DATE_COL_BY_TAB[tab];
  if (startIdx > -1 && startIdx < out.length && it.ep_started_at) {
    var sd = spec && startIdx === spec.col - 1 ? dateFromISO_(it.ep_started_at) : null;
    out[startIdx] = sd ? sd : String(it.ep_started_at);
  }
  if (watchIdx > -1 && watchIdx < out.length && (it.watched_at || it.ep_finished_at)) {
    var wd = spec && watchIdx === spec.col - 1 ? dateFromISO_(it.watched_at || it.ep_finished_at) : null;
    out[watchIdx] = wd ? wd : String(it.watched_at || it.ep_finished_at);
  }
  // Self-heal a show's Current Episode (CUR) / Total Episodes (Epis) into the
  // sheet so a missed live push corrects itself on the next sync. Columns
  // headed "CUR"/"Epis" (or "Current Episode"/"Total Episodes") are written
  // only where they exist.
  if (it.kind === "tv") {
    var curIdx = -1, episIdx = -1;
    for (var ci = 0; ci < hdr.length; ci++) {
      var hn = normTitle(hdr[ci]);
      if (curIdx === -1 && (hn === "cur" || hn === "current episode")) curIdx = ci;
      if (episIdx === -1 && (hn === "epis" || hn === "total episodes" || hn === "episodes")) episIdx = ci;
    }
    var es = episodeSummary_(it);
    if (curIdx > -1 && curIdx < out.length) out[curIdx] = es.cur != null ? String(es.cur) : "";
    if (episIdx > -1 && episIdx < out.length) out[episIdx] = es.total != null ? String(es.total) : "";
  }
  return out;
}

function stateSheet_(ss, tab) {
  var name = "_sync_" + tab.replace(/[\\\/\[\]\*\?]/g, " ").trim();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.hideSheet();
  }
  return sh;
}

function syncTab_(ss, tab, appUrl, appByTitle, appByKey, appById, counts, membership, processed, positions) {
  var sh = ss.getSheetByName(tab);
  if (!sh || sh.getLastRow() < 1) {
    counts.notabs.push(tab);
    return;
  }
  fixValidation_(sh);
  var grid = sh.getRange(1, 1, sh.getLastRow(), W).getValues();

  var headerIdx = -1;
  var lim = Math.min(grid.length, 10);
  for (var hi = 0; hi < lim; hi++) {
    var h = normTitle(grid[hi][0]);
    if (h === "movie title" || h === "show title" || h === "series title") {
      headerIdx = hi;
      break;
    }
  }
  if (headerIdx === -1) {
    counts.skippedTabs.push(tab);
    return;
  }
  processed[tab] = true;

  var headerRow = sh.getRange(headerIdx + 1, 1, 1, sh.getLastColumn()).getValues()[0];
  var refIdx = -1;
  var watchIdx = -1;
  var startIdx = -1;
  var fixedRef = REF_COL_BY_TAB[tab];
  if (fixedRef != null && fixedRef - 1 < headerRow.length) refIdx = fixedRef - 1;
  for (var ci = 0; ci < headerRow.length; ci++) {
    var hname = normTitle(headerRow[ci]);
    if (refIdx === -1 && hname === "reference") refIdx = ci;
    if (watchIdx === -1 && (hname === "watched" || hname === "date watched" || hname === "watched date" || hname === "date/watched" || hname === "date" || hname === "finished" || hname === "date finished" || hname === "finished date" || hname === "end date" || hname === "date completed" || hname === "completed")) watchIdx = ci;
    if (startIdx === -1 && (hname === "started" || hname === "start date" || hname === "started date")) startIdx = ci;
  }
  var width = Math.max(W, refIdx + 1, watchIdx + 1, startIdx + 1);
  if (width > W) grid = sh.getRange(1, 1, sh.getLastRow(), width).getValues();

  var stateSh = stateSheet_(ss, tab);
  var newGrid = [];
  for (var i = 0; i < grid.length; i++) newGrid.push(grid[i].slice());

  for (var i = headerIdx + 1; i < grid.length; i++) {
    var row = grid[i];
    var title = String(row[0] || "").trim();
    if (!title) continue;
    var effList = effectiveList_(tab, row);
    var flagged = tab === "Rewatch" && String(row[6] || "").trim() === "";

    var appItem = findApp_(title, appByKey);

    if (!appItem) {
      try {
        var created = fetchJson_(appUrl + "/api/items/by-title", {
          method: "POST",
          body: JSON.stringify({
            title: title,
            list: effList,
            position: i,
            kind: SHOW_TABS.indexOf(tab) !== -1 ? "tv" : undefined,
          }),
        });
        if (created && created.id) {
          appItem = created;
          appByTitle[normTitle(created.title)] = created;
          appByKey[normKey(created.title)] = created;
          appById[String(created.id)] = created;
          counts.added += created.existed ? 0 : 1;
        }
      } catch (e) {
        counts.missing++;
      }
    }
    if (!appItem) continue;

    if (!positions[appItem.id]) positions[appItem.id] = {};
    positions[appItem.id][effList] = i;

    var curFlag = !!(appItem.flags && appItem.flags[effList]);
    if (flagged !== curFlag) {
      try {
        appItem = fetchJson_(appUrl + "/api/items/" + appItem.id + "/flag", {
          method: "PUT",
          body: JSON.stringify({ list: effList, flagged: flagged }),
        });
        if (appItem) {
          appByTitle[normTitle(appItem.title)] = appItem;
          appById[String(appItem.id)] = appItem;
        }
        counts.pushed++;
      } catch (e) {}
    }

    var jv = colIs_(headerRow, 4, "j") ? String(row[4] || "").trim() : "";
    var myRating = jv === "" ? null : isNaN(parseInt(jv, 10)) ? null : parseInt(jv, 10);
    // Shows (tv items) don't use column E — James keeps "remaining episodes" there.
    // An empty sheet cell means "unknown": never push it into the app, or a blank
    // cell would silently wipe a score that was entered in the app.
    if (appItem.kind !== "tv" && jv !== "" && myRating !== appItem.my_rating) {
      try {
        appItem = fetchJson_(appUrl + "/api/items/" + appItem.id, {
          method: "PATCH",
          body: JSON.stringify({ my_rating: myRating }),
        });
        if (appItem) {
          appByTitle[normTitle(appItem.title)] = appItem;
          appById[String(appItem.id)] = appItem;
        }
        counts.pushed++;
      } catch (e) {}
    }

    var dv = colIs_(headerRow, 5, "d") ? String(row[5] || "").trim() : "";
    var diRating = dv === "" ? null : isNaN(parseInt(dv, 10)) ? null : parseInt(dv, 10);
    if (dv !== "" && diRating !== appItem.di_rating) {
      try {
        appItem = fetchJson_(appUrl + "/api/items/" + appItem.id, {
          method: "PATCH",
          body: JSON.stringify({ di_rating: diRating }),
        });
        if (appItem) {
          appByTitle[normTitle(appItem.title)] = appItem;
          appById[String(appItem.id)] = appItem;
        }
        counts.pushed++;
      } catch (e) {}
    }

    var ref = refIdx >= 0 ? String(row[refIdx] || "").trim() : "";
    if (ref !== "" && ref !== appItem.reference) {
      try {
        appItem = fetchJson_(appUrl + "/api/items/" + appItem.id, {
          method: "PATCH",
          body: JSON.stringify({ reference: ref }),
        });
        if (appItem) {
          appByTitle[normTitle(appItem.title)] = appItem;
          appById[String(appItem.id)] = appItem;
        }
        counts.pushed++;
      } catch (e) {}
    }

    // Shows track their dates in the app (episode toggles stamp started/finished
    // and push them to the Started/Finished columns), so only movies read dates
    // back from the sheet — otherwise a show's app-side date would be clobbered
    // by a stale or empty sheet cell.
    if (appItem.kind !== "tv") {
      var wv = watchIdx >= 0 ? dateVal_(row[watchIdx]) : "";
      var wval = wv === "" ? null : wv;
      if (wv !== "" && wval !== appItem.watched_at) {
        try {
          appItem = fetchJson_(appUrl + "/api/items/" + appItem.id, {
            method: "PATCH",
            body: JSON.stringify({ watched_at: wval }),
          });
          if (appItem) {
            appByTitle[normTitle(appItem.title)] = appItem;
            appById[String(appItem.id)] = appItem;
          }
          counts.pushed++;
        } catch (e) {}
      }

      var sv = startIdx >= 0 ? dateVal_(row[startIdx]) : "";
      var sval = sv === "" ? null : sv;
      if (sv !== "" && sval !== appItem.ep_started_at) {
        try {
          appItem = fetchJson_(appUrl + "/api/items/" + appItem.id, {
            method: "PATCH",
            body: JSON.stringify({ ep_started_at: sval }),
          });
          if (appItem) {
            appByTitle[normTitle(appItem.title)] = appItem;
            appById[String(appItem.id)] = appItem;
          }
          counts.pushed++;
        } catch (e) {}
      }
    }

    var desired = rowFromApp_(appItem, row, headerRow, startIdx, watchIdx, tab);
    if (!rowsEqual_(row, desired)) {
      newGrid[i] = desired;
      counts.pulled++;
    }

    if (!membership[appItem.id]) membership[appItem.id] = {};
    membership[appItem.id][effList] = true;
  }

  sh.getRange(1, 1, newGrid.length, width).setValues(newGrid);
  stateSh.getRange(1, 1, newGrid.length, width).setValues(newGrid);
}

function doSync() {
  var id = props().getProperty("SPREADSHEET_ID");
  var ss = id
    ? SpreadsheetApp.openById(id)
    : SpreadsheetApp.getActiveSpreadsheet();
  var appUrl = appUrl_();
  if (!appUrl) {
    ss.toast("Set your app URL first (Sync menu).", "Sync", 5);
    return;
  }

  var appItems = [];
  try {
    appItems = fetchJson_(appUrl + "/api/items") || [];
  } catch (e) {
    ss.toast("Can't reach app: " + e.message, "Sync", 8);
    return;
  }

  var appByTitle = {};
  var appById = {};
  var appByKey = {};
  for (var i = 0; i < appItems.length; i++) {
    var it = appItems[i];
    appByTitle[normTitle(it.title)] = it;
    appById[String(it.id)] = it;
    var k = normKey(it.title);
    if (k && !appByKey[k]) appByKey[k] = it;
  }

  var membership = {};
  var processed = {};
  var positions = {};
  var counts = { added: 0, pushed: 0, pulled: 0, deleted: 0, moved: 0, missing: 0, skippedTabs: [], notabs: [] };

  var tabs = tabs_();
  for (var i = 0; i < tabs.length; i++) {
    syncTab_(ss, tabs[i], appUrl, appByTitle, appByKey, appById, counts, membership, processed, positions);
  }

  for (var key in appById) {
    var it = appById[key];
    var intended = membership[key] ? Object.keys(membership[key]) : [];
    var current = it.lists || [];
    var same =
      current.length === intended.length &&
      current.every(function (l) {
        return intended.indexOf(l) !== -1;
      });
    if (same) continue;
    var confident = current.every(function (l) {
      return (
        processed[l] ||
        (processed["Rewatch"] &&
          (l === "Rewatch w/ Di" || l === "Rewatch w/o Di"))
      );
    });
    if (!confident) continue;
    if (intended.length === 0 && current.length > 0) {
      try {
        fetchJson_(appUrl + "/api/items/" + it.id, { method: "DELETE" });
        counts.deleted++;
      } catch (e) {}
    } else {
      try {
        fetchJson_(appUrl + "/api/items/" + it.id + "/lists", {
          method: "PUT",
          body: JSON.stringify({ lists: intended }),
        });
        counts.moved++;
      } catch (e) {}
    }
  }

  for (var key in positions) {
    var it = appById[key];
    if (!it) continue;
    var desired = positions[key];
    var cur = it.positions || {};
    var changed = false;
    for (var p in desired) {
      if (cur[p] !== desired[p]) {
        changed = true;
        break;
      }
    }
    if (!changed) continue;
    try {
      fetchJson_(appUrl + "/api/items/" + it.id + "/positions", {
        method: "PUT",
        body: JSON.stringify({ positions: desired }),
      });
      counts.moved++;
    } catch (e) {}
  }

  try {
    fetchJson_(appUrl + "/api/season-refresh", { method: "POST" });
  } catch (e) {}

  var msg =
    "Pushed " + counts.pushed +
    " · pulled " + counts.pulled +
    " · added " + counts.added +
    " · moved " + counts.moved +
    " · deleted " + counts.deleted +
    (counts.missing ? " · not found: " + counts.missing : "") +
    (counts.skippedTabs.length ? " · skipped tabs: " + counts.skippedTabs.join(", ") : "") +
    (counts.notabs.length ? " · not in sheet: " + counts.notabs.join(", ") : "");
  ss.toast(msg, "Sync");
  Logger.log(msg);
}

// ---- Web app gateway: lets the movie site edit the spreadsheet directly ----
// Deploy this script as a Web App (Deploy -> New deployment -> Web app,
// Execute as: Me, Who has access: Anyone). Copy the web app URL into the
// site's .env as SHEET_URL. The site sends signed JSON commands here.

function sheet_() {
  var id = props().getProperty("SPREADSHEET_ID");
  if (!id) throw new Error("SPREADSHEET_ID not set");
  return SpreadsheetApp.openById(id);
}

function headerRow_(sh) {
  var lim = Math.min(sh.getLastRow(), 10);
  for (var i = 1; i <= lim; i++) {
    var h = normTitle(sh.getRange(i, 1).getValue());
    if (h === "movie title" || h === "show title" || h === "series title") return i;
  }
  return -1;
}

function findRow_(sh, title) {
  var h = headerRow_(sh);
  if (h < 1) return -1;
  var last = sh.getLastRow();
  if (last <= h) return -1;
  var values = sh.getRange(h + 1, 1, last - h, 1).getValues();
  var want = normTitle(title);
  for (var i = 0; i < values.length; i++) {
    if (normTitle(values[i][0]) === want) return h + 1 + i;
  }
  return -1;
}

// Like findRow_ but returns every matching data row (for titles that repeat on
// a tab, e.g. multiple rewatch rows).
function findRows_(sh, title) {
  var h = headerRow_(sh);
  if (h < 1) return [];
  var last = sh.getLastRow();
  if (last <= h) return [];
  var values = sh.getRange(h + 1, 1, last - h, 1).getValues();
  var want = normTitle(title);
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (normTitle(values[i][0]) === want) rows.push(h + 1 + i);
  }
  return rows;
}

function ensureStatusHeader_(sh, h) {
  var cur = normTitle(sh.getRange(h, 9).getValue());
  if (cur !== "status" && cur !== "") {
    throw new Error("column I on " + sh.getName() + " is not 'Status'");
  }
  if (cur === "") sh.getRange(h, 9).setValue("Status");
}

function gatewayAdd_(b) {
  var ss = sheet_();
  var tab = baseTab_(b.tab);
  var sh = ss.getSheetByName(tab);
  if (!sh) sh = createTabWithHeaders_(tab);
  var h = headerRow_(sh);
  if (h < 1) throw new Error("no header row in " + b.tab);
  var status = b.status || "To Watch";
  var genre = mapGenres_(b.genres) || "";
  var date = b.date != null ? String(b.date) : "";
  var taste = b.taste_score != null ? String(b.taste_score) : null;
  var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
  var statusIdx = -1;
  var dateIdx = -1;
  var refIdx = -1;
  var fixedRef = REF_COL_BY_TAB[tab];
  if (fixedRef != null && fixedRef - 1 < hdr.length) refIdx = fixedRef - 1;
  for (var ci = 0; ci < hdr.length; ci++) {
    var hn = normTitle(hdr[ci]);
    if (statusIdx === -1 && hn === "status") statusIdx = ci;
    if (dateIdx === -1 && (hn === "watched" || hn === "date watched" || hn === "watched date" || hn === "date/watched" || hn === "date" || hn === "finished" || hn === "date finished" || hn === "date completed" || hn === "completed")) dateIdx = ci;
    if (refIdx < 0 && hn === "reference") refIdx = ci;
  }
  var refVal = b.reference != null && String(b.reference) !== "" ? String(b.reference) : "";
  var row = b.force ? -1 : findRow_(sh, b.title);
  if (row > 0) {
    var cur = sh.getRange(row, 1, 1, 4).getValues()[0];
    var tasteVal = taste != null ? taste : (cur[2] != null ? String(cur[2]) : "");
    sh.getRange(row, 1, 1, 4).setValues([
      [String(b.title || ""), String(b.year || ""), tasteVal, genre],
    ]);
    if (date !== "" && dateIdx > -1) {
      var spec = DATE_COL_BY_TAB[b.tab];
      if (spec && dateIdx === spec.col - 1 && dateFromISO_(date)) {
        sh.getRange(row, dateIdx + 1).setValue(dateFromISO_(date));
        sh.getRange(row, dateIdx + 1).setNumberFormat(spec.fmt);
      } else {
        sh.getRange(row, dateIdx + 1).setValue(date);
      }
    }
    if (statusIdx > -1) sh.getRange(row, statusIdx + 1).setValue(status);
    if (b.j != null && String(b.j) !== "" && colIs_(hdr, 4, "j")) sh.getRange(row, 5).setValue(String(b.j));
    if (b.d != null && String(b.d) !== "" && colIs_(hdr, 5, "d")) sh.getRange(row, 6).setValue(String(b.d));
    var dv = diValue_(b.tab);
    if (dv != null) sh.getRange(row, 7).setValue(dv);
    if (refIdx > -1 && refVal !== "") sh.getRange(row, refIdx + 1).setValue(refVal);
    return;
  }
  var insertAt = h + 1;
  while (insertAt <= sh.getLastRow()) {
    if (String(sh.getRange(insertAt, 1).getValue()).trim() === "") break;
    insertAt++;
  }
  var dv = diValue_(b.tab);
  var cells = [String(b.title || ""), String(b.year || ""), taste != null ? taste : "", genre, "", "", dv != null ? dv : "", "", ""];
  if (dateIdx > -1) {
    var spec = DATE_COL_BY_TAB[b.tab];
    if (spec && dateIdx === spec.col - 1 && dateFromISO_(date)) cells[dateIdx] = dateFromISO_(date);
    else cells[dateIdx] = date;
  }
  if (statusIdx > -1) cells[statusIdx] = status;
  if (b.j != null && String(b.j) !== "" && colIs_(hdr, 4, "j")) cells[4] = String(b.j);
  if (b.d != null && String(b.d) !== "" && colIs_(hdr, 5, "d")) cells[5] = String(b.d);
  sh.getRange(insertAt, 1, 1, cells.length).setValues([cells]);
  if (refIdx > -1 && refVal !== "") sh.getRange(insertAt, refIdx + 1).setValue(refVal);
}

// Create a year/archive-style tab (mirrors the "2026" tab layout) when an "add"
// targets a tab that doesn't yet exist in the sheet, so finished-2026 shows can
// land on "Shows 2026" without a manual tab creation step.
function createTabWithHeaders_(name) {
  var ss = sheet_();
  var sh = ss.insertSheet(name);
  var headers = ["Movie Title", "Year", "Taste", "Genre", "J", "D", "Di", "Date", "Status"];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  var spec = DATE_COL_BY_TAB[name];
  if (spec) sh.getRange(1, spec.col).setNumberFormat(spec.fmt);
  return sh;
}

function gatewayRemove_(b) {
  var ss = sheet_();
  var tab = baseTab_(b.tab);
  var sh = ss.getSheetByName(tab);
  if (!sh) return { removed: 0 };
  var h = headerRow_(sh);
  if (h < 1) return { removed: 0 };
  var last = sh.getLastRow();
  if (last <= h) return { removed: 0 };
  // Scan every matching row so a duplicate title with a different year (or a
  // different with-Di column) doesn't get deleted by accident.
  var grid = sh.getRange(h + 1, 1, last - h, 7).getValues();
  var want = normTitle(b.title);
  var year = b.year != null ? String(b.year).trim() : "";
  for (var i = grid.length - 1; i >= 0; i--) {
    if (normTitle(grid[i][0]) !== want) continue;
    var sheetYear = String(grid[i][1] || "").trim();
    if (year && sheetYear && sheetYear !== year) continue;
    if (tab === "Rewatch" && (b.tab === "Rewatch w/ Di" || b.tab === "Rewatch w/o Di")) {
      if (effectiveList_("Rewatch", grid[i]) !== b.tab) continue;
    }
    sh.deleteRow(h + 1 + i);
    return { removed: 1 };
  }
  return { removed: 0 };
}

// Delete a sheet entirely (body.tab). Fails if the sheet does not exist.
function gatewayDeleteTab_(b) {
  var ss = sheet_();
  var sh = ss.getSheetByName(String(b.tab || ""));
  if (!sh) throw new Error("no tab " + b.tab);
  ss.deleteSheet(sh);
  return { deleted: String(b.tab) };
}

// Bulk remove: deletes every row in b.tab whose title matches a title in
// b.titles. Returns how many rows were deleted.
function gatewayRemoveRows_(b) {
  var ss = sheet_();
  var tab = baseTab_(b.tab);
  var sh = ss.getSheetByName(tab);
  if (!sh) return { removed: 0 };
  var titles = b.titles || [];
  var removed = 0;
  for (var i = 0; i < titles.length; i++) {
    var rows = findRows_(sh, titles[i]);
    for (var k = rows.length - 1; k >= 0; k--) {
      if (tab === "Rewatch" && (b.tab === "Rewatch w/ Di" || b.tab === "Rewatch w/o Di")) {
        var rv = sh.getRange(rows[k], 1, 1, 7).getValues()[0];
        if (effectiveList_("Rewatch", rv) !== b.tab) continue;
      }
      sh.deleteRow(rows[k]);
      removed++;
    }
  }
  return { removed: removed };
}

// Dump every sheet's data rows as {title, year, j} (hidden _sync_ sheets are
// skipped). Returns {tabs: {sheetName: [rows]}}. A single tab can be dumped
// via b.tab. When a tab has a review/thoughts column and/or a watched/finished
// column (detected by header name, or forced with b.reviewCol/b.watchCol,
// 1-based), each row also carries {review} and {watched_at} (normalized to
// YYYY-MM-DD).
function gatewayDump_(b) {
  var ss = sheet_();
  var sheets = b.tab ? [ss.getSheetByName(baseTab_(String(b.tab)))] : ss.getSheets();
  var out = {};
  var REVIEW = ["review", "my review", "what did i think", "thoughts", "watched thoughts", "review/thoughts", "thoughts/review"];
  var WATCH = ["watched", "date watched", "watched date", "date/watched", "date", "finished", "date finished", "finished date", "end date", "date completed", "completed"];
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (!sh) continue;
    var name = sh.getName();
    if (name.indexOf("_sync_") === 0) continue;
    var h = headerRow_(sh);
    var last = sh.getLastRow();
    var rows = [];
    if (h >= 1 && last > h) {
      var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
      var reviewIdx = b.reviewCol ? Number(b.reviewCol) - 1 : -1;
      var watchIdx = b.watchCol ? Number(b.watchCol) - 1 : -1;
      for (var ci = 0; ci < hdr.length; ci++) {
        var hn = normTitle(hdr[ci]);
        if (reviewIdx === -1 && REVIEW.indexOf(hn) !== -1) reviewIdx = ci;
        if (watchIdx === -1 && WATCH.indexOf(hn) !== -1) watchIdx = ci;
      }
      var width = Math.max(5, reviewIdx + 1, watchIdx + 1);
      var vals = sh.getRange(h + 1, 1, last - h, width).getValues();
      for (var r = 0; r < vals.length; r++) {
        var t = String(vals[r][0] || "").trim();
        if (!t) continue;
        var row = {
          title: t,
          year: String(vals[r][1] || "").trim(),
          j: String(vals[r][4] || "").trim(),
        };
        if (reviewIdx >= 0) row.review = String(vals[r][reviewIdx] || "").trim();
        if (watchIdx >= 0) row.watched_at = dateVal_(vals[r][watchIdx]);
        rows.push(row);
      }
    }
    out[name] = rows;
  }
  return { tabs: out };
}

// Probe: return each tab's header row (1-based column -> header text).
function gatewayHeaders_(b) {
  var ss = sheet_();
  var sheets = b.tab ? [ss.getSheetByName(baseTab_(String(b.tab)))] : ss.getSheets();
  var out = {};
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (!sh) continue;
    var name = sh.getName();
    if (name.indexOf("_sync_") === 0) continue;
    var h = headerRow_(sh);
    if (h < 1) { out[name] = { headerRow: -1 }; continue; }
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var cols = {};
    for (var ci = 0; ci < hdr.length; ci++) cols[ci + 1] = String(hdr[ci] || "");
    out[name] = { headerRow: h, cols: cols };
  }
  return { tabs: out };
}

// Rename a single row's title in one tab. Matches by current title and sets
// the new title, leaving every other cell untouched.
function gatewayRename_(b) {
  var ss = sheet_();
  var sh = ss.getSheetByName(baseTab_(b.tab));
  if (!sh) throw new Error("no tab " + baseTab_(b.tab));
  var row = findRow_(sh, b.title);
  if (row < 1) throw new Error("row not found: " + b.title);
  sh.getRange(row, 1).setValue(b.newTitle);
  return { row: row };
}

// Highlight a row's title cell Light yellow 2 (#ffe599) (James's "this was a
// rewatch" marker). body.tab + body.title select the row; body.index picks
// which matching row (0-based, default first). Pass mark:false to clear the
// highlight.
function gatewayMarkRewatch_(b) {
  var ss = sheet_();
  var sh = ss.getSheetByName(baseTab_(b.tab));
  if (!sh) throw new Error("no tab " + baseTab_(b.tab));
  var rows = findRows_(sh, b.title);
  if (rows.length === 0) throw new Error("row not found: " + b.title);
  var idx = b.index == null ? 0 : Number(b.index);
  if (idx < 0 || idx >= rows.length) throw new Error("index out of range");
  var color = b.mark === false ? "#ffffff" : "#ffe599";
  sh.getRange(rows[idx], 1).setBackground(color);
  return { row: rows[idx], color: color };
}

// Write (or clear, with "") a review for a title. With body.tab (and optional
// body.index) the write targets one tab's Nth matching row (season entries on
// "Shows Watched"); the app sends body.tab for movie-level reviews too (the
// title's primary tab). Reviews only land on tabs that actually hold reviews:
// the "Thoughts" column of 2026 (position 7), or any tab whose header contains
// a review-named column. No column is ever auto-created for a review.
function gatewaySetReview_(b) {
  var ss = sheet_();
  var value = b.review == null ? "" : String(b.review);
  var tabs = b.tab ? [baseTab_(String(b.tab))] : tabs_();
  var REVIEW = ["review", "my review", "what did i think", "thoughts", "watched thoughts", "review/thoughts", "thoughts/review"];
  var updated = 0;
  for (var t = 0; t < tabs.length; t++) {
    var sh = ss.getSheetByName(tabs[t]);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var rows = findRows_(sh, b.title);
    if (b.index != null && b.index >= 0 && b.index < rows.length) {
      rows = [rows[Number(b.index)]];
    }
    if (rows.length === 0) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var reviewIdx = -1;
    var fixed = THOUGHTS_COL_BY_TAB[sh.getName()];
    if (fixed != null && fixed - 1 < hdr.length) reviewIdx = fixed - 1;
    if (reviewIdx < 0) {
      for (var ci = 0; ci < hdr.length; ci++) {
        if (reviewIdx === -1 && REVIEW.indexOf(normTitle(hdr[ci])) !== -1) reviewIdx = ci;
      }
    }
    if (reviewIdx < 0) continue;
    for (var k = 0; k < rows.length; k++) {
      sh.getRange(rows[k], reviewIdx + 1).setValue(value);
      updated++;
    }
  }
  return { updated: updated };
}

// Write (or clear, with "") a title's reference/comment from the app into the
// tab's Reference column. With body.tab (sent by the app, the title's primary
// tab) only that tab is written; otherwise the first synced tab that has the
// title. The target column comes from the per-tab REF_COL_BY_TAB map (Rewatch/
// Movies/No Di col H, Shows/Shows w/o Di col G, 2026 col I) or, for tabs not in
// the map, a header actually named "Reference". No column is ever auto-created.
// (The reverse direction — sheet -> app — is handled during doSync, which reads
// any "Reference" column into the app.)
function gatewaySetReference_(b) {
  var ss = sheet_();
  var value = b.reference == null ? "" : String(b.reference);
  var tabs = b.tab ? [baseTab_(String(b.tab))] : tabs_();
  var updated = 0;
  for (var t = 0; t < tabs.length; t++) {
    var sh = ss.getSheetByName(tabs[t]);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var rows = findRows_(sh, b.title);
    if (rows.length === 0) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var refIdx = -1;
    var fixed = REF_COL_BY_TAB[sh.getName()];
    if (fixed != null && fixed - 1 < hdr.length) refIdx = fixed - 1;
    if (refIdx < 0) {
      for (var ci = 0; ci < hdr.length; ci++) {
        if (refIdx === -1 && normTitle(hdr[ci]) === "reference") refIdx = ci;
      }
    }
    if (refIdx < 0) continue;
    for (var k = 0; k < rows.length; k++) {
      sh.getRange(rows[k], refIdx + 1).setValue(value);
      updated++;
    }
  }
  return { updated: updated };
}

// Set a single cell on a tab. body.tab + body.row (1-based row, default header
// row + 1 if omitted) + body.col (1-based column) + body.value. Used for
// one-off maintenance; not part of the normal sync flow.
function gatewaySetCell_(b) {
  var sh = sheet_().getSheetByName(baseTab_(String(b.tab)));
  if (!sh) throw new Error("no tab " + baseTab_(String(b.tab)));
  var row = b.row != null ? Number(b.row) : headerRow_(sh) + 1;
  if (row < 1) throw new Error("no header row in " + b.tab);
  var col = Number(b.col);
  if (col < 1) throw new Error("bad column");
  var value = b.value == null ? "" : String(b.value);
  sh.getRange(row, col).setValue(value);
  return { row: row, col: col, value: value };
}

// Delete any "Reference"/"Thoughts" (review) columns that are entirely empty
// below the header row. Leftovers from the earlier behavior that created a
// column on every tab. Returns the number of columns removed.
function gatewayCleanupColumns_() {
  var ss = sheet_();
  var NAMES = ["reference", "thoughts", "review", "my review", "what did i think", "watched thoughts", "review/thoughts", "thoughts/review"];
  var removed = 0;
  var tabs = tabs_();
  for (var t = 0; t < tabs.length; t++) {
    var sh = ss.getSheetByName(tabs[t]);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    for (var ci = hdr.length - 1; ci >= 0; ci--) {
      if (NAMES.indexOf(normTitle(hdr[ci])) === -1) continue;
      var last = sh.getLastRow();
      var empty = true;
      if (last > h) {
        var vals = sh.getRange(h + 1, ci + 1, last - h, 1).getValues();
        for (var r = 0; r < vals.length; r++) {
          if (String(vals[r][0]).trim() !== "") { empty = false; break; }
        }
      }
      if (empty) {
        sh.deleteColumn(ci + 1);
        removed++;
      }
    }
  }
  return { removed: removed };
}

// One-shot cleanup of the leftover "Reference" columns that the older buggy
// gateway auto-created (one fresh column per push). For every tab it finds the
// canonical reference column (REF_COL_BY_TAB, else the first header actually
// named "Reference") and any other "Reference"-named columns. Values that are
// only in a stray column are copied into the canonical column (right-to-left,
// so the newest stray wins) when the canonical cell is empty — this preserves
// references typed straight into the sheet that never reached the app — then
// every stray column is deleted. Values that match the app (already pushed into
// the canonical column by the app) are simply dropped with the stray.
function gatewayConsolidateReferences_() {
  var ss = sheet_();
  var removed = 0;
  var copied = 0;
  var kept = 0;
  var tabs = tabs_();
  for (var t = 0; t < tabs.length; t++) {
    var sh = ss.getSheetByName(tabs[t]);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var canonical = -1;
    var fixed = REF_COL_BY_TAB[sh.getName()];
    if (fixed != null && fixed - 1 < hdr.length) canonical = fixed - 1;
    for (var ci = 0; ci < hdr.length; ci++) {
      if (canonical === -1 && normTitle(hdr[ci]) === "reference") { canonical = ci; break; }
    }
    if (canonical < 0) continue;
    var strays = [];
    var width = canonical + 1;
    for (var ci = 0; ci < hdr.length; ci++) {
      if (ci === canonical) continue;
      if (normTitle(hdr[ci]) === "reference") {
        strays.push(ci);
        if (ci + 1 > width) width = ci + 1;
      }
    }
    if (strays.length === 0) continue;
    var last = sh.getLastRow();
    var rows = [];
    if (last > h) rows = sh.getRange(h + 1, 1, last - h, width).getValues();
    for (var s = strays.length - 1; s >= 0; s--) {
      var col = strays[s];
      for (var r = 0; r < rows.length; r++) {
        var v = String(rows[r][col] || "").trim();
        if (v === "") continue;
        var cv = String(rows[r][canonical] || "").trim();
        if (cv !== "") { kept++; continue; }
        sh.getRange(h + 1 + r, canonical + 1).setValue(v);
        copied++;
      }
    }
    for (var s = strays.length - 1; s >= 0; s--) {
      sh.deleteColumn(strays[s] + 1);
      removed++;
    }
  }
  return { removed: removed, copied: copied, kept: kept };
}

// Insert many rows at once, grouped by tab. Batches the writes per tab (one
// setValues call) so a few thousand rows stay inside the execution time limit.
// Skips titles already present in the tab. Creates the tab if missing.
// body.rowsByTab = { "Archive 2024": [ {title, year, genre, status, j, date}, ... ] }
function gatewayImportRows_(b) {
  var rowsByTab = b.rowsByTab || {};
  var total = 0;
  var tabs = Object.keys(rowsByTab);
  var ss = sheet_();
  for (var t = 0; t < tabs.length; t++) {
    var tab = tabs[t];
    try {
      var list = rowsByTab[tab];
      if (!list || !list.length) continue;
      var sh = ss.getSheetByName(tab);
      if (!sh) {
        sh = ss.insertSheet(tab);
        sh.getRange(1, 1).setValue("Movie Title");
      }
      var h = headerRow_(sh);
      if (h < 1) {
        if (sh.getLastRow() < 1) sh.getRange(1, 1).setValue("Movie Title");
        h = 1;
      }
      var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
      var genreIdx = -1;
      var statusIdx = -1;
      var dateIdx = -1;
      for (var ci = 0; ci < hdr.length; ci++) {
        var hn = normTitle(hdr[ci]);
        if (genreIdx === -1 && hn === "genre") genreIdx = ci;
        if (statusIdx === -1 && (hn === "status" || hn === "list")) statusIdx = ci;
        if (dateIdx === -1 && (hn === "finished" || hn === "date finished" || hn === "date watched" || hn === "date/watched" || hn === "watched")) dateIdx = ci;
      }
      var last = sh.getLastRow();
      var existing = {};
      if (last > h) {
        var vals = sh.getRange(h + 1, 1, last - h, 1).getValues();
        for (var i = 0; i < vals.length; i++) {
          existing[normTitle(vals[i][0])] = true;
        }
      }
      var matrix = [];
      var at = h + 1;
      while (at <= last) {
        if (String(sh.getRange(at, 1).getValue()).trim() === "") break;
        at++;
      }
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (existing[normTitle(r.title)]) continue;
        var row = [];
        row[0] = String(r.title || "");
        row[1] = r.year ? String(r.year) : "";
        if (genreIdx > -1) row[genreIdx] = String(r.genre || "");
        if (statusIdx > -1) row[statusIdx] = String(r.status || "To Watch");
        if (r.j != null && String(r.j) !== "" && colIs_(hdr, 4, "j")) row[4] = String(r.j);
        if (r.date && dateIdx > -1) row[dateIdx] = String(r.date);
        matrix.push(row);
      }
      if (!matrix.length) continue;
      var width = Math.max(sh.getLastColumn(), 6);
      for (var i = 0; i < matrix.length; i++) {
        var rr = matrix[i];
        if (rr.length < width) {
          var filled = rr.slice();
          for (var k = rr.length; k < width; k++) filled.push("");
          matrix[i] = filled;
        }
      }
      sh.getRange(at, 1, matrix.length, width).setValues(matrix);
      total += matrix.length;
    } catch (err) {
      throw new Error("importRows tab=" + tab + ": " + (err && err.message ? err.message : err));
    }
  }
  return { rows: total, tabs: tabs.length };
}

function gatewayStatus_(b) {
  var ss = sheet_();
  var status = b.status || "To Watch";
  var tabs = tabs_();
  for (var i = 0; i < tabs.length; i++) {
    var sh = ss.getSheetByName(tabs[i]);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var row = findRow_(sh, b.title);
    if (row < 1) continue;
    ensureStatusHeader_(sh, h);
    sh.getRange(row, 9).setValue(status);
  }
}

function gatewayRating_(b) {
  var ss = sheet_();
  var v = b.rating == null ? "" : String(b.rating);
  var tabs = tabs_();
  for (var i = 0; i < tabs.length; i++) {
    var sh = ss.getSheetByName(tabs[i]);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var row = findRow_(sh, b.title);
    if (row > 0 && colIs_(hdr, 4, "j")) sh.getRange(row, 5).setValue(v);
  }
}

// Read a review/thoughts column across tabs. Scans every synced tab (or a
// single tab via body.tab) and returns {title, review} rows for any row whose
// review column is non-empty. The review column is detected by its header name
// ("review", "thoughts", "my review", ...), or forced with body.col (1-based).
function gatewayReviews_(b) {
  var ss = sheet_();
  var tabs = b.tab ? [baseTab_(String(b.tab))] : tabs_();
  var forced = b.col ? Number(b.col) - 1 : -1;
  var HEADS = ["review", "my review", "what did i think", "thoughts", "watched thoughts", "review/thoughts", "thoughts/review"];
  var reviews = [];
  var sheets = [];
  for (var t = 0; t < tabs.length; t++) {
    var tab = tabs[t];
    var sh = ss.getSheetByName(tab);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var last = sh.getLastRow();
    if (last <= h) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var idx = forced;
    var colName = "";
    if (idx < 0) {
      for (var ci = 0; ci < hdr.length; ci++) {
        var hn = normTitle(hdr[ci]);
        if (HEADS.indexOf(hn) !== -1) {
          idx = ci;
          colName = String(hdr[ci] || "");
          break;
        }
      }
    } else {
      colName = String(hdr[idx] || "");
    }
    if (idx < 0) {
      sheets.push({ tab: tab, col: -1, colName: "" });
      continue;
    }
    var grid = sh.getRange(h + 1, 1, last - h, idx + 1).getValues();
    for (var r = 0; r < grid.length; r++) {
      var title = String(grid[r][0] || "").trim();
      var review = String(grid[r][idx] || "").trim();
      if (title && review) reviews.push({ tab: tab, title: title, review: review });
    }
    sheets.push({ tab: tab, col: idx + 1, colName: colName });
  }
  return { reviews: reviews, sheets: sheets };
}

// True when a cell fill looks yellow (James's marker for "this was a rewatch").
// Uses HSL so common Sheets yellows (#ffff00, #fff2cc, #ffe599, #ffd966, ...)
// all match while white and orange/red fills don't.
function isYellow_(color) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(color || "").trim());
  if (!m) return false;
  var n = parseInt(m[1], 16);
  var r = (n >> 16) & 255;
  var g = (n >> 8) & 255;
  var b = n & 255;
  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  if (max === min) return false;
  var l = (max + min) / 510;
  var d = max - min;
  var s = l > 0.5 ? d / (510 - max - min) : d / (max + min);
  var h;
  if (max === r) h = (g - b) / d;
  else if (max === g) h = 2 + (b - r) / d;
  else h = 4 + (r - g) / d;
  h *= 60;
  if (h < 0) h += 360;
  return h >= 35 && h <= 75 && s >= 0.3 && l >= 0.5;
}

// Read per-season data across tabs. Returns one entry per row that carries any
// review/rating/watched date, in sheet order, numbered 1..N per show so the row
// order encodes the season (first occurrence = S1, second = S2, ...). Col 5 is
// "J" (my rating for movies, but "remaining episodes" for shows — the app
// ignores it for shows), col 6 is "D" (Di's rating), the review column is
// detected by header, and the watched/finished column likewise. A row whose
// title cell is filled yellow is marked rewatch:true and does NOT advance the
// season counter (James highlights a rewatch row yellow).
function gatewaySeasonEntries_(b) {
  var ss = sheet_();
  var tabs = b.tab ? [baseTab_(String(b.tab))] : tabs_();
  var REVIEW = ["review", "my review", "what did i think", "thoughts", "watched thoughts", "review/thoughts", "thoughts/review"];
  var WATCH = ["watched", "date watched", "watched date", "date/watched", "date", "finished", "date finished", "finished date", "end date", "date completed", "completed"];
  var counts = {};
  var entries = [];
  var TO_WATCH = { "Shows": 1, "Shows w/o Di": 1 };
  for (var t = 0; t < tabs.length; t++) {
    var tab = tabs[t];
    if (TO_WATCH[tab]) continue;
    var sh = ss.getSheetByName(tab);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var last = sh.getLastRow();
    if (last <= h) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var reviewIdx = -1;
    var watchIdx = -1;
    for (var ci = 0; ci < hdr.length; ci++) {
      var hn = normTitle(hdr[ci]);
      if (reviewIdx === -1 && REVIEW.indexOf(hn) !== -1) reviewIdx = ci;
      if (watchIdx === -1 && WATCH.indexOf(hn) !== -1) watchIdx = ci;
    }
    var width = Math.max(reviewIdx + 1, watchIdx + 1, 6);
    var grid = sh.getRange(h + 1, 1, last - h, width).getValues();
    var bgs = sh.getRange(h + 1, 1, last - h, width).getBackgrounds();
    for (var r = 0; r < grid.length; r++) {
      var title = String(grid[r][0] || "").trim();
      if (!title) continue;
      var review = reviewIdx >= 0 ? String(grid[r][reviewIdx] || "").trim() : "";
      var j = String(grid[r][4] || "").trim();
      var d = String(grid[r][5] || "").trim();
      var wv = watchIdx >= 0 ? dateVal_(grid[r][watchIdx]) : "";
      if (review === "" && j === "" && d === "" && wv === "") continue;
      var key = normKey(title);
      var rewatch = isYellow_(bgs[r][0]);
      var season;
      if (rewatch) {
        season = counts[key] || 1;
      } else {
        counts[key] = (counts[key] || 0) + 1;
        season = counts[key];
      }
      entries.push({
        title: title,
        tab: tab,
        season: season,
        review: review,
        my_rating: j === "" || isNaN(parseInt(j, 10)) ? null : parseInt(j, 10),
        di_rating: d === "" || isNaN(parseInt(d, 10)) ? null : parseInt(d, 10),
        watched_at: wv === "" ? null : wv,
        rewatch: rewatch,
      });
    }
  }
  return { entries: entries };
}

// Move whole rows from one tab to another. Used to archive old years.
// body.rows are 1-based spreadsheet row numbers (data rows only, below the
// header). Rows are copied to the target tab below its existing data (or
// below a copied header if the tab is new), then deleted bottom-up from the
// source so the untouched rows keep their positions. The target tab is also
// added to the sync TABS so a follow-up sync never drops the moved items.
function gatewayMove_(b) {
  var ss = sheet_();
  if (b.from === b.to) throw new Error("source and target are the same tab");
  var src = ss.getSheetByName(b.from);
  if (!src) throw new Error("no tab " + b.from);
  var h = headerRow_(src);
  if (h < 1) throw new Error("no header row in " + b.from);
  var rows = (b.rows || [])
    .map(function (r) {
      return Number(r);
    })
    .filter(function (r) {
      return isFinite(r) && r >= h + 1;
    });
  rows.sort(function (a, b2) {
    return a - b2;
  });
  if (!rows.length) throw new Error("no rows to move");
  ensureTab_(b.to);
  var dst = ss.getSheetByName(b.to);
  var width = src.getLastColumn();
  if (!dst) {
    dst = ss.insertSheet(b.to, 1);
    var hdr = src.getRange(h, 1, 1, width).getValues()[0];
    dst.getRange(1, 1, 1, width).setValues([hdr]);
  }
    var dh = headerRow_(dst);
    if (dh < 1) {
      var hdr = src.getRange(h, 1, 1, width).getValues()[0];
      if (dst.getLastRow() < 1) {
        dst.getRange(1, 1, 1, width).setValues([hdr]);
      } else {
        dst.insertRowBefore(1);
        dst.getRange(1, 1, 1, width).setValues([hdr]);
      }
      dh = 1;
    }
  var at = dst.getLastRow() + 1;
  if (at <= dh) at = dh + 1;
  for (var i = 0; i < rows.length; i++) {
    var vals = src.getRange(rows[i], 1, 1, width).getValues()[0];
    dst.getRange(at, 1, 1, width).setValues([vals]);
    at++;
  }
  for (var j = rows.length - 1; j >= 0; j--) src.deleteRow(rows[j]);
  return rows.length;
}

function ensureTab_(name) {
  var raw = props().getProperty("TABS");
  var list = (raw ? raw : DEFAULT_TABS)
    .split(",")
    .map(function (t) {
      return String(t).trim();
    })
    .filter(Boolean);
  if (list.indexOf(name) >= 0) return;
  list.push(name);
  props().setProperty("TABS", list.join(","));
}

function parseRanges_(s) {
  var out = [];
  var parts = String(s || "").split(",");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    var m = p.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    var a = Number(m[1]);
    var b = m[2] ? Number(m[2]) : a;
    if (a > b) {
      var t = a;
      a = b;
      b = t;
    }
    for (var r = a; r <= b; r++) out.push(r);
  }
  out.sort(function (x, y) {
    return x - y;
  });
  var uniq = [];
  for (var j = 0; j < out.length; j++)
    if (uniq[uniq.length - 1] !== out[j]) uniq.push(out[j]);
  return uniq;
}

// Sync menu -> "Archive rows...". Moves the row range you type out of the
// "Shows Watched" tab into the Archive tab, then the app sync picks them up.
function archiveRows() {
  var ss = sheet_();
  var ui = SpreadsheetApp.getUi();
  var src = ss.getSheetByName("Shows Watched");
  var h = src ? headerRow_(src) : -1;
  if (h < 1) {
    ui.alert(
      'The "Shows Watched" tab has no title header. It needs "Movie Title" / ' +
        '"Show Title" / "Series Title" in column A within the first 10 rows.',
    );
    return;
  }
  var res = ui.prompt(
    "Archive rows — Shows Watched",
    "Move rows (1-based spreadsheet row numbers) from Shows Watched to the " +
      "Archive tab. Row 2 is the first title under the header.\n" +
      "Examples: 2-98   or   3-52,54-118,120-183",
    ui.ButtonSet.OK_CANCEL,
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var rows = parseRanges_(res.getResponseText()).filter(function (r) {
    return r > h;
  });
  if (!rows.length) {
    ui.alert("No data rows matched that range.");
    return;
  }
  var moved = gatewayMove_({ from: "Shows Watched", to: "Archive", rows: rows });
  ui.alert("Moved " + moved + " rows to Archive.");
}

// Year for a row based on its "Finished" cell. Blank (no finish date) means
// it was watched in 2022; otherwise the 4-digit year is pulled from the date.
function yearOf_(v) {
  var s = String(v || "").trim();
  if (s === "") return "2022";
  var m = s.match(/\b(19|20)\d{2}\b/);
  if (m) return m[0];
  var d = new Date(s);
  if (!isNaN(d.getTime())) return String(d.getFullYear());
  return "2022";
}

// Sync menu -> "Archive by year...". Splits the Archive tab into per-year tabs
// ("Archive 2022", "Archive 2023", ...) using the "Finished" date column.
// Rows without a finish date go to 2022; blank separator rows are skipped.
// Every year tab is created with the Archive header and added to the sync
// TABS (so a follow-up sync keeps the items). The Archive tab is left as just
// its header. Run Sync now afterwards.
function archiveByYear() {
  var ss = sheet_();
  var ui = SpreadsheetApp.getUi();
  var src = ss.getSheetByName("Archive");
  var h = src ? headerRow_(src) : -1;
  if (h < 1) {
    ui.alert('The "Archive" tab has no title header. It needs "Movie Title" / ' +
      '"Show Title" / "Series Title" in column A within the first 10 rows.');
    return;
  }
  var width = src.getLastColumn();
  var grid = src.getRange(1, 1, src.getLastRow(), width).getValues();
  var headerRow = grid[h - 1];
  var finIdx = -1;
  for (var ci = 0; ci < headerRow.length; ci++) {
    var hname = normTitle(headerRow[ci]);
    if (hname === "finished" || hname === "date finished" || hname === "date completed") {
      finIdx = ci;
      break;
    }
  }
  if (finIdx === -1) {
    ui.alert('The "Archive" tab has no "Finished" column in its header row.');
    return;
  }
  var byYear = {};
  for (var i = h; i < grid.length; i++) {
    var title = String(grid[i][0] || "").trim();
    if (!title) continue;
    var y = yearOf_(grid[i][finIdx]);
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(grid[i].slice());
  }
  var years = Object.keys(byYear).sort();
  var total = 0;
  for (var j = 0; j < years.length; j++) {
    var y = years[j];
    var name = "Archive " + y;
    ensureTab_(name);
    var dst = ss.getSheetByName(name);
    if (!dst) {
      dst = ss.insertSheet(name, 1);
      dst.getRange(1, 1, 1, width).setValues([headerRow.slice()]);
    }
    var dh = headerRow_(dst);
    if (dh < 1) {
      if (dst.getLastRow() < 1) {
        dst.getRange(1, 1, 1, width).setValues([headerRow.slice()]);
      } else {
        dst.insertRowBefore(1);
        dst.getRange(1, 1, 1, width).setValues([headerRow.slice()]);
      }
      dh = 1;
    }
    var at = Math.max(dst.getLastRow() + 1, dh + 1);
    dst.getRange(at, 1, byYear[y].length, width).setValues(byYear[y]);
    total += byYear[y].length;
  }
  src.getRange(h + 1, 1, grid.length - h, width).clearContent();
  var parts = [];
  for (var k = 0; k < years.length; k++) {
    parts.push("Archive " + years[k] + ": " + byYear[years[k]].length);
  }
  ui.alert(
    "Moved " + total + " rows.\n" + parts.join("\n") +
      "\nArchive is now header-only. Run Sync now.",
  );
}

// Sync menu -> "Clean up lists...". Finds rows sitting in the wrong tab and
// rows that are rated (or have a Date Watched) but still on a to-watch list,
// then moves each to the right place:
//   - a movie found in a shows-named tab -> Movies
//   - a show found in a movie to-watch tab -> Shows
//   - a rated/watched row on a to-watch list -> a year tab: its own Date
//     Watched year, else the year of the nearest dated row above or below in
//     the same tab, else the current year's tab ("2026"; older years go to
//     "Archive YYYY").
// "Rated" is J or D for movies, D only for shows (column E is "remaining
// episodes" for shows). Kind comes from the app (TMDB), since the sheet
// doesn't store it. Blank separator rows are skipped. Run Sync now afterwards.
function cleanupLists() {
  var ss = sheet_();
  var ui = SpreadsheetApp.getUi();
  var appUrl = appUrl_();
  if (!appUrl) {
    ui.alert("Set your app URL first (Sync menu).");
    return;
  }
  var appItems = [];
  try {
    appItems = fetchJson_(appUrl + "/api/items") || [];
  } catch (e) {
    ui.alert("Can't reach app: " + e.message);
    return;
  }
  var appByKey = {};
  for (var i = 0; i < appItems.length; i++) {
    var k = normKey(appItems[i].title);
    if (k && !appByKey[k]) appByKey[k] = appItems[i];
  }

  var movieTabs = ["Movies", "No Di", "Rewatch", "Rewatch w/ Di", "Rewatch w/o Di"];
  var showTabs = ["Shows", "Shows w/o Di"];
  var year = String(new Date().getFullYear());

  // moves[tab] = [{ row, to, title }]; row is a 1-based sheet row.
  var moves = {};

  var tabs = tabs_();
  for (var t = 0; t < tabs.length; t++) {
    var tab = tabs[t];
    var isMovies = movieTabs.indexOf(tab) !== -1;
    var isShows = showTabs.indexOf(tab) !== -1;
    var isWatched = tab === "Shows Watched";
    if (!isMovies && !isShows && !isWatched) continue;

    var sh = ss.getSheetByName(tab);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var last = sh.getLastRow();
    if (last <= h) continue;

    var grid = sh.getRange(h, 1, last - h + 1, sh.getLastColumn()).getValues();
    var hdr = grid[0];
    var watchIdx = -1;
    for (var ci = 0; ci < hdr.length; ci++) {
      var hn = normTitle(hdr[ci]);
      if (watchIdx === -1 && (hn === "watched" || hn === "date watched" || hn === "watched date" || hn === "date/watched" || hn === "date" || hn === "finished" || hn === "date finished" || hn === "date completed" || hn === "completed")) watchIdx = ci;
    }

    var rows = [];
    for (var i = 1; i < grid.length; i++) {
      var title = String(grid[i][0] || "").trim();
      if (!title) continue;
      var appItem = findApp_(title, appByKey);
      if (!appItem) continue;
      var jv = String(grid[i][4] || "").trim();
      var dv = String(grid[i][5] || "").trim();
      var wv = watchIdx >= 0 ? dateVal_(grid[i][watchIdx]) : "";
      rows.push({
        row: h + i,
        title: title,
        kind: appItem.kind,
        rated: appItem.kind === "tv" ? dv !== "" : jv !== "" || dv !== "",
        date: wv,
      });
    }

    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var to = null;
      if (isWatched) {
        if (r.kind === "movie") to = "Movies";
      } else if (r.rated || r.date !== "") {
        var y = r.date !== "" ? yearOf_(r.date) : "";
        if (y === "") {
          for (var u = j - 1; u >= 0; u--) {
            if (rows[u].date !== "") {
              y = yearOf_(rows[u].date);
              break;
            }
          }
        }
        if (y === "") {
          for (var d = j + 1; d < rows.length; d++) {
            if (rows[d].date !== "") {
              y = yearOf_(rows[d].date);
              break;
            }
          }
        }
        if (y === "") y = year;
        to = y === year ? year : "Archive " + y;
      } else if (r.kind === "movie" && isShows) {
        to = "Movies";
      } else if (r.kind === "tv" && isMovies) {
        to = "Shows";
      }
      if (!to) continue;
      if (!moves[tab]) moves[tab] = [];
      moves[tab].push({ row: r.row, to: to, title: r.title });
    }
  }

  var total = 0;
  var byDest = {};
  for (var src in moves) {
    total += moves[src].length;
    for (var k = 0; k < moves[src].length; k++) {
      var to = moves[src][k].to;
      byDest[to] = (byDest[to] || 0) + 1;
    }
  }
  if (!total) {
    ui.alert("Nothing to clean up — every row is in the right place.");
    return;
  }
  var parts = [];
  for (var d in byDest) parts.push(d + ": " + byDest[d]);
  var res = ui.alert(
    "Clean up " + total + " rows?\n\n" + parts.join("\n"),
    ui.ButtonSet.YES_NO
  );
  if (res !== ui.Button.YES) return;

  // Evacuate each source tab bottom-up so 1-based row numbers stay valid.
  for (var src in moves) {
    var srcSh = ss.getSheetByName(src);
    var h2 = headerRow_(srcSh);
    var width = srcSh.getLastColumn();
    var order = moves[src].slice().sort(function (a, b) {
      return b.row - a.row;
    });
    for (var m = 0; m < order.length; m++) {
      var mv = order[m];
      ensureTab_(mv.to);
      var dst = ss.getSheetByName(mv.to);
      if (!dst) {
        dst = ss.insertSheet(mv.to, 1);
        dst.getRange(1, 1, 1, width).setValues([
          srcSh.getRange(h2, 1, 1, width).getValues()[0],
        ]);
      }
      var dh = headerRow_(dst);
      if (dh < 1) {
        if (dst.getLastRow() < 1) {
          dst.getRange(1, 1, 1, width).setValues([
            srcSh.getRange(h2, 1, 1, width).getValues()[0],
          ]);
        } else {
          dst.insertRowBefore(1);
          dst.getRange(1, 1, 1, width).setValues([
            srcSh.getRange(h2, 1, 1, width).getValues()[0],
          ]);
        }
        dh = 1;
      }
      var at = dst.getLastRow() + 1;
      if (at <= dh) at = dh + 1;
      dst.getRange(at, 1, 1, width).setValues([
        srcSh.getRange(mv.row, 1, 1, width).getValues()[0],
      ]);
      srcSh.deleteRow(mv.row);
    }
  }
  ui.alert("Moved " + total + " rows. Run Sync now.");
}

// Debug helper: list every non-white-filled title cell across synced tabs with
// its raw color, so the yellow-rewatch marker can be verified/tuned. body.tab
// limits to a single tab.
function gatewayRewatchScan_(b) {
  var ss = sheet_();
  var tabs = b.tab ? [baseTab_(String(b.tab))] : tabs_();
  var TO_WATCH = { "Shows": 1, "Shows w/o Di": 1 };
  var rows = [];
  for (var t = 0; t < tabs.length; t++) {
    var tab = tabs[t];
    if (TO_WATCH[tab]) continue;
    var sh = ss.getSheetByName(tab);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var last = sh.getLastRow();
    if (last <= h) continue;
    var bgs = sh.getRange(h + 1, 1, last - h, 1).getBackgrounds();
    var grid = sh.getRange(h + 1, 1, last - h, 1).getValues();
    for (var r = 0; r < grid.length; r++) {
      var title = String(grid[r][0] || "").trim();
      if (!title) continue;
      var color = String(bgs[r][0] || "").trim();
      if (color !== "" && color !== "#ffffff") {
        rows.push({
          tab: tab,
          title: title,
          color: color,
          rewatch: isYellow_(color),
        });
      }
    }
  }
  return { rows: rows };
}

// Write taste score / ratings from the app into the sheet's Taste Score (C),
// J (E), and D (F) columns for every synced tab the title appears on. Null
// fields are skipped so clearing one cell never wipes the others. The app
// sends kind so shows never get col E ("remaining episodes") clobbered.
function gatewayScore_(b) {
  var ss = sheet_();
  var taste = b.taste_score != null ? String(b.taste_score) : null;
  var j = b.j != null && String(b.j) !== "" ? String(b.j) : null;
  var d = b.d != null && String(b.d) !== "" ? String(b.d) : null;
  if (taste == null && j == null && d == null) return { updated: 0 };
  var tabs = b.tab ? [b.tab] : tabs_();
  var updated = 0;
  for (var i = 0; i < tabs.length; i++) {
    var sh = ss.getSheetByName(tabs[i]);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var rows = findRows_(sh, b.title);
    for (var k = 0; k < rows.length; k++) {
      if (taste != null) sh.getRange(rows[k], 3).setValue(taste);
      if (j != null && colIs_(hdr, 4, "j")) sh.getRange(rows[k], 5).setValue(j);
      if (d != null && colIs_(hdr, 5, "d")) sh.getRange(rows[k], 6).setValue(d);
      updated++;
    }
  }
  return { updated: updated };
}

// Push a show's episode progress (Current Episode / Total Episodes) and
// started/finished dates from the app into the show's tab. Fired (debounced)
// when episodes are toggled in the app. The app sends the target tab in b.tab
// (e.g. "Currently Watching" or "Archive 2026"); if absent we fall back to
// "Currently Watching", then "Archive 2026". The CUR/Epis/Started/Finished
// columns are located by header name ("CUR"/"Epis", "Started"/"Finished"),
// so no hard-coded column indices are assumed. No-ops when the show isn't on
// the tab yet or the columns are missing.
function gatewayEpisodeProgress_(b) {
  var ss = sheet_();
  var tab = b.tab || "Currently Watching";
  var sh = ss.getSheetByName(tab) || ss.getSheetByName("Currently Watching") || ss.getSheetByName("Archive 2026");
  if (!sh) return 0;
  var row = findRow_(sh, b.title);
  if (row < 1) return 0;
  var h = headerRow_(sh);
  if (h < 1) return 0;
  var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
  var curIdx = -1, episIdx = -1, startIdx = -1, finIdx = -1;
  for (var ci = 0; ci < hdr.length; ci++) {
    var hn = normTitle(hdr[ci]);
    if (curIdx === -1 && (hn === "cur" || hn === "current episode")) curIdx = ci;
    if (episIdx === -1 && (hn === "epis" || hn === "total episodes" || hn === "episodes")) episIdx = ci;
    if (startIdx === -1 && (hn === "started" || hn === "start date" || hn === "started date")) startIdx = ci;
    if (finIdx === -1 && (hn === "finished" || hn === "date finished" || hn === "finished date" || hn === "end date")) finIdx = ci;
  }
  var updated = 0;
  if (curIdx > -1) { sh.getRange(row, curIdx + 1).setValue(b.cur != null ? b.cur : "").setNumberFormat("0"); updated++; }
  if (episIdx > -1) { sh.getRange(row, episIdx + 1).setValue(b.epis != null ? b.epis : "").setNumberFormat("0"); updated++; }
  if (startIdx > -1) { sh.getRange(row, startIdx + 1).setValue(b.started || ""); updated++; }
  if (finIdx > -1) { sh.getRange(row, finIdx + 1).setValue(b.finished || ""); updated++; }
  return updated;
}

// Write a movie's watched date from the app into the watched/finished column of
// every synced tab the title appears on (only where such a column exists).
// Fired live when a movie's watched_at changes in the app; the next doSync
// self-heals anything that slips through. Empty dates are ignored so clearing
// a date in the app never wipes a historical date out of the sheet.
function gatewayWatched_(b) {
  var date = b.date ? String(b.date) : "";
  if (!date) return;
  var ss = sheet_();
  var tabs = tabs_();
  var updated = 0;
  for (var i = 0; i < tabs.length; i++) {
    var sh = ss.getSheetByName(tabs[i]);
    if (!sh) continue;
    var h = headerRow_(sh);
    if (h < 1) continue;
    var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
    var dateIdx = -1;
    for (var ci = 0; ci < hdr.length; ci++) {
      var hn = normTitle(hdr[ci]);
      if (dateIdx === -1 && (hn === "watched" || hn === "date watched" || hn === "watched date" || hn === "date/watched" || hn === "date" || hn === "finished" || hn === "date finished" || hn === "finished date" || hn === "end date" || hn === "date completed" || hn === "completed")) dateIdx = ci;
    }
    if (dateIdx < 0) continue;
    var spec = DATE_COL_BY_TAB[tabs[i]];
    var rows = findRows_(sh, b.title);
    for (var k = 0; k < rows.length; k++) {
      if (spec && dateIdx === spec.col - 1 && dateFromISO_(date)) {
        sh.getRange(rows[k], dateIdx + 1).setValue(dateFromISO_(date));
        sh.getRange(rows[k], dateIdx + 1).setNumberFormat(spec.fmt);
      } else {
        sh.getRange(rows[k], dateIdx + 1).setValue(date);
      }
      updated++;
    }
  }
  return { updated: updated };
}

// Register the app's public tunnel URL from the tunnel helper so doSync can
// reach the app. Fired by tunnel.sh on every tunnel start, which keeps the URL
// fresh without touching the Sync menu.
function gatewaySetAppUrl_(b) {
  var url = String(b.url || "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("url required");
  props().setProperty("APP_URL", url);
  return { url: url };
}

// One-time conversion of a DATE_COL_BY_TAB tab's date column: turns ISO
// strings into real Dates and applies the tab's number format to the column.
// Returns how many cells were converted.
function gatewayFixDates_(b) {
  var tab = String(b.tab || "");
  var spec = DATE_COL_BY_TAB[tab];
  if (!spec) return { updated: 0, formatted: false };
  var ss = sheet_();
  var sh = ss.getSheetByName(tab);
  if (!sh) return { updated: 0, formatted: false };
  var h = headerRow_(sh);
  if (h < 1) return { updated: 0, formatted: false };
  var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
  var dateIdx = spec.col - 1;
  if (dateIdx < 0 || dateIdx >= hdr.length) return { updated: 0, formatted: false };
  var count = sh.getLastRow() - h;
  if (count <= 0) return { updated: 0, formatted: false };
  var vals = sh.getRange(h + 1, dateIdx + 1, count, 1).getValues();
  var updated = 0;
  for (var r = 0; r < vals.length; r++) {
    var v = vals[r][0];
    if (v instanceof Date) continue;
    var d = dateFromISO_(v);
    if (!d) continue;
    sh.getRange(h + 1 + r, dateIdx + 1).setValue(d);
    updated++;
  }
  sh.getRange(h + 1, dateIdx + 1, count, 1).setNumberFormat(spec.fmt);
  return { updated: updated, formatted: true };
}

// Diagnostic op: read a show's live CUR/Epis/Started/Finished cell values from
// the sheet so we can verify what the app actually wrote. Returns the matched
// row number and the raw cell values (dates serialized to ISO). Returns
// {row:-1} when the title isn't found on the tab, or null when the tab is gone.
function gatewayPeek_(b) {
  var ss = sheet_();
  var tab = b.tab || "Currently Watching";
  var sh = ss.getSheetByName(tab);
  if (!sh) return null;
  var h = headerRow_(sh);
  if (h < 1) return null;
  var row = findRow_(sh, b.title);
  if (row < 1) return { row: -1 };
  var hdr = sh.getRange(h, 1, 1, sh.getLastColumn()).getValues()[0];
  var curIdx = -1, episIdx = -1, startIdx = -1, finIdx = -1;
  for (var ci = 0; ci < hdr.length; ci++) {
    var hn = normTitle(hdr[ci]);
    if (curIdx === -1 && (hn === "cur" || hn === "current episode")) curIdx = ci;
    if (episIdx === -1 && (hn === "epis" || hn === "total episodes" || hn === "episodes")) episIdx = ci;
    if (startIdx === -1 && (hn === "started" || hn === "start date" || hn === "started date")) startIdx = ci;
    if (finIdx === -1 && (hn === "finished" || hn === "date finished" || hn === "finished date" || hn === "end date")) finIdx = ci;
  }
  function cv(idx) {
    if (idx < 0) return null;
    var v = sh.getRange(row, idx + 1).getValue();
    return v == null ? "" : (v instanceof Date ? v.toISOString() : String(v));
  }
  return { row: row, cur: cv(curIdx), epis: cv(episIdx), started: cv(startIdx), finished: cv(finIdx) };
}

function doPost(e) {
  var out = { ok: true };
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body || body.token !== GATEWAY_TOKEN) throw new Error("bad token");
    if (body.op === "add") gatewayAdd_(body);
    else if (body.op === "remove") { var rv = gatewayRemove_(body); out.removed = rv.removed; }
    else if (body.op === "status") gatewayStatus_(body);
    else if (body.op === "rating") gatewayRating_(body);
    else if (body.op === "move") out.moved = gatewayMove_(body);
    else if (body.op === "reviews") { var rr = gatewayReviews_(body); out.reviews = rr.reviews; out.sheets = rr.sheets; }
    else if (body.op === "rename") { var rr = gatewayRename_(body); out.row = rr.row; }
    else if (body.op === "seasonEntries") { var ee = gatewaySeasonEntries_(body); out.entries = ee.entries; }
    else if (body.op === "rewatchScan") { var rs = gatewayRewatchScan_(body); out.rows = rs.rows; }
    else if (body.op === "episodeProgress") { var ep = gatewayEpisodeProgress_(body); out.updated = ep != null ? ep : 0; }
    else if (body.op === "watched") { var wd = gatewayWatched_(body); out.updated = (wd && wd.updated) || 0; }
    else if (body.op === "setAppUrl") { var su = gatewaySetAppUrl_(body); out.url = su.url; }
    else if (body.op === "score") { var sc = gatewayScore_(body); out.updated = sc.updated; }
    else if (body.op === "markRewatch") { var mr = gatewayMarkRewatch_(body); out.row = mr.row; out.color = mr.color; }
    else if (body.op === "setReview") { var sr = gatewaySetReview_(body); out.updated = sr.updated; }
    else if (body.op === "setReference") { var sf = gatewaySetReference_(body); out.updated = sf.updated; }
    else if (body.op === "cleanupColumns") { var cc = gatewayCleanupColumns_(); out.removed = cc.removed; }
    else if (body.op === "consolidateReferences") { var cr = gatewayConsolidateReferences_(); out.removed = cr.removed; out.copied = cr.copied; out.kept = cr.kept; }
    else if (body.op === "setCell") { var sc = gatewaySetCell_(body); out.row = sc.row; out.col = sc.col; }
    else if (body.op === "importRows") { var ir = gatewayImportRows_(body); out.rows = ir.rows; out.tabs = ir.tabs; }
    else if (body.op === "removeRows") { var rr = gatewayRemoveRows_(body); out.removed = rr.removed; }
    else if (body.op === "dump") { var dd = gatewayDump_(body); out.tabs = dd.tabs; }
    else if (body.op === "headers") { var hd = gatewayHeaders_(body); out.tabs = hd.tabs; }
    else if (body.op === "deleteTab") { var dt = gatewayDeleteTab_(body); out.deleted = dt.deleted; }
    else if (body.op === "fixDates") { var fd = gatewayFixDates_(body); out.updated = fd.updated; out.formatted = fd.formatted; }
    else if (body.op === "peek") { out.peek = gatewayPeek_(body); }
    else throw new Error("unknown op " + body.op);
  } catch (err) {
    out.ok = false;
    out.error = String(err && err.message ? err.message : err);
    out.stack = String(err && err.stack ? err.stack : "");
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}
