import {
  listItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  setItemLists,
} from "./src/db";
import type { Item } from "./src/db";
import { watchProviders } from "./src/providers";

// One-time import: pull every title on the user's taste.io saved list
// (https://www.taste.io/users/darthvap0r/saved, fetched to /tmp/taste-saved.json)
// into the app. Movies land on the Movies tab, shows on the Shows tab.
//
// Matching rules (confirmed with the user):
//   - Exact title+year match  -> item already exists; ensure the right list.
//   - Title match, no year    -> ambiguous. Rated entries (seen) are KEPT and
//     marked watched; unrated entries are deleted ("keep the taste year only").
//   - No match                -> create from TMDB by title+year.
//   - Scored movies/shows never go on a to-watch list; they go to Archive.
//   - taste_score comes from the saved payload's user.average when present,
//     else from taste.py slugscore (checkpointed to /tmp/taste-scores.json).
//   - Every list membership is pushed to the sheet gateway like a normal add.
//
// Run: bun import-taste.ts
const KEY = process.env.TMDB_API_KEY || "";
console.error("DEBUG key:", KEY.length, "cwd:", process.cwd());
const BASE = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";
const GATEWAY = process.env.SHEET_URL || "";
const GATEWAY_TOKEN = process.env.SHEET_TOKEN || "";
const SAVED_FILE = "/tmp/taste-saved.json";
const SCORES_FILE = "/tmp/taste-scores.json";
const PY = import.meta.dir + "/taste.py";

const TODAY = new Date().toISOString().slice(0, 10);
const TMO = 15000;
function timed<T>(p: Promise<T>, ms = TMO): Promise<T> {
  return Promise.race([
    p,
    Bun.sleep(ms).then(() => {
      throw new Error("timeout");
    }),
  ]);
}
// The rated Amityville Horror (1979) stays unwatched; everything else the user
// confirmed as seen gets a watched date.
const KEEP_UNWATCHED = new Set(["theamityvillehorror"]);

type Saved = {
  name: string;
  slug: string;
  category: string;
  year: number | null;
  user?: { average?: number | null };
};

