// Start a tunnel for the movie app and auto-register its public URL with the
// sheet gateway (op "setAppUrl"). Quick-tunnel URLs change on every restart,
// so this keeps the Apps Script's APP_URL fresh without touching the Sync menu.
// Registration retries every 30s until it succeeds, so it also self-heals if
// the gateway is briefly unreachable or running old code.
//
// If STABLE_URL is set in .env, no cloudflared is spawned — the fixed URL
// (e.g. a Tailscale Funnel hostname) is registered instead, once at startup
// and again every 6h.
//
// Run via tunnel.sh (or directly: bun tunnel.ts).
const DIR = import.meta.dir;
const BIN = DIR + "/bin/cloudflared";
const LOCAL = "http://localhost:3002";

const GATEWAY = process.env.SHEET_URL;
const TOKEN = process.env.SHEET_TOKEN;
const STABLE = (process.env.STABLE_URL || "").trim();

if (!GATEWAY || !TOKEN) {
  console.error("SHEET_URL / SHEET_TOKEN not set in .env");
  process.exit(1);
}
const GW = GATEWAY;
const TK = TOKEN;

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

async function register(url: string) {
  try {
    const res = await fetch(GW, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TK, op: "setAppUrl", url }),
    });
    const j = await res.json().catch(() => null);
    if (j && j.ok && j.url) {
      console.log(`tunnel registered: ${url}`);
      return true;
    }
    console.error(
      `tunnel registration failed: ${j && j.error ? j.error : "unknown"}`,
    );
  } catch (e: unknown) {
    console.error(
      `tunnel registration error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  console.error(`register manually: Sync -> Set app URL -> ${url}`);
  return false;
}

async function keepRegistered(url: string) {
  let ok = await register(url);
  if (ok) {
    setInterval(
      () => {
        register(url).catch(() => {});
      },
      6 * 3600 * 1000,
    );
    return;
  }
  const retry = setInterval(async () => {
    if (await register(url)) clearInterval(retry);
  }, 30_000);
}

if (STABLE) {
  console.log(`stable URL mode: ${STABLE}`);
  await keepRegistered(STABLE);
  await new Promise(() => {});
} else {
  const proc = Bun.spawn([BIN, "tunnel", "--url", LOCAL], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let url: string | null = null;
  let registered = false;
  let retry: ReturnType<typeof setInterval> | null = null;

  async function handleChunk(text: string) {
    process.stdout.write(text);
    if (registered || url) return;
    const m = text.match(URL_RE);
    if (!m) return;
    url = m[0];
    registered = await register(url);
    if (!registered) {
      retry = setInterval(async () => {
        if (url && (await register(url))) {
          registered = true;
          if (retry) clearInterval(retry);
        }
      }, 30_000);
    }
  }

  const decoder = new TextDecoder();
  for await (const chunk of proc.stderr) {
    await handleChunk(decoder.decode(chunk));
  }
  for await (const chunk of proc.stdout) {
    process.stdout.write(decoder.decode(chunk));
  }

  process.exit(await proc.exited);
}
