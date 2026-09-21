import { setItemLists, setListPosition, topPosition, type Item } from "./db";
import { pushSheet, removeCmd, pushScore } from "./sheet";
import { TABS } from "./constants";

// A TV show counts as finished in 2026 only when the whole show is done — its
// whole-show watched_at falls in 2026. A single season finishing (e.g. season 1
// of a still-running multi-season show) must NOT archive the show, otherwise it
// would vanish from Currently Watching the moment any season ends.
function finished2026(it: Item): boolean {
  return !!(it.watched_at && String(it.watched_at).startsWith("2026"));
}

// When a TV show finishes in 2026, file it onto the "Shows 2026" tab and off
// Currently Watching / Shows Archive, in both the app and the sheet. ("2026"
// is the movies-only year tab; finished shows go to "Shows 2026".) Idempotent:
// once on the Shows 2026 list and off the source lists, it's a no-op.
export function transferToShows2026(it: Item): Item {
  if (it.kind !== "tv" || !finished2026(it)) return it;
  if (
    it.lists.includes(TABS.SHOWS_2026) &&
    !it.lists.includes(TABS.CURRENTLY_WATCHING) &&
    !it.lists.includes(TABS.SHOWS_ARCHIVE)
  )
    return it;
  const lists = it.lists.filter(
    (l) => l !== TABS.CURRENTLY_WATCHING && l !== TABS.SHOWS_ARCHIVE,
  );
  if (!lists.includes(TABS.SHOWS_2026)) lists.push(TABS.SHOWS_2026);
  const updated = setItemLists(it.id, lists);
  if (!updated) return it;
  setListPosition(updated.id, TABS.SHOWS_2026, topPosition(TABS.SHOWS_2026));
  if (it.lists.includes(TABS.CURRENTLY_WATCHING))
    void pushSheet(removeCmd(it, TABS.CURRENTLY_WATCHING));
  if (it.lists.includes(TABS.SHOWS_ARCHIVE))
    void pushSheet(removeCmd(it, TABS.SHOWS_ARCHIVE));
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
  pushScore(updated, TABS.SHOWS_2026);
  return updated;
}
