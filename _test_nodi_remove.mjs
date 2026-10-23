// A movie James has already scored can never be *added* back to the to-watch
// tabs, but it can be taken off one: the card offers "→ 2026" (which is where
// the app files everything he has watched) and the Lists menu lets the No Di
// box be unchecked. This drives both against a stub fetch so the payload the
// server receives is asserted directly.
//
//   bun _test_nodi_remove.mjs
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";

const html = `<!doctype html><html><body>
<main id="list"><div id="cats"></div><div id="tabs"></div>
<div id="tab-search-wrap"><input id="tab-search"/><button id="tab-search-clear"></button><div id="genre-bar"></div></div>
<div id="count"></div><div id="tidy-bar" class="hidden"></div><div id="items"></div><div id="empty"></div>
<div id="slot-view"><div id="dash-mode"></div><div id="night-btn"></div><div id="night-genre"></div><div id="night-result"></div>
<div id="reel-title"></div><div id="reel-year"></div><div id="reel-genre"></div><div id="slot-result"></div><div id="dash-genres"></div></div>
</main><div id="results"></div><div id="back-top"></div></body></html>`;
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
  // Node 24 exposes navigator as a getter-only global.
}
globalThis.location = { pathname: "/", origin: "http://localhost:3002", href: "" };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.addEventListener = () => {};

// Capture every request the module makes; answer list writes with the item we
// asked to change, and the initial /api/items load with an empty list.
const calls = [];
let reply = null;
const fetchStub = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: String(url), method, body });
  const payload = method === "GET" ? [] : reply;
  return { ok: true, json: async () => payload };
};

let src = readFileSync(process.env.APP_MODULE || "src/frontend/app.js", "utf8");
src += `
globalThis.__fileTo2026 = typeof fileTo2026 === "function" ? fileTo2026 : null;
globalThis.__card = card;
globalThis.__buildListMenu = buildListMenu;
globalThis.__updateTidyBar = updateTidyBar;
globalThis.__setTidyState = (l, its) => {
  list = l;
  items = its;
};
`;
const fn = new Function(
  "document", "window", "navigator", "location", "requestAnimationFrame",
  "addEventListener", "performance", "fetch", "setTimeout", "console", src,
);
fn(document, window, globalThis.navigator, globalThis.location,
   globalThis.requestAnimationFrame, globalThis.addEventListener,
   globalThis.performance, fetchStub, setTimeout, console);

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push([ok, name, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`]);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const seen = { id: "x1", kind: "movie", title: "Erin Brockovich", year: 2000, my_rating: 86, di_rating: 86, lists: [] };

// --- 1. the card offers the move off No Di, not a dead "back to Movies" ---
const nodiCard = globalThis.__card({ ...seen, lists: ["No Di"] }, "No Di");
check('seen movie on No Di offers "→ 2026"', /data-move="file-2026"/.test(nodiCard), true);
check('seen movie on No Di has no "↩ Movies"', /↩ Movies/.test(nodiCard), false);

const unseenCard = globalThis.__card({ id: "x2", kind: "movie", title: "Fresh", lists: ["No Di"] }, "No Di");
check('unscored movie keeps "↩ Movies"', /↩ Movies/.test(unseenCard), true);
check('unscored movie has no "→ 2026"', /file-2026/.test(unseenCard), false);

const dianaCard = globalThis.__card({ id: "x3", kind: "movie", title: "Hers", di_rating: 88, lists: ["No Di"] }, "No Di");
check("Diana-only movie still shows the Scored by Di note", /Scored by Di/.test(dianaCard), true);

const moviesCard = globalThis.__card({ ...seen, lists: ["Movies"] }, "Movies");
check("seen movie on Movies offers the same move", /data-move="file-2026"/.test(moviesCard), true);

// --- 2. the Lists menu lets a seen movie be unchecked off No Di ---
const state = (item, list) => {
  const menu = document.createElement("div");
  globalThis.__buildListMenu(menu, item);
  for (const cb of menu.querySelectorAll("input"))
    if (cb.dataset.list === list)
      return { disabled: !!cb.disabled, checked: !!cb.checked, title: cb.title || "" };
  return null;
};
check("seen movie on No Di: box is enabled so it can be removed", state({ ...seen, lists: ["No Di"] }, "No Di").disabled, false);
check("seen movie on No Di: box is checked", state({ ...seen, lists: ["No Di"] }, "No Di").checked, true);
check(
  "seen movie on No Di: tooltip says uncheck to remove",
  /uncheck to take it off/.test(state({ ...seen, lists: ["No Di"] }, "No Di").title),
  true,
);
check("seen movie not on Movies: Movies stays blocked as an add", state({ ...seen, lists: ["No Di"] }, "Movies").disabled, true);
check("seen movie on Movies: its own box is enabled", state({ ...seen, lists: ["Movies"] }, "Movies").disabled, false);

// --- 3. the PUT the site sends ---
const put = () => calls.filter((c) => c.method === "PUT" && /\/lists$/.test(c.url)).pop();

// Missing on an older app.js: report it as a failed check, not a crash.
if (!globalThis.__fileTo2026) {
  check("fileTo2026 exists", false, true);
} else {
  reply = { ...seen, lists: ["2026"] };
  await globalThis.__fileTo2026({ ...seen, lists: ["No Di"] });
  check("No Di only: PUT moves it to 2026 (not a delete)", put()?.body?.lists, ["2026"]);

  reply = { ...seen, lists: ["2026"] };
  await globalThis.__fileTo2026({ ...seen, lists: ["No Di", "2026"] });
  check("already on 2026: payload carries it once", put()?.body?.lists, ["2026"]);

  reply = { ...seen, lists: ["2026", "Taste Movies"] };
  await globalThis.__fileTo2026({ ...seen, lists: ["No Di", "Taste Movies"] });
  check("other lists survive the move", put()?.body?.lists, ["2026", "Taste Movies"]);
}

// --- 4. the tab-level sweep bar ---
const bar = document.getElementById("tidy-bar");
globalThis.__setTidyState("No Di", [
  { ...seen, id: "a", lists: ["No Di"] },
  { id: "b", kind: "movie", title: "Fresh", lists: ["No Di"] },
]);
globalThis.__updateTidyBar();
check(
  "tidy bar counts only the seen ones",
  /<span>1 title here is already scored/.test(bar.innerHTML),
  true,
);
check("tidy bar offers the move", /Move 1 to 2026/.test(bar.innerHTML), true);
check("tidy bar is visible on No Di", bar.classList.contains("hidden"), false);

globalThis.__setTidyState("2026", [{ ...seen, lists: ["2026"] }]);
globalThis.__updateTidyBar();
check("no tidy bar on a watched tab", bar.classList.contains("hidden"), true);
check("tidy bar cleared", bar.innerHTML, "");

globalThis.__setTidyState("No Di", [{ ...seen, id: "a", lists: ["No Di"] }]);
globalThis.__updateTidyBar();
calls.length = 0;
reply = { moved: 1, items: [] };
bar.querySelector(".tidy-btn").click();
for (let i = 0; i < 20 && !calls.some((c) => /tidy-watched$/.test(c.url)); i++)
  await new Promise((r) => setTimeout(r, 0));
const sweep = calls.filter((c) => c.method === "POST" && /tidy-watched$/.test(c.url));
check("sweep button posts to /api/tidy-watched", sweep.length, 1);
check("sweep sends no body to override the server's rule", sweep[0]?.body, null);

const pass = results.every(([ok]) => ok);
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
