import type { Context, Hono } from "hono";
import {
  listItems,
  getItem,
  getItemById,
  createItem,
  updateItem,
  deleteItem,
  setItemLists,
  setListPosition,
  setListFlag,
  setListAddedAt,
  topPosition,
} from "./db";
import type { Item } from "./db";
import { watchProviders } from "./providers";
import { normTitle, tasteUrl } from "./taste";
import {
  TABS,
  today,
  PRIMARY_SET,
  collapsePrimaries,
  kindForList,
  isShowList,
} from "./constants";
import {
  pushSheet,
  removeCmd,
  pushScore,
  pullTaste,
  episodeSummary,
} from "./sheet";
import { transferToShows2026 } from "./archive";
import { tmdb, detailFrom, directorFrom, runtimeFrom, IMG } from "./tmdb";

function internal(c: { req: { header: (k: string) => string | undefined } }) {
  return c.req.header("x-internal") === "1";
}

// Is this request the spreadsheet reconciling itself against the app? doSync
// pushes a whole tab's worth of list membership in one go, and it infers
// "deleted from the sheet" from a row it can't find. Its fetch helper already
// sends x-internal (the same marker the app's own scripts use), and it runs on
// Google's servers, so either the marker or the user agent identifies it. The
// browser UI sends neither, which is what lets the guards below protect the
// app's tracking without getting in the way of a list change made by hand.
function isSyncClient(c: { req: { header: (k: string) => string | undefined } }) {
  if (internal(c)) return true;
  if (c.req.header("x-sheet-sync") === "1") return true;
  return /Google-Apps-Script/i.test(c.req.header("user-agent") || "");
}

// Is the app in the middle of watching this show? A show with episodes ticked
// off, a season in progress or a current season set is being tracked right
// now. Once it's finished (the app stamps watched_at / ep_finished_at when the
// last known season completes) it is no longer "in progress" and the normal
// sheet rules apply again.
function activelyTracked(it: Item): boolean {
  if (it.kind !== "tv") return false;
  if (it.watched_at || it.ep_finished_at) return false;
  return (
    it.ep_started_at != null ||
    it.current_season != null ||
    Object.values(it.episode_progress || {}).some(
      (arr) => (arr || []).length > 0,
    )
  );
}

// Year + kind are what tell two items sharing a title apart (the 2026 show
// "Carrie" vs the 2002 TV movie). Prefer the closest match, and never fall
// through to a title-only match when the caller gave us something better.
function pickByTitle(
  candidates: Item[],
  year: string | null,
  kind: string,
): Item | null {
  if (!candidates.length) return null;
  const sameYear = (it: Item) =>
    year == null || String(it.year || "").trim() === year;
  return (
    candidates.find((it) => it.kind === kind && sameYear(it)) ??
    candidates.find((it) => it.kind === kind) ??
    candidates.find(sameYear) ??
    candidates[0]
  );
}

// The sheet's recovery route has to answer with something the spreadsheet can
// use: when a row names a work we can't mint, attaching it to the closest
// same-title item keeps the sheet resolvable instead of leaving a row that 404s
// on every sync. It never creates anything, so a stale year in the sheet cannot
// add a second item for one title.
function attachClosest(
  c: Context,
  named: Item[],
  title: string,
  year: string | null,
  kind: string,
  list: string,
) {
  const fallback = pickByTitle(named, year, kind);
  if (!fallback) return c.json({ error: "not found" }, 404);
  console.warn(
    `by-title "${title}" year=${year}: attaching to ${fallback.kind} ${fallback.year} (${fallback.id})`,
  );
  if (list && list !== TABS.SPIN && !blockedFromList(fallback, list))
    setItemLists(fallback.id, [
      list,
      ...fallback.lists.filter((l) => l !== list),
    ]);
  return c.json({ ...getItemById(fallback.id)!, existed: true });
}

const TO_WATCH: Set<string> = new Set([TABS.MOVIES, TABS.NO_DI]);

// Diana's score means she has seen the movie; James's means he has. A movie
// only Diana has scored is no longer a pick to watch together: it belongs on
// "No Di" (he can still watch it solo), never on "Movies".
function seenByJames(it: Item): boolean {
  return it.kind === "movie" && it.my_rating != null;
}

function seenByDianaOnly(it: Item): boolean {
  return it.kind === "movie" && it.my_rating == null && it.di_rating != null;
}

// Lists a title sits on *before* it has been watched: the to-watch picks
// (Movies / No Di / spin), the shows queued up to start, and a show in
// progress. Every other list — the year tabs, the archives, the taste.io
// library, the rewatch queue — only ever holds titles James has already seen.
const TO_WATCH_LISTS: Set<string> = new Set([
  TABS.MOVIES,
  TABS.NO_DI,
  TABS.CURRENTLY_WATCHING,
  TABS.SPIN,
  "Shows",
  "Shows w/o Di",
]);

// Has James watched this title before? A previous viewing shows up as a watch
// date, an explicit rewatch mark, or membership of a list that only holds
// watched titles. A title parked on a to-watch list has not been seen yet.
function seenBefore(it: Item): boolean {
  if (it.watched_at || it.first_watched_at || it.rewatched_at || it.rewatch)
    return true;
  return it.lists.some((l) => !TO_WATCH_LISTS.has(l));
}

// Would putting this movie on `list` break the rules above?
function blockedFromList(it: Item, list: string): boolean {
  if (seenByJames(it)) return TO_WATCH.has(list);
  return seenByDianaOnly(it) && list === TABS.MOVIES;
}

// Sheet "add" payload for the No Di tab. A Diana-only score lands a movie
// there, and doSync treats sheet tabs as the source of truth for list
// membership, so the spreadsheet has to see the move or it would put the movie
// back on Movies on the next sync.
function noDiSheetAdd(it: Item) {
  return {
    op: "add",
    tab: TABS.NO_DI,
    title: it.title,
    year: it.year,
    kind: it.kind,
    status: it.status,
    genres: it.genres,
    taste_score: it.taste_score,
    j: it.my_rating,
    d: it.di_rating,
    date: it.watched_at,
  };
}

