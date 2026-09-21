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

export function today(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
