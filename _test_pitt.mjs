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
src += `\nglobalThis.__currentSeason = currentSeason;\n`;
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

const base = {
  kind: "tv", status: "watching", my_rating: null, di_rating: null, taste_score: null,
  current_season: null, season_dates: {}, season_entries: [], episode_progress: {},
  season_counts: { 1: 15, 2: 15, 3: 0 }, seasons: 3,
};

// 1. The Pitt case: S1 fully watched+dated, S2 untouched -> must WAIT (null), not jump to S2
const pitt = {
  ...base,
  episode_progress: { 1: Array.from({ length: 15 }, (_, i) => i + 1) },
  season_dates: { 1: { started_at: "2026-03-02", finished_at: "2026-10-02" } },
};
check("finished S1 waits (no jump to S2)", globalThis.__currentSeason(pitt), null);

// 2. Fresh untouched show still tracks its first season (start point)
check("fresh show tracks S1", globalThis.__currentSeason({ ...base, season_counts: { 1: 15, 2: 15 }, episode_progress: {} }), 1);

// 3. Partial progress still wins (S1 full, S2 half-watched -> S2)
check("partial S2 progress -> S2", globalThis.__currentSeason({ ...base, season_counts: { 1: 15, 2: 15 }, episode_progress: { 1: Array.from({ length: 15 }, (_, i) => i + 1), 2: [1, 2] } }), 2);

// 4. Explicit current_season still wins
check("explicit current_season -> that season", globalThis.__currentSeason({ ...pitt, current_season: 2 }), 2);

// 5. Started-but-unfinished season via dates still wins
check("started S2 date -> S2", globalThis.__currentSeason({ ...pitt, season_dates: { ...pitt.season_dates, 2: { started_at: "2026-10-02", finished_at: null } } }), 2);

// 6. All complete -> null
check("all done -> null", globalThis.__currentSeason({ ...pitt, season_counts: { 1: 15 }, episode_progress: { 1: Array.from({ length: 15 }, (_, i) => i + 1) } }), null);

// --- server: episodes endpoint ---
const BASE = process.env.TEST_BASE || "http://localhost:3002";
const req = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const all = await req("GET", "/api/items");
const tv = all.find((x) => x.kind === "tv" && Object.keys(x.season_counts || {}).length >= 2 && (x.season_counts["1"] || 0) >= 1);
if (!tv) {
  results.push([false, "find local 2-season TV item", "none found"]);
} else {
  const orig = {
    episode_progress: tv.episode_progress, season_dates: tv.season_dates,
    watched_at: tv.watched_at, ep_started_at: tv.ep_started_at, ep_finished_at: tv.ep_finished_at,
    lists: tv.lists,
  };
  try {
    const full1 = Array.from({ length: tv.season_counts["1"] }, (_, i) => i + 1);
    await req("PATCH", `/api/items/${tv.id}`, {
      episode_progress: { 1: full1 },
      season_dates: { 1: { started_at: "2026-06-01", finished_at: "2026-06-02" } },
    });
    // seasonless inc on a completed season: must NOT roll into season 2
    const after = await req("POST", `/api/items/${tv.id}/episodes`, { op: "inc" });
    check(`no auto-rollover to S2 on "${tv.title}"`, Object.keys(after.episode_progress || {}).includes("2"), false);
    check("no show-level stamps on no-op inc", [after.watched_at, after.ep_finished_at], [orig.watched_at, orig.ep_finished_at]);
    // explicit per-season start still works
    const s2 = await req("POST", `/api/items/${tv.id}/episodes`, { op: "inc", season: 2 });
    check("explicit S2 start works", (s2.episode_progress || {})["2"], [1]);
  } finally {
    await req("PATCH", `/api/items/${tv.id}`, {
      episode_progress: orig.episode_progress,
      season_dates: orig.season_dates,
      watched_at: orig.watched_at,
      ep_started_at: orig.ep_started_at,
      ep_finished_at: orig.ep_finished_at,
    });
    const list = await req("GET", "/api/items");
    const back = list.find((x) => x.id === tv.id);
    if (JSON.stringify(back.lists) !== JSON.stringify(orig.lists)) {
      await req("PUT", `/api/items/${tv.id}/lists`, { lists: orig.lists });
    }
    const final = (await req("GET", "/api/items")).find((x) => x.id === tv.id);
    check("restore", [final.episode_progress, final.season_dates, final.watched_at, JSON.stringify(final.lists) === JSON.stringify(orig.lists)],
          [orig.episode_progress, orig.season_dates, orig.watched_at, true]);
  }
}

let pass = true;
for (const [ok] of results) if (!ok) pass = false;
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
