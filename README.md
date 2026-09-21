# puzzle-monkey-productions

Using ChipotlAI to build the movie watchlist website of my dreams.

## James' Watchlist

Personal movie/TV watchlist app. Bun + Hono backend, vanilla JS frontend,
SQLite storage, TMDB for metadata, optional Google Sheet + Taste.io sync.

## Run locally

```sh
cp .env.example .env   # fill in keys
bun install
bun run dev            # http://localhost:3002
```

## Host it 24/7 (Railway)

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo.
3. Add a **Volume**, mount path `/data` (holds the SQLite DB).
4. Set env vars from `.env.example` (`TMDB_API_KEY`, `SHEET_URL`,
   `SHEET_TOKEN`, `TASTE_REFRESH_TOKEN`, `STABLE_URL` = your Railway domain).
5. Deploy. Railway sets `PORT` automatically; the app picks it up.

No tunnels needed — the host URL is permanent. Point `STABLE_URL` at it so
the sheet gateway stays in sync.