// Move a movie Diana scored off "Movies" onto "No Di" and pin it to the top
// of that tab so the jump is easy to spot. watched_at stays empty — only Diana
// has seen it, so it must not read as watched-in-2026. No-op when not on Movies.
function moveToNoDi(it: Item): Item | null {
  if (!it.lists.includes(TABS.MOVIES)) return null;
  const moved = setItemLists(it.id, [
    TABS.NO_DI,
    ...it.lists.filter((l) => !TO_WATCH.has(l) && !PRIMARY_SET.has(l)),
  ]);
  if (!moved) return null;
  setListPosition(moved.id, TABS.NO_DI, topPosition(TABS.NO_DI));
  // Add before remove: the sheet gateway is slow (tens of seconds per call), and
  // doSync treats a title that appears on NO tab as deleted. Removing first
  // leaves exactly that gap — a sync landing in it deleted a real movie once.
  // Landing on two tabs for a moment is harmless by comparison: the next sync
  // just sees the move and settles on the destination.
  void pushSheet(noDiSheetAdd(moved));
  void pushSheet(removeCmd(it, TABS.MOVIES));
  return getItemById(moved.id) ?? moved;
}

// Keep the to-watch tabs honest on every write path. A movie James has seen
// (his own score) doesn't belong on a to-watch list at all — the score flow
// files it to the 2026 tab, and this is the backstop for all other paths. One
// that only Diana has scored relocates to "No Di" instead of vanishing off the
// watchlist entirely.
function stripScored(it: Item): Item | null {
  if (!seenByJames(it) && !seenByDianaOnly(it)) return it;
  if (!seenByJames(it)) {
    return it.lists.includes(TABS.MOVIES) ? (moveToNoDi(it) ?? it) : it;
  }
  const kept = it.lists.filter((l) => !TO_WATCH.has(l));
  return kept.length === it.lists.length ? it : setItemLists(it.id, kept);
}

const SHOWS_2026 = "Shows 2026";

function finished2026(it: Item): boolean {
  return !!(it.watched_at && String(it.watched_at).startsWith("2026"));
}

// When a TV show is finished in 2026, make sure it also appears on the "Shows
// 2026" (the "2026") sheet tab. Additive: it never drops Currently Watching, so
// a still-in-progress 2026 show can sit on both. transferToShows2026 handles
// the actual move off Currently Watching when the show completes.
function ensureShows2026(it: Item): Item {
  if (it.kind !== "tv" || !finished2026(it) || it.lists.includes(SHOWS_2026))
    return it;
  const updated = setItemLists(it.id, [
    SHOWS_2026,
    ...it.lists.filter((l) => l !== SHOWS_2026),
  ]);
  if (!updated) return it;
  setListPosition(updated.id, SHOWS_2026, topPosition(SHOWS_2026));
  void pushSheet({
    op: "add",
    tab: TABS.SHOWS_2026,
    title: updated.title,
    year: updated.year,
    kind: updated.kind,
    status: updated.status,
    genres: updated.genres,
    taste_score: updated.taste_score,
    j: updated.my_rating,
    d: updated.di_rating,
    date: updated.watched_at,
  });
  if (updated.review)
    void pushSheet({
      op: "setReview",
      tab: TABS.SHOWS_2026,
      title: updated.title,
      review: updated.review,
    });
  return updated;
}

async function createFromTmdb(
  tmdbId: number,
  kind: string,
): Promise<Item | null> {
  try {
    const d = await tmdb(`/${kind}/${tmdbId}`);
    const info = detailFrom(d, kind);
    const providers = await watchProviders(kind, tmdbId);
    const director = await directorFrom(kind, tmdbId, d);
    const counts: Record<string, number> = {};
    if (kind === "tv")
      for (const sn of d.seasons || [])
        if (sn.season_number > 0) counts[sn.season_number] = sn.episode_count;
    const created = createItem({
      tmdb_id: tmdbId,
      kind: kind === "tv" ? "tv" : "movie",
      title: info.title,
      year: info.year,
      taste_score: null,
      genres: info.genres,
      overview: info.overview,
      poster: info.poster,
      providers,
      runtime: info.runtime,
      director,
      reference: null,
      flags: {},
      list_dates: {},
      seasons: info.seasons.length ? info.seasons.length : null,
      episodes: info.seasons.length
        ? info.seasons.reduce((n, s) => n + s.episode_count, 0)
        : null,
      lists: [],
    });
    if (!created) return null;
    if (kind === "tv" && Object.keys(counts).length)
      return (
        updateItem(created.id, {
          season_counts: counts,
          seasons: Object.keys(counts).length,
          episodes: Object.values(counts).reduce((n, e) => n + e, 0),
        }) ?? created
      );
    return created;
  } catch {
    return null;
  }
}

// Seed a show at the season the user is on: set current_season, stamp that
// season's start date, and mark it watching. If the chosen season isn't in the
// cached counts (e.g. a freshly released season), refresh counts from TMDB
// first so the tracker actually shows it.
async function startSeason(it: Item, season: number): Promise<Item> {
  if (it.kind !== "tv") return it;
  let cur = it;
  if (cur.season_counts == null || cur.season_counts[season] == null) {
    try {
      const d = await tmdb(`/tv/${cur.tmdb_id}`);
      const c: Record<string, number> = {};
      for (const sn of d.seasons || [])
        if (sn.season_number > 0) c[sn.season_number] = sn.episode_count;
      const u = updateItem(cur.id, {
        season_counts: c,
        seasons: Object.keys(c).length || null,
        episodes: Object.values(c).reduce((n, e) => n + e, 0) || null,
      });
      if (u) cur = u;
    } catch {}
  }
  const dates = { ...(cur.season_dates || {}) };
  if (!dates[season])
    dates[season] = { started_at: today(), finished_at: null };
  let counts = cur.season_counts;
  let seasons: number | null = cur.seasons;
  let episodes: number | null = cur.episodes;
  if (season !== 1 && counts && counts[season] != null) {
    const filtered: Record<string, number> = {};
    filtered[season] = counts[season];
    counts = filtered;
    seasons = 1;
    episodes = counts[season];
  }
  const u2 = updateItem(cur.id, {
    current_season: season,
    season_dates: dates,
    season_counts: counts,
    seasons,
    episodes,
    status: cur.status === "done" ? cur.status : "watching",
  });
  return u2 ?? cur;
}

