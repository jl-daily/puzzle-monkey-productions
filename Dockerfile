FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# SQLite lives on the persistent volume so the library survives restarts.
ENV MOVIE_DB_PATH=/data/.movie-app.db
VOLUME /data

EXPOSE 3002
CMD ["bun", "src/index.ts"]
