import type { Hono } from "hono";
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
import { TABS, today, PRIMARY_SET, collapsePrimaries } from "./constants";
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

const TO_WATCH: Set<string> = new Set([TABS.MOVIES, TABS.NO_DI]);

// A scored movie has been seen, so it doesn't belong on a to-watch list. Keep
// the Movies/No Di tabs free of anything already scored (and thus archived).
function stripScored(it: Item): Item | null {
  if (it.kind !== "movie" || (it.my_rating == null && it.di_rating == null))
    return it;
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
    if (
      it.kind === "movie" &&
      (it.my_rating != null || it.di_rating != null) &&
      TO_WATCH.has(list)
    )
      return it;
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
        for (const d of dropped) void pushSheet(removeCmd(it, d));
        void pushSheet({
          op: "add",
          tab: list,
          title: updated.title,
          year: updated.year,
          status: updated.status,
          genres: updated.genres,
          taste_score: updated.taste_score,
          j: updated.my_rating,
          d: updated.di_rating,
          date: updated.watched_at,
        });
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
      if (!ready.rewatch) {
        const stamped = updateItem(ready.id, {
          rewatch: true,
          rewatched_at: ready.rewatched_at || today(),
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
    const kind = body.kind === "tv" ? "tv" : "movie";
    if (!title) return c.json({ error: "title required" }, 400);
    const existing = listItems().find(
      (it) => normTitle(it.title) === normTitle(title),
    );
    if (existing) {
      let ex = existing;
      if (!ex.rewatch) {
        const stamped = updateItem(ex.id, {
          rewatch: true,
          rewatched_at: ex.rewatched_at || today(),
        });
        if (stamped) {
          ex = stamped;
          if (ex.kind === "movie" && list)
            void pushSheet({
              op: "markRewatch",
              tab: list,
              title: ex.title,
              mark: true,
            });
        }
      }
      const scored =
        ex.kind === "movie" && (ex.my_rating != null || ex.di_rating != null);
      if (
        list &&
        list !== TABS.SPIN &&
        !(scored && TO_WATCH.has(list)) &&
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
      const r =
        (d.results || []).find(
          (x) =>
            normTitle((kind === "tv" ? x.name : x.title) ?? "") ===
            normTitle(title),
        ) || (d.results || [])[0];
      if (!r?.id) return c.json({ error: "not found" }, 404);
      const item = await createFromTmdb(r.id, kind);
      if (!item) return c.json({ error: "couldn't load from TMDB" }, 502);
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
    if (
      updated.kind === "tv" &&
      hasScore &&
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
      if (updated.rewatch && !updated.rewatched_at) {
        const stamped = updateItem(id, { rewatched_at: today() });
        if (stamped) Object.assign(updated, stamped);
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
        date: updated.watched_at,
      });
    }
    if (
      (body.move_to_2026 === true || updated.rewatch) &&
      updated.kind === "movie" &&
      (updated.lists.includes(TABS.MOVIES) ||
        updated.lists.includes(TABS.NO_DI)) &&
      (updated.my_rating != null || updated.di_rating != null)
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
      for (const t of [TABS.MOVIES, TABS.NO_DI]) {
        if (updated.lists.includes(t)) void pushSheet(removeCmd(updated, t));
      }
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
      return c.json(getItemById(id) ?? updated);
    }
    return c.json(stripScored(updated) ?? updated);
  });

  app.put("/api/items/:id/lists", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const lists = Array.isArray(body.lists)
      ? collapsePrimaries(body.lists.map(String))
      : null;
    if (!lists) return c.json({ error: "lists array required" }, 400);
    const it = getItemById(id);
    if (!it) return c.json({ error: "not found" }, 404);
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
    if (!internal(c)) {
      for (const t of it.lists) {
        void pushSheet(removeCmd(it, t));
      }
    }
    deleteItem(id);
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
