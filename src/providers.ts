const BASE = "https://api.themoviedb.org/3";
const LOGO = "https://image.tmdb.org/t/p/w45";
const KEY = process.env.TMDB_API_KEY || "";

export type Provider = { id: number; name: string; logo: string };

export async function watchProviders(
  kind: string,
  tmdbId: number,
): Promise<Provider[]> {
  if (!KEY) return [];
  try {
    const res = await fetch(
      BASE +
        "/" +
        kind +
        "/" +
        tmdbId +
        "/watch/providers?watch_region=US&language=en-US&api_key=" +
        KEY,
    );
    if (!res.ok) return [];
    const data = await res.json();
    const us = data.results && data.results.US;
    const out: Provider[] = [];
    const seen = new Set<number>();
    for (const group of [us && us.flatrate, us && us.free, us && us.ads]) {
      for (const p of group || []) {
        if (
          p &&
          p.provider_id &&
          p.logo_path &&
          !seen.has(p.provider_id) &&
          isWanted(p.provider_name)
        ) {
          seen.add(p.provider_id);
          out.push({
            id: p.provider_id,
            name: p.provider_name,
            logo: LOGO + p.logo_path,
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function isWanted(name: string): boolean {
  const n = String(name || "").toLowerCase();
  if (n.includes("amazon") || n.includes("channel")) return false;
  return (
    n.includes("hbo") ||
    n.includes("tubi") ||
    n.includes("disney") ||
    n.includes("netflix")
  );
}

export async function tvMeta(
  tmdbId: number,
): Promise<{ seasons: number | null; episodes: number | null }> {
  if (!KEY) return { seasons: null, episodes: null };
  try {
    const res = await fetch(
      BASE + "/tv/" + tmdbId + "?language=en-US&api_key=" + KEY,
    );
    if (!res.ok) return { seasons: null, episodes: null };
    const d = await res.json();
    return {
      seasons:
        typeof d.number_of_seasons === "number" ? d.number_of_seasons : null,
      episodes:
        typeof d.number_of_episodes === "number" ? d.number_of_episodes : null,
    };
  } catch {
    return { seasons: null, episodes: null };
  }
}
