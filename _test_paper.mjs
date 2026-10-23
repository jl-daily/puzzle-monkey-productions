// Regression: a show whose watched_at is from a PREVIOUS year must refresh it
// (preserving the old date on first_watched_at) when its last known season
// completes, so it can transfer to Shows 2026. Same-year dates must NOT churn.
//
// Run with the app on :3002 in the SAME command (see repo notes).
const BASE = process.env.TEST_BASE || "http://localhost:3002";
// Mirrors src/constants.ts today() — LOCAL date, not the UTC one.
const _d = new Date();
const todayISO = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

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
// A TV show with at least two known seasons, the last one having episodes.
const tv = all.find(
  (x) =>
    x.kind === "tv" &&
    x.season_counts &&
    Object.keys(x.season_counts).length >= 2 &&
    Object.values(x.season_counts).some((c) => c > 0),
);
if (!tv) {
  console.log("FAIL | no suitable 2-season TV item in local DB");
  process.exit(1);
}
const last = Math.max(...Object.keys(tv.season_counts).map(Number));
const count = tv.season_counts[last];
console.log(`# using "${tv.title}" (id ${tv.id}), last season ${last} x ${count}`);

const orig = {
  episode_progress: tv.episode_progress,
  season_dates: tv.season_dates,
  season_counts: tv.season_counts,
  watched_at: tv.watched_at,
  first_watched_at: tv.first_watched_at,
  ep_started_at: tv.ep_started_at,
  ep_finished_at: tv.ep_finished_at,
  lists: tv.lists,
};

const restore = async () => {
  await req("PATCH", `/api/items/${tv.id}`, {
    episode_progress: orig.episode_progress,
    season_dates: orig.season_dates,
    season_counts: orig.season_counts,
    watched_at: orig.watched_at,
    first_watched_at: orig.first_watched_at,
    ep_started_at: orig.ep_started_at,
    ep_finished_at: orig.ep_finished_at,
  });
  await req("PUT", `/api/items/${tv.id}/lists`, { lists: orig.lists });
  const back = (await req("GET", "/api/items")).find((x) => x.id === tv.id);
  check(
    "restore",
    [
      back.watched_at,
      back.first_watched_at,
      back.episode_progress,
      JSON.stringify(back.lists) === JSON.stringify(orig.lists),
    ],
    [orig.watched_at, orig.first_watched_at, orig.episode_progress, true],
  );
};

try {
  // --- scenario 1: stale prior-year watched_at -> refresh + transfer ---
  await req("PATCH", `/api/items/${tv.id}`, {
    episode_progress: {},
    season_dates: {},
    watched_at: "2025-03-11",
    first_watched_at: null,
    ep_started_at: null,
    ep_finished_at: null,
  });
  await req("PUT", `/api/items/${tv.id}/lists`, { lists: ["Currently Watching"] });

  for (let i = 0; i < count; i++)
    await req("POST", `/api/items/${tv.id}/episodes`, { op: "inc", season: last });

  const a = (await req("GET", "/api/items")).find((x) => x.id === tv.id);
  check("stale watched_at refreshed to today", a.watched_at, todayISO);
  check("old date preserved on first_watched_at", a.first_watched_at, "2025-03-11");
  check("moved off Currently Watching", (a.lists || []).includes("Currently Watching"), false);
  check("filed onto Shows 2026", (a.lists || []).includes("Shows 2026"), true);

  // --- scenario 2: same-year watched_at must not churn ---
  await req("PATCH", `/api/items/${tv.id}`, {
    watched_at: "2026-05-01",
    first_watched_at: null,
  });
  await req("POST", `/api/items/${tv.id}/episodes`, { op: "dec", season: last });
  await req("POST", `/api/items/${tv.id}/episodes`, { op: "inc", season: last });
  const b = (await req("GET", "/api/items")).find((x) => x.id === tv.id);
  check("same-year watched_at untouched", b.watched_at, "2026-05-01");
  check("same-year first_watched_at untouched", b.first_watched_at, null);
} finally {
  await restore();
}

const pass = results.every(Boolean);
console.log(pass ? "ALL_PASS" : "SOME_FAILED");
process.exit(pass ? 0 : 1);
