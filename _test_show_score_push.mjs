// The app must never write a show's rating into the sheet's column E ("J").
// A show has one row per season on the Archive <year> / Currently Watching
// tabs, and each row's column E is that season's rating, while the app keeps a
// single show-level my_rating — pushing it would flatten every season's score
// into one number (and the gateway writes column E on every row carrying that
// title). Movies keep the old behaviour: their J is the one rating.
//
// Runs the real pushScore against a stub sheet gateway, so what is asserted is
// the payload the gateway would receive.
//
//   bun _test_show_score_push.mjs
process.env.SHEET_URL = ""; // set below, before the module is imported
const PORT = 4177;
process.env.SHEET_URL = `http://127.0.0.1:${PORT}/`;
process.env.SHEET_TOKEN = "stub";

const seen = [];
Bun.serve({
  port: PORT,
  async fetch(req) {
    seen.push(await req.json());
    return Response.json({ ok: true, updated: 1 });
  },
});

// SHEET_MODULE exists so the test can be pointed at an older copy of the module
// (the pre-fix version from git) to prove it actually detects the regression.
const { pushScore } = await import(process.env.SHEET_MODULE || "./src/sheet.ts");

const show = {
  id: "t1",
  kind: "tv",
  title: "Kitchen Nightmares",
  year: "2023",
  lists: ["Archive 2025"],
  my_rating: 88,
  di_rating: 61,
  taste_score: 72,
};
const movie = {
  id: "m1",
  kind: "movie",
  title: "Slumdog Millionaire",
  year: "2008",
  lists: ["2026"],
  my_rating: 65,
  di_rating: 65,
  taste_score: 83,
};

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", name, "|", `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

pushScore(show);
pushScore(movie);
const deadline = Date.now() + 5000;
while (seen.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

const find = (title, tab) => seen.find((c) => c.title === title && c.tab === tab);
const showCmd = find(show.title, "Archive 2025");
const movieCmd = find(movie.title, "2026");

check("a show's score push reaches its tab", !!showCmd, true);
check("and carries no j (column E stays the season's own rating)", showCmd && "j" in showCmd, false);
check("while still carrying taste score, D and kind", showCmd && [showCmd.taste_score, showCmd.d, showCmd.kind, showCmd.op], [72, 61, "tv", "score"]);
check("a movie's push still carries its J", movieCmd && movieCmd.j, 65);
check("and its D and taste score", movieCmd && [movieCmd.d, movieCmd.taste_score], [65, 83]);
check("nothing else was sent", seen.length, 2);
console.log(`\n# payloads: ${JSON.stringify(seen)}`);

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL_PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
