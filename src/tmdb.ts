const KEY = process.env.TMDB_API_KEY || "";
const BASE = "https://api.themoviedb.org/3";
export const IMG = "https://image.tmdb.org/t/p/w500";

export type TmdbResult = {
  id?: number;
  name?: string;
  title?: string;
  first_air_date?: string;
  release_date?: string;
  poster_path?: string | null;
  overview?: string | null;
  genres?: { name: string }[];
  seasons?: { season_number: number; episode_count: number }[];
  runtime?: number;
  episode_run_time?: number[];
  created_by?: { name?: string }[];
  crew?: { name?: string; job?: string }[];
  results?: TmdbResult[];
};

export async function tmdb(path: string): Promise<TmdbResult> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}api_key=${KEY}&language=en-US`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`tmdb ${res.status}`);
  return res.json();
}

function runtimeFrom(r: TmdbResult, kind: string): number | null {
  if (kind === "tv") {
    const arr = r.episode_run_time || [];
    return arr.length ? Math.max(...arr) : null;
  }
  return typeof r.runtime === "number" ? r.runtime : null;
}

export function detailFrom(r: TmdbResult, kind: string) {
  const seasons = r.seasons || [];
  return {
    title: (kind === "tv" ? r.name : r.title) || "",
    year:
      ((kind === "tv" ? r.first_air_date : r.release_date) || "").slice(0, 4) ||
      null,
    genres: (r.genres || []).map((g) => g.name).join(", ") || null,
    overview: r.overview || null,
    poster: r.poster_path ? IMG + r.poster_path : null,
    seasons,
    runtime: runtimeFrom(r, kind),
  };
}

// Director for movies comes from the credits crew (job "Director"); for shows
// the closest equivalent is the "Created by" field on the detail response.
export async function directorFrom(
  kind: string,
  tmdbId: number,
  d: TmdbResult,
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

export { runtimeFrom };
