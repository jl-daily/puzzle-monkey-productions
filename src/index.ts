import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { networkInterfaces } from "node:os";
import { registerItems } from "./items";
import { registerEpisodes } from "./episodes";

const app = new Hono();
app.use(cors());

registerItems(app);
registerEpisodes(app);

app.get(
  "/*",
  async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  },
  serveStatic({ root: "./src/frontend" }),
);

const PORT = Number(process.env.PORT) || 3002;

const ip =
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i?.family === "IPv4" && !i.internal)?.address || "localhost";

console.log(
  process.env.TMDB_API_KEY
    ? `Movie app running at http://localhost:${PORT}`
    : `WARNING: no TMDB_API_KEY set. Add it to .env then restart.`,
);
if (!process.env.TASTE_REFRESH_TOKEN) {
  console.log(
    "WARNING: no TASTE_REFRESH_TOKEN set. Taste scores won't auto-fetch when adding to the 2026 tab.",
  );
}
console.log(`On your phone: http://${ip}:${PORT}`);
export default { port: PORT, hostname: "0.0.0.0", fetch: app.fetch };