function attach(it: Item, list: string): Item {
  if (list && list !== TABS.SPIN) {
    if (list === TABS.WATCH_2026 && !it.watched_at) {
      const stamped = updateItem(it.id, { watched_at: today() });
      if (stamped) it = stamped;
    }
    if (blockedFromList(it, list)) return it;
    if (!it.lists.includes(list)) {
      const target = collapsePrimaries([
        list,
        ...it.lists.filter((l) => l !== list),
      ]);
      const dropped = it.lists.filter(
        (l) => PRIMARY_SET.has(l) && !target.includes(l),
      );
      const updated = setItemLists(it.id, target);
      if (updated) {
        if (list !== TABS.SPIN)
          void setListPosition(updated.id, list, topPosition(list));
        // Destination row first, source rows second (see moveToNoDi): the sheet
        // gateway is slow, and doSync reads a title that appears on no tab as
        // deleted. A row briefly on two tabs is self-correcting; a gap is not.
        void pushSheet({
          op: "add",
          tab: list,
          title: updated.title,
          year: updated.year,
          kind: updated.kind,
          status: updated.status,
          genres: updated.genres,
          taste_score: updated.taste_score,
          j: updated.my_rating,
          d: updated.di_rating,
          date: updated.watched_at,
        });
        for (const d of dropped) void pushSheet(removeCmd(it, d));
        if (updated.taste_score == null) pullTaste(updated);
        return updated;
      }
    } else if (it.taste_score == null) {
      pullTaste(it);
    }
  }
  return it;
}

const PATCH_FIELDS = [
  "status",
  "my_rating",
  "di_rating",
  "taste_score",
  "reference",
  "watched_at",
  "first_watched_at",
  "watch_count",
  "review",
  "di_review",
  "providers",
  "seasons",
  "episodes",
  "season_entries",
  "episode_progress",
  "ep_started_at",
  "ep_finished_at",
  "season_counts",
  "season_dates",
  "theater",
  "rewatch",
  "rewatched_at",
  "current_season",
  "pinned",
  "di_confirmed",
  "title",
  "year",
  "poster",
  "overview",
  "kind",
  "tmdb_id",
] as const;

