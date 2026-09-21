import { updateItem } from "./db";
import type { Item } from "./db";
import { tasteScore } from "./taste";

const GATEWAY = process.env.SHEET_URL || "";
const GATEWAY_TOKEN = process.env.SHEET_TOKEN || "";

// Best-effort: fetch the taste.io score for an item that just landed on a
// list and store it. No-op when a score is already known or no token is set.
export function pullTaste(item: Item): void {
  if (item.taste_score != null) return;
  tasteScore(item.title, item.kind, item.year)
    .then((s) => {
      if (s == null || s === item.taste_score) return;
      const updated = updateItem(item.id, { taste_score: s });
      if (updated) pushScore(updated);
    })
    .catch(() => {});
}

let gatewayQueue: Promise<void> = Promise.resolve();
export function pushSheet(cmd: Record<string, unknown>): Promise<void> {
  if (!GATEWAY) return Promise.resolve();
  const run = gatewayQueue.then(async () => {
    const started = Date.now();
    try {
      const res = await fetch(GATEWAY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: GATEWAY_TOKEN, ...cmd }),
      });
      const body = await res.text().catch(() => "");
      console.log(
        `sheet ${cmd.op} ${JSON.stringify(cmd)} -> ${res.status} ${body.slice(0, 200)} (${Date.now() - started}ms)`,
      );
    } catch (e) {
      console.error(`sheet ${cmd.op} failed: ${e}`);
    }
  });
  gatewayQueue = run;
  return run;
}

// Sheet rows are matched by title, so include year + kind to disambiguate
// duplicate titles across tabs when telling the gateway to remove a row.
export function removeCmd(it: Item, tab: string) {
  return { op: "remove", tab, title: it.title, year: it.year, kind: it.kind };
}

export function pushScore(it: Item, tab?: string): void {
  if (!GATEWAY) return;
  const tabs = tab ? [tab] : (it.lists ?? []);
  if (!tabs.length) {
    void pushSheet({
      op: "score",
      title: it.title,
      kind: it.kind,
      taste_score: it.taste_score,
      j: it.my_rating,
      d: it.di_rating,
    });
    return;
  }
  for (const t of tabs) {
    void pushSheet({
      op: "score",
      tab: t,
      title: it.title,
      kind: it.kind,
      taste_score: it.taste_score,
      j: it.my_rating,
      d: it.di_rating,
    });
  }
}

// Current-season episode summary for the sheet's CUR / Epis columns. The web UI
// shows the next-to-watch episode (last watched + 1) for an in-progress season,
// so CUR mirrors that: for an in-progress season CUR = last watched + 1; for a
// finished season CUR = the last episode. "Total Episodes" (Epis) is the
// season's episode count. When a show is finished (no active current season)
// we fall back to the highest-touched season so the figures still reflect where
// the show ended.
export function episodeSummary(it: Item): {
  cur: number | null;
  total: number | null;
} {
  const prog = it.episode_progress || {};
  const counts = it.season_counts || {};
  const seasons = Object.keys(counts)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  let s = it.current_season;
  if (s == null) {
    s =
      seasons.find((n) => {
        const arr = prog[n] || [];
        const c = counts[n];
        return arr.length && (c == null || arr.length < c);
      }) ??
      seasons[seasons.length - 1] ??
      undefined;
    if (s == null) {
      const progSeasons = Object.keys(prog)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => b - a);
      s = progSeasons[0];
    }
  }
  if (s == null) return { cur: null, total: null };
  const arr = (prog[s] || []).slice().sort((a, b) => a - b);
  const last = arr.length ? arr[arr.length - 1] : 0;
  const total = counts[s] ?? null;
  const complete = total != null && last >= total;
  const cur = complete ? last : last + 1;
  return { cur, total };
}

// Debounce episode pushes per item so rapid +/- taps coalesce into a single
// sheet write. The gateway handles op "episodeProgress".
const episodeTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleEpisodePush(
  item: Item,
  prog: Record<string, number[]>,
  counts: Record<string, number> | null,
): void {
  if (!GATEWAY) return;
  const t = episodeTimers.get(item.id);
  if (t) clearTimeout(t);
  episodeTimers.set(
    item.id,
    setTimeout(() => {
      episodeTimers.delete(item.id);
      const { cur, total } = episodeSummary(item);
      void pushSheet({
        op: "episodeProgress",
        title: item.title,
        year: item.year,
        tab: item.lists && item.lists[0],
        progress: prog,
        counts: counts || {},
        started: item.ep_started_at,
        finished: item.watched_at || item.ep_finished_at,
        cur,
        epis: total,
      });
    }, 1500),
  );
}
