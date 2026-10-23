// Frontend companion to _test_nodi.mjs: the card's Lists menu must keep a
// Diana-only-scored movie off "Movies" (a to-watch-together pick) while still
// allowing "No Di" (watch it solo). A movie James scored stays off both.
//
// Run against a local server (app.js is read from disk, no server needed, but
// the harness boots the module the same way _test_pitt.mjs does):
//   bun _test_nodi_ui.mjs
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
  // Node 24 exposes navigator as a getter-only global; the stub isn't needed.
}
globalThis.location = { pathname: "/", origin: "http://localhost:3002", href: "" };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.addEventListener = () => {};
// NOTE: do not stub globalThis.performance — undici's fetch needs
// performance.markResourceTiming, and clobbering it crashes the process.

let src = readFileSync("src/frontend/app.js", "utf8");
src += `\nglobalThis.__buildListMenu = buildListMenu;\n`;
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
  results.push([ok, name, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`]);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// Menu state for one item: which of the two to-watch tabs are selectable.
const menuState = (item) => {
  const menu = document.createElement("div");
  globalThis.__buildListMenu(menu, item);
  const out = {};
  for (const cb of menu.querySelectorAll("input")) {
    if (cb.dataset.list === "Movies" || cb.dataset.list === "No Di")
      out[cb.dataset.list] = { disabled: !!cb.disabled, title: cb.title || "" };
  }
  return out;
};

const base = { kind: "movie", lists: [], my_rating: null, di_rating: null };

const diana = menuState({ ...base, lists: ["No Di"], di_rating: 88 });
check("Diana-scored movie: Movies blocked", diana.Movies.disabled, true);
check("Diana-scored movie: No Di selectable", diana["No Di"].disabled, false);
check(
  "Diana-scored movie: blocked for the right reason",
  /Diana has already scored/.test(diana.Movies.title),
  true,
);

const james = menuState({ ...base, lists: ["2026"], my_rating: 90, di_rating: 88 });
check("James-scored movie: Movies blocked", james.Movies.disabled, true);
check("James-scored movie: No Di blocked", james["No Di"].disabled, true);

// Being seen blocks *adding* to a to-watch tab, never *removing* from one: a
// scored movie the sync left on No Di has to be checkable so it can be removed.
const stranded = menuState({ ...base, lists: ["No Di"], my_rating: 90, di_rating: 88 });
check("James-scored movie on No Di: No Di can be unchecked", stranded["No Di"].disabled, false);
check("James-scored movie on No Di: Movies still blocked", stranded.Movies.disabled, true);

const strandedDiana = menuState({ ...base, lists: ["Movies"], di_rating: 88 });
check("Diana-scored movie on Movies: Movies can be unchecked", strandedDiana.Movies.disabled, false);

const unscored = menuState({ ...base, lists: ["Movies"] });
check("unscored movie: Movies selectable", unscored.Movies.disabled, false);
check("unscored movie: No Di selectable", unscored["No Di"].disabled, false);

const taste = menuState({ ...base, lists: ["Movies"], taste_score: 71 });
check("taste score alone doesn't block the menu", [taste.Movies.disabled, taste["No Di"].disabled], [false, false]);

const tv = menuState({ kind: "tv", lists: ["Currently Watching"], my_rating: 90, di_rating: 88 });
check("scored show: Movies/No Di untouched by the movie rule", [tv.Movies.disabled, tv["No Di"].disabled], [false, false]);

const pass = results.every(([ok]) => ok);
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
