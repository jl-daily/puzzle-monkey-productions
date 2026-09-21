const PY = import.meta.dir + "/../taste.py";

export function normTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function tasteScore(
  title: string,
  kind?: string,
  year?: string | null,
): Promise<number | null> {
  const args = ["python3", PY, "score", title];
  if (kind) args.push(kind);
  if (year) args.push(year);
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await Bun.readableStreamToText(proc.stdout);
  try {
    const j = JSON.parse(out);
    return typeof j.score === "number" ? j.score : null;
  } catch {
    return null;
  }
}

export async function tasteUrl(
  title: string,
  kind?: string,
  year?: string | null,
): Promise<string | null> {
  const args = ["python3", PY, "score", title];
  if (kind) args.push(kind);
  if (year) args.push(year);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  const out = await Bun.readableStreamToText(proc.stdout);
  try {
    const j = JSON.parse(out);
    if (!j.slug) return null;
    const cat = j.category === "tv" ? "tv" : "movies";
    return `https://www.taste.io/${cat}/${j.slug}`;
  } catch {
    return null;
  }
}
