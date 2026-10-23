// Regression: the "2026" tab must be strictly newest-watch-first. Diana-confirmed
// picks used to sink to the bottom of EVERY tab, which dropped a movie watched
// today below one watched in January. The sink is meant for the to-watch queues
// (where a pick can be cleared off the sheet), not for the date-ordered tabs or
// the archives. Boots app.js the same way _test_pitt.mjs does.
//
//   bun _test_2026_order.mjs
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";

const html = `<!doctype html><html><body>
<main id="list"><div id="cats"></div><div id="tabs"></div>
<div id="tab-search-wrap"><input id="tab-search"/><button id="tab-search-clear"></button><div id="genre-bar"></div></div>
<div id="count"></div><div id="items"></div><div id="empty"></div>
<div id="slot-view"><div id="dash-mode"></div><div id="night-btn"></div><div id="night-genre"></div><div id="night-result"></div>
<div id="reel-title"></div><div id="reel-year"></div><div id="reel-genre"></div><div id="slot-result"></div><div id="dash-genres"></div></div>
</main><div id="results"></div></body></html>`;
const { document, window } = parseHTML(html);
globalThis.document = document;
globalThis.window = window;
function makeStub(id) {
  const cls = new Set();
  return {
    id, dataset: {}, style: {}, value: "", disabled: false, textContent: "", innerHTML: "",
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, f) => (f === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : f ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    },
    addEventListener: () => {}, removeEventListener: () => {}, appendChild: () => {},
    setAttribute: () => {}, getAttribute: () => null, querySelector: () => null,
    querySelectorAll: () => [], closest: () => null, scrollIntoView: () => {},
  };
}
const __origGet = document.getElementById.bind(document);
document.getElementById = (id) => __origGet(id) || makeStub(id);
try {
  globalThis.navigator = { clipboard: { writeText: async () => {} } };
} catch {
  // Node exposes navigator as a getter-only global; the stub isn't needed.
}
globalThis.location = { pathname: "/", origin: "http://localhost:3002", href: "" };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.addEventListener = () => {};
// NOTE: do not stub globalThis.performance — undici's fetch needs it.

let src = readFileSync("src/frontend/app.js", "utf8");
src += `\nglobalThis.__sortDefault = sortDefault;\n`;
const fn = new Function(
  "document", "window", "navigator", "location", "requestAnimationFrame",
  "addEventListener", "performance", "fetch", "setTimeout", "console", src,
);
fn(document, window, globalThis.navigator, globalThis.location,
   globalThis.requestAnimationFrame, globalThis.addEventListener,
   globalThis.performance, fetch, setTimeout, console);

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const order = (shown, list) => globalThis.__sortDefault(shown.slice(), list).map((x) => x.title);

const item = (title, extra = {}) => ({
  id: title, title, kind: "movie", lists: [], positions: {}, di_confirmed: false,
  watched_at: null, created_at: "2026-01-01 00:00:00", ...extra,
});

// 1. The reported bug: the newest movie is flagged Diana-confirmed and must stay
//    at the top of the 2026 tab, not sink under the January movies.
const newConfirmed = item("Newest", { watched_at: "2026-10-13", di_confirmed: true });
const newConfirmed2 = item("Second Newest", { watched_at: "2026-10-11", di_confirmed: true });
const october = item("October", { watched_at: "2026-10-02" });
const june = item("June", { watched_at: "2026-06-09" });
const january = item("January", { watched_at: "2026-01-03" });
check(
  "2026: confirmed picks stay in date order",
  order([newConfirmed, newConfirmed2, october, june, january], "2026"),
  ["Newest", "Second Newest", "October", "June", "January"],
);

// 2. Purely chronological: whatever the incoming order, the tab comes out
//    newest-watch-first.
check(
  "2026: sorted newest-first from any incoming order",
  order([january, june, october, newConfirmed2, newConfirmed], "2026"),
  ["Newest", "Second Newest", "October", "June", "January"],
);

// 3. Titles with no watch date sit after the dated ones.
check(
  "2026: undated titles last",
  order([item("Undated"), october, january], "2026"),
  ["October", "January", "Undated"],
);

// 4. Same-date ties keep the server order (which is created_at DESC).
check(
  "2026: same-date ties keep incoming order",
  order([item("First tie", { watched_at: "2026-09-26" }), item("Second tie", { watched_at: "2026-09-26" })], "2026"),
  ["First tie", "Second tie"],
);

// 5. The to-watch queues still push confirmed picks out of the way.
const picked = item("Picked", { positions: { Movies: 1 }, di_confirmed: true });
const other = item("Other", { positions: { Movies: 2 } });
check("Movies: confirmed pick still sinks", order([picked, other], "Movies"), ["Other", "Picked"]);
check("No Di: confirmed pick still sinks", order([picked, other], "No Di"), ["Other", "Picked"]);

// 6. Date-ordered and archived tabs never sink: their own order wins.
check(
  "2025 archive: confirmed pick keeps its row order",
  order([item("Row one", { positions: { 2025: 1 }, di_confirmed: true }), item("Row two", { positions: { 2025: 2 } })], "2025"),
  ["Row one", "Row two"],
);

// 7. Currently Watching stays last-position-first (newest episode at the top).
check(
  "Currently Watching: reversed positions, no sink",
  order(
    [
      item("Older show", { positions: { "Currently Watching": 1 } }),
      item("Newer show", { positions: { "Currently Watching": 2 }, di_confirmed: true }),
    ],
    "Currently Watching",
  ),
  ["Newer show", "Older show"],
);

const pass = results.every(Boolean);
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
