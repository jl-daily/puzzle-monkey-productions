import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { today, TABS, collapsePrimaries } from "./constants";
import type { Provider } from "./providers";

const dbPath = process.env.MOVIE_DB_PATH || join(homedir(), ".movie-app.db");
const db = new Database(dbPath);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");

db.run(`CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  tmdb_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('movie','tv')),
  title TEXT NOT NULL,
  year TEXT,
  taste_score REAL,
  genres TEXT,
  overview TEXT,
  poster TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','watching','done')),
  my_rating INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tmdb_id, kind)
)`);

const itemsSql = db
  .query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'",
  )
  .get() as { sql: string } | null;
if (itemsSql && !/UNIQUE\s*\(\s*tmdb_id\s*,\s*kind\s*\)/.test(itemsSql.sql)) {
  db.exec(`BEGIN;
    CREATE TABLE items_new (
      id TEXT PRIMARY KEY,
      tmdb_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('movie','tv')),
      title TEXT NOT NULL,
      year TEXT,
      taste_score REAL,
      genres TEXT,
      overview TEXT,
      poster TEXT,
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','watching','done')),
      my_rating INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reference TEXT,
      di_rating INTEGER,
      rated_at TEXT,
      watched_at TEXT,
      providers TEXT,
      seasons INTEGER,
      episodes INTEGER,
      review TEXT,
      season_entries TEXT,
      UNIQUE(tmdb_id, kind)
    );
    INSERT INTO items_new (id, tmdb_id, kind, title, year, rating, taste_score, genres, overview, poster, status, my_rating, created_at, reference, di_rating, rated_at, watched_at, providers, seasons, episodes, review, season_entries)
      SELECT id, tmdb_id, kind, title, year, rating, taste_score, genres, overview, poster, status, my_rating, created_at, reference, di_rating, rated_at, watched_at, providers, seasons, episodes, review, season_entries FROM items;
    DROP TABLE items;
    ALTER TABLE items_new RENAME TO items;
    COMMIT;`);
}

db.run(`CREATE TABLE IF NOT EXISTS item_lists (
  item_id TEXT NOT NULL,
  list TEXT NOT NULL,
  position INTEGER,
  added_at TEXT,
  UNIQUE(item_id, list)
)`);

