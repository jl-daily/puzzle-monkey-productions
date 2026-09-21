import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
const html = `<!doctype html><html><body>
<header id="top"><input id="search-input"/><button id="search-btn"></button>
<button id="notes-btn"></button><button id="taste-btn"></button><div id="kind-toggle"></div></header>
<div id="results"></div><div id="taste-modal"><pre id="taste-code"></pre><button id="taste-close"></button><button id="taste-copy"></button></div>
<main id="list"><div id="cats"></div><div id="tabs"></div>
<div id="tab-search-wrap"><input id="tab-search"/><button id="tab-search-clear"></button><div id="genre-bar"></div></div>
<div id="count"></div>
<div id="slot-view"><div id="dash-mode"></div><div id="night-btn"></div><div id="night-genre"></div>
<div id="night-result"></div><div id="reel-title"></div><div id="reel-year"></div>
<div id="reel-genre"></div><div id="slot-result"></div><div id="dash-genres"></div></div>
<div id="items"></div><div id="empty"></div></main>
<button id="back-top"></button></body></html>`;
const { document, window } = parseHTML(html);
globalThis.document = document;
globalThis.window = window;
// Stub any element id that the harness HTML doesn't include so app.js init
// (top-level addEventListener bindings) doesn't throw on null.
function makeStub(id) {
  const cls = new Set();
  const el = {
    id,
    dataset: {},
    style: {},
    value: "",
    disabled: false,
    textContent: "",
    innerHTML: "",
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, f) =>
        f === undefined
          ? cls.has(c)
            ? cls.delete(c)
            : cls.add(c)
          : f
            ? cls.add(c)
            : cls.delete(c),
      contains: (c) => cls.has(c),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    scrollIntoView: () => {},
  };
  return el;
}
const __origGet = document.getElementById.bind(document);
document.getElementById = (id) => __origGet(id) || makeStub(id);
try {
  globalThis.navigator = { clipboard: { writeText: async () => {} } };
} catch {}
globalThis.location = {
  pathname: "/",
  origin: "http://localhost:3002",
  href: "",
};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.addEventListener = () => {};
globalThis.performance = { now: () => Date.now() };
let src = readFileSync(
  "/Users/jamesdaily/movie-app/src/frontend/app.js",
  "utf8",
);
src += `\nglobalThis.__render = render;
globalThis.__setList = (l) => { list = l; };
globalThis.__setItems = (arr) => { items = arr; };
globalThis.__setQuery = (q) => { tabQuery = q; };
globalThis.__card = card;
globalThis.__state = () => ({ list, itemsLen: items.length, genreSel });
`;
const fn = new Function(
  "document",
  "window",
  "navigator",
  "location",
  "requestAnimationFrame",
  "addEventListener",
  "performance",
  "fetch",
  "setTimeout",
  "console",
  src,
);
fn(
  document,
  window,
  globalThis.navigator,
  globalThis.location,
  globalThis.requestAnimationFrame,
  globalThis.addEventListener,
  globalThis.performance,
  fetch,
  setTimeout,
  console,
);

const all = await (await fetch("http://localhost:3002/api/items")).json();

// Test 1: Pop Culture Jeopardy pinned visible on Currently Watching
const pcj = all.find((x) => x.title === "Pop Culture Jeopardy!");
globalThis.__setItems([pcj]);
globalThis.__setQuery("");
globalThis.__setList("Currently Watching");
globalThis.__render();
const itemsEl = document.getElementById("items");
const pcjCards = itemsEl.querySelectorAll(`[data-id="${pcj.id}"]`);
const inDiana = !!(
  itemsEl.querySelector(".diana-block") &&
  itemsEl.querySelector(`.diana-block [data-id="${pcj.id}"]`)
);
console.log(
  "[1] Pop Culture Jeopardy on Currently Watching -> cards:",
  pcjCards.length,
  "| in diana-block:",
  inDiana,
  "| pinned:",
  pcj.pinned,
);

// Test 2: next-season button on a completed season with a following season
const multi = {
  id: "test-next",
  tmdb_id: 1,
  kind: "tv",
  title: "Next Season Test",
  year: "2024",
  rating: null,
  taste_score: null,
  genres: null,
  overview: "x",
  poster: null,
  status: "watching",
  my_rating: null,
  di_rating: null,
  reference: null,
  rated_at: null,
  watched_at: null,
  providers: [],
  seasons: 2,
  episodes: 20,
  review: null,
  season_entries: [
    {
      season: 1,
      tab: "Shows Watched",
      my_rating: null,
      di_rating: null,
      watched_at: null,
      rewatch: false,
      pinned: 0,
    },
  ],
  episode_progress: { 1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2: [] },
  season_counts: { 1: 10, 2: 10 },
  season_dates: {},
  theater: false,
  rewatch: false,
  rewatched_at: null,
  current_season: 1,
  pinned: 0,
  lists: ["Shows Watched"],
  list_dates: {},
  positions: {},
  flags: {},
  created_at: "2024-01-01",
};
globalThis.__setItems([multi]);
globalThis.__setList("Shows Watched");
globalThis.__render();
const m = document.getElementById("items");
const btn = m.querySelector(".next-season-btn");
console.log(
  "[2] Next-season button present for completed S1:",
  !!btn,
  btn ? "-> " + btn.dataset.next : "",
);