type Raw = {
  id?: number;
  name?: string;
  title?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  overview?: string | null;
  genres?: { name: string }[];
  seasons?: { season_number: number; episode_count: number }[];
  runtime?: number;
  episode_run_time?: number[];
  created_by?: { name?: string }[];
  crew?: { name?: string; job?: string }[];
  results?: Raw[];
};

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function tmdb(path: string): Promise<Raw> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${sep}api_key=${KEY}&language=en-US`;
  const res = await timed(
    fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TMO),
    }),
  );
  if (!res.ok) throw new Error(`tmdb ${res.status}`);
  const txt = await res.text();
  if (!txt.trim() || txt.trim() === "null") {
    console.error(
      "  DBG empty body",
      res.status,
      res.headers.get("content-type"),
      "len",
      txt.length,
      "|",
      url.replace(KEY, "KEY"),
    );
  }
  return JSON.parse(txt);
}

async function directorFrom(
  kind: string,
  tmdbId: number,
  d: Raw,
): Promise<string | null> {
  if (kind === "tv") {
    const names = (d.created_by || []).map((c) => c.name).filter(Boolean);
    return names.length ? names.slice(0, 2).join(", ") : null;
  }
  try {
    const c = await tmdb(`/movie/${tmdbId}/credits`);
    const dirs = (c.crew || [])
      .filter((x) => x.job === "Director")
      .map((x) => x.name)
      .filter(Boolean);
    return dirs.length ? dirs.slice(0, 2).join(", ") : null;
  } catch {
    return null;
  }
}

async function createFromTmdb(
  tmdbId: number,
  kind: string,
): Promise<Item | null> {
  try {
    const d = await tmdb(`/${kind}/${tmdbId}`);
    const seasons = d.seasons || [];
    const arr = d.episode_run_time || [];
    const runtime =
      kind === "tv"
        ? arr.length
          ? Math.max(...arr)
          : null
        : typeof d.runtime === "number"
          ? d.runtime
          : null;
    const director = await directorFrom(kind, tmdbId, d);
    const providers = await timed(watchProviders(kind, tmdbId));
    return createItem({
      tmdb_id: tmdbId,
      kind: kind === "tv" ? "tv" : "movie",
      title: (kind === "tv" ? d.name : d.title) || "",
      year:
        ((kind === "tv" ? d.first_air_date : d.release_date) || "").slice(
          0,
          4,
        ) || null,
      rating: null,
      taste_score: null,
      genres: (d.genres || []).map((g) => g.name).join(", ") || null,
      overview: d.overview || null,
      poster: d.poster_path ? IMG + d.poster_path : null,
      providers,
      runtime,
      director,
      reference: null,
      flags: {},
      seasons: seasons.length ? seasons.length : null,
      episodes: seasons.length
        ? seasons.reduce((n, s) => n + s.episode_count, 0)
        : null,
      lists: [],
    });
  } catch {
    return null;
  }
}

async function searchTmdb(
  title: string,
  year: number | null,
  kind: string,
): Promise<Raw | null> {
  const n = norm(title);
  const q = encodeURIComponent(title);
  const base = `/search/${kind}?query=${q}`;
  const withYear =
    year != null
      ? `${base}&${kind === "tv" ? "first_air_date_year" : "year"}=${year}`
      : null;
  for (const url of withYear ? [withYear, base] : [base]) {
    try {
      const d = await tmdb(url);
      const rs = d.results || [];
      if (!rs.length) continue;
      const byName = rs.filter((r) => norm(r.title || r.name || "") === n);
      const y = year != null ? String(year) : null;
      const pick =
        byName.find(
          (r) =>
            y != null &&
            (r.release_date || r.first_air_date || "").slice(0, 4) === y,
        ) ||
        byName[0] ||
        rs[0];
      if (pick) return pick;
    } catch (e) {
      console.error(
        "  DBG tmdb err:",
        String(e).slice(0, 140),
        "|",
        url.replace(KEY, "KEY"),
      );
      if (firstErr === "") firstErr = String(e).slice(0, 200);
    }
  }
  return null;
}

// ---- Sheet gateway (mirrors pushSheet in src/index.ts) ----
let queue: Promise<void> = Promise.resolve();
function pushSheet(cmd: Record<string, unknown>): void {
  if (!GATEWAY) return;
  queue = queue.then(async () => {
    try {
      await fetch(GATEWAY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: GATEWAY_TOKEN, ...cmd }),
        signal: AbortSignal.timeout(TMO),
      });
    } catch {}
  });
}
async function flush(): Promise<void> {
  await queue;
}

// ---- taste_score (checkpointed) ----
const scores: Record<string, number | null> = {};
try {
  Object.assign(scores, JSON.parse(await Bun.file(SCORES_FILE).text()));
} catch {}
async function saveScores(): Promise<void> {
  await Bun.write(SCORES_FILE, JSON.stringify(scores));
}

async function slugscore(slug: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["python3", PY, "slugscore", slug], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const t = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, 20000);
    try {
      const out = await Bun.readableStreamToText(proc.stdout);
      const j = JSON.parse(out);
      return typeof j.score === "number" ? j.score : null;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

async function scoreFor(s: Saved): Promise<number | null> {
  const avg = s.user?.average;
  if (typeof avg === "number") return Math.round(avg);
  if (s.slug in scores) return scores[s.slug];
  const sc = await slugscore(s.slug);
  scores[s.slug] = sc;
  await saveScores();
  return sc;
}

// ---- actions ----
let created = 0;
let added = 0;
let watched = 0;
let deleted = 0;
let skipped = 0;
let done = 0;
let firstErr = "";

function addList(it: Item, list: string): void {
  if (it.lists.includes(list)) return;
  const u = setItemLists(it.id, [...it.lists, list]);
  if (u) {
    pushSheet({
      op: "add",
      tab: list,
      title: u.title,
      year: u.year,
      status: u.status,
      genres: u.genres,
      taste_score: u.taste_score,
      j: u.my_rating,
      d: u.di_rating,
      date: u.watched_at,
    });
    added++;
  }
}

async function setScore(it: Item, s: number | null): Promise<void> {
  if (it.taste_score != null || s == null) return;
  const u = updateItem(it.id, { taste_score: s });
  if (u) {
    pushSheet({
      op: "score",
      title: u.title,
      kind: u.kind,
      taste_score: u.taste_score,
      j: u.my_rating,
      d: u.di_rating,
    });
  }
}

async function createTaste(s: Saved, kind: string): Promise<void> {
  const hit = await searchTmdb(s.name, s.year, kind);
  if (!hit?.id) {
    skipped++;
    console.log(`  SKIP ${s.name} (${s.year ?? "?"}): no tmdb match`);
    return;
  }
  let item = getItem(hit.id, kind);
  const fresh = !item;
  if (!item) item = await createFromTmdb(hit.id, kind);
  if (!item) {
    skipped++;
    console.log(`  SKIP ${s.name} (${s.year ?? "?"}): create failed`);
    return;
  }
  await setScore(item, await scoreFor(s));
  const list = kind === "tv" ? "Shows" : "Movies";
  addList(item, list);
  if (fresh) {
    created++;
    console.log(`  + ${item.title} (${item.year ?? "?"}) -> ${list}`);
  }
}

const saved: Saved[] = JSON.parse(await Bun.file(SAVED_FILE).text());
const items = listItems();
const byTitle = new Map<string, Item[]>();
for (const it of items) {
  const n = norm(it.title);
  const arr = byTitle.get(n);
  if (arr) arr.push(it);
  else byTitle.set(n, [it]);
}

for (const s of saved) {
  const kind = s.category === "tv" ? "tv" : "movie";
  const n = norm(s.name);
  const cands = byTitle.get(n) || [];
  const sy = s.year == null ? null : String(s.year);
  const same = cands.filter((c) => c.kind === kind);
  const exact = same.find((c) => (c.year == null ? sy == null : c.year === sy));
  done++;
  if (done % 25 === 0 || done === saved.length)
    console.log(
      `[${done}/${saved.length}] ${s.name} (${s.year ?? "?"}) exact=${!!exact} cands=${cands.length}`,
    );

  if (exact) {
    const seen = exact.my_rating != null || exact.di_rating != null;
    const list = seen
      ? kind === "tv"
        ? "Shows Archive"
        : "Movies Archive"
      : kind === "tv"
        ? "Shows"
        : "Movies";
    addList(exact, list);
    if (exact.taste_score == null) await setScore(exact, await scoreFor(s));
    continue;
  }

  if (cands.length) {
    // Ambiguous title (different year, or movie/show mismatch): rated entries
    // are kept and marked watched; unrated ones are deleted per the user's
    // "keep the taste year only" rule. The taste version is imported either way.
    for (const c of cands) {
      const rated = c.my_rating != null || c.di_rating != null;
      if (rated) {
        if (!KEEP_UNWATCHED.has(n) && (c.status !== "done" || !c.watched_at)) {
          const u = updateItem(c.id, { status: "done", watched_at: TODAY });
          if (u) {
            pushSheet({ op: "watched", title: u.title, date: u.watched_at });
            watched++;
            console.log(`  watched ${u.title} (${u.year ?? "?"})`);
          }
        }
      } else {
        for (const l of c.lists)
          if (l !== "spin")
            pushSheet({
              op: "remove",
              tab: l,
              title: c.title,
              year: c.year,
              kind: c.kind,
            });
        deleteItem(c.id);
        deleted++;
        console.log(`  DEL ${c.title} (${c.year ?? "?"})`);
      }
    }
    await createTaste(s, kind);
    continue;
  }

  await createTaste(s, kind);
}

await flush();
await saveScores();
console.log(
  `done: created=${created} added=${added} watched=${watched} deleted=${deleted} skipped=${skipped}`,
);