const cols = db.query("PRAGMA table_info(items)").all() as { name: string }[];
if (!cols.some((c) => c.name === "taste_score")) {
  db.run("ALTER TABLE items ADD COLUMN taste_score REAL");
}
if (!cols.some((c) => c.name === "reference")) {
  db.run("ALTER TABLE items ADD COLUMN reference TEXT");
}
if (!cols.some((c) => c.name === "di_rating")) {
  db.run("ALTER TABLE items ADD COLUMN di_rating INTEGER");
}
if (!cols.some((c) => c.name === "rated_at")) {
  db.run("ALTER TABLE items ADD COLUMN rated_at TEXT");
  db.run("UPDATE items SET rated_at = created_at WHERE my_rating IS NOT NULL");
}
if (!cols.some((c) => c.name === "watched_at")) {
  db.run("ALTER TABLE items ADD COLUMN watched_at TEXT");
}
if (!cols.some((c) => c.name === "providers")) {
  db.run("ALTER TABLE items ADD COLUMN providers TEXT");
}
if (!cols.some((c) => c.name === "seasons")) {
  db.run("ALTER TABLE items ADD COLUMN seasons INTEGER");
}
if (!cols.some((c) => c.name === "episodes")) {
  db.run("ALTER TABLE items ADD COLUMN episodes INTEGER");
}
if (!cols.some((c) => c.name === "review")) {
  db.run("ALTER TABLE items ADD COLUMN review TEXT");
}
if (!cols.some((c) => c.name === "di_review")) {
  db.run("ALTER TABLE items ADD COLUMN di_review TEXT");
}
if (!cols.some((c) => c.name === "season_entries")) {
  db.run("ALTER TABLE items ADD COLUMN season_entries TEXT");
}
if (!cols.some((c) => c.name === "episode_progress")) {
  db.run("ALTER TABLE items ADD COLUMN episode_progress TEXT");
}
if (!cols.some((c) => c.name === "season_counts")) {
  db.run("ALTER TABLE items ADD COLUMN season_counts TEXT");
}
if (!cols.some((c) => c.name === "ep_started_at")) {
  db.run("ALTER TABLE items ADD COLUMN ep_started_at TEXT");
  // One-time backfill: episode_progress briefly stored per-episode dates
  // (season -> { episode -> date }). Fold those into ep_started_at /
  // ep_finished_at and drop the dates back to plain episode numbers.
  const legacy = db
    .query(
      "SELECT id, episode_progress FROM items WHERE episode_progress IS NOT NULL",
    )
    .all() as { id: string; episode_progress: string }[];
  for (const r of legacy) {
    let o: unknown;
    try {
      o = JSON.parse(r.episode_progress);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const nums: Record<string, number[]> = {};
    const dates: string[] = [];
    for (const [s, v] of Object.entries(o as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        nums[s] = v.filter((n): n is number => typeof n === "number");
      } else if (v && typeof v === "object") {
        nums[s] = Object.keys(v).map(Number);
        for (const d of Object.values(v as Record<string, unknown>)) {
          if (typeof d === "string" && d) dates.push(d);
        }
      }
    }
    const sorted = dates.slice().sort();
    db.run(
      "UPDATE items SET episode_progress = ?, ep_started_at = ?, ep_finished_at = ? WHERE id = ?",
      [
        Object.keys(nums).length ? JSON.stringify(nums) : null,
        sorted.length ? sorted[0] : null,
        sorted.length ? sorted[sorted.length - 1] : null,
        r.id,
      ],
    );
  }
}
if (!cols.some((c) => c.name === "season_dates")) {
  db.run("ALTER TABLE items ADD COLUMN season_dates TEXT");
}
if (!cols.some((c) => c.name === "theater")) {
  db.run("ALTER TABLE items ADD COLUMN theater INTEGER NOT NULL DEFAULT 0");
}
if (!cols.some((c) => c.name === "current_season")) {
  db.run("ALTER TABLE items ADD COLUMN current_season INTEGER");
}
if (!cols.some((c) => c.name === "rewatch")) {
  db.run("ALTER TABLE items ADD COLUMN rewatch INTEGER NOT NULL DEFAULT 0");
}
if (!cols.some((c) => c.name === "rewatched_at")) {
  db.run("ALTER TABLE items ADD COLUMN rewatched_at TEXT");
}
if (!cols.some((c) => c.name === "runtime")) {
  db.run("ALTER TABLE items ADD COLUMN runtime INTEGER");
}
if (!cols.some((c) => c.name === "director")) {
  db.run("ALTER TABLE items ADD COLUMN director TEXT");
}
if (!cols.some((c) => c.name === "pinned")) {
  db.run("ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
}
if (!cols.some((c) => c.name === "di_confirmed")) {
  db.run(
    "ALTER TABLE items ADD COLUMN di_confirmed INTEGER NOT NULL DEFAULT 0",
  );
}
if (cols.some((c) => c.name === "rating")) {
  db.run("ALTER TABLE items DROP COLUMN rating");
}

const ilCols = db.query("PRAGMA table_info(item_lists)").all() as {
  name: string;
}[];
if (!ilCols.some((c) => c.name === "position")) {
  db.run("ALTER TABLE item_lists ADD COLUMN position INTEGER");
}
if (!ilCols.some((c) => c.name === "flagged")) {
  db.run(
    "ALTER TABLE item_lists ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0",
  );
}
if (!ilCols.some((c) => c.name === "added_at")) {
  db.run("ALTER TABLE item_lists ADD COLUMN added_at TEXT");
  db.run(
    "UPDATE item_lists SET added_at = (SELECT i.created_at FROM items i WHERE i.id = item_lists.item_id)",
  );
}
db.run(
  "UPDATE item_lists SET added_at = (SELECT i.created_at FROM items i WHERE i.id = item_lists.item_id) WHERE added_at IS NULL",
);

export type SeasonEntry = {
  season: number;
  tab: string;
  review: string | null;
  reference: string | null;
  di_review: string | null;
  my_rating: number | null;
  di_rating: number | null;
  watched_at: string | null;
  rewatch?: boolean;
};

export type SeasonDates = Record<
  string,
  { started_at: string | null; finished_at: string | null }
>;

export type Item = {
  id: string;
  tmdb_id: number;
  kind: "movie" | "tv";
  title: string;
  year: string | null;
  taste_score: number | null;
  genres: string | null;
  overview: string | null;
  poster: string | null;
  status: "todo" | "watching" | "done";
  my_rating: number | null;
  di_rating: number | null;
  reference: string | null;
  rated_at: string | null;
  watched_at: string | null;
  review: string | null;
  di_review: string | null;
  providers: Provider[];
  seasons: number | null;
  episodes: number | null;
  season_entries: SeasonEntry[];
  episode_progress: Record<string, number[]>;
  ep_started_at: string | null;
  ep_finished_at: string | null;
  season_counts: Record<string, number> | null;
  season_dates: SeasonDates | null;
  created_at: string;
  lists: string[];
  positions: Record<string, number>;
  flags: Record<string, boolean>;
  list_dates: Record<string, string | null>;
  theater: boolean;
  rewatch: boolean;
  rewatched_at: string | null;
  current_season: number | null;
  pinned: number;
  di_confirmed: boolean;
  runtime: number | null;
  director: string | null;
};

type Row = Omit<
  Item,
  | "lists"
  | "positions"
  | "flags"
  | "providers"
  | "season_entries"
  | "episode_progress"
  | "season_counts"
  | "season_dates"
> & {
  lists: string | null;
  providers: string | null;
  season_entries: string | null;
  episode_progress: string | null;
  season_counts: string | null;
  season_dates: string | null;
};

function rowToItem(row: Row): Item {
  let providers: Provider[] = [];
  if (row.providers) {
    try {
      providers = JSON.parse(row.providers);
    } catch {}
  }
  let season_entries: SeasonEntry[] = [];
  if (row.season_entries) {
    try {
      season_entries = JSON.parse(row.season_entries);
    } catch {}
  }
  // episode_progress: season -> watched episode numbers. Values may still be
  // an old object shape (season -> { episode -> date }); fold those to numbers.
  let episode_progress: Record<string, number[]> = {};
  if (row.episode_progress) {
    try {
      const o = JSON.parse(row.episode_progress) as Record<
        string,
        number[] | Record<string, unknown>
      >;
      for (const [s, v] of Object.entries(o)) {
        if (Array.isArray(v)) {
          episode_progress[s] = v.map(Number).filter((n) => Number.isFinite(n));
        } else if (v && typeof v === "object") {
          episode_progress[s] = Object.keys(v)
            .map(Number)
            .filter((n) => Number.isFinite(n));
        }
      }
    } catch {}
  }
  let season_counts: Record<string, number> | null = null;
  if (row.season_counts) {
    try {
      season_counts = JSON.parse(row.season_counts);
    } catch {}
  }
  let season_dates: SeasonDates | null = null;
  if (row.season_dates) {
    try {
      season_dates = JSON.parse(row.season_dates);
    } catch {}
  }
  return {
    ...row,
    providers,
    season_entries,
    episode_progress,
    season_counts,
    season_dates,
    lists: row.lists ? row.lists.split(",").filter(Boolean) : [],
    positions: {},
    flags: {},
    list_dates: {},
    theater: !!row.theater,
    rewatch: !!row.rewatch,
    di_confirmed: !!row.di_confirmed,
    current_season: row.current_season ?? null,
    pinned: row.pinned ?? 0,
  };
}

const posStmt = db.query(
  "SELECT list, position FROM item_lists WHERE item_id = ? AND position IS NOT NULL",
);

const flagStmt = db.query(
  "SELECT list FROM item_lists WHERE item_id = ? AND flagged = 1",
);

const dateStmt = db.query(
  "SELECT list, added_at FROM item_lists WHERE item_id = ?",
);

function hydrate(row: Row): Item {
  const it = rowToItem(row);
  for (const r of posStmt.all(it.id) as { list: string; position: number }[]) {
    it.positions[r.list] = r.position;
  }
  for (const r of flagStmt.all(it.id) as { list: string }[]) {
    it.flags[r.list] = true;
  }
  for (const r of dateStmt.all(it.id) as {
    list: string;
    added_at: string | null;
  }[]) {
    it.list_dates[r.list] = r.added_at;
  }
  return it;
}

const SELECT = `SELECT i.*, (
  SELECT group_concat(l.list, ',') FROM item_lists l WHERE l.item_id = i.id
) AS lists FROM items i`;

export function listItems(list?: string): Item[] {
  if (list === TABS.WATCH_2026) {
    const rows = db
      .query(
        SELECT +
          " WHERE i.id IN (SELECT item_id FROM item_lists WHERE list = ?)" +
          " ORDER BY i.watched_at IS NULL, i.watched_at DESC, i.created_at DESC",
      )
      .all(list) as Row[];
    return rows.map(hydrate);
  }
  const ORDER = ` ORDER BY CASE i.status WHEN 'todo' THEN 0 WHEN 'watching' THEN 1 ELSE 2 END, i.created_at DESC`;
  const rows = (
    list
      ? db
          .query(
            SELECT +
              " WHERE i.id IN (SELECT item_id FROM item_lists WHERE list = ?)" +
              " ORDER BY COALESCE((SELECT position FROM item_lists p WHERE p.item_id = i.id AND p.list = ?), 999999), i.created_at ASC",
          )
          .all(list, list)
      : db.query(SELECT + ORDER).all()
  ) as Row[];
  return rows.map(hydrate);
}

export function getItem(tmdbId: number, kind?: string): Item | null {
  const row = (
    kind
      ? db
          .query(SELECT + " WHERE i.tmdb_id = ? AND i.kind = ?")
          .get(tmdbId, kind)
      : db.query(SELECT + " WHERE i.tmdb_id = ?").get(tmdbId)
  ) as Row | null;
  return row ? hydrate(row) : null;
}

export function getItemById(id: string): Item | null {
  const row = db.query(SELECT + " WHERE i.id = ?").get(id) as Row | null;
  return row ? hydrate(row) : null;
}

export function createItem(
  data: Omit<
    Item,
    | "id"
    | "status"
    | "my_rating"
    | "di_rating"
    | "rated_at"
    | "watched_at"
    | "created_at"
    | "review"
    | "positions"
    | "season_entries"
    | "episode_progress"
    | "ep_started_at"
    | "ep_finished_at"
    | "season_counts"
    | "season_dates"
    | "theater"
    | "rewatch"
    | "rewatched_at"
   | "current_season"
   | "pinned"
   | "di_confirmed"
  >,
  positions?: Record<string, number>,
): Item {
  const id = randomUUID();
  db.run(
    "INSERT INTO items (id, tmdb_id, kind, title, year, taste_score, genres, overview, poster, providers, seasons, episodes, runtime, director) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      data.tmdb_id,
      data.kind,
      data.title,
      data.year,
      data.taste_score,
      data.genres,
      data.overview,
      data.poster,
      data.providers.length ? JSON.stringify(data.providers) : null,
      data.seasons,
      data.episodes,
      data.runtime,
      data.director,
    ],
  );
  for (const list of data.lists) {
    db.run(
      "INSERT OR IGNORE INTO item_lists (item_id, list, position) VALUES (?, ?, ?)",
      [id, list, positions ? (positions[list] ?? null) : null],
    );
  }
  return getItemById(id)!;
}

export function updateItem(
  id: string,
  fields: Partial<
    Pick<
      Item,
      | "status"
      | "my_rating"
      | "di_rating"
      | "taste_score"
      | "reference"
      | "watched_at"
      | "review"
      | "providers"
      | "seasons"
      | "episodes"
      | "season_entries"
      | "episode_progress"
      | "ep_started_at"
      | "ep_finished_at"
      | "season_counts"
      | "season_dates"
      | "theater"
      | "rewatch"
      | "rewatched_at"
      | "current_season"
      | "runtime"
      | "director"
      | "pinned"
      | "di_confirmed"
      | "title"
      | "year"
      | "poster"
      | "overview"
      | "kind"
      | "tmdb_id"
    >
  >,
): Item | null {
  const before = getItemById(id);
  if (!before) return null;
  const rated =
    (fields.my_rating !== undefined && fields.my_rating !== before.my_rating) ||
    (fields.di_rating !== undefined && fields.di_rating !== before.di_rating);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const jsonFields = new Set([
    "providers",
    "season_entries",
    "episode_progress",
    "season_counts",
    "season_dates",
  ]);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(
        jsonFields.has(k)
          ? v == null
            ? null
            : JSON.stringify(v)
          : k === "theater" || k === "rewatch"
            ? v
              ? 1
              : 0
            : k === "pinned"
              ? v === 2
                ? 2
                : v
                  ? 1
                  : 0
              : (v as string | number | null),
      );
    }
  }
  if (rated) sets.push("rated_at = datetime('now')");
  if (!sets.length) return before;
  vals.push(id);
  db.run(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`, vals);
  return getItemById(id);
}

export function setItemLists(id: string, lists: string[]): Item | null {
  if (!getItemById(id)) return null;
  // Enforce single-membership among primary lists at the write boundary so no
  // caller can ever persist an item on two primary tabs at once.
  lists = collapsePrimaries(lists);
  const before = db
    .query(
      "SELECT list, position, flagged, added_at FROM item_lists WHERE item_id = ?",
    )
    .all(id) as {
    list: string;
    position: number | null;
    flagged: number;
    added_at: string | null;
  }[];
  const pos = new Map(before.map((r) => [r.list, r.position]));
  const flag = new Map(before.map((r) => [r.list, r.flagged]));
  const had = new Map(before.map((r) => [r.list, r.added_at]));
  db.run("DELETE FROM item_lists WHERE item_id = ?", [id]);
  for (const list of lists) {
    db.run(
      "INSERT OR IGNORE INTO item_lists (item_id, list, position, flagged, added_at) VALUES (?, ?, ?, ?, ?)",
      [
        id,
        list,
        pos.has(list) ? (pos.get(list) ?? null) : null,
        flag.get(list) ? 1 : 0,
        had.has(list) ? (had.get(list) ?? null) : today(),
      ],
    );
  }
  return getItemById(id);
}

export function setListAddedAt(
  id: string,
  list: string,
  added_at: string | null,
): Item | null {
  if (!getItemById(id)) return null;
  db.run(
    "INSERT INTO item_lists (item_id, list, added_at) VALUES (?, ?, ?) ON CONFLICT(item_id, list) DO UPDATE SET added_at = excluded.added_at",
    [id, list, added_at],
  );
  return getItemById(id);
}

export function setListFlag(
  id: string,
  list: string,
  flagged: boolean,
): Item | null {
  if (!getItemById(id)) return null;
  db.run(
    "INSERT INTO item_lists (item_id, list, flagged) VALUES (?, ?, ?) ON CONFLICT(item_id, list) DO UPDATE SET flagged = excluded.flagged",
    [id, list, flagged ? 1 : 0],
  );
  return getItemById(id);
}

export function setListPosition(
  id: string,
  list: string,
  position: number,
): Item | null {
  if (!getItemById(id)) return null;
  db.run(
    "INSERT INTO item_lists (item_id, list, position) VALUES (?, ?, ?) ON CONFLICT(item_id, list) DO UPDATE SET position = excluded.position",
    [id, list, position],
  );
  return getItemById(id);
}

// The next free "top" slot for a tab: one below the current minimum position,
// so a freshly moved item sorts above everything else (and above the previous
// top item, for a most-recently-moved-first order).
export function topPosition(list: string): number {
  const r = db
    .query(
      "SELECT MIN(position) AS m FROM item_lists WHERE list = ? AND position IS NOT NULL",
    )
    .get(list) as { m: number | null };
  return (r.m ?? 0) - 1;
}

export function deleteItem(id: string): void {
  db.run("DELETE FROM item_lists WHERE item_id = ?", [id]);
  db.run("DELETE FROM items WHERE id = ?", [id]);
}
