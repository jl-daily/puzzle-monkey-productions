// Minimal stand-in for the Apps Script sheet gateway used by local tests: logs
// every command it receives and answers ok, so the app's sheet pushes can be
// asserted without touching the real spreadsheet.
import { appendFileSync, writeFileSync } from "node:fs";

const LOG = process.env.STUB_LOG || "/tmp/stub-sheet.log";
const PORT = Number(process.env.STUB_PORT) || 4111;
writeFileSync(LOG, "");

Bun.serve({
  port: PORT,
  async fetch(req) {
    const body = await req.json().catch(() => ({}));
    appendFileSync(LOG, JSON.stringify(body) + "\n");
    return Response.json({ ok: true, updated: 1, removed: 1, row: 1 });
  },
});
console.log(`stub sheet gateway on :${PORT} -> ${LOG}`);
