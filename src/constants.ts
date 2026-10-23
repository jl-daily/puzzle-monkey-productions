export const TABS = {
  MOVIES: "Movies",
  NO_DI: "No Di",
  WATCH_2026: "2026",
  SHOWS_2026: "Shows 2026",
  CURRENTLY_WATCHING: "Currently Watching",
  SHOWS_ARCHIVE: "Shows Archive",
  MOVIES_ARCHIVE: "Movies Archive",
  SPIN: "spin",
  ARCHIVE_YEARS: [
    "Archive 2022",
    "Archive 2023",
    "Archive 2024",
    "Archive 2025",
  ],
} as const;

// The canonical collection buckets. An item belongs to exactly one of these at
// a time; moving it to another primary list removes it from the old one. Sheet
// tabs (Taste *, Archive <year>) and Spin stay additive and are not here.
export const PRIMARY_LISTS = [
  TABS.MOVIES,
  TABS.NO_DI,
  TABS.WATCH_2026,
  TABS.CURRENTLY_WATCHING,
  TABS.SHOWS_ARCHIVE,
  TABS.MOVIES_ARCHIVE,
] as const;

export const PRIMARY_SET = new Set<string>(PRIMARY_LISTS);

// Collapse a lists array to at most one primary list: if it holds any primary,
// keep only the first one and drop the rest. Non-primary lists (sheet tabs,
// Spin, year archives) are preserved.
export function collapsePrimaries(lists: string[]): string[] {
  const keep = lists.find((l) => PRIMARY_SET.has(l));
  if (keep == null) return lists;
  return lists.filter((l) => !PRIMARY_SET.has(l) || l === keep);
}

// Lists that only ever hold TV shows. The spreadsheet names a row and the tab
// it lives on, so a row on one of these tabs is a show even when the caller
// doesn't say so. Without this, /api/items/by-title defaulted to "movie" and
// re-creating a missing show from its sheet row minted a movie with the show's
// name — which is how the show "Carrie" kept turning into the 2002 movie.
const SHOWS_RE = /^Shows( \d{4})?$/;
export function isShowList(list: string): boolean {
  return (
    list === TABS.CURRENTLY_WATCHING ||
    list === TABS.SHOWS_2026 ||
    list === TABS.SHOWS_ARCHIVE ||
    list === "Shows w/o Di" ||
    list === "Shows Watched" ||
    SHOWS_RE.test(list)
  );
}

// The kind a list implies, when the caller doesn't say. null for lists that
// both kinds use (spin, the taste.io library, the rewatch queues).
export function kindForList(list: string): "tv" | "movie" | null {
  if (!list) return null;
  if (isShowList(list)) return "tv";
  if (
    list === TABS.MOVIES ||
    list === TABS.NO_DI ||
    list === TABS.WATCH_2026 ||
    list === TABS.MOVIES_ARCHIVE ||
    /^Archive \d{4}$/.test(list)
  )
    return "movie";
  return null;
}

export function today(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