export function registerItems(app: Hono) {
  app.get("/api/items", (c) => c.json(listItems()));

  app.get("/api/search", async (c) => {
    const q = c.req.query("q") || "";
    const kind = c.req.query("kind") === "tv" ? "tv" : "movie";
    if (!q) return c.json({ results: [] });
    try {
      const d = await tmdb(`/search/${kind}?query=${encodeURIComponent(q)}`);
      return c.json({
        results: (d.results || [])
          .filter((r) => r.id != null)
          .map((r) => ({
            tmdb_id: r.id,
            kind,
            title: (kind === "tv" ? r.name : r.title) || "",
            year:
              ((kind === "tv" ? r.first_air_date : r.release_date) || "").slice(
                0,
                4,
              ) || null,
            poster: r.poster_path ? IMG + r.poster_path : null,
            genres: "",
            overview: r.overview || null,
            seasons:
              kind === "tv"
                ? (r.seasons || [])
                    .filter((s) => s.season_number > 0)
                    .map((s) => ({
                      season: s.season_number,
                      episodes: s.episode_count,
                    }))
                : [],
          })),
      });
    } catch {
      return c.json({ results: [] });
    }
  });

  // Seasons for a show, so the add flow can let the user pick the season
  // they're on. Pulled from TMDB detail (search results omit seasons).
  app.get("/api/seasons", async (c) => {
    const tmdbId = Number(c.req.query("tmdb_id"));
    const kind = c.req.query("kind") === "tv" ? "tv" : "movie";
    if (!Number.isFinite(tmdbId) || tmdbId <= 0)
      return c.json({ error: "tmdb_id required" }, 400);
    try {
      const d = await tmdb(`/${kind}/${tmdbId}`);
      const seasons = (d.seasons || [])
        .filter((s) => s.season_number > 0)
        .map((s) => ({ season: s.season_number, episodes: s.episode_count }));
      return c.json({ seasons });
    } catch {
      return c.json({ seasons: [] });
    }
  });

  // Search the user's own journal notes: item reviews, reference notes, and
  // per-season reviews. Returns raw snippets; the frontend highlights the match.
  app.get("/api/notes", (c) => {
    const q = (c.req.query("q") || "").trim().toLowerCase();
    if (!q) return c.json({ results: [] });
    const out: {
      id: string;
      title: string;
      year: string | null;
      kind: string;
      hits: { where: string; snippet: string }[];
      rec: string;
    }[] = [];
    const snip = (text: string) => {
      const low = text.toLowerCase();
      const i = low.indexOf(q);
      if (i < 0) return text.slice(0, 120);
      const a = Math.max(0, i - 45);
      const b = Math.min(text.length, i + q.length + 45);
      return (
        (a > 0 ? "…" : "") + text.slice(a, b) + (b < text.length ? "…" : "")
      );
    };
    const recency = (it: Item) =>
      it.watched_at || it.ep_finished_at || it.created_at || "";
    for (const it of listItems()) {
      const hits: { where: string; snippet: string }[] = [];
      const hit = (where: string, text: string | null | undefined) => {
        if (text && String(text).toLowerCase().includes(q))
          hits.push({ where, snippet: snip(String(text)) });
      };
      hit("Review", it.review);
      hit("Reference", it.reference);
      for (const e of it.season_entries) {
        hit(`Season ${e.season}`, e.review);
        hit(`Season ${e.season}`, e.reference);
      }
      if (!hits.length) continue;
      out.push({
        id: it.id,
        title: it.title,
        year: it.year,
        kind: it.kind,
        hits,
        rec: recency(it),
      });
    }
    out.sort((a, b) => b.rec.localeCompare(a.rec));
    return c.json({
      results: out.slice(0, 200).map(({ rec: _rec, ...rest }) => rest),
    });
  });

  app.post("/api/items", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const tmdbId = Number(body.tmdb_id);
    const kind = body.kind === "tv" ? "tv" : "movie";
    const list = typeof body.list === "string" ? body.list : "";
    const season = Number(body.season);
    const seasonOk = Number.isFinite(season) && season >= 1;
    if (!Number.isFinite(tmdbId) || tmdbId <= 0)
      return c.json({ error: "tmdb_id and kind required" }, 400);
    const existing = getItem(tmdbId, kind);
    if (existing) {
      const ready =
        seasonOk && existing.kind === "tv"
          ? await startSeason(existing, season)
          : existing;
      // A re-add is only a rewatch when James has actually seen the title
      // before. Re-adding something that was merely parked on a to-watch list
      // (No Di, Movies, spin) is a move: it must not pick up a rewatch mark or
      // a watch date, either of which would claim a viewing that never
      // happened.
      const seen = seenBefore(ready);
      if (seen && !ready.rewatch) {
        const stamped = updateItem(ready.id, {
          rewatch: true,
          rewatched_at: ready.rewatched_at || today(),
          watch_count: Math.max(2, ready.watch_count || 0),
        });
        if (stamped) {
          Object.assign(ready, stamped);
          if (stamped.kind === "movie" && list)
            void pushSheet({
              op: "markRewatch",
              tab: list,
              title: stamped.title,
              mark: true,
            });
        }
        // A rewatched movie is a fresh viewing: refresh watched_at so the
        // rewatch add lands on top of the 2026 tab (sorted watched_at DESC).
        // The date is mirrored to the sheet because doSync pulls watched
        // dates back sheet -> app and would otherwise revert it. Only an add
        // to the year tab means "I just watched this" — adding a title to a
        // to-watch list is a plan, so it keeps whatever date it already had
        // (and none, if it was never watched).
        if (
          seen &&
          ready.kind === "movie" &&
          list === TABS.WATCH_2026 &&
          ready.watched_at !== today()
        ) {
          const w = updateItem(ready.id, {
            // Keep the pre-rewatch viewing date so the card can show both:
            // watched_at moves to today (drives the 2026 sort), the original
            // is preserved in first_watched_at.
            ...(ready.first_watched_at == null && ready.watched_at
              ? { first_watched_at: ready.watched_at }
              : {}),
            watched_at: today(),
          });
          if (w) {
            Object.assign(ready, w);
            void pushSheet({
              op: "watched",
              title: w.title,
              year: w.year,
              kind: w.kind,
              date: w.watched_at,
            });
          }
        }
      }
      return c.json(attach(ready, list));
    }
    const item = await createFromTmdb(tmdbId, kind);
    if (!item) return c.json({ error: "couldn't load from TMDB" }, 502);
    const ready =
      seasonOk && item.kind === "tv" ? await startSeason(item, season) : item;
    return c.json(attach(ready, list));
  });

  app.post("/api/items/by-title", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const title = String(body.title || "").trim();
    const list = typeof body.list === "string" ? body.list : "";
    const year =
      body.year != null && String(body.year).trim()
        ? String(body.year).trim()
        : null;
    // The caller (the sheet) may not say whether the row is a show or a movie,
    // but the tab it sits on does: a row on "Currently Watching"/"Shows …" is a
    // show. Defaulting to "movie" here is what turned a deleted show back into
    // a movie of the same name.
    const kind =
      body.kind === "tv" || body.kind === "movie"
        ? body.kind
        : (kindForList(list) ?? "movie");
    if (!title) return c.json({ error: "title required" }, 400);
    const named = listItems().filter(
      (it) => normTitle(it.title) === normTitle(title),
    );
    // A row that names a different year is a hint that it is the *other* work
    // (the 2026 series and the 2002 TV movie both called "Carrie"), never a
    // reason to drop the only candidate: the sheet's Year column is not always
    // the release year (the year tabs often hold the year a movie was watched),
    // and an item left with no row anywhere is what the reconcile deletes.
    const sameWork = named.filter(
      (it) => year == null || it.year == null || String(it.year).trim() === year,
    );
    const sameKind = named.filter((it) => it.kind === kind);
    let existing = pickByTitle(sameWork, year, kind);
    if (!existing && sameKind.length) {
      existing = pickByTitle(sameKind, year, kind);
      if (existing)
        console.warn(
          `by-title "${title}" year=${year}: sheet year disagrees with the only ${kind} of that name (${existing.year}); attaching to it`,
        );
    }
    // Only worth minting the other work when the collection has nothing of the
    // kind this row implies — otherwise a stale year in the sheet would give us
    // two items for one title.
    const otherWork = !existing && !sameKind.length && !!named.length && year != null;
    if (named.length > 1 || otherWork)
      console.log(
        `by-title "${title}" year=${year} kind=${kind} list=${list}: ${named.length} items share the title (${named.map((it) => `${it.kind} ${it.year}`).join(", ")}) -> ${existing ? `${existing.kind} ${existing.year}` : otherWork ? "none, creating the " + kind : "none"}`,
      );
    if (existing) {
      // This path is the sheet's recovery route (doSync recreates a title the
      // app is missing), not a viewing gesture: re-attaching a title must not
      // mark it a rewatch or stamp a watch date on it.
      const ex = existing;
      if (
        list &&
        list !== TABS.SPIN &&
        !blockedFromList(ex, list) &&
        !ex.lists.includes(list)
      ) {
        setItemLists(ex.id, [list, ...ex.lists.filter((l) => l !== list)]);
        if (body.position != null)
          setListPosition(ex.id, list, Number(body.position));
        else setListPosition(ex.id, list, topPosition(list));
      }
      return c.json({ ...getItemById(ex.id)!, existed: true });
    }
    try {
      const d = await tmdb(
        `/search/${kind}?query=${encodeURIComponent(title)}`,
      );
      const yearOf = (x: { first_air_date?: string; release_date?: string }) =>
        ((kind === "tv" ? x.first_air_date : x.release_date) || "").slice(0, 4) ||
        null;
      const sameName = (d.results || []).filter(
        (x) => normTitle((kind === "tv" ? x.name : x.title) ?? "") === normTitle(title),
      );
      const yearMatch = sameName.find((x) => year != null && yearOf(x) === year);
      // For the other work only an exact title + year + kind match may be
      // minted, so a stale year in the sheet can never add a second item.
      const r = otherWork
        ? yearMatch
        : yearMatch || sameName[0] || (d.results || [])[0];
      if (!r?.id) {
        if (otherWork) return attachClosest(c, named, title, year, kind, list);
        return c.json({ error: "not found" }, 404);
      }
      const item = await createFromTmdb(r.id, kind);
      if (!item) {
        // Couldn't mint it (TMDB down, or the tmdb id is already taken by the
        // other kind). Attaching the row to the closest same-title item keeps
        // the sheet resolvable; the year/kind mismatch is logged above.
        console.warn(
          `by-title "${title}" year=${year}: create failed, falling back to a same-title item`,
        );
        return attachClosest(c, named, title, year, kind, list);
      }
      if (list) {
        const updated = setItemLists(item.id, [
          list,
          ...item.lists.filter((l) => l !== list),
        ]);
        if (body.position != null)
          setListPosition(item.id, list, Number(body.position));
        else if (updated) setListPosition(updated.id, list, topPosition(list));
        return c.json({ ...(updated ?? item), existed: false });
      }
      return c.json({ ...item, existed: false });
    } catch {
      return c.json({ error: "search failed" }, 502);
    }
  });

  app.put("/api/items/:id/flag", async (c) => {
    const { list, flagged } = await c.req.json();
    if (typeof list !== "string" || typeof flagged !== "boolean")
      return c.json({ error: "list string and flagged boolean required" }, 400);
    const item = setListFlag(c.req.param("id"), list, flagged);
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json(item);
  });

  app.patch("/api/items/:id", async (c) => {
    const id = c.req.param("id");
    const before = getItemById(id);
    if (!before) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const fields: Partial<Pick<Item, (typeof PATCH_FIELDS)[number]>> = {};
    for (const k of PATCH_FIELDS) {
      const v = body[k];
      if (v !== undefined) (fields as Record<string, unknown>)[k] = v;
    }
    let updated = updateItem(id, fields);
    if (!updated) return c.json({ error: "not found" }, 404);
    updated = ensureShows2026(updated as Item);
    updated = transferToShows2026(updated as Item);
    const hasScore =
      updated.my_rating != null ||
      updated.di_rating != null ||
      (updated.season_entries || []).some(
        (e) => e.my_rating != null || e.di_rating != null,
      );
    // Only auto-file a scored show off Currently Watching once it's show-level
    // finished (watched_at in 2026). Scoring at 3/4 or even 4/4 while still
    // "on the last episode" keeps it on CW; it only leaves after the season
    // is marked done — i.e. the last-episode tap stamps watched_at/ep_finished_at
    // via the episodes flow (isLastSeasonDone), which then
    // triggers transferToShows2026. So score + last episode = move, either
    // order, but scoring alone never moves.
    const shouldAutoFile = finished2026(updated);
    if (
      updated.kind === "tv" &&
      hasScore &&
      shouldAutoFile &&
      !updated.lists.includes(SHOWS_2026) &&
      updated.current_season != null
    ) {
      const cur = updated.season_entries?.find(
        (e) => e.season === updated.current_season,
      );
      if (cur && (cur.my_rating != null || cur.di_rating != null)) {
        const lists = updated.lists.filter(
          (l) => l !== TABS.CURRENTLY_WATCHING && l !== TABS.SHOWS_ARCHIVE,
        );
        if (!lists.includes(SHOWS_2026)) lists.push(SHOWS_2026);
        const moved = setItemLists(updated.id, lists);
        if (moved) {
          setListPosition(moved.id, SHOWS_2026, topPosition(SHOWS_2026));
          if (updated.lists.includes(TABS.CURRENTLY_WATCHING))
            void pushSheet(removeCmd(updated, TABS.CURRENTLY_WATCHING));
          void pushSheet({
            op: "add",
            tab: SHOWS_2026,
            title: moved.title,
            year: moved.year,
            kind: moved.kind,
            status: moved.status,
            genres: moved.genres,
            taste_score: moved.taste_score,
            j: moved.my_rating,
            d: moved.di_rating,
            date: moved.watched_at || today(),
          });
          pushScore(moved, SHOWS_2026);
          updated = moved;
        }
      }
    }
    if (
      fields.rewatch !== undefined &&
      updated.rewatch !== before.rewatch &&
      updated.kind === "movie"
    ) {
      const on2026 = updated.lists.includes(TABS.WATCH_2026);
      // A rewatch means at least two viewings. Never lower a higher count the
      // user set by hand.
      if (updated.rewatch && (updated.watch_count ?? 0) < 2) {
        const stamped = updateItem(id, { watch_count: 2 });
        if (stamped) Object.assign(updated, stamped);
      }
      // A card already on 2026 has a watch date: the emblem only turns the
      // yellow border on/off there. The viewing already happened on that date;
      // stamping "today" would rewrite history and jump the card to the top.
      if (!on2026) {
        if (updated.rewatch && !updated.rewatched_at) {
          const stamped = updateItem(id, { rewatched_at: today() });
          if (stamped) Object.assign(updated, stamped);
        }
        // Marking a rewatch is a fresh viewing: refresh watched_at so the item
        // jumps back to the top of the 2026 tab (both the server query and the
        // client sort order by watched_at DESC). Mirrored to the sheet because
        // doSync pulls watched dates back sheet -> app. Skipped when the PATCH
        // carries its own watched_at — an explicit date wins.
        if (
          updated.rewatch &&
          fields.watched_at === undefined &&
          updated.watched_at !== today()
        ) {
          const stamped = updateItem(id, {
            ...(updated.first_watched_at == null && updated.watched_at
              ? { first_watched_at: updated.watched_at }
              : {}),
            watched_at: today(),
          });
          if (stamped) {
            Object.assign(updated, stamped);
            void pushSheet({
              op: "watched",
              title: stamped.title,
              year: stamped.year,
              kind: stamped.kind,
              date: stamped.watched_at,
            });
          }
        }
      }
      const tab = typeof body.tab === "string" ? body.tab : "";
      void pushSheet({
        op: "markRewatch",
        tab,
        title: updated.title,
        mark: updated.rewatch,
      });
    }
    // Sync reviews/references edited in the app into the sheet. The sheet is the
    // source the re-sync (import-reviews.ts) reads back from, so every change —
    // including a cleared value — must land on ALL tabs the title belongs to. If
    // we only wrote the primary tab, a stale value on another tab would win the
    // re-sync and revert the edit.
    const sheetTabs = updated.lists.filter((t) => t !== TABS.SPIN);
    for (const e of updated.season_entries || []) {
      const pe = before.season_entries?.find((p) => p.season === e.season);
      if (!!e.rewatch !== !!pe?.rewatch && e.tab)
        void pushSheet({
          op: "markRewatch",
          tab: e.tab,
          title: updated.title,
          index: Math.max(0, (e.season || 1) - 1),
          season: e.season,
          mark: !!e.rewatch,
        });
      if ((e.review || null) !== (pe?.review || null))
        void pushSheet({
          op: "setReview",
          tab: TABS.CURRENTLY_WATCHING,
          title: updated.title,
          review: e.review || "",
          index: Math.max(0, (e.season || 1) - 1),
          season: e.season,
        });
      if ((e.reference || null) !== (pe?.reference || null))
        void pushSheet({
          op: "setReference",
          tab: TABS.CURRENTLY_WATCHING,
          title: updated.title,
          reference: e.reference || "",
          index: Math.max(0, (e.season || 1) - 1),
          season: e.season,
        });
    }
    if (
      fields.review !== undefined &&
      (updated.review || null) !== (before.review || null)
    )
      for (const tab of sheetTabs)
        void pushSheet({
          op: "setReview",
          title: updated.title,
          tab,
          review: updated.review || "",
        });
    if (
      fields.reference !== undefined &&
      (updated.reference || null) !== (before.reference || null)
    )
      for (const tab of sheetTabs)
        void pushSheet({
          op: "setReference",
          title: updated.title,
          tab,
          reference: updated.reference || "",
        });
    // Sync season start/finish dates edited in the app into the sheet's Shows
    // Watched Started/Finished columns. Pushes both values so the untouched
    // column is never blanked out.
    for (const [sk, sn] of Object.entries(updated.season_dates || {})) {
      const pn = (before.season_dates || {})[sk];
      if (
        pn &&
        pn.started_at === sn.started_at &&
        pn.finished_at === sn.finished_at
      )
        continue;
      const entry = updated.season_entries?.find(
        (e) => e.season === Number(sk),
      );
      const { cur, total } = episodeSummary(updated);
      void pushSheet({
        op: "episodeProgress",
        title: updated.title,
        started: sn.started_at || "",
        finished: sn.finished_at || (entry && entry.watched_at) || "",
        season: Number(sk),
        cur,
        epis: total,
      });
    }
    if (
      fields.my_rating !== undefined ||
      fields.di_rating !== undefined ||
      fields.taste_score !== undefined
    ) {
      pushScore(updated);
    }
    if (fields.watched_at !== undefined) {
      void pushSheet({
        op: "watched",
        title: updated.title,
        year: updated.year,
        kind: updated.kind,
        date: updated.watched_at,
      });
    }
    const onToWatch =
      updated.lists.includes(TABS.MOVIES) ||
      updated.lists.includes(TABS.NO_DI);
    // Diana scored it and James hasn't: file it to "No Di" instead of 2026,
    // because only she has seen it — it stays a to-watch pick for him. Fires
    // from the score editor (move_to_2026) or a score arriving from the sheet.
    if (
      updated.kind === "movie" &&
      onToWatch &&
      seenByDianaOnly(updated) &&
      (body.move_to_2026 === true ||
        fields.my_rating !== undefined ||
        fields.di_rating !== undefined)
    ) {
      const moved = moveToNoDi(updated) ?? updated;
      pushScore(moved, TABS.NO_DI);
      return c.json(moved);
    }
    // James's own score means he has seen it too: file it onto the 2026 tab.
    if (
      (body.move_to_2026 === true || updated.rewatch) &&
      updated.kind === "movie" &&
      onToWatch &&
      updated.my_rating != null
    ) {
      const kept = updated.lists.filter(
        (l) => l !== TABS.MOVIES && l !== TABS.NO_DI,
      );
      const lists = [
        TABS.WATCH_2026,
        ...kept.filter((l) => l !== TABS.WATCH_2026 && !PRIMARY_SET.has(l)),
      ];
      setItemLists(id, lists);
      if (!updated.watched_at) updateItem(id, { watched_at: today() });
      // Destination row first, source rows second — see moveToNoDi: a sheet with
      // no row at all reads as "deleted" to doSync, while a briefly duplicated
      // row is self-correcting.
      void pushSheet({
        op: "add",
        tab: TABS.WATCH_2026,
        title: updated.title,
        year: updated.year,
        status: updated.status,
        genres: updated.genres,
        taste_score: updated.taste_score,
        j: updated.my_rating,
        d: updated.di_rating,
        date: updated.watched_at || today(),
      });
      for (const t of [TABS.MOVIES, TABS.NO_DI]) {
        if (updated.lists.includes(t)) void pushSheet(removeCmd(updated, t));
      }
      return c.json(getItemById(id) ?? updated);
    }
    return c.json(stripScored(updated) ?? updated);
  });

  app.put("/api/items/:id/lists", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const given = Array.isArray(body.lists)
      ? collapsePrimaries(body.lists.map(String))
      : null;
    if (!given) return c.json({ error: "lists array required" }, 400);
    let lists = given;
    const it = getItemById(id);
    if (!it) return c.json({ error: "not found" }, 404);
    // A bulk reconcile may not un-list a show that is mid-season. doSync
    // derives list membership from the tabs it can read, and the spreadsheet
    // routinely lacks the row the app just pushed — the gateway queues each
    // push and takes seconds per call, so a sync landing in that window sees a
    // missing row. For a movie that means "the user deleted it"; for a show the
    // app is tracking it means the push hasn't landed. Keep the show's own
    // tracking lists and say so, so a list change made by hand still works.
    if (isSyncClient(c) && activelyTracked(it)) {
      const missing = it.lists.filter(
        (l) => isShowList(l) && !lists.includes(l),
      );
      if (missing.length) {
        console.warn(
          `sync tried to un-list in-progress show "${it.title}" (${it.id}) from ${missing.join(", ")} — keeping them`,
        );
        lists = collapsePrimaries([...missing, ...lists]);
      }
    }
    if (!lists.length) {
      if (!internal(c)) {
        for (const t of it.lists) {
          if (t !== TABS.SPIN) void pushSheet(removeCmd(it, t));
        }
      }
      deleteItem(id);
      return c.json({ deleted: true });
    }
    if (!internal(c)) {
      for (const t of it.lists) {
        if (!lists.includes(t) && t !== TABS.SPIN)
          void pushSheet(removeCmd(it, t));
      }
    }
    const updated = setItemLists(id, lists);
    if (!updated) return c.json({ error: "not found" }, 404);
    if (!internal(c)) {
      for (const t of lists) {
        if (!it.lists.includes(t) && t !== TABS.SPIN)
          void pushSheet({
            op: "add",
            tab: t,
            title: updated.title,
            year: updated.year,
            kind: updated.kind,
            status: updated.status,
            genres: updated.genres,
            taste_score: updated.taste_score,
            j: updated.my_rating,
            d: updated.di_rating,
            date: updated.watched_at,
          });
      }
    }
    return c.json(stripScored(updated) ?? updated);
  });

  app.put("/api/items/:id/list-date", async (c) => {
    const id = c.req.param("id");
    const { list, added_at } = (await c.req.json().catch(() => ({}))) as {
      list?: string;
      added_at?: string | null;
    };
    if (!list) return c.json({ error: "list required" }, 400);
    const updated = setListAddedAt(id, list, added_at ?? null);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(stripScored(updated) ?? updated);
  });

  app.put("/api/items/:id/positions", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const positions = body.positions;
    if (!positions || typeof positions !== "object" || Array.isArray(positions))
      return c.json({ error: "positions object required" }, 400);
    if (!getItemById(id)) return c.json({ error: "not found" }, 404);
    for (const [list, pos] of Object.entries(
      positions as Record<string, unknown>,
    )) {
      if (typeof pos === "number") setListPosition(id, list, pos);
    }
    return c.json(getItemById(id));
  });

  app.get("/api/taste/url", async (c) => {
    const title = c.req.query("title") || "";
    const kind = c.req.query("kind") || undefined;
    const year = c.req.query("year") || undefined;
    if (!title) return c.json({ url: null });
    const url = await tasteUrl(title, kind, year);
    if (url) return c.json({ url });
    return c.json({
      url: `https://www.taste.io/search?q=${encodeURIComponent(title)}`,
    });
  });

  app.post("/api/taste", async (c) => {
    const { scores } = await c.req.json();
    if (!scores || typeof scores !== "object") {
      return c.json({ error: "scores object required" }, 400);
    }
    const byTitle: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(scores)) {
      byTitle[normTitle(k)] = typeof v === "number" ? v : null;
    }
    let updated = 0;
    for (const it of listItems()) {
      const t = byTitle[normTitle(it.title)];
      if (t !== undefined && t !== it.taste_score) {
        updateItem(it.id, { taste_score: t });
        updated++;
      }
    }
    return c.json({ updated });
  });

  // A movie James has scored is seen, so it does not belong on a to-watch tab.
  // The sheet sync re-adds rows from Movies / No Di whenever they are still
  // there (a stale row, a hand-edit), so this sweeps them all off in one pass
  // instead of card by card: each title keeps every other list it is on, and a
  // title left with nothing goes to 2026 — the tab holding what he has watched.
  // Unscored movies are untouched, and shows are never involved.
  app.post("/api/tidy-watched", async (c) => {
    const moved: { id: string; title: string; from: string[]; to: string[] }[] =
      [];
    for (const it of listItems()) {
      if (it.kind !== "movie" || it.my_rating == null) continue;
      const drop = it.lists.filter(
        (l) => l === TABS.MOVIES || l === TABS.NO_DI,
      );
      if (!drop.length) continue;
      const kept = it.lists.filter((l) => !drop.includes(l));
      const lists = kept.length ? kept : [TABS.WATCH_2026];
      // Destination row first, source rows second — see moveToNoDi: a title with
      // no row at all reads as "deleted" to doSync, a briefly duplicated row is
      // self-correcting.
      if (lists.includes(TABS.WATCH_2026) && !it.lists.includes(TABS.WATCH_2026))
        void pushSheet({
          op: "add",
          tab: TABS.WATCH_2026,
          title: it.title,
          year: it.year,
          status: it.status,
          genres: it.genres,
          taste_score: it.taste_score,
          j: it.my_rating,
          d: it.di_rating,
          date: it.watched_at,
          reference: it.reference,
        });
      for (const t of drop) void pushSheet(removeCmd(it, t));
      const updated = setItemLists(it.id, lists);
      if (updated)
        moved.push({ id: it.id, title: it.title, from: drop, to: lists });
    }
    if (moved.length)
      console.log(
        `tidy: moved ${moved.length} watched movie(s) off the to-watch tabs`,
      );
    return c.json({ moved: moved.length, items: moved });
  });

  app.post("/api/archive-consolidate", async (c) => {
    const yearLists: Set<string> = new Set(TABS.ARCHIVE_YEARS);
    let moved = 0;
    for (const it of listItems()) {
      if (!it.lists.some((l) => yearLists.has(l))) continue;
      const archive =
        it.kind === "tv" ? TABS.SHOWS_ARCHIVE : TABS.MOVIES_ARCHIVE;
      const kept = it.lists.filter((l) => !yearLists.has(l));
      const lists = [
        archive,
        ...kept.filter((l) => l !== archive && !PRIMARY_SET.has(l)),
      ];
      setItemLists(it.id, lists);
      moved++;
    }
    return c.json({ moved });
  });

  // Re-pull per-season episode counts from TMDB for every show so episode
  // tracking and completion detection stay accurate. Called at the end of a sheet
  // sync; best-effort, skips shows that fail to load.
  app.post("/api/season-refresh", async (c) => {
    let refreshed = 0;
    for (const it of listItems()) {
      if (it.kind !== "tv") continue;
      try {
        const d = await tmdb(`/tv/${it.tmdb_id}`);
        const counts: Record<string, number> = {};
        for (const sn of d.seasons || []) {
          if (sn.season_number > 0) counts[sn.season_number] = sn.episode_count;
        }
        updateItem(it.id, {
          seasons: Object.keys(counts).length || null,
          episodes: Object.values(counts).reduce((n, e) => n + e, 0) || null,
          season_counts: counts,
        });
        refreshed++;
      } catch {}
    }
    return c.json({ refreshed });
  });

  // Re-pull watch providers from TMDB for every item so new services (e.g.
  // Disney+) show up on cards and in the provider filter. Best-effort; skips
  // items that fail to load.
  app.post("/api/providers-refresh", async (c) => {
    let refreshed = 0;
    for (const it of listItems()) {
      try {
        const providers = await watchProviders(it.kind, it.tmdb_id);
        updateItem(it.id, { providers });
        refreshed++;
      } catch {}
    }
    return c.json({ refreshed });
  });

  // Re-pull runtime + director/creator from TMDB for every item so cards show
  // them for older entries too. Best-effort; skips items that fail to load.
  app.post("/api/metadata-refresh", async (c) => {
    let refreshed = 0;
    for (const it of listItems()) {
      try {
        const d = await tmdb(`/${it.kind}/${it.tmdb_id}`);
        const director = await directorFrom(it.kind, it.tmdb_id, d);
        const runtime = runtimeFrom(d, it.kind);
        updateItem(it.id, { runtime, director });
        refreshed++;
      } catch {}
    }
    return c.json({ refreshed });
  });

  app.delete("/api/items/:id", async (c) => {
    const id = c.req.param("id");
    const it = getItemById(id);
    if (!it) return c.json({ error: "not found" }, 404);
    // Only the spreadsheet calls this (the app's own UI re-saves the list set
    // through PUT …/lists). doSync deletes an item when no tab it reads has a
    // row for it — but for a show the app is in the middle of watching, a
    // missing row means the row is missing, not that the show is gone: the
    // sheet gateway is slow, and two items whose titles normalize the same
    // (the 2026 show "Carrie" and the 2002 TV movie) make one row serve two
    // items, the losing one looking deleted. Refuse and log it rather than
    // dropping a show with its episode history.
    if (activelyTracked(it)) {
      console.warn(
        `refusing to delete in-progress show "${it.title}" (${it.id}, lists=${it.lists.join(", ")}) — the spreadsheet sees no row for it`,
      );
      return c.json(
        {
          error: "in-progress show",
          detail:
            "the app is tracking episodes for this show; remove it in the app (or clear its episodes) to delete it",
          item: it,
        },
        409,
      );
    }
    if (!internal(c)) {
      for (const t of it.lists) {
        void pushSheet(removeCmd(it, t));
      }
    }
    deleteItem(id);
    console.log(
      `deleted "${it.title}" (${it.year ?? "?"}, ${it.kind}) at the spreadsheet's request; was on ${it.lists.join(", ") || "no lists"}`,
    );
    return c.json({ ok: true });
  });

  // Move an item from one tab to another (e.g. Movies -> No Di) and pin it to
  // the top of the destination tab so an accidental move is easy to undo.
  app.post("/api/items/:id/move", async (c) => {
    const { from, to } = (await c.req.json().catch(() => ({}))) as {
      from?: string;
      to?: string;
    };
    if (typeof from !== "string" || typeof to !== "string")
      return c.json({ error: "from and to list names required" }, 400);
    const id = c.req.param("id");
    const it = getItemById(id);
    if (!it) return c.json({ error: "not found" }, 404);
    if (!it.lists.includes(from))
      return c.json({ error: `not on ${from}` }, 400);
    if (from === to) return c.json(it);
    // A manual move can't drop a scored movie back onto a to-watch tab; say so
    // instead of silently relocating it back on the next write.
    if (blockedFromList(it, to))
      return c.json(
        {
          error: seenByJames(it)
            ? `"${it.title}" is already scored — it belongs on 2026, not ${to}`
            : `Diana has already scored "${it.title}" — it belongs on No Di`,
        },
        400,
      );
    const lists = it.lists.filter((l) => l !== from);
    if (PRIMARY_SET.has(to)) {
      for (const l of lists.filter((l) => PRIMARY_SET.has(l) && l !== to))
        lists.splice(lists.indexOf(l), 1);
    }
    if (!lists.includes(to)) lists.push(to);
    const dropped = it.lists.filter(
      (l) => PRIMARY_SET.has(l) && l !== from && !lists.includes(l),
    );
    if (!internal(c)) {
      void pushSheet(removeCmd(it, from));
      for (const d of dropped) void pushSheet(removeCmd(it, d));
    }
    const updated = setItemLists(id, lists);
    if (!updated) return c.json({ error: "not found" }, 404);
    const positioned = setListPosition(id, to, topPosition(to)) ?? updated;
    void pushSheet({
      op: "add",
      tab: to,
      title: positioned.title,
      year: positioned.year,
      status: positioned.status,
      genres: positioned.genres,
      taste_score: positioned.taste_score,
      j: positioned.my_rating,
      d: positioned.di_rating,
      date: positioned.watched_at,
      reference: positioned.reference,
    });
    return c.json(positioned);
  });
}