// Test 3: no next button when season not complete
const multi2 = {
  ...multi,
  id: "test-next2",
  episode_progress: { 1: [1, 2], 2: [] },
  season_counts: { 1: 10, 2: 10 },
};
globalThis.__setItems([multi2]);
globalThis.__render();
const m2 = document.getElementById("items");
console.log(
  "[3] Next-season button absent when S1 incomplete:",
  !m2.querySelector(".next-season-btn"),
);

// Test 4: no next button on last season
const multi3 = {
  ...multi,
  id: "test-next3",
  seasons: 1,
  season_counts: { 1: 10 },
  episode_progress: { 1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  season_entries: [],
};
globalThis.__setItems([multi3]);
globalThis.__render();
const m3 = document.getElementById("items");
console.log(
  "[4] Next-season button absent on last season:",
  !m3.querySelector(".next-season-btn"),
);

// Test 5: real TV show House on Shows Archive (moved here as finished)
const house = all.find((x) => x.id === "c2b837c3-9b8e-45a1-a78b-5bd979e82388");
console.log("[5] House found in API:", !!house, "| lists:", house?.lists);
globalThis.__setItems([house]);
globalThis.__setQuery("");
globalThis.__setList("Shows Archive");
try {
  globalThis.__render();
  const h = document.getElementById("items");
  const cardEl = h.querySelector(`[data-id="${house.id}"]`);
  console.log(
    "[5] House card rendered:",
    !!cardEl,
    "| cards in #items:",
    h.querySelectorAll(".card").length,
    "| itemsEl html length:",
    h.innerHTML.length,
  );
  if (!cardEl) console.log("[5] RAW #items HTML:", h.innerHTML.slice(0, 500));
} catch (e) {
  console.log("[5] RENDER THREW for House:", e && e.stack ? e.stack : e);
}
console.log("[5b] state:", JSON.stringify(globalThis.__state()));
try {
  const node = globalThis.__card(house, "Shows Watched", false);
  console.log(
    "[5b] card() direct -> node:",
    !!node,
    node ? "html len " + (node.outerHTML ? node.outerHTML.length : "?") : "",
  );
  if (node)
    console.log("[5b] card HTML head:", String(node.outerHTML).slice(0, 300));
} catch (e) {
  console.log("[5b] card() THREW:", e && e.stack ? e.stack : e);
}

// Test 6: render ALL items on Shows Watched (catch any other invisible/throw)
globalThis.__setItems(all);
globalThis.__setQuery("");
globalThis.__setList("Shows Watched");
try {
  globalThis.__render();
  const h = document.getElementById("items");
  const cards = h.querySelectorAll(".card");
  const fragOnly = h.querySelectorAll("div > div.season");
  console.log(
    "[6] All Shows Watched -> top-level .card count:",
    cards.length,
    "| season sub-cards:",
    h.querySelectorAll(".season-card, .season").length,
    "| #items html len:",
    h.innerHTML.length,
  );
  const doneTv = all.filter(
    (x) =>
      x.kind === "tv" &&
      x.status === "done" &&
      (x.lists || []).includes("Shows Watched") &&
      (x.pinned || 0) < 1,
  );
  console.log(
    "[6] done+unpinned TV on Shows Watched (was-invisible class):",
    doneTv.length,
    "->",
    doneTv.map((x) => x.title).join(", "),
  );
} catch (e) {
  console.log("[6] RENDER ALL THREW:", e && e.stack ? e.stack : e);
}

// Test 7: House must NOT appear on Currently Watching (finished -> archived)
globalThis.__setItems(all);
globalThis.__setQuery("");
globalThis.__setList("Currently Watching");
try {
  globalThis.__render();
  const h = document.getElementById("items");
  const houseCard = h.querySelector(`[data-id="${house.id}"]`);
  const doneOnTab = all.filter(
    (x) =>
      x.kind === "tv" &&
      x.status === "done" &&
      (x.lists || []).includes("Currently Watching"),
  );
  console.log(
    "[7] House on Currently Watching:",
    !!houseCard,
    "| done shows on Currently Watching:",
    doneOnTab.length,
  );
} catch (e) {
  console.log("[7] RENDER THREW:", e && e.stack ? e.stack : e);
}
