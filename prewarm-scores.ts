// One-time helper: fetch taste.io match scores for every saved item that lacks
// a user.average in the payload. Runs taste.py slugscore in bounded-parallel
// and checkpoints results to /tmp/taste-scores.json (used by import-taste.ts).
// Run: bun prewarm-scores.ts
const SAVED_FILE = "/tmp/taste-saved.json";
const SCORES_FILE = "/tmp/taste-scores.json";
const PY = import.meta.dir + "/taste.py";
const CONCURRENCY = 3;
const TIMEOUT = 25000;

type Saved = {
  slug: string;
  user?: { average?: number | null };
};

const scores: Record<string, number | null> = {};
try {
  Object.assign(scores, JSON.parse(await Bun.file(SCORES_FILE).text()));
} catch {}

const saved: Saved[] = JSON.parse(await Bun.file(SAVED_FILE).text());
const need = saved.filter(
  (s) => typeof s.user?.average !== "number" && !(s.slug in scores),
);

function slugscore(slug: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = Bun.spawn(["python3", PY, "slugscore", slug], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const t = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve(null);
    }, TIMEOUT);
    (async () => {
      try {
        const out = await Bun.readableStreamToText(proc.stdout);
        const j = JSON.parse(out);
        resolve(typeof j.score === "number" ? j.score : null);
      } catch {
        resolve(null);
      } finally {
        clearTimeout(t);
      }
    })();
  });
}

let i = 0;
let q = 0;
const results = await Promise.all(
  need.map(async (s) => {
    while (q >= CONCURRENCY) await Bun.sleep(100);
    q++;
    try {
      return { slug: s.slug, score: await slugscore(s.slug) };
    } finally {
      q--;
      i++;
      if (i % 5 === 0 || i === need.length)
        console.log(`  ${i}/${need.length}`);
    }
  }),
);
for (const { slug, score } of results) scores[slug] = score;
await Bun.write(SCORES_FILE, JSON.stringify(scores));
const filled = Object.entries(scores).filter(([, v]) => v != null).length;
console.log(
  `done: ${need.length} fetched, ${filled} total non-null in checkpoint`,
);
