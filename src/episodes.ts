import type { Hono } from "hono";
import { getItemById, updateItem } from "./db";
import { tmdb } from "./tmdb";
import { scheduleEpisodePush } from "./sheet";
import { transferToShows2026 } from "./archive";
import { today } from "./constants";

// True once every season with progress has had all its episodes watched. A
// season with unknown episode count can't be confirmed done, so it keeps the
// show unfinished rather than stamping a finish date too early.
export function isShowComplete(
  prog: Record<string, number[]>,
  counts: Record<string, number> | null,
): boolean {
  let any = false;
  for (const [s, arr] of Object.entries(prog)) {
    any = true;
    const count = counts ? counts[s] : undefined;
    if (count == null || arr.length < count) return false;
  }
  return any;
}

// True when season s is fully watched, is the show's last known season, and no
// later season has progress yet, so stamping the show finished (Currently Watching
// Started/Finished) is correct.
export function isLastSeasonDone(
  prog: Record<string, number[]>,
  counts: Record<string, number> | null,
  s: number,
): boolean {
  const count = counts ? counts[s] : undefined;
  if (count == null || (prog[s] || []).length < count) return false;
  const known = Object.keys(counts || {}).map(Number);
  if (known.length && s !== Math.max(...known)) return false;
  for (const sn of Object.keys(prog).map(Number)) {
    if (sn > s && (prog[sn] || []).length) return false;
  }
  return true;
}

// Mark/unmark the next watched episode. With a body.season the call targets a
// specific season (per-season tracking, no rollover); otherwise the current
// season is the highest one with progress (else the first known season, else
// 1), and "inc" rolls into the next once a season's count is hit. Per-season
// episode counts are fetched from TMDB lazily and cached on the item. The first
// episode watched stamps ep_started_at; finishing the last episode stamps
// ep_finished_at and watched_at (both pushed to the sheet's Started/Finished
// columns for the Currently Watching tab).
export function registerEpisodes(app: Hono) {
  app.post("/api/items/:id/episodes", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const op = body.op === "dec" ? "dec" : "inc";
    const item = getItemById(c.req.param("id"));
    if (!item) return c.json({ error: "not found" }, 404);
    if (item.kind !== "tv")
      return c.json({ error: "only tv shows track episodes" }, 400);
    const before = item.episode_progress || {};
    const had = Object.keys(before).some((k) => (before[k] || []).length > 0);
    const prog: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(before)) prog[k] = [...v];
    let counts = item.season_counts;
    const seasonArg = Number(body.season);
    const perSeason = Number.isFinite(seasonArg) && seasonArg >= 1;
    let s = perSeason
      ? seasonArg
      : Math.max(0, ...Object.keys(prog).map(Number));
    if (!s) {
      const known = Object.keys(counts || {}).map(Number);
      s = known.length ? Math.min(...known) : 1;
    }
    if (!counts || counts[s] == null) {
      try {
        const d = await tmdb(`/tv/${item.tmdb_id}`);
        counts = {};
        for (const sn of d.seasons || []) {
          if (sn.season_number > 0) counts[sn.season_number] = sn.episode_count;
        }
      } catch {}
    }
    const touched = new Set<number>();
    if (op === "inc") {
      const arr = prog[s] || [];
      const count = counts ? counts[s] : undefined;
      const last = arr.length ? Math.max(...arr) : 0;
      if (count != null && last >= count) {
        const seasons = Object.keys(counts || {})
          .map(Number)
          .sort((a, b) => a - b);
        const ni = seasons.indexOf(s) + 1;
        if (!perSeason && seasons.length && ni < seasons.length) {
          touched.add(s);
          s = seasons[ni];
          prog[s] = [1];
        }
      } else {
        prog[s] = [...new Set([...arr, last + 1])];
      }
      touched.add(s);
    } else {
      let removed = false;
      if (perSeason) {
        const arr = (prog[s] || []).slice().sort((a, b) => b - a);
        if (arr.length) {
          prog[s] = arr.slice(1);
          if (!prog[s].length) delete prog[s];
          removed = true;
          touched.add(s);
        }
      } else {
        for (const sn of Object.keys(prog)
          .map(Number)
          .sort((a, b) => b - a)) {
          const arr = (prog[sn] || []).slice().sort((a, b) => b - a);
          if (!arr.length) continue;
          prog[sn] = arr.slice(1);
          if (!prog[sn].length) delete prog[sn];
          removed = true;
          touched.add(sn);
          break;
        }
      }
      if (!removed) return c.json(getItemById(item.id));
    }
    const now = Object.keys(prog).some((k) => (prog[k] || []).length > 0);
    const patch: {
      episode_progress: Record<string, number[]>;
      ep_started_at?: string | null;
      ep_finished_at?: string | null;
      watched_at?: string | null;
    } = { episode_progress: prog };
    if (!now) {
      patch.ep_started_at = null;
      patch.ep_finished_at = null;
    } else {
      if (!had) patch.ep_started_at = item.ep_started_at || today();
      if (op === "dec") {
        patch.ep_finished_at = null;
      } else if (
        perSeason
          ? isLastSeasonDone(prog, counts, s)
          : isShowComplete(prog, counts)
      ) {
        if (!item.ep_finished_at) patch.ep_finished_at = today();
        if (!item.watched_at) patch.watched_at = today();
      }
    }
    // Per-season start/finish dates: first episode stamps started_at, reaching a
    // season's full count stamps finished_at, and decrementing back past those
    // points clears them again (matching the show-level started/finished rules).
    const sdates = { ...(item.season_dates || {}) };
    for (const sn of touched) {
      const arr = prog[sn] || [];
      const count = counts ? counts[sn] : undefined;
      const prev = { ...(sdates[sn] || {}) };
      const next = {
        started_at: prev.started_at ?? null,
        finished_at: prev.finished_at ?? null,
      };
      if (arr.length) {
        if (!next.started_at) next.started_at = today();
        if (count != null && arr.length >= count) {
          if (!next.finished_at) next.finished_at = today();
        } else {
          next.finished_at = null;
        }
      } else {
        next.started_at = null;
        next.finished_at = null;
      }
      if (next.started_at || next.finished_at) sdates[sn] = next;
      else delete sdates[sn];
    }
    const seasonDates = Object.keys(sdates).length ? sdates : null;
    const changed =
      JSON.stringify(prog) !== JSON.stringify(before) ||
      (patch.ep_started_at !== undefined &&
        patch.ep_started_at !== item.ep_started_at) ||
      (patch.ep_finished_at !== undefined &&
        patch.ep_finished_at !== item.ep_finished_at) ||
      (patch.watched_at !== undefined &&
        patch.watched_at !== item.watched_at) ||
      JSON.stringify(seasonDates) !== JSON.stringify(item.season_dates);
    if (!changed) return c.json(getItemById(item.id));
    let updated = updateItem(item.id, {
      episode_progress: prog,
      season_counts: counts || null,
      season_dates: seasonDates,
      ep_started_at:
        patch.ep_started_at === undefined
          ? item.ep_started_at
          : patch.ep_started_at,
      ep_finished_at:
        patch.ep_finished_at === undefined
          ? item.ep_finished_at
          : patch.ep_finished_at,
      watched_at:
        patch.watched_at === undefined ? item.watched_at : patch.watched_at,
    });
    if (!updated) return c.json({ error: "not found" }, 404);
    const wasFinished =
      !!item.watched_at && String(item.watched_at).startsWith("2026");
    if (!wasFinished) updated = transferToShows2026(updated);
    scheduleEpisodePush(updated, prog, counts);
    return c.json(updated);
  });
}
